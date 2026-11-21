import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ConfigError, parseConfig, resolveSecret } from '../src/config.js';

const MINIMAL = {
  notifiers: { log: { type: 'console' } },
  watchers: [{ name: 'a', url: 'https://example.test/a', notify: ['log'] }],
};

test('a minimal config gets usable defaults', () => {
  const config = parseConfig(MINIMAL, { baseDir: '/tmp/x' });
  assert.equal(config.stateDir, '/tmp/x/.watchdiff');
  const [watcher] = config.watchers;
  assert.equal(watcher.mode, 'value');
  assert.equal(watcher.method, 'GET');
  assert.equal(watcher.label, 'a', 'label falls back to the name');
  assert.deepEqual(watcher.extract, { type: 'text', stripHtml: true });
  assert.equal(watcher.retries, 2);
  assert.equal(watcher.errorThreshold, 2);
  assert.equal(watcher.enabled, true);
});

test('defaults.notify applies to watchers that do not list their own channels', () => {
  const config = parseConfig({
    ...MINIMAL,
    defaults: { notify: ['log'], cooldownMinutes: 30 },
    watchers: [{ name: 'a', url: 'https://example.test/a' }],
  });
  assert.deepEqual(config.watchers[0].notify, ['log']);
  assert.equal(config.watchers[0].cooldownMinutes, 30);
});

test('env: references are resolved and a missing variable fails loudly', () => {
  const env = { TOKEN: 'abc123' };
  assert.equal(resolveSecret('env:TOKEN', env), 'abc123');
  assert.equal(resolveSecret('literal', env), 'literal');
  assert.throws(() => resolveSecret('env:NOPE', env), /NOPE is not set/);

  const config = parseConfig(
    {
      notifiers: { tg: { type: 'telegram', botToken: 'env:TOKEN', chatId: '42' } },
      watchers: [{ name: 'a', url: 'https://example.test/a', notify: ['tg'] }],
    },
    { env },
  );
  assert.equal(config.notifiers.tg.botToken, 'abc123');
});

test('a channel in use must resolve; an unused one only fails if something routes to it', () => {
  assert.throws(
    () =>
      parseConfig({
        notifiers: { tg: { type: 'telegram', botToken: 'env:ABSENT', chatId: '42' } },
        watchers: [{ name: 'a', url: 'https://example.test/a', notify: ['tg'] }],
      }),
    /ABSENT is not set/,
  );

  // The sample config documents Telegram and Slack; a user watching one page
  // with the console notifier must not have to set their secrets first.
  const config = parseConfig(
    {
      notifiers: {
        log: { type: 'console' },
        tg: { type: 'telegram', botToken: 'env:ABSENT', chatId: '42' },
      },
      watchers: [{ name: 'a', url: 'https://example.test/a', notify: ['log'] }],
    },
    { env: {} },
  );
  assert.equal(config.notifiers.log.type, 'console');
  assert.match(config.notifiers.tg.unavailable, /ABSENT is not set/, 'the reason is kept for the moment it is used');
});

test('a notifier name that does not exist is caught at load time, not at 3am', () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, watchers: [{ name: 'a', url: 'https://example.test/a', notify: ['typo'] }] }),
    /refers to "typo", which is not defined/,
  );
});

test('duplicate watcher names are rejected — they would share one state file', () => {
  assert.throws(
    () =>
      parseConfig({
        ...MINIMAL,
        watchers: [
          { name: 'a', url: 'https://example.test/1', notify: ['log'] },
          { name: 'a', url: 'https://example.test/2', notify: ['log'] },
        ],
      }),
    /"a" is used twice/,
  );
});

test('a name that is not filename-safe is rejected', () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, watchers: [{ name: '../escape', url: 'https://e.test', notify: ['log'] }] }),
    /filename-safe/,
  );
});

test('non-http URLs and malformed URLs are rejected', () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, watchers: [{ name: 'a', url: 'file:///etc/passwd', notify: ['log'] }] }),
    /must be http or https/,
  );
  assert.throws(
    () => parseConfig({ ...MINIMAL, watchers: [{ name: 'a', url: 'not a url', notify: ['log'] }] }),
    /is not a valid URL/,
  );
});

test('an invalid regex in an extractor is reported with its path', () => {
  assert.throws(
    () =>
      parseConfig({
        ...MINIMAL,
        watchers: [{ name: 'a', url: 'https://e.test', notify: ['log'], extract: { type: 'regex', pattern: '([' } }],
      }),
    /watchers\[0\]\.extract\.pattern is not a valid regex/,
  );
});

test('quietHours must be real times', () => {
  const ok = parseConfig({
    ...MINIMAL,
    watchers: [{ name: 'a', url: 'https://e.test', notify: ['log'], quietHours: { from: '23:00', to: '07:30', tz: 'America/Bogota' } }],
  });
  assert.deepEqual(ok.watchers[0].quietHours, { from: '23:00', to: '07:30', tz: 'America/Bogota' });
  assert.throws(
    () =>
      parseConfig({
        ...MINIMAL,
        watchers: [{ name: 'a', url: 'https://e.test', notify: ['log'], quietHours: { from: '25:00', to: '07:00' } }],
      }),
    /quietHours\.from must be a HH:MM time/,
  );
});

test('unknown modes, extractor types and notifier types are rejected by name', () => {
  assert.throws(() => parseConfig({ ...MINIMAL, watchers: [{ name: 'a', url: 'https://e.test', notify: ['log'], mode: 'guess' }] }), /mode must be one of/);
  assert.throws(
    () => parseConfig({ ...MINIMAL, watchers: [{ name: 'a', url: 'https://e.test', notify: ['log'], extract: { type: 'xpath' } }] }),
    /extract\.type must be one of/,
  );
  assert.throws(
    () =>
      parseConfig({
        notifiers: { x: { type: 'carrier-pigeon' } },
        watchers: [{ name: 'a', url: 'https://example.test/a', notify: ['x'] }],
      }),
    /type must be one of/,
  );
});

test('a json extractor without a path is rejected', () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, watchers: [{ name: 'a', url: 'https://e.test', notify: ['log'], extract: { type: 'json' } }] }),
    /extract\.path is required/,
  );
});

test('an empty watcher list is a configuration error', () => {
  assert.throws(() => parseConfig({ notifiers: {}, watchers: [] }), /watchers must be a non-empty array/);
  assert.throws(() => parseConfig(null), /config must be a JSON object/);
  assert.ok(ConfigError.prototype instanceof Error);
});
