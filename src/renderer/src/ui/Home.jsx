import React from 'react';
import * as lib from '../api/library.js';
import Icon from './icons.jsx';
import { ago, fmt } from './util.js';

const MOD = window.kotoba?.platform === 'darwin' ? '⌘' : 'Ctrl+';
const pct = (m) => (m.duration ? Math.min(100, (100 * (m.position ?? 0)) / m.duration) : 0);
const inProgress = (m) => m.exists && m.position > 5 && (!m.duration || m.position < m.duration - 30);
const folderName = (f) => f.split(/[\\/]/).filter(Boolean).slice(-2).join('/');

function Status({ status }) {
  const items = [
    [status.dictReady, 'Dictionary', status.dictReady ? 'JMdict loaded' : 'run npm run dict'],
    [status.ffmpeg, 'ffmpeg', status.ffmpeg ? 'clips & embedded subs' : 'not found'],
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

export default function Home({ library, status, onOpen, onRefresh, onSettings, onShortcuts, toast }) {
  const act = (fn) => async (e) => {
    e?.stopPropagation();
    try {
      await fn();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const remove = (m) => act(async () => {
    await lib.removeMedia(m.id);
    onRefresh();
    toast(`Removed “${m.title}” from history. The file was not touched.`);
  });
  const locate = (m) => act(async () => {
    const r = await lib.locate(m.id);
    if (r) {
      onRefresh();
      onOpen(r.id ?? m.id);
    }
  });
  const reveal = (m) => act(() => lib.reveal(m.id));
  const open = (m) => (m.exists ? onOpen(m.id) : toast(`File is missing: ${m.path}${lib.locate ? '. Use Locate… to find it.' : ''}`, true));

  const continuing = library.filter(inProgress).slice(0, 6);

  return (
    <div className="home" data-testid="home">
      <div className="titlebar">
        <div className="brand"><b>言葉</b>Kotoba</div>
        <span className="spacer" />
        <button className="btn" onClick={act(lib.openMediaDialog)} title={`Open file (${MOD}O)`}><Icon name="file" size={16} />Open File…</button>
        <button className="btn" onClick={act(lib.openFolderDialog)} title={`Open folder (⇧${MOD}O)`}><Icon name="folder" size={16} />Open Folder…</button>
        <button className="icon-btn" onClick={onShortcuts} aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)"><Icon name="keyboard" /></button>
        <button className="icon-btn" onClick={onSettings} aria-label={`Settings (${MOD},)`} title={`Settings (${MOD},)`}><Icon name="settings" /></button>
      </div>

      <main className="home-body">
        {!library.length ? (
          <div className="empty-state">
            <div className="drop">
              <h1>Drop a video anywhere</h1>
              <p>
                Or press <kbd>{MOD}O</kbd> to open a file, <kbd>⇧{MOD}O</kbd> for a whole folder.
                <br />
                Kotoba plays files where they are. Nothing is moved, copied or imported; it just remembers the path and where you stopped.
              </p>
              <div className="row">
                <button className="btn primary" onClick={act(lib.openMediaDialog)}>Open File…</button>
                <button className="btn" onClick={act(lib.openFolderDialog)}>Open Folder…</button>
              </div>
            </div>
            <p className="faint" style={{ marginTop: 18 }}>
              Subtitles next to the video (<code>Episode 01.ja.srt</code>) and embedded text tracks are found automatically.
            </p>
          </div>
        ) : (
          <>
            {continuing.length ? (
              <section className="section" aria-labelledby="cw-h">
                <div className="section-h"><h2 id="cw-h">Continue watching</h2></div>
                <div className="continue">
                  {continuing.map((m) => (
                    <button key={m.id} className="ccard" onClick={() => onOpen(m.id)} title={m.path}>
                      <span className="t">{m.title}</span>
                      <span className="m">{fmt(m.position)} of {fmt(m.duration)} · {ago(m.lastOpenedAt)}</span>
                      <span className="bar"><i style={{ width: `${pct(m)}%` }} /></span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="section" aria-labelledby="rc-h">
              <div className="section-h"><h2 id="rc-h">Recent</h2><span className="faint">{library.length}</span></div>
              <table className="recents">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th className="col-folder">Folder</th>
                    <th>Last watched</th>
                    <th className="col-dur">Length</th>
                    <th><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {library.map((m) => (
                    <tr
                      key={m.id}
                      className={`item${m.exists ? '' : ' missing'}`}
                      tabIndex={0}
                      onClick={() => open(m)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open(m)}
                      title={m.path}
                      aria-label={`${m.title}${m.exists ? '' : ' (missing)'}`}
                    >
                      <td className="title">
                        {m.title}
                        {!m.exists ? <span className="badge missing">Missing</span> : null}
                      </td>
                      <td className="folder col-folder"><bdi>{folderName(m.folder)}</bdi></td>
                      <td className="num">
                        {m.duration && m.position > 5 ? <span className="minibar"><i style={{ width: `${pct(m)}%` }} /></span> : null}
                        {ago(m.lastOpenedAt)}
                      </td>
                      <td className="num col-dur">{m.duration ? fmt(m.duration) : '—'}</td>
                      <td className="acts">
                        <span className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                          {!m.exists && lib.locate ? (
                            <button className="btn small" onClick={locate(m)}><Icon name="locate" size={14} />Locate…</button>
                          ) : null}
                          {m.exists ? (
                            <button className="icon-btn" onClick={reveal(m)} aria-label="Show in Finder" title="Show in Finder"><Icon name="finder" size={16} /></button>
                          ) : null}
                          <button className="icon-btn" onClick={remove(m)} aria-label="Remove from history" title="Remove from history (file is kept)"><Icon name="trash" size={16} /></button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
      <Status status={status} />
    </div>
  );
}
