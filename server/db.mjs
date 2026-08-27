import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';

export const db = new DatabaseSync(path.join(config.dataDir, 'kotoba.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- One row per JMdict entry. kanji/reading are the headword pair; forms keeps
  -- every alternate kanji spelling, because JMdict groups spellings a learner
  -- treats as separate words: 保証 / 保障 / 補償 are one entry, and a
  -- minimal-pair card needs all three.
  CREATE TABLE IF NOT EXISTS dict (
    id      INTEGER PRIMARY KEY,
    kanji   TEXT NOT NULL DEFAULT '',
    reading TEXT NOT NULL DEFAULT '',
    forms   TEXT NOT NULL DEFAULT '[]',
    pos     TEXT NOT NULL DEFAULT '[]',
    gloss   TEXT NOT NULL DEFAULT '[]',
    common  INTEGER NOT NULL DEFAULT 0
  );

  -- Every written form (kanji or kana) that should resolve to an entry.
  CREATE TABLE IF NOT EXISTS dict_form (
    form    TEXT NOT NULL,
    dict_id INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dict_form ON dict_form(form);

  -- Every subtitle line the player has ever loaded. Backs collocation and
  -- prediction cards, so they are grounded in what you actually watch.
  CREATE TABLE IF NOT EXISTS line (
    media    TEXT NOT NULL,
    idx      INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms   INTEGER NOT NULL,
    text     TEXT NOT NULL,
    PRIMARY KEY (media, idx)
  ) WITHOUT ROWID;

  -- Mining history, so the UI can grey out words you already have.
  CREATE TABLE IF NOT EXISTS mined (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    word  TEXT NOT NULL,
    type  TEXT NOT NULL,
    media TEXT NOT NULL DEFAULT '',
    cue   INTEGER NOT NULL DEFAULT -1,
    at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mined_word ON mined(word);
`);

// Older databases predate the `forms` column; adding it is cheap and lets an
// existing install upgrade by re-running `npm run dict` alone.
if (!db.prepare('PRAGMA table_info(dict)').all().some((c) => c.name === 'forms')) {
  db.exec("ALTER TABLE dict ADD COLUMN forms TEXT NOT NULL DEFAULT '[]'");
}

export function dictReady() {
  return db.prepare('SELECT count(*) AS n FROM dict').get().n > 0;
}
