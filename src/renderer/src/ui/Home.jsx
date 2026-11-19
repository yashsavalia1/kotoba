import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as lib from '../api/library.js';
import Icon from './icons.jsx';

const PLATFORM = window.kotoba?.platform;
const MOD = PLATFORM === 'darwin' ? '⌘' : 'Ctrl+';
const REVEAL = PLATFORM === 'darwin' ? 'Show in Finder' : PLATFORM === 'win32' ? 'Show in Explorer' : 'Open containing folder';
// The most slices a folder's line is cut into; past that, each slice is a few videos together.
const MAX_SLICES = 24;

function Status({ status }) {
  const items = [
    [status.dictReady, 'Dictionary', status.dictReady ? 'JMdict loaded' : 'run npm run dict'],
    [status.anki != null, 'Anki', status.anki != null ? `AnkiConnect v${status.anki}` : 'not running'],
    [status.llm, 'Claude', status.llm ? 'ready' : 'off'],
  ];
  return (
    <footer className="status-strip" aria-label="Status">
      {items.map(([ok, name, note]) => (
        <span key={name}><span className={`dot ${ok ? 'ok' : name === 'Claude' ? '' : 'bad'}`} />{name} <span className="faint">· {note}</span></span>
      ))}
      <span className="spacer" />
      <span>{status.corpusLines.toLocaleString()} lines watched</span>
    </footer>
  );
}

/** A folder's videos along the foot of its frame, a slice each, a group per season. */
function Slices({ groups }) {
  const per = Math.ceil(groups.reduce((n, g) => n + g.length, 0) / MAX_SLICES);
  const sliced = groups.map((g) =>
    Array.from({ length: Math.ceil(g.length / per) }, (_, i) => {
      const chunk = g.slice(i * per, (i + 1) * per);
      return chunk.reduce((a, b) => a + b, 0) / chunk.length;
    })
  );
  return (
    <span className="shade slices">
      {sliced.map((s, i) => (
        <span key={i} className="season" style={{ flexGrow: s.length }}>
          {s.map((v, j) => <i key={j}><b style={{ width: `${v * 100}%` }} /></i>)}
        </span>
      ))}
    </span>
  );
}

const Tick = () => (
  <span className="tick" data-testid="watched-tick" aria-label="Watched">
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.8 10.4 8.8 13.2 14.2 7.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </span>
);

function Card({ testid, thumb, glyph, badge, watched, progress, shares, title, subtitle, menuOpen, onOpen, onMenu }) {
  const [broken, setBroken] = useState(null);
  const showThumb = thumb && broken !== thumb;
  return (
    <button className={`lcard${menuOpen ? ' menu-open' : ''}`} data-testid={testid} title={title} onClick={onOpen} onContextMenu={onMenu}>
      <span className="frame">
        {showThumb ? <img src={thumb} alt="" loading="lazy" draggable={false} onError={() => setBroken(thumb)} /> : <span className="glyph">{glyph}</span>}
        {badge ? <span className="num">{badge}</span> : null}
        {watched ? <Tick /> : null}
        {shares ? <Slices groups={shares} /> : progress > 0 ? <span className="shade line"><i><b style={{ width: `${progress * 100}%` }} /></i></span> : null}
      </span>
      <span className="t">{title}</span>
      {subtitle ? <span className="m">{subtitle}</span> : null}
    </button>
  );
}

function ContextMenu({ at, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) });
    ref.current.querySelector('button')?.focus();
  }, [at]);
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && onClose();
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu ctx-menu" data-testid="context-menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it) => (
        <button key={it.label} className="opt" onClick={() => (onClose(), it.run())}>{it.label}</button>
      ))}
    </div>
  );
}

/** Grid columns as the browser lays them out, so Continue watching fills exactly one row. */
function useColumns() {
  const [el, setEl] = useState(null);
  const [n, setN] = useState(1);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setN(getComputedStyle(el).gridTemplateColumns.split(' ').length || 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, n];
}

const Label = ({ children }) => <h2 className="lib-label">{children}</h2>;

export default function Home({ status, settings, folder, onFolder, onChooseRoot, onSettings, onShortcuts, toast }) {
  const [listing, setListing] = useState(null);
  const [slide, setSlide] = useState('');
  const [menu, setMenu] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [gridRef, columns] = useColumns();
  const shown = useRef(null);

  // Names, counts and Continue watching are worked out in main from these settings.
  const { libraryRoot, tidyNames, episodeNumbers, continueWatching, showProgress } = settings;
  useEffect(() => {
    let live = true;
    lib
      .browse(folder)
      .then((l) => {
        if (!live) return;
        const prev = shown.current;
        // Deeper folders come in from the right, the way back from the left.
        setSlide(prev && l.dir && prev.dir !== l.dir ? (l.crumbs.length > prev.depth ? 'from-right' : 'from-left') : '');
        shown.current = { dir: l.dir, depth: l.crumbs?.length ?? 0 };
        setListing(l);
      })
      .catch((e) => (folder ? onFolder(null) : toast(e.message, true)));
    return () => {
      live = false;
    };
  }, [folder, libraryRoot, tidyNames, episodeNumbers, continueWatching, showProgress, nonce, onFolder, toast]);

  const refresh = () => setNonce((n) => n + 1);
  const act = (fn) => async () => {
    try {
      await fn();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const play = (path) =>
    act(async () => {
      if (!(await lib.openPaths([path]))?.length) toast('That file is missing.', true);
    })();
  const change = (fn, path) => act(async () => (await fn(path), refresh()));
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = (key, items) => (e) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    // A keyboard context menu has no pointer position: open it at the card.
    setMenu({ key, items, at: e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 12, y: r.top + 12 } });
  };

  const fileItems = (path) => [
    { label: REVEAL, run: act(() => lib.revealPath(path)) },
    { label: 'Copy path', run: act(async () => (await lib.copyPath(path), toast('Path copied'))) },
  ];
  const videoItems = (v, resume = false) => [
    ...(v.position > 0 ? [{ label: 'Play from the start', run: act(async () => (await lib.clearProgress(v.path), play(v.path))) }] : []),
    ...(!v.watched ? [{ label: 'Mark as watched', run: change(lib.markWatched, v.path) }] : []),
    ...(v.position > 0 || v.watched ? [{ label: 'Clear progress', run: change(lib.clearProgress, v.path) }] : []),
    ...(resume && v.folder ? [{ label: 'Go to folder', run: () => onFolder(v.folder === libraryRoot ? null : v.folder) }] : []),
    ...(resume ? [{ label: 'Remove from row', run: change(lib.forget, v.path) }] : []),
    ...fileItems(v.path),
  ];
  const folderItems = (f) => [
    { label: 'Mark all as watched', run: change(lib.markWatched, f.path) },
    { label: 'Clear progress', run: change(lib.clearProgress, f.path) },
    ...fileItems(f.path),
  ];

  // Each kind of mark can be turned off in settings, or all of them.
  const ticks = showProgress && settings.progressChecks;
  const lines = showProgress && settings.videoProgress;
  const slices = showProgress && settings.folderProgress;

  const resume = (listing?.resume ?? []).slice(0, Math.max(1, columns));
  const folders = listing?.folders ?? [];
  const videos = listing?.videos ?? [];
  // Labelled groups only when there are two kinds to tell apart, Continue watching among them.
  const labelled = [resume.length, folders.length, videos.length].filter(Boolean).length > 1;

  const resumeCards = resume.map((r) => (
    <Card
      key={`resume:${r.path}`}
      testid="resume-card"
      thumb={lib.thumbUrl(r.path, r.position)}
      glyph="♪"
      progress={lines ? r.progress : 0}
      title={r.title}
      subtitle={r.subtitle}
      menuOpen={menu?.key === `resume:${r.path}`}
      onOpen={() => play(r.path)}
      onMenu={openMenu(`resume:${r.path}`, videoItems(r, true))}
    />
  ));

  return (
    <div className="home" data-testid="home">
      <div className="titlebar">
        <div className="brand"><b>言葉</b>Kotoba</div>
        {listing?.crumbs ? (
          <nav className="crumbs" data-testid="crumbs" aria-label="Folders">
            {listing.crumbs.map((c, i) => (
              <React.Fragment key={c.path}>
                {i ? <span className="sep" aria-hidden="true">/</span> : null}
                <button className="crumb" aria-current={i === listing.crumbs.length - 1 ? 'page' : undefined} onClick={() => onFolder(i ? c.path : null)}>
                  {c.title}
                </button>
              </React.Fragment>
            ))}
          </nav>
        ) : null}
        <span className="spacer" />
        <button className="icon-btn" onClick={onShortcuts} aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)"><Icon name="keyboard" /></button>
        <button className="icon-btn" onClick={onSettings} aria-label={`Settings (${MOD},)`} title={`Settings (${MOD},)`}><Icon name="settings" /></button>
      </div>

      <main className="home-body">
        {!listing ? null : !listing.root ? (
          <div className="lib-page">
            {resumeCards.length ? (
              <div className="lib-grid" ref={gridRef}>
                <Label>Continue watching</Label>
                {resumeCards}
              </div>
            ) : null}
            <div className="empty-state">
              <h1>Your library</h1>
              <p>Pick the folder that holds your videos.</p>
              <button className="btn primary" onClick={onChooseRoot}>Choose folder</button>
              <p className="faint">
                Or drop a video anywhere, or press <kbd>{MOD}O</kbd>. Files stay where they are; nothing is copied.
              </p>
            </div>
          </div>
        ) : (
          <div key={listing.dir} className={`lib-page ${slide}`}>
            <header className="page-title">
              <h1 data-testid="page-title">{listing.title}</h1>
              {listing.detail ? <p>{listing.detail}</p> : null}
            </header>
            {!folders.length && !videos.length ? <p className="lib-empty">No videos here.</p> : null}
            <div className="lib-grid" ref={gridRef}>
              {resumeCards.length ? (
                <>
                  {labelled ? <Label>Continue watching</Label> : null}
                  {resumeCards}
                </>
              ) : null}
              {labelled && folders.length ? <Label>Folders</Label> : null}
              {folders.map((f) => (
                <Card
                  key={f.path}
                  testid="folder-card"
                  thumb={f.cover ? lib.thumbUrl(f.cover) : null}
                  glyph={<Icon name="folder" size={40} />}
                  watched={ticks && f.allWatched}
                  shares={slices && !f.allWatched && f.shares.some((g) => g.some((x) => x > 0)) ? f.shares : null}
                  title={f.title}
                  subtitle={f.subtitle}
                  menuOpen={menu?.key === f.path}
                  onOpen={() => onFolder(f.path)}
                  onMenu={openMenu(f.path, folderItems(f))}
                />
              ))}
              {labelled && videos.length ? <Label>Videos</Label> : null}
              {videos.map((v) => (
                <Card
                  key={v.path}
                  testid="video-card"
                  thumb={v.audio ? null : lib.thumbUrl(v.path)}
                  glyph={v.audio ? '♪' : null}
                  badge={v.badge}
                  watched={ticks && v.watched}
                  progress={lines ? v.progress : 0}
                  title={v.title}
                  menuOpen={menu?.key === v.path}
                  onOpen={() => play(v.path)}
                  onMenu={openMenu(v.path, videoItems(v))}
                />
              ))}
            </div>
          </div>
        )}
      </main>
      <Status status={status} />
      {menu ? <ContextMenu at={menu.at} items={menu.items} onClose={closeMenu} /> : null}
    </div>
  );
}
