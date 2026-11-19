import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, invoke, testId, sampleRecord, sampleSubs, video, SAMPLE } from './fixtures.mjs';
import { ffmpeg } from '../src/core/ffmpeg.mjs';

/** A 4 s test file made with the app's ffmpeg: `codecs` are output args such as -c:v / -c:a. */
function makeMedia(file, ...codecs) {
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=4', '-f', 'lavfi', '-i', 'sine=d=4', ...codecs, file]);
  return file;
}

test('home renders on a bare launch', async ({ launch }) => {
  const { page } = await launch();
  await expect(await testId(page, 'home')).toBeVisible();
});

test('opens the sample from argv and plays it', async ({ launch }) => {
  const { page } = await launch({ files: [SAMPLE] });
  const rec = await sampleRecord(page);
  const plan = await invoke(page, 'playback:plan', rec.id);
  expect(plan).toMatchObject({ video: { codec: 'h264' }, audio: { codec: 'aac' }, unsupported: null });

  const v = await video(page);
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
  // Closing a drawer runs its effect cleanups; one returning a scroll Promise blanked the app.
  await page.keyboard.press('p');
  await expect(page.getByTestId('playlist')).toHaveCount(0);
  await expect(page.getByTestId('player')).toBeVisible();
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

test('a file Chromium plays nothing of says why instead of a black screen', async ({ launch, userDataDir }) => {
  const file = makeMedia(path.join(userDataDir, 'dvd.mkv'), '-c:v', 'mpeg2video', '-c:a', 'ac3');
  const { page } = await launch({ files: [file] });
  const box = await testId(page, 'unplayable');
  await expect(box).toContainText("Kotoba can't play this file");
  await expect(box).toContainText("MPEG-2 video isn't supported");
  await expect(page.locator('[data-testid=player] video')).toHaveCount(0);
});

test('a file whose audio Chromium cannot decode plays its video with a notice', async ({ launch, userDataDir }) => {
  const file = makeMedia(path.join(userDataDir, 'bd.mkv'), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3');
  const { page } = await launch({ files: [file] });
  await expect(page.locator('.toast', { hasText: "AC3 audio isn't supported." })).toBeVisible();
  const v = await video(page);
  await v.evaluate((el) => el.paused && el.play());
  await expect.poll(() => v.evaluate((el) => el.currentTime)).toBeGreaterThan(0.5);
  await expect(page.getByTestId('unplayable')).toHaveCount(0);
});

test('a file of another type is refused with a toast, from argv and from Open File', async ({ launch, userDataDir }) => {
  const avi = path.join(userDataDir, 'old.avi');
  fs.writeFileSync(avi, 'RIFF');
  const { app, page } = await launch({ files: [avi] });
  const toast = page.locator('.toast', { hasText: "Kotoba can't play .avi files." });
  await expect(toast).toBeVisible();
  await expect(await testId(page, 'home')).toBeVisible();
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);

  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, avi);
  expect(await invoke(page, 'dialog:openMedia')).toEqual([]);
  await expect(toast).toBeVisible();
  expect((await invoke(page, 'library:list')).map((m) => m.path)).not.toContain(avi);
});

test('embedded text subtitles load and render', async ({ launch, userDataDir }) => {
  const file = path.join(userDataDir, 'Embedded.mkv');
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-i', SAMPLE, '-i', SAMPLE.replace(/\.mkv$/, '.ja.srt'),
    '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'srt', '-metadata:s:s:0', 'language=jpn', file,
  ]);
  const { page } = await launch({ files: [file] });
  let rec;
  await expect.poll(async () => (rec = (await invoke(page, 'library:list')).find((m) => m.path === file))).toBeTruthy();
  const tracks = await invoke(page, 'subs:tracks', rec.id);
  expect(tracks.map((t) => [t.key, t.source])).toEqual([['stream:2', 'embedded']]);
  const { cues } = await invoke(page, 'subs:load', rec.id, 'stream:2');
  expect(cues.length).toBeGreaterThan(0);

  const v = await video(page);
  await v.evaluate((el, t) => {
    el.pause();
    el.currentTime = t;
  }, cues[0].start + 0.5);
  await expect(await testId(page, 'subtitle-line')).toContainText(cues[0].text.replace(/\s+/g, '').slice(0, 2));
});

test('renderer errors land in main.log', async ({ launch, userDataDir }) => {
  const { page } = await launch();
  await page.evaluate(() => console.error('log-probe'));
  await expect.poll(() => fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8')).toContain('[renderer] log-probe');
});
