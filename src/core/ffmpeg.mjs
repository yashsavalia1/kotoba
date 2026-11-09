import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getSetting } from './settings.mjs';
import { ROOT } from './paths.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// Inside a packaged app the binaries are unpacked next to the asar, not inside it.
const unpacked = (p) => p?.replace('app.asar/', 'app.asar.unpacked/');

function npmBinary(name) {
  try {
    return unpacked(name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path);
  } catch {
    return null;
  }
}

const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64' };

/** CPU arch of a thin Mach-O binary; null for anything else (fat, ELF, PE, unreadable). */
export function machoArch(bin) {
  try {
    const fd = fs.openSync(bin, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return buf.readUInt32LE(0) === 0xfeedfacf ? (MACHO_CPU[buf.readUInt32LE(4)] ?? 'other') : null;
  } catch {
    return null;
  }
}

// Packaged: Resources/bin/<name> (extraResources). Dev: build/<name>-<platform>-<arch>/<name>.
// ffprobe-static ships an x86_64 binary as darwin/arm64, so a native one is preferred over it.
function bundled(name) {
  const dirs = [
    process.resourcesPath && path.join(process.resourcesPath, 'bin', name),
    path.join(ROOT, 'build', `${name}-${process.platform}-${process.arch}`, name),
  ];
  const all = [...dirs, npmBinary(name)].filter((c) => c && fs.existsSync(c));
  const foreign = (c) => ![null, process.arch].includes(machoArch(c));
  return { native: all.filter((c) => !foreign(c)), foreign: all.filter(foreign) };
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
  const { native, foreign } = bundled(name);
  // Foreign-arch binaries (Rosetta) only as a last resort; works() drops any that cannot exec.
  const candidates = [override, process.env[name.toUpperCase()], ...native, name, ...foreign].filter(Boolean);
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
