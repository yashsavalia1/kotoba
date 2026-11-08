import fs from 'node:fs';
import path from 'node:path';
import { userDb } from './db.mjs';
import { SUB_EXTS, parseSubtitles } from './subs.mjs';
import { displayTitle, isMediaFile, probe, extractEmbeddedSub, decodeSubFile, BITMAP_SUB_CODECS } from './media.mjs';

const now = () => Date.now();

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

/** Register a file (or refresh its stat) and mark it opened. Returns the media record. */
export function openMedia(absPath) {
  const abs = path.resolve(absPath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  if (!isMediaFile(abs)) throw new Error(`Not a media file: ${path.basename(abs)}`);
  const st = fs.statSync(abs);
  const db = userDb();
  db.prepare(
    `INSERT INTO media (path, title, size, mtime, added_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
       last_opened_at = excluded.last_opened_at`
  ).run(abs, displayTitle(abs), st.size, st.mtimeMs, now(), now());
  return getMedia(db.prepare('SELECT id FROM media WHERE path = ?').get(abs).id);
}

export function getMedia(id) {
  return hydrate(userDb().prepare('SELECT * FROM media WHERE id = ?').get(Number(id)));
}

export function listMedia({ limit = 200 } = {}) {
  return userDb()
    .prepare('SELECT * FROM media ORDER BY coalesce(last_opened_at, added_at) DESC LIMIT ?')
    .all(limit)
    .map(hydrate);
}

export function removeMedia(id) {
  userDb().prepare('DELETE FROM media WHERE id = ?').run(Number(id));
}

/** The only gate between the renderer and the filesystem: ids must be registered media. */
export function pathOf(id) {
  const row = userDb().prepare('SELECT path FROM media WHERE id = ?').get(Number(id));
  if (!row) throw new Error(`unknown media id ${id}`);
  return row.path;
}

export function setPosition(id, position, duration) {
  userDb()
    .prepare('UPDATE media SET position = ?, duration = coalesce(?, duration) WHERE id = ?')
    .run(Math.max(0, Number(position) || 0), Number.isFinite(duration) ? duration : null, Number(id));
}

export function setPrefs(id, patch) {
  const current = getMedia(id)?.prefs ?? {};
  const next = { ...current, ...patch };
  userDb().prepare('UPDATE media SET prefs = ? WHERE id = ?').run(JSON.stringify(next), Number(id));
  return next;
}

/** Media files in the same folder, natural-sorted: the implicit playlist for next/previous episode. */
export function siblings(id) {
  const abs = pathOf(id);
  const dir = path.dirname(abs);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && isMediaFile(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((n) => ({ path: path.join(dir, n), title: displayTitle(n), current: path.join(dir, n) === abs }));
}

// ---------------------------------------------------------------- subtitles

function siblingSubtitleFiles(abs) {
  const dir = path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => SUB_EXTS.includes(path.extname(n).toLowerCase()) && n.startsWith(stem))
    .map((n) => {
      const middle = path.basename(n, path.extname(n)).slice(stem.length).replace(/^[.\-_\s]+/, '');
      return { file: path.join(dir, n), label: middle || path.extname(n).slice(1) };
    });
}

/**
 * Every subtitle source for a media file. Keys are stable across launches so the
 * chosen track can be remembered: `file:<abs path>` or `stream:<ffprobe index>`.
 */
export async function subtitleTracks(id) {
  const abs = pathOf(id);
  const tracks = [];
  const seen = new Set();
  const addFile = (file, label, source) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    tracks.push({ key: `file:${file}`, kind: 'file', source, label, file });
  };
  for (const s of siblingSubtitleFiles(abs)) addFile(s.file, s.label, 'sibling');
  for (const r of userDb().prepare('SELECT path FROM media_sub WHERE media_id = ? ORDER BY added_at').all(Number(id))) {
    addFile(r.path, path.basename(r.path), 'attached');
  }
  try {
    const info = await probe(abs);
    for (const s of info.streams ?? []) {
      if (s.codec_type !== 'subtitle' || BITMAP_SUB_CODECS.has(s.codec_name)) continue;
      tracks.push({
        key: `stream:${s.index}`,
        kind: 'stream',
        source: 'embedded',
        label: [s.tags?.language, s.tags?.title].filter(Boolean).join(' · ') || `Track ${s.index}`,
        language: s.tags?.language ?? null,
        stream: s.index,
      });
    }
  } catch {
    /* unprobeable file: external subtitles still work */
  }
  return tracks;
}

export function attachSubtitle(id, file) {
  const abs = path.resolve(file);
  if (!SUB_EXTS.includes(path.extname(abs).toLowerCase())) throw new Error('Not a subtitle file');
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  userDb()
    .prepare('INSERT OR IGNORE INTO media_sub (media_id, path, added_at) VALUES (?, ?, ?)')
    .run(Number(id), abs, now());
  return `file:${abs}`;
}

export async function loadSubtitleTrack(id, key) {
  const abs = pathOf(id);
  if (key.startsWith('file:')) {
    const file = key.slice(5);
    const known = (await subtitleTracks(id)).some((t) => t.key === key);
    if (!known) throw new Error('subtitle file is not associated with this media');
    return parseSubtitles(decodeSubFile(file), path.extname(file));
  }
  if (key.startsWith('stream:')) {
    return parseSubtitles(await extractEmbeddedSub(abs, Number(key.slice(7))), '.ass');
  }
  throw new Error(`bad subtitle track key: ${key}`);
}
