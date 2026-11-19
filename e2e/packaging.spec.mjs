import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, invoke, ROOT } from './fixtures.mjs';
import { MEDIA_EXTS } from '../src/core/media.mjs';
import { SUB_EXTS } from '../src/core/subs.mjs';

test('fileAssociations cover every media and subtitle extension', ({ executable }) => {
  test.skip(Boolean(executable), 'config check runs once, in the dev project');
  const { build } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const exts = build.fileAssociations.flatMap((a) => a.ext.map((e) => `.${e}`));
  expect(new Set(exts)).toEqual(new Set([...MEDIA_EXTS, ...SUB_EXTS]));
  expect(build.fileAssociations.every((a) => a.role === 'Viewer' && a.rank === 'Alternate')).toBe(true);
});

test('packaged app uses bundled native ffmpeg/ffprobe and a read-only dictionary', async ({ executable, launch }) => {
  test.skip(!executable, 'packaged project only');
  const { app, page } = await launch();
  expect(await invoke(page, 'app:status')).toMatchObject({ dictReady: true });

  const info = await app.evaluate(async ({ app }, urls) => {
    // evaluate() has no dynamic import; require(esm) shares the app's module instances.
    const req = process.getBuiltinModule('node:module').createRequire(urls.ffmpeg);
    const ff = req(urls.ffmpeg);
    const db = req(urls.db);
    let writeError = null;
    try {
      db.dictDb().exec('CREATE TABLE e2e_probe (x)');
    } catch (e) {
      writeError = e.message;
    }
    return {
      isPackaged: app.isPackaged,
      resources: process.resourcesPath,
      bins: { ffmpeg: ff.ffmpeg(), ffprobe: ff.ffprobe() },
      writeError,
    };
  }, {
    ffmpeg: path.join(ROOT, executable, '../../Resources/app.asar/src/core/ffmpeg.mjs'),
    db: path.join(ROOT, executable, '../../Resources/app.asar/src/core/db.mjs'),
  });

  expect(info.isPackaged).toBe(true);
  expect(info.bins.ffmpeg).toBe(path.join(info.resources, 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg'));
  expect(info.bins.ffprobe).toBe(path.join(info.resources, 'bin/ffprobe'));
  for (const bin of Object.values(info.bins)) expect(execFileSync('lipo', ['-archs', bin]).toString().trim()).toBe(process.arch);
  expect(info.writeError).toMatch(/readonly/i);
});
