import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { ROOT } from '../core/paths.mjs';
import { pathOf } from '../core/library.mjs';
import { playbackPlan } from '../core/playback.mjs';
import { checkPath } from '../core/browse.mjs';
import { thumbnail } from '../core/thumbs.mjs';
import { isVideoFile } from '../core/media.mjs';
import { handle } from './ipc-util.mjs';

const RENDERER_DIR = path.resolve(process.env.KOTOBA_RENDERER_DIR || path.join(ROOT, 'out', 'renderer'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mka': 'audio/x-matroska', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

const CSP =
  "default-src 'self' kotoba:; media-src kotoba:; img-src kotoba: data: blob:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' kotoba:; font-src 'self' data:";

function serveApp(url) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.normalize(path.join(RENDERER_DIR, rel));
  if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(RENDERER_DIR, 'index.html');
  return new Response(fs.readFileSync(file), {
    headers: { 'content-type': mimeOf(file), 'content-security-policy': CSP },
  });
}

/** Byte-range file responses; <video> seeks by issuing Range requests. */
export function serveFile(abs, request) {
  const size = fs.statSync(abs).size;
  const headers = {
    'content-type': mimeOf(abs),
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
  };
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
  if (!m) {
    return new Response(Readable.toWeb(fs.createReadStream(abs)), {
      status: 200,
      headers: { ...headers, 'content-length': String(size) },
    });
  }
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), {
    status: 206,
    headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` },
  });
}

function serveMedia(url, request) {
  const id = Number(url.pathname.replace(/^\//, ''));
  let abs;
  try {
    abs = pathOf(id);
  } catch {
    return new Response('unknown media', { status: 404 });
  }
  if (!fs.existsSync(abs)) return new Response('file missing', { status: 404 });
  return serveFile(abs, request);
}

/** kotoba://thumb/?path=<abs>[&at=<sec>]: a library frame. Only for videos under the library root or already registered. */
async function serveThumb(url) {
  try {
    const abs = checkPath(url.searchParams.get('path'));
    const file = isVideoFile(abs) && (await thumbnail(abs, Number(url.searchParams.get('at')) || 0));
    if (file) return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/jpeg' } });
  } catch {
    /* outside the library, unreadable, or a frame removed under us */
  }
  return new Response('no thumbnail', { status: 404 });
}

export function registerProtocol() {
  protocol.handle('kotoba', (request) => {
    const url = new URL(request.url);
    switch (url.host) {
      case 'app':
        return serveApp(url);
      case 'media':
        return serveMedia(url, request);
      case 'thumb':
        return serveThumb(url);
      default:
        return new Response('not found', { status: 404 });
    }
  });
}

export function registerPlaybackIpc() {
  handle('playback:plan', (id) => playbackPlan(id));
}
