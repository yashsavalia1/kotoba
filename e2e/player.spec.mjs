import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, invoke, testId, sampleRecord, sampleSubs, video, SAMPLE } from './fixtures.mjs';

test('home renders on a bare launch', async ({ launch }) => {
  const { page } = await launch();
  await expect(await testId(page, 'home')).toBeVisible();
});

test('opens the sample from argv and plays it', async ({ launch }) => {
  const { page } = await launch({ files: [SAMPLE] });
  const rec = await sampleRecord(page);
  const plan = await invoke(page, 'playback:plan', rec.id);
  expect(plan).toMatchObject({ mode: 'stream', reason: 'ac3 audio' });

  const v = await video(page);
  await expect.poll(() => v.evaluate((el) => el.dataset.mode)).toBe('stream');
  await v.evaluate((el) => el.paused && el.play());
  const t0 = await v.evaluate((el) => el.currentTime);
  await expect.poll(() => v.evaluate((el) => el.currentTime), { timeout: 10_000 }).toBeGreaterThan(t0 + 0.5);
  expect(await v.evaluate((el) => ({ muted: el.muted, error: el.error?.message ?? null }))).toEqual({ muted: true, error: null });
});

test('subtitles render, hovering a word shows the dictionary, clicking opens the card maker', async ({ launch }) => {
  const { page } = await launch({ files: [SAMPLE] });
  const rec = await sampleRecord(page);
  const { cues } = await sampleSubs(page, rec.id);
  expect(cues.length).toBeGreaterThan(0);

  const v = await video(page);
  await v.evaluate((el, t) => {
    el.pause();
    el.currentTime = t;
  }, cues[0].start + 0.5);

  const line = await testId(page, 'subtitle-line');
  await expect(line).toBeVisible();
  await expect(line).toContainText(cues[0].text.replace(/\s+/g, '').slice(0, 2));

  const token = line.getByTestId('token').first();
  await token.hover();
  const popup = await testId(page, 'dict-popup');
  await expect(popup).toBeVisible();
  await expect(popup).not.toBeEmpty();

  await token.click();
  await expect(await testId(page, 'card-maker')).toBeVisible();
});

test('transcript and playlist drawers, settings dialog', async ({ launch }) => {
  const { app, page } = await launch({ files: [SAMPLE] });
  await sampleRecord(page);
  await expect(await testId(page, 'player')).toBeVisible();
  await page.keyboard.press('t');
  await expect(await testId(page, 'transcript')).toBeVisible();
  await page.keyboard.press('p');
  await expect(await testId(page, 'playlist')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('evt:command', 'open-settings'));
  await expect(await testId(page, 'settings')).toBeVisible();
});

test('> opens the next file in the folder and keeps a player on screen', async ({ launch, userDataDir }) => {
  const dir = fs.mkdtempSync(path.join(userDataDir, 'folder-'));
  for (const n of ['a', 'b']) fs.copyFileSync(SAMPLE, path.join(dir, `${n}.mkv`));
  const { page } = await launch({ files: [path.join(dir, 'a.mkv')] });
  let v = await video(page);
  await expect.poll(() => v.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Shift+Period');
  await expect.poll(() => page.title()).toContain('b');
  v = await video(page);
  await expect.poll(() => v.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(2);
});

const ffmpegChildren = (pid) => {
  try {
    return execFileSync('pgrep', ['-P', String(pid), '-x', 'ffmpeg']).toString().trim().split('\n').length;
  } catch {
    return 0;
  }
};

test('stream mode seeks land in media time and cancelling a stream kills its ffmpeg', async ({ launch }) => {
  const { app, page } = await launch({ files: [SAMPLE] });
  const rec = await sampleRecord(page);
  const v = await video(page);
  await expect.poll(() => v.evaluate((el) => el.dataset.mode)).toBe('stream');
  for (const t of [25, 5, 15]) {
    await v.evaluate((el, t) => (el.currentTime = t), t);
    await expect.poll(() => v.evaluate((el) => !el.seeking && el.readyState >= 3)).toBe(true);
    expect(Math.abs((await v.evaluate((el) => el.currentTime)) - t)).toBeLessThan(0.5);
  }
  await page.evaluate(async (id) => {
    const reader = (await fetch(`kotoba://stream/${id}?start=5`)).body.getReader();
    await reader.read();
    await reader.cancel();
  }, rec.id);
  await expect.poll(() => ffmpegChildren(app.process().pid)).toBe(0);
});
