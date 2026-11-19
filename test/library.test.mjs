import './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { configurePaths, paths } from '../src/core/paths.mjs';
import { userDb } from '../src/core/db.mjs';
import { ffmpeg } from '../src/core/ffmpeg.mjs';
import * as lib from '../src/core/library.mjs';
import { migrateLegacy } from '../src/core/migrate-legacy.mjs';

// The migration test writes dictionary rows: never into the shared dict.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-lib-'));
configurePaths({ dictDbPath: path.join(TMP, 'dict.db') });

const JA_SRT = '1\n00:00:00,500 --> 00:00:01,500\n正直、今日は行きたくないんだよね。\n\n2\n00:00:01,600 --> 00:00:02,500\nからかうのはやめてよ、高木さん。\n';
const EN_SRT = "1\n00:00:00,500 --> 00:00:01,500\nHonestly, I don't want to go today.\n\n2\n00:00:01,600 --> 00:00:02,500\nStop teasing me, Takagi. What is that?\n";

const write = (file, body = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

// One real two-second mkv with two embedded text tracks (jpn, eng) and a PGS-free layout; copies fill the trees.
const MASTER = path.join(TMP, 'master.mkv');
write(path.join(TMP, 'm.ja.srt'), JA_SRT);
write(path.join(TMP, 'm.en.srt'), EN_SRT);
execFileSync(ffmpeg(), [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
  '-i', path.join(TMP, 'm.ja.srt'), '-i', path.join(TMP, 'm.en.srt'),
  '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3', '-t', '2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt',
  '-metadata:s:s:0', 'language=jpn', '-metadata:s:s:1', 'language=eng', '-metadata:s:s:1', 'title=English Subs',
  MASTER,
]);
let n = 0;
// Distinct sizes so basename+size relinking is unambiguous.
const media = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(MASTER, file);
  fs.appendFileSync(file, Buffer.alloc(++n));
  return file;
};
const tree = (name) => fs.mkdtempSync(path.join(TMP, `${name}-`));
const fileKeys = async (id) => (await lib.subtitleTracks(id)).filter((t) => t.kind === 'file').map((t) => path.basename(t.file));

test('episode numbers from every common naming scheme', () => {
  const ep = (n) => lib.episodeInfo(n).episode;
  assert.equal(ep('[washed] Karakai Jouzu no Takagi-san - S01E03 (BD 1080p HEVC Opus).mkv'), 3);
  assert.equal(ep('[synced for Erai-raws] Karakai Jouzu no Takagi-san -  (3).srt'), 3);
  assert.equal(ep('[synced for Erai-raws] Karakai Jouzu no Takagi-san - (12).srt'), 12);
  assert.equal(ep('[SubsPlease] Frieren - 03 (1080p) [ABCD1234].mkv'), 3);
  assert.equal(ep('Show E03.mkv'), 3);
  assert.equal(ep('Show EP03.ja.srt'), 3);
  assert.equal(ep('Show Episode 3.srt'), 3);
  assert.equal(ep('Show #03.srt'), 3);
  assert.equal(ep('からかい上手の高木さん 第3話.srt'), 3);
  assert.equal(ep('からかい上手の高木さん 第３話.srt'), 3);
  assert.equal(ep('Show 1x03 720p.srt'), 3);
  assert.equal(ep('Show 03.srt'), 3);
  assert.equal(ep('Movie (2019) 1080p x264.mkv'), null);
  assert.equal(lib.episodeInfo('Show.S02E10.1080p.WEB.x264.mkv').season, 2);
  assert.deepEqual(lib.episodeInfo('[washed] Karakai Jouzu no Takagi-san - S01E03 (BD 1080p HEVC Opus).mkv').series, ['karakai', 'jouzu', 'no', 'takagi', 'san']);
});

test('language and flags from filename tags', () => {
  const lang = (n) => lib.nameTags(n).language;
  assert.equal(lang('Video.ja.srt'), 'ja');
  assert.equal(lang('Video.jpn.srt'), 'ja');
  assert.equal(lang('Video.Japanese.srt'), 'ja');
  assert.equal(lang('Video.ja-JP.srt'), 'ja');
  assert.equal(lang('Video [Japanese].srt'), 'ja');
  assert.equal(lang('Video.eng.sdh.srt'), 'en');
  assert.equal(lang('2_English.srt'), 'en');
  assert.equal(lang('Video.en.forced.srt'), 'en');
  assert.equal(lang('Kono Oto Tomare de.srt'), null, 'two-letter romaji particle is not a language tag');
  assert.equal(lang('Karakai Jouzu no Takagi-san - (3).srt'), null);
  assert.equal(lib.nameTags('Video.ja.forced.srt').forced, true);
  assert.equal(lib.nameTags('Video.en.sdh.srt').sdh, true);
});

test('language sniffing from subtitle text', () => {
  assert.equal(lib.sniffLanguage([{ text: '正直、今日は行きたくないんだよね。からかうのはやめてよ。' }]), 'ja');
  assert.equal(lib.sniffLanguage([{ text: "Honestly, I don't want to go today. Stop teasing me, what is that?" }]), 'en');
  assert.equal(lib.sniffLanguage([{ text: '...' }]), null);
});

test('same-folder discovery: exact stems with tags, episode numbers, never another episode', async () => {
  const dir = tree('show');
  const v3 = media(path.join(dir, 'Show - S01E03 [1080p].mkv'));
  media(path.join(dir, 'Show - S01E01 [1080p].mkv'));
  media(path.join(dir, 'Show - S01E13 [1080p].mkv'));
  write(path.join(dir, 'Show - S01E03 [1080p].ja.srt'), JA_SRT);
  write(path.join(dir, 'Show - S01E03 [1080p].en.srt'), EN_SRT);
  write(path.join(dir, 'Show - S01E03 [1080p].ja.forced.srt'), JA_SRT);
  write(path.join(dir, 'Show 03.srt'), JA_SRT); // renamed differently, same episode
  write(path.join(dir, 'Show - S01E01 [1080p].ja.srt'), JA_SRT);
  write(path.join(dir, 'Show - 13.srt'), JA_SRT);
  write(path.join(dir, 'Show - S02E03.srt'), JA_SRT); // different season
  write(path.join(dir, 'Other Series - 03.srt'), JA_SRT); // different show, same number
  const id = lib.openMedia(v3).id;
  const tracks = await lib.subtitleTracks(id);
  const files = tracks.filter((t) => t.kind === 'file');
  assert.deepEqual(files.map((t) => path.basename(t.file)).sort(), [
    'Show - S01E03 [1080p].en.srt', 'Show - S01E03 [1080p].ja.forced.srt', 'Show - S01E03 [1080p].ja.srt', 'Show 03.srt',
  ]);
  // Ranked: Japanese exact, then embedded Japanese, then sniffed-Japanese episode match, forced, then English.
  assert.equal(path.basename(tracks[0].file), 'Show - S01E03 [1080p].ja.srt');
  assert.equal(tracks[0].language, 'ja');
  assert.equal(tracks[1].key, 'stream:2');
  assert.equal(files.find((t) => t.file.endsWith('Show 03.srt')).match, 'episode');
  assert.equal(files.find((t) => t.file.endsWith('Show 03.srt')).language, 'ja', 'sniffed from text');
  const order = tracks.map((t) => t.key);
  const forced = order.findIndex((k) => k.endsWith('.ja.forced.srt'));
  const english = order.findIndex((k) => k.endsWith('.en.srt'));
  assert.ok(forced > order.indexOf('stream:2') && english > forced, order.join('\n'));
  assert.equal(tracks.at(-1).language, 'en');
});

test('episode prefix never matches a longer number (E1 vs E10)', async () => {
  const dir = tree('prefix');
  const e1 = media(path.join(dir, 'Show E1.mkv'));
  media(path.join(dir, 'Show E10.mkv'));
  write(path.join(dir, 'Show E10.ja.srt'), JA_SRT);
  write(path.join(dir, 'Show E1.ja.srt'), JA_SRT);
  assert.deepEqual(await fileKeys(lib.openMedia(e1).id), ['Show E1.ja.srt']);
});

test('Subs/ folders: YTS layout, RARBG Subs/<stem>/, language subfolders', async () => {
  const yts = tree('yts');
  const movie = media(path.join(yts, 'Movie (2019) [1080p] [YTS.MX].mp4'));
  write(path.join(yts, 'Subs', '2_English.srt'), EN_SRT);
  write(path.join(yts, 'Subs', '3_Japanese.srt'), JA_SRT);
  const tracks = (await lib.subtitleTracks(lib.openMedia(movie).id)).filter((t) => t.kind === 'file');
  assert.deepEqual(tracks.map((t) => [path.basename(t.file), t.language, t.source]), [
    ['3_Japanese.srt', 'ja', 'subfolder'],
    ['2_English.srt', 'en', 'subfolder'],
  ]);

  const rarbg = tree('rarbg');
  const ep = media(path.join(rarbg, 'Show.S01E03.1080p.WEB.x264.mkv'));
  media(path.join(rarbg, 'Show.S01E04.1080p.WEB.x264.mkv'));
  write(path.join(rarbg, 'Subs', 'Show.S01E03.1080p.WEB.x264', '2_English.srt'), EN_SRT);
  write(path.join(rarbg, 'Subs', 'Show.S01E04.1080p.WEB.x264', '2_English.srt'), EN_SRT);
  write(path.join(rarbg, 'Subs', 'Japanese', 'Show.S01E03.srt'), JA_SRT);
  write(path.join(rarbg, 'Subs', 'Japanese', 'Show.S01E04.srt'), JA_SRT);
  const rt = (await lib.subtitleTracks(lib.openMedia(ep).id)).filter((t) => t.kind === 'file');
  assert.deepEqual(rt.map((t) => [path.relative(rarbg, t.file), t.language]), [
    [path.join('Subs', 'Japanese', 'Show.S01E03.srt'), 'ja'],
    [path.join('Subs', 'Show.S01E03.1080p.WEB.x264', '2_English.srt'), 'en'],
  ]);
});

test('Takagi: original Downloads layout with subs in a sibling folder, and the renamed layout', async () => {
  const downloads = tree('Downloads');
  const vdir = path.join(downloads, '[washed] Karakai Jouzu no Takagi-san - S01 (BD 1080p HEVC Opus)');
  const sdir = path.join(downloads, '[synced for Erai-raws] Karakai Jouzu no Takagi-san (01-12)');
  for (const e of ['01', '02', '03', '10']) media(path.join(vdir, `[washed] Karakai Jouzu no Takagi-san - S01E${e} (BD 1080p HEVC Opus).mkv`));
  for (const k of [1, 2, 3, 4, 10, 13]) write(path.join(sdir, `[synced for Erai-raws] Karakai Jouzu no Takagi-san -  (${k}).srt`), JA_SRT);
  write(path.join(sdir, '[synced for Erai-raws] Karakai Jouzu no Takagi-san - (12).srt'), JA_SRT);
  // Decoys: another season and an unrelated show with the same numbering.
  write(path.join(downloads, '[Erai-raws] Karakai Jouzu no Takagi-san 2 (01-12)', 'Karakai Jouzu no Takagi-san 2 - (3).srt'), JA_SRT);
  write(path.join(downloads, '[Erai-raws] Kaguya-sama (01-12)', 'Kaguya-sama - (3).srt'), JA_SRT);
  fs.writeFileSync(path.join(downloads, 'unrelated.zip'), '');

  const e3 = path.join(vdir, '[washed] Karakai Jouzu no Takagi-san - S01E03 (BD 1080p HEVC Opus).mkv');
  const tracks = await lib.subtitleTracks(lib.openMedia(e3).id);
  const files = tracks.filter((t) => t.kind === 'file');
  assert.deepEqual(files.map((t) => t.file), [path.join(sdir, '[synced for Erai-raws] Karakai Jouzu no Takagi-san -  (3).srt')]);
  assert.equal(files[0].source, 'nearby');
  assert.equal(files[0].language, 'ja');
  // Embedded Japanese is certain to belong to this file, so it outranks the heuristic match.
  assert.deepEqual(tracks.slice(0, 2).map((t) => t.key), ['stream:2', `file:${files[0].file}`]);

  const e10 = path.join(vdir, '[washed] Karakai Jouzu no Takagi-san - S01E10 (BD 1080p HEVC Opus).mkv');
  assert.deepEqual(await fileKeys(lib.openMedia(e10).id), ['[synced for Erai-raws] Karakai Jouzu no Takagi-san -  (10).srt']);

  const loaded = await lib.loadSubtitleTrack(lib.openMedia(e3).id, tracks[0].key);
  assert.equal(loaded.cues.length, 2);

  // ~/Media layout: renamed .ja.srt siblings next to the videos.
  const mediaDir = path.join(tree('Media'), 'Karakai Jouzu no Takagi-san S01');
  const v = media(path.join(mediaDir, '[washed] Karakai Jouzu no Takagi-san - S01E03 (BD 1080p HEVC Opus).mkv'));
  media(path.join(mediaDir, '[washed] Karakai Jouzu no Takagi-san - S01E04 (BD 1080p HEVC Opus).mkv'));
  write(path.join(mediaDir, '[washed] Karakai Jouzu no Takagi-san - S01E03 (BD 1080p HEVC Opus).ja.srt'), JA_SRT);
  write(path.join(mediaDir, '[washed] Karakai Jouzu no Takagi-san - S01E04 (BD 1080p HEVC Opus).ja.srt'), JA_SRT);
  const t = await lib.subtitleTracks(lib.openMedia(v).id);
  assert.equal(path.basename(t[0].file), '[washed] Karakai Jouzu no Takagi-san - S01E03 (BD 1080p HEVC Opus).ja.srt');
  assert.equal(t[0].label, 'Japanese · ja.srt');
  assert.equal(t.filter((x) => x.kind === 'file').length, 1);
});

test('embedded tracks carry language/title and extraction is cached', async () => {
  const dir = tree('embedded');
  const v = media(path.join(dir, 'Embedded.mkv'));
  const { id } = lib.openMedia(v);
  const streams = (await lib.subtitleTracks(id)).filter((t) => t.kind === 'stream');
  assert.deepEqual(streams.map((t) => [t.key, t.language, t.title]), [['stream:2', 'ja', null], ['stream:3', 'en', 'English Subs']]);

  const cacheDir = path.join(paths.userDataDir, 'subs-cache');
  const before = new Set(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []);
  const first = await lib.loadSubtitleTrack(id, 'stream:2');
  assert.equal(first.cues[0].text, '正直、今日は行きたくないんだよね。');
  assert.equal(first.track.language, 'ja');
  const added = fs.readdirSync(cacheDir).filter((f) => !before.has(f));
  assert.equal(added.length, 1);
  // Prove the second load is served from the cache, not ffmpeg.
  const cached = path.join(cacheDir, added[0]);
  fs.writeFileSync(cached, fs.readFileSync(cached, 'utf8').replace('正直', '素直'));
  const second = await lib.loadSubtitleTrack(id, 'stream:2');
  assert.equal(second.cues[0].text, '素直、今日は行きたくないんだよね。');
  // A changed file (new mtime/size) misses the cache.
  fs.appendFileSync(v, Buffer.alloc(1));
  const third = await lib.loadSubtitleTrack(id, 'stream:2');
  assert.equal(third.cues[0].text, '正直、今日は行きたくないんだよね。');
});

test('access control: only discovered/attached subtitle files and real text streams load', async () => {
  const dir = tree('acl');
  const v = media(path.join(dir, 'Clip.mkv'));
  media(path.join(dir, 'Clip 2.mkv'));
  const secret = write(path.join(tree('elsewhere'), 'secret.srt'), JA_SRT);
  const { id } = lib.openMedia(v);
  await assert.rejects(lib.loadSubtitleTrack(id, `file:${secret}`), /not associated/);
  await assert.rejects(lib.loadSubtitleTrack(id, `file:${dir}/../${path.basename(path.dirname(secret))}/secret.srt`), /not associated/);
  await assert.rejects(lib.loadSubtitleTrack(id, 'stream:0'), /no such text subtitle stream/, 'video stream is not a subtitle');
  await assert.rejects(lib.loadSubtitleTrack(id, 'stream:99'), /no such/);
  await assert.rejects(lib.loadSubtitleTrack(id, 'stream:1;rm'), /bad subtitle track key/);
  await assert.rejects(lib.loadSubtitleTrack(9999, 'stream:2'), /unknown media id/);

  assert.throws(() => lib.attachSubtitle(id, path.join(dir, 'Clip 2.mkv')), /Not a subtitle file/);
  fs.mkdirSync(path.join(dir, 'dir.srt'));
  assert.throws(() => lib.attachSubtitle(id, path.join(dir, 'dir.srt')), /Not a file/);
  assert.throws(() => lib.attachSubtitle(id, path.join(dir, 'missing.srt')), /File not found/);
  const key = lib.attachSubtitle(id, secret);
  assert.equal((await lib.loadSubtitleTrack(id, key)).cues.length, 2);
  assert.equal((await lib.subtitleTracks(id)).find((t) => t.key === key).source, 'attached');

  assert.equal(lib.isKnownFolder(dir), true);
  assert.equal(lib.isKnownFolder(path.join(dir, 'sub')), false);
  assert.equal(lib.isKnownFolder(path.dirname(dir)), false);
  assert.throws(() => lib.openMedia(path.join(dir, 'dir.srt')), /Not a media file/);
  fs.mkdirSync(path.join(dir, 'folder.mkv'));
  assert.throws(() => lib.openMedia(path.join(dir, 'folder.mkv')), /Not a file/);
});

test('playlist: natural order, adjacent registers and opens, null at the ends', () => {
  const dir = tree('playlist');
  for (const e of [10, 2, 1]) media(path.join(dir, `Show E${e}.mkv`));
  write(path.join(dir, '.hidden.mkv'));
  write(path.join(dir, 'notes.txt'));
  const first = lib.openMedia(path.join(dir, 'Show E1.mkv'));
  assert.deepEqual(lib.siblings(first.id).map((s) => s.title), ['Show E1', 'Show E2', 'Show E10']);
  assert.equal(lib.siblings(first.id)[1].id, null, 'not registered until visited');
  const second = lib.adjacent(first.id, 1);
  assert.equal(path.basename(second.path), 'Show E2.mkv');
  assert.equal(path.basename(lib.adjacent(second.id, 1).path), 'Show E10.mkv');
  assert.equal(lib.adjacent(lib.siblings(first.id)[2].id, 1), null);
  assert.equal(lib.adjacent(first.id, -1), null);
  assert.equal(lib.adjacent(second.id, -1).id, first.id);
  assert.throws(() => lib.adjacent(first.id, 0), /non-zero/);
});

test('moved files: auto-relink by basename+size on open and on folder open, locate keeps the id', () => {
  const a = tree('old');
  const b = tree('new');
  const e1 = media(path.join(a, 'Takagi E1.mkv'));
  const e2 = media(path.join(a, 'Takagi E2.mkv'));
  const sub = write(path.join(a, 'Takagi E1.custom.srt'), JA_SRT);
  const r1 = lib.openMedia(e1);
  const r2 = lib.openMedia(e2);
  lib.attachSubtitle(r1.id, sub);
  lib.setPrefs(r1.id, { subTrack: `file:${sub}`, rate: 0.75 });
  userDb().prepare('UPDATE media SET last_opened_at = ? WHERE id = ?').run(Date.now() - 600_000, r1.id); // past a quick look
  lib.setPosition(r1.id, 42, 120);
  userDb().prepare('INSERT INTO line (media_id, idx, start_ms, end_ms, text) VALUES (?, 0, 0, 1000, ?)').run(r1.id, 'からかう');

  for (const f of [e1, e2, sub]) fs.renameSync(f, path.join(b, path.basename(f)));
  assert.equal(lib.getMedia(r1.id).exists, false);

  // Opening the moved E1 relinks it (same id) and, by scanning the folder, E2 too.
  const moved = lib.openMedia(path.join(b, 'Takagi E1.mkv'));
  assert.equal(moved.id, r1.id);
  assert.equal(moved.position, 42);
  assert.equal(moved.prefs.rate, 0.75);
  assert.equal(moved.prefs.subTrack, `file:${path.join(b, 'Takagi E1.custom.srt')}`);
  assert.equal(lib.getMedia(r2.id).path, path.join(b, 'Takagi E2.mkv'));
  assert.equal(userDb().prepare('SELECT count(*) AS n FROM line WHERE media_id = ?').get(r1.id).n, 1);

  // Different size: not the same file, no relink.
  const c = tree('other');
  const r3 = lib.openMedia(media(path.join(c, 'Lonely.mkv')));
  fs.rmSync(path.join(c, 'Lonely.mkv'));
  const fresh = lib.openMedia(write(path.join(tree('elsewhere'), 'Lonely.mkv'), 'different'));
  assert.notEqual(fresh.id, r3.id);

  // Manual locate to a renamed file keeps the id and merges a duplicate record.
  const renamed = path.join(c, 'Lonely (renamed).mkv');
  media(renamed);
  const dup = lib.openMedia(renamed);
  const located = lib.locateMedia(r3.id, renamed);
  assert.equal(located.id, r3.id);
  assert.equal(located.exists, true);
  assert.equal(lib.getMedia(dup.id), undefined);
  assert.throws(() => lib.locateMedia(r3.id, path.join(c, 'nope.mkv')), /File not found/);
});

test('history: recents by last opened; remove/clear hide but keep the record', async () => {
  const dir = tree('history');
  const a = lib.openMedia(media(path.join(dir, 'A.mkv')));
  await new Promise((r) => setTimeout(r, 5));
  const b = lib.openMedia(media(path.join(dir, 'B.mkv')));
  let ids = lib.listMedia().map((m) => m.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
  userDb().prepare('INSERT INTO line (media_id, idx, start_ms, end_ms, text) VALUES (?, 0, 0, 1000, ?)').run(a.id, 'line');
  lib.removeMedia(a.id);
  ids = lib.listMedia().map((m) => m.id);
  assert.ok(!ids.includes(a.id) && ids.includes(b.id));
  assert.equal(userDb().prepare('SELECT count(*) AS n FROM line WHERE media_id = ?').get(a.id).n, 1);
  assert.equal(lib.openMedia(path.join(dir, 'A.mkv')).id, a.id, 'reopening restores the same record');
  lib.clearHistory();
  assert.deepEqual(lib.listMedia(), []);
  assert.equal(lib.pathOf(b.id), path.join(dir, 'B.mkv'));
});

test('per-media prefs are validated', () => {
  const { id } = lib.openMedia(media(path.join(tree('prefs'), 'P.mkv')));
  assert.deepEqual(lib.setPrefs(id, { subTrack: 'stream:2', refTrack: null, subDelayMs: -250.4, rate: 1.5 }), {
    subTrack: 'stream:2', refTrack: null, subDelayMs: -250, rate: 1.5,
  });
  assert.deepEqual(lib.setPrefs(id, { rate: undefined }), { subTrack: 'stream:2', refTrack: null, subDelayMs: -250 });
  assert.throws(() => lib.setPrefs(id, { volume: 1 }), /unknown pref/);
  assert.throws(() => lib.setPrefs(id, { subTrack: '/etc/passwd' }), /invalid subTrack/);
  assert.throws(() => lib.setPrefs(id, { rate: 10 }), /invalid rate/);
  assert.throws(() => lib.setPrefs(id, { subDelayMs: 'x' }), /invalid subDelayMs/);
  assert.throws(() => lib.setPrefs(id, [1]), /object/);
  assert.throws(() => lib.setPrefs(9999, {}), /unknown media id/);
});

test('legacy migration: tolerant of missing files and a dict without forms, idempotent', () => {
  const legacyPath = path.join(TMP, 'legacy.db');
  const present = media(path.join(tree('legacy'), '[washed] Karakai Jouzu no Takagi-san - S01E04 (BD 1080p HEVC Opus).mkv'));
  const missing = path.join(TMP, 'gone', '[washed] Karakai Jouzu no Takagi-san - S01E08 (BD 1080p HEVC Opus).mkv');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE dict (id INTEGER PRIMARY KEY, kanji TEXT, reading TEXT, pos TEXT, gloss TEXT, common INTEGER);
    CREATE TABLE dict_form (form TEXT, dict_id INTEGER);
    CREATE TABLE line (media TEXT, idx INTEGER, start_ms INTEGER, end_ms INTEGER, text TEXT, PRIMARY KEY (media, idx));
    CREATE TABLE mined (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, type TEXT, media TEXT, cue INTEGER, at INTEGER);
    INSERT INTO dict VALUES (1, '正直', 'しょうじき', '[]', '["honesty"]', 1);
    INSERT INTO dict_form VALUES ('正直', 1);
  `);
  const b64 = (p) => Buffer.from(p).toString('base64url');
  const insLine = legacy.prepare('INSERT INTO line VALUES (?, ?, 0, 1000, ?)');
  insLine.run(b64(present), 0, '正直');
  insLine.run(b64(missing), 0, '西片の負け');
  insLine.run(b64('relative/path.mkv'), 0, 'skipped');
  legacy.prepare("INSERT INTO mined (word, type, media, cue, at) VALUES ('正直', 'cloze', ?, 0, 1)").run(b64(present));
  legacy.close();

  const report = migrateLegacy(legacyPath);
  assert.deepEqual({ ...report }, { dict: 1, media: 2, lines: 2, mined: 1 });
  assert.deepEqual(migrateLegacy(legacyPath), { skipped: 'already migrated' });
  assert.deepEqual(migrateLegacy(path.join(TMP, 'nope.db')), { skipped: 'no legacy database' });

  const row = (p) => userDb().prepare('SELECT * FROM media WHERE path = ?').get(p);
  assert.ok(lib.listMedia().some((m) => m.path === present), 'files on disk join the history');
  assert.equal(row(missing).last_opened_at, null, 'missing files stay hidden');
  assert.equal(userDb().prepare('SELECT count(*) AS n FROM line WHERE media_id = ?').get(row(missing).id).n, 1);

  // The missing legacy file turns up elsewhere: same record, corpus intact.
  const found = media(path.join(tree('found'), path.basename(missing)));
  assert.equal(lib.openMedia(found).id, row(found).id);
  assert.equal(row(found).id, userDb().prepare('SELECT media_id FROM line WHERE text = ?').get('西片の負け').media_id);
});
