// Native ffprobe for this platform from the same ffmpeg-static release (b6.1.1) as the bundled
// ffmpeg, whose npm package ships no ffprobe. Checked against GitHub's published sha256.
//   node build/fetch-ffprobe.mjs   ->  build/ffprobe-<platform>-<arch>/ffprobe[.exe]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
// [sha256 of the .gz download, sha256 of the binary inside it]
const SHA256 = {
  'darwin-arm64': ['d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be', 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64'],
  'darwin-x64': ['d4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186', 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0'],
  'linux-x64': ['25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067', '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d'],
  'linux-arm64': ['2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8', 'd17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8'],
  'win32-x64': ['f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d', '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4'],
};

const target = `${process.platform}-${process.arch}`;
if (!SHA256[target]) throw new Error(`no ffprobe build for ${target}`);
const [GZ_SHA256, BIN_SHA256] = SHA256[target];
const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), `ffprobe-${target}`, exe);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(out) && sha(fs.readFileSync(out)) === BIN_SHA256) process.exit(0);

const url = `${RELEASE}/ffprobe-${target}.gz`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const gz = Buffer.from(await res.arrayBuffer());
if (sha(gz) !== GZ_SHA256) throw new Error('ffprobe download: sha256 mismatch');
const bin = zlib.gunzipSync(gz);
if (sha(bin) !== BIN_SHA256) throw new Error('ffprobe binary: sha256 mismatch');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bin, { mode: 0o755 });
console.log(`fetched ${path.relative(process.cwd(), out)}`);
