import { spawn } from 'node:child_process';
import path from 'node:path';
import { test, expect, invoke, sampleRecord, sampleSubs, ROOT, SAMPLE } from './fixtures.mjs';
import { startMockAnki } from '../scripts/mock-anki.mjs';

const MOCK_ANKI = 'http://127.0.0.1:8771';
const LOCAL_TYPES = ['ContextCloze', 'ReadingContrast', 'Audio', 'Production', 'Collocation', 'Image', 'MinimalPair', 'Prediction', 'ReverseContext'];

/** First cue and the first token in it with a dictionary entry. */
async function minable(page) {
  const rec = await sampleRecord(page);
  const { cues, tokens } = await sampleSubs(page, rec.id);
  const cueIndex = tokens.findIndex((ts) => ts.some((t) => t.entries?.length));
  const token = tokens[cueIndex].find((t) => t.entries?.length);
  return { mediaId: rec.id, cue: cues[cueIndex], cueIndex, word: token.text };
}

test('status: dictionary ready', async ({ launch }) => {
  const { page } = await launch();
  const status = await invoke(page, 'app:status');
  expect(status).toMatchObject({ dictReady: true });
  const entries = await invoke(page, 'dict:lookup', '正直');
  expect(entries[0].glossText).toMatch(/honest/i);
});

test('card preview builds every local card type', async ({ launch }) => {
  test.setTimeout(90_000);
  const { page } = await launch({ files: [SAMPLE] });
  const req = await minable(page);
  const { cards, skipped } = await invoke(page, 'cards:preview', { ...req, types: LOCAL_TYPES });
  const built = Object.fromEntries(cards.map((c) => [c.type, c]));
  expect(Object.keys(built)).toEqual(expect.arrayContaining(['ContextCloze', 'Audio', 'Image', 'ReverseContext']));
  expect(built.ContextCloze.media).toEqual(expect.arrayContaining(['audio', 'picture']));
  expect(built.Image.media).toContain('picture');
  for (const s of skipped) expect(s.reason, s.type).toBeTruthy();
  expect(cards.length + skipped.length).toBe(LOCAL_TYPES.length);
});

test('cards:create sends Anki the audio clip and the screenshot', async ({ launch }) => {
  test.setTimeout(90_000);
  const mock = await startMockAnki();
  try {
    const { page } = await launch({ files: [SAMPLE] });
    await invoke(page, 'settings:set', { ankiConnect: mock.url });
    await invoke(page, 'anki:setup');
    const { added } = await invoke(page, 'cards:create', { ...(await minable(page)), types: ['ContextCloze'] });
    expect(added).toHaveLength(1);
    const [note] = mock.state.notes;
    expect(note.audio.map((m) => m.filename)).toEqual([expect.stringMatching(/\.mp3$/)]);
    expect(note.picture.map((m) => m.filename)).toEqual([expect.stringMatching(/\.jpg$/)]);
    for (const m of [...note.audio, ...note.picture]) expect(mock.state.media.get(m.filename).length).toBeGreaterThan(1000);
  } finally {
    await mock.close();
  }
});

test('settings persist across a restart', async ({ launch }) => {
  const patch = { deckName: 'E2E Deck', subtitleFontSize: 37, pauseOnHover: true };
  const first = await launch();
  await invoke(first.page, 'settings:set', patch);
  await first.app.close();
  const second = await launch();
  expect(await invoke(second.page, 'settings:get')).toMatchObject(patch);
});

test.describe('with mock AnkiConnect', () => {
  let mock;
  test.beforeAll(async () => {
    const up = () => fetch(MOCK_ANKI, { method: 'POST', body: '{"action":"version"}' }).then((r) => r.ok, () => false);
    if (await up()) return;
    mock = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts', 'mock-anki.mjs'), '8771'], { stdio: 'ignore' });
    await expect.poll(up).toBe(true);
  });
  test.afterAll(() => mock?.kill());

  test('cards:create adds notes', async ({ launch }) => {
    test.setTimeout(90_000);
    const { page } = await launch({ files: [SAMPLE] });
    await invoke(page, 'settings:set', { ankiConnect: MOCK_ANKI, deckName: 'Kotoba E2E' });
    expect((await invoke(page, 'app:status')).anki).toBe(6);
    await invoke(page, 'anki:setup');
    const req = await minable(page);
    const { added, skipped } = await invoke(page, 'cards:create', { ...req, types: ['ContextCloze', 'Audio'] });
    expect(skipped).toEqual([]);
    expect(added.map((a) => a.type).sort()).toEqual(['Audio', 'ContextCloze']);
    expect(added.every((a) => a.noteId)).toBe(true);
    expect(await invoke(page, 'cards:minedWords')).toContain(req.word);
  });

  test('a card Anki calls a duplicate is held, then added anyway or without asking', async ({ launch }) => {
    test.setTimeout(90_000);
    const { page } = await launch({ files: [SAMPLE] });
    await invoke(page, 'settings:set', { ankiConnect: MOCK_ANKI, deckName: `Kotoba E2E dup ${Date.now()}` });
    await invoke(page, 'anki:setup');
    const req = { ...(await minable(page)), types: ['ContextCloze'] };
    expect((await invoke(page, 'cards:create', req)).added).toHaveLength(1);
    expect(await invoke(page, 'cards:create', req)).toMatchObject({ added: [], skipped: [], duplicates: ['ContextCloze'] });
    expect((await invoke(page, 'cards:create', { ...req, allowDuplicates: true })).added).toHaveLength(1);
    await invoke(page, 'settings:set', { warnDuplicates: false });
    expect(await invoke(page, 'cards:create', req)).toMatchObject({ duplicates: [] });
  });

  test('the card maker asks about a duplicate and Add it anyway adds it', async ({ launch }) => {
    test.setTimeout(90_000);
    // Point at the mock before the app boots: the card maker uses the Anki status read at startup.
    const first = await launch();
    await invoke(first.page, 'settings:set', { ankiConnect: MOCK_ANKI, deckName: `Kotoba E2E ui ${Date.now()}` });
    await invoke(first.page, 'anki:setup');
    await first.app.close();
    const { page } = await launch({ files: [SAMPLE] });
    await page.evaluate(() => localStorage.setItem('kotoba.cardTypes', '["ContextCloze"]'));
    const { cues } = await sampleSubs(page, (await sampleRecord(page)).id);
    const v = page.locator('[data-testid=player] video');
    await v.evaluate((el, t) => {
      el.pause();
      el.currentTime = t;
    }, cues[0].start + 0.5);
    const mineFirstToken = async () => {
      await page.getByTestId('subtitle-line').getByTestId('token').first().click();
      const maker = page.getByTestId('card-maker');
      await maker.getByRole('button', { name: /^Add 1 card/ }).click();
      return maker;
    };
    const maker = await mineFirstToken();
    await expect(maker).toHaveCount(0);
    await mineFirstToken();
    const dialog = page.getByTestId('duplicate-card');
    await expect(dialog).toContainText('You already have this');
    await dialog.getByRole('button', { name: 'Add it anyway' }).click();
    await expect(page.getByTestId('card-maker')).toHaveCount(0);
    expect(await invoke(page, 'settings:get')).toMatchObject({ warnDuplicates: true });
  });
});
