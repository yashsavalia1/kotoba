import { invoke } from './ipc.js';

export const getStatus = () => invoke('app:status');
export const getSettings = () => invoke('settings:get');
export const setSettings = (patch) => invoke('settings:set', patch);
export const setApiKey = (key) => invoke('settings:setApiKey', key);
export const lookupWord = (word) => invoke('dict:lookup', word);
export const tokenize = (text) => invoke('dict:tokenize', text);
export const previewCards = (req) => invoke('cards:preview', req);
export const createCards = (req) => invoke('cards:create', req);
export const minedWords = () => invoke('cards:minedWords');
export const ankiSetup = () => invoke('anki:setup');
