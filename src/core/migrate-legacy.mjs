import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dictDb, userDb, transaction } from './db.mjs';
import { paths } from './paths.mjs';
import { displayTitle } from './media.mjs';

/**
 * Imports state from the pre-desktop web version (data/kotoba.db): its dictionary
 * tables, and its corpus/mining history keyed by base64url(path). Runs once.
 */
export function migrateLegacy(legacyPath) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return { skipped: 'no legacy database' };
  const user = userDb();
  if (user.prepare("SELECT 1 FROM meta WHERE key = 'legacy_migrated'").get()) return { skipped: 'already migrated' };

  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  const report = { dict: 0, media: 0, lines: 0, mined: 0 };
  try {
    const has = (t) => legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const cols = (t) => new Set(legacy.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    // Dictionary import is best-effort: a read-only or already-built dict.db must not block the user data.
    try {
      const dict = paths.dictReadOnly ? null : dictDb();
      if (dict && has('dict') && !dict.prepare('SELECT 1 FROM dict LIMIT 1').get()) {
        const forms = cols('dict').has('forms') ? 'forms' : "'[]' AS forms";
        transaction(dict, () => {
          const insD = dict.prepare('INSERT INTO dict (id, kanji, reading, forms, pos, gloss, common) VALUES (?, ?, ?, ?, ?, ?, ?)');
          for (const r of legacy.prepare(`SELECT id, kanji, reading, ${forms}, pos, gloss, common FROM dict`).iterate()) {
            insD.run(r.id, r.kanji, r.reading, r.forms ?? '[]', r.pos, r.gloss, r.common);
            report.dict++;
          }
          if (has('dict_form')) {
            const insF = dict.prepare('INSERT INTO dict_form (form, dict_id) VALUES (?, ?)');
            for (const r of legacy.prepare('SELECT form, dict_id FROM dict_form').iterate()) insF.run(r.form, r.dict_id);
          }
        });
      }
    } catch (e) {
      report.dict = 0;
      report.dictError = e.message;
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
      // Files still on disk join the history; missing ones stay hidden until relinked by basename.
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch {
        /* moved or deleted */
      }
      user
        .prepare('INSERT OR IGNORE INTO media (path, title, size, mtime, added_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(abs, displayTitle(abs), st?.size ?? null, st?.mtimeMs ?? null, Date.now(), st ? Date.now() : null);
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
        const media = cols('mined').has('media') ? 'media' : "'' AS media";
        for (const r of legacy.prepare(`SELECT word, type, ${media}, cue, at FROM mined`).iterate()) {
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
