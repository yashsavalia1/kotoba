import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dictReady } from '../src/core/db.mjs';
import { tokenize, lookup, homophones, sharedKanji, glossText } from '../src/core/dict.mjs';

const skip = dictReady() ? false : 'dictionary not built - run `npm run dict`';

test('segments a line into the words a learner would hover', { skip }, () => {
  const got = tokenize('正直、今日は行きたくない。')
    .filter((t) => t.entries.length)
    .map((t) => t.lemma);
  assert.ok(got.includes('正直'));
  assert.ok(got.includes('行く'), 'the whole inflected 行きたくない resolves to 行く');
});

test('longest match wins, so 素直に is one token not two', { skip }, () => {
  const toks = tokenize('素直に謝った');
  assert.deepEqual(toks.map((t) => t.text), ['素直に', '謝った']);
  assert.equal(toks[0].lemma, '素直');
  assert.equal(toks[1].lemma, '謝る');
});

test('greedy matching does not strand a verb it half-consumed', { skip }, () => {
  // Regression: 素直にな used to match, leaving った to resolve as 兎 (rabbit).
  const toks = tokenize('やっと素直になった。');
  const lemmas = toks.filter((t) => t.entries.length).map((t) => t.lemma);
  assert.ok(lemmas.includes('素直'));
  assert.ok(lemmas.includes('成る') || lemmas.includes('なる'), 'なった resolves to なる');
  assert.ok(!lemmas.includes('兎'), 'no rabbits');
});

test('every token accounts for exactly its slice of the line', { skip }, () => {
  const line = '彼女は素直な子だから心配ない。';
  assert.equal(tokenize(line).map((t) => t.text).join(''), line);
});

test('minimal pairs are common words of the same length', { skip }, () => {
  const kanshin = lookup('感心')[0];
  const pairs = homophones(kanshin.reading, '感心', 4).map((e) => e.spelling);
  assert.ok(pairs.includes('関心'), `expected 関心 among ${pairs.join(' ')}`);

  // 保証 / 保障 / 補償 live under one JMdict entry; all three must surface.
  const hosho = lookup('保証')[0];
  const hoshoPairs = homophones(hosho.reading, '保証', 4).map((e) => e.spelling);
  assert.ok(hoshoPairs.includes('保障'), `expected 保障 among ${hoshoPairs.join(' ')}`);
  assert.ok(hoshoPairs.includes('補償'), `expected 補償 among ${hoshoPairs.join(' ')}`);
  assert.ok(!hoshoPairs.includes('保証'), 'the target itself is never its own pair');
});

test('reading contrast returns words read differently from the target', { skip }, () => {
  const e = lookup('正直')[0];
  const others = sharedKanji(e.kanji, e.id, e.reading, 4);
  assert.ok(others.length > 0);
  assert.ok(others.every((o) => o.reading !== e.reading), 'a same-reading word teaches nothing here');
  assert.ok(others.every((o) => [...o.spelling].some((c) => e.kanji.includes(c))));
  assert.ok(others.every((o) => o.spelling !== e.kanji));
});

test('glosses are readable, not raw JSON', { skip }, () => {
  const g = glossText(lookup('正直')[0]);
  assert.match(g, /honest/);
  assert.ok(!g.includes('{'));
});
