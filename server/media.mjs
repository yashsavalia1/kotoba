import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { SUB_EXTS } from './subs.mjs';

const run = promisify(execFile);

export const VIDEO_EXTS = ['.mkv', '.mp4', '.m4v', '.webm', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.ogv', '.mpg', '.mpeg'];
export const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma'];
const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];

// Codecs Chrome/Safari will play from an MP4 container without transcoding.
const MP4_VIDEO_OK = new Set(['h264', 'hevc', 'av1']);
const MP4_AUDIO_OK = new Set(['aac', 'mp3']);
const DIRECT_EXTS = new Set(['.mp4', '.m4v', '.mp3', '.m4a', '.webm', '.ogg', '.opus', '.wav', '.flac']);

// Release names bury the only distinguishing part between identical prefixes
// and suffixes: every episode of a season renders as the same truncated string
// in a list. Drop bracketed group tags and parenthesised technical tags, but
// keep parentheses that carry real information such as a year.
const TECH = /\b(\d{3,4}p|BD|BDRip|BluRay|WEB|WEBRip|WEB-DL|HDTV|DVD|DVDRip|REMUX|HEVC|AVC|x26[45]|H\.?26[45]|AAC\d?|AC3|EAC3|DTS|FLAC|Opus|10 ?bits?|8 ?bits?|Dual[- ]Audio|MULTi|SCREENER)\b/i;

export function displayTitle(abs) {
  const stem = path.basename(abs, path.extname(abs));
  const trimmed = stem
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([^)]*)\)/g, (whole, inner) => (TECH.test(inner) ? ' ' : whole))
    .replace(/\s*[-_–]\s*$/, '')
    .replace(/^\s*[-_–]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return trimmed || stem;
}

export const idFor = (abs) => Buffer.from(abs).toString('base64url');
export const pathFor = (id) => {
  const abs = Buffer.from(id, 'base64url').toString('utf8');
  if (!config.mediaDirs.some((d) => abs.startsWith(path.resolve(d)))) {
    throw new Error('path outside configured mediaDirs');
  }
  if (!fs.existsSync(abs)) throw new Error('no such media file');
  return abs;
};

function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out, depth + 1);
    else if (MEDIA_EXTS.includes(path.extname(e.name).toLowerCase())) out.push(abs);
  }
  return out;
}

/** Subtitle files sitting next to the media file with a matching basename. */
function siblingSubs(abs) {
  const dir = path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase();
    if (!SUB_EXTS.includes(ext)) continue;
    if (!name.startsWith(stem)) continue;
    // "Show S01E01.ja.srt" -> label "ja"; "Show S01E01.srt" -> label "external"
    const middle = path.basename(name, ext).slice(stem.length).replace(/^[.\-_\s]+/, '');
    out.push({ kind: 'external', file: path.join(dir, name), label: middle || 'external' });
  }
  return out;
}

export function scanLibrary() {
  const files = config.mediaDirs.flatMap((d) => walk(path.resolve(d)));
  return files
    .map((abs) => {
      const st = fs.statSync(abs);
      return {
        id: idFor(abs),
        title: displayTitle(abs),
        file: path.basename(abs),
        dir: path.relative(path.resolve(config.mediaDirs[0]), path.dirname(abs)) || '.',
        ext: path.extname(abs).toLowerCase(),
        size: st.size,
        mtime: st.mtimeMs,
        hasExternalSubs: siblingSubs(abs).length > 0,
      };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.title.localeCompare(b.title));
}

export async function probe(abs) {
  const { stdout } = await run(config.ffprobe, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', abs,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** External sibling files plus every embedded text-subtitle stream. */
export async function subtitleTracks(abs) {
  const tracks = siblingSubs(abs);
  let info;
  try {
    info = await probe(abs);
  } catch {
    return tracks;
  }
  let n = 0;
  for (const s of info.streams ?? []) {
    if (s.codec_type !== 'subtitle') continue;
    const idx = n++;
    // Bitmap subtitles (PGS/VobSub) carry no text - nothing to hover.
    if (['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'].includes(s.codec_name)) continue;
    tracks.push({
      kind: 'embedded',
      index: idx,
      label: [s.tags?.language, s.tags?.title].filter(Boolean).join(' ') || `track ${idx}`,
    });
  }
  return tracks;
}

export async function extractEmbeddedSub(abs, index) {
  const { stdout } = await run(config.ffmpeg, [
    '-v', 'error', '-i', abs, '-map', `0:s:${index}`, '-f', 'srt', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Subtitle files are still routinely Shift-JIS. Fall back when UTF-8 fails. */
export function decodeSubFile(abs) {
  const buf = fs.readFileSync(abs);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  for (const enc of ['shift_jis', 'euc-jp', 'windows-1252']) {
    try {
      const alt = new TextDecoder(enc, { fatal: true }).decode(buf);
      return alt;
    } catch { /* try next */ }
  }
  return utf8;
}

// ------------------------------------------------------------------ playback

const jobs = new Map(); // cacheKey -> { status, progress, error }

const cacheKey = (abs) => {
  const st = fs.statSync(abs);
  return crypto.createHash('sha1').update(`${abs}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 16);
};

/** ISO-639-1 in the config, ISO-639-2 in most containers. */
const LANG_ALIASES = { ja: ['ja', 'jpn'], en: ['en', 'eng'], ko: ['ko', 'kor'], zh: ['zh', 'chi', 'zho'] };

async function playPlan(abs) {
  const ext = path.extname(abs).toLowerCase();
  const info = await probe(abs);
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);

  // Dual-audio releases are common, and ffmpeg's default mapping picks by
  // channel count, not language - which silently hands you the English dub.
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const want = LANG_ALIASES[config.targetLang] ?? [config.targetLang];
  const a = audio.find((s) => want.includes((s.tags?.language ?? '').toLowerCase())) ?? audio[0];
  const duration = Number(info.format?.duration) || 0;

  const videoOk = !v || MP4_VIDEO_OK.has(v.codec_name);
  const audioOk = !a || MP4_AUDIO_OK.has(a.codec_name);
  if (DIRECT_EXTS.has(ext) && videoOk && audioOk) return { mode: 'direct', duration, info };

  return {
    mode: 'convert',
    duration,
    info,
    // Stream-copying is near-instant; a real transcode is the slow path.
    copyOnly: videoOk,
    args: [
      // Map exactly one video and one audio stream. Without this, ffmpeg also
      // carries subtitle and attachment streams into the mp4 as data tracks.
      '-map', `0:${v ? v.index : 'v:0'}`,
      ...(a ? ['-map', `0:${a.index}`] : []),
      // Matroska chapters otherwise land in the mp4 as a stray bin_data track.
      '-sn', '-dn', '-map_chapters', '-1',
      ...(videoOk ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']),
      // Safari (and some Chrome builds) refuse HEVC tagged hev1 but accept
      // hvc1; the bitstream is identical, only the sample entry name differs.
      ...(v?.codec_name === 'hevc' && videoOk ? ['-tag:v', 'hvc1'] : []),
      ...(audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    ],
  };
}

/**
 * Make `abs` playable by a browser <video> element. Returns immediately with a
 * status; the client polls until `ready`. Direct-playable files skip the work.
 */
export async function prepare(abs) {
  const plan = await playPlan(abs);
  if (plan.mode === 'direct') return { status: 'ready', direct: true, duration: plan.duration };

  const key = cacheKey(abs);
  const out = path.join(config.cacheDir, `${key}.mp4`);

  // An in-flight job wins over the file check: ffmpeg creates its output as
  // soon as it starts, so existsSync alone would report a 48-byte header ready.
  const existing = jobs.get(key);
  if (existing) return { ...existing, key, duration: plan.duration };
  if (fs.existsSync(out)) return { status: 'ready', direct: false, key, duration: plan.duration };

  const job = { status: 'working', progress: 0, copyOnly: plan.copyOnly };
  jobs.set(key, job);

  // Written to a .part file and renamed on success, so a crashed or killed
  // conversion can never leave a truncated file that looks like a cache hit.
  const partial = `${out}.part.mp4`;
  const child = execFile(
    config.ffmpeg,
    ['-v', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-i', abs,
      ...plan.args, '-movflags', '+faststart', partial],
    { maxBuffer: 1024 * 1024 }
  );
  child.stdout?.on('data', (chunk) => {
    const m = /out_time_us=(\d+)/.exec(String(chunk));
    if (m && plan.duration) job.progress = Math.min(1, Number(m[1]) / 1e6 / plan.duration);
  });
  child.on('exit', (code) => {
    if (code === 0) {
      fs.renameSync(partial, out);
      job.status = 'ready';
      job.progress = 1;
    } else {
      job.status = 'error';
      job.error = `ffmpeg exited ${code}`;
      fs.rmSync(partial, { force: true });
    }
    // Keep the entry so a follow-up poll sees the terminal state.
    setTimeout(() => jobs.delete(key), 60_000).unref();
  });

  return { ...job, key, duration: plan.duration };
}

export const convertedPath = (key) => path.join(config.cacheDir, `${key}.mp4`);

/** Total bytes of converted media held in the cache. */
export function cacheSize() {
  let total = 0;
  for (const f of fs.readdirSync(config.cacheDir)) {
    try {
      total += fs.statSync(path.join(config.cacheDir, f)).size;
    } catch { /* raced with a cleanup */ }
  }
  return total;
}

// ------------------------------------------------------- card media extraction

const pad = (n) => Math.max(0, n);

/** Audio clip of a subtitle span, as mp3. */
export async function clipAudio(abs, start, end) {
  const p = config.clipPadding;
  const file = path.join(config.cacheDir, `a_${crypto.randomUUID()}.mp3`);
  await run(config.ffmpeg, [
    '-v', 'error', '-y', '-ss', String(pad(start - p)), '-t', String(end - start + 2 * p),
    '-i', abs, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', file,
  ]);
  return file;
}

/** Video clip of a subtitle span, as h264 mp4. */
export async function clipVideo(abs, start, end) {
  const p = config.clipPadding;
  const file = path.join(config.cacheDir, `v_${crypto.randomUUID()}.mp4`);
  await run(config.ffmpeg, [
    '-v', 'error', '-y', '-ss', String(pad(start - p)), '-t', String(end - start + 2 * p),
    '-i', abs, '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', file,
  ]);
  return file;
}

/** Single frame from the middle of a subtitle span, as jpeg. */
export async function screenshot(abs, start, end) {
  const file = path.join(config.cacheDir, `i_${crypto.randomUUID()}.jpg`);
  await run(config.ffmpeg, [
    '-v', 'error', '-y', '-ss', String(pad((start + end) / 2)), '-i', abs,
    '-frames:v', '1', '-vf', 'scale=-2:480', '-q:v', '4', file,
  ]);
  return file;
}

export function ffmpegAvailable() {
  try {
    execFileSync(config.ffmpeg, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
