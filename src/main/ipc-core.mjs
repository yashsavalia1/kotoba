import fs from 'node:fs';
import { app, safeStorage } from 'electron';
import { dictReady, userDb } from '../core/db.mjs';
import { getSettings, setSettings, setApiKey, getApiKey } from '../core/settings.mjs';
import { tokenize, lookup, glossText } from '../core/dict.mjs';
import { corpusSize } from '../core/corpus.mjs';
import { buildCards, CARD_TYPES, REQUIREMENTS } from '../core/cards.mjs';
import { addNote, ankiVersion, ensureSchema } from '../core/anki.mjs';
import { llmAvailable } from '../core/llm.mjs';
import { pathOf, getMedia } from '../core/library.mjs';
import { handle } from './ipc-util.mjs';

const KEY_META = 'anthropic_key';

export function loadApiKey() {
  const row = userDb().prepare('SELECT value FROM meta WHERE key = ?').get(KEY_META);
  if (!row || !safeStorage.isEncryptionAvailable()) return;
  try {
    setApiKey(safeStorage.decryptString(Buffer.from(row.value, 'base64')));
  } catch (e) {
    console.error('[kotoba] could not decrypt stored API key:', e.message);
  }
}

function saveApiKey(key) {
  const db = userDb();
  if (!key) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(KEY_META);
    setApiKey(null);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable');
  const enc = safeStorage.encryptString(key).toString('base64');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY_META, enc);
  setApiKey(key);
}

async function cardRequest(req) {
  const abs = pathOf(req.mediaId);
  return { ...req, mediaPath: abs, mediaTitle: getMedia(req.mediaId).title };
}

export function registerCoreIpc() {
  handle('app:status', async () => {
    let anki = null;
    try {
      anki = await ankiVersion();
    } catch {
      /* Anki closed or AnkiConnect missing; the UI shows it */
    }
    return {
      version: app.getVersion(),
      platform: process.platform,
      dictReady: dictReady(),
      anki,
      llm: llmAvailable(),
      hasStoredKey: Boolean(userDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(KEY_META)),
      envKey: Boolean(process.env.ANTHROPIC_API_KEY),
      corpusLines: corpusSize(),
      deckName: getSettings().deckName,
      cardTypes: CARD_TYPES.map((type) => ({ type, ...REQUIREMENTS[type] })),
    };
  });

  handle('settings:get', () => getSettings());
  handle('settings:set', (patch) => setSettings(patch));
  handle('settings:setApiKey', (key) => {
    saveApiKey(String(key ?? '').trim());
    return Boolean(getApiKey());
  });

  handle('dict:lookup', (word) =>
    lookup(String(word ?? ''))
      .slice(0, 12)
      .map((e) => ({ ...e, glossText: glossText(e) }))
  );
  handle('dict:tokenize', (text) => tokenize(String(text ?? '')));

  handle('cards:preview', async (req) => {
    const { cards, skipped, files } = await buildCards(await cardRequest(req));
    for (const f of files) fs.rmSync(f, { force: true });
    return {
      cards: cards.map((c) => ({ type: c.type, fields: c.fields, media: c.media.map((m) => m.kind) })),
      skipped,
    };
  });

  handle('cards:create', async (req) => {
    if (!Array.isArray(req?.types) || !req.types.length) throw new Error('Pick at least one card type');
    const { cards, skipped, files } = await buildCards(await cardRequest(req));
    const allowDuplicate = Boolean(req.allowDuplicates) || !getSettings().warnDuplicates;
    const added = [];
    const failed = [...skipped];
    // Cards Anki called duplicates; the card maker asks before adding them anyway.
    const duplicates = [];
    const ins = userDb().prepare('INSERT INTO mined (word, type, media_id, cue, at) VALUES (?, ?, ?, ?, ?)');
    try {
      for (const card of cards) {
        try {
          const noteId = await addNote(card.type, card.fields, card.media, [], { allowDuplicate });
          ins.run(req.word, card.type, req.mediaId, req.cueIndex ?? -1, Date.now());
          added.push({ type: card.type, noteId });
        } catch (e) {
          if (e.code === 'duplicate') duplicates.push(card.type);
          else failed.push({ type: card.type, reason: e.message });
        }
      }
    } finally {
      for (const f of files) fs.rmSync(f, { force: true });
    }
    return { added, skipped: failed, duplicates };
  });

  handle('cards:minedWords', () =>
    userDb().prepare('SELECT DISTINCT word FROM mined').all().map((r) => r.word)
  );

  handle('anki:setup', async () => {
    await ensureSchema();
    return { deck: getSettings().deckName };
  });
}
