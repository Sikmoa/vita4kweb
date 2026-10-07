// Runs the audio wiring that is actually in player.js (createAudioContext,
// ensureAudio, setupAudioStream, syncAudioRoute: extracted from the source text,
// not re-implemented) against a real module Worker that uses the production
// audio_sink.js, and a real AudioWorklet. Checks the routing the page performs:
// worklet attach on 'ready', no main-thread audio traffic, mute -> 'off' (the
// worklet stops receiving chunks), unmute -> 'port' again on the same channel,
// and the fallback to the page when AudioWorklet is unavailable.
//
// Usage: node browser/tests/audio_player_wiring_chromium.mjs [player.js ...]
//   (default: browser/web/player.js and deploy/player.js)
// Environment: PLAYWRIGHT_MODULE_URL, PLAYWRIGHT_CHROMIUM_EXECUTABLE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f))
  : [resolve(root, 'browser/web/player.js'), resolve(root, 'deploy/player.js')];
const playwrightUrl = process.env.PLAYWRIGHT_MODULE_URL
  || pathToFileURL(resolve(process.env.PLAYWRIGHT_DIR || '/home/claude/.npm-global/lib/node_modules/playwright', 'index.mjs')).href;
const { chromium } = await import(playwrightUrl);

function audioSource(text, file) {
  const start = text.indexOf('function createAudioContext(');
  const end = text.indexOf('const logLines = [];', start);
  assert.ok(start > 0 && end > start, `${file}: audio block not found`);
  return text.slice(start, end);
}

const PRODUCER = `
import { createAudioSink } from './audio_sink.js';
const sink = createAudioSink((m) => self.postMessage({ type: 'page-audio', port: m.port }));
const pcm = new Uint8Array(new Int16Array(2048).fill(8000).buffer);
let timer = null;
self.onmessage = ({ data }) => {
  if (data.type === 'audio-config') { sink.configure(data.mode, data.port); self.postMessage({ type: 'configured', mode: sink.mode }); }
  if (data.type === 'run') timer = setInterval(() => sink.push(48000, 2, 1024, pcm, 1), 1024 * 1000 / 48000);
  if (data.type === 'stop') clearInterval(timer);
};
self.postMessage({ type: 'ready' });`;

const page = (source, legacyNext, noWorklet) => `<!doctype html><meta charset=utf-8><script type=module>
${noWorklet ? 'Object.defineProperty(AudioContext.prototype, "audioWorklet", { get() { return undefined; } });' : ''}
const logs = []; const log = (t) => logs.push(String(t)); const notice = log; const startedAt = 0;
const make = new Function('log', 'notice', 'startedAt', 'performance', \`
  let audioCtx = null, audioGain = null, muted = false, worker = null;
  ${legacyNext ? 'let audioNext = 0;' : 'const audioNext = new Map();'}
  const audioSources = new Set();
  let audioChunks = 0, audioBytes = 0, audioLogged = false, audioFirstAt = 0, audioPeak = 0;
  \` + ${JSON.stringify(source)} + \`
  return {
    ensureAudio, syncAudioRoute,
    loading: () => audioStreamLoading,
    set worker(w) { worker = w; }, set ready(r) { workerReady = r; },
    setMuted(m) { muted = m; if (audioGain) audioGain.gain.value = m ? 0 : 1; syncAudioRoute(); },
    get info() { return { rate: audioCtx?.sampleRate, node: !!audioStreamNode, failed: audioStreamFailed, stats: audioStreamStats }; },
    playAudioPCM,
  };\`);
const player = make(log, notice, startedAt, performance);
player.ensureAudio();
await player.loading();
const worker = new Worker('./producer.js', { type: 'module' });
const events = []; let leaks = 0;
await new Promise((r) => { worker.onmessage = ({ data }) => { events.push(data); if (data.type === 'ready') r(); if (data.type === 'page-audio') leaks++; }; });
player.worker = worker; player.ready = true; player.syncAudioRoute();
window.player = player; window.worker = worker; window.events = events; window.logs = logs; window.leaks = () => leaks; window.ok = true;
</script>`;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
  try {
    const [, which, name] = path.split('/');
    if (!name && which === 'a') return send('text/html', globalThis.pageHtml[0]);
    if (!name && which === 'b') return send('text/html', globalThis.pageHtml[1]);
    if (path.endsWith('/producer.js')) return send('text/javascript', PRODUCER);
    if (path.endsWith('/audio_sink.js') || path.endsWith('/audio_stream_worklet.js'))
      return send('text/javascript', await readFile(resolve(root, 'browser/web', path.split('/').pop())));
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
let failed = true;
try {
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const source = audioSource(text, file);
    const legacyNext = /let audioCtx = null, audioGain = null, audioNext = 0/.test(text);
    const label = file.replace(root + '/', '');

    // 1. Worklet available: port route, mute/unmute.
    globalThis.pageHtml = [page(source, legacyNext, false), page(source, legacyNext, true)];
    const tab = await browser.newPage();
    const errors = [];
    tab.on('pageerror', (e) => errors.push(String(e)));
    await tab.goto(base + '/a/');
    await tab.waitForFunction(() => window.ok === true, null, { timeout: 20000 });
    let info = await tab.evaluate(() => window.player.info);
    assert.equal(info.rate, 48000, label + ': 48 kHz context');
    assert.equal(info.node, true, label + ': stream node created');
    const modes = await tab.evaluate(() => window.events.filter((e) => e.type === 'configured').map((e) => e.mode));
    assert.deepEqual(modes, ['port'], label + ': page routed the worker to the worklet port: ' + modes);

    await tab.evaluate(() => window.worker.postMessage({ type: 'run' }));
    await tab.waitForFunction(() => window.player.info.stats?.chunks > 20, null, { timeout: 15000 });
    const before = await tab.evaluate(() => window.player.info.stats.chunks);
    assert.equal(await tab.evaluate(() => window.leaks()), 0, label + ': no audio on the main thread');

    await tab.evaluate(() => window.player.setMuted(true));
    await tab.waitForTimeout(2600); // two stats periods
    const muted = (await tab.evaluate(() => window.events.filter((e) => e.type === 'configured').map((e) => e.mode)));
    assert.deepEqual(muted, ['port', 'off'], label + ': mute routes to off: ' + muted);
    const mid = await tab.evaluate(() => window.player.info.stats.chunks);
    await tab.waitForTimeout(2300);
    const after = await tab.evaluate(() => window.player.info.stats.chunks);
    assert.equal(after, mid, label + ': muted: the worklet receives nothing');
    assert.ok(mid - before < 150, label + ': chunks stopped flowing around mute (' + before + ' -> ' + mid + ')');

    await tab.evaluate(() => window.player.setMuted(false));
    await tab.waitForTimeout(2600);
    const resumed = await tab.evaluate(() => window.player.info.stats.chunks);
    assert.ok(resumed > after + 20, label + ': unmute resumes on the same channel (' + after + ' -> ' + resumed + ')');
    const finalModes = await tab.evaluate(() => window.events.filter((e) => e.type === 'configured').map((e) => e.mode));
    assert.deepEqual(finalModes, ['port', 'off', 'port'], label + ': ' + finalModes);
    assert.equal(await tab.evaluate(() => window.leaks()), 0);
    assert.deepEqual(errors, [], label + ': page errors ' + errors.join('; '));
    await tab.close();
    console.log(`ok - ${label}: ready -> port route, no main-thread audio, mute -> off, unmute -> port`);

    // 2. No AudioWorklet (insecure context stand-in): falls back to the page path.
    const tab2 = await browser.newPage();
    await tab2.goto(base + '/b/');
    await tab2.waitForFunction(() => window.ok === true, null, { timeout: 20000 });
    const modes2 = await tab2.evaluate(() => window.events.filter((e) => e.type === 'configured').map((e) => e.mode));
    info = await tab2.evaluate(() => window.player.info);
    assert.deepEqual(modes2, ['main'], label + ': fallback route: ' + modes2);
    assert.equal(info.failed, true);
    await tab2.evaluate(() => window.worker.postMessage({ type: 'run' }));
    await tab2.waitForFunction(() => window.leaks() > 5, null, { timeout: 10000 });
    await tab2.close();
    console.log(`ok - ${label}: without AudioWorklet the worker falls back to the page path`);
  }
  failed = false;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
