import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

// Packaged, electron-builder unpacks ffmpeg-static next to the asar and copies the native arm64
// ffprobe (build/fetch-ffprobe.mjs) to Resources/bin. Dev and tests use the same two repo copies.
const PACKAGED = ROOT.includes('app.asar');
const BINARIES = {
  ffmpeg: path.join(ROOT.replace('app.asar', 'app.asar.unpacked'), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ffprobe: PACKAGED ? path.join(process.resourcesPath, 'bin', 'ffprobe') : path.join(ROOT, 'build', 'ffprobe-darwin-arm64', 'ffprobe'),
};

function bundled(name) {
  const bin = BINARIES[name];
  if (fs.existsSync(bin)) return bin;
  throw new Error(`${name} is missing from ${bin}` + (PACKAGED ? '' : ' (npm install; node build/fetch-ffprobe.mjs)'));
}

export const ffmpeg = () => bundled('ffmpeg');
export const ffprobe = () => bundled('ffprobe');
