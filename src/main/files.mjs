import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, shell } from 'electron';
import * as library from '../core/library.mjs';
import { tokenize } from '../core/dict.mjs';
import { recordCues } from '../core/corpus.mjs';
import { isMediaFile } from '../core/media.mjs';
import { SUB_EXTS } from '../core/subs.mjs';
import { handle } from './ipc-util.mjs';

const isSub = (p) => SUB_EXTS.includes(path.extname(p).toLowerCase());

function expand(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(p).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        if (!n.startsWith('.') && isMediaFile(n)) out.push(path.join(p, n));
      }
    } else if (isMediaFile(p)) {
      out.push(p);
    }
  }
  return out;
}

/** Entry point for every way a file arrives: Finder, dock, argv, menu, dialog, drag-drop. */
export function openPaths(ctx, paths) {
  const records = [];
  for (const p of expand(paths)) {
    try {
      records.push(library.openMedia(p));
      app.addRecentDocument(p);
    } catch (e) {
      console.error('[kotoba] open failed:', p, e.message);
    }
  }
  if (records.length) ctx.send('evt:open-media', { id: records[0].id, ids: records.map((r) => r.id) });
  return records;
}

export function argvFiles(argv, cwd = process.cwd()) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-'))
    .map((a) => path.resolve(cwd, a))
    .filter((a) => fs.existsSync(a));
}

export async function openMediaDialog(ctx, { folders = false } = {}) {
  const res = await dialog.showOpenDialog(ctx.getWindow(), {
    properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    filters: folders ? [] : [{ name: 'Media', extensions: ['*'] }],
  });
  return res.canceled ? [] : openPaths(ctx, res.filePaths);
}

export function registerLibraryIpc(ctx) {
  handle('library:list', () => library.listMedia());
  handle('library:get', (id) => library.getMedia(id));
  handle('library:remove', (id) => library.removeMedia(id));
  handle('library:open', (paths) => openPaths(ctx, paths ?? []));
  handle('library:siblings', (id) => library.siblings(id));
  handle('library:openSibling', (absPath) => {
    const dirs = new Set(library.listMedia({ limit: 10000 }).map((m) => m.folder));
    if (!dirs.has(path.dirname(path.resolve(absPath)))) throw new Error('not in a folder you have opened');
    return library.openMedia(absPath);
  });
  handle('library:setPosition', (id, position, duration) => library.setPosition(id, position, duration));
  handle('library:setPrefs', (id, patch) => library.setPrefs(id, patch));
  handle('library:reveal', (id) => shell.showItemInFolder(library.pathOf(id)));

  handle('subs:tracks', (id) => library.subtitleTracks(id));
  handle('subs:load', async (id, key) => {
    const cues = await library.loadSubtitleTrack(id, key);
    if (cues.length) recordCues(Number(id), cues);
    return { key, cues, tokens: cues.map((c) => tokenize(c.text)) };
  });
  handle('subs:attach', (id, file) => library.attachSubtitle(id, file));

  handle('dialog:openMedia', () => openMediaDialog(ctx));
  handle('dialog:openFolder', () => openMediaDialog(ctx, { folders: true }));
  handle('dialog:attachSubtitle', async (id) => {
    const res = await dialog.showOpenDialog(ctx.getWindow(), {
      properties: ['openFile'],
      defaultPath: path.dirname(library.pathOf(id)),
      filters: [{ name: 'Subtitles', extensions: SUB_EXTS.map((e) => e.slice(1)) }],
    });
    return res.canceled ? null : library.attachSubtitle(id, res.filePaths[0]);
  });
  handle('files:classify', (paths) => (paths ?? []).map((p) => ({ path: p, kind: isSub(p) ? 'subtitle' : isMediaFile(p) ? 'media' : fs.existsSync(p) && fs.statSync(p).isDirectory() ? 'folder' : 'other' })));
}
