// Play fixtures in the real app and measure what actually happens. Audio is never audible:
// the window is muted and the analyser graph ends in a zero gain.
//   node scripts/verify-playback.mjs [files…]            through the app UI (VideoSurface)
//   node scripts/verify-playback.mjs --matrix [files…]   raw <video src=kotoba://media/…>, no UI
//   options: --force-stream (KOTOBA_PLAYBACK=stream) · --json out.json · --sample 2500
// Default files: data/fixtures/*. Exits non-zero when a UI-mode check fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (flag(n) ? args[args.indexOf(`--${n}`) + 1] : d);
const valued = new Set(['--json', '--sample']);
let files = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!files.length) {
  const dir = path.join(ROOT, 'data', 'fixtures');
  files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort().map((f) => path.join(dir, f));
}
files = files.map((f) => path.resolve(f));
const SAMPLE = Number(opt('sample', 2500));

const ffmpegPids = () => {
  try {
    return execFileSync('pgrep', ['-x', 'ffmpeg']).toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const before = new Set(ffmpegPids());

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-verify-'));
const app = await electron.launch({
  args: [ROOT],
  cwd: ROOT,
  env: {
    ...process.env,
    KOTOBA_USER_DATA: userData,
    KOTOBA_BACKGROUND: '1',
    ...(!process.env.FFPROBE && fs.existsSync('/opt/homebrew/bin/ffprobe') ? { FFPROBE: '/opt/homebrew/bin/ffprobe' } : {}), ...(flag('force-stream') ? { KOTOBA_PLAYBACK: 'stream' } : {}),
  },
});
const win = await app.firstWindow();
const errors = [];
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
win.on('pageerror', (e) => errors.push(String(e)));
await win.waitForLoadState('domcontentloaded');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));

// In-page instrumentation: decoded byte counters, flash/beep onsets for A/V sync,
// the dominant tone frequency (440 Hz = jpn track, 1000 Hz = eng track).
await win.evaluate(() => {
  const K = (window.__kv = {});
  const ctx = new AudioContext();
  const graph = (v) => {
    if (v.__g) return v.__g;
    const src = ctx.createMediaElementSource(v);
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(an).connect(mute).connect(ctx.destination);
    return (v.__g = an);
  };
  const frac = (t) => ((t % 1) + 1.5) % 1 - 0.5;
  const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null);
  const once = (v, ok, bad = 'error', ms = 15000) =>
    new Promise((res) => {
      const t0 = performance.now();
      const done = (r) => {
        clearTimeout(timer);
        v.removeEventListener(ok, a);
        v.removeEventListener(bad, b);
        res({ ...r, ms: Math.round(performance.now() - t0) });
      };
      const a = () => done({ ok: true });
      const b = () => done({ ok: false, error: v.error ? `${v.error.code}:${v.error.message}` : bad });
      const timer = setTimeout(() => done({ ok: false, error: `timeout waiting for ${ok}` }), ms);
      v.addEventListener(ok, a);
      v.addEventListener(bad, b);
    });

  K.measure = async (v, ms) => {
    const an = graph(v);
    await ctx.resume();
    const td = new Float32Array(an.fftSize);
    const fd = new Float32Array(an.frequencyBinCount);
    const cv = Object.assign(document.createElement('canvas'), { width: 32, height: 18 });
    const g = cv.getContext('2d', { willReadFrequently: true });
    const out = { flashes: [], flashMedia: [], beeps: [], freqs: {} };
    const a0 = v.webkitAudioDecodedByteCount;
    const v0 = v.webkitVideoDecodedByteCount;
    const t0 = v.currentTime;
    let lit = false;
    let loud = false;
    let live = true;
    const onFrame = (_now, meta) => {
      if (!live) return;
      try {
        g.drawImage(v, 0, 0, 32, 18);
        const d = g.getImageData(0, 0, 32, 18).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
        const lum = s / (d.length * 0.75 * 255);
        if (lum > 0.8 && !lit) {
          out.flashes.push(frac(v.currentTime));
          out.flashMedia.push(frac(meta.mediaTime));
        }
        lit = lum > 0.8;
      } catch (e) {
        out.canvasError = String(e);
      }
      v.requestVideoFrameCallback(onFrame);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
    await new Promise((res) => {
      const end = performance.now() + ms;
      const tick = () => {
        an.getFloatTimeDomainData(td);
        let e = 0;
        for (const x of td.subarray(td.length - 1024)) e += x * x;
        const rms = Math.sqrt(e / 1024);
        out.maxRms = Math.max(out.maxRms ?? 0, rms);
        if (rms > 0.03 && !loud) {
          out.beeps.push(frac(v.currentTime));
          an.getFloatFrequencyData(fd);
          let best = 0;
          for (let i = 1; i < fd.length; i++) if (fd[i] > fd[best]) best = i;
          const hz = Math.round((best * ctx.sampleRate) / an.fftSize / 50) * 50;
          out.freqs[hz] = (out.freqs[hz] ?? 0) + 1;
        }
        loud = rms > 0.01;
        if (performance.now() < end) setTimeout(tick, 8);
        else res();
      };
      tick();
    });
    live = false;
    const flash = median(out.flashes);
    const beep = median(out.beeps);
    const top = Object.entries(out.freqs).sort((a, b) => b[1] - a[1])[0];
    return {
      advanced: +(v.currentTime - t0).toFixed(2),
      audioBytes: v.webkitAudioDecodedByteCount - a0,
      videoBytes: v.webkitVideoDecodedByteCount - v0,
      tone: top ? Number(top[0]) : null,
      flashAt: flash,
      flashMediaAt: median(out.flashMedia),
      beepAt: beep,
      avOffsetMs: flash != null && beep != null ? Math.round((beep - flash) * 1000) : null,
      canvasError: out.canvasError,
      maxRms: +(out.maxRms ?? 0).toFixed(3),
      ctx: `${ctx.state}@${ctx.sampleRate}`,
    };
  };

  K.seek = async (v, t) => {
    const p = once(v, 'seeked');
    const t0 = performance.now();
    v.currentTime = t;
    const r = await p;
    // A seek is only done for the user once a frame at the target can play.
    if (r.ok && v.readyState < 3) await once(v, 'canplay', 'error', 15000);
    return { ...r, target: t, landed: +v.currentTime.toFixed(3), ms: Math.round(performance.now() - t0) };
  };

  K.tracks = (v) =>
    v.audioTracks ? [...v.audioTracks].map((t) => ({ id: t.id, lang: t.language, label: t.label, enabled: t.enabled })) : null;

  K.selectTrack = (v, i) => {
    [...v.audioTracks].forEach((t, j) => (t.enabled = j === i));
  };

  // Raw direct probe: what Chromium itself does with the file, no app code involved.
  K.raw = async (url, ms, dual) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;z-index:9999';
    document.body.append(v);
    const r = { url };
    try {
      const t0 = performance.now();
      v.src = url;
      const meta = await once(v, 'loadeddata');
      r.load = meta;
      if (!meta.ok) return r;
      r.firstFrameMs = Math.round(performance.now() - t0);
      r.width = v.videoWidth;
      r.duration = +v.duration.toFixed(2);
      r.tracks = K.tracks(v);
      await v.play().catch((e) => (r.playError = String(e)));
      r.play = await K.measure(v, ms);
      if (dual && v.audioTracks?.length > 1) {
        const enabled = [...v.audioTracks].findIndex((t) => t.enabled);
        K.selectTrack(v, enabled === 0 ? 1 : 0);
        await new Promise((res) => setTimeout(res, 400));
        r.switched = { to: enabled === 0 ? 1 : 0, ...(await K.measure(v, ms)), tracks: K.tracks(v) };
      }
      r.seek = await K.seek(v, Math.min(20, v.duration - 5));
      r.afterSeek = await K.measure(v, 1500);
    } catch (e) {
      r.exception = String(e);
    } finally {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
    return r;
  };
});

const records = await win.evaluate((ps) => window.kotoba.invoke('library:open', ps), files);
const results = [];

if (flag('matrix')) {
  for (const rec of records) {
    const dual = /dual/.test(rec.path);
    const r = await win.evaluate(([u, ms, d]) => window.__kv.raw(u, ms, d), [`kotoba://media/${rec.id}`, SAMPLE, dual]);
    const name = path.basename(rec.path);
    const verdict = !r.load?.ok
      ? `FAIL ${r.load?.error}`
      : `${r.play.videoBytes > 0 && r.width ? 'V' : '-'}${r.play.audioBytes > 0 && r.play.tone ? 'A' : '-'}`;
    console.log(
      `${name.padEnd(46)} ${verdict.padEnd(8)} adv=${r.play?.advanced ?? '-'} tone=${r.play?.tone ?? '-'} ` +
        `av=${r.play?.avOffsetMs ?? '-'}ms tracks=${JSON.stringify(r.tracks?.map((t) => `${t.lang}${t.enabled ? '*' : ''}`) ?? null)}` +
        (r.switched ? ` switched→${r.switched.to} tone=${r.switched.tone}` : '') +
        (r.seek ? ` seek=${r.seek.landed}/${r.seek.target} ${r.seek.ms}ms` : '')
    );
    results.push({ name, ...r });
  }
} else {
  let failures = 0;
  for (const rec of records) {
    const name = path.basename(rec.path);
    const r = await win.evaluate(
      async ([id, ms]) => {
        const K = window.__kv;
        const t0 = performance.now();
        await window.kotoba.invoke('library:open', [await window.kotoba.invoke('library:get', id).then((m) => m.path)]);
        const plan = await window.kotoba.invoke('playback:plan', id);
        let v;
        for (let i = 0; i < 300; i++) {
          v = document.querySelector('[data-testid=player] video');
          if (v && new RegExp(`/${id}(\\?|$)`).test(v.dataset.source) && v.readyState >= 2) break;
          await new Promise((res) => setTimeout(res, 50));
        }
        const out = { mode: v?.dataset.mode, reason: plan.reason, firstFrameMs: Math.round(performance.now() - t0) };
        if (!v || v.readyState < 2) return { ...out, error: v?.error?.message ?? 'no playable video element' };
        v.muted = false;
        await v.play();
        out.play = await K.measure(v, ms);
        const d = v.duration;
        out.duration = +d.toFixed(2);
        out.seeks = [];
        for (const t of [d * 0.6, d * 0.2, Math.max(0, d - 4)]) {
          const s = await K.seek(v, +t.toFixed(2));
          s.after = await K.measure(v, 1200);
          out.seeks.push(s);
        }
        v.pause();
        return out;
      },
      [rec.id, SAMPLE]
    );
    const problems = [];
    if (r.error) problems.push(r.error);
    if (r.play) {
      if (!(r.play.advanced > SAMPLE / 2000)) problems.push(`playback did not advance (${r.play.advanced}s)`);
      if (!(r.play.videoBytes > 0)) problems.push('no video decoded');
      if (!(r.play.audioBytes > 0) || !r.play.tone) problems.push('no audio heard');
      if (r.play.avOffsetMs != null && Math.abs(r.play.avOffsetMs) > 120) problems.push(`A/V offset ${r.play.avOffsetMs}ms`);
      if (r.play.flashMediaAt != null && Math.abs(r.play.flashMediaAt) > 0.06) problems.push(`frame timestamps off by ${r.play.flashMediaAt}s`);
    }
    for (const s of r.seeks ?? []) {
      if (!s.ok) problems.push(`seek ${s.target}: ${s.error}`);
      else if (Math.abs(s.landed - s.target) > 0.5) problems.push(`seek ${s.target} landed ${s.landed}`);
      if (s.after && !(s.after.advanced > 0.3) && s.target < r.duration - 2) problems.push(`no playback after seek ${s.target}`);
    }
    failures += problems.length ? 1 : 0;
    console.log(
      `${problems.length ? 'FAIL' : 'ok  '} ${name.padEnd(46)} ${String(r.mode).padEnd(6)} first=${r.firstFrameMs}ms ` +
        `av=${r.play?.avOffsetMs ?? '-'}ms tone=${r.play?.tone ?? '-'} seeks=${(r.seeks ?? []).map((s) => `${s.landed}/${s.target}@${s.ms}ms`).join(' ')}` +
        (problems.length ? `\n     ${problems.join('; ')}` : '') +
        (r.reason ? `\n     reason: ${r.reason}` : '')
    );
    results.push({ name, ...r, problems });
  }
  process.exitCode = failures ? 1 : 0;
}

await app.close();
await new Promise((res) => setTimeout(res, 500));
const orphans = ffmpegPids().filter((p) => !before.has(p));
console.log(`console errors: ${errors.length ? `\n  ${[...new Set(errors)].join('\n  ')}` : 'none'}`);
console.log(`ffmpeg processes left after close: ${orphans.length ? orphans.join(',') : 'none'}`);
if (orphans.length) process.exitCode = 1;
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify({ results, errors, orphans }, null, 1));
fs.rmSync(userData, { recursive: true, force: true });
