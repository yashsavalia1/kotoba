import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from './paths.mjs';
import { getSetting } from './settings.mjs';
import { ffmpegPath, ffprobePath } from './ffmpeg.mjs';

const run = promisify(execFile);

export const VIDEO_EXTS = ['.mkv', '.mp4', '.m4v', '.webm', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.mts', '.ogv', '.mpg', '.mpeg', '.3gp', '.vob', '.divx'];
export const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.ac3', '.dts', '.mka', '.ape', '.alac', '.aiff', '.aif'];
export const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];

export const extOf = (p) => path.extname(p).toLowerCase();
export const isMediaFile = (p) => MEDIA_EXTS.includes(extOf(p));
export const isVideoFile = (p) => VIDEO_EXTS.includes(extOf(p));

// Release tags bury the only distinguishing part of a filename between an identical prefix and suffix.
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

const probeCache = new Map();

/** ffprobe JSON, memoised per path + mtime + size. */
export async function probe(abs) {
  const st = fs.statSync(abs);
  const key = `${abs}:${st.size}:${st.mtimeMs}`;
  if (!probeCache.has(key)) {
    probeCache.set(
      key,
      run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', abs], {
        maxBuffer: 32 << 20,
      })
        .then(({ stdout }) => JSON.parse(stdout))
        .catch((e) => {
          probeCache.delete(key);
          throw e;
        })
    );
  }
  return probeCache.get(key);
}

// Bitmap subtitle codecs carry no text to hover.
export const BITMAP_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

export async function extractEmbeddedSub(abs, streamIndex) {
  const { stdout } = await run(ffmpegPath(), ['-v', 'error', '-i', abs, '-map', `0:${streamIndex}`, '-f', 'ass', '-'], {
    maxBuffer: 64 << 20,
  });
  return stdout;
}

/** Subtitle files are still routinely Shift-JIS or EUC-JP. */
export function decodeSubFile(abs) {
  const buf = fs.readFileSync(abs);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  for (const enc of ['shift_jis', 'euc-jp', 'utf-16le', 'windows-1252']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {
      /* try next */
    }
  }
  return utf8;
}

const tmp = (prefix, ext) => path.join(paths.tempDir, `${prefix}_${crypto.randomUUID()}${ext}`);
const padded = (start, end) => {
  const p = Number(getSetting('clipPadding')) || 0;
  return { from: Math.max(0, start - p), length: end - start + 2 * p };
};

export async function clipAudio(abs, start, end, audioStream = null) {
  const { from, length } = padded(start, end);
  const file = tmp('a', '.mp3');
  await run(ffmpegPath(), [
    '-v', 'error', '-y', '-ss', String(from), '-t', String(length), '-i', abs,
    '-map', audioStream == null ? '0:a:0' : `0:${audioStream}`, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', file,
  ]);
  return file;
}

export async function clipVideo(abs, start, end, audioStream = null) {
  const { from, length } = padded(start, end);
  const file = tmp('v', '.mp4');
  await run(ffmpegPath(), [
    '-v', 'error', '-y', '-ss', String(from), '-t', String(length), '-i', abs,
    '-map', '0:v:0', '-map', audioStream == null ? '0:a:0?' : `0:${audioStream}`,
    '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', file,
  ]);
  return file;
}

export async function screenshot(abs, start, end) {
  const file = tmp('i', '.jpg');
  await run(ffmpegPath(), [
    '-v', 'error', '-y', '-ss', String(Math.max(0, (start + end) / 2)), '-i', abs,
    '-frames:v', '1', '-vf', 'scale=-2:480', '-q:v', '4', file,
  ]);
  return file;
}
