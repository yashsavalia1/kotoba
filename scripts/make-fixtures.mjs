// Generate short playback fixtures covering container × video codec × audio codec, with the
// app's own ffmpeg, for scripts/verify-playback.mjs.
//   node scripts/make-fixtures.mjs [--out data/fixtures] [--only <substring>] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ffmpeg } from '../src/core/ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = path.resolve(ROOT, opt('out', 'data/fixtures'));
const ONLY = opt('only', '');
const DUR = 30;

const V = {
  h264: ['libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '120'],
  hevc: ['libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '120', '-x265-params', 'log-level=error'],
  hevc10: ['libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le', '-g', '120', '-x265-params', 'log-level=error'],
  vp9: ['libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '800k', '-g', '120'],
  av1: ['libsvtav1', '-preset', '10', '-g', '120', '-pix_fmt', 'yuv420p'],
  mpeg2: ['mpeg2video', '-q:v', '4', '-g', '15'],
  xvid: ['mpeg4', '-q:v', '4', '-g', '120'],
  prores: ['prores_ks', '-profile:v', '0'],
  theora: ['libtheora', '-q:v', '6', '-g', '120'],
};
const A = {
  aac: ['aac'],
  opus: ['libopus'],
  vorbis: ['libvorbis'],
  flac: ['flac'],
  mp3: ['libmp3lame'],
  ac3: ['ac3'],
  eac3: ['eac3'],
  dts: ['dca', '-strict', '-2'],
  truehd: ['truehd', '-strict', '-2'],
  pcm: ['pcm_s16le'],
};
const FMT = { mkv: 'matroska', mka: 'matroska', mp4: 'mp4', m4v: 'mp4', m4a: 'mp4', mov: 'mov', webm: 'webm', ogg: 'ogg', oga: 'oga', opus: 'opus', mp3: 'mp3', flac: 'flac', aac: 'adts', wav: 'wav' };

// [container, video codec or null, audio codecs (first track first), extra output args, name suffix]
const FIXTURES = [
  ...['aac', 'opus', 'vorbis', 'flac', 'mp3', 'ac3', 'eac3', 'dts', 'truehd', 'pcm'].map((a) => ['mkv', 'h264', [a]]),
  ['mkv', 'hevc', ['opus']], ['mkv', 'hevc10', ['opus']], ['mkv', 'vp9', ['opus']], ['mkv', 'av1', ['opus']],
  ['mkv', 'mpeg2', ['mp3']], ['mkv', 'xvid', ['mp3']], ['mkv', 'prores', ['pcm']],
  // Chromium plays the first audio track it can decode, so an AC3 first track hands over to the AAC.
  ['mkv', 'h264', ['aac', 'ac3']], ['mkv', 'h264', ['ac3', 'aac']],
  ['mp4', 'h264', ['aac']], ['mp4', 'h264', ['mp3']], ['mp4', 'h264', ['opus']], ['mp4', 'h264', ['flac']],
  ['mp4', 'h264', ['ac3']], ['mp4', 'h264', ['eac3']],
  ['mp4', 'hevc', ['aac'], ['-tag:v', 'hvc1']], ['mp4', 'hevc10', ['aac'], ['-tag:v', 'hvc1']],
  ['mp4', 'hevc', ['aac'], ['-tag:v', 'hev1'], 'hev1'], ['mp4', 'vp9', ['opus']], ['mp4', 'av1', ['opus']],
  ['mp4', 'xvid', ['aac']], ['mp4', 'mpeg2', ['aac']],
  ['m4v', 'h264', ['aac']],
  ['mov', 'h264', ['aac']], ['mov', 'hevc', ['aac'], ['-tag:v', 'hvc1']], ['mov', 'prores', ['pcm']],
  ['webm', 'vp9', ['opus']], ['webm', 'vp9', ['vorbis']], ['webm', 'av1', ['opus']],
  ['ogg', 'theora', ['vorbis']],
  ['mp3', null, ['mp3']], ['flac', null, ['flac']], ['m4a', null, ['aac']], ['aac', null, ['aac']],
  ['ogg', null, ['vorbis']], ['oga', null, ['flac']], ['opus', null, ['opus']], ['wav', null, ['pcm']],
  ['mka', null, ['aac']], ['mka', null, ['ac3']],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [c, v, audios, extra = [], suffix] of FIXTURES) {
  const file = path.join(OUT, `${[c, v, ...audios, suffix].filter(Boolean).join('-')}.${c}`);
  if (ONLY && !file.includes(ONLY)) continue;
  if (fs.existsSync(file) && !args.includes('--force')) {
    console.log('skip', path.basename(file));
    continue;
  }
  const inputs = v ? ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24:d=${DUR}`] : [];
  const out = v ? ['-map', '0:v', '-c:v', ...V[v]] : [];
  audios.forEach((a, i) => {
    inputs.push('-f', 'lavfi', '-i', `sine=f=${440 * (i + 1)}:r=48000:d=${DUR},aformat=channel_layouts=stereo`);
    out.push('-map', `${(v ? 1 : 0) + i}:a`, `-c:a:${i}`, ...A[a]);
  });
  const t0 = Date.now();
  execFileSync(ffmpeg(), ['-hide_banner', '-v', 'error', '-y', ...inputs, ...out, ...extra, '-f', FMT[c], file], {
    stdio: 'inherit',
    env: { ...process.env, SVT_LOG: '1' },
  });
  console.log(`made ${path.basename(file)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
