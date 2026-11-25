/**
 * Orchestration: one pass over the watchers.
 *
 * The rule that shapes everything here: **a change the human was not told about
 * must not be written to the baseline.** If an alert is held back by quiet hours
 * or a cooldown, the old baseline stays, so the next check detects the same
 * change again and reports it when it is allowed to. Advancing the baseline on a
 * suppressed change is how a monitor loses the one event it existed for.
 */

import { compare, renderAlert, renderDigest } from './diff.js';
import { ExtractError, extract } from './extract.js';
import { fetchBody } from './http.js';
import { messagesFor } from './messages.js';
import { notifyAll } from './notify.js';
import { StateStore, hashValue, initialState } from './state.js';

/** Minutes since midnight for a date in a given IANA timezone. */
export function minutesInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

function toMinutes(hhmm) {
  const [hours, minutes] = String(hhmm).split(':').map(Number);
  return hours * 60 + minutes;
}

/** True when `now` falls inside the configured quiet window (which may wrap midnight). */
export function inQuietHours(quietHours, now) {
  if (!quietHours) return false;
  const current = minutesInZone(now, quietHours.tz ?? 'UTC');
  const from = toMinutes(quietHours.from);
  const to = toMinutes(quietHours.to);
  return from <= to ? current >= from && current < to : current >= from || current < to;
}

function cooldownRemainingMs(state, watcher, now) {
  const minutes = watcher.cooldownMinutes ?? 0;
  if (!minutes || !state?.lastNotifiedAt) return 0;
  const elapsed = now.getTime() - Date.parse(state.lastNotifiedAt);
  const window = minutes * 60_000;
  return elapsed >= window ? 0 : window - elapsed;
}

function advance(state, reading, now, { changed }) {
  const timestamp = now.toISOString();
  return {
    ...state,
    kind: reading.kind,
    value: reading.kind === 'single' ? reading.value : undefined,
    items: reading.kind === 'list' ? reading.items : undefined,
    hash: hashValue(reading.kind === 'single' ? reading.value : reading.items),
    lastCheck: timestamp,
    lastChange: changed ? timestamp : state.lastChange,
    changeCount: (state.changeCount ?? 0) + (changed ? 1 : 0),
    checks: (state.checks ?? 0) + 1,
    consecutiveErrors: 0,
  };
}

/**
 * Checks one watcher and, when warranted, sends its alert.
 * Never throws for an expected failure: the outcome is always an entry.
 */
export async function checkWatcher(watcher, context) {
  const { store, notifiers, dry = false, deps = {} } = context;
  const t = messagesFor(watcher.language);
  const now = context.now ? context.now() : new Date();
  const base = { name: watcher.name, label: watcher.label, url: watcher.url, mode: watcher.mode, checkedAt: now.toISOString() };
  const previous = await store.read(watcher.name);

  let reading;
  let fetchInfo;
  try {
    fetchInfo = await fetchBody(watcher, deps);
    reading = extract(fetchInfo.body, watcher.extract);
  } catch (error) {
    const isExtract = error instanceof ExtractError;
    const message = `${isExtract ? t.extractFailed : t.fetchFailed}: ${error.message}`;
    const consecutiveErrors = (previous?.consecutiveErrors ?? 0) + 1;
    const state = {
      ...(previous ?? { name: watcher.name, firstSeen: now.toISOString(), checks: 0, changeCount: 0 }),
      lastCheck: now.toISOString(),
      lastError: message,
      consecutiveErrors,
    };
    if (!dry) await store.write(watcher.name, state);

    const entry = { ...base, status: 'error', error: message, consecutiveErrors, significant: false, summary: message };
    const shouldReport =
      watcher.notifyOnError !== false &&
      consecutiveErrors >= (watcher.errorThreshold ?? 2) &&
      !inQuietHours(watcher.quietHours, now) &&
      cooldownRemainingMs(state, watcher, now) === 0;
    if (shouldReport && !dry) {
      entry.notifications = await notifyAll(
        watcher.notify,
        notifiers,
        {
          title: t.checkFailedTitle(watcher.label, consecutiveErrors),
          text: [message, '', watcher.url, '', t.alertChecked(now.toISOString())].join('\n'),
          watcher,
          result: { summary: message },
        },
        deps,
      );
      await store.write(watcher.name, { ...state, lastNotifiedAt: now.toISOString() });
    }
    return entry;
  }

  // First successful check: store the baseline and stay quiet. Alerting on the
  // first reading would mean "everything you watch is new", which trains the
  // human to ignore the channel.
  if (!previous || (!previous.hash && !previous.value && !previous.items)) {
    const state = initialState(watcher.name, reading, now);
    if (!dry) await store.write(watcher.name, state);
    return {
      ...base,
      status: 'baseline',
      significant: false,
      summary: reading.kind === 'list' ? t.baselineItems(reading.items.length) : t.baselineChars(reading.value.length),
      attempts: fetchInfo.attempts,
    };
  }

  const result = compare(previous, reading, watcher);
  const entry = {
    ...base,
    status: result.significant ? 'changed' : 'ok',
    changed: result.changed,
    significant: result.significant,
    summary: result.summary,
    result,
    attempts: fetchInfo.attempts,
    durationMs: fetchInfo.durationMs,
  };

  if (!result.significant) {
    if (!dry) await store.write(watcher.name, advance(previous, reading, now, { changed: result.changed }));
    return entry;
  }

  const quiet = inQuietHours(watcher.quietHours, now);
  const cooldown = cooldownRemainingMs(previous, watcher, now);
  if (quiet || cooldown > 0) {
    entry.status = 'deferred';
    entry.deferredReason = quiet ? t.quietHours : t.cooldown(Math.ceil(cooldown / 60_000));
    // Baseline deliberately untouched: the change is re-detected next run.
    if (!dry) {
      await store.write(watcher.name, { ...previous, lastCheck: now.toISOString(), consecutiveErrors: 0, deferred: entry.deferredReason });
    }
    return entry;
  }

  const payload = {
    title: `🔔 ${watcher.label}`,
    text: renderAlert(watcher, result, { now, state: previous }),
    watcher,
    result,
  };
  entry.notifications = dry ? [] : await notifyAll(watcher.notify, notifiers, payload, deps);
  entry.alertText = payload.text;

  if (!dry) {
    const delivered = !watcher.notify.length || entry.notifications.some((n) => n.ok);
    const state = advance(previous, reading, now, { changed: true });
    // If every channel failed, keep the old baseline so the alert is retried.
    await store.write(
      watcher.name,
      delivered ? { ...state, lastNotifiedAt: now.toISOString(), deferred: undefined } : { ...previous, lastCheck: now.toISOString() },
    );
    if (!delivered) {
      entry.status = 'undelivered';
      entry.error = entry.notifications.map((n) => `${n.notifier}: ${n.error}`).join('; ');
    }
  }
  return entry;
}

/** Runs every enabled watcher, sequentially, and optionally sends a digest. */
export async function runAll(config, options = {}) {
  const store = options.store ?? new StateStore(config.stateDir);
  const only = options.only ? new Set(options.only) : null;
  const watchers = config.watchers.filter((w) => w.enabled && (!only || only.has(w.name)));
  if (only) {
    for (const name of only) {
      if (!config.watchers.some((w) => w.name === name)) throw new Error(`no watcher named "${name}" in this config`);
    }
  }

  const entries = [];
  for (const watcher of watchers) {
    const entry = await checkWatcher(watcher, {
      store,
      notifiers: config.notifiers,
      now: options.now,
      dry: options.dry,
      deps: options.deps ?? {},
    });
    entries.push(entry);
    options.onEntry?.(entry);
  }

  let digest = null;
  if (options.digestTo?.length) {
    const now = options.now ? options.now() : new Date();
    const text = renderDigest(entries, { now, language: config.language });
    digest = {
      text,
      notifications: options.dry
        ? []
        : await notifyAll(
            options.digestTo,
            config.notifiers,
            { title: '📋 watchdiff', text, result: { summary: 'digest' } },
            options.deps ?? {},
          ),
    };
  }

  return {
    entries,
    digest,
    counts: {
      total: entries.length,
      changed: entries.filter((e) => e.status === 'changed').length,
      deferred: entries.filter((e) => e.status === 'deferred').length,
      errors: entries.filter((e) => e.status === 'error' || e.status === 'undelivered').length,
      baseline: entries.filter((e) => e.status === 'baseline').length,
    },
  };
}
