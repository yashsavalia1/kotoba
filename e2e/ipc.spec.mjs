import { spawn } from 'node:child_process';
import path from 'node:path';
import { test, expect, invoke, sampleRecord, sampleSubs, ROOT, SAMPLE } from './fixtures.mjs';

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

test('status: dictionary and ffmpeg ready', async ({ launch }) => {
  const { page } = await launch();
  const status = await invoke(page, 'app:status');
  expect(status).toMatchObject({ dictReady: true, ffmpeg: true });
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
});
