import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './paths.mjs';

const DICT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS dict (
    id      INTEGER PRIMARY KEY,
    kanji   TEXT NOT NULL DEFAULT '',
    reading TEXT NOT NULL DEFAULT '',
    forms   TEXT NOT NULL DEFAULT '[]',
    pos     TEXT NOT NULL DEFAULT '[]',
    gloss   TEXT NOT NULL DEFAULT '[]',
    common  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dict_form (
    form    TEXT NOT NULL,
    dict_id INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dict_form ON dict_form(form);
`;

const USER_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Every file the user has opened. Files are never copied or moved; path is the identity.
  CREATE TABLE IF NOT EXISTS media (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT NOT NULL UNIQUE,
    title          TEXT NOT NULL,
    size           INTEGER,
    mtime          REAL,
    duration       REAL,
    added_at       INTEGER NOT NULL,
    last_opened_at INTEGER,
    position       REAL NOT NULL DEFAULT 0,
    prefs          TEXT NOT NULL DEFAULT '{}',
    watched        INTEGER NOT NULL DEFAULT 0,
    played_at      INTEGER  -- last saved sitting; Continue watching, newest first
  );

  -- Subtitle files the user attached by hand (Add Subtitle File…, drag-drop).
  CREATE TABLE IF NOT EXISTS media_sub (
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    path     TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (media_id, path)
  );

  -- Every subtitle line ever loaded; backs collocation and prediction cards.
  CREATE TABLE IF NOT EXISTS line (
    media_id INTEGER NOT NULL,
    idx      INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms   INTEGER NOT NULL,
    text     TEXT NOT NULL,
    PRIMARY KEY (media_id, idx)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS mined (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    word     TEXT NOT NULL,
    type     TEXT NOT NULL,
    media_id INTEGER,
    cue      INTEGER NOT NULL DEFAULT -1,
    at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mined_word ON mined(word);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

let dict = null;
let user = null;

/** Read-mostly JMdict database. Built by `npm run dict`; shipped read-only in the packaged app. */
export function dictDb() {
  if (!dict && paths.dictReadOnly) {
    dict = new DatabaseSync(paths.dictDbPath, { readOnly: true });
  } else if (!dict) {
    fs.mkdirSync(path.dirname(paths.dictDbPath), { recursive: true });
    dict = new DatabaseSync(paths.dictDbPath);
    dict.exec(DICT_SCHEMA);
  }
  return dict;
}

/** Library, corpus, mining history and settings. Lives in the per-user data directory. */
export function userDb() {
  if (!user) {
    user = new DatabaseSync(path.join(paths.userDataDir, 'user.db'));
    user.exec(USER_SCHEMA);
    migrateUser(user);
  }
  return user;
}

/** Databases from before the library model get the watched flag and Continue watching, from what they had. */
function migrateUser(db) {
  if (db.prepare('PRAGMA table_info(media)').all().some((c) => c.name === 'watched')) return;
  transaction(db, () =>
    db.exec(`
      ALTER TABLE media ADD COLUMN watched INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE media ADD COLUMN played_at INTEGER;
      UPDATE media SET watched = 1, position = 0
        WHERE position > 0 AND duration > 0 AND duration - position < min(max(duration / 10, 30), 300);
      UPDATE media SET played_at = last_opened_at WHERE position > 0;
    `)
  );
}

export function dictReady() {
  try {
    return dictDb().prepare('SELECT 1 FROM dict LIMIT 1').get() !== undefined;
  } catch {
    return false;
  }
}

/** Tests and the dictionary builder need to drop handles before swapping files underneath. */
export function closeDatabases() {
  dict?.close();
  user?.close();
  dict = null;
  user = null;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
