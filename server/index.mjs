import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.mjs';
import { db, dictReady } from './db.mjs';
import { tokenize, lookup, glossText } from './dict.mjs';
import { parseSubtitles } from './subs.mjs';
import { recordCues, corpusSize } from './corpus.mjs';
import * as media from './media.mjs';
import { buildCards, CARD_TYPES, REQUIREMENTS } from './cards.mjs';
import { addNote, ankiVersion, ensureSchema } from './anki.mjs';
import { llmAvailable } from './llm.mjs';

const app = express();
app.use(express.json({ limit: '4mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[kotoba] ${req.method} ${req.path}:`, e.message);
    res.status(e.status ?? 500).json({ error: e.message });
  });

// ------------------------------------------------------------------- status

app.get('/api/status', wrap(async (_req, res) => {
  let anki = null;
  try {
    anki = await ankiVersion();
  } catch { /* Anki not running - the UI shows this, mining stays disabled */ }
  res.json({
    dictReady: dictReady(),
    corpusLines: corpusSize(),
    ffmpeg: media.ffmpegAvailable(),
    llm: llmAvailable(),
    anki,
    deckName: config.deckName,
    mediaDirs: config.mediaDirs,
    cardTypes: CARD_TYPES.map((t) => ({ type: t, ...REQUIREMENTS[t] })),
  });
}));

app.post('/api/anki/setup', wrap(async (_req, res) => {
  await ensureSchema();
  res.json({ ok: true, deck: config.deckName });
}));

// ------------------------------------------------------------------ library

app.get('/api/library', wrap((_req, res) => res.json(media.scanLibrary())));

app.get('/api/media/:id', wrap(async (req, res) => {
  const abs = media.pathFor(req.params.id);
  res.json({
    id: req.params.id,
    title: path.basename(abs, path.extname(abs)),
    isVideo: media.VIDEO_EXTS.includes(path.extname(abs).toLowerCase()),
    tracks: await media.subtitleTracks(abs),
  });
}));

app.post('/api/media/:id/prepare', wrap(async (req, res) => {
  const abs = media.pathFor(req.params.id);
  const state = await media.prepare(abs);
  res.json({
    ...state,
    url: state.status === 'ready'
      ? state.direct
        ? `/api/stream/${req.params.id}`
        : `/api/converted/${state.key}`
      : null,
  });
}));

app.get('/api/stream/:id', wrap((req, res) => res.sendFile(media.pathFor(req.params.id))));

app.get('/api/converted/:key', wrap((req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.key)) return res.status(400).end();
  const file = media.convertedPath(req.params.key);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not converted' });
  res.sendFile(file);
}));

// ---------------------------------------------------------------- subtitles

app.get('/api/media/:id/subs', wrap(async (req, res) => {
  const abs = media.pathFor(req.params.id);
  const tracks = await media.subtitleTracks(abs);
  const track = tracks[Number(req.query.track ?? 0)];
  if (!track) return res.status(404).json({ error: 'no such subtitle track' });

  const body = track.kind === 'external'
    ? media.decodeSubFile(track.file)
    : await media.extractEmbeddedSub(abs, track.index);
  const ext = track.kind === 'external' ? path.extname(track.file) : '.srt';
  const cues = parseSubtitles(body, ext);

  // Hover has to be instant, so every cue is segmented up front rather than on
  // mouseover. A 400-line episode segments in well under a second.
  const tokens = req.query.tokenize === '0' ? null : cues.map((c) => tokenize(c.text));

  if (req.query.record !== '0' && cues.length) recordCues(req.params.id, cues);
  res.json({ track: track.label, cues, tokens });
}));

app.post('/api/tokenize', wrap((req, res) => res.json({ tokens: tokenize(String(req.body.text ?? '')) })));

app.post('/api/lookup', wrap((req, res) => {
  const entries = lookup(String(req.body.word ?? '')).slice(0, 12);
  res.json({ entries: entries.map((e) => ({ ...e, glossText: glossText(e) })) });
}));

// -------------------------------------------------------------------- cards

const qMined = db.prepare('SELECT type, at FROM mined WHERE word = ? ORDER BY at DESC');
const insMined = db.prepare('INSERT INTO mined (word, type, media, cue, at) VALUES (?, ?, ?, ?, ?)');

app.get('/api/mined/:word', wrap((req, res) =>
  res.json({ mined: qMined.all(req.params.word) })));

app.post('/api/cards', wrap(async (req, res) => {
  const { mediaId, cue, cueIndex = -1, word, entryId, types, translation, includeVideo } = req.body;
  if (!Array.isArray(types) || !types.length) {
    return res.status(400).json({ error: 'pick at least one card type' });
  }
  const abs = media.pathFor(mediaId);

  const { cards, skipped, files } = await buildCards({
    types,
    mediaPath: abs,
    mediaTitle: path.basename(abs, path.extname(abs)),
    cue,
    word,
    entryId,
    translation,
    includeVideo,
  });

  const added = [];
  const failed = [...skipped];
  for (const card of cards) {
    try {
      const id = await addNote(card.type, card.fields, card.media);
      insMined.run(word, card.type, mediaId, cueIndex, Date.now());
      added.push({ type: card.type, noteId: id });
    } catch (e) {
      failed.push({ type: card.type, reason: e.message });
    }
  }
  // AnkiConnect has copied whatever it needed into the collection by now.
  for (const f of files) fs.rmSync(f, { force: true });

  res.json({ added, skipped: failed });
}));

/** Preview the generated fields without touching Anki. */
app.post('/api/cards/preview', wrap(async (req, res) => {
  const abs = media.pathFor(req.body.mediaId);
  const { cards, skipped, files } = await buildCards({
    ...req.body,
    mediaPath: abs,
    mediaTitle: path.basename(abs, path.extname(abs)),
  });
  for (const f of files) fs.rmSync(f, { force: true });
  res.json({
    cards: cards.map((c) => ({ type: c.type, fields: c.fields, media: c.media.map((m) => m.kind) })),
    skipped,
  });
}));

// --------------------------------------------------------------------- web

const dist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(config.port, () => {
  console.log(`[kotoba] http://localhost:${config.port}`);
  if (!dictReady()) console.log('[kotoba] dictionary is empty - run `npm run dict`');
  if (!media.ffmpegAvailable()) console.log(`[kotoba] ffmpeg not found at "${config.ffmpeg}"`);
  if (!fs.existsSync(dist)) console.log('[kotoba] web/dist missing - run `npm run dev` or `npm run build`');
});
