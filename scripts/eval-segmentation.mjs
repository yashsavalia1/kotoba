// Segmentation quality report over a folder of Japanese subtitle files.
//   node --no-warnings scripts/eval-segmentation.mjs [dir] [--sample N] [--dump out.txt] [--json]
// Default dir is the Takagi-san S01 corpus. Use KOTOBA_DICT_DB to evaluate another build.
// --dump writes every cue's segmentation (one line per cue) so two runs can be diffed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configurePaths, ROOT } from '../src/core/paths.mjs';
import { parseSubtitles } from '../src/core/subs.mjs';

configurePaths({
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-eval-')),
  dictDbPath: process.env.KOTOBA_DICT_DB || path.join(ROOT, 'data', 'dict.db'),
});
const { tokenize } = await import('../src/core/dict.mjs');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sample: { type: 'string', default: '40' },
    dump: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const dir = positionals[0] || path.join(os.homedir(), 'Media', 'Karakai Jouzu no Takagi-san S01');
const files = fs.readdirSync(dir).filter((f) => /\.(srt|vtt|ass|ssa)$/i.test(f)).sort();
if (!files.length) throw new Error(`no subtitle files in ${dir}`);

const JP = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ々〆ヶゝゞ]/;
const KANJI1 = /^[㐀-䶿一-鿿々]$/;
const PARTICLES = new Set(['は', 'が', 'を', 'に', 'で', 'と', 'も', 'の', 'へ', 'や', 'か', 'ね', 'よ', 'な', 'さ', 'ぞ', 'わ']);

const m = { cues: 0, jpChars: 0, covered: 0, tokens: 0, resolved: 0, kanji1: 0, names: 0, badParticle: 0 };
const unknown = new Map();
const kanji1 = new Map();
const perEpisode = [];
const dump = [];
const all = [];

tokenize('ウォームアップ'); // first call pays for opening the database and preparing statements

for (const f of files) {
  const cues = parseSubtitles(fs.readFileSync(path.join(dir, f), 'utf8'), path.extname(f));
  const t0 = performance.now();
  const segs = cues.map((c) => tokenize(c.text));
  perEpisode.push({ file: f, cues: cues.length, ms: performance.now() - t0 });

  cues.forEach((c, i) => {
    const toks = segs[i];
    m.cues++;
    let run = '';
    const endRun = () => {
      if (run) unknown.set(run, (unknown.get(run) || 0) + 1);
      run = '';
    };
    for (const t of toks) {
      const jp = [...t.text].filter((ch) => JP.test(ch)).length;
      m.jpChars += jp;
      if (!t.entries.length) {
        for (const ch of t.text) (JP.test(ch) ? (run += ch) : endRun());
        continue;
      }
      endRun();
      m.tokens++;
      m.resolved++;
      m.covered += jp;
      if (KANJI1.test(t.text)) {
        m.kanji1++;
        kanji1.set(t.text, (kanji1.get(t.text) || 0) + 1);
      }
      if (t.entries[0].name) m.names++;
      if (PARTICLES.has(t.text) && !t.entries[0].pos.includes('prt')) m.badParticle++;
    }
    endRun();
    const line = toks.map((t) => (t.entries.length ? t.text : `[${t.text}]`)).join('|').replace(/\n/g, '⏎');
    dump.push(`${f.match(/S\d+E\d+/)?.[0] ?? f}#${i}\t${line}`);
    all.push(line);
  });
}

const totalMs = perEpisode.reduce((s, e) => s + e.ms, 0);
const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
const report = {
  db: process.env.KOTOBA_DICT_DB || 'data/dict.db',
  files: files.length,
  cues: m.cues,
  coverage: +((100 * m.covered) / m.jpChars).toFixed(2),
  tokens: m.resolved,
  singleKanjiTokens: m.kanji1,
  singleKanjiRate: +((100 * m.kanji1) / m.resolved).toFixed(2),
  nameTokens: m.names,
  particlesNotPrt: m.badParticle,
  unknownRuns: [...unknown.values()].reduce((s, n) => s + n, 0),
  msPerEpisode: +(totalMs / files.length).toFixed(1),
  msPerCue: +(totalMs / m.cues).toFixed(3),
};

if (values.dump) fs.writeFileSync(values.dump, dump.join('\n') + '\n');
if (values.json) {
  console.log(JSON.stringify(report));
} else {
  console.log(report);
  console.log('\ntop unknown runs:', top(unknown, 25).map(([k, n]) => `${k}×${n}`).join('  '));
  console.log('top single-kanji tokens:', top(kanji1, 25).map(([k, n]) => `${k}×${n}`).join('  '));
  const n = Number(values.sample);
  const step = Math.max(1, Math.floor(all.length / n));
  console.log(`\nsample (every ${step}th cue, [x] = unresolved):`);
  for (let i = 0; i < all.length && i / step < n; i += step) console.log('  ' + all[i]);
}
