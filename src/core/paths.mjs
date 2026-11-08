import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const state = {
  userDataDir: process.env.KOTOBA_USER_DATA || path.join(ROOT, 'data', 'dev-user'),
  dictDbPath: process.env.KOTOBA_DICT_DB || path.join(ROOT, 'data', 'dict.db'),
  tempDir: path.join(os.tmpdir(), 'kotoba'),
};

// Core modules never import Electron; main (or a test) calls this before touching a database.
export function configurePaths(patch = {}) {
  Object.assign(state, Object.fromEntries(Object.entries(patch).filter(([, v]) => v)));
}

export const paths = {
  get userDataDir() {
    fs.mkdirSync(state.userDataDir, { recursive: true });
    return state.userDataDir;
  },
  get dictDbPath() {
    return state.dictDbPath;
  },
  get tempDir() {
    fs.mkdirSync(state.tempDir, { recursive: true });
    return state.tempDir;
  },
};
