import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main, parseArgs, parseDuration } from '../src/cli.js';

async function workspace() {
  return mkdtemp(path.join(tmpdir(), 'watchdiff-cli-'));
}

function collector() {
  const lines = [];
  return { lines, log: (text) => lines.push(String(text)), text: () => lines.join('\n') };
}

test('parseArgs reads the command, repeated --only and durations', () => {
  const options = parseArgs(['check', '-c', 'my.json', '--only', 'a,b', '--only', 'c', '--dry', '--exit-change']);
  assert.equal(options.command, 'check');
  assert.equal(options.config, 'my.json');
  assert.deepEqual(options.only, ['a', 'b', 'c']);
  assert.equal(options.dry, true);
  assert.equal(options.exitChange, true);

  assert.equal(parseArgs([]).command, 'check', 'check is the default command');
  assert.equal(parseDuration('45s'), 45_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('30'), 1_800_000, 'a bare number means minutes');
  assert.throws(() => parseDuration('soon'), /is not a duration/);
});

test('an unknown option fails with usage instead of running anything', async () => {
  const out = collector();
  const err = collector();
  const code = await main(['check', '--turbo'], { log: out.log, errorLog: err.log });
  assert.equal(code, 1);
  assert.match(err.text(), /unknown option --turbo/);
  assert.match(err.text(), /Usage:/);
});

test('--help and --version are exit 0', async () => {
  const out = collector();
  assert.equal(await main(['--help'], { log: out.log, errorLog: out.log }), 0);
  assert.match(out.text(), /watch a page or an API/);
  const version = collector();
  assert.equal(await main(['--version'], { log: version.log, errorLog: version.log }), 0);
  assert.match(version.text(), /^\d+\.\d+\.\d+$/);
});

test('init writes a runnable sample config and refuses to overwrite it', async () => {
  const dir = await workspace();
  const file = path.join(dir, 'watchdiff.config.json');
  const out = collector();
  assert.equal(await main(['init', '-c', file], { log: out.log, errorLog: out.log }), 0);

  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(written.watchers.length >= 1);
  assert.ok(written.notifiers.log);
  assert.match(out.text(), /Config de ejemplo escrita/);

  const second = collector();
  assert.equal(await main(['init', '-c', file], { log: second.log, errorLog: second.log }), 1);
  assert.match(second.text(), /already exists/);
});

test('a config error exits 1 and names the problem', async () => {
  const dir = await workspace();
  const file = path.join(dir, 'broken.json');
  await writeFile(file, JSON.stringify({ notifiers: {}, watchers: [{ name: 'a' }] }), 'utf8');
  const err = collector();
  assert.equal(await main(['check', '-c', file], { log: () => {}, errorLog: err.log }), 1);
  assert.match(err.text(), /watchers\[0\]\.url is required/);
});

test('a missing config file is a configuration error, not a crash', async () => {
  const err = collector();
  assert.equal(await main(['check', '-c', '/nonexistent/watchdiff.json'], { log: () => {}, errorLog: err.log }), 1);
  assert.match(err.text(), /cannot read config/);
});

test('check runs end to end, and --exit-change reports a change through the exit code', async () => {
  const dir = await workspace();
  const body = { value: 'v1' };
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const file = path.join(dir, 'watchdiff.config.json');
  await writeFile(
    file,
    JSON.stringify({
      stateDir: 'state',
      notifiers: { history: { type: 'jsonl', file: path.join(dir, 'alerts.jsonl') } },
      watchers: [
        {
          name: 'api',
          label: 'Local API',
          url: `http://127.0.0.1:${port}/`,
          extract: { type: 'json', path: 'value' },
          notify: ['history'],
        },
      ],
    }),
    'utf8',
  );

  const first = collector();
  assert.equal(await main(['check', '-c', file], { log: first.log, errorLog: first.log }), 0);
  assert.match(first.text(), /🆕 Local API: línea base guardada/);

  body.value = 'v2';
  const second = collector();
  const code = await main(['check', '-c', file, '--exit-change'], { log: second.log, errorLog: second.log });
  assert.equal(code, 3, 'exit 3 lets a shell script react to a change');
  assert.match(second.text(), /🔔 Local API: "v1" → "v2"/);

  const alerts = (await readFile(path.join(dir, 'alerts.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(alerts.length, 1);
  assert.equal(JSON.parse(alerts[0]).watcher, 'api');

  const status = collector();
  assert.equal(await main(['status', '-c', file, '--json'], { log: status.log, errorLog: status.log }), 0);
  const parsed = JSON.parse(status.text());
  assert.equal(parsed.watchers[0].changes, 1);
  assert.equal(parsed.watchers[0].checks, 2);

  await new Promise((resolve) => server.close(resolve));
});

test('a watcher that cannot be read exits 2', async () => {
  const dir = await workspace();
  const file = path.join(dir, 'watchdiff.config.json');
  await writeFile(
    file,
    JSON.stringify({
      stateDir: 'state',
      notifiers: { log: { type: 'console' } },
      watchers: [{ name: 'dead', url: 'http://127.0.0.1:1/', retries: 0, notify: ['log'] }],
    }),
    'utf8',
  );
  const out = collector();
  assert.equal(await main(['check', '-c', file], { log: out.log, errorLog: out.log }), 2);
  assert.match(out.text(), /⚠️ dead: no se pudo leer la página/);
});
