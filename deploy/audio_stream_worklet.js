// Streaming PCM sink for the single-threaded runtime (the build that has no
// SharedArrayBuffer; the threaded build uses audio_ring_worklet.js instead).
//
// The emulation Worker sends one int16 chunk per sceAudioOutOutput call
// straight to this processor over a MessagePort (audio_sink.js), so the page's
// main thread never touches the audio data. Each guest port is its own stream
// with a small float ring. Chunks are converted on arrival and played back with
// linear interpolation across chunk boundaries, which also handles a context
// rate that differs from the port rate without the per-buffer seams that
// chained AudioBufferSourceNodes produce.
//
// Playback starts once `targetMs` of audio is queued and restarts the same way
// after an underrun (with a short fade, so there is no click). Each underrun
// that the guest recovers from within half a second raises the target a
// little; a long stable stretch lowers it again. A burst
// that leaves more than `maxMs` queued (the guest runs unpaced while loading)
// drops the oldest audio instead of adding latency.
const RING = 1 << 15; // frames per stream (~0.68 s at 48 kHz)
const MASK = RING - 1;
const MAX_CHUNK = RING >>> 1; // frames; a larger chunk keeps only its newest part
const FADE_IN = 64; // frames
const TAIL_DECAY = 0.97; // per frame, applied to the last sample on underrun
const TAIL_FLOOR = 1e-5; // below this the tail is treated as silence
const SCALE = 1 / 32768;

class Stream {
  constructor(freq, channels) {
    this.freq = freq;
    this.channels = channels;
    this.left = new Float32Array(RING);
    this.right = channels > 1 ? new Float32Array(RING) : this.left;
    this.write = 0; // frames received (absolute, monotonic)
    this.read = 0; // fractional read position (absolute frames)
    this.primed = false;
    this.fadeIn = 0;
    this.lastL = 0; // last sample played, carried across blocks so a fade-out can start from it
    this.lastR = 0;
    this.tailL = 0; // decaying remainder of the last sample after an underrun
    this.tailR = 0;
    this.lastSeen = currentTime;
    this.dryAt = -1; // when playback ran dry (-1: not dry)
  }
}

class Vita3kAudioStream extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions ?? {};
    this.baseMs = o.targetMs ?? 60;
    this.targetMs = this.baseMs;
    this.maxTargetMs = o.maxTargetMs ?? 200;
    this.maxMs = o.maxMs ?? 300;
    this.streams = new Map();
    this.input = null;
    this.stopped = false;
    this.counters = { chunks: 0, frames: 0, underruns: 0, overruns: 0, dropped: 0 };
    this.stableSince = currentTime;
    this.reportAt = currentTime + 2;
    this.port.onmessage = ({ data }) => this.control(data);
  }

  control(message) {
    if (!message) return;
    switch (message.type) {
      case 'attach':
        // A new emulation Worker brings a new channel; the old one is dead.
        if (this.input) { this.input.onmessage = null; this.input.close(); }
        this.input = message.port;
        this.input.onmessage = ({ data }) => this.chunk(data);
        break;
      case 'flush':
        this.streams.clear();
        break;
      case 'stop':
        this.stopped = true;
        break;
    }
  }

  targetFrames(stream) { return Math.ceil(this.targetMs * 0.001 * stream.freq); }

  chunk(data) {
    if (!data) return;
    const { port, freq, channels, frames, pcm } = data;
    if (!(frames > 0) || !(freq > 0) || (channels !== 1 && channels !== 2) || !pcm
      || pcm.byteLength < frames * channels * 2) return;
    let stream = this.streams.get(port);
    if (!stream || stream.freq !== freq || stream.channels !== channels) {
      stream = new Stream(freq, channels);
      this.streams.set(port, stream);
    }
    if (stream.dryAt >= 0) {
      // Data came back soon after playback ran dry: that gap was heard, so make
      // the next start more cautious. After a long silence the guest had
      // paused (a loading screen, a menu), which must not inflate latency.
      if (currentTime - stream.dryAt < 0.5) {
        this.counters.underruns += 1;
        this.targetMs = Math.min(this.maxTargetMs, this.targetMs + 20);
        this.stableSince = currentTime;
      }
      stream.dryAt = -1;
    }
    const samples = new Int16Array(pcm, 0, frames * channels);
    const skip = frames > MAX_CHUNK ? frames - MAX_CHUNK : 0;
    const count = frames - skip;
    const left = stream.left, right = stream.right;
    let write = stream.write;
    if (channels === 2) {
      for (let i = 0; i < count; ++i) {
        const at = write + i & MASK, from = (skip + i) * 2;
        left[at] = samples[from] * SCALE;
        right[at] = samples[from + 1] * SCALE;
      }
    } else {
      for (let i = 0; i < count; ++i) left[write + i & MASK] = samples[skip + i] * SCALE;
    }
    write += count;
    stream.write = write;
    stream.lastSeen = currentTime;
    this.counters.chunks += 1;
    this.counters.frames += frames;
    // Too far ahead: keep the newest target's worth and count the drop.
    const queued = write - stream.read;
    const limit = Math.min(Math.ceil(Math.max(this.maxMs, this.targetMs * 3) * 0.001 * freq), RING - MAX_CHUNK);
    if (queued > limit) {
      const keep = this.targetFrames(stream);
      this.counters.overruns += 1;
      this.counters.dropped += queued - keep;
      stream.read = write - keep;
    }
  }

  render(stream, left, right, frames) {
    const step = stream.freq / sampleRate;
    const mixRight = right !== left;
    let tailL = stream.tailL, tailR = stream.tailR;
    if (!stream.primed) {
      if (stream.write - stream.read < this.targetFrames(stream)) {
        // Still filling. An underrun's fade-out keeps decaying across blocks
        // instead of stopping dead at the block edge (that would click).
        if (tailL !== 0 || tailR !== 0) {
          for (let i = 0; i < frames; ++i) {
            tailL *= TAIL_DECAY;
            tailR *= TAIL_DECAY;
            left[i] += tailL;
            if (mixRight) right[i] += tailR;
          }
          if (Math.abs(tailL) + Math.abs(tailR) < TAIL_FLOOR) tailL = tailR = 0;
          stream.tailL = tailL;
          stream.tailR = tailR;
        }
        return;
      }
      stream.primed = true;
      stream.fadeIn = 0;
    }
    let read = stream.read;
    const write = stream.write;
    const sl = stream.left, sr = stream.right;
    const stereo = sr !== sl;
    const tailing = tailL !== 0 || tailR !== 0;
    let fadeIn = stream.fadeIn;
    let playedL = stream.lastL, playedR = stream.lastR;
    let i = 0;
    for (; i < frames; ++i) {
      // Interpolation needs frame floor(read) and the one after it.
      if (read + 1 >= write) break;
      const whole = Math.floor(read), fraction = read - whole;
      const a = whole & MASK, b = whole + 1 & MASK;
      let l = sl[a] + (sl[b] - sl[a]) * fraction;
      let r = stereo ? sr[a] + (sr[b] - sr[a]) * fraction : l;
      if (fadeIn < FADE_IN) {
        const gain = fadeIn++ / FADE_IN;
        l *= gain;
        r *= gain;
      }
      playedL = l;
      playedR = r;
      if (tailing) {
        tailL *= TAIL_DECAY;
        tailR *= TAIL_DECAY;
        l += tailL;
        r += tailR;
      }
      left[i] += l;
      if (mixRight) right[i] += r;
      read += step;
    }
    if (i < frames) {
      // Ran dry mid-block: fade the last output to zero (across following
      // blocks too), then wait to refill.
      // (If it ran dry on the block's first frame, playedL/R still hold the
      // last sample of the previous block, which is where the fade starts.)
      tailL += playedL;
      tailR += playedR;
      playedL = playedR = 0;
      for (; i < frames; ++i) {
        tailL *= TAIL_DECAY;
        tailR *= TAIL_DECAY;
        left[i] += tailL;
        if (mixRight) right[i] += tailR;
      }
      stream.primed = false;
      // Whether this was an underrun is decided when data next arrives (see
      // chunk): a guest that simply stopped sending is not one.
      stream.dryAt = currentTime;
    }
    if (Math.abs(tailL) + Math.abs(tailR) < TAIL_FLOOR) tailL = tailR = 0;
    stream.tailL = tailL;
    stream.tailR = tailR;
    stream.lastL = playedL;
    stream.lastR = playedR;
    stream.read = read;
    stream.fadeIn = fadeIn;
  }

  process(_inputs, outputs) {
    if (this.stopped) return false;
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    const frames = left.length;
    left.fill(0);
    if (right !== left) right.fill(0);
    const now = currentTime;
    for (const [port, stream] of this.streams) {
      if (now - stream.lastSeen > 2) { this.streams.delete(port); continue; }
      this.render(stream, left, right, frames);
    }
    if (this.targetMs > this.baseMs && now - this.stableSince > 10) {
      this.targetMs = Math.max(this.baseMs, this.targetMs - 10);
      this.stableSince = now;
    }
    if (now >= this.reportAt) {
      this.reportAt = now + 2;
      let queuedMs = 0;
      for (const stream of this.streams.values())
        queuedMs = Math.max(queuedMs, (stream.write - stream.read) * 1000 / stream.freq);
      this.port.postMessage({ type: 'stats', ...this.counters, queuedMs: Math.round(queuedMs),
        targetMs: this.targetMs, streams: this.streams.size });
    }
    return true;
  }
}

registerProcessor('vita3k-audio-stream', Vita3kAudioStream);
