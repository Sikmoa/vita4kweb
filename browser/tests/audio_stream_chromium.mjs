// Real-time check of the single-threaded audio path in Chromium: a module
// Worker running the production audio_sink.js feeds the production
// audio_stream_worklet.js over a MessageChannel, paced like the emulator's
// sceAudioOutOutput (wall-clock schedule, catch-up after a stall). A recorder
// worklet captures what the stream node outputs.
//
// Asserts: no main-thread audio traffic in port mode; a short stall is absorbed
// with no underrun; a long stall is one counted underrun that fades out and in;
// and the captured signal never steps by more than a 440 Hz sine allows, i.e.
// no clicks at chunk boundaries, stalls, or recovery.
// Also times the legacy main-thread handler (taken verbatim from the original
// player.js when LEGACY_PLAYER is given) against the new path.
//
// Usage: node browser/tests/audio_stream_chromium.mjs
// Environment: PLAYWRIGHT_MODULE_URL (default: global playwright),
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE, LEGACY_PLAYER (path to the old player.js).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
const playwrightUrl = process.env.PLAYWRIGHT_MODULE_URL
  || pathToFileURL(resolve(process.env.PLAYWRIGHT_DIR || '/home/claude/.npm-global/lib/node_modules/playwright', 'index.mjs')).href;
const { chromium } = await import(playwrightUrl);
const legacyPlayer = process.env.LEGACY_PLAYER ? await readFile(process.env.LEGACY_PLAYER, 'utf8') : null;

const RECORDER = `
class Recorder extends AudioWorkletProcessor {
  constructor() { super(); this.blocks = []; this.frames = 0;
    this.port.onmessage = ({ data }) => { if (data === 'dump') { this.port.postMessage({ blocks: this.blocks }); this.blocks = []; } }; }
  process(inputs, outputs) {
    const input = inputs[0][0];
    if (input) { this.blocks.push(input.slice()); }
    if (outputs[0][0] && input) outputs[0][0].set(input);
    return true;
  }
}
registerProcessor('recorder', Recorder);`;

const PRODUCER = `
import { createAudioSink } from './audio_sink.js';
const sink = createAudioSink((m) => self.postMessage({ type: 'page-audio-leak' }));
const CHUNK = 1024, FREQ = 48000, MS = CHUNK * 1000 / FREQ;
let phase = 0;
function chunk() {
  const pcm = new Int16Array(CHUNK * 2);
  for (let i = 0; i < CHUNK; ++i) { const v = Math.round(16384 * Math.sin(phase)); phase += 2 * Math.PI * 440 / FREQ; pcm[2 * i] = v; pcm[2 * i + 1] = v; }
  return new Uint8Array(pcm.buffer);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(stalls) {
  const start = performance.now(); let next = start, sent = 0, worst = 0, total = 0;
  const stallAt = new Map(stalls);
  while (performance.now() - start < 5000) {
    const wait = next - performance.now(); if (wait > 0) await sleep(wait);   // pace to the schedule
    if (stallAt.has(sent)) { const until = performance.now() + stallAt.get(sent); while (performance.now() < until); stallAt.delete(sent); } // hitch
    const t0 = performance.now(); sink.push(FREQ, 2, CHUNK, chunk(), 1); const dt = performance.now() - t0; worst = Math.max(worst, dt); total += dt;
    sent += 1; next += MS;                                                      // keeps its schedule: catches up after a stall
  }
  self.postMessage({ type: 'done', sent, avgPushMs: total / sent, worstPushMs: worst });
}
self.onmessage = ({ data }) => {
  if (data.type === 'audio-config') sink.configure(data.mode, data.port);
  if (data.type === 'run') run(data.stalls);
};
self.postMessage({ type: 'ready' });`;

const PAGE = `<!doctype html><meta charset=utf-8><title>audio stream test</title><script type=module>
const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
await ctx.resume();
await ctx.audioWorklet.addModule('./audio_stream_worklet.js');
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([${JSON.stringify(RECORDER)}], { type: 'text/javascript' })));
const node = new AudioWorkletNode(ctx, 'vita3k-audio-stream', { numberOfInputs: 0, outputChannelCount: [2] });
const rec = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
node.connect(rec); rec.connect(ctx.destination);
let stats = null; node.port.onmessage = ({ data }) => { if (data.type === 'stats') stats = data; };
const worker = new Worker('./producer.js', { type: 'module' });
let leaks = 0, done = null;
const ready = new Promise((r) => { worker.onmessage = ({ data }) => { if (data.type === 'ready') r(); if (data.type === 'page-audio-leak') leaks++; if (data.type === 'done') done = data; }; });
await ready;
const channel = new MessageChannel();
node.port.postMessage({ type: 'attach', port: channel.port1 }, [channel.port1]);
worker.postMessage({ type: 'audio-config', mode: 'port', port: channel.port2 }, [channel.port2]);
window.start = (stalls) => worker.postMessage({ type: 'run', stalls });
window.finished = () => done;
window.result = async () => {
  const blocks = await new Promise((r) => { rec.port.onmessage = ({ data }) => r(data.blocks); rec.port.postMessage('dump'); });
  const all = new Float32Array(blocks.length * 128); blocks.forEach((b, i) => all.set(b, i * 128));
  return { samples: Array.from(all), stats, leaks, sampleRate: ctx.sampleRate };
};
window.ready = true;
</script>`;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
  try {
    if (path === '/') return send('text/html', PAGE);
    if (path === '/producer.js') return send('text/javascript', PRODUCER);
    if (path === '/audio_sink.js' || path === '/audio_stream_worklet.js')
      return send('text/javascript', await readFile(resolve(web, path.slice(1))));
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
let failed = true;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });

  // 40 ms hitch at chunk 120 (~2.6 s in) should be absorbed by the 60 ms start
  // buffer; 160 ms at chunk 170 (~3.6 s in) cannot be.
  await page.evaluate(() => window.start([[120, 40], [170, 160]]));
  await page.waitForFunction(() => window.finished() !== null, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  const done = await page.evaluate(() => window.finished());
  const { samples, stats, leaks, sampleRate } = await page.evaluate(() => window.result());
  assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
  assert.equal(sampleRate, 48000);
  assert.equal(leaks, 0, 'nothing went to the main thread in port mode');

  // Find the audible region and check continuity within it.
  const x = Float32Array.from(samples);
  let first = x.findIndex((v) => Math.abs(v) > 1e-4);
  assert.ok(first >= 0, 'audio was produced');
  let steps = 0, maxStep = 0, maxAt = 0, silent = 0;
  for (let i = first + 100; i < x.length; ++i) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > maxStep) { maxStep = d; maxAt = i; }
    steps += 1;
  }
  for (const v of x) if (v === 0) silent += 1;
  const sineStep = 2 * Math.PI * 440 / 48000 * 0.5; // largest step of the 0.5-amplitude sine
  console.log(JSON.stringify({ chunks: done.sent, avgPushMicros: Math.round(done.avgPushMs * 1000), worstPushMs: +done.worstPushMs.toFixed(2),
    stats, maxStep: +maxStep.toFixed(4), sineStep: +sineStep.toFixed(4), maxAtMs: Math.round(maxAt / 48), recordedMs: Math.round(x.length / 48) }));
  assert.ok(done.sent >= 200 && stats.chunks >= 150, 'stream received the chunks over the port');
  assert.equal(stats.underruns, 1, 'only the 160 ms stall underruns (40 ms is absorbed): ' + JSON.stringify(stats));
  assert.ok(stats.targetMs > 60, 'target raised after the audible gap');
  assert.ok(maxStep <= sineStep * 1.15, `no clicks: max step ${maxStep.toFixed(4)} vs sine limit ${sineStep.toFixed(4)} at ${Math.round(maxAt / 48)} ms`);
  console.log('ok - port mode: seamless, short stall absorbed, long stall = one smooth underrun');

  // Legacy main-thread handler cost for the same audio, if the old player is supplied.
  if (legacyPlayer) {
    const start = legacyPlayer.indexOf('function playAudioPCM(');
    const end = legacyPlayer.indexOf('// Threaded runtime:', start) > 0 ? legacyPlayer.indexOf('// Threaded runtime:', start) : legacyPlayer.indexOf('const logLines', start);
    const source = legacyPlayer.slice(start, end);
    const ms = await page.evaluate(async (code) => {
      const ctx = new AudioContext({ sampleRate: 48000 }); const gain = ctx.createGain(); gain.connect(ctx.destination);
      const audioCtx = ctx, audioGain = gain, audioSources = new Set(), audioNext = new Map();
      let audioChunks = 0, audioBytes = 0, audioLogged = false, audioFirstAt = 0, audioPeak = 0; const startedAt = 0; const log = () => {};
      const fn = new Function('audioCtx', 'audioGain', 'audioSources', 'audioNext', 'log', 'startedAt', 'performance',
        `let audioChunks = 0, audioBytes = 0, audioLogged = false, audioFirstAt = 0, audioPeak = 0; ${code}; return playAudioPCM;`)(
        audioCtx, audioGain, audioSources, audioNext, log, startedAt, performance);
      const chunk = new Int16Array(2048).map((_, i) => Math.sin(i) * 10000).buffer;
      const frames = 1024, n = 470; // ~10 s of audio in 1024-frame chunks
      const t0 = performance.now();
      for (let i = 0; i < n; ++i) fn(48000, 2, frames, chunk.slice(0), 1);
      return (performance.now() - t0) / (n * frames / 48000);
    }, source);
    console.log(`legacy main-thread handler: ${ms.toFixed(1)} ms of JS per second of audio; new path: 0 ms (no main-thread messages)`);
  }
  failed = false;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
