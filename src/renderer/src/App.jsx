import React, { useCallback, useEffect, useState } from 'react';
import Player from './Player.jsx';
import CardMaker from './CardMaker.jsx';
import * as core from './api/core.js';
import * as lib from './api/library.js';
import { playbackPlan } from './api/playback.js';
import { on, pathForFile } from './api/ipc.js';

function Pill({ ok, children, title }) {
  return <span className={`pill ${ok ? 'on' : 'off'}`} title={title}>{children}</span>;
}

const pickTrack = (tracks, prefs) =>
  tracks.find((t) => t.key === prefs.subTrack) ??
  tracks.find((t) => /\b(ja|jp|jpn|japanese)\b/i.test(`${t.label} ${t.language ?? ''}`)) ??
  tracks[0] ??
  null;

export default function App() {
  const [status, setStatus] = useState(null);
  const [library, setLibrary] = useState([]);
  const [current, setCurrent] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [trackKey, setTrackKey] = useState(null);
  const [subs, setSubs] = useState(null);
  const [plan, setPlan] = useState(null);
  const [mining, setMining] = useState(null);
  const [minedWords, setMinedWords] = useState(new Set());
  const [toast, setToast] = useState(null);

  const say = useCallback((text, err = false) => {
    setToast({ text, err });
    setTimeout(() => setToast(null), err ? 7000 : 3500);
  }, []);

  const refresh = useCallback(() => {
    core.getStatus().then(setStatus).catch((e) => say(e.message, true));
    lib.listMedia().then(setLibrary).catch((e) => say(e.message, true));
  }, [say]);

  useEffect(() => {
    refresh();
    core.minedWords().then((w) => setMinedWords(new Set(w))).catch(() => {});
  }, [refresh]);

  const open = useCallback(
    async (id) => {
      setPlan(null);
      setSubs(null);
      try {
        const media = await lib.getMedia(id);
        if (!media.exists) throw new Error(`File is missing: ${media.path}`);
        setCurrent(media);
        const ts = await lib.subtitleTracks(id);
        setTracks(ts);
        setTrackKey(pickTrack(ts, media.prefs)?.key ?? null);
        if (!ts.length) say('No text subtitles found. File › Add Subtitle File…', true);
        setPlan(await playbackPlan(id));
        refresh();
      } catch (e) {
        say(e.message, true);
      }
    },
    [refresh, say]
  );

  useEffect(() => {
    if (!current || !trackKey) return;
    let live = true;
    lib
      .loadSubtitles(current.id, trackKey)
      .then((s) => live && setSubs(s))
      .catch((e) => say(e.message, true));
    lib.setPrefs(current.id, { subTrack: trackKey }).catch(() => {});
    return () => {
      live = false;
    };
  }, [current, trackKey, say]);

  const attachSubtitle = useCallback(async () => {
    if (!current) return say('Open a file first.', true);
    const key = await lib.attachSubtitleDialog(current.id);
    if (!key) return;
    setTracks(await lib.subtitleTracks(current.id));
    setTrackKey(key);
  }, [current, say]);

  useEffect(() => on('evt:open-media', ({ id }) => open(id)), [open]);
  useEffect(
    () =>
      on('evt:command', (command) => {
        if (command === 'show-library') setCurrent(null);
        if (command === 'attach-subtitle') attachSubtitle();
      }),
    [attachSubtitle]
  );

  useEffect(() => {
    const over = (e) => e.preventDefault();
    const drop = async (e) => {
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean);
      const kinds = await lib.classify(paths);
      const subsDropped = kinds.filter((k) => k.kind === 'subtitle');
      if (subsDropped.length && current) {
        let key = null;
        for (const s of subsDropped) key = await lib.attachSubtitle(current.id, s.path);
        setTracks(await lib.subtitleTracks(current.id));
        setTrackKey(key);
      }
      const media = kinds.filter((k) => k.kind === 'media' || k.kind === 'folder').map((k) => k.path);
      if (media.length) await lib.openPaths(media);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [current]);

  const onMine = useCallback(
    (token, cueIndex) => {
      if (!subs || cueIndex == null || cueIndex < 0) return;
      setMining({ mediaId: current.id, cue: subs.cues[cueIndex], cueIndex, token, translation: '' });
    },
    [subs, current]
  );

  const onDone = ({ added, skipped }) => {
    const word = mining.token.lemma;
    setMining(null);
    if (added.length) {
      setMinedWords((s) => new Set(s).add(word));
      say(`Added ${added.length} card${added.length === 1 ? '' : 's'}: ${added.map((a) => a.type).join(', ')}`);
    }
    if (skipped.length) say(skipped.map((s) => `${s.type}: ${s.reason}`).join(' · '), true);
  };

  const onProgress = useCallback(
    (t, d) => current && lib.setPosition(current.id, t, d).catch(() => {}),
    [current]
  );

  if (!status) return <div className="empty">Starting…</div>;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">言葉<span>.</span></div>
        <Pill ok={status.dictReady} title="JMdict">dictionary</Pill>
        <Pill ok={status.ffmpeg} title="clip extraction">ffmpeg</Pill>
        <Pill ok={status.anki != null} title="AnkiConnect">{status.anki != null ? `anki v${status.anki}` : 'anki offline'}</Pill>
        <Pill ok={status.llm} title="Contrast / Situation / Naturalness cards">claude</Pill>
        <span className="pill">{status.corpusLines.toLocaleString()} lines mined</span>
        <span className="spacer" />
        {tracks.length > 1 ? (
          <select value={trackKey ?? ''} onChange={(e) => setTrackKey(e.target.value)}>
            {tracks.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        ) : null}
        <button onClick={() => lib.openMediaDialog()}>Open…</button>
        <button onClick={() => core.ankiSetup().then(() => say('Note types installed.')).catch((e) => say(e.message, true))}>
          Install note types
        </button>
      </div>

      <div className="main">
        <div className="sidebar">
          <h3>Recent · {library.length}</h3>
          {library.map((m) => (
            <div
              key={m.id}
              className={`libitem${current?.id === m.id ? ' active' : ''}${m.exists ? '' : ' missing'}`}
              onClick={() => open(m.id)}
              title={m.path}
            >
              {m.title}
              <small>{m.exists ? m.folder.split('/').pop() : 'missing'}{m.duration ? ` · ${Math.round((100 * m.position) / m.duration)}%` : ''}</small>
            </div>
          ))}
          {!library.length ? (
            <div className="dim" style={{ padding: '10px 14px', fontSize: 12 }}>
              Open a file (⌘O) or drop one anywhere. Files stay where they are.
            </div>
          ) : null}
        </div>

        <div className="stage">
          {!current ? (
            <div className="empty">
              <div>
                Drop a video here, or press ⌘O.<br />
                <span style={{ fontSize: 12 }}>Files are never moved or copied — Kotoba remembers where they live.</span>
              </div>
            </div>
          ) : plan ? (
            <Player
              key={current.id}
              url={plan.url}
              isVideo={Boolean(plan.video)}
              subs={subs}
              minedWords={minedWords}
              onMine={onMine}
              onError={(m) => say(m, true)}
              startAt={current.position}
              onProgress={onProgress}
            />
          ) : (
            <div className="empty">Opening…</div>
          )}
        </div>
      </div>

      {mining ? (
        <CardMaker ctx={mining} status={status} onClose={() => setMining(null)} onDone={onDone} onError={(m) => say(m, true)} />
      ) : null}
      {toast ? <div className={`toast${toast.err ? ' err' : ''}`}>{toast.text}</div> : null}
    </div>
  );
}
