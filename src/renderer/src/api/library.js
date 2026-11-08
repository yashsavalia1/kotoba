import { invoke } from './ipc.js';

export const listMedia = () => invoke('library:list');
export const getMedia = (id) => invoke('library:get', id);
export const removeMedia = (id) => invoke('library:remove', id);
export const openPaths = (paths) => invoke('library:open', paths);
export const siblings = (id) => invoke('library:siblings', id);
export const openSibling = (absPath) => invoke('library:openSibling', absPath);
export const setPosition = (id, position, duration) => invoke('library:setPosition', id, position, duration);
export const setPrefs = (id, patch) => invoke('library:setPrefs', id, patch);
export const reveal = (id) => invoke('library:reveal', id);
export const classify = (paths) => invoke('files:classify', paths);

export const subtitleTracks = (id) => invoke('subs:tracks', id);
export const loadSubtitles = (id, key) => invoke('subs:load', id, key);
export const attachSubtitle = (id, file) => invoke('subs:attach', id, file);

export const openMediaDialog = () => invoke('dialog:openMedia');
export const openFolderDialog = () => invoke('dialog:openFolder');
export const attachSubtitleDialog = (id) => invoke('dialog:attachSubtitle', id);
