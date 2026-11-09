import { getSettings } from './settings.mjs';

const MIN_VERSION = 6;

/** An AnkiConnect failure with a message fit for the UI and a stable `code` for logic. */
export class AnkiError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'AnkiError';
    this.code = code;
  }
}

const FRIENDLY = [
  [/duplicate/i, 'duplicate', () => 'Already in your deck'],
  [/deck was not found/i, 'missing-deck', (m) => `Anki has no deck named "${/: (.*)$/.exec(m)?.[1] ?? getSettings().deckName}"`],
  [/model was not found/i, 'missing-model', () => 'A Kotoba note type is missing in Anki'],
  [/collection is not available/i, 'no-collection', () => 'Anki is open but no profile is loaded - pick a profile in Anki'],
  [/valid api key/i, 'api-key', () => 'AnkiConnect requires an API key - clear "apiKey" in the AnkiConnect add-on config'],
];

async function post(action, params) {
  const url = getSettings().ankiConnect;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, version: MIN_VERSION, params }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new AnkiError(
      'unreachable',
      `Cannot reach AnkiConnect at ${url}. Open Anki and install the AnkiConnect add-on (code 2055492159).`,
      { cause }
    );
  }
  let body;
  try {
    body = await res.json();
  } catch (cause) {
    throw new AnkiError('bad-response', `${url} answered, but not like AnkiConnect (HTTP ${res.status})`, { cause });
  }
  // Pre-v6 AnkiConnect ignores `version` and returns a bare result with no envelope.
  if (body === null || typeof body !== 'object' || !('error' in body)) return { legacy: true, result: body };
  return body;
}

// Both caches are per AnkiConnect URL (and deck), so changing either in settings re-checks.
let permitted = null;
let permittedFor = null;
/** Newer AnkiConnect wants requestPermission before anything else; older ones lack the action. */
function ensurePermission() {
  const url = getSettings().ankiConnect;
  if (permittedFor !== url) permitted = null;
  permittedFor = url;
  permitted ??= (async () => {
    const res = await post('requestPermission', {});
    if (res.legacy || /unsupported action/i.test(res.error ?? '')) {
      const v = await post('version', {});
      const version = Number(v.result);
      if (v.legacy || !(version >= MIN_VERSION)) {
        throw new AnkiError('old-version', `AnkiConnect is too old (version ${v.result ?? 'unknown'}). Update the add-on in Anki: Tools > Add-ons > Check for Updates.`);
      }
      return;
    }
    if (res.error) throw new AnkiError('permission', `AnkiConnect: ${res.error}`);
    if (res.result?.permission !== 'granted') {
      throw new AnkiError('permission', 'Anki denied Kotoba access. Allow it in the AnkiConnect prompt inside Anki, then try again.');
    }
    if (Number(res.result.version) < MIN_VERSION) {
      throw new AnkiError('old-version', `AnkiConnect is too old (version ${res.result.version}). Update the add-on in Anki.`);
    }
  })();
  const p = permitted;
  p.catch(() => {
    if (permitted === p) permitted = null;
  });
  return p;
}

async function invoke(action, params = {}) {
  await ensurePermission();
  const { result, error } = await post(action, params);
  if (error) {
    const hit = FRIENDLY.find(([re]) => re.test(error));
    if (hit) throw new AnkiError(hit[1], hit[2](error));
    throw new AnkiError('anki', `AnkiConnect: ${error}`);
  }
  return result;
}

export const ankiVersion = async () => {
  try {
    return await invoke('version');
  } catch (e) {
    // A denied or failed permission probe must be re-asked next time Anki is checked.
    permitted = null;
    throw e;
  }
};

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

const template = (type) => ({ Front: MODELS[type].front, Back: MODELS[type].back });

/** Bring an existing Kotoba note type (from an older install) up to the current fields, templates and CSS. */
async function upgradeModel(type) {
  const name = modelName(type);
  const m = MODELS[type];
  const have = await invoke('modelFieldNames', { modelName: name });
  for (const [index, field] of m.fields.entries()) {
    if (!have.includes(field)) await invoke('modelFieldAdd', { modelName: name, fieldName: field, index });
  }
  const templates = await invoke('modelTemplates', { modelName: name });
  const [cardName = type] = Object.keys(templates ?? {});
  const now = templates?.[cardName];
  const want = template(type);
  if (now?.Front !== want.Front || now?.Back !== want.Back) {
    await invoke('updateModelTemplates', { model: { name, templates: { [cardName]: want } } });
  }
  const styling = await invoke('modelStyling', { modelName: name });
  if (styling?.css !== CSS) await invoke('updateModelStyling', { model: { name, css: CSS } });
}

let ensured = null;
let ensuredFor = null;
/** Create missing note types and the target deck; upgrade outdated note types. Cached until it fails. */
export function ensureSchema() {
  const { ankiConnect, deckName } = getSettings();
  if (ensuredFor !== `${ankiConnect}\n${deckName}`) ensured = null;
  ensuredFor = `${ankiConnect}\n${deckName}`;
  ensured ??= (async () => {
    const existing = new Set(await invoke('modelNames'));
    for (const [type, m] of Object.entries(MODELS)) {
      const name = modelName(type);
      if (existing.has(name)) {
        await upgradeModel(type);
        continue;
      }
      await invoke('createModel', {
        modelName: name,
        inOrderFields: m.fields,
        css: CSS,
        isCloze: false,
        cardTemplates: [{ Name: type, ...template(type) }],
      });
    }
    const decks = new Set(await invoke('deckNames'));
    if (!decks.has(deckName)) await invoke('createDeck', { deck: deckName });
  })();
  const p = ensured;
  p.catch(() => {
    if (ensured === p) ensured = null;
  });
  return p;
}

/**
 * @param {string} type      one of CARD_TYPES
 * @param {object} fields    field name -> html
 * @param {Array}  media     [{ kind:'audio'|'video'|'picture', path, filename, field }]
 * @param {string[]} tags
 */
export async function addNote(type, fields, media = [], tags = []) {
  if (!MODELS[type]) throw new Error(`unknown card type: ${type}`);
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
  try {
    return await invoke('addNote', { note });
  } catch (e) {
    // The deck or note type was deleted in Anki since the schema was checked: recreate once.
    if (e.code !== 'missing-deck' && e.code !== 'missing-model') throw e;
    ensured = null;
    await ensureSchema();
    return invoke('addNote', { note });
  }
}

export { invoke as ankiInvoke };
