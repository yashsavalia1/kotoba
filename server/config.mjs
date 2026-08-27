import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_PATH = path.join(ROOT, 'kotoba.config.json');

const DEFAULTS = {
  mediaDirs: [path.join(os.homedir(), 'Media')],
  dataDir: path.join(ROOT, 'data'),
  cacheDir: path.join(ROOT, 'cache'),
  port: 5174,
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  ffprobe: process.env.FFPROBE || 'ffprobe',
  ankiConnect: 'http://127.0.0.1:8765',
  deckName: 'Kotoba',
  targetLang: 'ja',
  // Trailing/leading padding on mined audio + video clips, in seconds.
  clipPadding: 0.25,
};

function load() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    console.log(`[kotoba] wrote default config to ${CONFIG_PATH} - set mediaDirs and restart`);
  }
  const cfg = { ...DEFAULTS, ...user };
  // Relative paths in the config file are relative to the project, not to
  // whatever directory the server happened to be launched from.
  cfg.mediaDirs = cfg.mediaDirs.map((d) => path.resolve(ROOT, d));
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.cacheDir = path.resolve(ROOT, cfg.cacheDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  return cfg;
}

export const config = load();
