import { dictDb } from './db.mjs';
import { deinflect, posAllows } from './deinflect.mjs';

const MAX_SCAN = 12; // longest substring we will try to match as one word

const JP = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ々〆ヶゝゞ]/;
const KANJI = /[㐀-䶿一-鿿々]/;
const isJP = (ch) => JP.test(ch);

const COLS = 'd.id, d.kanji, d.reading, d.forms, d.pos, d.gloss, d.common';

const stmts = new WeakMap();
const stmt = (sql) => {
  const db = dictDb();
  if (!stmts.has(db)) stmts.set(db, new Map());
  const cache = stmts.get(db);
  if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
  return cache.get(sql);
};
const qFormsSql = `SELECT f.form, ${COLS} FROM dict_form f JOIN dict d ON d.id = f.dict_id WHERE f.form = ?`;
const qForms = { all: (form) => stmt(qFormsSql).all(form) };
const qFormsIn = (forms) =>
  stmt(`SELECT f.form, ${COLS} FROM dict_form f JOIN dict d ON d.id = f.dict_id
        WHERE f.form IN (SELECT value FROM json_each(?))`).all(JSON.stringify(forms));
const anyFormIn = (forms) =>
  !!stmt('SELECT 1 AS x FROM dict_form WHERE form IN (SELECT value FROM json_each(?)) LIMIT 1').get(JSON.stringify(forms));

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

// ------------------------------------------------------------ casual spellings

const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const VOWEL = {};
for (const [v, row] of [
  ['あ', 'あかさたなはまやらわがざだばぱぁゃゎ'], ['い', 'いきしちにひみりぎじぢびぴぃ'],
  ['う', 'うくすつぬふむゆるぐずづぶぷぅゅ'], ['え', 'えけせてねへめれげぜでべぺぇ'],
  ['お', 'おこそとのほもよろをごぞどぼぽぉょ'],
]) for (const c of row) VOWEL[c] = v;
// ー after an e/o-row kana is usually spelled い/う: せんせー 先生, そーなんだ そう.
const LONG = { あ: 'あ', い: 'い', う: 'う', え: 'い', お: 'う' };
const SMALL = { ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お' };
const VOICED = { か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご', さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ', た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど', は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ' };
const stretch = (s, map) => s.replace(/([ぁ-ゖ])ー/g, (_, c) => c + (map[VOWEL[c]] ?? ''));

/**
 * Spellings to try when the surface itself is not a word, most literal first:
 * katakana for emphasis (スゴい), elongation (すげー, かわいーー, う〜ん), small
 * vowels (ねぇ), repeat marks (いすゞ) and a trailing glottal stop (えいっ).
 * `intOnly` variants may only resolve to interjections.
 */
function variants(surface) {
  const out = [{ text: surface }];
  const seen = new Set([surface]);
  const add = (text, intOnly = false) => {
    if (text && !seen.has(text)) seen.add(text), out.push({ text, intOnly });
  };
  if (/^[ァ-ヶ]/.test(surface) && surface.length > 1) add(toHira(surface));
  if (/[ゝゞ々]/.test(surface)) {
    add(surface.replace(/(.)ゝ/g, '$1$1').replace(/(.)ゞ/g, (_, c) => c + (VOICED[c] ?? c)).replace(/(.)々/g, '$1$1'));
  }
  {
    const t = surface.replace(/ー+/g, 'ー').replace(/[ぁぃぅぇぉ]/g, (c) => SMALL[c]);
    add(t);
    if (/[ぁ-ゖ]ー/.test(t)) {
      add(stretch(t, LONG));
      add(stretch(t, { あ: 'あ', い: 'い', う: 'う', え: 'え', お: 'お' }));
      add(t.replace(/([ぁ-ゖ])ー/g, '$1'));
    }
  }
  if (surface.length > 1 && /[っッ]$/.test(surface)) add(surface.slice(0, -1), true);
  return out;
}

const UK = (e) => e.senses.some((s) => s.misc?.includes('uk'));
// A kana surface matched against a kanji word that is not usually written in
// kana is the weaker reading: は is the particle before it is 羽, が before 蛾.
const kanaPenalty = (e) => (e.kanji && !KANJI.test(e.matchedForm) && !UK(e) ? 1 : 0);

/** Dictionary words reachable from `surface` by deinflection or a casual-spelling variant. */
function words(surface) {
  for (const v of variants(surface)) {
    const cands = deinflect(v.text);
    const byForm = new Map();
    for (const row of qFormsIn(cands.map((c) => c.text))) {
      if (!byForm.has(row.form)) byForm.set(row.form, []);
      byForm.get(row.form).push(row);
    }
    if (!byForm.size) continue;
    const out = new Map();
    for (const { text, type } of cands) {
      for (const row of byForm.get(text) ?? []) {
        if (out.has(row.id)) continue;
        const e = hydrate(row);
        if (!posAllows(type, e.pos)) continue;
        if (v.intOnly && !e.pos.includes('int')) continue;
        e.matchedForm = text;
        e.inflected = text !== surface;
        out.set(row.id, e);
      }
    }
    if (out.size) {
      return [...out.values()].sort(
        (a, b) =>
          Number(b.common) - Number(a.common) ||
          kanaPenalty(a) - kanaPenalty(b) ||
          Number(a.inflected) - Number(b.inflected) ||
          a.id - b.id
      );
    }
  }
  return [];
}

// ---------------------------------------------------------------------- names

const NAME_ORDER = ['surname', 'fem', 'masc', 'given', 'person', 'place'];
const hasNames = new WeakMap();
const namesReady = () => {
  const db = dictDb();
  if (!hasNames.has(db)) {
    hasNames.set(db, !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'name_form'").get());
  }
  return hasNames.get(db);
};
// Names are matched as written, never deinflected, and only when spelled with
// kanji or katakana: a hiragana run is far likelier to be grammar than a name.
const nameable = (s) => KANJI.test(s) || /^[ァ-ヺー]+$/.test(s);

const hydrateName = (row, surface) => {
  const types = row.types.split(',').sort((a, b) => NAME_ORDER.indexOf(a) - NAME_ORDER.indexOf(b));
  return {
    id: row.id,
    kanji: row.kanji,
    reading: row.reading,
    headword: row.kanji || row.reading,
    forms: [],
    pos: types,
    senses: [{ pos: types, misc: [], text: JSON.parse(row.gloss) }],
    common: false,
    name: true,
    nameType: types[0],
    matchedForm: surface,
    inflected: false,
  };
};

/** JMnedict person and place names spelled exactly `surface`, likeliest reading first. */
function names(surface) {
  if (surface.length < 2 || !nameable(surface) || !namesReady()) return [];
  return stmt(
    `SELECT n.* FROM name_form f JOIN name n ON n.id = f.name_id WHERE f.form = ? ORDER BY n.rank DESC, n.id`
  )
    .all(surface)
    .map((r) => hydrateName(r, surface));
}

/** Length of the longest name starting at `pos`, or 0. One query for every prefix. */
function longestName(text, pos, limit) {
  if (!namesReady() || !(KANJI.test(text[pos]) || /[ァ-ヺ]/.test(text[pos]))) return 0;
  const prefixes = [];
  for (let len = 2; len <= limit; len++) {
    const p = text.slice(pos, pos + len);
    if (!isJP(p.at(-1)) && p.at(-1) !== 'ー') break;
    if (nameable(p)) prefixes.push(p);
  }
  if (!prefixes.length) return 0;
  const row = stmt(
    'SELECT max(length(form)) AS n FROM name_form WHERE form IN (SELECT value FROM json_each(?))'
  ).get(JSON.stringify(prefixes));
  return row?.n ?? 0;
}

/** Does an exact dictionary word start inside text[pos, pos+n) and run past its end? (今日子|供) */
function crossesWord(text, pos, n) {
  const spans = [];
  for (let j = pos + 1; j < pos + n; j++) {
    for (let e = pos + n + 1; e <= Math.min(text.length, j + MAX_SCAN); e++) spans.push(text.slice(j, e));
  }
  return spans.length > 0 && anyFormIn(spans);
}

// ------------------------------------------------------------------- lookups

/** Look up every entry reachable from `surface`: dictionary words first, then names. */
export function lookup(surface) {
  return [...words(surface), ...names(surface)];
}

const TAIL_PARTICLES = new Set([...'はがをにでともへかよねやな']);
const NOUNS = new Set(['n', 'n-adv', 'n-t', 'pn']);

/**
 * 今日は is listed as the greeting こんにちは, but in running text it is far more
 * often 今日 + は. A match that is only a set phrase or interjection ending in a
 * particle yields to a common noun + that particle.
 */
function splitTrailingParticle(hit) {
  if (hit.length < 2 || !TAIL_PARTICLES.has(hit.surface.at(-1))) return null;
  const top = hit.entries[0];
  if (top.inflected || !top.pos.every((p) => p === 'exp' || p === 'int')) return null;
  const head = hit.surface.slice(0, -1);
  const entries = words(head);
  const h = entries[0];
  if (!h || h.inflected || !h.common || !h.pos.some((p) => NOUNS.has(p))) return null;
  return { surface: head, length: hit.length - 1, entries };
}

/**
 * A hiragana match that is only kanji words spelled in kana (はそん 破損, ことし
 * 今年) yields when cutting it after a particle or a common word lets the next
 * word reach further: 大人は|そんな, こと|しない. On a tie it yields only to a
 * particle before an uncommon match (が|いい for 害意, not は|なし for 話).
 */
function splitKanaSpelling(text, pos, hit) {
  if (hit.length < 2 || !/^[ぁ-ゖー]+$/.test(hit.surface) || !hit.entries.every(kanaPenalty)) return null;
  const common = hit.entries.some((e) => e.common);
  let best = null;
  for (let k = hit.length - 1; k >= 1; k--) {
    const head = words(hit.surface.slice(0, k));
    const h = head[0];
    if (!h || kanaPenalty(h)) continue;
    const prt = h.pos.includes('prt');
    if (!prt && !(k > 1 && h.common && !h.inflected)) continue;
    const next = lookupAt(text, pos + k);
    if (!next) continue;
    const reach = k + next.length;
    const ok = reach > hit.length || (reach === hit.length && prt && !common && next.length > 1 && !kanaPenalty(next.entries[0]));
    if (ok && (!best || reach > best.reach || (reach === best.reach && prt && !best.prt))) {
      best = { reach, prt, hit: { surface: hit.surface.slice(0, k), length: k, entries: head } };
    }
  }
  return best?.hit ?? null;
}

/** An uncommon particle+kanji entry (は行) yields to the particle when the word after it reaches further: 西片|は|行かない. */
function splitLeadingParticle(text, pos, hit) {
  if (hit.length < 2 || !TAIL_PARTICLES.has(hit.surface[0]) || !KANJI.test(hit.surface[1])) return null;
  if (hit.entries.some((e) => e.common)) return null;
  const next = lookupAt(text, pos + 1);
  if (!next || 1 + next.length <= hit.length) return null;
  const entries = words(hit.surface[0]);
  return entries.length ? { surface: hit.surface[0], length: 1, entries } : null;
}

function longestWord(text, pos, limit) {
  for (let len = limit; len >= 1; len--) {
    const surface = text.slice(pos, pos + len);
    const entries = words(surface);
    if (!entries.length) continue;
    // 安心で|しょ and じゃないで|しょ: never take the で/だ that opens でしょ/だろう.
    if (len > 1 && /^(でしょ|だろ)/.test(text.slice(pos + len - 1))) continue;
    return { surface, length: len, entries };
  }
  return null;
}

// tokenize() asks for the same positions again while weighing splits.
const memo = { text: null, hits: new Map() };

/**
 * Longest-match lookup starting at `pos`. Returns null when nothing matches.
 * This is Yomitan's scan strategy - no tokeniser, so multi-word dictionary
 * entries (正直に言う) win over their parts. A name wins only where it is longer
 * than any dictionary word (西片, not 西 + 片) and does not cut a word in half.
 */
export function lookupAt(text, pos) {
  if (memo.text !== text) (memo.text = text), memo.hits.clear();
  if (!memo.hits.has(pos)) memo.hits.set(pos, scanAt(text, pos));
  const hit = memo.hits.get(pos);
  return hit && { ...hit, entries: [...hit.entries] };
}

function scanAt(text, pos) {
  const limit = Math.min(MAX_SCAN, text.length - pos);
  if (limit < 1 || !isJP(text[pos])) return null;
  let hit = longestWord(text, pos, limit);
  if (hit) hit = splitTrailingParticle(hit) ?? splitKanaSpelling(text, pos, hit) ?? splitLeadingParticle(text, pos, hit) ?? hit;

  const n = longestName(text, pos, limit);
  if (n > (hit?.length ?? 0) && !crossesWord(text, pos, n)) {
    const surface = text.slice(pos, pos + n);
    return { surface, length: n, entries: names(surface) };
  }
  if (hit) hit.entries.push(...names(hit.surface));
  return hit;
}

// Half-width katakana is folded to full-width and a wave dash after kana read as
// ー (う〜ん). `at[i]` maps a normalised index back to the original text.
function normalize(text) {
  let norm = '';
  const at = [];
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    at.push(i);
    if (ch >= 'ｦ' && ch <= 'ﾟ') {
      const pair = (ch + (text[i + 1] ?? '')).normalize('NFKC');
      if (/[ﾞﾟ]/.test(text[i + 1] ?? '') && pair.length === 1) {
        norm += pair;
        i++;
        continue;
      }
      ch = ch.normalize('NFKC');
    } else if ((ch === '〜' || ch === '～') && /[ぁ-ヺー]/.test(norm.at(-1) ?? '')) {
      ch = 'ー';
    }
    norm += ch;
  }
  at.push(text.length);
  return { norm, at };
}

const HONORIFIC = /^(さん|くん|君|ちゃん|様|さま|先輩|先生|氏|殿)/;
const MAX_ENTRIES = 8;
const MAX_NAMES = 3;

/**
 * Segment a whole subtitle line into hoverable tokens. Non-Japanese runs come
 * back as `{ text, entries: [] }` so the client can render them inert.
 */
export function tokenize(text) {
  const { norm, at } = normalize(text);
  const tokens = [];
  let i = 0;
  let plain = '';
  const flush = () => {
    if (plain) tokens.push({ text: plain, entries: [] });
    plain = '';
  };

  while (i < norm.length) {
    const hit = lookupAt(norm, i);
    if (!hit) {
      plain += text.slice(at[i], at[i + 1]);
      i++;
      continue;
    }
    flush();
    const ws = hit.entries.filter((e) => !e.name);
    const ns = hit.entries.filter((e) => e.name).slice(0, MAX_NAMES);
    // 高木 is a dictionary word (tall tree) but 高木さん and a （高木） speaker label are people.
    const person = ns.length && (HONORIFIC.test(norm.slice(i + hit.length)) || (/[（(]/.test(norm[i - 1]) && /[）)]/.test(norm[i + hit.length])));
    const entries = person ? [...ns, ...ws] : [...ws.slice(0, MAX_ENTRIES - ns.length), ...ns];
    tokens.push({
      text: text.slice(at[i], at[i + hit.length]),
      lemma: entries[0].headword,
      reading: entries[0].reading,
      entries: entries.slice(0, MAX_ENTRIES),
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

  const q = dictDb().prepare(
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
