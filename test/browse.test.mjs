import './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { userDb } from '../src/core/db.mjs';
import { getSettings, setSettings, setLibraryRoot } from '../src/core/settings.mjs';
import { ffmpeg } from '../src/core/ffmpeg.mjs';
import * as lib from '../src/core/library.mjs';
import * as browse from '../src/core/browse.mjs';
import { thumbnail } from '../src/core/thumbs.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-browse-'));
const ROOT = path.join(TMP, 'Library');
const touch = (rel, body = 'x') => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

// Show/Season N/ep, a loose film, hidden and non-media files, a folder with only audio.
const S1 = ['[Grp] Show - 01 [1080p].mkv', '[Grp] Show - 02 [1080p].mkv', '[Grp] Show - 10 [1080p].mkv'].map((n) => touch(`Show (2019) [BD]/Season 1/${n}`));
const S2 = touch('Show (2019) [BD]/Season 2/[Grp] Show S2 - 01 [1080p].mkv');
const DEEP = touch('Show (2019) [BD]/Season 2/Extras/Deeper/clip.mkv');
const FILM = touch('Film.mp4');
touch('.hidden/secret.mkv');
touch('Show (2019) [BD]/Season 1/.ep.mkv');
touch('Show (2019) [BD]/notes.txt');
touch('Music/Track 1.flac');
setLibraryRoot(ROOT);

const sittingOver = (id) => userDb().prepare('UPDATE media SET last_opened_at = ? WHERE id = ?').run(Date.now() - 600_000, id);
function stopAt(file, position, duration = 1440) {
  const { id } = lib.openMedia(file);
  sittingOver(id);
  lib.setPosition(id, position, duration);
  return id;
}

test('natural sort: "Episode 2" before "Episode 10"', () => {
  const names = ['Episode 10.mkv', 'episode 2.mkv', 'Episode 1.mkv'];
  assert.deepEqual(names.sort(lib.naturalCompare), ['Episode 1.mkv', 'episode 2.mkv', 'Episode 10.mkv']);
});

test('the root lists folders and videos, skipping hidden ones, with tidy names and counts', () => {
  const l = browse.browse();
  assert.equal(l.title, 'Library');
  assert.equal(l.detail, '2 folders · 1 video');
  assert.deepEqual(l.folders.map((f) => f.title), ['Music', 'Show (2019)']);
  assert.deepEqual(l.videos.map((v) => v.title), ['Film']);
  assert.deepEqual(l.crumbs, [{ path: ROOT, title: 'Library' }]);
});

test('a folder card counts its videos and seasons two levels down, with its first video as cover', () => {
  const show = browse.browse().folders.find((f) => f.path.endsWith('[BD]'));
  assert.equal(show.title, 'Show (2019)');
  assert.equal(show.subtitle, '4 videos', 'Season 2/Extras/Deeper is three levels down');
  assert.equal(show.cover, S1[0]);
  assert.deepEqual(show.shares, [[0, 0, 0], [0]]);
  const music = browse.browse().folders.find((f) => f.title === 'Music');
  assert.equal(music.subtitle, '1 video');
  assert.equal(music.cover, null, 'audio has no frame');
});

test('inside a season: breadcrumbs, episode titles and place badges', () => {
  const l = browse.browse(path.dirname(S1[0]));
  assert.deepEqual(l.crumbs.map((c) => c.title), ['Library', 'Show (2019)', 'Season 1']);
  assert.deepEqual(l.videos.map((v) => [v.title, v.badge]), [['Episode 1', null], ['Episode 2', null], ['Episode 10', null]]);
  setSettings({ tidyNames: false });
  assert.deepEqual(browse.browse(path.dirname(S1[0])).videos.map((v) => [v.title, v.badge]), [
    ['[Grp] Show - 01 [1080p]', 1], ['[Grp] Show - 02 [1080p]', 2], ['[Grp] Show - 10 [1080p]', 3],
  ]);
  setSettings({ tidyNames: true });
  assert.equal(browse.browse(path.dirname(DEEP)).detail, '1 video');
});

test('browsing stays inside the root', () => {
  assert.throws(() => browse.browse(TMP), /not in your library/);
  assert.throws(() => browse.browse(path.join(ROOT, '..')), /not in your library/);
  assert.throws(() => browse.checkPath('/etc/hosts'), /not in your library/);
  const outside = path.join(TMP, 'Outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.mkv'), 'x');
  fs.symlinkSync(outside, path.join(ROOT, 'escape'));
  assert.throws(() => browse.browse(path.join(ROOT, 'escape')), /not in your library/);
  assert.throws(() => browse.checkPath(path.join(ROOT, 'escape', 'secret.mkv')), /not in your library/);
  fs.rmSync(path.join(ROOT, 'escape'));
  assert.equal(browse.checkPath(FILM), FILM);
});

test('Continue watching: newest first, one card per show, top-level and outside videos alone', () => {
  const outside = path.join(TMP, 'Elsewhere', 'Lone [720p].mkv');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'x');
  stopAt(S1[0], 300);
  stopAt(S1[1], 600);
  stopAt(FILM, 60, 7200);
  stopAt(outside, 120);
  const resume = browse.browse().resume;
  assert.deepEqual(resume.map((r) => [r.title, r.subtitle]), [
    ['Lone', '22 min left'],
    ['Film', '1 h 59 min left'],
    ['Season 1', 'Episode 2 · 14 min left'],
  ]);
  assert.equal(resume[2].path, S1[1]);
  assert.equal(resume[0].folder, null, 'outside the root: no folder to go to');
  fs.rmSync(outside);
  assert.equal(browse.browse().resume.length, 2, 'missing files are hidden');
  browse.forget(FILM);
  assert.deepEqual(browse.browse().resume.map((r) => r.path), [S1[1]]);
  assert.equal(lib.getMedia(lib.idByPath(FILM)).position, 60, 'removing from the row keeps the place');
  setSettings({ continueWatching: false });
  assert.deepEqual(browse.browse().resume, []);
  setSettings({ continueWatching: true });
});

test('mark all as watched and clear progress, recursively', () => {
  const show = path.dirname(path.dirname(S1[0]));
  browse.markWatched(show);
  let card = browse.browse().folders.find((f) => f.path === show);
  assert.equal(card.subtitle, '4 videos · all watched');
  assert.ok(card.allWatched);
  assert.deepEqual(browse.browse(path.dirname(S1[0])).videos.map((v) => v.watched), [true, true, true]);
  assert.equal(lib.idByPath(DEEP), undefined, 'four levels down is out of reach, as for the count');
  assert.equal(browse.browse().resume.some((r) => r.path.startsWith(show)), false);

  browse.clearProgress(S2);
  card = browse.browse().folders.find((f) => f.path === show);
  assert.equal(card.subtitle, '4 videos · 3 watched');
  assert.deepEqual(card.shares, [[1, 1, 1], [0]]);
  setSettings({ showProgress: false });
  assert.equal(browse.browse().folders.find((f) => f.path === show).subtitle, '4 videos');
  setSettings({ showProgress: true });
  browse.clearProgress(show);
  assert.equal(browse.browse().folders.find((f) => f.path === show).subtitle, '4 videos');
});

test('the renderer cannot set the library folder', () => {
  assert.throws(() => setSettings({ libraryRoot: '/' }), /folder picker/);
});

test('rows for retired settings stay out of the settings', () => {
  userDb().prepare("INSERT INTO settings (key, value) VALUES ('retiredSetting', '\"x\"')").run();
  assert.equal('retiredSetting' in getSettings(), false);
});

test('thumbnails: a frame a fifth in, cached; a left-off frame retaken past 30 s', async () => {
  const video = path.join(ROOT, 'Clip.mkv');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=160x90:d=120:r=5', '-c:v', 'libx264', '-preset', 'ultrafast', video]);
  const own = await thumbnail(video);
  assert.match(own, /\.jpg$/);
  assert.equal(fs.readFileSync(own).subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(await thumbnail(video), own);
  const at50 = await thumbnail(video, 50);
  assert.notEqual(at50, own);
  assert.equal(await thumbnail(video, 75), at50, 'within 30 s: kept');
  const at90 = await thumbnail(video, 90);
  assert.notEqual(at90, at50);
  assert.ok(!fs.existsSync(at50), 'the old left-off frame goes');
  assert.ok(fs.existsSync(own));
});
