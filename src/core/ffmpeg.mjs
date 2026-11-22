import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

// Packaged, electron-builder unpacks ffmpeg-static next to the asar and copies this platform's
// ffprobe (build/fetch-ffprobe.mjs) to Resources/bin. Dev and tests use the same two repo copies.
const PACKAGED = ROOT.includes('app.asar');
const EXE = process.platform === 'win32' ? '.exe' : '';
const BINARIES = {
  ffmpeg: path.join(ROOT.replace('app.asar', 'app.asar.unpacked'), 'node_modules', 'ffmpeg-static', `ffmpeg${EXE}`),
  ffprobe: PACKAGED
    ? path.join(process.resourcesPath, 'bin', `ffprobe${EXE}`)
    : path.join(ROOT, 'build', `ffprobe-${process.platform}-${process.arch}`, `ffprobe${EXE}`),
};

function bundled(name) {
  const bin = BINARIES[name];
  if (fs.existsSync(bin)) return bin;
  throw new Error(`${name} is missing from ${bin}` + (PACKAGED ? '' : ' (npm install; node build/fetch-ffprobe.mjs)'));
}

export const ffmpeg = () => bundled('ffmpeg');
export const ffprobe = () => bundled('ffprobe');
