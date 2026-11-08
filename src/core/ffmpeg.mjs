import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getSetting } from './settings.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// Inside a packaged app the binaries are unpacked next to the asar, not inside it.
const unpacked = (p) => p?.replace('app.asar/', 'app.asar.unpacked/');

function bundled(name) {
  try {
    return unpacked(name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path);
  } catch {
    return null;
  }
}

function works(bin) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const resolved = new Map();

function resolveBinary(name) {
  const override = getSetting(`${name}Path`);
  const key = `${name}:${override}`;
  if (resolved.has(key)) return resolved.get(key);
  const candidates = [override, process.env[name.toUpperCase()], bundled(name), name].filter(Boolean);
  const found = candidates.find((c) => (c === name || fs.existsSync(c)) && works(c)) ?? null;
  resolved.set(key, found);
  return found;
}

export const ffmpegPath = () => resolveBinary('ffmpeg');
export const ffprobePath = () => resolveBinary('ffprobe');
export const ffmpegAvailable = () => Boolean(ffmpegPath() && ffprobePath());

let caps = null;
/** Encoders and hardware acceleration the resolved ffmpeg actually supports. */
export async function capabilities() {
  if (caps) return caps;
  const { stdout } = await run(ffmpegPath(), ['-hide_banner', '-encoders'], { maxBuffer: 4 << 20 });
  const encoders = new Set([...stdout.matchAll(/^\s[VAS][.A-Z]{5}\s+(\S+)/gm)].map((m) => m[1]));
  caps = { encoders };
  return caps;
}

export function resetFfmpegResolution() {
  resolved.clear();
  caps = null;
}
