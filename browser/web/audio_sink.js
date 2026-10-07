// Worker side of the single-threaded audio path (browser/src/hle_audio_null.cpp
// calls vita3kWebOnAudio once per sceAudioOutOutput). The page picks where the
// PCM goes with an 'audio-config' message:
//
//   'port'  a MessagePort connected to audio_stream_worklet.js: one copy, one
//           transferred message, and the page's main thread is not involved.
//   'main'  legacy: post the chunk to the page (used when the page has no
//           AudioWorklet, e.g. an insecure context). This is also the default
//           until the page says otherwise, so an older player keeps working.
//   'off'   drop it before copying anything: no sink yet, or sound is muted.
export function createAudioSink(post) {
  let mode = 'main';
  let port = null;
  return {
    get mode() { return mode; },
    // `next` is 'port', 'main' or 'off'. A new port replaces (and closes) the
    // old one; omitting it keeps the current one, so muting ('off') and
    // unmuting ('port') need no new channel. 'port' with no port ever given
    // falls back to 'main'.
    configure(next, nextPort) {
      if (nextPort) {
        if (port && port !== nextPort) { try { port.close(); } catch {} }
        port = nextPort;
      }
      mode = next === 'off' ? 'off' : next === 'port' && port ? 'port' : 'main';
    },
    // `view` is only valid synchronously (it points into the Wasm scratch), so
    // it is copied here and the copy is what travels.
    push(freq, channels, frames, view, id = 0) {
      if (mode === 'off') return;
      const data = new Uint8Array(view).buffer;
      if (mode === 'port') port.postMessage({ port: id, freq, channels, frames, pcm: data }, [data]);
      else post({ type: 'vita-audio', freq, channels, frames, data, port: id }, [data]);
    },
  };
}
