// Generate short playback fixtures covering container × video codec × audio codec.
//   node scripts/make-fixtures.mjs [--out data/fixtures] [--only <substring>] [--force]
// Video: testsrc2 + burned-in timestamp + a white flash for the first 0.1 s of every second.
// Audio: a 0.1 s beep at every whole second (440 Hz; English tracks use 1000 Hz), so the
// flash and the beep line up when A/V are in sync and the heard track can be identified.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = path.resolve(ROOT, opt('out', 'data/fixtures'));
const ONLY = opt('only', '');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const DUR = 30;

const FONT = '/System/Library/Fonts/Supplemental/Courier New.ttf';
const videoSrc = (rate = 24) =>
  `testsrc2=s=640x360:r=${rate}:d=${DUR},` +
  `drawbox=c=white:t=fill:enable='lt(mod(t,1),0.1)',` +
  `drawtext=fontfile='${FONT}':text='%{pts\\:hms} f%{n}':fontsize=44:fontcolor=yellow:box=1:boxcolor=black:x=20:y=20`;
const beep = (freq, rate = 48000) =>
  `sine=f=${freq}:r=${rate}:d=${DUR},volume='if(lt(mod(t,1),0.1),0.8,0)':eval=frame,aformat=channel_layouts=stereo`;

const V = {
  h264: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '120'],
  hevc: ['-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '120', '-x265-params', 'log-level=error'],
  hevc10: ['-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le', '-g', '120', '-x265-params', 'log-level=error'],
  vp9: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '800k', '-g', '120'],
  av1: ['-c:v', 'libsvtav1', '-preset', '10', '-g', '120', '-pix_fmt', 'yuv420p'],
  mpeg2: ['-c:v', 'mpeg2video', '-q:v', '4', '-g', '15'],
  xvid: ['-c:v', 'libxvid', '-q:v', '4', '-g', '120'],
  wmv2: ['-c:v', 'wmv2', '-q:v', '4', '-g', '120'],
  prores: ['-c:v', 'prores_ks', '-profile:v', '0'],
  theora: ['-c:v', 'libtheora', '-q:v', '6', '-g', '120'],
};
const A = {
  aac: ['-c:a', 'aac', '-b:a', '128k'],
  opus: ['-c:a', 'libopus', '-b:a', '96k'],
  vorbis: ['-c:a', 'libvorbis', '-q:a', '4'],
  flac: ['-c:a', 'flac'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '128k'],
  ac3: ['-c:a', 'ac3', '-b:a', '192k'],
  eac3: ['-c:a', 'eac3', '-b:a', '192k'],
  dts: ['-c:a', 'dca', '-strict', '-2'],
  truehd: ['-c:a', 'truehd', '-strict', '-2'],
  pcm: ['-c:a', 'pcm_s16le'],
  wma: ['-c:a', 'wmav2', '-b:a', '128k'],
  mp2: ['-c:a', 'mp2', '-b:a', '192k'],
};

// [container, video, audio, extra output args]
const SINGLE = [
  ...['aac', 'opus', 'vorbis', 'flac', 'mp3', 'ac3', 'eac3', 'dts', 'truehd', 'pcm'].map((a) => ['mkv', 'h264', a]),
  ['mkv', 'hevc', 'opus'], ['mkv', 'hevc10', 'opus'], ['mkv', 'vp9', 'opus'], ['mkv', 'av1', 'opus'],
  ['mkv', 'mpeg2', 'mp3'], ['mkv', 'xvid', 'mp3'], ['mkv', 'prores', 'pcm'],
  ['mp4', 'h264', 'aac'], ['mp4', 'h264', 'mp3'], ['mp4', 'h264', 'opus'], ['mp4', 'h264', 'flac'],
  ['mp4', 'h264', 'ac3'], ['mp4', 'h264', 'eac3'],
  ['mp4', 'hevc', 'aac', ['-tag:v', 'hvc1']], ['mp4', 'hevc10', 'aac', ['-tag:v', 'hvc1']],
  ['mp4', 'hevc', 'aac', ['-tag:v', 'hev1'], 'hev1'], ['mp4', 'vp9', 'opus'], ['mp4', 'av1', 'opus'],
  ['mp4', 'xvid', 'aac'], ['mp4', 'mpeg2', 'aac'],
  ['mov', 'h264', 'aac'], ['mov', 'hevc', 'aac', ['-tag:v', 'hvc1']], ['mov', 'prores', 'pcm'],
  ['webm', 'vp9', 'opus'], ['webm', 'vp9', 'vorbis'], ['webm', 'av1', 'opus'],
  ['avi', 'xvid', 'mp3'], ['avi', 'h264', 'ac3'], ['avi', 'mpeg2', 'mp2'],
  ['ts', 'h264', 'aac'], ['ts', 'hevc', 'ac3'], ['ts', 'mpeg2', 'mp2'],
  ['m2ts', 'h264', 'ac3', ['-mpegts_m2ts_mode', '1']], ['m2ts', 'hevc', 'eac3', ['-mpegts_m2ts_mode', '1']],
  ['m2ts', 'h264', 'truehd', ['-mpegts_m2ts_mode', '1']],
  ['wmv', 'wmv2', 'wma'],
  ['flv', 'h264', 'aac'], ['flv', 'h264', 'mp3'],
  ['ogg', 'theora', 'vorbis'],
];

const FMT = { mkv: 'matroska', mp4: 'mp4', mov: 'mov', webm: 'webm', avi: 'avi', ts: 'mpegts', m2ts: 'mpegts', wmv: 'asf', flv: 'flv', ogg: 'ogg' };
const audioRate = (c, a) => (c === 'flv' ? 44100 : a === 'truehd' || a === 'dts' ? 48000 : 48000);

function encode(name, container, vcodec, audios, extra = []) {
  const file = path.join(OUT, `${name}.${container}`);
  if (ONLY && !file.includes(ONLY)) return;
  if (fs.existsSync(file) && !args.includes('--force')) return void console.log('skip', path.basename(file));
  const inputs = ['-f', 'lavfi', '-i', videoSrc()];
  const maps = ['-map', '0:v'];
  const codecArgs = [...V[vcodec]];
  audios.forEach(({ codec, lang, freq, isDefault }, i) => {
    inputs.push('-f', 'lavfi', '-i', beep(freq, audioRate(container, codec)));
    maps.push('-map', `${i + 1}:a`);
    const [, enc, ...rest] = A[codec];
    codecArgs.push(`-c:a:${i}`, enc, ...rest.map((x) => (x === '-b:a' ? `-b:a:${i}` : x === '-q:a' ? `-q:a:${i}` : x)));
    codecArgs.push(`-metadata:s:a:${i}`, `language=${lang}`, `-metadata:s:a:${i}`, `title=${lang === 'jpn' ? 'Japanese' : 'English'}`);
    codecArgs.push(`-disposition:a:${i}`, isDefault ? 'default' : '0');
  });
  const t0 = Date.now();
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...inputs, ...maps, ...codecArgs, ...extra, '-f', FMT[container], file], {
    stdio: 'inherit',
    env: { ...process.env, SVT_LOG: '1' },
  });
  console.log(`made ${path.basename(file)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [c, v, a, extra, suffix] of SINGLE) {
  encode(`${c}-${v}-${a}${suffix ? `-${suffix}` : ''}`, c, v, [{ codec: a, lang: 'jpn', freq: 440, isDefault: true }], extra);
}
const JE = [{ lang: 'jpn', freq: 440 }, { lang: 'eng', freq: 1000 }];
for (const [c, a] of [['mkv', 'aac'], ['mkv', 'opus'], ['mp4', 'aac']]) {
  encode(`${c}-h264-${a}-dual-jpn-default`, c, 'h264', JE.map((t, i) => ({ ...t, codec: a, isDefault: i === 0 })));
  encode(`${c}-h264-${a}-dual-eng-default`, c, 'h264', [...JE].reverse().map((t, i) => ({ ...t, codec: a, isDefault: i === 0 })));
}
// Default flag on the second track: what does Chromium play, the first or the flagged one?
encode('mkv-h264-aac-dual-eng-first-jpn-default', 'mkv', 'h264', [...JE].reverse().map((t, i) => ({ ...t, codec: 'aac', isDefault: i === 1 })));
// Dual audio where the Japanese track is undecodable by Chromium (forces stream).
encode('mkv-h264-dual-eng-aac-jpn-ac3', 'mkv', 'h264', [
  { lang: 'eng', freq: 1000, codec: 'aac', isDefault: true },
  { lang: 'jpn', freq: 440, codec: 'ac3', isDefault: false },
]);
