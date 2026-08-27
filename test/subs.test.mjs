import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles } from '../server/subs.mjs';

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
