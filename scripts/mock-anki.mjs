// A stand-in for the AnkiConnect add-on, so the full mining path can be tested
// without Anki running. Prints every request it receives.
//   node --no-warnings test/mock-anki.mjs [port]

import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] ?? 8765);
const models = new Map();
const decks = new Set(['Default']);
let nextId = 1700000000000;
export const received = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { action, params } = JSON.parse(body || '{}');
    let result = null;
    let error = null;

    switch (action) {
      case 'version': result = 6; break;
      case 'modelNames': result = [...models.keys()]; break;
      case 'deckNames': result = [...decks]; break;
      case 'createDeck': decks.add(params.deck); result = 1; break;
      case 'createModel':
        models.set(params.modelName, params);
        console.log(`  createModel  ${params.modelName}  fields=[${params.inOrderFields.join(', ')}]`);
        result = { name: params.modelName };
        break;
      case 'addNote': {
        const n = params.note;
        const model = models.get(n.modelName);
        if (!model) { error = `model was not found: ${n.modelName}`; break; }
        const unknown = Object.keys(n.fields).filter((f) => !model.inOrderFields.includes(f));
        if (unknown.length) { error = `unknown field(s): ${unknown.join(', ')}`; break; }
        const missing = model.inOrderFields.filter((f) => !(f in n.fields));
        if (missing.length) { error = `missing field(s): ${missing.join(', ')}`; break; }
        for (const kind of ['audio', 'video', 'picture']) {
          for (const m of n[kind] ?? []) {
            if (!fs.existsSync(m.path)) { error = `${kind} file missing: ${m.path}`; break; }
            if (!m.fields?.length) { error = `${kind} has no target field`; break; }
            if (!model.inOrderFields.includes(m.fields[0])) {
              error = `${kind} targets unknown field ${m.fields[0]}`;
            }
          }
        }
        if (error) break;
        received.push(n);
        console.log(`  addNote      ${n.modelName}  media=[${['audio','video','picture'].filter(k=>n[k]?.length).join(', ') || 'none'}]  tags=[${n.tags.join(' ')}]`);
        result = nextId++;
        break;
      }
      default: error = `unsupported action: ${action}`;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result, error }));
  });
});

server.listen(port, () => console.log(`[mock-anki] listening on ${port}`));
