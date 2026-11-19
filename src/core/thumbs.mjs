import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from './paths.mjs';
import { ffmpeg } from './ffmpeg.mjs';
import { probe } from './media.mjs';

// Library thumbnails: one ffmpeg frame per video, 480 px wide, kept as JPEGs under userData.
// ponytail: never pruned; frames of replaced files stay until a cache sweep is worth writing.

const run = promisify(execFile);
const JOBS = 2;
// A Continue watching frame is taken again once you are more than this many seconds past it.
const CLOSE = 30;
const dir = () => path.join(paths.userDataDir, 'thumbs');
const inflight = new Map();
const failed = new Set();
const waiting = [];
let active = 0;

async function queued(fn) {
  if (active < JOBS) active++;
  else await new Promise((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next job, so a new caller can't slip in past the limit.
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// A replaced or re-encoded file gets a new name, so a new frame.
function keyOf(abs) {
  const st = fs.statSync(abs);
  return crypto.createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}`).digest('hex');
}

/** Writes the frame `at` seconds into `abs` to `file`; false if there is none (and it isn't tried again this run). */
function grab(abs, file, at) {
  if (failed.has(file)) return Promise.resolve(false);
  if (!inflight.has(file)) {
    const job = queued(async () => {
      const tmp = path.join(dir(), 'tmp', `${crypto.randomUUID()}.jpg`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      try {
        await run(ffmpeg(), [
          '-v', 'error', '-y', '-ss', String(Math.max(0, at)), '-i', abs,
          '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', tmp,
        ], { timeout: 30_000 });
        fs.renameSync(tmp, file);
        return true;
      } catch {
        fs.rmSync(tmp, { force: true });
        failed.add(file);
        return false;
      }
    }).finally(() => inflight.delete(file));
    inflight.set(file, job);
  }
  return inflight.get(file);
}

const atOf = (file) => Number(path.basename(file, '.jpg').split('@')[1]) || 0;

async function leftOff(abs, key, at) {
  const taken = fs.existsSync(dir()) ? fs.readdirSync(dir()).filter((n) => n.startsWith(`${key}@`)).map((n) => path.join(dir(), n)) : [];
  const near = taken.find((f) => Math.abs(atOf(f) - at) <= CLOSE);
  if (near) return near;
  const file = path.join(dir(), `${key}@${Math.floor(at)}.jpg`);
  if (!(await grab(abs, file, at))) return thumbnail(abs);
  // The old frame stays until the new one is there.
  for (const f of taken) fs.rmSync(f, { force: true });
  return file;
}

/**
 * A JPEG of `abs`: its own frame, a fifth of the way in, kept as it is from then on; or with `at`,
 * the frame where it was left, for Continue watching. Null when no frame can be had.
 */
export async function thumbnail(abs, at = 0) {
  const key = keyOf(abs);
  if (at > 0) return leftOff(abs, key, at);
  const file = path.join(dir(), `${key}.jpg`);
  if (fs.existsSync(file)) return file;
  const duration = Number((await probe(abs)).format?.duration) || 0;
  return (await grab(abs, file, duration * 0.2)) ? file : null;
}
