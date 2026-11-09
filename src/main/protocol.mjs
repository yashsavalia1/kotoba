import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { app, protocol } from 'electron';
import { ROOT } from '../core/paths.mjs';
import { pathOf } from '../core/library.mjs';
import { playbackPlan, streamArgs, TS_OFFSET } from '../core/playback.mjs';
import { ffmpegPath } from '../core/ffmpeg.mjs';
import { handle } from './ipc-util.mjs';

const RENDERER_DIR = path.resolve(process.env.KOTOBA_RENDERER_DIR || path.join(ROOT, 'out', 'renderer'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mka': 'audio/x-matroska', '.ogv': 'video/ogg', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

const CSP =
  "default-src 'self' kotoba:; media-src kotoba: blob:; img-src kotoba: data: blob:; " +
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

const streams = new Set();

/** kotoba://stream/<id>?start=<sec>&audio=<stream index>: ffmpeg fragmented MP4, killed when the reader cancels. */
async function serveStream(url) {
  const id = Number(url.pathname.replace(/^\//, ''));
  const start = Number(url.searchParams.get('start') ?? 0);
  const audio = url.searchParams.get('audio');
  if (!Number.isInteger(id) || !(start >= 0) || (audio && !/^\d+$/.test(audio))) return new Response('bad request', { status: 400 });
  let args;
  try {
    args = await streamArgs(id, { start, audio: audio ? Number(audio) : null });
  } catch {
    return new Response('unknown media', { status: 404 });
  }
  const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  streams.add(proc);
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  proc.on('close', (code, signal) => {
    streams.delete(proc);
    if (code && !signal) console.error(`ffmpeg stream ${id}@${start} exited ${code}: ${stderr.trim()}`);
  });
  const body = Readable.toWeb(proc.stdout);
  const kill = () => proc.exitCode === null && proc.kill('SIGKILL');
  const reader = body.getReader();
  return new Response(
    new ReadableStream({
      pull: async (c) => {
        const { value, done } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      },
      cancel: kill,
    }),
    {
      headers: {
        'content-type': 'video/mp4',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-ts-offset',
        'cache-control': 'no-store',
        'x-ts-offset': String(TS_OFFSET),
      },
    }
  );
}

export function registerProtocol() {
  app.on('will-quit', () => streams.forEach((p) => p.kill('SIGKILL')));
  protocol.handle('kotoba', (request) => {
    const url = new URL(request.url);
    switch (url.host) {
      case 'app':
        return serveApp(url);
      case 'media':
        return serveMedia(url, request);
      case 'stream':
        return serveStream(url);
      default:
        return new Response('not found', { status: 404 });
    }
  });
}

export function registerPlaybackIpc() {
  handle('playback:plan', (id) => playbackPlan(id));
}
