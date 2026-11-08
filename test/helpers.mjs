import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configurePaths, ROOT } from '../src/core/paths.mjs';

// Each test file gets a throwaway user database; the dictionary is shared and read-only.
configurePaths({
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-test-')),
  dictDbPath: process.env.KOTOBA_DICT_DB || path.join(ROOT, 'data', 'dict.db'),
});

export const SAMPLE = path.join(ROOT, 'sample', 'Shoujiki S01E01.mkv');
