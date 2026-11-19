// Native arm64 ffprobe from the same ffmpeg-static release (b6.1.1) as the bundled ffmpeg, whose
// npm package ships no ffprobe. Verified against GitHub's published sha256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-arm64.gz';
const GZ_SHA256 = 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be';
const BIN_SHA256 = 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ffprobe-darwin-arm64', 'ffprobe');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(out) && sha(fs.readFileSync(out)) === BIN_SHA256) process.exit(0);

const res = await fetch(URL_);
if (!res.ok) throw new Error(`${URL_}: HTTP ${res.status}`);
const gz = Buffer.from(await res.arrayBuffer());
if (sha(gz) !== GZ_SHA256) throw new Error('ffprobe download: sha256 mismatch');
const bin = zlib.gunzipSync(gz);
if (sha(bin) !== BIN_SHA256) throw new Error('ffprobe binary: sha256 mismatch');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bin, { mode: 0o755 });
console.log(`fetched ${path.relative(process.cwd(), out)}`);
