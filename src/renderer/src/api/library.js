import { invoke } from './ipc.js';

export const getMedia = (id) => invoke('library:get', id);
export const openPaths = (paths) => invoke('library:open', paths);
export const siblings = (id) => invoke('library:siblings', id);
export const adjacent = (id, delta) => invoke('library:adjacent', id, delta);
export const openSibling = (absPath) => invoke('library:openSibling', absPath);
export const locate = (id, newPath) => invoke('library:locate', id, newPath);
export const setPosition = (id, position, duration) => invoke('library:setPosition', id, position, duration);
export const setPrefs = (id, patch) => invoke('library:setPrefs', id, patch);
export const reveal = (id) => invoke('library:reveal', id);
export const classify = (paths) => invoke('files:classify', paths);

export const browse = (dir) => invoke('library:browse', dir ?? null);
export const markWatched = (path) => invoke('library:markWatched', path);
export const clearProgress = (path) => invoke('library:clearProgress', path);
export const forget = (path) => invoke('library:forget', path);
export const revealPath = (path) => invoke('library:revealPath', path);
export const copyPath = (path) => invoke('library:copyPath', path);
export const chooseLibraryRoot = () => invoke('dialog:libraryRoot');
/** A library frame: the video's own, or with `at` (seconds) the one where it was left. */
export const thumbUrl = (path, at = 0) => `kotoba://thumb/?path=${encodeURIComponent(path)}${at > 0 ? `&at=${Math.floor(at)}` : ''}`;

export const subtitleTracks = (id) => invoke('subs:tracks', id);
export const loadSubtitles = (id, key) => invoke('subs:load', id, key);
export const attachSubtitle = (id, file) => invoke('subs:attach', id, file);

export const openMediaDialog = () => invoke('dialog:openMedia');
export const attachSubtitleDialog = (id) => invoke('dialog:attachSubtitle', id);
export const locateDialog = (id) => invoke('dialog:locateMedia', id);
