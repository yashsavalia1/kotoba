import { userDb } from './db.mjs';

export const DEFAULTS = {
  deckName: 'Kotoba',
  ankiConnect: 'http://127.0.0.1:8765',
  targetLang: 'ja',
  clipPadding: 0.25,
  ffmpegPath: '',
  ffprobePath: '',
  subtitleFontSize: 30,
  pauseOnHover: false,
  autoplayNext: true,
  resumePlayback: true,
};

export function getSettings() {
  const rows = userDb().prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULTS, ...stored };
}

export const getSetting = (key) => getSettings()[key];

export function setSettings(patch) {
  const q = userDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) throw new Error(`unknown setting: ${k}`);
    q.run(k, JSON.stringify(v));
  }
  return getSettings();
}

// The decrypted Claude key is held only in memory; main decrypts it from safeStorage at startup.
let apiKey = null;
export const setApiKey = (key) => {
  apiKey = key || null;
};
export const getApiKey = () => apiKey || process.env.ANTHROPIC_API_KEY || null;
