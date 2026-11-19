// A stand-in for the AnkiConnect add-on, so the full mining path can be tested
// without Anki running. As a script it prints every request it receives:
//   node --no-warnings scripts/mock-anki.mjs [port]
// Tests import startMockAnki() and inspect / mutate its state directly.

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MEDIA_KINDS = ['audio', 'video', 'picture'];
const mediaRef = (kind, filename) => (kind === 'picture' ? `<img src="${filename}">` : `[sound:${filename}]`);
// Anki's duplicate check compares first fields with HTML stripped but media filenames kept.
const stripHtml = (s) => s.replace(/<img[^>]*?\bsrc=["']?([^"'\s>]+)[^>]*>/gi, ' $1 ').replace(/<[^>]*>/g, '');

/**
 * @param {object} [opts]
 * @param {number} [opts.port]        0 picks a free port
 * @param {'granted'|'denied'} [opts.permission]
 * @param {number} [opts.version]     what `version` reports
 * @param {boolean} [opts.legacy]     an AnkiConnect that predates requestPermission
 * @param {boolean} [opts.log]
 */
export function startMockAnki({ port = 0, permission = 'granted', version = 6, legacy = false, log = false } = {}) {
  const state = {
    permission,
    version,
    legacy,
    models: new Map(), // name -> { fields, templates: { name: { Front, Back } }, css }
    decks: new Set(['Default']),
    media: new Map(), // filename -> bytes
    notes: [],
    calls: [],
  };
  let nextId = 1700000000000;
  const say = (...a) => log && console.log(...a);

  const actions = {
    requestPermission: () => {
      if (state.legacy) throw new Error('unsupported action');
      return state.permission === 'granted'
        ? { permission: 'granted', requireApiKey: false, version: state.version }
        : { permission: 'denied' };
    },
    version: () => state.version,
    modelNames: () => [...state.models.keys()],
    deckNames: () => [...state.decks],
    createDeck: ({ deck }) => (state.decks.add(deck), 1),
    createModel: ({ modelName, inOrderFields, css, cardTemplates }) => {
      if (state.models.has(modelName)) throw new Error('Model name already exists');
      state.models.set(modelName, {
        fields: [...inOrderFields],
        css,
        templates: Object.fromEntries(cardTemplates.map((t, i) => [t.Name ?? `Card ${i + 1}`, { Front: t.Front, Back: t.Back }])),
      });
      say(`  createModel  ${modelName}  fields=[${inOrderFields.join(', ')}]`);
      return { name: modelName };
    },
    modelFieldNames: ({ modelName }) => [...model(modelName).fields],
    modelFieldAdd: ({ modelName, fieldName, index }) => {
      const m = model(modelName);
      if (m.fields.includes(fieldName)) throw new Error(`field already exists: ${fieldName}`);
      m.fields.splice(index ?? m.fields.length, 0, fieldName);
      return null;
    },
    modelTemplates: ({ modelName }) => structuredClone(model(modelName).templates),
    updateModelTemplates: ({ model: { name, templates } }) => {
      const m = model(name);
      for (const [card, t] of Object.entries(templates)) {
        if (!m.templates[card]) throw new Error(`template not found: ${card}`);
        Object.assign(m.templates[card], t);
      }
      return null;
    },
    modelStyling: ({ modelName }) => ({ css: model(modelName).css }),
    updateModelStyling: ({ model: { name, css } }) => ((model(name).css = css), null),
    addNote: ({ note: n }) => {
      const m = state.models.get(n.modelName);
      if (!m) throw new Error(`model was not found: ${n.modelName}`);
      if (!state.decks.has(n.deckName)) throw new Error(`deck was not found: ${n.deckName}`);
      const unknown = Object.keys(n.fields).filter((f) => !m.fields.includes(f));
      if (unknown.length) throw new Error(`unknown field(s): ${unknown.join(', ')}`);
      // Real AnkiConnect leaves unmentioned fields empty and attaches media before its checks.
      const fields = Object.fromEntries(m.fields.map((f) => [f, n.fields[f] ?? '']));
      const stored = [];
      for (const kind of MEDIA_KINDS) {
        for (const item of n[kind] ?? []) {
          if (!fs.existsSync(item.path)) throw new Error(`${kind} file missing: ${item.path}`);
          if (!item.fields?.length) throw new Error(`${kind} has no target field`);
          for (const f of item.fields) {
            if (!m.fields.includes(f)) throw new Error(`${kind} targets unknown field ${f}`);
            fields[f] += mediaRef(kind, item.filename);
          }
          stored.push([item.filename, fs.readFileSync(item.path)]);
        }
      }
      const first = fields[m.fields[0]];
      if (!first.trim()) throw new Error('cannot create note because it is empty');
      const allowDup = n.options?.allowDuplicate;
      const scopeDeck = n.options?.duplicateScope === 'deck';
      if (
        !allowDup &&
        state.notes.some(
          (o) =>
            o.modelName === n.modelName &&
            (!scopeDeck || o.deckName === n.deckName) &&
            stripHtml(o.fields[m.fields[0]]) === stripHtml(first)
        )
      ) {
        throw new Error('cannot create note because it is a duplicate');
      }
      for (const [name, bytes] of stored) state.media.set(name, bytes);
      const id = nextId++;
      state.notes.push({ id, ...n, fields });
      say(`  addNote      ${n.modelName}  media=[${MEDIA_KINDS.filter((k) => n[k]?.length).join(', ') || 'none'}]  tags=[${n.tags.join(' ')}]`);
      return id;
    },
  };

  function model(name) {
    const m = state.models.get(name);
    if (!m) throw new Error(`model was not found: ${name}`);
    return m;
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let result = null;
      let error = null;
      try {
        const { action, params = {} } = JSON.parse(body || '{}');
        state.calls.push(action);
        if (!actions[action]) throw new Error(`unsupported action: ${action}`);
        result = actions[action](params) ?? null;
      } catch (e) {
        error = e.message;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result, error }));
    });
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    )
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startMockAnki({ port: Number(process.argv[2] ?? 8765), log: true });
  console.log(`[mock-anki] listening on ${url}`);
}
