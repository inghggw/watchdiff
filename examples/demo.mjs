/**
 * Self-contained demo: no network, no config file, nothing to install.
 *
 *   node examples/demo.mjs
 *
 * Starts a local API, watches it, changes it, and prints the alert that would
 * have gone out — the fastest way to see the baseline/change/quiet-hours
 * behaviour before pointing watchdiff at anything real.
 */

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseConfig } from '../src/config.js';
import { runAll } from '../src/runner.js';
import { StateStore } from '../src/state.js';

const feed = { tenders: [{ id: 'T-1001' }, { id: 'T-1002' }], price: '1.250.000' };

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(feed));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const dir = await mkdtemp(path.join(tmpdir(), 'watchdiff-demo-'));
const store = new StateStore(dir);

const config = parseConfig({
  notifiers: { log: { type: 'console' } },
  watchers: [
    {
      name: 'tenders',
      label: 'New tenders in my category',
      url,
      extract: { type: 'json', path: 'tenders[*].id' },
      mode: 'list',
      alertOn: 'added',
      notify: ['log'],
    },
    {
      name: 'price',
      label: 'Competitor Pro plan price',
      url,
      extract: { type: 'json', path: 'price' },
      mode: 'number',
      thresholdPercent: 5,
      notify: ['log'],
    },
  ],
});

const run = async (title, options = {}) => {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
  const result = await runAll(config, { store, deps: { logger: (text) => console.log(text) }, ...options });
  for (const entry of result.entries) {
    const icon = { baseline: '🆕', changed: '🔔', ok: '·', deferred: '⏸', error: '⚠️' }[entry.status] ?? '?';
    console.log(`${icon} ${entry.label}: ${entry.summary}`);
  }
};

await run('1. First check — stores the baseline and alerts nobody');
await run('2. Nothing changed — silence, not a false alarm');

feed.tenders.push({ id: 'T-1003' }, { id: 'T-1004' });
feed.price = '1.252.000';
await run('3. Two new tenders, price up 0.16% — the tenders are news, the price is under the 5% threshold');

feed.price = '1.500.000';
await run('4. Price up 19.8% — now it clears the threshold');

// Quiet hours from here on: 23:00–07:00 UTC.
config.watchers[0].quietHours = { from: '23:00', to: '07:00', tz: 'UTC' };
const atHour = (hour) => () => {
  const moment = new Date();
  moment.setUTCHours(hour, 0, 0, 0);
  return moment;
};

feed.tenders.push({ id: 'T-1005' });
await run('5. A tender arrives at 04:00 UTC, inside quiet hours — held back, and the baseline does NOT advance', {
  now: atHour(4),
});
await run('6. At 13:00 UTC the held change is delivered: nothing was lost', { now: atHour(13) });

await run('7. The "still watching, nothing changed" digest', { digestTo: ['log'] });

await new Promise((resolve) => server.close(resolve));
await rm(dir, { recursive: true, force: true });
console.log('\nDemo over. Nothing was left on disk.');
console.log('Add "language": "es" to the config and the same run comes out in Spanish.');
