// Collocation and prediction cards are built from the subtitle lines you have
// actually watched, not from a generic frequency list. Every line the player
// loads is recorded here, so the deck grows in the direction of your media.
//
// ponytail: instr() full scans. At personal scale (a few hundred thousand
// lines) this is milliseconds. Add FTS5 only if it ever stops being.

import { dictDb, userDb, transaction } from './db.mjs';
import { glossText, lookup, lookupAt } from './dict.mjs';

const BOUNDARY = /[、。！？…‥「」『』（）()〈〉《》【】\[\]〜～—―♪♫\s,.!?]/;

const JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * Replace a media file's lines with the Japanese dialogue in `cues`. A track with none
 * (an English reference track, a signs-only track) leaves the existing lines alone.
 */
export function recordCues(mediaId, cues) {
  const lines = cues.filter((c) => (c.kind ?? 'dialogue') === 'dialogue' && JAPANESE.test(c.text));
  if (!lines.length) return 0;
  const db = userDb();
  const del = db.prepare('DELETE FROM line WHERE media_id = ?');
  const ins = db.prepare('INSERT INTO line (media_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)');
  transaction(db, () => {
    del.run(mediaId);
    lines.forEach((c, i) => ins.run(mediaId, i, Math.round(c.start * 1000), Math.round(c.end * 1000), c.text));
  });
  return lines.length;
}

export const corpusSize = () => userDb().prepare('SELECT count(*) AS n FROM line').get().n;

const linesContaining = (word, limit = 800) =>
  userDb()
    .prepare('SELECT text FROM line WHERE instr(text, ?) > 0 LIMIT ?')
    .all(word, limit)
    .map((r) => r.text);

/** Every occurrence index of `word` in `text`. */
function* occurrences(text, word) {
  let i = text.indexOf(word);
  while (i !== -1) {
    yield i;
    i = text.indexOf(word, i + 1);
  }
}

// Function words first: a dictionary longest-match over kana reads 本当にいい as 本当|にい (兄).
// ponytail: hand list of common particles/copulas; a real morphological analyser is the upgrade.
const PARTICLES = [
  'じゃない', 'でしょう', 'だろう', 'ってば', 'くらい', 'ぐらい', 'なんて', 'なんか', 'ばかり', 'だけど',
  'って', 'から', 'まで', 'より', 'ほど', 'だけ', 'しか', 'さえ', 'こそ', 'でも', 'けど', 'のに', 'ので',
  'かな', 'かも', 'だよ', 'だね', 'だな', 'だろ', 'です', 'でしょ', 'じゃ', 'には', 'では', 'とか', 'なら',
  'の', 'が', 'は', 'を', 'に', 'で', 'と', 'も', 'や', 'へ', 'か', 'だ',
].sort((a, b) => b.length - a.length);

// Phrases are cut at word boundaries so 高木さん never surfaces as 高木さ.
// Memoised per call: a few hundred lines repeat the same neighbours.
function tokenizer() {
  const after = new Map();
  const before = new Map();
  return {
    /** The dictionary word starting at `at`, or '' at punctuation / unknown text. */
    next(text, at) {
      const key = text.slice(at, at + 12);
      if (!after.has(key)) {
        const cut = [...key].findIndex((c) => BOUNDARY.test(c));
        const clean = cut === -1 ? key : key.slice(0, cut);
        after.set(key, (clean && (PARTICLES.find((p) => clean.startsWith(p)) ?? lookupAt(clean, 0)?.surface)) || '');
      }
      return after.get(key);
    },
    /** The longest dictionary word ending at `at` (max 4 chars), or ''. */
    prev(text, at) {
      const key = text.slice(Math.max(0, at - 4), at);
      if (!before.has(key)) {
        let hit = '';
        for (let n = key.length; n >= 1 && !hit; n--) {
          const s = key.slice(-n);
          if (![...s].some((c) => BOUNDARY.test(c)) && lookup(s).length) hit = s;
        }
        before.set(key, hit);
      }
      return before.get(key);
    },
  };
}

/**
 * Phrases the word actually appears in. Dictionary multi-word entries first
 * (available on day one, before any corpus exists), then phrases mined from
 * watched subtitles: the word plus one or two neighbouring dictionary words.
 */
export function collocations(word, limit = 8) {
  const seen = new Set([word]);

  const fromDict = [];
  for (const row of dictDb()
    .prepare(
      `SELECT DISTINCT d.id, d.kanji, d.reading, d.gloss, d.common FROM dict_form f
       JOIN dict d ON d.id = f.dict_id
       WHERE instr(f.form, ?) > 0 AND f.form != ?
       ORDER BY d.common DESC, length(f.form) ASC LIMIT ?`
    )
    .all(word, word, limit * 4)) {
    const form = row.kanji || row.reading;
    // 日本当帰 contains 本当 but is not a phrase built on it.
    if (seen.has(form) || !(form.startsWith(word) || form.endsWith(word))) continue;
    seen.add(form);
    fromDict.push({
      phrase: form,
      note: glossText({ senses: JSON.parse(row.gloss) }, 1),
      source: 'dictionary',
    });
  }

  const counts = new Map();
  const bump = (p) => counts.set(p, (counts.get(p) ?? 0) + 1);
  const tok = tokenizer();
  for (const text of linesContaining(word)) {
    for (const at of occurrences(text, word)) {
      const end = at + word.length;
      const t1 = tok.next(text, end);
      if (t1) {
        bump(word + t1);
        const t2 = tok.next(text, end + t1.length);
        if (t2) bump(word + t1 + t2);
      }
      const p = tok.prev(text, at);
      // A lone particle before the word (の勝負) is not a collocation.
      if (p && !/^[\u3040-\u309f]$/.test(p)) bump(p + word);
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
  const tok = tokenizer();
  for (const text of linesContaining(word)) {
    for (const at of occurrences(text, word)) {
      const end = at + word.length;
      let tail = text.slice(end);
      const cut = [...tail].findIndex((c) => BOUNDARY.test(c));
      if (cut !== -1) tail = tail.slice(0, cut);
      // Short clauses (に言うと) are kept whole; long ones are cut to two words at a word boundary.
      if (tail.length > 6) {
        const t1 = tok.next(text, end);
        tail = t1 + tok.next(text, end + t1.length);
      }
      if (tail.length < 2) continue;
      counts.set(tail, (counts.get(tail) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([text, n]) => ({ text, count: n }));
}
