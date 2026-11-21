/**
 * Configuration loading and validation.
 *
 * A monitor that silently misreads its own config is worse than one that does
 * not start, so every field is validated up front with an error message that
 * names the exact path. Secrets are never written in the config file: any string
 * may be `env:VAR_NAME` and is resolved from the environment at load time.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const EXTRACTOR_TYPES = ['text', 'json', 'regex'];
export const MODES = ['value', 'list', 'number'];
export const NOTIFIER_TYPES = ['console', 'webhook', 'telegram', 'command', 'jsonl'];

const DEFAULTS = {
  timeoutMs: 20_000,
  retries: 2,
  retryDelayMs: 5_000,
  cooldownMinutes: 0,
  notifyOnError: true,
  /** Consecutive failed checks before the error is reported. One blip is not an outage. */
  errorThreshold: 2,
};

/** Resolves `env:NAME` references. Any other string is returned unchanged. */
export function resolveSecret(value, env = process.env, where = 'value') {
  if (typeof value !== 'string' || !value.startsWith('env:')) return value;
  const name = value.slice(4).trim();
  if (!name) throw new ConfigError(`${where}: "env:" needs a variable name`);
  const resolved = env[name];
  if (resolved === undefined || resolved === '') {
    throw new ConfigError(`${where}: environment variable ${name} is not set`);
  }
  return resolved;
}

function requireString(object, key, where) {
  const value = object[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`${where}.${key} is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalNumber(object, key, where, { min = 0 } = {}) {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new ConfigError(`${where}.${key} must be a number >= ${min}`);
  }
  return value;
}

function parseQuietHours(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new ConfigError(`${where}.quietHours must be an object`);
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/;
  for (const key of ['from', 'to']) {
    if (!time.test(String(value[key] ?? ''))) {
      throw new ConfigError(`${where}.quietHours.${key} must be a HH:MM time, got ${JSON.stringify(value[key])}`);
    }
  }
  return { from: value.from, to: value.to, tz: value.tz ?? 'UTC' };
}

function validateExtractor(raw, where) {
  if (raw === undefined) return { type: 'text', stripHtml: true };
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`${where}.extract must be an object`);
  const type = raw.type ?? 'text';
  if (!EXTRACTOR_TYPES.includes(type)) {
    throw new ConfigError(`${where}.extract.type must be one of ${EXTRACTOR_TYPES.join(', ')}, got ${JSON.stringify(type)}`);
  }
  const extract = { type };
  if (type === 'text') {
    extract.stripHtml = raw.stripHtml !== false;
    if (raw.between !== undefined) {
      if (!Array.isArray(raw.between) || raw.between.length !== 2 || raw.between.some((s) => typeof s !== 'string')) {
        throw new ConfigError(`${where}.extract.between must be a pair of strings [start, end]`);
      }
      extract.between = raw.between;
    }
  }
  if (type === 'json') {
    extract.path = requireString(raw, 'path', `${where}.extract`);
  }
  if (type === 'regex') {
    extract.pattern = requireString(raw, 'pattern', `${where}.extract`);
    extract.flags = raw.flags ?? 'g';
    extract.group = optionalNumber(raw, 'group', `${where}.extract`) ?? 0;
    try {
      new RegExp(extract.pattern, extract.flags);
    } catch (error) {
      throw new ConfigError(`${where}.extract.pattern is not a valid regex: ${error.message}`);
    }
  }
  return extract;
}

/**
 * Validates one notifier. A notifier that no enabled watcher uses is validated
 * leniently (`lazy`): the sample config ships Telegram and Slack entries as
 * documentation, and a missing `TELEGRAM_BOT_TOKEN` must not stop the watchers
 * that only write to a log. The failure is kept on the notifier, so routing an
 * alert to it later reports exactly what is missing instead of going silent.
 */
function validateNotifier(name, raw, env, { lazy = false } = {}) {
  if (lazy) {
    try {
      return validateNotifier(name, raw, env, { lazy: false });
    } catch (error) {
      if (error instanceof ConfigError) return { name, type: raw?.type ?? 'unknown', unavailable: error.message };
      throw error;
    }
  }
  const where = `notifiers.${name}`;
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`${where} must be an object`);
  const type = requireString(raw, 'type', where);
  if (!NOTIFIER_TYPES.includes(type)) {
    throw new ConfigError(`${where}.type must be one of ${NOTIFIER_TYPES.join(', ')}, got ${JSON.stringify(type)}`);
  }
  const notifier = { name, type };
  if (type === 'webhook') {
    notifier.url = resolveSecret(requireString(raw, 'url', where), env, `${where}.url`);
    notifier.template = raw.template ?? 'json';
    if (!['json', 'slack', 'discord'].includes(notifier.template)) {
      throw new ConfigError(`${where}.template must be json, slack or discord`);
    }
    notifier.headers = raw.headers ?? {};
  }
  if (type === 'telegram') {
    notifier.botToken = resolveSecret(requireString(raw, 'botToken', where), env, `${where}.botToken`);
    notifier.chatId = String(resolveSecret(requireString(raw, 'chatId', where), env, `${where}.chatId`));
  }
  if (type === 'command') {
    const command = raw.command;
    if (!Array.isArray(command) || !command.length || command.some((c) => typeof c !== 'string')) {
      throw new ConfigError(`${where}.command must be a non-empty array of strings, e.g. ["/usr/bin/notify-send"]`);
    }
    notifier.command = command;
  }
  if (type === 'jsonl') {
    notifier.file = requireString(raw, 'file', where);
  }
  return notifier;
}

function validateWatcher(raw, index, notifierNames, defaults) {
  const where = `watchers[${index}]`;
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`${where} must be an object`);
  const name = requireString(raw, 'name', where);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new ConfigError(`${where}.name must be filename-safe (letters, digits, dot, dash, underscore), got ${JSON.stringify(name)}`);
  }
  const url = requireString(raw, 'url', where);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ConfigError(`${where}.url is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new ConfigError(`${where}.url must be http or https, got ${parsedUrl.protocol}`);
  }

  const mode = raw.mode ?? 'value';
  if (!MODES.includes(mode)) {
    throw new ConfigError(`${where}.mode must be one of ${MODES.join(', ')}, got ${JSON.stringify(mode)}`);
  }

  const notify = raw.notify ?? defaults.notify ?? [];
  if (!Array.isArray(notify) || notify.some((n) => typeof n !== 'string')) {
    throw new ConfigError(`${where}.notify must be an array of notifier names`);
  }
  for (const target of notify) {
    if (!notifierNames.includes(target)) {
      throw new ConfigError(
        `${where}.notify refers to "${target}", which is not defined in notifiers (defined: ${notifierNames.join(', ') || 'none'})`,
      );
    }
  }

  const watcher = {
    name,
    url,
    label: raw.label ?? name,
    method: (raw.method ?? 'GET').toUpperCase(),
    headers: raw.headers ?? {},
    body: raw.body,
    extract: validateExtractor(raw.extract, where),
    mode,
    notify,
    timeoutMs: optionalNumber(raw, 'timeoutMs', where, { min: 1 }) ?? defaults.timeoutMs,
    retries: optionalNumber(raw, 'retries', where) ?? defaults.retries,
    retryDelayMs: optionalNumber(raw, 'retryDelayMs', where) ?? defaults.retryDelayMs,
    cooldownMinutes: optionalNumber(raw, 'cooldownMinutes', where) ?? defaults.cooldownMinutes,
    errorThreshold: optionalNumber(raw, 'errorThreshold', where, { min: 1 }) ?? defaults.errorThreshold,
    notifyOnError: raw.notifyOnError ?? defaults.notifyOnError,
    quietHours: parseQuietHours(raw.quietHours, where) ?? defaults.quietHours,
    enabled: raw.enabled !== false,
  };

  if (mode === 'number') {
    watcher.threshold = optionalNumber(raw, 'threshold', where);
    watcher.thresholdPercent = optionalNumber(raw, 'thresholdPercent', where);
  }
  if (mode === 'list') {
    watcher.alertOn = raw.alertOn ?? 'added';
    if (!['added', 'removed', 'both'].includes(watcher.alertOn)) {
      throw new ConfigError(`${where}.alertOn must be added, removed or both`);
    }
    watcher.maxItemsInAlert = optionalNumber(raw, 'maxItemsInAlert', where, { min: 1 }) ?? 10;
  }
  return watcher;
}

/** Validates a plain object into a usable config. `baseDir` resolves relative paths. */
export function parseConfig(raw, { baseDir = process.cwd(), env = process.env } = {}) {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('config must be a JSON object');

  const rawDefaults = raw.defaults ?? {};
  if (typeof rawDefaults !== 'object' || rawDefaults === null) throw new ConfigError('defaults must be an object');
  const defaults = {
    ...DEFAULTS,
    timeoutMs: optionalNumber(rawDefaults, 'timeoutMs', 'defaults', { min: 1 }) ?? DEFAULTS.timeoutMs,
    retries: optionalNumber(rawDefaults, 'retries', 'defaults') ?? DEFAULTS.retries,
    retryDelayMs: optionalNumber(rawDefaults, 'retryDelayMs', 'defaults') ?? DEFAULTS.retryDelayMs,
    cooldownMinutes: optionalNumber(rawDefaults, 'cooldownMinutes', 'defaults') ?? DEFAULTS.cooldownMinutes,
    errorThreshold: optionalNumber(rawDefaults, 'errorThreshold', 'defaults', { min: 1 }) ?? DEFAULTS.errorThreshold,
    notifyOnError: rawDefaults.notifyOnError ?? DEFAULTS.notifyOnError,
    notify: rawDefaults.notify,
    quietHours: parseQuietHours(rawDefaults.quietHours, 'defaults'),
  };
  if (defaults.notify !== undefined && (!Array.isArray(defaults.notify) || defaults.notify.some((n) => typeof n !== 'string'))) {
    throw new ConfigError('defaults.notify must be an array of notifier names');
  }

  const rawNotifiers = raw.notifiers ?? {};
  if (typeof rawNotifiers !== 'object' || rawNotifiers === null) throw new ConfigError('notifiers must be an object');

  if (!Array.isArray(raw.watchers) || raw.watchers.length === 0) {
    throw new ConfigError('watchers must be a non-empty array');
  }
  const names = new Set();
  const watchers = raw.watchers.map((watcher, index) => {
    const parsed = validateWatcher(watcher, index, Object.keys(rawNotifiers), defaults);
    if (names.has(parsed.name)) throw new ConfigError(`watchers[${index}].name "${parsed.name}" is used twice`);
    names.add(parsed.name);
    return parsed;
  });

  // Only the channels something actually routes to have to be fully resolvable.
  const used = new Set(watchers.filter((w) => w.enabled).flatMap((w) => w.notify));
  const notifiers = {};
  for (const [name, value] of Object.entries(rawNotifiers)) {
    notifiers[name] = validateNotifier(name, value, env, { lazy: !used.has(name) });
  }

  const stateDir = path.resolve(baseDir, raw.stateDir ?? '.watchdiff');
  return { stateDir, defaults, notifiers, watchers };
}

export async function loadConfig(file, { env = process.env } = {}) {
  const absolute = path.resolve(file);
  let text;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read config ${absolute}: ${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${absolute} is not valid JSON: ${error.message}`);
  }
  return parseConfig(raw, { baseDir: path.dirname(absolute), env });
}
