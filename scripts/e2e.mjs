// End-to-end smoke run against a live server. Assumes `node server/index.mjs`
// is up and kotoba.config.json points at a folder with at least one media file
// plus a matching subtitle file.
//
//   node --no-warnings test/e2e.mjs [baseUrl]

const BASE = process.argv[2] ?? 'http://localhost:5174';

const j = async (p, init) => {
  const r = await fetch(BASE + p, init);
  const b = await r.json();
  if (b.error) throw new Error(`${p}: ${b.error}`);
  return b;
};
const post = (p, data) =>
  j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

const ok = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

const status = await j('/api/status');
ok('dictionary loaded', status.dictReady);
ok('ffmpeg present', status.ffmpeg);
console.log(`       anki: ${status.anki ?? 'offline'} · claude: ${status.llm ? 'on' : 'off'}`);

const library = await j('/api/library');
ok('library non-empty', library.length > 0, `${library.length} file(s)`);
if (!library.length) process.exit(1);
const item = library[0];

const info = await j(`/api/media/${item.id}`);
ok('subtitle track found', info.tracks.length > 0, info.tracks.map((t) => t.label).join(', '));

let prep = await post(`/api/media/${item.id}/prepare`, {});
const started = Date.now();
while (prep.status === 'working' && Date.now() - started < 120_000) {
  await new Promise((r) => setTimeout(r, 500));
  prep = await post(`/api/media/${item.id}/prepare`, {});
}
ok('playable stream ready', prep.status === 'ready', `${prep.direct ? 'direct' : 'converted'} → ${prep.url}`);

const head = await fetch(BASE + prep.url, { headers: { Range: 'bytes=0-1023' } });
ok('range request served', head.status === 206, `HTTP ${head.status}, ${head.headers.get('content-range')}`);
head.body?.cancel();

const subs = await j(`/api/media/${item.id}/subs?track=0`);
ok('cues parsed', subs.cues.length > 0, `${subs.cues.length} cues`);
ok('cues tokenized', subs.tokens?.length === subs.cues.length);
const known = subs.tokens.flat().filter((t) => t.entries.length);
ok('tokens resolve to entries', known.length > 0, `${known.length} hoverable words`);
console.log(`       line 1: ${subs.tokens[0].map((t) => (t.entries.length ? `[${t.text}]` : t.text)).join('')}`);

// Preview every card type that does not need an API key.
const offline = [
  'ContextCloze', 'ReadingContrast', 'Audio', 'Production', 'Collocation',
  'Image', 'MinimalPair', 'Prediction', 'ReverseContext',
];
const target = subs.tokens.flat().find((t) => t.lemma === '正直') ?? known[0];
const cueIndex = subs.tokens.findIndex((toks) => toks.includes(target));

const preview = await post('/api/cards/preview', {
  mediaId: item.id,
  cue: subs.cues[cueIndex >= 0 ? cueIndex : 0],
  cueIndex,
  word: target.text,
  types: offline,
  translation: 'Honestly, I do not want to go today.',
  includeVideo: true,
});

console.log(`\n  target word: ${target.text} → ${target.lemma}（${target.reading}）`);
for (const c of preview.cards) {
  console.log(`\n  ── ${c.type}${c.media.length ? `  [${c.media.join(', ')}]` : ''}`);
  for (const [k, v] of Object.entries(c.fields)) {
    if (v) console.log(`     ${k.padEnd(14)} ${String(v).replace(/<[^>]+>/g, '').replace(/\n/g, ' ').slice(0, 96)}`);
  }
}
for (const s of preview.skipped) console.log(`  ── ${s.type}: SKIPPED — ${s.reason}`);

ok('\n  at least 6 card types built offline', preview.cards.length >= 6, `${preview.cards.length}/${offline.length}`);
ok('  media attached', preview.cards.some((c) => c.media.includes('audio')) && preview.cards.some((c) => c.media.includes('picture')));
