import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clean, episodes, episodeTitle, showTitle, namesEpisode } from '../src/core/titles.mjs';

// Ported from Mizune's core/src/test/.../TitlesTest.kt and RecentVideosTest.kt.

test('drops release tags from folder names', () => {
  assert.equal(clean('[SomeSubs] Kumo-Ten! (1080p BD 10bit) [ABCD1234]'), 'Kumo-Ten!');
  assert.equal(clean('[Group] Kumo-Ten! (2009) [BD 1080p x265 FLAC]'), 'Kumo-Ten! (2009)');
  assert.equal(clean('[OtherSubs] Tabibito (Complete) [1080p]'), 'Tabibito');
  assert.equal(clean('Tooi.no.Tabibito.S01.1080p.WEB-DL.H.264-GROUP'), 'Tooi no Tabibito Season 1');
  assert.equal(clean('Ame the Band! [BDRip 1080p HEVC Dual-Audio]'), 'Ame the Band!');
  assert.equal(clean('Hibike!_Euphonium_2_[Hi10P]'), 'Hibike! Euphonium 2');
  assert.equal(clean('【字幕组】Mushishi【1080p】'), 'Mushishi');
  assert.equal(clean('[Judas] Yuru Camp (Season 2) [1080p][HEVC x265 10bit][Eng-Subs]'), 'Yuru Camp (Season 2)');
  assert.equal(clean('Weathering.With.You.2019.1080p.BluRay.x264-GROUP'), 'Weathering With You 2019');
  assert.equal(clean('Steins;Gate (BD 1080p Dual Audio)'), 'Steins;Gate');
});

test('episodes with their own tags', () => {
  const names = [
    '[Some-raws] Kawa no Hotori - 01 [1080p][Multiple Subtitle][ABCD1234].mkv',
    '[Some-raws] Kawa no Hotori - 02 END [1080p][Multiple Subtitle][ABCD1235].mkv',
  ];
  assert.deepEqual(episodes(names), ['Episode 1', 'Episode 2']);
});

test('leaves plain names alone', () => {
  assert.equal(clean('Lectures'), 'Lectures');
  assert.equal(clean('Season 1'), 'Season 1');
  assert.equal(clean('Dr. Stone'), 'Dr. Stone');
  assert.equal(clean("Charlotte's Web"), "Charlotte's Web");
  assert.equal(clean('ゆるキャン△'), 'ゆるキャン△');
  assert.equal(clean('Lesson 10.mkv'), 'Lesson 10');
});

test('cleans episode files', () => {
  assert.equal(clean('[SomeSubs] Kumo-Ten! - 01 (1080p bd1230) [5E6F7A8B].mkv'), 'Kumo-Ten! - 01');
  assert.equal(clean('[SomeSubs] Kumo-Ten! - 01v2 [1080p].mkv'), 'Kumo-Ten! - 01');
  assert.equal(clean('Tabibito.S01E05.The.Long.Road.1080p.WEB.H264-GROUP.mkv'), 'Tabibito S01E05 The Long Road');
});

test('a name made only of brackets keeps its title', () => {
  assert.equal(clean('[Neko fansub][Ame the Band!][01][1080p][CHS].mp4'), 'Ame the Band! 01');
});

test('episodes drop the series they share', () => {
  const names = [
    '[SomeSubs] Kumo-Ten! - 01 (1080p BD) [5E6F7A8B].mkv',
    '[SomeSubs] Kumo-Ten! - 02 (1080p BD) [1B2C3D4E].mkv',
    '[SomeSubs] Kumo-Ten! - 10 (1080p BD) [AA00BB11].mkv',
  ];
  assert.deepEqual(episodes(names), ['Episode 1', 'Episode 2', 'Episode 10']);
});

test('episode titles are kept', () => {
  const names = ['Tabibito.S01E05.The.Long.Road.1080p.WEB.H264-GROUP.mkv', 'Tabibito.S01E06.A.Quiet.Town.1080p.WEB.H264-GROUP.mkv'];
  assert.deepEqual(episodes(names), ['Episode 5 · The Long Road', 'Episode 6 · A Quiet Town']);
});

test('episodes from several seasons say which season', () => {
  assert.deepEqual(episodes(['Show S01E12.mkv', 'Show S02E01.mkv']), ['S1 E12', 'S2 E1']);
});

test('Japanese episode numbers', () => {
  assert.deepEqual(episodes(['けいおん！ 第1話.mkv', 'けいおん！ 第2話.mkv']), ['Episode 1', 'Episode 2']);
});

test('different videos keep their own titles', () => {
  assert.deepEqual(episodes(['Lesson 1.mkv', 'Lesson 2.mkv', 'Lesson 10.mkv']), ['Lesson 1', 'Lesson 2', 'Lesson 10']);
  assert.deepEqual(episodes(['Your Name (2016) [BD 1080p].mkv']), ['Your Name (2016)']);
  assert.deepEqual(episodes(['Paper Lanterns [1080p].mkv', 'Moss Garden [1080p].mkv']), ['Paper Lanterns', 'Moss Garden']);
});

test('an episode among its siblings, and its show named once', () => {
  const siblings = ['[Made-Up Subs] Paper Lanterns - 01 [1080p].mkv', '[Made-Up Subs] Paper Lanterns - 02 [1080p].mkv'];
  assert.equal(episodeTitle(siblings[1], siblings, true), 'Episode 2');
  assert.equal(episodeTitle(siblings[1], siblings, false), '[Made-Up Subs] Paper Lanterns - 02 [1080p]');
  assert.equal(episodeTitle('Lesson 4.mp4', [], true), 'Lesson 4');
  assert.equal(showTitle('Quiet Harbour', 'Quiet Harbour'), null);
  assert.equal(showTitle(null, 'Lesson 4'), null);
  assert.equal(showTitle('Paper Lanterns', 'Episode 2'), 'Paper Lanterns');
});

test('a title naming its episode needs no number badge', () => {
  assert.ok(namesEpisode('Episode 3 · Title'));
  assert.ok(namesEpisode('S1 E3'));
  assert.ok(!namesEpisode('Lesson 3'));
});
