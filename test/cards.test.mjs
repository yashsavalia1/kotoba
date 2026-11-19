import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { userDb, dictReady } from '../src/core/db.mjs';
import { configurePaths } from '../src/core/paths.mjs';
import { setApiKey, setSettings } from '../src/core/settings.mjs';
import { addNote } from '../src/core/anki.mjs';
import { startMockAnki } from '../scripts/mock-anki.mjs';
import { joinCue } from '../src/core/cards.mjs';
import { parseSubtitles } from '../src/core/subs.mjs';
import { SAMPLE } from './helpers.mjs';
import { recordCues, collocations, continuations } from '../src/core/corpus.mjs';
import { buildCards } from '../src/core/cards.mjs';
import { displayTitle } from '../src/core/media.mjs';
import { ffmpeg } from '../src/core/ffmpeg.mjs';

const skip = dictReady() ? false : 'dictionary not built - run `npm run dict`';
const FIXTURE = 999001;

// A private temp dir, so leak checks are not confused by other processes' clips.
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-clips-'));
configurePaths({ tempDir: TEMP });
const tempFiles = () => fs.readdirSync(TEMP);

const CUES = [
  '正直に言うと、よく分からない。',
  '正直言って、それは無理だ。',
  '正直に言うと、行きたくない。',
  '彼は正直者だ。',
  '正直言って、疲れた。',
].map((text, i) => ({ start: i * 4, end: i * 4 + 3, text }));

test.before(() => {
  userDb().prepare('DELETE FROM line WHERE media_id = ?').run(FIXTURE);
  recordCues(FIXTURE, CUES);
});
test.after(() => userDb().prepare('DELETE FROM line WHERE media_id = ?').run(FIXTURE));

test('library titles keep what distinguishes a file and drop release tags', () => {
  // Every episode of a season shares a prefix and a suffix; without trimming
  // they all render as the same truncated string in the sidebar.
  assert.equal(
    displayTitle('/m/[washed] Karakai Jouzu no Takagi-san - S01E01 (BD 1080p HEVC Opus).mkv'),
    'Karakai Jouzu no Takagi-san - S01E01'
  );
  assert.equal(
    displayTitle('/m/[washed] Karakai Jouzu no Takagi-san - S01E12 (BD 1080p HEVC Opus).mkv'),
    'Karakai Jouzu no Takagi-san - S01E12'
  );
  // A parenthesised year is information, not a release tag.
  assert.equal(displayTitle('/m/Exit 8 (2025) [1080p] [WEBRip].mp4'), 'Exit 8 (2025)');
  // Nothing to strip means nothing is lost.
  assert.equal(displayTitle('/m/Show Name - 03.mkv'), 'Show Name - 03');
  assert.ok(displayTitle('/m/[1080p][HEVC].mkv').length > 0, 'never returns an empty title');
});

test('corpus records every cue exactly once per index', () => {
  recordCues(FIXTURE, CUES); // idempotent - re-loading a track must not duplicate
  const n = userDb().prepare('SELECT count(*) AS n FROM line WHERE media_id = ?').get(FIXTURE).n;
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

const sample = SAMPLE;
const mediaSkip = skip || (!fs.existsSync(sample) && 'sample media not present');

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

test('a multi-line cue joins without a stray space in Japanese, and the token offset follows', () => {
  assert.deepEqual(joinCue('正直、今日は\n行きたくない。', 7), { sentence: '正直、今日は行きたくない。', offset: 6 });
  assert.deepEqual(joinCue('Honestly,\nno.', null), { sentence: 'Honestly, no.', offset: null });
  assert.deepEqual(joinCue('（高木）ねえ\n（西片）うっ', 0).sentence, '（高木）ねえ（西片）うっ');
});

test('corpus ignores signs, songs and non-Japanese tracks, and re-loading replaces', { skip }, () => {
  const MEDIA = 999002;
  const ja = parseSubtitles(`[Script Info]

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,勝負だ、西片。
Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\pos(1,1)}勝負看板
Dialogue: 0,0:00:03.00,0:00:04.00,OP,,0,0,0,,勝負の歌
`, '.ass');
  const count = () => userDb().prepare('SELECT count(*) AS n FROM line WHERE media_id = ?').get(MEDIA).n;
  try {
    assert.equal(recordCues(MEDIA, ja), 1);
    assert.equal(count(), 1);
    // The English reference track is recorded too by the caller; it must not wipe the Japanese.
    assert.equal(recordCues(MEDIA, [{ start: 1, end: 2, text: "It's a match, Nishikata." }]), 0);
    assert.equal(count(), 1);
    // A shorter re-load leaves no stale lines behind.
    recordCues(MEDIA, [...ja, ...ja.map((c) => ({ ...c, start: c.start + 10, end: c.end + 10 }))]);
    assert.equal(count(), 2);
    recordCues(MEDIA, ja);
    assert.equal(count(), 1);
  } finally {
    userDb().prepare('DELETE FROM line WHERE media_id = ?').run(MEDIA);
  }
});

test('collocations cut at word boundaries and skip dictionary words that merely contain it', { skip }, () => {
  const MEDIA = 999003;
  recordCues(MEDIA, ['高木さんの勝ち。', '高木さんの番だ。', '高木さんに負けた。', '高木さんに言う。', '本当かな'].map(
    (text, i) => ({ start: i, end: i + 1, text })
  ));
  try {
    const phrases = collocations('高木', 8).map((c) => c.phrase);
    assert.ok(phrases.includes('高木さんの') && phrases.includes('高木さんに'), phrases.join(' '));
    assert.ok(!phrases.includes('高木さ'), 'never a fragment');
    assert.ok(!collocations('本当', 10).some((c) => c.phrase === '日本当帰'), '日本当帰 is not built on 本当');
  } finally {
    userDb().prepare('DELETE FROM line WHERE media_id = ?').run(MEDIA);
  }
});

const llmServer = (status, body) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

test('a failing Claude call skips only the generative types, with the reason', { skip }, async () => {
  const server = await llmServer(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  setApiKey('sk-ant-cards-test');
  try {
    const { cards, skipped } = await buildCards({ ...base, types: ['Contrast', 'Situation', 'Collocation'] });
    assert.deepEqual(cards.map((c) => c.type), ['Collocation']);
    assert.deepEqual(skipped.map((s) => s.type), ['Contrast', 'Situation']);
    assert.match(skipped[0].reason, /API key/);
  } finally {
    setApiKey(null);
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
});

test('the hovered occurrence is the one highlighted and blanked', { skip: mediaSkip }, async () => {
  const twice = { start: 0, end: 3, text: '正直、正直に言うと…' };
  const { cards, files } = await buildCards({
    ...base, mediaPath: sample, cue: twice, tokenStart: 3, types: ['Audio', 'ReverseContext'], translation: 'x',
  });
  const byType = Object.fromEntries(cards.map((c) => [c.type, c.fields]));
  assert.equal(byType.Audio.Sentence, '正直、<b class="target">正直</b>に言うと…');
  assert.equal(byType.ReverseContext.Cloze, '正直、＿＿＿に言うと…');
  for (const f of files) fs.rmSync(f, { force: true });
});

test('a word that is not in the line never yields an empty cloze', { skip: mediaSkip }, async () => {
  const { cards, skipped, files } = await buildCards({
    ...base, mediaPath: sample, word: '正直', cue: { start: 0, end: 3, text: 'よく分からない。' },
    types: ['ContextCloze', 'ReverseContext'], translation: 'x',
  });
  assert.deepEqual(cards.map((c) => c.type), ['ContextCloze']);
  assert.equal(cards[0].fields.Sentence, 'よく分からない。');
  assert.match(skipped[0].reason, /does not appear/);
  for (const f of files) fs.rmSync(f, { force: true });
});

test('a word written in kana in the line is still found by its reading', { skip: mediaSkip }, async () => {
  const { cards, files } = await buildCards({
    ...base, mediaPath: sample, word: '正直',
    cue: { start: 0, end: 3, text: 'しょうじき言って無理。' }, types: ['ReverseContext'], translation: 'x',
  });
  assert.equal(cards[0].fields.Cloze, '＿＿＿言って無理。');
  for (const f of files) fs.rmSync(f, { force: true });
});

test('media names are content-addressed', { skip: mediaSkip }, async () => {
  const build = (over = {}) =>
    buildCards({ ...base, mediaPath: sample, types: ['ContextCloze'], translation: 'x', ...over });
  const a = await build();
  const b = await build();
  const c = await build({ cue: { ...cue, start: 1, end: 3 } });
  const names = (r) => r.cards[0].media.map((m) => m.filename).sort();
  assert.deepEqual(names(a), names(b), 're-mining the same line reuses the same media');
  assert.notDeepEqual(names(a), names(c), 'a different span is a different clip');
  assert.ok(names(a).every((n) => /^kotoba_[0-9a-f]{16}\.(mp3|jpg)$/.test(n)), names(a).join());
  for (const r of [a, b, c]) for (const f of r.files) fs.rmSync(f, { force: true });
});

test('ffmpeg failure is a clear error and leaves no temp files behind', { skip: mediaSkip }, async () => {
  const before = tempFiles();
  await assert.rejects(
    buildCards({ ...base, mediaPath: '/nonexistent/missing.mkv', types: ['Audio'], translation: 'x' }),
    /Could not cut the audio clip: .*no such file/i
  );
  // Screenshot succeeds, audio fails (no audio track): the screenshot must not be orphaned.
  const silent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-silent-')), 'silent.mkv');
  execFileSync(ffmpeg(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', silent]);
  await assert.rejects(
    buildCards({ ...base, mediaPath: silent, types: ['ContextCloze', 'Image'], translation: 'x' }),
    /Could not cut the audio clip/
  );
  assert.deepEqual(tempFiles(), before);
});

test('a reference-track translation is used as-is and keeps its line breaks', { skip: mediaSkip }, async () => {
  const { cards, files } = await buildCards({
    ...base, mediaPath: sample, types: ['Production'], translation: 'Honestly,\n<i>no idea</i>.',
  });
  assert.equal(cards[0].fields.Translation, 'Honestly,<br>&lt;i&gt;no idea&lt;/i&gt;.');
  for (const f of files) fs.rmSync(f, { force: true });
});

test('Anki refuses a note whose first field the deck has unless duplicates are allowed', { skip: mediaSkip }, async () => {
  const mock = await startMockAnki();
  setSettings({ ankiConnect: mock.url, deckName: 'Kotoba' });
  const line = { start: 0, end: 3, text: 'いや〜 筆箱が開かなくって' };
  const mine = async (word, opts) => {
    const { cards, files } = await buildCards({ ...base, mediaPath: sample, cue: line, word, types: ['ContextCloze'] });
    try {
      return await addNote(cards[0].type, cards[0].fields, cards[0].media, [], opts);
    } finally {
      for (const f of files) fs.rmSync(f, { force: true });
    }
  };
  try {
    await mine('筆箱');
    // Same as Mizune: the first field (the line, HTML stripped) decides, so another word in it counts too.
    await assert.rejects(mine('開かなく'), (e) => e.code === 'duplicate' && e.message === 'Already in your deck');
    await mine('開かなく', { allowDuplicate: true });
    assert.equal(mock.state.notes.length, 2);
  } finally {
    await mock.close();
  }
});
