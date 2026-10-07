// Deterministic tests for browser/web/audio_stream_worklet.js and
// browser/web/audio_sink.js, run in Node with a mocked AudioWorklet scope.
// Usage: node browser/tests/audio_stream_node.mjs
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

// ---- Mocked AudioWorkletGlobalScope ------------------------------------
let Processor = null;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); } }; }
};
globalThis.registerProcessor = (name, cls) => { assert.equal(name, 'vita3k-audio-stream'); Processor = cls; };
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
await import(pathToFileURL(resolve(web, 'audio_stream_worklet.js')).href);
assert.ok(Processor, 'processor registered');

const QUANTUM = 128;
// A fake MessagePort pair end the processor can attach to.
const fakePort = () => ({ onmessage: null, closed: false, close() { this.closed = true; } });

function make(options = {}) {
  const processor = new Processor({ processorOptions: options });
  const input = fakePort();
  processor.port.onmessage({ data: { type: 'attach', port: input } });
  return {
    processor, input,
    send(port, freq, channels, samples) { // samples: Int16Array interleaved
      const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
      input.onmessage({ data: { port, freq, channels, frames: samples.length / channels, pcm } });
    },
    // Render `quanta` blocks, advancing the clock; returns concatenated L and R.
    run(quanta) {
      const L = new Float32Array(quanta * QUANTUM), R = new Float32Array(quanta * QUANTUM);
      for (let q = 0; q < quanta; ++q) {
        const l = new Float32Array(QUANTUM), r = new Float32Array(QUANTUM);
        assert.equal(processor.process([], [[l, r]]), true);
        L.set(l, q * QUANTUM); R.set(r, q * QUANTUM);
        currentTime += QUANTUM / sampleRate;
      }
      return { L, R };
    },
  };
}
const resetClock = () => { currentTime = 0; };
const stereoRamp = (frames, from = 0, slope = 2) => {
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; ++i) { out[2 * i] = (from + i) * slope; out[2 * i + 1] = -(from + i) * slope; }
  return out;
};
const maxStep = (a, from = 0, to = a.length) => {
  let m = 0;
  for (let i = from + 1; i < to; ++i) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
};
let passed = 0;
const test = (name, body) => { resetClock(); body(); passed += 1; console.log('ok - ' + name); };

// ---- Worklet ------------------------------------------------------------
test('same rate: chunk boundaries are seamless and samples are exact', () => {
  const t = make({ targetMs: 20 });
  // 1024-frame chunks of a ramp; enough queued to prime (20 ms = 960 frames).
  for (let c = 0; c < 6; ++c) t.send(1, 48000, 2, stereoRamp(1024, c * 1024));
  const { L, R } = t.run(40); // 5120 frames
  // After the 64-frame fade-in, output i is exactly source i.
  for (let i = 64; i < 5000; ++i) {
    assert.equal(L[i], (i * 2) / 32768, 'left ' + i);
    assert.equal(R[i], -(i * 2) / 32768, 'right ' + i);
  }
  assert.equal(t.processor.counters.underruns, 0);
});

test('44.1 kHz context, 48 kHz port: no steps at chunk boundaries', () => {
  globalThis.sampleRate = 44100;
  const t = make({ targetMs: 20 });
  for (let c = 0; c < 8; ++c) t.send(1, 48000, 2, stereoRamp(1024, c * 1024));
  const { L } = t.run(60);
  const slope = (48000 / 44100) * 2 / 32768; // per output frame
  assert.ok(maxStep(L, 80, 6000) < slope * 1.01, 'max step ' + maxStep(L, 80, 6000) + ' vs ' + slope);
  assert.ok(maxStep(L, 80, 6000) > slope * 0.99);
  globalThis.sampleRate = 48000;
});

test('mono port plays on both channels', () => {
  const t = make({ targetMs: 10 });
  const mono = new Int16Array(2048).map((_, i) => i * 4);
  t.send(1, 48000, 1, mono);
  const { L, R } = t.run(20);
  for (let i = 100; i < 1500; ++i) assert.equal(L[i], R[i]);
  assert.ok(L[1000] > 0);
});

test('two ports are mixed', () => {
  const t = make({ targetMs: 10 });
  const constant = (v) => new Int16Array(4096 * 2).fill(v);
  t.send(1, 48000, 2, constant(8000));
  t.send(2, 48000, 2, constant(4000));
  const { L } = t.run(20);
  assert.equal(L[1000], 12000 / 32768);
});

test('underrun: fade-out is smooth across blocks, counted, and refills before resuming', () => {
  const t = make({ targetMs: 20, maxTargetMs: 200 });
  const dc = new Int16Array(1200 * 2).fill(16000); // primes (960) then runs dry
  t.send(1, 48000, 2, dc);
  const first = t.run(12); // 1536 frames: plays 1199, then dry
  assert.equal(t.processor.counters.underruns, 0, 'not decided until data returns');
  // The guest resumes within half a second, below the raised 40 ms target:
  // that gap was heard, so the target goes up, and the fade-out must continue
  // through block edges with no hard step while the stream refills.
  t.send(1, 48000, 2, new Int16Array(1000 * 2).fill(16000));
  assert.equal(t.processor.counters.underruns, 1);
  assert.equal(t.processor.targetMs, 40, 'target raised after an underrun');
  const waiting = t.run(8);
  const whole = new Float32Array(first.L.length + waiting.L.length);
  whole.set(first.L); whole.set(waiting.L, first.L.length);
  const level = 16000 / 32768;
  const firstDecayStep = level * (1 - 0.97);
  assert.ok(maxStep(whole, 1100, whole.length) <= firstDecayStep * 1.001,
    'max step ' + maxStep(whole, 1100, whole.length) + ' vs ' + firstDecayStep);
  assert.ok(Math.abs(whole[whole.length - 1]) < 1e-4, 'tail reached silence');
  assert.ok(waiting.L.slice(600).every((v) => v === 0), 'then waits silently for the target');
  // Above the target playback resumes with a fade-in.
  t.send(1, 48000, 2, new Int16Array(1500 * 2).fill(16000));
  const resumed = t.run(4);
  assert.ok(resumed.L[0] === 0 && resumed.L[20] < resumed.L[60] && resumed.L[200] > 0.45, 'fade-in then full level');
});

test('underrun exactly on a block boundary still fades from the last sample', () => {
  // Interpolation reads one frame ahead, so 1281 queued frames play exactly 10
  // blocks and the stream runs dry on the first frame of block 11. (After any
  // earlier underrun this alignment is the normal case: chunks are multiples of
  // 128 frames.) The fade-out must start from block 10's last sample, not zero.
  const t = make({ targetMs: 20 });
  t.send(1, 48000, 2, new Int16Array(1281 * 2).fill(16000));
  const out = t.run(10 + 6);
  const level = 16000 / 32768;
  assert.ok(Math.abs(out.L[1279] - level) < 1e-6, 'full level up to the last played frame');
  const firstDecayStep = level * (1 - 0.97);
  assert.ok(maxStep(out.L, 1000, out.L.length) <= firstDecayStep * 1.001,
    'max step ' + maxStep(out.L, 1000, out.L.length) + ' vs ' + firstDecayStep);
  assert.ok(Math.abs(out.L[out.L.length - 1]) < 0.01, 'faded out');
});

test('a paused guest is not an underrun and its stream is reaped', () => {
  const t = make({ targetMs: 10 });
  t.send(1, 48000, 2, new Int16Array(800 * 2).fill(1000));
  t.run(10); // drains
  currentTime += 1.0; // guest silent for a second...
  t.run(2);
  t.send(1, 48000, 2, new Int16Array(800 * 2).fill(1000)); // ...then resumes
  assert.equal(t.processor.counters.underruns, 0, 'a pause is not a heard glitch');
  assert.equal(t.processor.targetMs, 10, 'latency target untouched');
  t.run(10);
  currentTime += 2.5; // and goes quiet for good
  t.run(1);
  assert.equal(t.processor.streams.size, 0, 'idle stream removed');
});

test('a burst drops the oldest audio instead of adding latency', () => {
  const t = make({ targetMs: 20, maxMs: 100 });
  for (let c = 0; c < 20; ++c) t.send(1, 48000, 2, stereoRamp(1024, c * 1024)); // ~427 ms at once
  assert.ok(t.processor.counters.overruns > 0);
  const stream = t.processor.streams.get(1);
  assert.ok((stream.write - stream.read) / 48 <= 100 + 22, 'queued stays near the cap');
  t.run(4);
  assert.equal(t.processor.counters.underruns, 0);
});

test('an oversized chunk keeps only its newest frames', () => {
  const t = make({ targetMs: 20 });
  t.send(1, 48000, 2, stereoRamp(40000));
  const stream = t.processor.streams.get(1);
  assert.ok(stream.write <= 16384);
  t.run(10); // does not throw or read garbage
});

test('malformed chunks are ignored', () => {
  const t = make();
  t.input.onmessage({ data: { port: 1, freq: 48000, channels: 3, frames: 10, pcm: new ArrayBuffer(60) } });
  t.input.onmessage({ data: { port: 1, freq: 48000, channels: 2, frames: 1000, pcm: new ArrayBuffer(16) } });
  t.input.onmessage({ data: null });
  assert.equal(t.processor.streams.size, 0);
});

test('flush, re-attach and stop', () => {
  const t = make({ targetMs: 10 });
  t.send(1, 48000, 2, stereoRamp(2048));
  t.processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(t.processor.streams.size, 0);
  const replacement = fakePort();
  t.processor.port.onmessage({ data: { type: 'attach', port: replacement } });
  assert.ok(t.input.closed && t.input.onmessage === null, 'old channel closed');
  assert.equal(typeof replacement.onmessage, 'function');
  t.processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(t.processor.process([], [[new Float32Array(128), new Float32Array(128)]]), false);
});

test('stats are reported every ~2 s', () => {
  const t = make({ targetMs: 10 });
  t.send(1, 48000, 2, stereoRamp(4096));
  t.run(1000); // 2.67 s
  const stats = t.processor.port.posted.filter((m) => m.type === 'stats');
  assert.ok(stats.length >= 1 && stats[0].chunks === 1 && 'queuedMs' in stats[0] && 'targetMs' in stats[0]);
});

test('latency target relaxes after a stable stretch', () => {
  const t = make({ targetMs: 20, maxTargetMs: 200 });
  t.processor.targetMs = 80;
  t.processor.stableSince = currentTime;
  t.run(4000); // ~10.7 s, no streams
  assert.ok(t.processor.targetMs < 80 && t.processor.targetMs >= 20);
});

// ---- Worker-side sink ---------------------------------------------------
const { createAudioSink } = await import(pathToFileURL(resolve(web, 'audio_sink.js')).href);

test('sink: default routes to the page like the legacy path', () => {
  const posted = [];
  const sink = createAudioSink((m, transfer) => posted.push({ m, transfer }));
  const view = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  sink.push(48000, 2, 2, view, 5);
  assert.equal(posted.length, 1);
  assert.deepEqual({ ...posted[0].m, data: undefined }, { type: 'vita-audio', freq: 48000, channels: 2, frames: 2, data: undefined, port: 5 });
  assert.notEqual(posted[0].m.data, view.buffer, 'copied, not the wasm memory');
  assert.deepEqual([...new Uint8Array(posted[0].m.data)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(posted[0].transfer[0], posted[0].m.data);
});

test('sink: port mode sends one transferred message and nothing to the page', () => {
  const posted = [], sent = [];
  const sink = createAudioSink((m) => posted.push(m));
  const port = { postMessage: (m, t) => sent.push({ m, t }), close() {} };
  sink.configure('port', port);
  sink.push(48000, 2, 1, new Uint8Array([9, 8, 7, 6]), 3);
  assert.equal(posted.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].m.port, 3);
  assert.equal(sent[0].t[0], sent[0].m.pcm);
});

test('sink: off drops before copying; port without a port falls back to the page', () => {
  const posted = [];
  const sink = createAudioSink((m) => posted.push(m));
  let touched = false;
  const spy = new Proxy(new Uint8Array(4), { get(target, key) { touched = true; return Reflect.get(target, key); } });
  sink.configure('off');
  sink.push(48000, 2, 1, spy, 1);
  assert.equal(touched, false, 'no copy while off');
  assert.equal(posted.length, 0);
  sink.configure('port', null);
  assert.equal(sink.mode, 'main');
});

test('sink: muting keeps the port, so unmuting needs no new channel', () => {
  const sent = [];
  const sink = createAudioSink(() => {});
  sink.configure('port', { postMessage: (m) => sent.push(m), close() { throw new Error('must stay open'); } });
  sink.configure('off');
  sink.push(48000, 2, 1, new Uint8Array(4), 1);
  assert.equal(sent.length, 0);
  sink.configure('port');
  sink.push(48000, 2, 1, new Uint8Array(4), 1);
  assert.equal(sent.length, 1);
});

test('sink: reconfiguring closes the previous port', () => {
  const sink = createAudioSink(() => {});
  let closed = 0;
  sink.configure('port', { postMessage() {}, close() { closed += 1; } });
  sink.configure('port', { postMessage() {}, close() {} });
  assert.equal(closed, 1);
});

console.log(`\n${passed} tests passed`);
