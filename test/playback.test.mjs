import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { playable } from '../src/core/playback.mjs';

const v = (codec_name, pix_fmt = 'yuv420p') => ({ codec_type: 'video', codec_name, pix_fmt });
const a = (codec_name) => ({ codec_type: 'audio', codec_name });
const file = (format_name, ...streams) => ({ format: { format_name }, streams: streams.map((s, index) => ({ index, ...s })) });
const MKV = 'matroska,webm';
const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const why = (info, abs) => playable(info, abs).unsupported;

test('plays what the matrix showed Chromium plays', () => {
  assert.equal(why(file(MKV, v('hevc', 'yuv420p10le'), a('opus')), '/x.mkv'), null);
  assert.equal(why(file(MP4, v('h264'), a('aac')), '/x.mp4'), null);
  assert.equal(why(file(MKV, v('vp9'), a('vorbis')), '/x.webm'), null);
  assert.equal(why(file('mp3', a('mp3')), '/x.mp3'), null);
});

test('says plainly what will not play', () => {
  assert.equal(why(file('avi', v('h264'), a('mp3')), '/x.avi'), "AVI files aren't supported");
  assert.equal(why(file(MKV, v('mpeg2video'), a('mp3')), '/x.mkv'), "MPEG-2 video isn't supported");
  assert.equal(why(file(MKV, v('h264', 'yuv420p10le'), a('aac')), '/x.mkv'), "H.264 video (yuv420p10le) isn't supported");
  assert.equal(why(file(MKV, v('h264'), a('ac3')), '/x.mkv'), "AC3 audio isn't supported");
  assert.equal(why(file(MKV, v('h264'), a('opus')), '/x.webm'), "H.264 video isn't supported");
});

test('the part Chromium plays is still reported', () => {
  const silent = playable(file(MKV, v('h264'), a('ac3')), '/x.mkv');
  assert.equal(silent.video.codec, 'h264');
  assert.equal(silent.audio, null);
  const black = playable(file(MKV, v('mpeg2video'), a('mp3')), '/x.mkv');
  assert.equal(black.video, null);
  assert.equal(black.audio.codec, 'mp3');
  assert.deepEqual(playable(file('avi', v('h264'), a('mp3')), '/x.avi'), { video: null, audio: null, unsupported: "AVI files aren't supported" });
});

test('the first audio track Chromium decodes plays, and cover art is not video', () => {
  assert.equal(why(file(MKV, v('h264'), a('aac'), a('ac3')), '/x.mkv'), null);
  const skipped = playable(file(MKV, v('h264'), a('ac3'), a('aac')), '/x.mkv');
  assert.equal(skipped.audio.codec, 'aac');
  assert.equal(skipped.audio.index, 2, 'card clips map this stream, not the first audio track');
  assert.equal(skipped.unsupported, "AC3 audio isn't supported");
  const art = { ...v('mjpeg', 'yuvj444p'), disposition: { attached_pic: 1 } };
  assert.deepEqual(playable(file('mp3', art, a('mp3')), '/x.mp3'), { video: null, audio: { index: 1, codec: 'mp3', language: null }, unsupported: null });
});
