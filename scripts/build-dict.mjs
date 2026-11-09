// Builds the SQLite dictionary from jmdict-simplified: JMdict (English) into
// dict/dict_form, JMnedict person and place names into name/name_form.
//   npm run dict                                  download the latest release
//   npm run dict -- jmdict.json.tgz jmnedict.json.tgz   offline, local files (.tgz or .json)
// Writes to a temp file beside the target and renames it into place, so a reader
// of the old file never sees a half-built one. Target: $KOTOBA_DICT_DB or data/dict.db.
//
// ponytail: whole-file JSON.parse (~200MB each) instead of a streaming parser. Needs
// the --max-old-space-size in the npm script; swap in a streaming parser only if a
// machine actually OOMs here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../src/core/paths.mjs';

const RELEASE_API = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';
const ASSETS = { jmdict: /^jmdict-eng-[\d.+]+\.json\.tgz$/, jmnedict: /^jmnedict-all-[\d.+]+\.json\.tgz$/ };
// Names a subtitle line actually contains. The rest (companies, works, stations,
// 130k "unclassified") would only add false matches.
const NAME_TYPES = new Set(['surname', 'given', 'masc', 'fem', 'person', 'place']);

const t0 = Date.now();
const log = (msg) => console.log(`[dict ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);

let release;
async function download(kind, tmp) {
  release ??= await fetch(RELEASE_API, { headers: { accept: 'application/vnd.github+json' } }).then((r) => {
    if (!r.ok) throw new Error(`GitHub API ${r.status}; pass local files instead: npm run dict -- jmdict.tgz jmnedict.tgz`);
    return r.json();
  });
  const asset = release.assets.find((a) => ASSETS[kind].test(a.name));
  if (!asset) throw new Error(`no ${kind} .json.tgz asset in release ${release.tag_name}`);
  log(`downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)}MB)...`);
  const res = await fetch(asset.browser_download_url);
  if (!res.ok) throw new Error(`download ${asset.name}: HTTP ${res.status}`);
  const file = path.join(tmp, asset.name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** Parsed JSON of a local .json / .json.tgz, or of the latest release asset. */
async function load(kind, local) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-dict-'));
  try {
    const file = local ? path.resolve(local) : await download(kind, tmp);
    if (local) log(`${kind}: using ${file}`);
    let jsonFile = file;
    if (/\.(tgz|tar\.gz)$/.test(file)) {
      execFileSync('tar', ['-xzf', file, '-C', tmp]);
      jsonFile = path.join(tmp, fs.readdirSync(tmp).find((f) => f.endsWith('.json')));
    }
    log(`${kind}: parsing ${path.basename(jsonFile)}...`);
    return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const target = paths.dictDbPath;
const out = `${target}.building-${process.pid}`;
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(out, { force: true });
const db = new DatabaseSync(out);
db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE dict (
    id      INTEGER PRIMARY KEY,
    kanji   TEXT NOT NULL DEFAULT '',
    reading TEXT NOT NULL DEFAULT '',
    forms   TEXT NOT NULL DEFAULT '[]',
    pos     TEXT NOT NULL DEFAULT '[]',
    gloss   TEXT NOT NULL DEFAULT '[]',
    common  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE dict_form (form TEXT NOT NULL, dict_id INTEGER NOT NULL);
  CREATE TABLE name (
    id      INTEGER PRIMARY KEY,
    kanji   TEXT NOT NULL DEFAULT '',
    reading TEXT NOT NULL,
    types   TEXT NOT NULL,  -- comma-separated JMnedict name types
    gloss   TEXT NOT NULL,  -- JSON array of romanisations / translations
    rank    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE name_form (form TEXT NOT NULL, name_id INTEGER NOT NULL, PRIMARY KEY (form, name_id)) WITHOUT ROWID;
`);

function buildWords(words) {
  const insEntry = db.prepare(
    'INSERT INTO dict (id, kanji, reading, forms, pos, gloss, common) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insForm = db.prepare('INSERT INTO dict_form (form, dict_id) VALUES (?, ?)');
  let n = 0;
  db.exec('BEGIN');
  for (const w of words) {
    const id = Number(w.id);
    if (!Number.isFinite(id)) continue;

    const kanji = w.kanji.filter((k) => !k.tags.includes('sK'));
    const kana = w.kana.filter((k) => !k.tags.includes('sk'));
    const common = kanji.some((k) => k.common) || kana.some((k) => k.common) ? 1 : 0;
    const pos = [...new Set(w.sense.flatMap((s) => s.partOfSpeech))];
    const gloss = w.sense.map((s) => ({ pos: s.partOfSpeech, misc: s.misc, text: s.gloss.map((g) => g.text) }));

    insEntry.run(
      id,
      kanji[0]?.text ?? '',
      kana[0]?.text ?? '',
      JSON.stringify(kanji.map((k) => ({ t: k.text, c: k.common ? 1 : 0 }))),
      JSON.stringify(pos),
      JSON.stringify(gloss),
      common
    );
    for (const form of new Set([...kanji.map((k) => k.text), ...kana.map((k) => k.text)])) insForm.run(form, id);
    if (++n % 50000 === 0) log(`  words ${n}/${words.length}`);
  }
  db.exec('COMMIT');
  return n;
}

const KATAKANA = /^[ァ-ヺー・]+$/;

function buildNames(words) {
  // How often a (spelling, reading) pair opens or closes the full name of a
  // well-known person: the only frequency signal JMnedict has. It is what ranks
  // 高木 たかぎ above たかき and こうぼく.
  const persons = new Map();
  const bucket = (k) => persons.get(k) ?? persons.set(k, []).get(k);
  for (const w of words) {
    if (!w.translation.some((t) => t.type.includes('person'))) continue;
    for (const k of w.kanji) for (const r of w.kana) {
      bucket('^' + k.text.slice(0, 2)).push([k.text, r.text]);
      bucket('$' + k.text.slice(-2)).push([k.text, r.text]);
    }
  }
  const rankOf = (k, r) =>
    k.length < 2
      ? 0
      : (persons.get('^' + k.slice(0, 2)) ?? []).filter(([pk, pr]) => pk !== k && pk.startsWith(k) && pr.startsWith(r)).length +
        (persons.get('$' + k.slice(-2)) ?? []).filter(([pk, pr]) => pk !== k && pk.endsWith(k) && pr.endsWith(r)).length;

  const insName = db.prepare('INSERT INTO name (id, kanji, reading, types, gloss, rank) VALUES (?, ?, ?, ?, ?, ?)');
  const insForm = db.prepare('INSERT OR IGNORE INTO name_form (form, name_id) VALUES (?, ?)');
  let n = 0;
  let seen = 0;
  db.exec('BEGIN');
  for (const w of words) {
    if (++seen % 100000 === 0) log(`  names ${seen}/${words.length}`);
    const types = [...new Set(w.translation.flatMap((t) => t.type))].filter((t) => NAME_TYPES.has(t));
    if (!types.length) continue;
    // Kanji spellings, or katakana for kana-only names (サナエ). Hiragana-only
    // names (ことね) are left out: they collide with ordinary words and particles.
    const forms = w.kanji.length ? w.kanji.map((k) => k.text) : w.kana.map((k) => k.text).filter((t) => KATAKANA.test(t));
    if (!forms.length) continue;
    const id = Number(w.id);
    const reading = w.kana[0].text;
    const gloss = [...new Set(w.translation.flatMap((t) => t.translation.map((x) => x.text)))];
    insName.run(id, w.kanji[0]?.text ?? '', reading, types.join(','), JSON.stringify(gloss), rankOf(forms[0], reading));
    for (const f of forms) insForm.run(f, id);
    n++;
  }
  db.exec('COMMIT');
  return n;
}

try {
  const [jmdictPath, jmnedictPath] = process.argv.slice(2);
  let src = await load('jmdict', jmdictPath);
  log(`jmdict ${src.version} (${src.dictDate}): ${src.words.length} entries`);
  const nWords = buildWords(src.words);
  src = await load('jmnedict', jmnedictPath);
  log(`jmnedict ${src.version} (${src.dictDate}): ${src.words.length} entries`);
  const nNames = buildNames(src.words);
  src = null;

  log('indexing...');
  db.exec('CREATE INDEX idx_dict_form ON dict_form(form)');
  log('analyze + vacuum...');
  db.exec('ANALYZE');
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('VACUUM');
  const { c: nForms } = db.prepare('SELECT count(*) AS c FROM dict_form').get();
  const { c: nNameForms } = db.prepare('SELECT count(*) AS c FROM name_form').get();
  db.close();

  for (const ext of ['-wal', '-shm', '-journal']) fs.rmSync(target + ext, { force: true });
  fs.renameSync(out, target);
  log(`done: ${nWords} words (${nForms} forms), ${nNames} names (${nNameForms} forms)`);
  log(`wrote ${target} (${(fs.statSync(target).size / 1e6).toFixed(1)}MB)`);
} catch (e) {
  try { db.close(); } catch {}
  fs.rmSync(out, { force: true });
  throw e;
}
