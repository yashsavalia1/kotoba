import { userDb } from './db.mjs';

export const DEFAULTS = {
  deckName: 'Kotoba',
  ankiConnect: 'http://127.0.0.1:8765',
  targetLang: 'ja',
  clipPadding: 0.25,
  subtitleFontSize: 30,
  pauseOnHover: false,
  autoplayNext: true,
  resumePlayback: true,
  warnDuplicates: true,
  libraryRoot: null,
  episodeNumbers: true,
  tidyNames: true,
  continueWatching: true,
  showProgress: true,
  progressChecks: true,
  videoProgress: true,
  folderProgress: false,
};

export function getSettings() {
  const rows = userDb().prepare('SELECT key, value FROM settings').all();
  // Older databases keep rows for settings that are gone; those aren't settings any more.
  const stored = Object.fromEntries(rows.filter((r) => r.key in DEFAULTS).map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULTS, ...stored };
}

export const getSetting = (key) => getSettings()[key];

function write(patch) {
  const q = userDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) q.run(k, JSON.stringify(v));
  return getSettings();
}

export function setSettings(patch) {
  for (const k of Object.keys(patch)) {
    if (!(k in DEFAULTS)) throw new Error(`unknown setting: ${k}`);
    // The library folder is what the renderer may browse, so only the folder picker in main sets it.
    if (k === 'libraryRoot') throw new Error('Choose the media folder with the folder picker');
  }
  return write(patch);
}

export const setLibraryRoot = (dir) => write({ libraryRoot: dir });

// The decrypted Claude key is held only in memory; main decrypts it from safeStorage at startup.
let apiKey = null;
export const setApiKey = (key) => {
  apiKey = key || null;
};
export const getApiKey = () => apiKey || process.env.ANTHROPIC_API_KEY || null;
