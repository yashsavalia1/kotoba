import { db } from './db.mjs';
import { deinflect, posAllows } from './deinflect.mjs';

const MAX_SCAN = 12; // longest substring we will try to match as one word

const JP = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ々〆ヶゝゞ]/;
const KANJI = /[㐀-䶿一-鿿々]/;
const isJP = (ch) => JP.test(ch);

const COLS = 'd.id, d.kanji, d.reading, d.forms, d.pos, d.gloss, d.common';

const qForms = db.prepare(`
  SELECT ${COLS} FROM dict_form f JOIN dict d ON d.id = f.dict_id WHERE f.form = ?
`);

/** Every kanji spelling of an entry, tagged with whether that spelling is common. */
const spellingsOf = (e) =>
  (e.forms.length ? e.forms : e.kanji ? [{ t: e.kanji, c: e.common ? 1 : 0 }] : [])
    .filter((f) => KANJI.test(f.t));

const hydrate = (row) => ({
  id: row.id,
  kanji: row.kanji,
  reading: row.reading,
  headword: row.kanji || row.reading,
  forms: row.forms ? JSON.parse(row.forms) : [],
  pos: JSON.parse(row.pos),
  senses: JSON.parse(row.gloss),
  common: !!row.common,
});

/** Look up every dictionary entry reachable from `surface` by deinflection. */
export function lookup(surface) {
  const out = new Map();
  for (const { text, type } of deinflect(surface)) {
    for (const row of qForms.all(text)) {
      if (out.has(row.id)) continue;
      const e = hydrate(row);
      if (!posAllows(type, e.pos)) continue;
      e.matchedForm = text;
      e.inflected = text !== surface;
      out.set(row.id, e);
    }
  }
  return [...out.values()].sort(
    (a, b) => Number(b.common) - Number(a.common) || Number(a.inflected) - Number(b.inflected) || a.id - b.id
  );
}

/**
 * Longest-match lookup starting at `pos`. Returns null when nothing matches.
 * This is Yomitan's scan strategy - no tokeniser, so multi-word dictionary
 * entries (正直に言う) win over their parts.
 */
export function lookupAt(text, pos) {
  const limit = Math.min(MAX_SCAN, text.length - pos);
  for (let len = limit; len >= 1; len--) {
    const surface = text.slice(pos, pos + len);
    if (!isJP(surface[0])) break;
    const entries = lookup(surface);
    if (entries.length) return { surface, length: len, entries };
  }
  return null;
}

/**
 * Segment a whole subtitle line into hoverable tokens. Non-Japanese runs come
 * back as `{ text, entries: [] }` so the client can render them inert.
 */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  let plain = '';
  const flush = () => {
    if (plain) tokens.push({ text: plain, entries: [] });
    plain = '';
  };

  while (i < text.length) {
    if (!isJP(text[i])) {
      plain += text[i++];
      continue;
    }
    const hit = lookupAt(text, i);
    if (!hit) {
      plain += text[i++];
      continue;
    }
    flush();
    tokens.push({
      text: hit.surface,
      lemma: hit.entries[0].headword,
      reading: hit.entries[0].reading,
      entries: hit.entries.slice(0, 8),
    });
    i += hit.length;
  }
  flush();
  return tokens;
}

/**
 * Words that sound identical but are written differently - 保証 / 保障,
 * 感心 / 関心. Candidates come from every entry that carries the reading as a
 * kana form, then from every kanji spelling those entries list, because JMdict
 * files 保証 and 保障 under a single entry.
 *
 * Restricted to spellings of the same length that JMdict marks common: a
 * minimal pair is only worth drilling when both halves are words you will meet.
 *
 * @returns {{spelling:string, reading:string, gloss:string, id:number}[]}
 */
export function homophones(reading, excludeSpelling = '', limit = 4) {
  const len = [...excludeSpelling].length;
  const out = [];
  const seen = new Set([excludeSpelling]);

  for (const row of qForms.all(reading)) {
    const e = hydrate(row);
    if (e.reading !== reading && !e.forms.length) continue;
    for (const f of spellingsOf(e)) {
      if (seen.has(f.t) || !f.c) continue;
      if (len && [...f.t].length !== len) continue;
      seen.add(f.t);
      out.push({ spelling: f.t, reading, gloss: glossText(e, 1), id: e.id });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Words sharing a kanji character but read differently - the 素直 / 正直 and
 * 感心 / 関心 case. Results are round-robined across the target's characters so
 * a two-kanji word does not return four neighbours of its first kanji only.
 */
export function sharedKanji(kanji, excludeId, reading = '', limit = 4) {
  const chars = [...kanji].filter((c) => KANJI.test(c));
  if (!chars.length) return [];
  const len = [...kanji].length;

  const q = db.prepare(
    `SELECT DISTINCT f.form, ${COLS} FROM dict_form f JOIN dict d ON d.id = f.dict_id
     WHERE f.form LIKE ? AND length(f.form) = ? AND d.id != ? AND d.reading != ?
       AND d.common = 1
     ORDER BY d.id ASC LIMIT ?`
  );

  const buckets = chars.map((c) =>
    q
      .all(`%${c}%`, len, excludeId ?? -1, reading, limit * 3)
      .filter((r) => KANJI.test(r.form) && r.form !== kanji)
      .map((r) => ({ spelling: r.form, reading: r.reading, gloss: glossText(hydrate(r), 1), id: r.id }))
  );

  const out = [];
  const seen = new Set([kanji]);
  for (let i = 0; out.length < limit && buckets.some((b) => i < b.length); i++) {
    for (const bucket of buckets) {
      const e = bucket[i];
      if (!e || seen.has(e.spelling) || out.length >= limit) continue;
      seen.add(e.spelling);
      out.push(e);
    }
  }
  return out;
}

export const glossText = (entry, max = 3) =>
  entry.senses
    .slice(0, max)
    .map((s) => s.text.slice(0, 3).join('; '))
    .join(' / ');
