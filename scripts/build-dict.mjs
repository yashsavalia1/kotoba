// Downloads the latest jmdict-simplified English release and flattens it into
// the local SQLite dictionary. Run once: `npm run dict`.
//
// ponytail: whole-file JSON.parse (~200MB) instead of a streaming parser. Needs
// the --max-old-space-size in the npm script. Swap in a streaming parser only if
// a machine actually OOMs here; this runs once.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dictDb } from '../src/core/db.mjs';

const db = dictDb();

const RELEASE_API = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';

async function fetchSource() {
  const local = process.argv[2];
  if (local) {
    console.log(`[dict] using local file ${local}`);
    return fs.readFileSync(local, 'utf8');
  }

  console.log('[dict] resolving latest jmdict-simplified release...');
  const release = await fetch(RELEASE_API, {
    headers: { accept: 'application/vnd.github+json' },
  }).then((r) => r.json());

  const asset = release.assets.find((a) => /^jmdict-eng-[\d.+]+\.json\.tgz$/.test(a.name));
  if (!asset) throw new Error('no jmdict-eng .json.tgz asset in latest release');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-dict-'));
  const tgz = path.join(tmp, asset.name);
  console.log(`[dict] downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)}MB)...`);
  const buf = Buffer.from(await fetch(asset.browser_download_url).then((r) => r.arrayBuffer()));
  fs.writeFileSync(tgz, buf);

  execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
  const json = fs.readdirSync(tmp).find((f) => f.endsWith('.json'));
  const text = fs.readFileSync(path.join(tmp, json), 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  return text;
}

const text = await fetchSource();
console.log('[dict] parsing...');
const { words } = JSON.parse(text);
console.log(`[dict] ${words.length} entries`);

db.exec('DELETE FROM dict; DELETE FROM dict_form;');
const insEntry = db.prepare(
  'INSERT INTO dict (id, kanji, reading, forms, pos, gloss, common) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const insForm = db.prepare('INSERT INTO dict_form (form, dict_id) VALUES (?, ?)');

db.exec('BEGIN');
let n = 0;
for (const w of words) {
  const id = Number(w.id);
  if (!Number.isFinite(id)) continue;

  const kanji = w.kanji.filter((k) => !k.tags.includes('sK'));
  const kana = w.kana.filter((k) => !k.tags.includes('sk'));
  const common = kanji.some((k) => k.common) || kana.some((k) => k.common) ? 1 : 0;

  const pos = [...new Set(w.sense.flatMap((s) => s.partOfSpeech))];
  const gloss = w.sense.map((s) => ({
    pos: s.partOfSpeech,
    misc: s.misc,
    text: s.gloss.map((g) => g.text),
  }));

  insEntry.run(
    id,
    kanji[0]?.text ?? '',
    kana[0]?.text ?? '',
    JSON.stringify(kanji.map((k) => ({ t: k.text, c: k.common ? 1 : 0 }))),
    JSON.stringify(pos),
    JSON.stringify(gloss),
    common
  );

  for (const form of new Set([...kanji.map((k) => k.text), ...kana.map((k) => k.text)])) {
    insForm.run(form, id);
  }
  if (++n % 50000 === 0) console.log(`[dict]   ${n}...`);
}
db.exec('COMMIT');

db.exec('ANALYZE');
const { c } = db.prepare('SELECT count(*) AS c FROM dict_form').get();
console.log(`[dict] done: ${n} entries, ${c} surface forms`);
