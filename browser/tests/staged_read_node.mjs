// Runs worker.js's real readStagedFile against mock streaming Responses.
//   node browser/tests/staged_read_node.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8');
const start = src.indexOf('async function readStagedFile(');
const end = src.indexOf('\n}\n', start) + 3;
const readStagedFile = new Function(`${src.slice(start, end)}; return readStagedFile;`)();

const data = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31 + 7) & 0xff);
const response = (chunks, headers = {}) => ({
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  body: { getReader() { let i = 0; return { async read() { return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }; } }; } },
});
const split = (n) => { const out = []; for (let i = 0; i < data.length; i += n) out.push(data.slice(i, i + n)); return out; };

for (const [name, resp, hint] of [
  ['exact hint', response(split(7000)), data.length],
  ['content-length only', response(split(4096), { 'content-length': String(data.length) }), 0],
  ['no hint', response(split(65536)), 0],
  ['hint too small', response(split(9999)), 1234],
  ['hint too large', response(split(9999)), data.length + 5000],
  ['encoded content-length ignored', response(split(9999), { 'content-length': '10', 'content-encoding': 'gzip' }), 0],
  ['empty chunks', response([new Uint8Array(0), ...split(50000), new Uint8Array(0)]), data.length],
]) {
  let last = 0;
  const out = await readStagedFile(resp, (r) => { assert.ok(r >= last); last = r; }, hint);
  assert.equal(out.byteLength, data.length, name);
  assert.equal(out.buffer.byteLength, data.length, `${name}: buffer must be exact size (MEMFS canOwn)`);
  assert.deepEqual(out, data, name);
  assert.equal(last, data.length, `${name}: progress reaches total`);
  console.log('ok:', name);
}
// no body reader: arrayBuffer fallback
const fallback = await readStagedFile({ arrayBuffer: async () => data.buffer.slice(0) , headers: { get: () => null } }, () => {}, 0);
assert.deepEqual(fallback, data);
console.log('PASS: readStagedFile');
