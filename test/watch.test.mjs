import './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { configurePaths } from '../src/core/paths.mjs';
import { userDb, closeDatabases } from '../src/core/db.mjs';
import * as lib from '../src/core/library.mjs';
import { finished, skimmed, share, timeLeft, folderDetail } from '../src/core/watch.mjs';

// Rules ported from Mizune's RecentVideosTest.kt and ProgressTest.kt.

test('the credits count as watched', () => {
  const episode = 24 * 60;
  assert.ok(finished(episode - 120, episode));
  assert.ok(!finished(episode - 180, episode));
  // A film's last tenth would be its ending too, so five minutes at most.
  const film = 120 * 60;
  assert.ok(finished(film - 240, film));
  assert.ok(!finished(film - 360, film));
  assert.ok(!finished(10, 0));
});

test("a look isn't watching", () => {
  const episode = 24 * 60;
  assert.ok(skimmed(45, episode));
  assert.ok(!skimmed(75, episode));
  // Half a minute of a one-minute clip is more than a look.
  assert.ok(!skimmed(30, 60));
  assert.ok(skimmed(10, 60));
  // A sitting played before the length was known isn't thrown away.
  assert.ok(!skimmed(10, 0));
});

test('time left, shares and folder details', () => {
  assert.equal(timeLeft(20), 'Under a minute left');
  assert.equal(timeLeft(12 * 60), '12 min left');
  assert.equal(timeLeft(65 * 60), '1 h 5 min left');
  assert.equal(share(0, 1440, true), 1);
  assert.equal(share(360, 1440, false), 0.25);
  assert.equal(share(360, 0, false), 0);
  assert.equal(folderDetail(0, 0), null);
  assert.equal(folderDetail(1, 0), '1 video');
  assert.equal(folderDetail(12, 5), '12 videos · 5 watched');
  assert.equal(folderDetail(12, 12), '12 videos · all watched');
});

test('setPosition: a short sitting is not saved, the credits mark it watched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-watch-'));
  const file = path.join(dir, 'Show - 01.mkv');
  fs.writeFileSync(file, 'x');
  const { id } = lib.openMedia(file);
  const sittingFor = (seconds) => userDb().prepare('UPDATE media SET last_opened_at = ? WHERE id = ?').run(Date.now() - seconds * 1000, id);
  const row = () => userDb().prepare('SELECT position, duration, watched, played_at FROM media WHERE id = ?').get(id);

  lib.setPosition(id, 300, 1440);
  assert.deepEqual({ ...row() }, { position: 0, duration: 1440, watched: 0, played_at: null }, 'a look keeps nothing but the length');

  sittingFor(120);
  lib.setPosition(id, 300, 1440);
  assert.equal(row().position, 300);
  assert.ok(row().played_at > 0, 'joins Continue watching');

  lib.setPosition(id, 1400, 1440);
  assert.equal(row().position, 0, 'finished episodes start over');
  assert.equal(row().watched, 1);
  assert.equal(lib.getMedia(id).watched, true);
});

test('an older user.db gains watched and Continue watching, keeping its rows', () => {
  closeDatabases();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-migrate-'));
  const old = new DatabaseSync(path.join(dir, 'user.db'));
  old.exec(`CREATE TABLE media (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, size INTEGER,
    mtime REAL, duration REAL, added_at INTEGER NOT NULL, last_opened_at INTEGER, position REAL NOT NULL DEFAULT 0, prefs TEXT NOT NULL DEFAULT '{}')`);
  const ins = old.prepare('INSERT INTO media (path, title, duration, added_at, last_opened_at, position) VALUES (?, ?, ?, 1, ?, ?)');
  ins.run('/v/partway.mkv', 'partway', 1440, 500, 300);
  ins.run('/v/credits.mkv', 'credits', 1440, 400, 1420);
  ins.run('/v/unplayed.mkv', 'unplayed', null, 300, 0);
  old.close();

  configurePaths({ userDataDir: dir });
  const rows = Object.fromEntries(userDb().prepare('SELECT title, position, watched, played_at FROM media').all().map((r) => [r.title, { ...r }]));
  assert.deepEqual(rows.partway, { title: 'partway', position: 300, watched: 0, played_at: 500 });
  assert.deepEqual(rows.credits, { title: 'credits', position: 0, watched: 1, played_at: null });
  assert.deepEqual(rows.unplayed, { title: 'unplayed', position: 0, watched: 0, played_at: null });
  closeDatabases();
  configurePaths({ userDataDir: dir });
  assert.equal(userDb().prepare('SELECT count(*) AS n FROM media').get().n, 3, 'migrates once');
});
