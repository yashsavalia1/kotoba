import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { userDb, transaction } from './db.mjs';
import { paths } from './paths.mjs';
import { getSettings } from './settings.mjs';
import { SUB_EXTS, parseSubtitles } from './subs.mjs';
import { displayTitle, isMediaFile, probe, extractEmbeddedSub, decodeSubFile, BITMAP_SUB_CODECS } from './media.mjs';

const now = () => Date.now();
const MAX_DIR_ENTRIES = 5000;
const MAX_SUB_BYTES = 32 << 20;

export const isSubtitleFile = (p) => SUB_EXTS.includes(path.extname(p).toLowerCase());
export const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).slice(0, MAX_DIR_ENTRIES);
  } catch {
    return [];
  }
}

// Directory entries may be symlinks; follow them for files, never for directories (no loops).
const isFileEntry = (dir, e) => e.isFile() || (e.isSymbolicLink() && statSafe(path.join(dir, e.name))?.isFile());

function statFile(abs) {
  const st = statSafe(abs);
  if (!st) throw new Error(`File not found: ${abs}`);
  if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
  return st;
}

// ---------------------------------------------------------------- records

const hydrate = (row) =>
  row && {
    id: row.id,
    path: row.path,
    title: row.title,
    folder: path.dirname(row.path),
    size: row.size,
    duration: row.duration,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    position: row.position,
    prefs: JSON.parse(row.prefs || '{}'),
    exists: fs.existsSync(row.path),
  };

const idByPath = (abs) => userDb().prepare('SELECT id FROM media WHERE path = ?').get(abs)?.id;

/** Register a file without marking it opened (no history entry for new rows). Relinks moved records. */
function register(abs, st) {
  const db = userDb();
  let id = idByPath(abs);
  if (id == null) {
    const moved = movedRecordFor(abs, st.size);
    if (moved) relink(moved.id, abs, st);
    id = moved?.id;
  }
  if (id == null) {
    db.prepare('INSERT INTO media (path, title, size, mtime, added_at) VALUES (?, ?, ?, ?, ?)').run(
      abs, displayTitle(abs), st.size, st.mtimeMs, now()
    );
    id = idByPath(abs);
  } else {
    db.prepare('UPDATE media SET size = ?, mtime = ? WHERE id = ?').run(st.size, st.mtimeMs, id);
  }
  return id;
}

/** Register a file (or refresh its stat) and mark it opened. Returns the media record. */
export function openMedia(absPath) {
  const abs = path.resolve(absPath);
  if (!isMediaFile(abs)) throw new Error(`Not a media file: ${path.basename(abs)}`);
  const id = register(abs, statFile(abs));
  userDb().prepare('UPDATE media SET last_opened_at = ? WHERE id = ?').run(now(), id);
  relinkFolder(path.dirname(abs));
  return getMedia(id);
}

export function getMedia(id) {
  return hydrate(userDb().prepare('SELECT * FROM media WHERE id = ?').get(Number(id)));
}

/** History: files the user opened, most recent first. Removed entries keep their row (corpus, prefs) but leave the list. */
export function listMedia({ limit = 200 } = {}) {
  return userDb()
    .prepare('SELECT * FROM media WHERE last_opened_at IS NOT NULL ORDER BY last_opened_at DESC, id DESC LIMIT ?')
    .all(limit)
    .map(hydrate);
}

export function removeMedia(id) {
  userDb().prepare('UPDATE media SET last_opened_at = NULL WHERE id = ?').run(Number(id));
}

export function clearHistory() {
  userDb().prepare('UPDATE media SET last_opened_at = NULL').run();
}

/** The only gate between the renderer and the filesystem: ids must be registered media. */
export function pathOf(id) {
  const row = userDb().prepare('SELECT path FROM media WHERE id = ?').get(Number(id));
  if (!row) throw new Error(`unknown media id ${id}`);
  return row.path;
}

/** Folders containing registered media: a renderer may open any media file directly inside one. */
export function isKnownFolder(dir) {
  const d = path.resolve(dir);
  return userDb()
    .prepare('SELECT path FROM media')
    .all()
    .some((r) => path.dirname(r.path) === d);
}

export function setPosition(id, position, duration) {
  userDb()
    .prepare('UPDATE media SET position = ?, duration = coalesce(?, duration) WHERE id = ?')
    .run(Math.max(0, Number(position) || 0), Number.isFinite(duration) ? duration : null, Number(id));
}

const TRACK_KEY = /^(file:.+|stream:\d+)$/;
const isTrackKey = (v) => v === null || (typeof v === 'string' && TRACK_KEY.test(v));
const PREF_RULES = {
  subTrack: isTrackKey,
  refTrack: isTrackKey,
  audioTrack: (v) => v === null || (Number.isInteger(v) && v >= 0),
  subDelayMs: (v) => Number.isFinite(v) && Math.abs(v) <= 600_000,
  rate: (v) => Number.isFinite(v) && v >= 0.25 && v <= 4,
};

/** Merge a validated patch. `null` track = explicitly off; `undefined` removes the key. */
export function setPrefs(id, patch) {
  pathOf(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('prefs patch must be an object');
  const next = { ...getMedia(id).prefs };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in PREF_RULES)) throw new Error(`unknown pref: ${k}`);
    if (v === undefined) delete next[k];
    else if (!PREF_RULES[k](v)) throw new Error(`invalid ${k}: ${JSON.stringify(v)}`);
    else next[k] = k === 'subDelayMs' ? Math.round(v) : v;
  }
  userDb().prepare('UPDATE media SET prefs = ? WHERE id = ?').run(JSON.stringify(next), Number(id));
  return next;
}

// ---------------------------------------------------------------- moved / missing files

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
// Records without a size (legacy imports) relink on basename alone, so only on distinctive names.
const couldBe = (r, size) => (r.size == null ? path.basename(r.path).length > 15 : r.size === size) && !fs.existsSync(r.path);

/** A missing record with the same basename (and size, when known) — the file was moved. */
function movedRecordFor(abs, size) {
  const name = path.basename(abs);
  return userDb()
    .prepare("SELECT id, path, size FROM media WHERE path LIKE ? ESCAPE '\\' ORDER BY coalesce(last_opened_at, added_at) DESC")
    .all(`%${escapeLike(path.sep + name)}`)
    .find((r) => path.basename(r.path) === name && couldBe(r, size));
}

/** Relink missing records whose file now sits in `dir` (one readdir, one query). */
function relinkFolder(dir) {
  const byName = new Map();
  for (const r of userDb().prepare('SELECT id, path, size FROM media').all()) {
    if (path.dirname(r.path) === dir) continue;
    const name = path.basename(r.path);
    byName.set(name, [...(byName.get(name) ?? []), r]);
  }
  if (!byName.size) return;
  for (const e of readDir(dir)) {
    const candidates = byName.get(e.name);
    if (!candidates || !isMediaFile(e.name)) continue;
    const abs = path.join(dir, e.name);
    const st = statSafe(abs);
    if (!st?.isFile() || idByPath(abs) != null) continue;
    const r = candidates.find((c) => couldBe(c, st.size));
    if (r) relink(r.id, abs, st);
  }
}

function relink(id, abs, st) {
  const db = userDb();
  const old = pathOf(id);
  const oldDir = path.dirname(old);
  const newDir = path.dirname(abs);
  // A subtitle that moved with the video keeps its path relative to it.
  const follow = (file) => {
    if (fs.existsSync(file)) return file;
    const moved = path.resolve(newDir, path.relative(oldDir, file));
    return fs.existsSync(moved) ? moved : null;
  };
  transaction(db, () => {
    db.prepare('UPDATE media SET path = ?, title = ?, size = ?, mtime = ? WHERE id = ?').run(
      abs, displayTitle(abs), st.size, st.mtimeMs, id
    );
    for (const { path: sub } of db.prepare('SELECT path FROM media_sub WHERE media_id = ?').all(id)) {
      const moved = follow(sub);
      if (moved && moved !== sub) db.prepare('UPDATE OR IGNORE media_sub SET path = ? WHERE media_id = ? AND path = ?').run(moved, id, sub);
    }
    const prefs = JSON.parse(db.prepare('SELECT prefs FROM media WHERE id = ?').get(id).prefs || '{}');
    for (const k of ['subTrack', 'refTrack']) {
      if (typeof prefs[k] !== 'string' || !prefs[k].startsWith('file:')) continue;
      const moved = follow(prefs[k].slice(5));
      if (moved) prefs[k] = `file:${moved}`;
      else delete prefs[k];
    }
    db.prepare('UPDATE media SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), id);
  });
}

/**
 * Point a record at a file's new location, keeping its id (history, corpus, prefs, position).
 * If the new path was already registered separately, that newer record is merged into this one.
 */
export function locateMedia(id, newPath) {
  const abs = path.resolve(newPath);
  if (!isMediaFile(abs)) throw new Error(`Not a media file: ${path.basename(abs)}`);
  const st = statFile(abs);
  pathOf(id);
  const db = userDb();
  const other = idByPath(abs);
  if (other != null && other !== Number(id)) {
    transaction(db, () => {
      db.prepare('UPDATE OR IGNORE line SET media_id = ? WHERE media_id = ?').run(Number(id), other);
      db.prepare('DELETE FROM line WHERE media_id = ?').run(other);
      db.prepare('UPDATE mined SET media_id = ? WHERE media_id = ?').run(Number(id), other);
      db.prepare('UPDATE OR IGNORE media_sub SET media_id = ? WHERE media_id = ?').run(Number(id), other);
      db.prepare('DELETE FROM media WHERE id = ?').run(other);
    });
  }
  relink(Number(id), abs, st);
  db.prepare('UPDATE media SET last_opened_at = ? WHERE id = ?').run(now(), Number(id));
  return getMedia(id);
}

// ---------------------------------------------------------------- playlist

/** Media files in the same folder, natural-sorted: the implicit playlist for next/previous episode. */
export function siblings(id) {
  const abs = pathOf(id);
  const dir = path.dirname(abs);
  const q = userDb().prepare('SELECT id, position, duration FROM media WHERE path = ?');
  return readDir(dir)
    .filter((e) => isMediaFile(e.name) && isFileEntry(dir, e))
    .map((e) => e.name)
    .sort(naturalCompare)
    .map((n) => {
      const p = path.join(dir, n);
      const row = q.get(p);
      return { path: p, title: displayTitle(n), current: p === abs, id: row?.id ?? null, position: row?.position ?? 0, duration: row?.duration ?? null };
    });
}

/** Register and open the previous (-1) / next (+1) file in the folder, or null at either end. */
export function adjacent(id, delta) {
  const step = Math.trunc(Number(delta));
  if (!step) throw new Error('delta must be a non-zero integer');
  const list = siblings(id);
  const i = list.findIndex((s) => s.current);
  const next = i === -1 ? null : list[i + step];
  return next ? openMedia(next.path) : null;
}

// ---------------------------------------------------------------- names: language, episode, series

const LANGS = {
  ja: ['ja', 'jp', 'jpn', 'jap', 'japanese', 'nihongo', '日本語'],
  en: ['en', 'eng', 'english'],
  zh: ['zh', 'chi', 'zho', 'chs', 'cht', 'chinese', '中文'],
  ko: ['ko', 'kor', 'korean'],
  es: ['es', 'spa', 'spanish'],
  fr: ['fr', 'fre', 'fra', 'french'],
  de: ['de', 'ger', 'deu', 'german'],
  pt: ['pt', 'por', 'portuguese'],
  it: ['it', 'ita', 'italian'],
  ru: ['ru', 'rus', 'russian'],
};
const LANG_OF = new Map(Object.entries(LANGS).flatMap(([code, tags]) => tags.map((t) => [t, code])));
const FORCED = new Set(['forced', 'signs', 'songs']);
const SDH = new Set(['sdh', 'cc', 'hoh']);
const langDisplay = new Intl.DisplayNames(['en'], { type: 'language' });

// `ja-JP`, `en_US`, `zh-Hans` → their primary subtag.
const langOfTag = (t) => LANG_OF.get(t.toLowerCase().replace(/^([a-z]{2,3})[-_][a-z]{2,4}$/, '$1')) ?? null;
const isTag = (t) => langOfTag(t) != null || FORCED.has(t.toLowerCase()) || SDH.has(t.toLowerCase());

/** Stem without extension or trailing `.ja.forced`-style tags. */
function baseStem(name) {
  const ext = path.extname(name).toLowerCase();
  let stem = isSubtitleFile(name) || isMediaFile(name) ? name.slice(0, -ext.length) : name;
  for (let seg; (seg = stem.match(/\.([^.]+)$/)?.[1]) && isTag(seg); ) stem = stem.slice(0, -seg.length - 1);
  return stem;
}

/** Language and flags from a filename: `.ja.`, `[Japanese]`, `(eng)`, `2_English`, `.ja-JP.forced`. */
export function nameTags(name) {
  const stem = isSubtitleFile(name) ? name.slice(0, -path.extname(name).length) : name;
  const dots = stem.split('.').slice(1).slice(-3).reverse();
  // Two-letter codes collide with romaji particles ("de", "no"), so a bare trailing word must be 3+ letters.
  const last = stem.split('.').at(-1).split(/[\s_-]+/).filter(Boolean).at(-1) ?? '';
  const brackets = [...stem.matchAll(/[[(]([^\])]+)[\])]/g)].map((m) => m[1].trim()).reverse();
  const tokens = [...dots, ...(last.length >= 3 ? [last] : []), ...brackets, stem];
  const lower = tokens.map((t) => t.toLowerCase());
  return {
    language: tokens.map(langOfTag).find(Boolean) ?? null,
    forced: lower.some((t) => FORCED.has(t)),
    sdh: lower.some((t) => SDH.has(t)),
  };
}

const GENERIC = new Set(['subs', 'sub', 'subtitles', 'subtitle', 'complete', 'batch', 'season', 'bd', 'bluray', 'web', 'tv', 'the', ...LANG_OF.keys()]);
const seriesWords = (s) =>
  s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !GENERIC.has(w) && !/^\d+$/.test(w));

/** Episode, season and series words from a file or folder name. Episode null when there is none. */
export function episodeInfo(name) {
  let s = baseStem(name)
    .replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\b\d{3,4}[pi]\b|\b[xh]\.?26[45]\b|\b(?:10|8)[ -]?bits?\b|\b\d{3,4}x\d{3,4}\b/gi, ' ');
  const found = (m, season, episode) => ({
    season: season == null ? null : Number(season),
    episode: Number(episode),
    series: seriesWords(s.slice(0, m.index)),
  });
  let m;
  if ((m = /\bS(\d{1,2})[\s._-]?E(\d{1,4})/i.exec(s))) return found(m, m[1], m[2]);
  if ((m = /(?<!\d)(\d{1,2})x(\d{2,3})(?!\d)/.exec(s))) return found(m, m[1], m[2]);
  if ((m = /第\s*(\d{1,4})\s*[話回]/.exec(s))) return found(m, null, m[1]);
  if ((m = /\b(?:ep(?:isode)?\.?\s*|e)(\d{1,4})(?:v\d)?\b/i.exec(s))) return found(m, null, m[1]);
  if ((m = /#\s*(\d{1,4})\b/.exec(s))) return found(m, null, m[1]);
  if ((m = /\s[-–]\s+(\d{1,4})(?:v\d)?(?=$|[\s.([_])/.exec(s))) return found(m, null, m[1]);
  if ((m = /\((\d{1,3})\)/.exec(s))) return found(m, null, m[1]);
  s = s.replace(/\([^)]*\)/g, ' ').trim();
  if ((m = /(?:^|[\s_.])(\d{1,3})(?:v\d)?$/.exec(s))) return found(m, null, m[1]);
  return { season: null, episode: null, series: seriesWords(s) };
}

/** Series words and season of a folder name like `[Group] Show - S01 (BD 1080p)` or `Show 2 (01-12)`. */
function folderInfo(name) {
  const s = name.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').trim();
  const m = /\bS(\d{1,2})\b|\bSeason\s*(\d{1,2})\b|\b(\d)(?:st|nd|rd|th)\s+Season\b|\s(\d{1,2})$/i.exec(s);
  return {
    season: m ? Number(m[1] ?? m[2] ?? m[3] ?? m[4]) : null,
    series: seriesWords(m ? s.slice(0, m.index) + s.slice(m.index + m[0].length) : s),
  };
}

/** Share of the smaller word set found in the larger (null when either is empty). */
function overlap(a, b, minChars = 0) {
  if (!a.length || !b.length) return null;
  const [small, big] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  const shared = small.filter((w) => big.has(w));
  return shared.join('').length < minChars ? 0 : shared.length / small.length;
}

/**
 * How a subtitle filename relates to the video: 'exact' (same stem plus tags), 'episode'
 * (same episode number), 'folder' (lone video in the folder), or null. Never a different episode.
 */
function matchKind(video, subName, { lone = false, checkSeries = true } = {}) {
  const stem = baseStem(subName).toLowerCase();
  const sub = episodeInfo(subName);
  if (video.episode != null && sub.episode != null) {
    if (sub.episode !== video.episode) return null;
    if (video.season != null && sub.season != null && video.season !== sub.season) return null;
  }
  if (stem === video.stem || (stem.startsWith(video.stem) && /^[\s._\-[(]/.test(stem.slice(video.stem.length)))) return 'exact';
  const seriesOk = !checkSeries || (overlap(video.series, sub.series) ?? 1) >= 0.6;
  if (video.episode != null && sub.episode === video.episode && seriesOk) return 'episode';
  if (lone && seriesOk) return 'folder';
  return null;
}

// ---------------------------------------------------------------- subtitle discovery

const SUBDIR = /^(subs?|subtitles?)$/i;

function videoInfo(abs) {
  const info = episodeInfo(path.basename(abs));
  const folder = folderInfo(path.basename(path.dirname(abs)));
  return {
    stem: baseStem(path.basename(abs)).toLowerCase(),
    episode: info.episode,
    season: info.season ?? (info.episode != null ? folder.season : null),
    series: info.series.length ? info.series : folder.series,
  };
}

/**
 * Subtitle files near a video, like a real player: same folder (exact stem, same episode, or
 * anything if it is the only video), `Subs/`, `Subs/<video stem>/`, `Subs/<Language>/`, and
 * same-series sibling folders (`[Group] Show (01-12)/Show - (3).srt` next to `Show - S01/`).
 */
function discoverSubtitleFiles(abs) {
  const dir = path.dirname(abs);
  const video = videoInfo(abs);
  const entries = readDir(dir);
  const lone = entries.filter((e) => isMediaFile(e.name)).length <= 1;
  const out = [];
  const add = (file, source, match, langHint = null) => match && out.push({ file, source, match, langHint });

  for (const e of entries) {
    if (isSubtitleFile(e.name)) add(path.join(dir, e.name), 'sibling', matchKind(video, e.name, { lone }));
  }
  for (const sd of entries.filter((e) => e.isDirectory() && SUBDIR.test(e.name))) {
    const subDir = path.join(dir, sd.name);
    for (const e of readDir(subDir)) {
      if (isSubtitleFile(e.name)) {
        add(path.join(subDir, e.name), 'subfolder', matchKind(video, e.name, { lone, checkSeries: false }));
      } else if (e.isDirectory()) {
        const exact = e.name.toLowerCase() === video.stem;
        const langHint = langOfTag(e.name);
        if (!exact && !langHint) continue;
        for (const f of readDir(path.join(subDir, e.name))) {
          if (!isSubtitleFile(f.name)) continue;
          add(path.join(subDir, e.name, f.name), 'subfolder', exact ? 'exact' : matchKind(video, f.name, { lone, checkSeries: false }), langHint);
        }
      }
    }
  }
  out.push(...nearbyFolders(abs, video));
  return out;
}

// ponytail: scans at most MAX_DIR_ENTRIES names of the parent and 4 matching folders; an index of
// user-designated subtitle folders is the upgrade if people keep subs further away.
function nearbyFolders(abs, video) {
  const dir = path.dirname(abs);
  const parent = path.dirname(dir);
  const season = video.season ?? 1;
  if (parent === dir || video.episode == null) return [];
  const out = [];
  let folders = 0;
  for (const e of readDir(parent)) {
    if (!e.isDirectory() || path.join(parent, e.name) === dir) continue;
    const f = folderInfo(e.name);
    // A shared title of 6+ letters: "Show" alone next to "Show (2)" is too weak a signal.
    if ((f.season ?? 1) !== season || (overlap(video.series, f.series, 6) ?? 0) < 0.6) continue;
    if (++folders > 4) break;
    const subDir = path.join(parent, e.name);
    for (const s of readDir(subDir)) {
      if (!isSubtitleFile(s.name)) continue;
      const match = matchKind(video, s.name);
      if (match === 'exact' || match === 'episode') out.push({ file: path.join(subDir, s.name), source: 'nearby', match, langHint: null });
    }
  }
  return out;
}

const sniffCache = new Map();

/** Guess a language from subtitle text: Japanese-character ratio, Hangul, Han-only, English stopwords. */
export function sniffLanguage(cues) {
  const text = cues.slice(0, 300).map((c) => c.text).join('\n');
  const count = (re) => text.match(re)?.length ?? 0;
  const kana = count(/[぀-ヿ]/g);
  const han = count(/[一-鿿]/g);
  const hangul = count(/[가-힯]/g);
  const latin = count(/[A-Za-z]/g);
  const total = kana + han + hangul + latin;
  if (total < 20) return null;
  if ((kana + han) / total > 0.3) return kana > (kana + han) * 0.1 ? 'ja' : 'zh';
  if (hangul / total > 0.3) return 'ko';
  if (latin / total > 0.8) {
    const words = text.match(/[A-Za-z']+/g) ?? [];
    const common = words.filter((w) => /^(the|you|i|to|and|a|is|it|what|that|of|in|me|this|don't|i'm)$/i.test(w)).length;
    return common / words.length > 0.08 ? 'en' : null;
  }
  return null;
}

function sniffFile(file, st) {
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (!sniffCache.has(key)) {
    let lang = null;
    try {
      if (st.size <= MAX_SUB_BYTES) lang = sniffLanguage(parseSubtitles(decodeSubFile(file), path.extname(file)));
    } catch {
      /* unreadable: unknown language */
    }
    sniffCache.set(key, lang);
  }
  return sniffCache.get(key);
}

function langToCode(tag) {
  if (!tag || tag === 'und') return null;
  return langOfTag(tag) ?? (/^[a-z]{2}$/i.test(tag) ? tag.toLowerCase() : null);
}

const langName = (code) => {
  try {
    return code ? langDisplay.of(code) : null;
  } catch {
    return null;
  }
};

function fileTracks(id) {
  const abs = pathOf(id);
  const dir = path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  const found = discoverSubtitleFiles(abs);
  for (const r of userDb().prepare('SELECT path FROM media_sub WHERE media_id = ? ORDER BY added_at').all(Number(id))) {
    found.push({ file: r.path, source: 'attached', match: 'attached', langHint: null });
  }
  const seen = new Set();
  const tracks = [];
  for (const { file, source, match, langHint } of found.reverse()) {
    if (seen.has(file)) continue;
    const st = statSafe(file);
    if (!st?.isFile()) continue;
    seen.add(file);
    const tags = nameTags(path.basename(file));
    const language = tags.language ?? langHint ?? sniffFile(file, st);
    const detail =
      match === 'exact' && path.dirname(file) === dir
        ? path.basename(file).slice(stem.length).replace(/^[\s._-]+/, '') || path.basename(file)
        : path.relative(dir, file);
    tracks.push({
      key: `file:${file}`, kind: 'file', source, match, file, language, forced: tags.forced, sdh: tags.sdh,
      label: [langName(language), detail].filter(Boolean).join(' · '),
    });
  }
  return tracks.reverse();
}

async function streamTracks(abs) {
  let info;
  try {
    info = await probe(abs);
  } catch {
    return []; // unprobeable or missing file: external subtitles still work
  }
  return (info.streams ?? [])
    .filter((s) => s.codec_type === 'subtitle' && !BITMAP_SUB_CODECS.has(s.codec_name))
    .map((s) => {
      const title = s.tags?.title ?? null;
      const tags = title ? nameTags(title) : {};
      const cached = readCache(abs, s.index);
      const language = langToCode(s.tags?.language) ?? tags.language ?? (cached ? sniffLanguage(parseSubtitles(cached, '.ass')) : null);
      const forced = Boolean(s.disposition?.forced) || Boolean(tags.forced);
      return {
        key: `stream:${s.index}`, kind: 'stream', source: 'embedded', match: 'embedded', stream: s.index,
        codec: s.codec_name, title, language, forced, sdh: Boolean(s.disposition?.hearing_impaired) || Boolean(tags.sdh),
        default: Boolean(s.disposition?.default),
        label: [langName(language), title, forced && !tags.forced ? 'forced' : null].filter(Boolean).join(' · ') || `Track ${s.index}`,
      };
    });
}

const MATCH_SCORE = { attached: 50, exact: 40, embedded: 30, episode: 25, folder: 10 };
const SOURCE_PENALTY = { subfolder: 2, nearby: 5 };

function rank(tracks, target) {
  const score = (t) =>
    (t.language === target ? 1000 : t.language == null ? 500 : 0) +
    MATCH_SCORE[t.match] - (SOURCE_PENALTY[t.source] ?? 0) - (t.forced ? 100 : 0) - (t.sdh ? 5 : 0) + (t.default ? 3 : 0);
  return tracks.map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s).map(({ t }) => t);
}

/**
 * Every subtitle source for a media file, best first: target language, then how sure the
 * match is. Keys are stable across launches: `file:<abs path>` or `stream:<ffprobe index>`.
 */
export async function subtitleTracks(id) {
  const files = fileTracks(id);
  const streams = await streamTracks(pathOf(id));
  return rank([...files, ...streams], getSettings().targetLang);
}

export function attachSubtitle(id, file) {
  pathOf(id);
  const abs = path.resolve(file);
  if (!isSubtitleFile(abs)) throw new Error('Not a subtitle file');
  if (statFile(abs).size > MAX_SUB_BYTES) throw new Error('Subtitle file is too large');
  userDb()
    .prepare('INSERT OR IGNORE INTO media_sub (media_id, path, added_at) VALUES (?, ?, ?)')
    .run(Number(id), abs, now());
  return `file:${abs}`;
}

// ---------------------------------------------------------------- embedded subtitle cache

// Extraction reads the whole container (seconds for a 2 GB mkv); the text is tiny, so keep it.
const MAX_CACHE_FILES = 500;
const inflight = new Map();
const cacheDir = () => path.join(paths.userDataDir, 'subs-cache');

function cacheFile(abs, index) {
  const st = statSafe(abs);
  if (!st) return null;
  const key = crypto.createHash('sha1').update(`${abs}\0${st.size}\0${st.mtimeMs}\0${index}`).digest('hex');
  return path.join(cacheDir(), `${key}.ass`);
}

function readCache(abs, index) {
  const file = cacheFile(abs, index);
  try {
    return file && fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function pruneCache() {
  const dir = cacheDir();
  const files = readDir(dir).map((e) => path.join(dir, e.name));
  if (files.length <= MAX_CACHE_FILES) return;
  const old = files.map((f) => [f, statSafe(f)?.mtimeMs ?? 0]).sort((a, b) => a[1] - b[1]);
  for (const [f] of old.slice(0, files.length - MAX_CACHE_FILES)) fs.rmSync(f, { force: true });
}

export async function embeddedSubtitleText(abs, index) {
  const cached = readCache(abs, index);
  if (cached != null) return cached;
  const file = cacheFile(abs, index);
  if (!inflight.has(file)) {
    inflight.set(
      file,
      extractEmbeddedSub(abs, index)
        .then((text) => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.${crypto.randomUUID()}.tmp`;
          fs.writeFileSync(tmp, text);
          fs.renameSync(tmp, file);
          pruneCache();
          return text;
        })
        .finally(() => inflight.delete(file))
    );
  }
  return inflight.get(file);
}

/** Cues for one of the media's own tracks. Keys not offered by subtitleTracks are refused. */
export async function loadSubtitleTrack(id, key) {
  const abs = pathOf(id);
  if (typeof key !== 'string') throw new Error('bad subtitle track key');
  if (key.startsWith('file:')) {
    const track = fileTracks(id).find((t) => t.key === key);
    if (!track) throw new Error('subtitle file is not associated with this media');
    if (statFile(track.file).size > MAX_SUB_BYTES) throw new Error('Subtitle file is too large');
    return { track, cues: parseSubtitles(decodeSubFile(track.file), path.extname(track.file)) };
  }
  if (/^stream:\d+$/.test(key)) {
    const track = (await streamTracks(abs)).find((t) => t.key === key);
    if (!track) throw new Error('no such text subtitle stream');
    const cues = parseSubtitles(await embeddedSubtitleText(abs, track.stream), '.ass');
    return { track: { ...track, language: track.language ?? sniffLanguage(cues) }, cues };
  }
  throw new Error(`bad subtitle track key: ${key}`);
}
