import fs from 'node:fs';
import path from 'node:path';
import { userDb, transaction } from './db.mjs';
import { getSettings } from './settings.mjs';
import { isMediaFile, isVideoFile } from './media.mjs';
import { readDir, isFileEntry, naturalCompare, statSafe, idByPath, register } from './library.mjs';
import { nameOf, episodes, namesEpisode, episodeTitle, showTitle } from './titles.mjs';
import { share, timeLeft, folderDetail } from './watch.mjs';

// The library root mirrored as it is on disk: each folder a card, nested folders seasons.

const RESUME_KEPT = 12;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const within = (root, p) => {
  const rel = path.relative(root, p);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const count = (n, noun) => (n === 0 ? null : n === 1 ? `1 ${noun}` : `${n} ${noun}s`);

export function libraryRoot() {
  const root = getSettings().libraryRoot;
  return typeof root === 'string' && statSafe(root)?.isDirectory() ? root : null;
}

// Real paths, so a symlinked folder can't lead out of the library; files themselves may be links.
function underRoot(abs) {
  const root = libraryRoot();
  const dir = real(statSafe(abs)?.isDirectory() ? abs : path.dirname(abs));
  return Boolean(root && dir && within(real(root), dir));
}

/** A path from the renderer it may act on: anything under the library folder, or media already in the library. */
export function checkPath(p) {
  if (typeof p !== 'string' || !p) throw new Error('path required');
  const abs = path.resolve(p);
  if (underRoot(abs) || (isMediaFile(abs) && idByPath(abs) != null)) return abs;
  throw new Error('That is not in your library');
}

const sorted = (dir, keep) => readDir(dir).filter((e) => keep(e)).map((e) => e.name).sort(naturalCompare).map((n) => path.join(dir, n));
const videosIn = (dir) => sorted(dir, (e) => isMediaFile(e.name) && isFileEntry(dir, e));
const foldersIn = (dir) => sorted(dir, (e) => e.isDirectory());

/** The videos in `dir` and the folders under it, at most `depth` levels down, as a show split into seasons has. */
const videosUnder = (dir, depth = 3) => (depth ? [...videosIn(dir), ...foldersIn(dir).flatMap((d) => videosUnder(d, depth - 1))] : []);

/** The first video in a folder's subfolders, for a show split into seasons, at most `depth` levels down. */
function coverIn(dir, depth = 3) {
  if (!depth) return null;
  for (const d of foldersIn(dir)) {
    const found = videosIn(d).find(isVideoFile) ?? coverIn(d, depth - 1);
    if (found) return found;
  }
  return null;
}

const progressRows = () => new Map(userDb().prepare('SELECT path, position, duration, watched FROM media').all().map((r) => [r.path, r]));
const shareOf = (r) => share(r?.position ?? 0, r?.duration ?? 0, Boolean(r?.watched));
const progressOf = (r) => (r?.duration > 0 ? clamp01(r.position / r.duration) : 0);

function folderCard(dir, rows, s) {
  const own = videosIn(dir);
  // A show split into seasons counts them all, a group each.
  const groups = [own, ...foldersIn(dir).map((d) => videosUnder(d, 2))].filter((g) => g.length);
  const all = groups.flat();
  const watched = all.filter((p) => rows.get(p)?.watched).length;
  return {
    path: dir,
    title: nameOf(path.basename(dir), s.tidyNames),
    subtitle: folderDetail(all.length, s.showProgress ? watched : 0),
    cover: own.find(isVideoFile) ?? coverIn(dir),
    allWatched: all.length > 0 && watched >= all.length,
    shares: groups.map((g) => g.map((p) => shareOf(rows.get(p)))),
  };
}

function videoCards(dir, rows, s) {
  const files = videosIn(dir);
  const names = files.map((f) => path.basename(f));
  const titles = s.tidyNames ? episodes(names) : names.map((n) => nameOf(n, false));
  return files.map((f, i) => {
    const r = rows.get(f);
    return {
      path: f,
      title: titles[i],
      // Numbered by place in the folder: names carry too many other numbers (1080p, 10bit) to guess from.
      badge: s.episodeNumbers && !namesEpisode(titles[i]) ? i + 1 : null,
      audio: !isVideoFile(f),
      position: r?.position ?? 0,
      progress: progressOf(r),
      watched: Boolean(r?.watched),
    };
  });
}

/**
 * Continue watching: videos stopped partway, newest first. A show is picked up where it was last
 * left, so each folder under the root appears once; videos at the top or outside the root stand alone.
 */
function continueWatching(root, s = getSettings()) {
  const rows = userDb()
    .prepare('SELECT path, position, duration, watched FROM media WHERE played_at IS NOT NULL AND position > 0 AND duration > 0 ORDER BY played_at DESC, id DESC')
    .all();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (out.length >= RESUME_KEPT) break;
    if (!isMediaFile(r.path) || !statSafe(r.path)?.isFile()) continue;
    const parent = path.dirname(r.path);
    const inLibrary = Boolean(root) && within(root, parent);
    const inShow = inLibrary && parent !== root;
    const key = inShow ? parent : r.path;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = path.basename(r.path);
    const title = inLibrary ? episodeTitle(name, videosIn(parent).map((f) => path.basename(f)), s.tidyNames) : nameOf(name, s.tidyNames);
    const show = showTitle(inShow ? nameOf(path.basename(parent), s.tidyNames) : null, title);
    const left = timeLeft(r.duration - r.position);
    out.push({
      path: r.path,
      folder: inLibrary ? parent : null,
      title: show ?? title,
      subtitle: show ? `${title} · ${left}` : left,
      position: r.position,
      progress: progressOf(r),
      watched: Boolean(r.watched),
    });
  }
  return out;
}

/** One folder of the library (the root when `dir` is null): its cards, breadcrumbs and, at the root, Continue watching. */
export function browse(dir = null) {
  const s = getSettings();
  const root = libraryRoot();
  if (!root) return { root: null, resume: s.continueWatching ? continueWatching(null, s) : [] };
  const at = dir == null ? root : checkPath(dir);
  if (!statSafe(at)?.isDirectory() || !underRoot(at)) throw new Error('Folder not found');
  const rows = progressRows();
  const folders = foldersIn(at).map((d) => folderCard(d, rows, s));
  const videos = videoCards(at, rows, s);
  const parts = path.relative(root, at).split(path.sep).filter(Boolean);
  return {
    root,
    dir: at,
    // The library's own folder by its name too, as every folder below it; the breadcrumbs say Library.
    title: nameOf(path.basename(at), s.tidyNames) || 'Your library',
    detail: [count(folders.length, 'folder'), count(videos.length, 'video')].filter(Boolean).join(' · '),
    crumbs: [{ path: root, title: 'Library' }, ...parts.map((p, i) => ({ path: path.join(root, ...parts.slice(0, i + 1)), title: nameOf(p, s.tidyNames) }))],
    resume: at === root && s.continueWatching ? continueWatching(root, s) : [],
    folders,
    videos,
  };
}

/** A file, or every video in a folder and the folders under it. */
function targets(p) {
  const abs = checkPath(p);
  return statSafe(abs)?.isDirectory() ? videosUnder(abs) : [abs];
}

/** As if each had played to the end. Videos never opened are registered to hold the mark. */
export function markWatched(p) {
  // No transaction: register() may relink a moved record, which opens its own.
  for (const f of targets(p)) {
    const st = statSafe(f);
    if (st?.isFile()) userDb().prepare('UPDATE media SET watched = 1, position = 0, played_at = NULL WHERE id = ?').run(register(f, st));
  }
}

/** Forgets where each was left and that it was watched: it plays from the start and leaves Continue watching. */
export function clearProgress(p) {
  const db = userDb();
  const files = targets(p);
  transaction(db, () => {
    for (const f of files) db.prepare('UPDATE media SET watched = 0, position = 0, played_at = NULL WHERE path = ?').run(f);
  });
}

/** Takes a video out of Continue watching; where it was left is kept. */
export function forget(p) {
  userDb().prepare('UPDATE media SET played_at = NULL WHERE path = ?').run(checkPath(p));
}
