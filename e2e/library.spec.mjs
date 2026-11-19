import fs from 'node:fs';
import path from 'node:path';
import { test, expect, video, SAMPLE } from './fixtures.mjs';

/** Library/Shoujiki/Season 1/{01,02}.mkv and a loose film, all copies of the 34 s sample. */
function libraryTree(userDataDir) {
  const root = fs.mkdtempSync(path.join(userDataDir, 'lib-'));
  const season = path.join(root, '[Grp] Shoujiki (BD 1080p)', 'Season 1');
  fs.mkdirSync(season, { recursive: true });
  for (const n of ['01', '02']) fs.copyFileSync(SAMPLE, path.join(season, `[Grp] Shoujiki - ${n} [1080p].mkv`));
  fs.copyFileSync(SAMPLE, path.join(root, 'Film.mkv'));
  return root;
}

test('library: choose the root, browse, thumbnails, back to the folder, Continue watching, mark watched', async ({ launch, userDataDir }) => {
  test.setTimeout(90_000);
  const root = libraryTree(userDataDir);
  const { app, page } = await launch();
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, root);

  await page.getByRole('button', { name: 'Choose folder' }).click();
  await expect(page.getByTestId('page-title')).toHaveText(path.basename(root));
  await page.getByTestId('folder-card').filter({ hasText: 'Shoujiki' }).click();
  await expect(page.getByTestId('crumbs')).toHaveText(/Library\s*\/\s*Shoujiki/);
  await page.getByTestId('folder-card').filter({ hasText: 'Season 1' }).click();
  await expect(page.getByTestId('page-title')).toHaveText('Season 1');
  const cards = page.getByTestId('video-card');
  await expect(cards).toHaveText([/Episode 1/, /Episode 2/]);

  const thumb = cards.first().locator('img');
  await expect.poll(() => thumb.evaluate((img) => img.complete && img.naturalWidth), { timeout: 20_000 }).toBe(480);

  // A sitting must outlast a quick look (a quarter of 34 s) and stop before the credits (the last 30 s).
  await cards.first().click();
  const v = await video(page);
  await expect.poll(() => v.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(1);
  await v.evaluate((el) => {
    el.pause();
    el.currentTime = 2;
  });
  await page.waitForTimeout(9_000);
  await page.getByRole('button', { name: /Back to library/ }).click();
  await expect(page.getByTestId('page-title')).toHaveText('Season 1');

  await page.getByTestId('crumbs').getByRole('button', { name: 'Library' }).click();
  const resume = page.getByTestId('resume-card');
  await expect(resume).toHaveCount(1);
  await expect(resume).toContainText('Season 1');
  await expect(resume).toContainText('Episode 1');

  await page.getByTestId('folder-card').filter({ hasText: 'Shoujiki' }).click();
  await page.getByTestId('folder-card').filter({ hasText: 'Season 1' }).click();
  const second = page.getByTestId('video-card').nth(1);
  await expect(second.getByTestId('watched-tick')).toHaveCount(0);
  await second.click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('button', { name: 'Mark as watched' }).click();
  await expect(second.getByTestId('watched-tick')).toBeVisible();
});
