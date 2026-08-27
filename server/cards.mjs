import path from 'node:path';
import crypto from 'node:crypto';
import { lookup, homophones, sharedKanji, glossText } from './dict.mjs';
import { collocations, continuations } from './corpus.mjs';
import { clipAudio, clipVideo, screenshot } from './media.mjs';
import { enrich, llmAvailable } from './llm.mjs';
import { CARD_TYPES } from './anki.mjs';

export { CARD_TYPES };

/** What each card type needs before it can be built. */
export const REQUIREMENTS = {
  ContextCloze:    { audio: true,  image: true,  llm: [] },
  Contrast:        { audio: false, image: false, llm: ['contrast'] },
  ReadingContrast: { audio: false, image: false, llm: [] },
  Audio:           { audio: true,  image: false, llm: [] },
  Production:      { audio: true,  image: false, llm: [] },
  Situation:       { audio: false, image: false, llm: ['situation'] },
  Collocation:     { audio: false, image: false, llm: [] },
  Image:           { audio: false, image: true,  llm: [] },
  MinimalPair:     { audio: false, image: false, llm: [] },
  Naturalness:     { audio: false, image: false, llm: ['naturalness'] },
  Prediction:      { audio: false, image: false, llm: [] },
  ReverseContext:  { audio: true,  image: false, llm: [] },
};

/** Card types whose back shows an English translation of the mined line. */
const NEEDS_TRANSLATION = new Set(['ContextCloze', 'Production', 'ReverseContext']);

const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const list = (items) => items.map(esc).join('<br>');

const highlight = (sentence, word) =>
  word && sentence.includes(word)
    ? nl(sentence).replace(esc(word), `<b class="target">${esc(word)}</b>`)
    : nl(sentence);

const blank = (sentence, word) =>
  word && sentence.includes(word) ? nl(sentence.replaceAll(word, '＿＿＿')) : nl(sentence);

/**
 * Build the requested cards for one mined word.
 *
 * @param {object}   req
 * @param {string[]} req.types        card type names
 * @param {string}   req.mediaPath    absolute path of the source file
 * @param {string}   req.mediaTitle   human label used in the Source field
 * @param {{start:number,end:number,text:string}} req.cue
 * @param {string}   req.word         surface form the user hovered
 * @param {number}  [req.entryId]     chosen dictionary entry, defaults to best match
 * @param {string}  [req.translation] from a reference subtitle track, if loaded
 * @param {boolean} [req.includeVideo]
 * @returns {Promise<{cards: object[], skipped: object[], files: string[]}>}
 */
export async function buildCards(req) {
  const {
    types, mediaPath, mediaTitle, cue, word,
    entryId, includeVideo = false,
  } = req;

  const unknown = types.filter((t) => !CARD_TYPES.includes(t));
  if (unknown.length) throw new Error(`unknown card type(s): ${unknown.join(', ')}`);
  let active = [...types];

  const entries = lookup(word);
  const entry =
    (entryId != null && entries.find((e) => e.id === Number(entryId))) || entries[0] || null;
  if (!entry) throw new Error(`no dictionary entry for "${word}"`);

  const sentence = cue.text.replace(/\n/g, ' ');
  const meaning = glossText(entry);
  const source = `${esc(mediaTitle)} · ${fmtTime(cue.start)}`;
  const skipped = [];

  // ------------------------------------------------ gather shared inputs once

  const wants = (k) => types.some((t) => REQUIREMENTS[t][k]);
  const stamp = crypto.randomUUID().slice(0, 8);
  const files = [];

  const [audioFile, imageFile, videoFile] = await Promise.all([
    wants('audio') ? clipAudio(mediaPath, cue.start, cue.end) : null,
    wants('image') ? screenshot(mediaPath, cue.start, cue.end) : null,
    includeVideo && wants('image') ? clipVideo(mediaPath, cue.start, cue.end) : null,
  ]);
  for (const f of [audioFile, imageFile, videoFile]) if (f) files.push(f);

  const asset = (file, kind, field) =>
    file ? [{ kind, path: file, filename: `kotoba_${stamp}${path.extname(file)}`, field }] : [];

  // ------------------------------------------------------- one LLM round trip

  let need = [...new Set(active.flatMap((t) => REQUIREMENTS[t].llm))];
  let translation = req.translation?.trim() ?? '';
  if (!translation && active.some((t) => NEEDS_TRANSLATION.has(t))) need.push('translation');

  let ai = {};
  if (need.length) {
    if (!llmAvailable()) {
      // Only the generative types are blocked. A missing translation just
      // leaves that field empty; it does not cancel the card.
      const blocked = active.filter((t) => REQUIREMENTS[t].llm.length);
      for (const t of blocked) skipped.push({ type: t, reason: 'ANTHROPIC_API_KEY not set' });
      active = active.filter((t) => !blocked.includes(t));
      need = [];
    } else {
      ai = await enrich({
        sentence, word: entry.headword, reading: entry.reading, gloss: meaning, need,
      });
      translation ||= ai.translation ?? '';
    }
  }

  // ------------------------------------------------------------- the builders

  const builders = {
    ContextCloze: () => ({
      fields: {
        Sentence: highlight(sentence, word),
        Word: esc(entry.headword),
        Reading: esc(entry.reading),
        Meaning: esc(meaning),
        Translation: esc(translation),
        Audio: '', Video: '', Screenshot: '', Source: source,
      },
      media: [
        ...asset(audioFile, 'audio', 'Audio'),
        ...asset(imageFile, 'picture', 'Screenshot'),
        ...asset(videoFile, 'video', 'Video'),
      ],
    }),

    Contrast: () =>
      ai.contrast && {
        fields: {
          Question: nl(ai.contrast.question),
          OptionA: esc(ai.contrast.optionA),
          OptionB: esc(ai.contrast.optionB),
          Answer: esc(ai.contrast.answer),
          Explanation: esc(ai.contrast.explanation),
          Source: source,
        },
        media: [],
      },

    ReadingContrast: () => {
      const others = sharedKanji(entry.kanji || entry.headword, entry.id, entry.reading, 3);
      if (!others.length) return null;
      const set = [
        { spelling: entry.kanji || entry.headword, reading: entry.reading },
        ...others,
      ];
      return {
        fields: {
          Words: list(set.map((e) => e.spelling)),
          Readings: list(set.map((e) => `${e.spelling}（${e.reading}）`)),
          Source: source,
        },
        media: [],
      };
    },

    Audio: () => ({
      fields: {
        Audio: '',
        Word: esc(entry.headword),
        Reading: esc(entry.reading),
        Meaning: esc(meaning),
        Sentence: highlight(sentence, word),
        Source: source,
      },
      media: asset(audioFile, 'audio', 'Audio'),
    }),

    Production: () =>
      translation && {
        fields: {
          Translation: esc(translation),
          Sentence: highlight(sentence, word),
          Reading: esc(entry.reading),
          Audio: '',
          Source: source,
        },
        media: asset(audioFile, 'audio', 'Audio'),
      },

    Situation: () =>
      ai.situation && {
        fields: {
          Situation: nl(ai.situation.situation),
          Sentence: esc(ai.situation.sentence),
          Reading: esc(ai.situation.reading),
          Meaning: esc(meaning),
          Source: source,
        },
        media: [],
      },

    Collocation: () => {
      const cols = collocations(entry.kanji || entry.headword, 8);
      if (cols.length < 2) return null;
      return {
        fields: {
          Word: esc(entry.headword),
          Meaning: esc(meaning),
          Collocations: cols
            .map((c) => `${esc(c.phrase)}<span class="note">　${esc(c.note)}</span>`)
            .join('<br>'),
          Source: source,
        },
        media: [],
      };
    },

    Image: () =>
      imageFile && {
        fields: {
          Screenshot: '', Video: '',
          Sentence: highlight(sentence, word),
          Word: esc(entry.headword),
          Source: source,
        },
        media: [
          ...asset(imageFile, 'picture', 'Screenshot'),
          ...asset(videoFile, 'video', 'Video'),
        ],
      },

    MinimalPair: () => {
      if (!entry.kanji) return null;
      const others = homophones(entry.reading, entry.kanji, 2);
      if (!others.length) return null;
      const set = [
        { spelling: entry.kanji, reading: entry.reading, gloss: glossText(entry, 1) },
        ...others,
      ];
      return {
        fields: {
          Words: list(set.map((e) => e.spelling)),
          Readings: list(set.map((e) => e.reading)),
          Meanings: set.map((e) => `${esc(e.spelling)} — ${esc(e.gloss)}`).join('<br>'),
          Source: source,
        },
        media: [],
      };
    },

    Naturalness: () =>
      ai.naturalness && {
        fields: {
          Candidate: esc(ai.naturalness.candidate),
          Verdict: esc(ai.naturalness.verdict),
          Better: esc(ai.naturalness.better),
          Explanation: esc(ai.naturalness.explanation),
          Source: source,
        },
        media: [],
      },

    Prediction: () => {
      const next = continuations(entry.kanji || entry.headword, 5);
      if (next.length < 2) return null;
      return {
        fields: {
          Prompt: `${esc(entry.kanji || entry.headword)}＿＿＿`,
          Continuations: next
            .map((c) => `${esc(c.text)}<span class="note">　${c.count}×</span>`)
            .join('<br>'),
          Source: source,
        },
        media: [],
      };
    },

    ReverseContext: () => ({
      fields: {
        Cloze: blank(sentence, word),
        Word: esc(entry.headword),
        Reading: esc(entry.reading),
        Meaning: esc(meaning),
        Translation: esc(translation),
        Audio: '',
        Source: source,
      },
      media: asset(audioFile, 'audio', 'Audio'),
    }),
  };

  const REASONS = {
    ReadingContrast: 'no words share a kanji with a different reading',
    Collocation: 'not enough phrases yet - watch more with this word in it',
    MinimalPair: 'no homophone with a different spelling',
    Prediction: 'seen too few times in your corpus - watch more first',
    Production: 'needs an English translation (load a reference sub track or set ANTHROPIC_API_KEY)',
    Image: 'no video frame available (audio-only source?)',
  };

  const cards = [];
  for (const type of active) {
    const built = builders[type]();
    if (!built) {
      skipped.push({ type, reason: REASONS[type] ?? 'could not be generated' });
      continue;
    }
    cards.push({ type, ...built });
  }
  return { cards, skipped, files };
}

function fmtTime(s) {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}
