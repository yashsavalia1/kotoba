// Collocation and prediction cards are built from the subtitle lines you have
// actually watched, not from a generic frequency list. Every line the player
// loads is recorded here, so the deck grows in the direction of your media.
//
// ponytail: LIKE '%word%' full scans. At personal scale (a few hundred thousand
// lines) this is milliseconds. Add FTS5 only if it ever stops being.

import { dictDb, userDb, transaction } from './db.mjs';
import { glossText } from './dict.mjs';

const BOUNDARY = /[、。！？…「」『』（）\s,.!?]/;

export function recordCues(mediaId, cues) {
  const db = userDb();
  const ins = db.prepare(
    'INSERT OR REPLACE INTO line (media_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
  );
  transaction(db, () =>
    cues.forEach((c, i) => ins.run(mediaId, i, Math.round(c.start * 1000), Math.round(c.end * 1000), c.text))
  );
}

export const corpusSize = () => userDb().prepare('SELECT count(*) AS n FROM line').get().n;

const linesContaining = (word, limit = 800) =>
  userDb()
    .prepare('SELECT text FROM line WHERE text LIKE ? LIMIT ?')
    .all(`%${word}%`, limit)
    .map((r) => r.text);

/** Every occurrence index of `word` in `text`. */
function* occurrences(text, word) {
  let i = text.indexOf(word);
  while (i !== -1) {
    yield i;
    i = text.indexOf(word, i + 1);
  }
}

/**
 * Phrases the word actually appears in. Dictionary multi-word entries first
 * (available on day one, before any corpus exists), then n-grams mined from
 * watched subtitles.
 */
export function collocations(word, limit = 8) {
  const seen = new Set([word]);

  const fromDict = [];
  for (const row of dictDb()
    .prepare(
      `SELECT DISTINCT d.id, d.kanji, d.reading, d.gloss FROM dict_form f
       JOIN dict d ON d.id = f.dict_id
       WHERE f.form LIKE ? AND f.form != ?
       ORDER BY length(f.form) ASC LIMIT ?`
    )
    .all(`%${word}%`, word, limit * 2)) {
    const form = row.kanji || row.reading;
    if (seen.has(form)) continue;
    seen.add(form);
    fromDict.push({
      phrase: form,
      note: glossText({ senses: JSON.parse(row.gloss) }, 1),
      source: 'dictionary',
    });
  }

  const counts = new Map();
  for (const text of linesContaining(word)) {
    for (const at of occurrences(text, word)) {
      for (let n = 1; n <= 4; n++) {
        const after = text.slice(at + word.length, at + word.length + n);
        if (after.length === n && ![...after].some((c) => BOUNDARY.test(c))) {
          counts.set(word + after, (counts.get(word + after) ?? 0) + 1);
        }
        const before = text.slice(Math.max(0, at - n), at);
        if (before.length === n && ![...before].some((c) => BOUNDARY.test(c))) {
          counts.set(before + word, (counts.get(before + word) ?? 0) + 1);
        }
      }
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);

  const fromCorpus = [];
  for (const [phrase, n] of ranked) {
    if (seen.has(phrase)) continue;
    // Drop a phrase that a longer, equally frequent phrase already contains.
    if (ranked.some(([other, m]) => m === n && other !== phrase && other.includes(phrase))) continue;
    seen.add(phrase);
    fromCorpus.push({ phrase, note: `${n}×`, source: 'corpus' });
  }

  // Interleaved, not concatenated: phrases mined from your own media are the
  // more valuable half, and appending them lets the dictionary crowd them out.
  const out = [];
  for (let i = 0; out.length < limit && (i < fromDict.length || i < fromCorpus.length); i++) {
    if (fromCorpus[i]) out.push(fromCorpus[i]);
    if (out.length < limit && fromDict[i]) out.push(fromDict[i]);
  }
  return out;
}

/** What tends to come after the word - the raw material for Prediction cards. */
export function continuations(word, limit = 5) {
  const counts = new Map();
  for (const text of linesContaining(word)) {
    for (const at of occurrences(text, word)) {
      let tail = text.slice(at + word.length, at + word.length + 14);
      const cut = [...tail].findIndex((c) => BOUNDARY.test(c));
      if (cut === 0) continue;
      if (cut > 0) tail = tail.slice(0, cut);
      tail = tail.trim();
      if (tail.length < 2) continue;
      counts.set(tail, (counts.get(tail) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([text, n]) => ({ text, count: n }));
}
