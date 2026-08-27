import test from 'node:test';
import assert from 'node:assert/strict';
import { deinflect, posAllows } from '../server/deinflect.mjs';

const forms = (surface) => new Set(deinflect(surface).map((d) => d.text));

test('recovers dictionary forms across inflection chains', () => {
  const cases = [
    ['食べたくなかった', '食べる'],
    ['行きたくない', '行く'],
    ['読まれた', '読む'],
    ['謝った', '謝る'],
    ['なった', 'なる'],
    ['素直じゃない', '素直'],
    ['正直に', '正直'],
    ['見ている', '見る'],
    ['面白かった', '面白い'],
    ['来られなかった', '来る'],
    ['走って', '走る'],
    ['買っちゃった', '買う'],
    ['してしまった', 'する'],
    ['分からない', '分かる'],
    ['言えよ', '言う'],
    ['泳いだ', '泳ぐ'],
    ['話しました', '話す'],
    ['待っている', '待つ'],
    ['死んだ', '死ぬ'],
    ['遊ばせる', '遊ぶ'],
    ['行ってきた', '行く'],
    ['きた', 'くる'],
  ];
  for (const [surface, expected] of cases) {
    assert.ok(forms(surface).has(expected), `${surface} should deinflect to ${expected}`);
  }
});

test('surface form is always the first candidate', () => {
  assert.equal(deinflect('食べた')[0].text, '食べた');
  assert.equal(deinflect('食べた')[0].type, null);
});

test('candidate sets stay small enough to query per token', () => {
  for (const w of ['食べたくなかった', '来られなかった', '行ってきました']) {
    assert.ok(deinflect(w).length < 60, `${w} produced ${deinflect(w).length} candidates`);
  }
});

test('single-kana rules do not chain, so trailing kana is not swallowed', () => {
  // 素直にな must not reduce to 素直: that is what let the scanner eat な and
  // strand った, which then mis-resolved to 兎.
  assert.ok(!forms('素直にな').has('素直'));
  assert.ok(forms('素直に').has('素直'));
});

test('part of speech gates a deinflection', () => {
  // った -> う is only valid if the entry is a godan verb.
  assert.ok(!posAllows('v5', ['n']), 'a noun cannot be the base of a v5 deinflection');
  assert.ok(posAllows('v5', ['v5u', 'vt']));
  assert.ok(posAllows('v1', ['v1']));
  assert.ok(!posAllows('v1', ['v5r']));
  assert.ok(posAllows('adji', ['adj-i']));
  assert.ok(!posAllows('te', ['v5r']), 'a te-form is never a headword');
  assert.ok(posAllows(null, ['anything']));
});

test('never deinflects a form down to the empty string', () => {
  for (const w of ['て', 'た', 'な', 'に', 'する', 'い']) {
    assert.ok(deinflect(w).every((d) => d.text.length > 0), `${w} produced an empty candidate`);
  }
});
