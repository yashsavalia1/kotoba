import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSettings } from '../src/core/settings.mjs';
import { addNote, ankiVersion, ensureSchema, MODELS, CARD_TYPES } from '../src/core/anki.mjs';
import { startMockAnki } from '../scripts/mock-anki.mjs';

const mocks = [];
async function anki(opts) {
  const mock = await startMockAnki(opts);
  mocks.push(mock);
  setSettings({ ankiConnect: mock.url, deckName: 'Kotoba' });
  return mock;
}
test.after(() => Promise.all(mocks.map((m) => m.close())));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-anki-'));
const file = (name, bytes = 'x') => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, bytes);
  return p;
};
const fieldsFor = (type, over = {}) => ({ ...Object.fromEntries(MODELS[type].fields.map((f) => [f, ''])), ...over });

test('asks for permission first, then creates every note type and the deck', async () => {
  const { state } = await anki();
  assert.equal(await ankiVersion(), 6);
  await ensureSchema();
  assert.equal(state.calls[0], 'requestPermission');
  assert.deepEqual([...state.models.keys()].sort(), CARD_TYPES.map((t) => `Kotoba::${t}`).sort());
  assert.ok(state.decks.has('Kotoba'));
  assert.equal(state.calls.filter((c) => c === 'requestPermission').length, 1, 'permission is asked once');
});

test('a denied permission is a clear error and is asked again next time', async () => {
  const mock = await anki({ permission: 'denied' });
  await assert.rejects(ankiVersion(), (e) => e.code === 'permission' && /denied/.test(e.message));
  mock.state.permission = 'granted';
  assert.equal(await ankiVersion(), 6);
});

test('an AnkiConnect without requestPermission still works if new enough, and is refused if too old', async () => {
  const mock = await anki({ legacy: true });
  assert.equal(await ankiVersion(), 6);
  const old = await anki({ legacy: true, version: 4 });
  await assert.rejects(ankiVersion(), (e) => e.code === 'old-version' && /too old \(version 4\)/.test(e.message));
  assert.ok(old.state.calls.includes('version'));
  assert.ok(mock.state.calls.includes('version'));
});

test('connection refused names the URL and the add-on', async () => {
  const mock = await anki();
  await mock.close();
  await assert.rejects(ankiVersion(), (e) => e.code === 'unreachable' && e.message.includes(mock.url) && /2055492159/.test(e.message));
});

test('ensureSchema forgets a failure so a retry after Anki starts works', async () => {
  const mock = await anki();
  const url = mock.url;
  await mock.close();
  await assert.rejects(ensureSchema(), /Cannot reach AnkiConnect/);
  const again = await startMockAnki({ port: Number(new URL(url).port) });
  mocks.push(again);
  await ensureSchema();
  assert.equal(again.state.models.size, CARD_TYPES.length);
});

test('an outdated Kotoba note type is upgraded in place, not recreated', async () => {
  const { state } = await anki();
  const old = {
    fields: ['Sentence', 'Word', 'Reading', 'Meaning', 'Audio', 'Source', 'Notes'],
    templates: { 'Old card': { Front: '{{Sentence}}', Back: '{{FrontSide}}' } },
    css: '.card {}',
  };
  state.models.set('Kotoba::ContextCloze', old);
  await ensureSchema();
  const m = state.models.get('Kotoba::ContextCloze');
  assert.equal(m, old, 'same note type, so existing notes keep their scheduling');
  for (const f of MODELS.ContextCloze.fields) assert.ok(m.fields.includes(f), `missing ${f}`);
  assert.ok(m.fields.includes('Notes'), "the user's own extra field is kept");
  assert.deepEqual(Object.keys(m.templates), ['Old card'], 'the existing template is updated, not replaced');
  assert.equal(m.templates['Old card'].Front, MODELS.ContextCloze.front);
  assert.match(m.css, /\.target/);
});

test('an up-to-date note type is not rewritten', async () => {
  const { state } = await anki();
  await ensureSchema();
  const second = await startMockAnki();
  mocks.push(second);
  second.state.models = structuredClone(state.models);
  second.state.decks = new Set(state.decks);
  setSettings({ ankiConnect: second.url });
  await ensureSchema();
  assert.ok(!second.state.calls.some((c) => /^(update|create|modelFieldAdd)/.test(c)), second.state.calls.join(' '));
});

test('media is attached to its field and content-addressed names are stored once', async () => {
  const { state } = await anki();
  const audio = file('a.mp3', 'audio-bytes');
  const pic = file('i.jpg', 'jpeg-bytes');
  const media = [
    { kind: 'audio', path: audio, filename: 'kotoba_abc.mp3', field: 'Audio' },
    { kind: 'picture', path: pic, filename: 'kotoba_def.jpg', field: 'Screenshot' },
  ];
  const id = await addNote('ContextCloze', fieldsFor('ContextCloze', { Sentence: '<b>正直</b>に言うと' }), media);
  assert.equal(typeof id, 'number');
  const note = state.notes.at(-1);
  assert.equal(note.fields.Audio, '[sound:kotoba_abc.mp3]');
  assert.equal(note.fields.Screenshot, '<img src="kotoba_def.jpg">');
  assert.equal(note.deckName, 'Kotoba');
  assert.deepEqual(note.tags, ['kotoba', 'ContextCloze']);

  await addNote('ReverseContext', fieldsFor('ReverseContext', { Cloze: '＿＿＿に言うと' }), [
    { kind: 'audio', path: audio, filename: 'kotoba_abc.mp3', field: 'Audio' },
  ]);
  assert.equal(state.media.size, 2, 're-mining the same clip reuses one media file');
});

test('a duplicate note is reported as already in the deck', async () => {
  await anki();
  const fields = fieldsFor('Prediction', { Prompt: '正直＿＿＿', Continuations: 'に言うと' });
  await addNote('Prediction', fields);
  await assert.rejects(addNote('Prediction', fields), (e) => e.code === 'duplicate' && e.message === 'Already in your deck');
});

test('a deck or note type deleted in Anki after setup is recreated on the next add', async () => {
  const { state } = await anki();
  await ensureSchema();
  state.decks.delete('Kotoba');
  state.models.delete('Kotoba::Collocation');
  await addNote('Collocation', fieldsFor('Collocation', { Word: '正直', Collocations: '正直者' }));
  assert.ok(state.decks.has('Kotoba'));
  assert.equal(state.notes.at(-1).modelName, 'Kotoba::Collocation');
});

test('changing the deck in settings creates the new deck', async () => {
  const { state } = await anki();
  await ensureSchema();
  setSettings({ deckName: 'Mining::Takagi' });
  await addNote('Collocation', fieldsFor('Collocation', { Word: '勝負', Collocations: 'この勝負' }));
  assert.ok(state.decks.has('Mining::Takagi'));
  assert.equal(state.notes.at(-1).deckName, 'Mining::Takagi');
  setSettings({ deckName: 'Kotoba' });
});
