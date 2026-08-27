import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db, dictReady } from '../server/db.mjs';
import { config } from '../server/config.mjs';
import { recordCues, collocations, continuations } from '../server/corpus.mjs';
import { buildCards } from '../server/cards.mjs';
import { ffmpegAvailable } from '../server/media.mjs';

const skip = dictReady() ? false : 'dictionary not built - run `npm run dict`';
const FIXTURE = '__test_fixture__';

const CUES = [
  '正直に言うと、よく分からない。',
  '正直言って、それは無理だ。',
  '正直に言うと、行きたくない。',
  '彼は正直者だ。',
  '正直言って、疲れた。',
].map((text, i) => ({ start: i * 4, end: i * 4 + 3, text }));

test.before(() => {
  db.exec(`DELETE FROM line WHERE media = '${FIXTURE}'`);
  recordCues(FIXTURE, CUES);
});
test.after(() => db.exec(`DELETE FROM line WHERE media = '${FIXTURE}'`));

test('corpus records every cue exactly once per index', () => {
  recordCues(FIXTURE, CUES); // idempotent - re-loading a track must not duplicate
  const n = db.prepare('SELECT count(*) AS n FROM line WHERE media = ?').get(FIXTURE).n;
  assert.equal(n, CUES.length);
});

test('collocations combine dictionary phrases with mined n-grams', { skip }, () => {
  const cols = collocations('正直', 10);
  const phrases = cols.map((c) => c.phrase);
  assert.ok(phrases.includes('正直者'), `dictionary phrase missing from ${phrases.join(' ')}`);
  assert.ok(
    cols.some((c) => c.source === 'corpus' && c.phrase.startsWith('正直')),
    `no mined n-gram in ${phrases.join(' ')}`
  );
  assert.ok(!phrases.includes('正直'), 'the word itself is not a collocation');
});

test('predictions rank what actually follows the word', { skip }, () => {
  const next = continuations('正直', 6);
  const byText = Object.fromEntries(next.map((c) => [c.text, c.count]));
  assert.ok(next.length >= 2, JSON.stringify(next));
  assert.ok(byText['に言うと'] >= 2, `に言うと should be seen twice: ${JSON.stringify(byText)}`);
  assert.ok(byText['言って'] >= 2, `言って should be seen twice: ${JSON.stringify(byText)}`);
  assert.ok(next.every((c) => !c.text.includes('、')), 'continuations stop at punctuation');
  assert.deepEqual(
    next.map((c) => c.count),
    [...next.map((c) => c.count)].sort((a, b) => b - a),
    'ranked by frequency'
  );
});

const cue = { start: 0, end: 3, text: '正直に言うと、よく分からない。' };
const base = {
  mediaPath: '/nonexistent/does-not-matter.mkv',
  mediaTitle: 'Fixture E01',
  cue,
  word: '正直',
};

test('builds the lookup-only card types without touching ffmpeg', { skip }, async () => {
  const { cards, skipped } = await buildCards({
    ...base,
    types: ['ReadingContrast', 'MinimalPair', 'Collocation', 'Prediction'],
  });
  const byType = Object.fromEntries(cards.map((c) => [c.type, c.fields]));

  assert.ok(byType.ReadingContrast, 'ReadingContrast should build');
  assert.match(byType.ReadingContrast.Words, /正直/);
  assert.match(byType.ReadingContrast.Readings, /正直（しょうじき）/);

  assert.ok(byType.Collocation, 'Collocation should build');
  assert.match(byType.Collocation.Collocations, /正直者/);

  assert.ok(byType.Prediction, 'Prediction should build');
  assert.equal(byType.Prediction.Prompt, '正直＿＿＿');
  assert.match(byType.Prediction.Continuations, /に言うと/);

  // 正直 has no common same-length homophone, so this one must decline loudly.
  assert.ok(!byType.MinimalPair);
  assert.match(skipped.find((s) => s.type === 'MinimalPair').reason, /homophone/);
});

test('minimal pair builds for a word that has one', { skip }, async () => {
  const { cards } = await buildCards({
    ...base,
    cue: { start: 0, end: 3, text: '品質を保証します。' },
    word: '保証',
    types: ['MinimalPair'],
  });
  assert.equal(cards.length, 1);
  assert.match(cards[0].fields.Words, /保証/);
  assert.match(cards[0].fields.Words, /保障|補償/);
});

test('rejects unknown card types instead of silently dropping them', { skip }, async () => {
  await assert.rejects(
    () => buildCards({ ...base, types: ['ContextCloze', 'Nonsense'] }),
    /unknown card type\(s\): Nonsense/
  );
});

test('rejects a word with no dictionary entry', { skip }, async () => {
  await assert.rejects(
    () => buildCards({ ...base, word: 'ぬぬぬぬぬ', types: ['Collocation'] }),
    /no dictionary entry/
  );
});

const sample = path.join(config.mediaDirs[0], 'Shoujiki S01E01.mkv');
const mediaSkip = skip || (!ffmpegAvailable() && 'ffmpeg not available')
  || (!fs.existsSync(sample) && 'sample media not present');

test('extracts clips and blanks the target word', { skip: mediaSkip }, async () => {
  const { cards, files } = await buildCards({
    ...base,
    mediaPath: sample,
    types: ['ContextCloze', 'ReverseContext', 'Audio', 'Image'],
    translation: 'Honestly, I have no idea.',
  });
  const byType = Object.fromEntries(cards.map((c) => [c.type, c]));

  assert.equal(byType.ReverseContext.fields.Cloze, '＿＿＿に言うと、よく分からない。');
  assert.match(byType.ContextCloze.fields.Sentence, /<b class="target">正直<\/b>/);
  assert.equal(byType.ContextCloze.fields.Translation, 'Honestly, I have no idea.');

  const kinds = byType.ContextCloze.media.map((m) => m.kind);
  assert.deepEqual(kinds.sort(), ['audio', 'picture']);
  for (const f of files) {
    assert.ok(fs.statSync(f).size > 0, `${f} is empty`);
    fs.rmSync(f, { force: true });
  }
});

test('a missing API key skips only the generative types', { skip: mediaSkip }, async () => {
  // Regression: needing a translation used to take out every card in the batch.
  const before = process.env.ANTHROPIC_API_KEY;
  const beforeToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const { cards, skipped, files } = await buildCards({
      ...base,
      mediaPath: sample,
      types: ['ContextCloze', 'ReverseContext', 'Contrast', 'Collocation'],
    });
    const built = cards.map((c) => c.type);
    assert.deepEqual(built.sort(), ['Collocation', 'ContextCloze', 'ReverseContext']);
    assert.equal(cards.find((c) => c.type === 'ContextCloze').fields.Translation, '');
    assert.deepEqual(skipped.map((s) => s.type), ['Contrast']);
    for (const f of files) fs.rmSync(f, { force: true });
  } finally {
    if (before) process.env.ANTHROPIC_API_KEY = before;
    if (beforeToken) process.env.ANTHROPIC_AUTH_TOKEN = beforeToken;
  }
});

test('escapes HTML so a subtitle cannot inject markup into a card', { skip }, async () => {
  const { cards } = await buildCards({
    ...base,
    cue: { start: 0, end: 3, text: '正直に言うと <script>alert(1)</script> & そう。' },
    types: ['Collocation'],
    translation: '<img onerror=alert(1)>',
  });
  const html = JSON.stringify(cards[0].fields);
  assert.ok(!html.includes('<script>'), 'raw script tag reached a card field');
  assert.ok(html.includes('Fixture E01'));
});
