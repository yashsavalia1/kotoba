import assert from 'node:assert/strict';
import { cueAt, cueBefore, overlapText, fmt, pickPrimary, pickReference } from './util.js';

const cues = [{ start: 1, end: 2, text: 'a' }, { start: 3, end: 4, text: 'b' }, { start: 5, end: 7, text: 'c\nd' }];
assert.equal(cueAt(cues, 1.5), 0);
assert.equal(cueAt(cues, 2.5), -1);
assert.equal(cueBefore(cues, 2.5), 0);
assert.equal(cueBefore(cues, 0.5), -1);
assert.equal(overlapText(cues, 4.8, 6.9), 'c d');
assert.equal(overlapText(cues, 1.9, 3.1), '');
assert.equal(fmt(3725), '1:02:05');
assert.equal(fmt(65), '1:05');
const tracks = [{ key: 'a', label: 'en' }, { key: 'b', label: 'ja' }];
assert.equal(pickPrimary(tracks, {}).key, 'b');
assert.equal(pickReference(tracks, {}, 'b').key, 'a');
assert.equal(pickReference(tracks, { refTrack: null }, 'b'), null);
console.log('ok');
