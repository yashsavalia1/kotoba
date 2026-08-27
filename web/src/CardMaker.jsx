import React, { useEffect, useState } from 'react';
import { previewCards, createCards, lookupWord } from './api.js';

const TYPES = [
  ['ContextCloze', 'Context cloze', 'The line as-is on the front; reading, gloss and translation on the back. Tests recognition in a natural sentence.'],
  ['Contrast', 'Contrast', 'Forced choice between the word and its nearest confusable. Teaches the decision boundary. Needs Claude.'],
  ['ReadingContrast', 'Reading contrast', 'The word beside others sharing a kanji but read differently. Perceptual training.'],
  ['Audio', 'Audio', 'Clip on the front, nothing else. Trains the skill you actually use while watching.'],
  ['Production', 'Production', 'English on the front, the Japanese line on the back. Active recall.'],
  ['Situation', 'Situation', 'A described situation on the front; what a native would say on the back. Needs Claude.'],
  ['Collocation', 'Collocation', 'The phrases this word actually lives in — from the dictionary and from your own watched subtitles.'],
  ['Image', 'Image', 'A frame from the scene on the front, Japanese on the back. No English anywhere.'],
  ['MinimalPair', 'Minimal pair', 'Same reading, different spelling — 保証 / 保障, 感心 / 関心.'],
  ['Naturalness', 'Would a native say this?', 'A plausible-but-off sentence, judged. Needs Claude.'],
  ['Prediction', 'Prediction', 'The word plus a blank; the back is what most often follows it in your corpus.'],
  ['ReverseContext', 'Reverse context', 'The line with the word blanked out. Produce the missing word.'],
];

const DEFAULT = ['ContextCloze'];

export default function CardMaker({ ctx, status, onClose, onDone, onError }) {
  const [selected, setSelected] = useState(new Set(DEFAULT));
  const [entries, setEntries] = useState(ctx.token.entries ?? []);
  const [entryId, setEntryId] = useState(ctx.token.entries?.[0]?.id ?? null);
  const [includeVideo, setIncludeVideo] = useState(false);
  const [translation, setTranslation] = useState(ctx.translation ?? '');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    if (entries.length) return;
    lookupWord(ctx.token.text)
      .then((r) => {
        setEntries(r.entries);
        setEntryId(r.entries[0]?.id ?? null);
      })
      .catch((e) => onError(e.message));
  }, [ctx.token.text]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const body = () => ({
    mediaId: ctx.mediaId,
    cue: ctx.cue,
    cueIndex: ctx.cueIndex,
    word: ctx.token.text,
    entryId,
    types: [...selected],
    translation,
    includeVideo,
  });

  const toggle = (type, disabled) => {
    if (disabled) return;
    setPreview(null);
    setSelected((s) => {
      const next = new Set(s);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  };

  const run = async (fn, label) => {
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      onError(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const doPreview = () => run(() => previewCards(body()).then(setPreview), 'preview');
  const doCreate = () =>
    run(async () => {
      const r = await createCards(body());
      onDone(r);
    }, 'create');

  const ankiOff = status.anki == null;

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <div>
            <div className="jp" style={{ fontSize: 22 }}>{ctx.token.text}</div>
            <div className="dim" style={{ fontSize: 12 }}>{ctx.cue.text.replace(/\n/g, ' ')}</div>
          </div>
          <span className="spacer" />
          <button onClick={onClose}>✕</button>
        </header>

        <div className="body">
          {entries.length > 1 ? (
            <>
              <div className="dim" style={{ fontSize: 12 }}>Which entry?</div>
              <div className="entrypick">
                {entries.slice(0, 8).map((e) => (
                  <button
                    key={e.id}
                    className={e.id === entryId ? 'sel' : ''}
                    onClick={() => { setEntryId(e.id); setPreview(null); }}
                  >
                    <span className="jp">{e.kanji || e.reading}</span>
                    <span className="dim">　{e.reading}　{e.senses[0]?.text[0]}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="typegrid">
            {TYPES.map(([type, label, blurb]) => {
              const needsLlm = ['Contrast', 'Situation', 'Naturalness'].includes(type);
              const disabled = needsLlm && !status.llm;
              return (
                <label
                  key={type}
                  className={`type${selected.has(type) ? ' sel' : ''}${disabled ? ' disabled' : ''}`}
                  onClick={(e) => { e.preventDefault(); toggle(type, disabled); }}
                >
                  <input type="checkbox" readOnly checked={selected.has(type)} disabled={disabled} />
                  <span>
                    <b>{label}</b>
                    <small>{disabled ? 'Set ANTHROPIC_API_KEY to enable.' : blurb}</small>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <label className="row dim" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={includeVideo} onChange={(e) => { setIncludeVideo(e.target.checked); setPreview(null); }} />
              attach video clip
            </label>
            <input
              type="text"
              style={{ flex: 1 }}
              placeholder="English translation (optional — Claude fills it in if left blank)"
              value={translation}
              onChange={(e) => setTranslation(e.target.value)}
            />
          </div>

          {preview ? (
            <div className="preview">
              {preview.cards.map((c) => (
                <div className="pcard" key={c.type}>
                  <h4>{c.type}{c.media.length ? ` · ${c.media.join(', ')}` : ''}</h4>
                  {Object.entries(c.fields)
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div className="pfield" key={k}>
                        <span>{k}</span>
                        <div className="jp" dangerouslySetInnerHTML={{ __html: v }} />
                      </div>
                    ))}
                </div>
              ))}
              {preview.skipped.map((s) => (
                <div className="warn" key={s.type}>{s.type}: {s.reason}</div>
              ))}
            </div>
          ) : null}
        </div>

        <footer>
          <span className="dim" style={{ fontSize: 12 }}>
            {selected.size} card{selected.size === 1 ? '' : 's'} → {status.deckName}
            {ankiOff ? ' · Anki is not running' : ''}
          </span>
          <span className="spacer" />
          <button onClick={doPreview} disabled={!selected.size || !!busy}>
            {busy === 'preview' ? 'Building…' : 'Preview'}
          </button>
          <button className="primary" onClick={doCreate} disabled={!selected.size || !!busy || ankiOff}>
            {busy === 'create' ? 'Sending…' : 'Add to Anki'}
          </button>
        </footer>
      </div>
    </div>
  );
}
