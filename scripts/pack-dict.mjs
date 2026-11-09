// Snapshot data/dict.db into build/dict.db for the packaged app, which opens it read-only.
//   node scripts/pack-dict.mjs [src] [dest]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.argv[2] ?? path.join(ROOT, 'data', 'dict.db'));
const dest = path.resolve(process.argv[3] ?? path.join(ROOT, 'build', 'dict.db'));
const tmp = `${dest}.tmp`;

if (!fs.existsSync(src)) throw new Error(`${src} not found; run npm run dict first`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(tmp, { force: true });

// VACUUM INTO takes a consistent, compacted snapshot (WAL included) without writing to the source.
const from = new DatabaseSync(src, { readOnly: true });
from.prepare('VACUUM INTO ?').run(tmp);
from.close();

const db = new DatabaseSync(tmp);
db.exec('PRAGMA journal_mode = DELETE; VACUUM; ANALYZE;');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
const counts = Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]));
if (!counts.dict) throw new Error('dict table is empty');
db.close();
fs.renameSync(tmp, dest);

console.log(`${path.relative(ROOT, dest)}  ${(fs.statSync(dest).size / 2 ** 20).toFixed(1)} MB`, counts);
