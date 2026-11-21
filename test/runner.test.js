/**
 * End-to-end tests: a real HTTP server, a real state directory on disk, and the
 * full check → compare → notify path. These are the tests that would have caught
 * the failures that actually matter in a monitor: a missed change, a false
 * alarm, or an alert lost because the baseline advanced without delivery.
 */

import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { checkWatcher, inQuietHours, minutesInZone, runAll } from '../src/runner.js';

/** Minimal HTTP server whose body the test can swap between checks. */
async function serve(initialBody, contentType = 'application/json') {
  const state = { body: initialBody, status: 200, hits: 0 };
  const server = createServer((request, response) => {
    state.hits++;
    response.writeHead(state.status, { 'content-type': contentType });
    response.end(typeof state.body === 'string' ? state.body : JSON.stringify(state.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    url: `http://127.0.0.1:${port}/`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'watchdiff-test-'));
  return { dir, store: new StateStore(dir) };
}

function capturing() {
  const sent = [];
  return { sent, logger: (text) => sent.push(text) };
}

function config(watcher, extra = {}) {
  return parseConfig({
    notifiers: { log: { type: 'console' }, ...extra.notifiers },
    watchers: [{ notify: ['log'], ...watcher }],
    ...extra.root,
  });
}

test('the first check stores a baseline and stays silent', async () => {
  const server = await serve([{ id: 'a' }, { id: 'b' }]);
  const { store, dir } = await tempStore();
  const capture = capturing();
  const parsed = config({ name: 'ids', url: server.url, extract: { type: 'json', path: '[*].id' }, mode: 'list' });

  const entry = await checkWatcher(parsed.watchers[0], {
    store,
    notifiers: parsed.notifiers,
    deps: { logger: capture.logger },
  });

  assert.equal(entry.status, 'baseline');
  assert.equal(capture.sent.length, 0, 'the first reading is not news');
  const saved = JSON.parse(await readFile(path.join(dir, 'ids.json'), 'utf8'));
  assert.deepEqual(saved.items, ['a', 'b']);
  assert.equal(saved.checks, 1);
  await server.close();
});

test('a new item in the list produces exactly one alert, then goes quiet', async () => {
  const server = await serve([{ id: 'a' }]);
  const { store } = await tempStore();
  const capture = capturing();
  const parsed = config({ name: 'ids', url: server.url, extract: { type: 'json', path: '[*].id' }, mode: 'list' });
  const context = { store, notifiers: parsed.notifiers, deps: { logger: capture.logger } };

  await checkWatcher(parsed.watchers[0], context);
  server.state.body = [{ id: 'a' }, { id: 'b' }];
  const changed = await checkWatcher(parsed.watchers[0], context);
  const again = await checkWatcher(parsed.watchers[0], context);

  assert.equal(changed.status, 'changed');
  assert.deepEqual(changed.result.added, ['b']);
  assert.equal(changed.notifications[0].ok, true);
  assert.equal(again.status, 'ok', 'the same state is not re-announced');
  assert.equal(capture.sent.length, 1);
  assert.match(capture.sent[0], /\+ b/);
  await server.close();
});

test('an intermittent 500 is retried and does not look like a change', async () => {
  const { store } = await tempStore();
  const capture = capturing();
  const parsed = config({ name: 'flaky', url: 'https://example.test/x', retries: 2, retryDelayMs: 1 });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) return new Response('upstream hiccup', { status: 500 });
    return new Response('<p>Estado: ACTIVA</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const context = { store, notifiers: parsed.notifiers, deps: { logger: capture.logger, fetchImpl, sleepImpl: async () => {} } };

  const entry = await checkWatcher(parsed.watchers[0], context);
  assert.equal(entry.status, 'baseline');
  assert.equal(entry.attempts, 3);
  assert.equal(capture.sent.length, 0);
});

test('a persistent failure is reported only after errorThreshold consecutive misses', async () => {
  const { store } = await tempStore();
  const capture = capturing();
  const parsed = config({ name: 'down', url: 'https://example.test/x', retries: 0, errorThreshold: 2 });
  const deps = {
    logger: capture.logger,
    fetchImpl: async () => new Response('nope', { status: 503 }),
    sleepImpl: async () => {},
  };
  const context = { store, notifiers: parsed.notifiers, deps };

  const first = await checkWatcher(parsed.watchers[0], context);
  assert.equal(first.status, 'error');
  assert.equal(first.consecutiveErrors, 1);
  assert.equal(capture.sent.length, 0, 'one blip is not an outage');

  const second = await checkWatcher(parsed.watchers[0], context);
  assert.equal(second.consecutiveErrors, 2);
  assert.equal(capture.sent.length, 1);
  assert.match(capture.sent[0], /fallo de verificación \(2 seguidos\)/);
});

test('a 404 is not retried: the page being gone is news, not a glitch', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const parsed = config({ name: 'gone', url: 'https://example.test/x', retries: 3, errorThreshold: 1 });
  const entry = await checkWatcher(parsed.watchers[0], {
    store,
    notifiers: parsed.notifiers,
    deps: {
      logger: () => {},
      fetchImpl: async () => {
        calls++;
        return new Response('missing', { status: 404 });
      },
      sleepImpl: async () => {},
    },
  });
  assert.equal(calls, 1);
  assert.match(entry.error, /HTTP 404/);
});

test('a change during quiet hours is held back AND the baseline is kept, so it is reported later', async () => {
  const server = await serve('<p>Estado: ACTIVA</p>', 'text/html');
  const { store } = await tempStore();
  const capture = capturing();
  const parsed = config({
    name: 'estado',
    url: server.url,
    quietHours: { from: '23:00', to: '07:00', tz: 'UTC' },
  });
  const deps = { logger: capture.logger };

  // 20:00 UTC — outside the quiet window: baseline.
  await checkWatcher(parsed.watchers[0], { store, notifiers: parsed.notifiers, deps, now: () => new Date('2026-11-21T20:00:00Z') });

  server.state.body = '<p>Estado: CANCELADA</p>';
  const night = await checkWatcher(parsed.watchers[0], {
    store,
    notifiers: parsed.notifiers,
    deps,
    now: () => new Date('2026-11-22T02:00:00Z'),
  });
  assert.equal(night.status, 'deferred');
  assert.equal(night.deferredReason, 'horario de silencio');
  assert.equal(capture.sent.length, 0);

  const morning = await checkWatcher(parsed.watchers[0], {
    store,
    notifiers: parsed.notifiers,
    deps,
    now: () => new Date('2026-11-22T13:00:00Z'),
  });
  assert.equal(morning.status, 'changed', 'the change survived the night');
  assert.equal(capture.sent.length, 1);
  assert.match(capture.sent[0], /CANCELADA/);
  await server.close();
});

test('a cooldown batches a second change instead of dropping it', async () => {
  const server = await serve([{ id: 'a' }]);
  const { store } = await tempStore();
  const capture = capturing();
  const parsed = config({
    name: 'ids',
    url: server.url,
    extract: { type: 'json', path: '[*].id' },
    mode: 'list',
    cooldownMinutes: 60,
  });
  const at = (iso) => ({ store, notifiers: parsed.notifiers, deps: { logger: capture.logger }, now: () => new Date(iso) });

  await checkWatcher(parsed.watchers[0], at('2026-11-21T10:00:00Z'));
  server.state.body = [{ id: 'a' }, { id: 'b' }];
  await checkWatcher(parsed.watchers[0], at('2026-11-21T10:05:00Z'));
  assert.equal(capture.sent.length, 1);

  server.state.body = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const held = await checkWatcher(parsed.watchers[0], at('2026-11-21T10:10:00Z'));
  assert.equal(held.status, 'deferred');
  assert.match(held.deferredReason, /cooldown \(55 min restantes\)/);

  const later = await checkWatcher(parsed.watchers[0], at('2026-11-21T11:30:00Z'));
  assert.equal(later.status, 'changed');
  assert.deepEqual(later.result.added, ['c'], 'nothing was lost while the cooldown held');
  assert.equal(capture.sent.length, 2);
  await server.close();
});

test('if every channel fails, the baseline is not advanced and the alert is retried', async () => {
  const server = await serve('<p>v1</p>', 'text/html');
  const { store } = await tempStore();
  const parsed = config(
    { name: 'page', url: server.url, notify: ['broken'] },
    { notifiers: { broken: { type: 'webhook', url: 'https://hooks.example.test/x' } } },
  );
  let posts = 0;
  const deps = {
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return new Response('nope', { status: 500 });
      }
      return undefined;
    },
  };
  // The watcher fetch must hit the real server; only the webhook POST is stubbed.
  const realFetch = globalThis.fetch;
  const context = {
    store,
    notifiers: parsed.notifiers,
    deps: { fetchImpl: async (url, init) => (init?.method === 'POST' ? deps.fetchImpl(url, init) : realFetch(url, init)) },
  };

  await checkWatcher(parsed.watchers[0], context);
  server.state.body = '<p>v2</p>';
  const first = await checkWatcher(parsed.watchers[0], context);
  assert.equal(first.status, 'undelivered');
  assert.equal(posts, 1);

  const retry = await checkWatcher(parsed.watchers[0], context);
  assert.equal(retry.status, 'undelivered', 'the change is still pending because nobody was told');
  assert.equal(posts, 2);
  await server.close();
});

test('a corrupt state file is re-seeded instead of firing a false alarm', async () => {
  const server = await serve('<p>v1</p>', 'text/html');
  const { store, dir } = await tempStore();
  const capture = capturing();
  const parsed = config({ name: 'page', url: server.url });
  const context = { store, notifiers: parsed.notifiers, deps: { logger: capture.logger } };

  await checkWatcher(parsed.watchers[0], context);
  await (await import('node:fs/promises')).writeFile(path.join(dir, 'page.json'), '{ this is not json', 'utf8');
  const entry = await checkWatcher(parsed.watchers[0], context);
  assert.equal(entry.status, 'baseline');
  assert.equal(capture.sent.length, 0);
  await server.close();
});

test('--dry reads and compares but writes no state and sends nothing', async () => {
  const server = await serve('<p>v1</p>', 'text/html');
  const { store, dir } = await tempStore();
  const capture = capturing();
  const parsed = config({ name: 'page', url: server.url });

  await checkWatcher(parsed.watchers[0], { store, notifiers: parsed.notifiers, deps: { logger: capture.logger }, dry: true });
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), [], 'nothing was written');
  assert.equal(capture.sent.length, 0);
  await server.close();
});

test('runAll reports counts, honours --only and can send a digest', async () => {
  const server = await serve([{ id: 'a' }]);
  const { store } = await tempStore();
  const capture = capturing();
  const parsed = parseConfig({
    notifiers: { log: { type: 'console' } },
    watchers: [
      { name: 'one', url: server.url, extract: { type: 'json', path: '[*].id' }, mode: 'list', notify: ['log'] },
      { name: 'two', url: server.url, extract: { type: 'json', path: '[0].id' }, mode: 'value', notify: ['log'] },
    ],
  });

  const seeded = await runAll(parsed, { store, deps: { logger: capture.logger } });
  assert.equal(seeded.counts.baseline, 2);

  server.state.body = [{ id: 'z' }];
  const only = await runAll(parsed, { store, deps: { logger: capture.logger }, only: ['two'] });
  assert.equal(only.counts.total, 1);
  assert.equal(only.counts.changed, 1);

  const digest = await runAll(parsed, { store, deps: { logger: capture.logger }, digestTo: ['log'] });
  assert.ok(digest.digest.text.includes('Resumen'));
  assert.equal(digest.digest.notifications[0].ok, true);

  await assert.rejects(() => runAll(parsed, { store, only: ['nope'] }), /no watcher named "nope"/);
  await server.close();
});

test('quiet-hour arithmetic handles a window that wraps midnight, in the configured timezone', () => {
  const quiet = { from: '23:00', to: '07:00', tz: 'America/Bogota' };
  // 03:00 UTC = 22:00 in Bogotá (UTC-5) — still awake.
  assert.equal(inQuietHours(quiet, new Date('2026-11-22T03:00:00Z')), false);
  // 05:00 UTC = 00:00 in Bogotá — asleep.
  assert.equal(inQuietHours(quiet, new Date('2026-11-22T05:00:00Z')), true);
  // 13:00 UTC = 08:00 in Bogotá — awake again.
  assert.equal(inQuietHours(quiet, new Date('2026-11-22T13:00:00Z')), false);
  assert.equal(inQuietHours(undefined, new Date()), false);
  assert.equal(minutesInZone(new Date('2026-11-22T05:30:00Z'), 'America/Bogota'), 30);
});
