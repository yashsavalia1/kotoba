import React, { useCallback, useEffect, useState } from 'react';
import Player from './Player.jsx';
import CardMaker from './CardMaker.jsx';
import * as api from './api.js';

function Pill({ ok, children, title }) {
  return <span className={`pill ${ok ? 'on' : 'off'}`} title={title}>{children}</span>;
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [library, setLibrary] = useState([]);
  const [current, setCurrent] = useState(null); // { id, title, isVideo, tracks }
  const [trackIndex, setTrackIndex] = useState(0);
  const [subs, setSubs] = useState(null);
  const [playUrl, setPlayUrl] = useState(null);
  const [progress, setProgress] = useState(null);
  const [mining, setMining] = useState(null);
  const [minedWords, setMinedWords] = useState(new Set());
  const [toast, setToast] = useState(null);

  const say = useCallback((text, err = false) => {
    setToast({ text, err });
    setTimeout(() => setToast(null), err ? 7000 : 3500);
  }, []);

  const refreshStatus = useCallback(
    () => api.getStatus().then(setStatus).catch((e) => say(e.message, true)),
    [say]
  );

  useEffect(() => {
    refreshStatus();
    api.getLibrary().then(setLibrary).catch((e) => say(e.message, true));
  }, [refreshStatus, say]);

  // Open a file: fetch its subtitle tracks, then make it browser-playable.
  const open = async (item) => {
    setCurrent(null);
    setSubs(null);
    setPlayUrl(null);
    setProgress(null);
    setTrackIndex(0);
    try {
      const info = await api.getMedia(item.id);
      setCurrent(info);
      if (!info.tracks.length) say('No text subtitle track found for this file.', true);

      let state = await api.prepare(item.id);
      while (state.status === 'working') {
        setProgress(state);
        await new Promise((r) => setTimeout(r, 700));
        state = await api.prepare(item.id);
      }
      setProgress(null);
      if (state.status === 'error') throw new Error(state.error ?? 'conversion failed');
      setPlayUrl(state.url);
    } catch (e) {
      say(e.message, true);
    }
  };

  // Load (and segment) a subtitle track whenever the file or track changes.
  useEffect(() => {
    if (!current?.tracks?.length) return;
    setSubs(null);
    api
      .getSubs(current.id, trackIndex)
      .then(setSubs)
      .catch((e) => say(e.message, true));
  }, [current, trackIndex, say]);

  const onMine = useCallback(
    (token, cueIndex) => {
      if (!subs || cueIndex == null || cueIndex < 0) return;
      setMining({
        mediaId: current.id,
        cue: subs.cues[cueIndex],
        cueIndex,
        token,
        translation: '',
      });
    },
    [subs, current]
  );

  const onDone = ({ added, skipped }) => {
    setMining(null);
    if (added.length) {
      setMinedWords((s) => new Set(s).add(mining.token.lemma));
      say(`Added ${added.length} card${added.length === 1 ? '' : 's'}: ${added.map((a) => a.type).join(', ')}`);
    }
    if (skipped.length) {
      say(skipped.map((s) => `${s.type}: ${s.reason}`).join(' · '), true);
    }
  };

  if (!status) return <div className="empty">Starting…</div>;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">言葉<span>.</span></div>
        <Pill ok={status.dictReady} title="JMdict in SQLite">
          {status.dictReady ? 'dictionary' : 'no dictionary — run npm run dict'}
        </Pill>
        <Pill ok={status.ffmpeg} title="playback + clip extraction">ffmpeg</Pill>
        <Pill ok={status.anki != null} title={`AnkiConnect · deck ${status.deckName}`}>
          {status.anki != null ? `anki v${status.anki}` : 'anki offline'}
        </Pill>
        <Pill ok={status.llm} title="Contrast / Situation / Naturalness cards">claude</Pill>
        <span className="pill">{status.corpusLines.toLocaleString()} lines mined</span>
        <span className="spacer" />
        {current?.tracks?.length > 1 ? (
          <select value={trackIndex} onChange={(e) => setTrackIndex(Number(e.target.value))}>
            {current.tracks.map((t, i) => (
              <option key={i} value={i}>{t.label}</option>
            ))}
          </select>
        ) : null}
        <button onClick={() => api.ankiSetup().then(() => { say('Note types installed.'); refreshStatus(); }).catch((e) => say(e.message, true))}>
          Install note types
        </button>
      </div>

      <div className="main">
        <div className="sidebar">
          <h3>Library · {library.length}</h3>
          {library.map((m) => (
            <div
              key={m.id}
              className={`libitem${current?.id === m.id ? ' active' : ''}`}
              onClick={() => open(m)}
              title={m.title}
            >
              {m.title}
              <small>{m.dir === '.' ? m.ext.slice(1) : m.dir}{m.hasExternalSubs ? ' · subs' : ''}</small>
            </div>
          ))}
          {!library.length ? (
            <div className="dim" style={{ padding: '10px 14px', fontSize: 12 }}>
              Nothing found. Point <code>mediaDirs</code> in kotoba.config.json at your media folder and restart.
            </div>
          ) : null}
        </div>

        <div className="stage">
          {!current ? (
            <div className="empty">
              <div>
                Pick something from the library.<br />
                <span style={{ fontSize: 12 }}>
                  space play · <code>,</code>/<code>.</code> prev/next line · <code>r</code> replay line ·{' '}
                  <code>↑</code>/<code>↓</code> speed · <code>m</code> mute · <code>s</code> subtitles ·{' '}
                  <code>e</code> mine hovered word
                </span>
              </div>
            </div>
          ) : progress ? (
            <div className="empty">
              {progress.copyOnly ? 'Remuxing' : 'Transcoding'} for the browser…{' '}
              {Math.round((progress.progress ?? 0) * 100)}%
            </div>
          ) : playUrl ? (
            <Player
              url={playUrl}
              isVideo={current.isVideo}
              subs={subs}
              minedWords={minedWords}
              onMine={onMine}
              onError={(m) => say(m, true)}
            />
          ) : (
            <div className="empty">Opening…</div>
          )}
        </div>
      </div>

      {mining ? (
        <CardMaker
          ctx={mining}
          status={status}
          onClose={() => setMining(null)}
          onDone={onDone}
          onError={(m) => say(m, true)}
        />
      ) : null}

      {toast ? <div className={`toast${toast.err ? ' err' : ''}`}>{toast.text}</div> : null}
    </div>
  );
}
