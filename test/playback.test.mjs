import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamReason, pickAudio } from '../src/core/playback.mjs';

const v = (codec_name, pix_fmt = 'yuv420p') => ({ index: 0, codec_type: 'video', codec_name, pix_fmt });
const a = (index, codec_name, language, isDefault = 0) => ({
  index,
  codec_type: 'audio',
  codec_name,
  tags: { language },
  disposition: { default: isDefault },
});
const file = (format_name, ...streams) => ({ format: { format_name }, streams });
const MKV = 'matroska,webm';
const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';

test('direct only where the matrix showed Chromium plays it', () => {
  assert.equal(streamReason(file(MKV, v('hevc', 'yuv420p10le'), a(1, 'opus', 'jpn')), '/x.mkv', 1), null);
  assert.equal(streamReason(file(MP4, v('h264'), a(1, 'aac', 'jpn')), '/x.mp4', 1), null);
  assert.equal(streamReason(file('avi', v('h264'), a(1, 'mp3', 'jpn')), '/x.avi', 1), 'avi container');
  assert.equal(streamReason(file(MKV, v('h264'), a(1, 'ac3', 'jpn')), '/x.mkv', 1), 'ac3 audio');
  assert.equal(streamReason(file(MKV, v('h264', 'yuv420p10le'), a(1, 'aac', 'jpn')), '/x.mkv', 1), 'h264 yuv420p10le video');
  assert.equal(streamReason(file(MKV, v('vp9'), a(1, 'vorbis', 'jpn')), '/x.webm', 1), null);
  assert.equal(streamReason(file(MKV, v('h264'), a(1, 'vorbis', 'jpn')), '/x.mkv', 1), 'vorbis audio');
  assert.equal(streamReason(file(MP4, v('h264'), a(1, 'mp3', 'jpn')), '/x.mp4', 1), 'mp3 audio');
});

test('only the first audio track plays directly', () => {
  const dual = file(MKV, v('h264'), a(1, 'aac', 'eng', 1), a(2, 'aac', 'jpn'));
  assert.equal(streamReason(dual, '/x.mkv', 1), null);
  assert.equal(streamReason(dual, '/x.mkv', 2), 'not the first audio track');
});

test('audio follows the target language before the default flag', () => {
  const dual = file(MKV, v('h264'), a(1, 'aac', 'eng', 1), a(2, 'aac', 'jpn'));
  assert.equal(pickAudio(dual, 'ja'), 2);
  assert.equal(pickAudio(dual, 'ko'), 1);
  assert.equal(pickAudio(file(MKV, v('h264')), 'ja'), null);
});
