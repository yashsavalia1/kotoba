import { test, expect, invoke, sampleRecord, sampleSubs, SAMPLE } from './fixtures.mjs';

const opacity = (loc) => loc.evaluate((el) => Number(getComputedStyle(el).opacity));

async function onFirstLine(page) {
  const rec = await sampleRecord(page);
  const { cues } = await sampleSubs(page, rec.id);
  const v = page.locator('[data-testid=player] video');
  await v.evaluate((el, t) => {
    el.pause();
    el.currentTime = t;
  }, cues[0].start + 0.5);
  const line = page.getByTestId('subtitle-line');
  await expect(line).toBeVisible();
  return { rec, line, words: line.locator('.layer.line'), peek: page.getByTestId('peek-line') };
}

test('holding I swaps the line for its translation in place, releasing swaps back', async ({ launch }) => {
  const { page } = await launch({ files: [SAMPLE] });
  const { rec, line, words, peek } = await onFirstLine(page);
  const tracks = await invoke(page, 'subs:tracks', rec.id);
  await expect(peek).not.toBeEmpty();
  if (tracks.length > 1) await expect(peek).not.toContainText('No translation track');
  const box = await line.boundingBox();

  await page.keyboard.down('i');
  await expect.poll(() => opacity(peek)).toBe(1);
  await expect.poll(() => opacity(words)).toBe(0);
  // Same box: the translation fades in where the line was, nothing below it.
  expect(await line.boundingBox()).toEqual(box);

  await page.keyboard.up('i');
  await expect.poll(() => opacity(peek)).toBe(0);
  await expect.poll(() => opacity(words)).toBe(1);
});

test('a long press on the line peeks and does not open the card maker', async ({ launch }) => {
  const { page } = await launch({ files: [SAMPLE] });
  const { line, peek } = await onFirstLine(page);
  const token = line.getByTestId('token').first();
  const b = await token.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect.poll(() => opacity(peek)).toBe(1);
  await page.mouse.up();
  await expect.poll(() => opacity(peek)).toBe(0);
  await expect(page.getByTestId('card-maker')).toHaveCount(0);

  await token.click();
  await expect(page.getByTestId('card-maker')).toBeVisible();
});
