import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as core from '../api/core.js';
import * as lib from '../api/library.js';
import { on, pathForFile } from '../api/ipc.js';
import Home from './Home.jsx';
import Player from './Player.jsx';
import CardMaker from './CardMaker.jsx';
import Settings from './Settings.jsx';
import Shortcuts from './Shortcuts.jsx';
import Icon from './icons.jsx';
import { isTyping } from './util.js';

const toggleFullscreen = () =>
  (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});

export default function App() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [library, setLibrary] = useState([]);
  const [media, setMedia] = useState(null);
  const [mining, setMining] = useState(null);
  const [modal, setModal] = useState(null);
  const [mined, setMined] = useState(() => new Set());
  const [toasts, setToasts] = useState([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [attached, setAttached] = useState(null);
  const dragDepth = useRef(0);

  const toast = useCallback((text, err = false) => {
    const id = Math.random();
    setToasts((t) => [...t.filter((x) => x.text !== text), { id, text, err }].slice(-4));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 8000 : 3500);
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await core.getStatus();
    setStatus(s);
    return s;
  }, []);
  const refreshLibrary = useCallback(() => lib.listMedia().then(setLibrary).catch((e) => toast(e.message, true)), [toast]);

  useEffect(() => {
    Promise.all([refreshStatus(), core.getSettings().then(setSettings)]).catch((e) => setBootError(e.message));
    refreshLibrary();
    core.minedWords().then((w) => setMined(new Set(w))).catch(() => {});
  }, [refreshStatus, refreshLibrary]);

  const saveSettings = useCallback(
    (patch) => {
      setSettings((s) => ({ ...s, ...patch }));
      core
        .setSettings(patch)
        .then((s) => {
          setSettings(s);
          if ('ankiConnect' in patch || 'deckName' in patch || 'ffmpegPath' in patch) refreshStatus().catch(() => {});
        })
        .catch((e) => toast(e.message, true));
    },
    [refreshStatus, toast]
  );

  const open = useCallback(
    async (id) => {
      try {
        const m = await lib.getMedia(id);
        if (!m) throw new Error('That file is no longer in the library.');
        if (!m.exists) {
          refreshLibrary();
          setMedia(null);
          throw new Error(`File is missing: ${m.path}`);
        }
        setMining(null);
        setAttached(null);
        setMedia(m);
        refreshLibrary();
      } catch (e) {
        toast(e.message, true);
      }
    },
    [refreshLibrary, toast]
  );

  const goHome = useCallback(() => {
    setMedia(null);
    refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    document.title = media ? `${media.title} · Kotoba` : 'Kotoba';
  }, [media]);

  useEffect(() => on('evt:open-media', ({ id }) => open(id)), [open]);

  const commands = useRef({});
  commands.current = {
    'open-settings': () => setModal('settings'),
    'show-shortcuts': () => setModal('shortcuts'),
    'show-library': goHome,
    'toggle-fullscreen': toggleFullscreen,
    close: () => (modal ? setModal(null) : mining ? setMining(null) : media ? goHome() : window.close()),
    'attach-subtitle': () => !media && toast('Open a video first, then add a subtitle file.', true),
  };
  useEffect(() => on('evt:command', (name) => commands.current[name]?.()), []);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || modal || mining) return;
      if (e.key === '?') {
        e.preventDefault();
        setModal('shortcuts');
      } else if (!media && e.key === 'f') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, mining, media]);

  // ------------------------------------------------------------ drag and drop

  useEffect(() => {
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const leave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const over = (e) => e.preventDefault();
    const drop = async (e) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean);
      if (!paths.length) return;
      try {
        const kinds = await lib.classify(paths);
        const subs = kinds.filter((k) => k.kind === 'subtitle');
        const mediaPaths = kinds.filter((k) => k.kind === 'media' || k.kind === 'folder').map((k) => k.path);
        if (subs.length && !mediaPaths.length) {
          if (!media) return toast('Open a video first, then drop its subtitle file.', true);
          let key = null;
          for (const s of subs) key = await lib.attachSubtitle(media.id, s.path);
          setAttached({ key, n: Date.now() });
          return;
        }
        if (mediaPaths.length) {
          const recs = await lib.openPaths(mediaPaths);
          if (!recs?.length) toast('Nothing playable in what was dropped.', true);
        } else toast('Kotoba plays video and audio files, or folders of them.', true);
      } catch (err) {
        toast(err.message, true);
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [media, toast]);

  // ------------------------------------------------------------ mining

  const onDone = ({ added, skipped }) => {
    setMining(null);
    if (added.length) {
      setMined((s) => new Set(s).add(mining.token.text).add(mining.token.lemma));
      toast(`Added ${added.length} card${added.length === 1 ? '' : 's'} to ${status.deckName}`);
      refreshStatus().catch(() => {});
    }
    if (skipped.length) toast(skipped.map((s) => `${s.type}: ${s.reason}`).join(' · '), true);
  };

  if (bootError) return <div className="boot">Kotoba could not start: {bootError}</div>;
  if (!status || !settings) return <div className="boot">Starting…</div>;

  const platform = window.kotoba?.platform === 'darwin' ? 'platform-mac' : 'platform-other';

  return (
    <div className={`${platform}${fullscreen ? ' fullscreen' : ''}`} style={{ height: '100%' }}>
      {media ? (
        <Player
          key={media.id}
          media={media}
          settings={settings}
          mined={mined}
          active={!modal && !mining}
          fullscreen={fullscreen}
          attached={attached}
          onMine={setMining}
          onOpenMedia={open}
          onHome={goHome}
          onSettings={saveSettings}
          onFullscreen={toggleFullscreen}
          toast={toast}
        />
      ) : (
        <Home
          library={library}
          status={status}
          onOpen={open}
          onRefresh={refreshLibrary}
          onSettings={() => setModal('settings')}
          onShortcuts={() => setModal('shortcuts')}
          toast={toast}
        />
      )}

      {mining ? (
        <CardMaker
          ctx={mining}
          status={status}
          covered={Boolean(modal)}
          onClose={() => setMining(null)}
          onDone={onDone}
          onError={(m) => toast(m, true)}
          onSettings={() => setModal('settings')}
        />
      ) : null}
      {modal === 'settings' ? (
        <Settings settings={settings} status={status} onSave={saveSettings} onStatus={refreshStatus} onClose={() => setModal(null)} toast={toast} />
      ) : null}
      {modal === 'shortcuts' ? <Shortcuts onClose={() => setModal(null)} /> : null}

      {dragging ? (
        <div className="dropzone" aria-hidden="true">
          <div>
            {media ? 'Drop a video to play it, or a subtitle file to add it' : 'Drop to play'}
            <small>Files stay where they are. Nothing is copied.</small>
          </div>
        </div>
      ) : null}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}`}>
            <span>{t.text}</span>
            <button className="icon-btn" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
