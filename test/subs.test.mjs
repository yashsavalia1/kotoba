import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubtitles } from '../src/core/subs.mjs';
import { extractEmbeddedSub } from '../src/core/media.mjs';

test('parses SRT with comma decimals and multi-line cues', () => {
  const cues = parseSubtitles(`1
00:00:01,500 --> 00:00:04,000
正直、今日は
行きたくない。

2
00:01:02,250 --> 00:01:05,000
素直に謝った。
`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 4);
  assert.equal(cues[0].text, '正直、今日は\n行きたくない。');
  assert.equal(cues[1].start, 62.25);
});

test('parses WebVTT with dot decimals and strips inline tags', () => {
  const cues = parseSubtitles(`WEBVTT

00:00:02.000 --> 00:00:05.000
<i>素直</i>に<b>謝った</b>。
`, '.vtt');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, '素直に謝った。');
  assert.equal(cues[0].start, 2);
});

test('parses ASS, honours the Format line, and keeps commas inside text', () => {
  const cues = parseSubtitles(`[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}正直、行きたくない。
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,一行目\\N二行目
`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '正直、行きたくない。', 'override block stripped, comma in text kept');
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.5);
  assert.equal(cues[1].text, '一行目\n二行目', 'ASS \\N becomes a newline');
});

test('merges cues that share exact timings and sorts by start', () => {
  const cues = parseSubtitles(`1
00:00:05,000 --> 00:00:06,000
second

2
00:00:01,000 --> 00:00:02,000
top sign

3
00:00:01,000 --> 00:00:02,000
bottom line
`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'top sign\nbottom line');
  assert.equal(cues[1].text, 'second');
});

test('strips inline furigana but keeps speaker labels and stage directions', () => {
  const cues = parseSubtitles(`1
00:00:02,544 --> 00:00:04,212
（西片(にしかた)）フッフッフ…

2
00:00:05,000 --> 00:00:06,000
（ため息）

3
00:00:07,000 --> 00:00:08,000
高木(たかぎ)さんは意地悪(いじわる)だ

4
00:00:09,000 --> 00:00:10,000
これは(たぶん)違う
`);
  assert.equal(cues[0].text, '（西片）フッフッフ…', 'reading removed, speaker label kept');
  assert.equal(cues[1].text, '（ため息）', 'a kanji-bearing label is content, not furigana');
  assert.equal(cues[2].text, '高木さんは意地悪だ', 'every furigana run on the line is stripped');
  assert.equal(cues[3].text, 'これは(たぶん)違う', 'kana in parens after kana is not furigana');
});

test('drops empty cues rather than emitting blank subtitles', () => {
  const cues = parseSubtitles(`1
00:00:01,000 --> 00:00:02,000


2
00:00:03,000 --> 00:00:04,000
real
`);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'real');
});

// ---------------------------------------------------------------- real-world files

const fixture = (name) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

test('ASS: drawings, comments, karaoke, \\h, layers and kinds', () => {
  const cues = parseSubtitles(fixture('typeset.ass'), '.ass');
  const texts = cues.map((c) => c.text);

  assert.ok(!texts.some((t) => t.includes('コメント')), 'Comment: lines are ignored');
  assert.ok(!texts.some((t) => /m 0 0|\\p|[{}]/.test(t)), `drawing or tags leaked: ${JSON.stringify(texts)}`);

  const first = cues[0];
  assert.deepEqual(first, { start: 1, end: 3.5, text: '正直、行きたくない。', kind: 'dialogue', style: 'Default' });

  const signs = cues.filter((c) => c.text === '看板');
  assert.equal(signs.length, 1, 'border/blur layers of one sign collapse');
  assert.equal(signs[0].kind, 'sign');

  const song = cues.find((c) => c.style === 'OP-Romaji');
  assert.equal(song.text, 'koisuru', 'karaoke timing tags stripped');
  assert.equal(song.kind, 'song');

  const stacked = cues.filter((c) => c.start === 4);
  assert.equal(stacked.length, 1, 'identical duplicate lines collapse');
  assert.equal(stacked[0].text, '一行目\n二行目 三 四', '\\N is a line break, \\h and \\n are spaces');

  assert.ok(!texts.includes('長さゼロ') && !texts.includes('逆さま'), 'zero and negative durations dropped');
  assert.equal(cues.find((c) => c.text === '名前で看板').kind, 'sign', 'actor name "Sign" marks a sign');
  assert.equal(cues.find((c) => c.text === '位置指定').kind, 'sign', '\\pos-placed text is typesetting');
  assert.equal(cues.find((c) => c.start === 13).text, '本文、続き', 'brace comments are not text');

  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].start >= cues[i - 1].start, 'sorted by start');
});

test('SRT: BOM, CRLF, {\\an8}, numbering gaps, missing blank line, no trailing newline', () => {
  const cues = parseSubtitles(fixture('crlf-bom.srt'), '.srt');
  assert.deepEqual(
    cues.map((c) => [c.start, c.end, c.text, c.kind]),
    [
      [1, 2.5, '上の字幕', 'dialogue'],
      [3, 4, '番号が飛ぶ', 'dialogue'],
      [5, 6, '空行なし', 'dialogue'],
      [7, 9, '♪〜', 'song'],
      [9, 10, '楽しいね♪', 'dialogue'],
      [11, 12, '末尾に改行なし', 'dialogue'],
    ]
  );
  assert.ok(!cues.some((c) => /\r|﻿/.test(c.text)));
});

test('WebVTT: identifiers, settings, NOTE/STYLE/REGION, mm:ss timestamps, entities', () => {
  const cues = parseSubtitles(fixture('cues.vtt'), '.vtt');
  assert.deepEqual(
    cues.map((c) => [c.start, c.end, c.text]),
    [
      [1, 3.5, 'からかい上手の & 高木さん'],
      [4, 5, 'カラオケ'],
      [3600.25, 3601, '一時間後'],
    ]
  );
});

test('same-timed cues of different kinds stay separate; overlapping cues keep file order', () => {
  const cues = parseSubtitles(`[Script Info]

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,長い台詞
Dialogue: 0,0:00:01.00,0:00:05.00,Signs,,0,0,0,,看板
Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,割り込み
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,同時A
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,同時B
`);
  assert.deepEqual(
    cues.map((c) => `${c.start}-${c.end} ${c.kind} ${c.text}`),
    ['1-5 dialogue 長い台詞', '1-5 sign 看板', '2-3 dialogue 割り込み', '2-4 dialogue 同時A\n同時B']
  );
});

const TAKAGI = path.join(os.homedir(), 'Media', 'Karakai Jouzu no Takagi-san S01');
const takagiSkip = !fs.existsSync(TAKAGI) && 'Takagi media not present';

test('every Takagi .ja.srt parses completely and cleanly', { skip: takagiSkip }, () => {
  const files = fs.readdirSync(TAKAGI).filter((f) => f.endsWith('.ja.srt'));
  assert.equal(files.length, 12);
  for (const f of files) {
    const body = fs.readFileSync(path.join(TAKAGI, f), 'utf8');
    const cues = parseSubtitles(body, '.srt');
    assert.equal(cues.length, body.match(/-->/g).length, `${f}: a cue was lost`);
    for (const c of cues) {
      assert.ok(c.text && !/[<>{}\r﻿]/.test(c.text), `${f}: dirty text ${JSON.stringify(c.text)}`);
      assert.ok(c.end > c.start);
      assert.ok(!/[一-鿿][(（][ぁ-ゟ]+[)）]/.test(c.text), `${f}: furigana left in ${c.text}`);
    }
    assert.ok(cues.filter((c) => c.kind === 'song').every((c) => /♪/.test(c.text)));
  }
});

const mkv = takagiSkip ? null : fs.readdirSync(TAKAGI).find((f) => f.endsWith('.mkv'));

test('the embedded English ASS track splits into dialogue, signs and songs', { skip: takagiSkip }, async () => {
  const body = await extractEmbeddedSub(path.join(TAKAGI, mkv), 2);
  const cues = parseSubtitles(body, '.ass');
  const kinds = Object.groupBy(cues, (c) => c.kind);
  assert.ok(kinds.dialogue.length > 200, `only ${kinds.dialogue?.length} dialogue cues`);
  assert.ok(kinds.dialogue.every((c) => c.style.startsWith('Default')), 'typeset styles leaked into dialogue');
  assert.ok(kinds.song.every((c) => /OP|ED|song/i.test(c.style)));
  assert.ok(kinds.sign.length > 0);
  assert.ok(!cues.some((c) => /[{}\\]|^m -?\d/.test(c.text)), 'override tags or drawings leaked');
});
