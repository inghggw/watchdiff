import { strict as assert } from 'node:assert';
import test from 'node:test';

import { compare, lineDiff, parseNumber, renderAlert, renderDigest } from '../src/diff.js';

const NOW = new Date('2026-11-21T20:00:00Z');

test('value mode reports the old and the new value', () => {
  const result = compare({ kind: 'single', value: 'ACTIVA' }, { kind: 'single', value: 'CANCELADA' }, { mode: 'value' });
  assert.equal(result.changed, true);
  assert.equal(result.significant, true);
  assert.match(result.summary, /"ACTIVA" → "CANCELADA"/);
});

test('an identical value is not a change', () => {
  const result = compare({ kind: 'single', value: 'ACTIVA' }, { kind: 'single', value: 'ACTIVA' }, { mode: 'value' });
  assert.equal(result.changed, false);
  assert.equal(result.significant, false);
});

test('multiline text is summarized as a line count and diffed', () => {
  const before = 'linea uno\nlinea dos\nlinea tres';
  const after = 'linea uno\nlinea tres\nlinea cuatro';
  const result = compare({ kind: 'single', value: before }, { kind: 'single', value: after }, { mode: 'value' });
  assert.match(result.summary, /1 línea\(s\) nueva\(s\), 1 eliminada\(s\)/);
  assert.deepEqual(result.diff, { removed: ['linea dos'], added: ['linea cuatro'] });
});

test('lineDiff ignores reordering and blank lines', () => {
  assert.deepEqual(lineDiff('a\n\nb', 'b\na'), { removed: [], added: [] });
});

test('list mode alerts on new items only, by default', () => {
  const watcher = { mode: 'list', alertOn: 'added' };
  const result = compare({ kind: 'list', items: ['a', 'b'] }, { kind: 'list', items: ['b', 'c'] }, watcher);
  assert.deepEqual(result.added, ['c']);
  assert.deepEqual(result.removed, ['a']);
  assert.equal(result.significant, true);
  assert.match(result.summary, /1 nuevo\(s\), 1 eliminado\(s\)/);
});

test('with alertOn=added, items only disappearing is a change but not an alert', () => {
  const watcher = { mode: 'list', alertOn: 'added' };
  const result = compare({ kind: 'list', items: ['a', 'b'] }, { kind: 'list', items: ['a'] }, watcher);
  assert.equal(result.changed, true);
  assert.equal(result.significant, false, 'a closed tender leaving the list is not news for a supplier');
});

test('alertOn=removed inverts that, and both covers either direction', () => {
  const removedOnly = compare({ kind: 'list', items: ['a', 'b'] }, { kind: 'list', items: ['a'] }, { mode: 'list', alertOn: 'removed' });
  assert.equal(removedOnly.significant, true);
  const both = compare({ kind: 'list', items: ['a'] }, { kind: 'list', items: ['a', 'b'] }, { mode: 'list', alertOn: 'both' });
  assert.equal(both.significant, true);
});

test('parseNumber reads both Colombian and US formats', () => {
  assert.equal(parseNumber('$ 1.250.000,50'), 1250000.5);
  assert.equal(parseNumber('1,250,000.50 USD'), 1250000.5);
  assert.equal(parseNumber('1.250.000'), 1250000, 'a repeated separator is thousands grouping');
  assert.equal(parseNumber('1,250,000'), 1250000);
  assert.equal(parseNumber('42'), 42);
  assert.equal(parseNumber('-3,5'), -3.5);
  assert.equal(parseNumber('3.5'), 3.5, 'a single separator is a decimal point');
  assert.equal(parseNumber('sin datos'), null);
});

test('number mode reports the delta and the percentage', () => {
  const result = compare({ kind: 'single', value: '100' }, { kind: 'single', value: '125' }, { mode: 'number' });
  assert.equal(result.before, 100);
  assert.equal(result.after, 125);
  assert.equal(result.delta, 25);
  assert.equal(result.significant, true);
  assert.match(result.summary, /100 → 125 \(↑ 25, 25\.00%\)/);
});

test('an absolute threshold keeps small movements out of the channel', () => {
  const watcher = { mode: 'number', threshold: 1000 };
  const small = compare({ kind: 'single', value: '120000' }, { kind: 'single', value: '120500' }, watcher);
  assert.equal(small.changed, true);
  assert.equal(small.significant, false, 'the baseline still advances, the human is not pinged');
  const big = compare({ kind: 'single', value: '120000' }, { kind: 'single', value: '135000' }, watcher);
  assert.equal(big.significant, true);
});

test('a percentage threshold is applied on top of the absolute one', () => {
  const watcher = { mode: 'number', thresholdPercent: 10 };
  assert.equal(compare({ kind: 'single', value: '100' }, { kind: 'single', value: '105' }, watcher).significant, false);
  assert.equal(compare({ kind: 'single', value: '100' }, { kind: 'single', value: '115' }, watcher).significant, true);
});

test('a non-numeric reading in number mode is reported, not treated as zero', () => {
  const result = compare({ kind: 'single', value: '100' }, { kind: 'single', value: 'No definido' }, { mode: 'number' });
  assert.equal(result.changed, false);
  assert.match(result.error, /no es un número/);
});

test('a change in the shape of the data is flagged on its own', () => {
  const result = compare({ kind: 'single', value: 'x' }, { kind: 'list', items: ['x'] }, { mode: 'value' });
  assert.equal(result.shapeChange, true);
  assert.match(result.summary, /single → list/);
});

test('the alert carries the label, the url, the items and when it was checked', () => {
  const watcher = {
    label: 'SECOP II — software en Tolima',
    url: 'https://www.datos.gov.co/resource/p6dx-8zbt.json',
    mode: 'list',
    alertOn: 'added',
    maxItemsInAlert: 2,
  };
  const result = compare({ kind: 'list', items: ['a'] }, { kind: 'list', items: ['a', 'b', 'c', 'd'] }, watcher);
  const text = renderAlert(watcher, result, { now: NOW, state: { lastChange: '2026-11-01T10:00:00.000Z' } });
  assert.match(text, /^3 nuevo\(s\)/, 'the body opens with what changed; the label is the title');
  assert.doesNotMatch(text.split('\n')[0], /SECOP II/, 'no duplicated label in every channel');
  assert.match(text, /datos\.gov\.co/);
  assert.match(text, /\+ b/);
  assert.match(text, /… y 1 más/, 'long lists are capped so the message survives Telegram');
  assert.match(text, /Total ahora: 4 \(antes 1\)/);
  assert.match(text, /Cambio anterior: 2026-11-01T10:00:00\.000Z/);
  assert.match(text, /Verificado: 2026-11-21T20:00:00\.000Z/);
});

test('the digest says "nothing changed" out loud — silence looks like a dead monitor', () => {
  const quiet = renderDigest(
    [
      { label: 'a', status: 'ok', significant: false, summary: 'sin cambios' },
      { label: 'b', status: 'ok', significant: false, summary: 'sin cambios' },
    ],
    { now: NOW },
  );
  assert.match(quiet, /✅ Resumen — 2 vigilados, sin novedades/);

  const busy = renderDigest(
    [
      { label: 'a', status: 'changed', significant: true, summary: '2 nuevo(s)' },
      { label: 'b', status: 'error', significant: false, error: 'HTTP 503' },
    ],
    { now: NOW },
  );
  assert.match(busy, /📋 Resumen — 1 de 2 con novedades/);
  assert.match(busy, /⚠️ b: HTTP 503/);
  assert.match(busy, /1 no se pudo\(ieron\) leer/);
});
