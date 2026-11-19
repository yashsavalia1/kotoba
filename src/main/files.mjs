import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, shell } from 'electron';
import * as library from '../core/library.mjs';
import * as browse from '../core/browse.mjs';
import { tokenize } from '../core/dict.mjs';
import { recordCues } from '../core/corpus.mjs';
import { getSettings, setLibraryRoot } from '../core/settings.mjs';
import { extOf, isMediaFile } from '../core/media.mjs';
import { SUB_EXTS } from '../core/subs.mjs';
import { handle } from './ipc-util.mjs';

const MAX_PATHS = 1000;

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

const cleanPaths = (paths) =>
  [...new Set((Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).slice(0, MAX_PATHS).map((p) => path.resolve(p)))];

const SKIP_DIRS = /^(subs?|subtitles?|extras?|featurettes?|samples?|bonus)$/i;

/** First media file of a folder in natural order, descending into subfolders (Season 1/) when it has none. */
function firstMediaIn(dir, budget = { dirs: 200 }, depth = 0) {
  if (--budget.dirs < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  } catch {
    return null;
  }
  entries.sort((a, b) => library.naturalCompare(a.name, b.name));
  const file = entries.find((e) => isMediaFile(e.name) && statSafe(path.join(dir, e.name))?.isFile());
  if (file) return path.join(dir, file.name);
  if (depth >= 2) return null;
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.test(e.name)) continue;
    const found = firstMediaIn(path.join(dir, e.name), budget, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Entry point for every way a file arrives: Finder, dock, argv, menu, dialog, drag-drop.
 * A folder opens its first item; the rest of it is reachable via siblings/adjacent.
 * Subtitle files arriving with media are attached to the first opened file; files of
 * any other type are refused with an evt:error.
 */
export function openPaths(ctx, paths) {
  const records = [];
  const subs = [];
  const refused = new Set();
  for (const p of cleanPaths(paths)) {
    const st = statSafe(p);
    if (!st) continue;
    if (st.isFile() && library.isSubtitleFile(p)) {
      subs.push(p);
      continue;
    }
    const file = st.isDirectory() ? firstMediaIn(p) : p;
    if (!file) continue;
    if (!isMediaFile(file)) {
      refused.add(extOf(file) || path.basename(file));
      continue;
    }
    try {
      const record = library.openMedia(file);
      if (!records.some((r) => r.id === record.id)) records.push(record);
      app.addRecentDocument(file);
    } catch (e) {
      console.error('[kotoba] open failed:', file, e.message);
    }
  }
  if (refused.size) ctx.send('evt:error', `Kotoba can't play ${[...refused].join(', ')} files.`);
  if (!records.length) return records;
  for (const s of subs) {
    try {
      library.attachSubtitle(records[0].id, s);
    } catch (e) {
      console.error('[kotoba] attach failed:', s, e.message);
    }
  }
  ctx.send('evt:open-media', { id: records[0].id, ids: records.map((r) => r.id) });
  return records;
}

export function argvFiles(argv, cwd = process.cwd()) {
  const appPath = path.resolve(app.getAppPath());
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => typeof a === 'string' && a && !a.startsWith('-'))
    .map((a) => path.resolve(cwd, a))
    .filter((a) => a !== appPath && fs.existsSync(a));
}

export async function openMediaDialog(ctx) {
  const res = await dialog.showOpenDialog(ctx.getWindow(), {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['*'] }],
  });
  return res.canceled ? [] : openPaths(ctx, res.filePaths);
}

function classify(p) {
  const st = typeof p === 'string' && p ? statSafe(p) : null;
  if (!st) return 'other';
  if (st.isDirectory()) return 'folder';
  if (!st.isFile()) return 'other';
  return library.isSubtitleFile(p) ? 'subtitle' : isMediaFile(p) ? 'media' : 'other';
}

export function registerLibraryIpc(ctx) {
  handle('library:list', () => library.listMedia());
  handle('library:get', (id) => library.getMedia(id));
  handle('library:remove', (id) => void library.removeMedia(id));
  handle('library:clearHistory', () => {
    library.clearHistory();
    app.clearRecentDocuments();
  });
  handle('library:open', (paths) => openPaths(ctx, paths));
  handle('library:siblings', (id) => library.siblings(id));
  handle('library:adjacent', (id, delta) => {
    const record = library.adjacent(id, delta);
    if (record) app.addRecentDocument(record.path);
    return record;
  });
  handle('library:openSibling', (absPath) => {
    if (typeof absPath !== 'string') throw new Error('path required');
    if (!library.isKnownFolder(path.dirname(path.resolve(absPath)))) throw new Error('not in a folder you have opened');
    const record = library.openMedia(absPath);
    app.addRecentDocument(record.path);
    return record;
  });
  handle('library:locate', (id, newPath) => {
    if (typeof newPath !== 'string') throw new Error('path required');
    const record = library.locateMedia(id, newPath);
    app.addRecentDocument(record.path);
    return record;
  });
  handle('library:setPosition', (id, position, duration) => library.setPosition(id, position, duration));
  handle('library:setPrefs', (id, patch) => library.setPrefs(id, patch));
  handle('library:reveal', (id) => {
    const abs = library.pathOf(id);
    if (fs.existsSync(abs)) shell.showItemInFolder(abs);
    else if (fs.existsSync(path.dirname(abs))) shell.openPath(path.dirname(abs));
  });

  handle('library:browse', (dir) => browse.browse(dir ?? null));
  handle('library:markWatched', (p) => browse.markWatched(p));
  handle('library:clearProgress', (p) => browse.clearProgress(p));
  handle('library:forget', (p) => browse.forget(p));
  handle('library:revealPath', (p) => shell.showItemInFolder(browse.checkPath(p)));
  handle('library:copyPath', (p) => clipboard.writeText(browse.checkPath(p)));

  handle('subs:tracks', (id) => library.subtitleTracks(id));
  handle('subs:load', async (id, key) => {
    const { track, cues } = await library.loadSubtitleTrack(id, key);
    // Only target-language lines feed the corpus; a reference (English) track would pollute it.
    const target = getSettings().targetLang;
    if (cues.length && (track.language == null || track.language === target)) recordCues(Number(id), cues);
    return { key, language: track.language, cues, tokens: cues.map((c) => tokenize(c.text)) };
  });
  handle('subs:attach', (id, file) => {
    if (typeof file !== 'string') throw new Error('path required');
    return library.attachSubtitle(id, file);
  });

  handle('dialog:openMedia', () => openMediaDialog(ctx));
  handle('dialog:libraryRoot', async () => {
    const current = browse.libraryRoot();
    const res = await dialog.showOpenDialog(ctx.getWindow(), {
      title: 'Choose your media folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(current ? { defaultPath: current } : {}),
    });
    return res.canceled ? null : setLibraryRoot(res.filePaths[0]);
  });
  handle('dialog:attachSubtitle', async (id) => {
    const res = await dialog.showOpenDialog(ctx.getWindow(), {
      properties: ['openFile'],
      defaultPath: path.dirname(library.pathOf(id)),
      filters: [{ name: 'Subtitles', extensions: SUB_EXTS.map((e) => e.slice(1)) }],
    });
    return res.canceled ? null : library.attachSubtitle(id, res.filePaths[0]);
  });
  handle('dialog:locateMedia', async (id) => {
    const old = library.pathOf(id);
    const dir = path.dirname(old);
    const res = await dialog.showOpenDialog(ctx.getWindow(), {
      title: `Locate ${path.basename(old)}`,
      properties: ['openFile'],
      ...(fs.existsSync(dir) ? { defaultPath: dir } : {}),
    });
    if (res.canceled) return null;
    const record = library.locateMedia(id, res.filePaths[0]);
    app.addRecentDocument(record.path);
    return record;
  });
  handle('files:classify', (paths) => (Array.isArray(paths) ? paths.slice(0, MAX_PATHS) : []).map((p) => ({ path: p, kind: classify(p) })));
}
