import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dictDb, userDb, transaction } from './db.mjs';
import { displayTitle } from './media.mjs';

/**
 * Imports state from the pre-desktop web version (data/kotoba.db): its dictionary
 * tables, and its corpus/mining history keyed by base64url(path). Runs once.
 */
export function migrateLegacy(legacyPath) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return { skipped: 'no legacy database' };
  const user = userDb();
  if (user.prepare("SELECT 1 FROM meta WHERE key = 'legacy_migrated'").get()) return { skipped: 'already migrated' };

  const legacy = new DatabaseSync(legacyPath);
  const report = { dict: 0, media: 0, lines: 0, mined: 0 };
  try {
    const dict = dictDb();
    const has = (t) => legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (has('dict') && !dict.prepare('SELECT 1 FROM dict LIMIT 1').get()) {
      transaction(dict, () => {
        const insD = dict.prepare('INSERT INTO dict (id, kanji, reading, forms, pos, gloss, common) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const r of legacy.prepare('SELECT id, kanji, reading, forms, pos, gloss, common FROM dict').iterate()) {
          insD.run(r.id, r.kanji, r.reading, r.forms ?? '[]', r.pos, r.gloss, r.common);
          report.dict++;
        }
        const insF = dict.prepare('INSERT INTO dict_form (form, dict_id) VALUES (?, ?)');
        for (const r of legacy.prepare('SELECT form, dict_id FROM dict_form').iterate()) insF.run(r.form, r.dict_id);
      });
    }

    const idFor = new Map();
    const mediaId = (legacyId) => {
      if (idFor.has(legacyId)) return idFor.get(legacyId);
      let abs;
      try {
        abs = Buffer.from(legacyId, 'base64url').toString('utf8');
      } catch {
        return null;
      }
      if (!path.isAbsolute(abs)) return null;
      user
        .prepare('INSERT OR IGNORE INTO media (path, title, added_at) VALUES (?, ?, ?)')
        .run(abs, displayTitle(abs), Date.now());
      const id = user.prepare('SELECT id FROM media WHERE path = ?').get(abs).id;
      idFor.set(legacyId, id);
      report.media++;
      return id;
    };

    transaction(user, () => {
      if (has('line')) {
        const ins = user.prepare('INSERT OR IGNORE INTO line (media_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)');
        for (const r of legacy.prepare('SELECT media, idx, start_ms, end_ms, text FROM line').iterate()) {
          const id = mediaId(r.media);
          if (id == null) continue;
          ins.run(id, r.idx, r.start_ms, r.end_ms, r.text);
          report.lines++;
        }
      }
      if (has('mined')) {
        const ins = user.prepare('INSERT INTO mined (word, type, media_id, cue, at) VALUES (?, ?, ?, ?, ?)');
        for (const r of legacy.prepare('SELECT word, type, media, cue, at FROM mined').iterate()) {
          ins.run(r.word, r.type, mediaId(r.media), r.cue, r.at);
          report.mined++;
        }
      }
      user.prepare("INSERT INTO meta (key, value) VALUES ('legacy_migrated', ?)").run(JSON.stringify(report));
    });
  } finally {
    legacy.close();
  }
  return report;
}
