import { test, expect, invoke, testId, sampleRecord, sampleSubs, video, SAMPLE } from './fixtures.mjs';

test('home renders on a bare launch', async ({ launch }) => {
  const { page } = await launch();
  await expect(await testId(page, 'home')).toBeVisible();
});

test('opens the sample from argv and plays it', async ({ launch }) => {
  const { page } = await launch({ files: [SAMPLE] });
  const rec = await sampleRecord(page);
  const plan = await invoke(page, 'playback:plan', rec.id);
  expect(plan.url).toMatch(/^kotoba:\/\/media\//);

  const v = await video(page);
  await expect.poll(() => v.evaluate((el) => el.currentSrc)).toMatch(/^kotoba:\/\/media\//);
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
