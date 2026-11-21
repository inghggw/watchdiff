import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ExtractError, extract, readJsonPath, stripHtml } from '../src/extract.js';

test('stripHtml drops scripts and styles instead of diffing their contents', () => {
  const html = `
    <html><head><style>.a{color:red}</style><script>var csrf="9f3b2a";</script></head>
    <body><h1>Precio</h1><p>El plan cuesta&nbsp;$ 120.000 COP</p></body></html>`;
  const text = stripHtml(html);
  assert.doesNotMatch(text, /csrf/, 'a rotating CSRF token would make every check look like a change');
  assert.doesNotMatch(text, /color:red/);
  assert.match(text, /Precio/);
  assert.match(text, /El plan cuesta \$ 120\.000 COP/);
});

test('stripHtml decodes entities and collapses whitespace', () => {
  assert.equal(stripHtml('<p>Tom &amp; Jerry   &lt;3</p>'), 'Tom & Jerry <3');
  assert.equal(stripHtml('<div>a</div><div>b</div>'), 'a\nb');
  assert.equal(stripHtml('<p>caf&#233;</p>'), 'café');
});

test('text extraction can be narrowed to the region between two markers', () => {
  const body = '<p>ruido</p>INICIO<p>Estado: CANCELADA</p>FIN<p>más ruido</p>';
  const reading = extract(body, { type: 'text', stripHtml: true, between: ['INICIO', 'FIN'] });
  assert.equal(reading.kind, 'single');
  assert.equal(reading.value, 'Estado: CANCELADA');
  assert.throws(
    () => extract(body, { type: 'text', stripHtml: true, between: ['NOPE', 'FIN'] }),
    /start marker "NOPE" not found/,
  );
});

test('readJsonPath walks objects, indexes and wildcards', () => {
  const data = { page: { items: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] } };
  assert.equal(readJsonPath(data, 'page.items[0].id'), 'a');
  assert.deepEqual(readJsonPath(data, 'page.items[*].id'), ['a', 'b']);
  assert.deepEqual(readJsonPath([{ v: 1 }, { v: 2 }], '[*].v'), [1, 2]);
  assert.equal(readJsonPath({ a: { b: 'c' } }, 'a.b'), 'c');
});

test('a wrong json path says what it found instead of silently returning nothing', () => {
  assert.throws(() => readJsonPath({ a: 1 }, 'a[*]'), /\[\*\] applied to number, not an array/);
  assert.throws(() => readJsonPath({ a: null }, 'a.b'), /cannot read "b" of null/);
  assert.throws(() => extract('{"a":1}', { type: 'json', path: 'missing' }), /is not present in the response/);
  assert.throws(() => extract('<html>', { type: 'json', path: 'a' }), /not valid JSON/);
});

test('a json array becomes a list reading, a scalar becomes a single reading', () => {
  const rows = JSON.stringify([{ id_del_proceso: 'CO1.REQ.1' }, { id_del_proceso: 'CO1.REQ.2' }]);
  const list = extract(rows, { type: 'json', path: '[*].id_del_proceso' });
  assert.equal(list.kind, 'list');
  assert.deepEqual(list.items, ['CO1.REQ.1', 'CO1.REQ.2']);

  const single = extract(JSON.stringify([{ version: 'v24.22.2' }]), { type: 'json', path: '[0].version' });
  assert.equal(single.kind, 'single');
  assert.equal(single.value, 'v24.22.2');
});

test('objects inside a list are serialized so they can still be compared', () => {
  const reading = extract(JSON.stringify({ rows: [{ a: 1 }, { a: 2 }] }), { type: 'json', path: 'rows[*]' });
  assert.deepEqual(reading.items, ['{"a":1}', '{"a":2}']);
});

test('regex extraction returns one value or every match', () => {
  const body = 'Saldo: $1.250.000 al 20/11/2026';
  const one = extract(body, { type: 'regex', pattern: 'Saldo: \\$([\\d.]+)', flags: '', group: 1 });
  assert.equal(one.kind, 'single');
  assert.equal(one.value, '1.250.000');

  const many = extract('id=7 id=8 id=9', { type: 'regex', pattern: 'id=(\\d+)', flags: 'g', group: 1 });
  assert.equal(many.kind, 'list');
  assert.deepEqual(many.items, ['7', '8', '9']);
});

test('a pattern that matches nothing is an extraction failure, not an empty value', () => {
  assert.throws(
    () => extract('nada que ver', { type: 'regex', pattern: 'Saldo: (\\d+)', flags: '', group: 1 }),
    /matched nothing in the response/,
  );
  assert.throws(
    () => extract('id=7', { type: 'regex', pattern: 'id=(\\d+)', flags: 'g', group: 5 }),
    /has no capture group 5/,
  );
  assert.ok(new ExtractError('x') instanceof Error);
});
