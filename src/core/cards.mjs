import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lookup, homophones, sharedKanji, glossText } from './dict.mjs';
import { collocations, continuations } from './corpus.mjs';
import { clipAudio, clipVideo, screenshot } from './media.mjs';
import { enrich, llmAvailable } from './llm.mjs';
import { CARD_TYPES } from './anki.mjs';
import { getSetting } from './settings.mjs';

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

/** Split the sentence around the mined word: [before, word, after], or null if it isn't there. */
const locate = (sentence, word, at) => {
  if (!word) return null;
  const i = at != null && sentence.startsWith(word, at) ? at : sentence.indexOf(word);
  return i < 0 ? null : [sentence.slice(0, i), word, sentence.slice(i + word.length)];
};

const highlight = (parts, sentence) =>
  parts ? `${nl(parts[0])}<b class="target">${esc(parts[1])}</b>${nl(parts[2])}` : nl(sentence);

const blank = (parts, sentence) => (parts ? `${nl(parts[0])}＿＿＿${nl(parts[2])}` : nl(sentence));

const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

/**
 * One line of text from a multi-line cue. Japanese wraps without a space, so a break
 * between two CJK characters is dropped; elsewhere it becomes a space. `offset` (an index
 * into the original text) is mapped to the joined string.
 */
export function joinCue(text, offset) {
  let out = '';
  let mapped = offset;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') {
      out += text[i];
      continue;
    }
    const drop = CJK.test(out.at(-1) ?? '') && CJK.test(text[i + 1] ?? '');
    if (!drop) out += ' ';
    else if (offset != null && i < offset) mapped--;
  }
  return { sentence: out, offset: mapped };
}

const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').at(-1);

/**
 * Build the requested cards for one mined word.
 *
 * @param {object}   req
 * @param {string[]} req.types        card type names
 * @param {string}   req.mediaPath    absolute path of the source file
 * @param {string}   req.mediaTitle   human label used in the Source field
 * @param {{start:number,end:number,text:string}} req.cue
 * @param {string}   req.word         surface form the user hovered
 * @param {number}  [req.tokenStart]  offset of the hovered token in cue.text (picks the right
 *                                    occurrence when the word appears more than once)
 * @param {number}  [req.entryId]     chosen dictionary entry, defaults to best match
 * @param {string}  [req.translation] from a reference subtitle track, if loaded
 * @param {number}  [req.audioStream] ffprobe stream index of the audio track to clip
 * @param {boolean} [req.includeVideo]
 * @returns {Promise<{cards: object[], skipped: object[], files: string[]}>}
 */
export async function buildCards(req) {
  const files = [];
  try {
    return await build(req, files);
  } catch (e) {
    for (const f of files) fs.rmSync(f, { force: true });
    throw e;
  }
}

async function build(req, files) {
  const {
    types, mediaPath, mediaTitle, cue, word,
    entryId, includeVideo = false, tokenStart,
  } = req;
  const audioStream = req.audioStream == null || req.audioStream === '' ? null : Number(req.audioStream);

  if (!Array.isArray(types) || !types.length) throw new Error('Pick at least one card type');
  const unknown = types.filter((t) => !CARD_TYPES.includes(t));
  if (unknown.length) throw new Error(`unknown card type(s): ${unknown.join(', ')}`);
  let active = [...types];

  const entries = lookup(word);
  const entry =
    (entryId != null && entries.find((e) => e.id === Number(entryId))) || entries[0] || null;
  if (!entry) throw new Error(`no dictionary entry for "${word}"`);

  const joined = joinCue(String(cue.text ?? ''), tokenStart == null ? null : Number(tokenStart));
  const sentence = joined.sentence;
  // The hovered surface first; then the dictionary spellings, for a word that was looked up
  // rather than hovered (or whose surface differs from the line, e.g. kana vs kanji).
  const parts = [word, entry.kanji, entry.headword, entry.reading]
    .filter(Boolean)
    .reduce((hit, w, i) => hit ?? locate(sentence, w, i === 0 ? joined.offset : null), null);
  const meaning = glossText(entry);
  const source = `${esc(mediaTitle)} · ${fmtTime(cue.start)}`;
  const skipped = [];

  // ------------------------------------------------ gather shared inputs once

  const wants = (k) => active.some((t) => REQUIREMENTS[t][k]);
  const clip = (fn, kind) =>
    fn().then(
      (file) => (file && files.push(file), file),
      (e) => {
        throw Object.assign(new Error(`Could not extract the ${kind} with ffmpeg: ${firstLine(e)}`), { cause: e });
      }
    );

  const [audio, image, video] = await Promise.allSettled([
    wants('audio') ? clip(() => clipAudio(mediaPath, cue.start, cue.end, audioStream), 'audio clip') : null,
    wants('image') ? clip(() => screenshot(mediaPath, cue.start, cue.end), 'screenshot') : null,
    includeVideo && wants('image') ? clip(() => clipVideo(mediaPath, cue.start, cue.end, audioStream), 'video clip') : null,
  ]);
  // No audio is fatal (most types are built around it); a missing frame only costs the picture.
  if (audio.status === 'rejected') throw audio.reason;
  const audioFile = audio.value;
  const imageFile = image.status === 'fulfilled' ? image.value : null;
  const videoFile = video.status === 'fulfilled' ? video.value : null;
  const imageError = image.status === 'rejected' ? image.reason.message : null;

  // Content-addressed: re-mining the same line reuses the same file in Anki's media folder.
  const padding = Number(getSetting('clipPadding')) || 0;
  const mediaName = (file, kind) =>
    `kotoba_${crypto
      .createHash('sha256')
      .update(JSON.stringify([mediaPath, cue.start, cue.end, kind, audioStream, padding]))
      .digest('hex')
      .slice(0, 16)}${path.extname(file)}`;
  const asset = (file, kind, field) =>
    file ? [{ kind, path: file, filename: mediaName(file, kind), field }] : [];

  // ------------------------------------------------------- one LLM round trip

  const need = [...new Set(active.flatMap((t) => REQUIREMENTS[t].llm))];
  let translation = String(req.translation ?? '').trim();
  if (!translation && active.some((t) => NEEDS_TRANSLATION.has(t))) need.push('translation');

  let ai = {};
  const blockLlm = (reason) => {
    // Only the generative types are blocked. A missing translation just
    // leaves that field empty; it does not cancel the card.
    const blocked = active.filter((t) => REQUIREMENTS[t].llm.length);
    for (const t of blocked) skipped.push({ type: t, reason });
    active = active.filter((t) => !blocked.includes(t));
  };
  if (need.length) {
    if (!llmAvailable()) {
      blockLlm('ANTHROPIC_API_KEY not set');
    } else {
      try {
        ai = await enrich({
          sentence, word: entry.headword, reading: entry.reading, gloss: meaning, need,
        });
      } catch (e) {
        blockLlm(e.message);
      }
      translation ||= ai.translation ?? '';
    }
  }

  // ------------------------------------------------------------- the builders

  const builders = {
    ContextCloze: () => ({
      fields: {
        Sentence: highlight(parts, sentence),
        Word: esc(entry.headword),
        Reading: esc(entry.reading),
        Meaning: esc(meaning),
        Translation: nl(translation),
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
        Sentence: highlight(parts, sentence),
        Source: source,
      },
      media: asset(audioFile, 'audio', 'Audio'),
    }),

    Production: () =>
      translation && {
        fields: {
          Translation: nl(translation),
          Sentence: highlight(parts, sentence),
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
          Sentence: highlight(parts, sentence),
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

    ReverseContext: () => parts && ({
      fields: {
        Cloze: blank(parts, sentence),
        Word: esc(entry.headword),
        Reading: esc(entry.reading),
        Meaning: esc(meaning),
        Translation: nl(translation),
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
    Image: imageError ?? 'no video frame available (audio-only source?)',
    ReverseContext: `"${word}" does not appear in this line, so there is nothing to blank`,
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
