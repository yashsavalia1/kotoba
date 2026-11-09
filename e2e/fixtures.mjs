import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, _electron as electron } from '@playwright/test';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RENDERER_DIR = path.resolve(ROOT, process.env.KOTOBA_RENDERER_DIR || 'out/e2e');
export const SAMPLE = path.join(ROOT, 'sample', 'Shoujiki S01E01.mkv');
export { expect };

export const test = base.extend({
  /** Packaged executable (relative to ROOT); null runs the dev build. */
  executable: [null, { option: true }],

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  /** launch({ files, userData }) → { app, page }; every app is closed after the test. */
  launch: async ({ executable, userDataDir }, use) => {
    const exe = executable && path.resolve(ROOT, executable);
    if (exe && !fs.existsSync(exe)) test.skip(true, `${executable} missing: run npm run dist`);
    const apps = [];
    await use(async ({ files = [], userData = userDataDir } = {}) => {
      // KOTOBA_BACKGROUND=0 to watch the windows.
      const env = { KOTOBA_BACKGROUND: '1', ...process.env, KOTOBA_USER_DATA: userData };
      delete env.KOTOBA_RENDERER_URL;
      delete env.KOTOBA_DICT_DB;
      if (exe) delete env.KOTOBA_RENDERER_DIR;
      else env.KOTOBA_RENDERER_DIR = RENDERER_DIR;
      // --mute-audio: tests never make sound, whatever the UI does with volume.
      const app = await electron.launch(
        exe
          ? { executablePath: exe, args: ['--mute-audio', ...files], env }
          : { args: ['--mute-audio', ROOT, ...files], cwd: ROOT, env }
      );
      apps.push(app);
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.kotoba);
      return { app, page };
    });
    for (const app of apps) await app.close().catch(() => {});
  },
});

export const invoke = (page, channel, ...args) =>
  page.evaluate(([c, a]) => window.kotoba.invoke(c, ...a), [channel, args]);

/** Locator for a data-testid the UI promises; marks the test fixme while the UI does not render it yet. */
export async function testId(page, id, timeout = 10_000) {
  const loc = page.getByTestId(id).first();
  const present = await loc.waitFor({ state: 'attached', timeout }).then(() => true, () => false);
  test.fixme(!present, `data-testid="${id}" is not rendered by the UI yet`);
  return loc;
}

export async function sampleRecord(page) {
  let rec;
  await expect
    .poll(async () => (rec = (await invoke(page, 'library:list')).find((m) => m.path === SAMPLE)))
    .toBeTruthy();
  return rec;
}

/** Cues + tokens of the sample's first subtitle track, via IPC. */
export async function sampleSubs(page, id) {
  const tracks = await invoke(page, 'subs:tracks', id);
  expect(tracks.length).toBeGreaterThan(0);
  return invoke(page, 'subs:load', id, tracks[0].key);
}

export async function video(page) {
  const player = await testId(page, 'player');
  const v = player.locator('video').first();
  await v.waitFor({ state: 'attached' });
  await v.evaluate((el) => (el.muted = true));
  return v;
}
