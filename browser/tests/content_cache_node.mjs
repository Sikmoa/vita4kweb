// Node test for content_cache.js directory-handle caching and pipelined
// unpacking, against an in-memory OPFS mock (no browser needed).
//   node browser/tests/content_cache_node.mjs
import assert from 'node:assert/strict';

let lookups = 0;
class NotFound extends Error { constructor(m) { super(m); this.name = 'NotFoundError'; } }
class MockFile { constructor(bytes) { this.bytes = bytes; this.size = bytes.length; }
  async arrayBuffer() { return Uint8Array.from(this.bytes).buffer; } async text() { return new TextDecoder().decode(this.bytes); }
  slice(a, b) { return new Blob([Uint8Array.from(this.bytes.subarray(a, b))]); } stream() { return new Blob([this.bytes]).stream(); } }
class MockFileHandle { constructor(parent, name) { this.kind = 'file'; this.parent = parent; this.name = name; }
  async getFile() { if (this.parent.dead || this.parent.children.get(this.name) !== this) throw new NotFound('gone'); return new MockFile(this.parent.data.get(this.name) ?? new Uint8Array()); }
  async createWritable() { if (this.parent.dead) throw new NotFound('dir removed'); const self = this; const chunks = [];
    return { async write(b) { chunks.push(typeof b === 'string' ? new TextEncoder().encode(b) : b); },
      async close() { self.parent.data.set(self.name, Uint8Array.from(Buffer.concat(chunks))); } }; } }
class MockDir { constructor(name) { this.kind = 'directory'; this.name = name; this.children = new Map(); this.data = new Map(); this.dead = false; }
  async getDirectoryHandle(name, { create } = {}) { lookups++; if (this.dead) throw new NotFound('dir removed');
    let c = this.children.get(name); if (!c) { if (!create) throw new NotFound(name); c = new MockDir(name); this.children.set(name, c); } return c; }
  async getFileHandle(name, { create } = {}) { if (this.dead) throw new NotFound('dir removed');
    let c = this.children.get(name); if (!c) { if (!create) throw new NotFound(name); c = new MockFileHandle(this, name); this.children.set(name, c); } return c; }
  async removeEntry(name) { const c = this.children.get(name); if (!c) throw new NotFound(name); if (c.kind === 'directory') c.markDead(); this.children.delete(name); this.data.delete(name); }
  markDead() { this.dead = true; for (const c of this.children.values()) if (c.kind === 'directory') c.markDead(); }
  async *entries() { for (const [k, v] of this.children) yield [k, v]; } }
const root = new MockDir('');
Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => root } }, configurable: true });

const cache = await import('../web/content_cache.js');
const { createZip } = await import('../web/zip.js');
const enc = (s) => new TextEncoder().encode(s);
const key = cache.cacheKeyFor('TITLE', 'TITLE');

// 1. round trip + far fewer directory lookups than re-walking per file
const N = 50;
for (let i = 0; i < N; i++) await cache.cacheWriteFile(key, `ux0/app/TITLE/data/f${i}.bin`, enc('x' + i));
const walkedPerFile = lookups / N;
assert.ok(lookups < 12, `expected cached walks, got ${lookups} lookups for ${N} files`);
for (let i = 0; i < N; i += 7) assert.equal(new TextDecoder().decode(await cache.cacheReadFile(key, `ux0/app/TITLE/data/f${i}.bin`)), 'x' + i);
console.log(`ok: ${N} writes took ${lookups} directory lookups (was ~${N * 6} uncached)`);

// 2. directory removed behind our back (another realm's cacheClear) is recovered
const before = lookups;
const contentRoot = await root.getDirectoryHandle('vita3k-content');
await contentRoot.removeEntry('TITLE_TITLE'.replace('_', '/').split('/')[0]).catch(() => {});
await cache.cacheWriteFile(key, 'ux0/app/TITLE/data/after.bin', enc('recovered'));
assert.equal(new TextDecoder().decode(await cache.cacheReadFile(key, 'ux0/app/TITLE/data/after.bin')), 'recovered');
console.log('ok: stale cached handles recovered after external removal');

// 3. cacheClear then rewrite
await cache.cacheClear(key);
assert.equal(await cache.cacheReadFile(key, 'ux0/app/TITLE/data/f1.bin'), null);
await cache.cacheWriteFile(key, 'ux0/app/TITLE/data/f1.bin', enc('again'));
assert.equal(new TextDecoder().decode(await cache.cacheReadFile(key, 'ux0/app/TITLE/data/f1.bin')), 'again');
console.log('ok: clear + rewrite');

// 4. manifest round trip
await cache.cacheWriteManifest(key, [{ path: 'a', size: 1 }]);
assert.deepEqual((await cache.cacheReadManifest(key)).files, [{ path: 'a', size: 1 }]);

// 5. pipelined unpack of a real zip, in order, with progress
const files = [];
for (let i = 0; i < 20; i++) files.push({ path: `ux0/app/GAME00001/f${i}.bin`, bytes: enc('payload-' + i + 'z'.repeat(i * 100)) });
const zip = createZip(files);
const key2 = cache.cacheKeyFor('GAME00001', 'GAME00001');
const progress = [];
const result = await cache.unpackPackageToCache(zip, key2, (done, total, path) => progress.push([done, total, path]));
assert.equal(result.files, 20);
assert.deepEqual(progress.map((p) => p[0]), Array.from({ length: 20 }, (_, i) => i + 1));
for (let i = 0; i < 20; i++) assert.deepEqual(await cache.cacheReadFile(key2, `ux0/app/GAME00001/f${i}.bin`), files[i].bytes);
console.log('ok: pipelined unpack (20 files, ordered, byte-exact)');

// 6. corrupt entry mid-archive: error surfaces, no unhandled rejection, earlier files kept
const bad = new Uint8Array(await createZip(files).arrayBuffer());
const text = new TextDecoder('latin1').decode(bad);
const at = text.indexOf('payload-5z');
bad[at] ^= 0xff; // flip a payload byte of file 5 -> CRC mismatch
let unhandled = 0; process.on('unhandledRejection', () => { unhandled++; });
const key3 = cache.cacheKeyFor('GAME00001', 'BAD');
await assert.rejects(cache.unpackPackageToCache(new Blob([bad]), key3), /CRC mismatch|corrupt/);
await new Promise((r) => setTimeout(r, 20));
assert.equal(unhandled, 0, 'no unhandled rejections from the prefetched extraction');
console.log('ok: corrupt entry rejects cleanly');
console.log('PASS: content_cache directory cache + pipelined unpack');
