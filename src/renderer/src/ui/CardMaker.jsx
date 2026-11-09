import React, { useEffect, useState } from 'react';
import { previewCards, createCards, lookupWord } from '../api/core.js';
import Icon from './icons.jsx';
import { store } from './util.js';

const TYPES = {
  ContextCloze: ['Context cloze', 'The line as-is; reading, gloss and translation on the back.'],
  Contrast: ['Contrast', 'Forced choice between the word and its nearest confusable.'],
  ReadingContrast: ['Reading contrast', 'Beside other words sharing a kanji but read differently.'],
  Audio: ['Audio', 'The clip on the front, nothing else.'],
  Production: ['Production', 'English on the front, the Japanese line on the back.'],
  Situation: ['Situation', 'A described situation; what a native would say.'],
  Collocation: ['Collocation', 'The phrases this word lives in, from your own watched lines.'],
  Image: ['Image', 'A frame from the scene; Japanese on the back, no English.'],
  MinimalPair: ['Minimal pair', 'Same reading, different spelling: 保証 / 保障.'],
  Naturalness: ['Would a native say this?', 'A plausible-but-off sentence, judged.'],
  Prediction: ['Prediction', 'The word plus a blank; what most often follows it.'],
  ReverseContext: ['Reverse context', 'The line with the word blanked out.'],
};
const GROUPS = [
  ['From the clip', ['ContextCloze', 'Audio', 'Image', 'Production', 'ReverseContext']],
  ['From the dictionary', ['ReadingContrast', 'MinimalPair']],
  ['From your watched lines', ['Collocation', 'Prediction']],
  ['Needs Claude', ['Contrast', 'Situation', 'Naturalness']],
];
const NEEDS_LLM = new Set(['Contrast', 'Situation', 'Naturalness']);


function Sentence({ text, word }) {
  const i = text.indexOf(word);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <b>{word}</b>
      {text.slice(i + word.length)}
    </>
  );
}

export default function CardMaker({ ctx, status, covered, onClose, onDone, onError, onSettings }) {
  const [selected, setSelected] = useState(() => new Set(store.get('cardTypes', ['ContextCloze']).filter((t) => !NEEDS_LLM.has(t) || status.llm)));
  const [entries, setEntries] = useState(ctx.token.entries ?? []);
  const [entryId, setEntryId] = useState(ctx.token.entries?.[0]?.id ?? null);
  const [includeVideo, setIncludeVideo] = useState(false);
  const [translation, setTranslation] = useState(ctx.translation ?? '');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    if (entries.length) return;
    lookupWord(ctx.token.text)
      .then((list) => {
        setEntries(list);
        setEntryId(list[0]?.id ?? null);
      })
      .catch((e) => onError(e.message));
  }, [ctx.token.text]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = () => ({
    mediaId: ctx.mediaId,
    cue: ctx.cue,
    cueIndex: ctx.cueIndex,
    word: ctx.token.text,
    entryId,
    types: [...selected],
    translation: translation.trim(),
    includeVideo,
    audioStream: ctx.audioStream ?? undefined,
  });

  const run = async (label, fn) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const doPreview = () => run('preview', async () => setPreview(await previewCards(body())));
  const doCreate = () =>
    run('create', async () => {
      store.set('cardTypes', [...selected]);
      onDone(await createCards(body()));
    });

  const ankiOff = status.anki == null;
  const canCreate = selected.size && !busy && !ankiOff;

  useEffect(() => {
    const onKey = (e) => {
      if (covered) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCreate) {
        e.preventDefault();
        doCreate();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const toggle = (type) => {
    setPreview(null);
    setSelected((s) => {
      const next = new Set(s);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-testid="card-maker" role="dialog" aria-modal="true" aria-labelledby="cm-word">
        <header className="cm-head">
          <div style={{ minWidth: 0 }}>
            <div className="word" id="cm-word">{ctx.token.text}</div>
            <div className="sentence"><Sentence text={ctx.cue.text.replace(/\n/g, ' ')} word={ctx.token.text} /></div>
          </div>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close (Esc)"><Icon name="close" /></button>
        </header>

        <div className="body">
          <div className="cm-grid">
            <div>
              <span className="label">Meaning</span>
              <div className="entries" role="radiogroup" aria-label="Dictionary entry">
                {entries.slice(0, 8).map((e) => (
                  <button
                    key={e.id}
                    role="radio"
                    aria-checked={e.id === entryId}
                    className={`entry-opt${e.id === entryId ? ' sel' : ''}`}
                    onClick={() => {
                      setEntryId(e.id);
                      setPreview(null);
                    }}
                  >
                    <div className="h">{e.kanji || e.reading}{e.kanji && e.reading ? <span>{e.reading}</span> : null}</div>
                    <span className="g">{e.senses?.[0]?.text?.slice(0, 3).join('; ')}</span>
                  </button>
                ))}
                {!entries.length ? <span className="hint">No dictionary entry found.</span> : null}
              </div>

              <label className="label" htmlFor="cm-tr">Translation</label>
              <div className="field">
                <textarea
                  id="cm-tr"
                  value={translation}
                  onChange={(e) => {
                    setTranslation(e.target.value);
                    setPreview(null);
                  }}
                  placeholder={status.llm ? 'Left blank, Claude writes one.' : 'Optional. Pick a secondary subtitle track to fill this in.'}
                />
                <span className="hint">
                  {ctx.translation ? 'From the secondary subtitle track.' : status.llm ? 'Claude fills it in if left blank.' : 'Production cards need a translation.'}
                </span>
              </div>

              <span className="label">Media</span>
              <label className="row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={includeVideo} onChange={(e) => { setIncludeVideo(e.target.checked); setPreview(null); }} />
                Attach a video clip to image cards
              </label>
            </div>

            <div>
              {GROUPS.map(([title, types]) => (
                <div className="type-group" key={title}>
                  <h5>{title}</h5>
                  <div className="types">
                    {types.map((type) => {
                      const disabled = NEEDS_LLM.has(type) && !status.llm;
                      const [label, blurb] = TYPES[type];
                      const sel = selected.has(type);
                      return (
                        <button key={type} className={`type${sel ? ' sel' : ''}`} disabled={disabled} onClick={() => toggle(type)} role="checkbox" aria-checked={sel}>
                          <span className="box">{sel ? '✓' : ''}</span>
                          <span>
                            <b>{label}</b>
                            <small>{disabled ? 'Add a Claude API key in Settings to enable.' : blurb}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {preview ? (
            <div className="preview" aria-live="polite">
              {preview.cards.map((c) => (
                <div className="pcard" key={c.type}>
                  <h4>{TYPES[c.type]?.[0] ?? c.type}{c.media.length ? ` · ${c.media.join(', ')}` : ''}</h4>
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
                <div className="warn" key={s.type}>{TYPES[s.type]?.[0] ?? s.type}: {s.reason}</div>
              ))}
            </div>
          ) : null}
        </div>

        <footer>
          <div className="status-row">
            <span><span className={`dot ${ankiOff ? 'bad' : 'ok'}`} />{ankiOff ? 'Anki not reachable' : `Anki → ${status.deckName}`}</span>
            <span><span className={`dot ${status.llm ? 'ok' : ''}`} />{status.llm ? 'Claude ready' : 'Claude off'}</span>
            {ankiOff ? <button className="btn small ghost" onClick={onSettings}>Settings…</button> : null}
          </div>
          <span className="spacer" />
          <button className="btn" onClick={doPreview} disabled={!selected.size || !!busy}>
            {busy === 'preview' ? 'Building…' : 'Preview'}
          </button>
          <button className="btn primary" onClick={doCreate} disabled={!canCreate} title="⌘↵">
            {busy === 'create' ? 'Adding…' : `Add ${selected.size} card${selected.size === 1 ? '' : 's'}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
