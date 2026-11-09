import { createFile, Log, MP4BoxBuffer } from 'mp4box';

Log.setLogLevel(Log.error);

// Past this much buffered ahead the reader stops pulling, so ffmpeg blocks on its pipe.
const BUFFER_AHEAD = 60;
// Restarts begin a little early so the first frame is at or before the target.
const LEAD = 1;

const until = (target, ev) => new Promise((r) => target.addEventListener(ev, r, { once: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const concat = (a, b) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
};
// Chromium's MSE only knows these by their lower-case names.
const codecId = (c) => (/^(opus|flac)$/i.test(c) ? c.toLowerCase() : c);

/** MSE type from the init segment at the head of a stream; null until the moov is complete. */
function mimeOf(bytes) {
  const f = createFile();
  let info = null;
  f.onReady = (i) => (info = i);
  f.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes.slice().buffer, 0));
  if (!info) return null;
  return `${info.videoTracks.length ? 'video' : 'audio'}/mp4; codecs="${info.tracks.map((t) => codecId(t.codec)).join(', ')}"`;
}

/**
 * Play kotoba://stream on `video` through MediaSource. Timestamps arrive in media time, so
 * seeking is `video.currentTime = t`; a seek outside the range being streamed restarts ffmpeg
 * there. Returns detach().
 */
export function attachStream(video, { url, duration, startAt = 0, onError }) {
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  let sb = null;
  let gen = 0;
  let ctrl = null;
  let from = startAt;
  let dead = false;

  const idle = async () => {
    while (sb?.updating) await until(sb, 'updateend');
  };
  const rangeAt = (t) => {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.1 && t < b.end(i)) return [b.start(i), b.end(i)];
    return null;
  };
  const ahead = () => (rangeAt(video.currentTime)?.[1] ?? video.currentTime) - video.currentTime;

  async function append(bytes, my) {
    for (;;) {
      await idle();
      if (my !== gen) return;
      try {
        sb.appendBuffer(bytes);
        await until(sb, 'updateend');
        return;
      } catch (e) {
        if (e.name !== 'QuotaExceededError') throw e;
        // ponytail: relies on Chromium's MSE GC; only drops what is behind the playhead when that fails.
        if (video.currentTime > 10) {
          sb.remove(0, video.currentTime - 10);
          await until(sb, 'updateend');
        }
        await sleep(1000);
      }
    }
  }

  async function run(t) {
    const my = ++gen;
    ctrl?.abort();
    ctrl = new AbortController();
    from = t;
    try {
      if (sb) {
        await idle();
        if (my !== gen) return;
        // The previous response was cut mid-fragment.
        if (ms.readyState === 'open') sb.abort();
      }
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}start=${Math.max(0, t - LEAD).toFixed(3)}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Stream failed (${res.status}): ${await res.text()}`);
      const reader = res.body.getReader();
      let head = new Uint8Array(0);
      for (;;) {
        while (sb && my === gen && ahead() > BUFFER_AHEAD) await sleep(500);
        if (my !== gen) return void reader.cancel();
        const { value, done } = await reader.read();
        if (my !== gen) return void reader.cancel();
        if (done) break;
        let chunk = value;
        if (!sb) {
          head = concat(head, value);
          const mime = mimeOf(head);
          if (!mime) continue;
          if (!MediaSource.isTypeSupported(mime)) throw new Error(`This build cannot play ${mime}`);
          sb = ms.addSourceBuffer(mime);
          // The server shifts timestamps forward so B-frame dts never goes below zero.
          sb.timestampOffset = -Number(res.headers.get('x-ts-offset') ?? 0);
          chunk = head;
        }
        await append(chunk, my);
      }
      if (my === gen && ms.readyState === 'open') {
        await idle();
        ms.endOfStream();
      }
    } catch (e) {
      if (my === gen && !dead && e.name !== 'AbortError') onError?.(e.message);
    }
  }

  const onSeeking = () => {
    const t = video.currentTime;
    const [a, b] = rangeAt(from) ?? [from, from];
    if (t >= a - 0.5 && t <= b + 0.5) return;
    run(t);
  };

  ms.addEventListener(
    'sourceopen',
    () => {
      if (duration) ms.duration = duration;
      // Before metadata this only sets where playback will start; it fires no seek.
      if (startAt) video.currentTime = startAt;
      run(startAt);
    },
    { once: true }
  );
  video.addEventListener('seeking', onSeeking);
  video.src = objectUrl;

  return () => {
    dead = true;
    gen++;
    ctrl?.abort();
    video.removeEventListener('seeking', onSeeking);
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  };
}
