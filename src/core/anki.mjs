import { getSettings } from './settings.mjs';

async function invoke(action, params = {}) {
  let res;
  try {
    res = await fetch(getSettings().ankiConnect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new Error(
      `Cannot reach AnkiConnect at ${getSettings().ankiConnect}. Open Anki and install the AnkiConnect add-on (code 2055492159).`,
      { cause }
    );
  }
  const body = await res.json();
  if (body.error) throw new Error(`AnkiConnect: ${body.error}`);
  return body.result;
}

export const ankiVersion = () => invoke('version');

const CSS = `
.card { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; font-size: 22px;
        text-align: center; color: #1c1c1e; background: #fbfbfd; line-height: 1.7; }
.jp   { font-size: 30px; line-height: 1.6; }
.target { color: #c2410c; font-weight: 600; }
.reading { font-size: 20px; color: #6b7280; }
.gloss   { font-size: 18px; color: #374151; }
.en      { font-size: 18px; color: #4b5563; font-style: italic; }
.note    { font-size: 15px; color: #6b7280; }
.list    { font-size: 24px; line-height: 2.1; }
.source  { font-size: 12px; color: #9ca3af; margin-top: 18px; }
.opt     { font-size: 24px; margin: 10px 0; }
img      { max-width: 92%; border-radius: 8px; }
hr#answer { border: none; border-top: 1px solid #e5e7eb; margin: 18px 0; }
`;

const src = '<div class="source">{{Source}}</div>';
const ans = '{{FrontSide}}<hr id=answer>';

/**
 * The twelve note types. Each is a distinct Anki model so scheduling, styling
 * and search all stay separate per card kind.
 */
export const MODELS = {
  ContextCloze: {
    fields: ['Sentence', 'Word', 'Reading', 'Meaning', 'Translation', 'Audio', 'Video', 'Screenshot', 'Source'],
    front: '<div class="jp">{{Sentence}}</div>{{Screenshot}}',
    back: `${ans}<div class="reading">{{Reading}}</div><div class="gloss">{{Meaning}}</div><div class="en">{{Translation}}</div>{{Audio}}{{Video}}${src}`,
  },
  Contrast: {
    fields: ['Question', 'OptionA', 'OptionB', 'Answer', 'Explanation', 'Source'],
    front: '<div class="jp">{{Question}}</div><div class="opt">A. {{OptionA}}</div><div class="opt">B. {{OptionB}}</div>',
    back: `${ans}<div class="jp target">{{Answer}}</div><div class="note">{{Explanation}}</div>${src}`,
  },
  ReadingContrast: {
    fields: ['Words', 'Readings', 'Source'],
    front: '<div class="note">Read these</div><div class="list">{{Words}}</div>',
    back: `${ans}<div class="list">{{Readings}}</div>${src}`,
  },
  Audio: {
    fields: ['Audio', 'Word', 'Reading', 'Meaning', 'Sentence', 'Source'],
    front: '{{Audio}}',
    back: `${ans}<div class="jp target">{{Word}}</div><div class="reading">{{Reading}}</div><div class="gloss">{{Meaning}}</div><div class="jp">{{Sentence}}</div>${src}`,
  },
  Production: {
    fields: ['Translation', 'Sentence', 'Reading', 'Audio', 'Source'],
    front: '<div class="en">{{Translation}}</div>',
    back: `${ans}<div class="jp">{{Sentence}}</div><div class="reading">{{Reading}}</div>{{Audio}}${src}`,
  },
  Situation: {
    fields: ['Situation', 'Sentence', 'Reading', 'Meaning', 'Source'],
    front: '<div class="en">{{Situation}}</div>',
    back: `${ans}<div class="jp target">{{Sentence}}</div><div class="reading">{{Reading}}</div><div class="gloss">{{Meaning}}</div>${src}`,
  },
  Collocation: {
    fields: ['Word', 'Meaning', 'Collocations', 'Source'],
    front: '<div class="jp target">{{Word}}</div><div class="gloss">{{Meaning}}</div>',
    back: `${ans}<div class="list">{{Collocations}}</div>${src}`,
  },
  Image: {
    fields: ['Screenshot', 'Video', 'Sentence', 'Word', 'Source'],
    front: '{{Screenshot}}',
    back: `${ans}<div class="jp">{{Sentence}}</div><div class="jp target">{{Word}}</div>{{Video}}${src}`,
  },
  MinimalPair: {
    fields: ['Words', 'Readings', 'Meanings', 'Source'],
    front: '<div class="list">{{Words}}</div>',
    back: `${ans}<div class="list">{{Readings}}</div><div class="gloss">{{Meanings}}</div>${src}`,
  },
  Naturalness: {
    fields: ['Candidate', 'Verdict', 'Better', 'Explanation', 'Source'],
    front: '<div class="note">Would a native say this?</div><div class="jp">{{Candidate}}</div>',
    back: `${ans}<div class="jp target">{{Verdict}}</div><div class="jp">{{Better}}</div><div class="note">{{Explanation}}</div>${src}`,
  },
  Prediction: {
    fields: ['Prompt', 'Continuations', 'Source'],
    front: '<div class="note">Finish it</div><div class="jp">{{Prompt}}</div>',
    back: `${ans}<div class="list">{{Continuations}}</div>${src}`,
  },
  ReverseContext: {
    fields: ['Cloze', 'Word', 'Reading', 'Meaning', 'Translation', 'Audio', 'Source'],
    front: '<div class="note">What word is missing?</div><div class="jp">{{Cloze}}</div>',
    back: `${ans}<div class="jp target">{{Word}}</div><div class="reading">{{Reading}}</div><div class="gloss">{{Meaning}}</div><div class="en">{{Translation}}</div>{{Audio}}${src}`,
  },
};

export const CARD_TYPES = Object.keys(MODELS);
const modelName = (type) => `Kotoba::${type}`;

let ensured = null;
/** Create any missing note types and the target deck. Idempotent, cached. */
export async function ensureSchema() {
  if (ensured) return ensured;
  ensured = (async () => {
    const existing = new Set(await invoke('modelNames'));
    for (const [type, m] of Object.entries(MODELS)) {
      const name = modelName(type);
      if (existing.has(name)) continue;
      await invoke('createModel', {
        modelName: name,
        inOrderFields: m.fields,
        css: CSS,
        isCloze: false,
        cardTemplates: [{ Name: type, Front: m.front, Back: m.back }],
      });
    }
    const decks = new Set(await invoke('deckNames'));
    const { deckName } = getSettings();
    if (!decks.has(deckName)) await invoke('createDeck', { deck: deckName });
  })();
  return ensured;
}

/**
 * @param {string} type      one of CARD_TYPES
 * @param {object} fields    field name -> html
 * @param {Array}  media     [{ kind:'audio'|'video'|'picture', path, filename, field }]
 * @param {string[]} tags
 */
export async function addNote(type, fields, media = [], tags = []) {
  await ensureSchema();
  const note = {
    deckName: getSettings().deckName,
    modelName: modelName(type),
    fields,
    tags: ['kotoba', type, ...tags],
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  };
  for (const m of media) {
    // AnkiConnect stores the file and appends its reference to the named field.
    (note[m.kind] ??= []).push({ path: m.path, filename: m.filename, fields: [m.field] });
  }
  return invoke('addNote', { note });
}

export { invoke as ankiInvoke };
