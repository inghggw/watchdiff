/**
 * Command line interface.
 *
 * Designed to be run by cron or a systemd timer: one pass per invocation, quiet
 * on success, meaningful exit codes, and never an interactive prompt.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError, loadConfig } from './config.js';
import { StateStore } from './state.js';
import { runAll } from './runner.js';

export const VERSION = '0.1.0';

const HELP = `watchdiff ${VERSION} — watch a page or an API and get told when it changes.

Usage:
  watchdiff check   [-c config.json] [--only name] [--dry] [--digest log] [--json]
  watchdiff watch   [-c config.json] --interval 15m [--digest log]
  watchdiff status  [-c config.json]
  watchdiff init    [-c config.json]

Options:
  -c, --config <file>      Config file (default: watchdiff.config.json)
      --only <names>       Check only these watchers (comma-separated, repeatable)
      --dry                Check and report, but send nothing and write no state
      --digest <names>     Also send one summary to these notifiers, changes or not
      --interval <dur>     Loop interval for "watch": 45s, 15m, 2h
      --json               Machine-readable output
      --exit-change        Exit 3 when something changed (for scripts)
      --quiet              Only print problems
  -h, --help               This text
  -v, --version            Version

Exit codes:
  0  all watchers checked, nothing to report
  1  usage or configuration error
  2  at least one watcher could not be read, or an alert could not be delivered
  3  something changed and --exit-change was given
`;

const SAMPLE_CONFIG = {
  stateDir: '.watchdiff',
  defaults: {
    timeoutMs: 20000,
    retries: 2,
    retryDelayMs: 5000,
    errorThreshold: 2,
    notify: ['log'],
  },
  notifiers: {
    log: { type: 'console' },
    history: { type: 'jsonl', file: '.watchdiff/alerts.jsonl' },
    telegram: { type: 'telegram', botToken: 'env:TELEGRAM_BOT_TOKEN', chatId: 'env:TELEGRAM_CHAT_ID' },
    slack: { type: 'webhook', url: 'env:SLACK_WEBHOOK_URL', template: 'slack' },
  },
  watchers: [
    {
      name: 'secop-software-tolima',
      label: 'SECOP II — software en Tolima',
      url: 'https://www.datos.gov.co/resource/p6dx-8zbt.json?$select=id_del_proceso,nombre_del_procedimiento&$where=departamento_entidad%20%3D%20%27Tolima%27%20AND%20starts_with(codigo_principal_de_categoria,%20%27V1.8111%27)%20AND%20estado_del_procedimiento%20!%3D%20%27Borrador%27&$order=fecha_de_publicacion_del%20DESC&$limit=25',
      extract: { type: 'json', path: '[*].id_del_proceso' },
      mode: 'list',
      alertOn: 'added',
      notify: ['log', 'history'],
      quietHours: { from: '23:00', to: '07:00', tz: 'America/Bogota' },
    },
    {
      name: 'node-lts',
      label: 'Node.js — versión LTS publicada',
      url: 'https://nodejs.org/dist/index.json',
      extract: { type: 'json', path: '[0].version' },
      mode: 'value',
      notify: ['log'],
    },
  ],
};

export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!match) throw new ConfigError(`"${text}" is not a duration (use 500ms, 45s, 15m, 2h)`);
  const value = Number(match[1]);
  const unit = match[2] ?? 'm';
  return value * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
}

export function parseArgs(argv) {
  const options = { command: 'check', config: 'watchdiff.config.json', only: [], digest: [] };
  let index = 0;
  if (argv[index] && !argv[index].startsWith('-')) options.command = argv[index++];

  const next = (flag) => {
    const value = argv[++index];
    if (value === undefined) throw new ConfigError(`${flag} needs a value`);
    return value;
  };

  for (; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '-c':
      case '--config':
        options.config = next(arg);
        break;
      case '--only':
        options.only.push(...next(arg).split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--digest':
        options.digest.push(...next(arg).split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--interval':
        options.interval = parseDuration(next(arg));
        break;
      case '--dry':
        options.dry = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--exit-change':
        options.exitChange = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        throw new ConfigError(`unknown option ${arg}`);
    }
  }
  return options;
}

const ICONS = { ok: '·', changed: '🔔', deferred: '⏸', baseline: '🆕', error: '⚠️', undelivered: '📵' };

function printEntry(entry, log) {
  const icon = ICONS[entry.status] ?? '?';
  const extra =
    entry.status === 'deferred'
      ? ` (retenido: ${entry.deferredReason})`
      : entry.status === 'undelivered'
        ? ` (no se pudo entregar: ${entry.error})`
        : entry.attempts > 1
          ? ` (${entry.attempts} intentos)`
          : '';
  log(`${icon} ${entry.label}: ${entry.summary}${extra}`);
}

async function commandCheck(options, log, deps) {
  const config = await loadConfig(options.config);
  const result = await runAll(config, {
    only: options.only.length ? options.only : undefined,
    digestTo: options.digest.length ? options.digest : undefined,
    dry: options.dry,
    deps,
    onEntry: options.json || options.quiet ? undefined : (entry) => printEntry(entry, log),
  });

  if (options.json) {
    log(JSON.stringify(result, null, 2));
  } else {
    const { counts } = result;
    if (options.quiet) {
      for (const entry of result.entries) {
        if (entry.status !== 'ok') printEntry(entry, log);
      }
    }
    log(
      `\n${counts.total} verificado(s): ${counts.changed} con cambios, ${counts.baseline} línea base, ` +
        `${counts.deferred} retenido(s), ${counts.errors} con error${options.dry ? ' — modo --dry, nada enviado' : ''}`,
    );
    for (const entry of result.entries) {
      for (const notification of entry.notifications ?? []) {
        if (!notification.ok) log(`   envío fallido → ${notification.notifier}: ${notification.error}`);
      }
    }
    if (result.digest) {
      for (const notification of result.digest.notifications) {
        if (!notification.ok) log(`   resumen fallido → ${notification.notifier}: ${notification.error}`);
      }
    }
  }

  if (result.counts.errors > 0) return 2;
  if (options.exitChange && result.counts.changed > 0) return 3;
  return 0;
}

async function commandWatch(options, log, deps) {
  if (!options.interval) throw new ConfigError('watch needs --interval, e.g. --interval 15m');
  log(`watchdiff ${VERSION}: cada ${Math.round(options.interval / 1000)} s. Ctrl-C para salir.`);
  let running = true;
  const stop = () => {
    running = false;
    log('\nsaliendo tras el ciclo actual…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (running) {
    const started = Date.now();
    try {
      await commandCheck(options, log, deps);
    } catch (error) {
      log(`⚠️ ciclo fallido: ${error.message}`);
    }
    const wait = Math.max(0, options.interval - (Date.now() - started));
    const deadline = Date.now() + wait;
    while (running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  }
  return 0;
}

async function commandStatus(options, log) {
  const config = await loadConfig(options.config);
  const store = new StateStore(config.stateDir);
  const rows = [];
  for (const watcher of config.watchers) {
    const state = await store.read(watcher.name);
    rows.push({
      watcher: watcher.name,
      mode: watcher.mode,
      enabled: watcher.enabled,
      checks: state?.checks ?? 0,
      changes: state?.changeCount ?? 0,
      lastCheck: state?.lastCheck ?? null,
      lastChange: state?.lastChange ?? null,
      consecutiveErrors: state?.consecutiveErrors ?? 0,
      lastError: state?.lastError ?? null,
    });
  }
  if (options.json) {
    log(JSON.stringify({ stateDir: config.stateDir, watchers: rows }, null, 2));
    return 0;
  }
  log(`Estado en ${config.stateDir}\n`);
  for (const row of rows) {
    log(
      `${row.enabled ? '' : '(off) '}${row.watcher} [${row.mode}] — ${row.checks} chequeos, ${row.changes} cambios` +
        `${row.lastCheck ? `, último ${row.lastCheck}` : ', nunca verificado'}` +
        `${row.consecutiveErrors ? `, ${row.consecutiveErrors} error(es) seguidos: ${row.lastError}` : ''}`,
    );
  }
  return 0;
}

async function commandInit(options, log) {
  const target = path.resolve(options.config);
  try {
    await writeFile(target, `${JSON.stringify(SAMPLE_CONFIG, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new ConfigError(`${target} already exists; delete it or pass -c another-file.json`);
    throw error;
  }
  log(`Config de ejemplo escrita en ${target}`);
  log('Siguiente paso: watchdiff check --dry   (lee, compara y no envía nada)');
  return 0;
}

export async function main(argv, { log = console.log, errorLog = console.error, deps = {} } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorLog(`watchdiff: ${error.message}\n`);
    errorLog(HELP);
    return 1;
  }
  if (options.help) {
    log(HELP);
    return 0;
  }
  if (options.version) {
    log(VERSION);
    return 0;
  }

  try {
    switch (options.command) {
      case 'check':
        return await commandCheck(options, log, deps);
      case 'watch':
        return await commandWatch(options, log, deps);
      case 'status':
        return await commandStatus(options, log);
      case 'init':
        return await commandInit(options, log);
      default:
        errorLog(`watchdiff: unknown command "${options.command}"\n`);
        errorLog(HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      errorLog(`watchdiff: ${error.message}`);
      return 1;
    }
    errorLog(`watchdiff: ${error?.stack ?? error}`);
    return 2;
  }
}

export { SAMPLE_CONFIG, HELP };
