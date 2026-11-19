import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as lib from '../api/library.js';
import { playbackPlan } from '../api/playback.js';
import { on } from '../api/ipc.js';
import Subtitles from './Subtitles.jsx';
import Icon from './icons.jsx';
import { cueAt, cueBefore, fmt, isTyping, overlapText, pickPrimary, pickReference, store } from './util.js';

const SPEEDS = [0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3];
const IDLE_MS = 2500;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function Seek({ time, duration, buffered, chapters, onSeek }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const [drag, setDrag] = useState(null);
  const at = (e) => {
    const r = ref.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * (duration || 0);
  };
  const shown = drag ?? time;
  const pct = (t) => `${duration ? (100 * t) / duration : 0}%`;
  const chapterAt = (t) => chapters.findLast?.((c) => c.start <= t)?.title;

  return (
    <div
      ref={ref}
      className={`seek${drag != null ? ' drag' : ''}`}
      role="slider"
      tabIndex={-1}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration || 0)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${fmt(time)} of ${fmt(duration)}`}
      onPointerMove={(e) => {
        const t = at(e);
        setHover({ t, x: e.clientX - ref.current.getBoundingClientRect().left });
        if (drag != null) setDrag(t);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e));
      }}
      onPointerUp={(e) => {
        if (drag == null) return;
        onSeek(at(e));
        setDrag(null);
      }}
    >
      <div className="track">
        {buffered.map(([a, b], i) => (
          <div key={i} className="buf" style={{ left: pct(a), width: pct(b - a) }} />
        ))}
        <div className="fill" style={{ width: pct(shown) }} />
        {chapters.filter((c) => c.start > 0).map((c, i) => (
          <div key={i} className="tick" style={{ left: pct(c.start) }} />
        ))}
        <div className="knob" style={{ left: pct(shown) }} />
      </div>
      {hover && duration ? (
        <div className="tip" style={{ left: clamp(hover.x, 30, (ref.current?.clientWidth ?? 0) - 30) }}>
          {fmt(drag ?? hover.t)}
          {chapters.length ? <small>{chapterAt(drag ?? hover.t)}</small> : null}
        </div>
      ) : null}
    </div>
  );
}

function Pop({ id, open, setOpen, label, children, button }) {
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !wrap.current?.contains(e.target) && setOpen(null);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open, setOpen]);
  return (
    <div className="menu-wrap" ref={wrap}>
      {button({ 'aria-label': label, title: label, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(open ? null : id) })}
      {open ? (
        <div className="menu" role="menu" aria-label={label}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

const Opt = ({ checked, onClick, children, hint }) => (
  <button className="opt" role="menuitemradio" aria-checked={checked} onClick={onClick}>
    <span className="chk">{checked ? '✓' : ''}</span>
    <span>{children}</span>
    {hint ? <small>{hint}</small> : null}
  </button>
);

function Stepper({ label, value, onMinus, onPlus, onReset }) {
  return (
    <div className="line">
      <span className="lbl">{label}</span>
      <span className="stepper">
        <button onClick={onMinus} aria-label={`Decrease ${label}`}>−</button>
        <span onDoubleClick={onReset} title="Double-click to reset">{value}</span>
        <button onClick={onPlus} aria-label={`Increase ${label}`}>+</button>
      </span>
    </div>
  );
}

function Transcript({ cues, index, delay, onSeek, onClose }) {
  const [q, setQ] = useState('');
  const list = useRef(null);
  const ql = q.trim().toLowerCase();
  const rows = useMemo(
    () => cues.map((c, i) => [c, i]).filter(([c]) => !ql || c.text.toLowerCase().includes(ql)),
    [cues, ql]
  );
  useEffect(() => {
    if (ql) return;
    list.current?.querySelector('.cue.active')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [index, ql]);
  const mark = (text) => {
    if (!ql) return text;
    const i = text.toLowerCase().indexOf(ql);
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + ql.length)}</mark>
        {text.slice(i + ql.length)}
      </>
    );
  };
  return (
    <aside className="drawer" data-testid="transcript" aria-label="Transcript">
      <header>
        <h3>Transcript</h3>
        <span className="faint">{cues.length} lines</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close transcript"><Icon name="close" size={16} /></button>
      </header>
      <div className="search">
        <input type="search" placeholder="Filter lines…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter transcript" onKeyDown={(e) => e.key === 'Escape' && (q ? setQ('') : e.currentTarget.blur())} />
      </div>
      <div className="list" ref={list}>
        {rows.map(([c, i]) => (
          <button key={i} className={`cue${i === index ? ' active' : ''}`} onClick={() => onSeek(c.start + delay + 0.01)}>
            <span className="t">{fmt(c.start + delay)}</span>
            <span className="tx jp">{mark(c.text)}</span>
          </button>
        ))}
        {!cues.length ? <p className="faint" style={{ padding: '0 14px' }}>No subtitles loaded.</p> : null}
        {cues.length && !rows.length ? <p className="faint" style={{ padding: '0 14px' }}>No lines match.</p> : null}
      </div>
    </aside>
  );
}

function Playlist({ items, onOpen, onClose }) {
  const list = useRef(null);
  useEffect(() => {
    list.current?.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }, [items]);
  return (
    <aside className="drawer" data-testid="playlist" aria-label="Playlist">
      <header>
        <h3>Playlist</h3>
        <span className="faint">{items.length} in folder</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close playlist"><Icon name="close" size={16} /></button>
      </header>
      <div className="list" ref={list}>
        {items.map((s, i) => (
          <button key={s.path} className={`pl-item${s.current ? ' current' : ''}`} onClick={() => !s.current && onOpen(s.path)} title={s.path} aria-current={s.current || undefined}>
            <span className="n">{i + 1}</span>
            <span className="nm">{s.title}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export default function Player({ media, settings, mined, active, fullscreen, attached, onMine, onOpenMedia, onHome, onSettings, onFullscreen, toast }) {
  const video = useRef(null);
  const prefs = media.prefs ?? {};
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [primaryKey, setPrimaryKey] = useState(null);
  const [refKey, setRefKey] = useState(null);
  const [subs, setSubs] = useState(null);
  const [refSubs, setRefSubs] = useState(null);
  const [showSubs, setShowSubs] = useState(true);
  const [peeking, setPeeking] = useState(false);
  const [delayMs, setDelayMs] = useState(prefs.subDelayMs ?? 0);
  const [rate, setRate] = useState(prefs.rate ?? 1);
  const [volume, setVolume] = useState(() => store.get('volume', 1));
  const [muted, setMuted] = useState(() => store.get('muted', false));
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(media.position ?? 0);
  const [duration, setDuration] = useState(media.duration ?? 0);
  const [buffered, setBuffered] = useState([]);
  const [cueIndex, setCueIndex] = useState(-1);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState(null);
  const [drawer, setDrawer] = useState(() => store.get('drawer', null));
  const [siblings, setSiblings] = useState([]);
  const [osd, setOsd] = useState(null);
  const [flash, setFlash] = useState(null);
  const [resumed, setResumed] = useState(null);
  const [showRemaining, setShowRemaining] = useState(false);
  const hovered = useRef(null);
  const resumeAfterHover = useRef(false);
  const didStart = useRef(false);
  const osdTimer = useRef(null);
  const idleTimer = useRef(null);
  const overChrome = useRef(false);

  const cues = subs?.cues ?? [];
  const refCues = refSubs?.cues ?? [];
  const delay = delayMs / 1000;
  const fontSize = settings.subtitleFontSize ?? 30;

  const say = useCallback((text) => {
    clearTimeout(osdTimer.current);
    setOsd(text);
    osdTimer.current = setTimeout(() => setOsd(null), 1300);
  }, []);
  const savePrefs = useCallback((patch) => lib.setPrefs(media.id, patch).catch(() => {}), [media.id]);

  // ------------------------------------------------------------ loading

  useEffect(() => {
    let live = true;
    playbackPlan(media.id)
      .then((p) => {
        if (!live) return;
        setPlan(p);
        if (p.duration) setDuration(p.duration);
        if (p.unsupported && (p.video || p.audio)) toast(`${p.unsupported}.`, true);
      })
      .catch((e) => toast(e.message, true));
    lib
      .subtitleTracks(media.id)
      .then((ts) => {
        if (!live) return;
        setTracks(ts);
        const primary = pickPrimary(ts, prefs);
        setPrimaryKey(prefs.subTrack === null ? null : primary?.key ?? null);
        setRefKey(pickReference(ts, prefs, primary?.key)?.key ?? null);
        if (!ts.length) toast('No text subtitles found. Drop a subtitle file on the window, or File › Add Subtitle File…', true);
      })
      .catch((e) => toast(e.message, true));
    lib.siblings(media.id).then((s) => live && setSiblings(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [media.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSubs(null);
    if (!primaryKey) return;
    let live = true;
    lib.loadSubtitles(media.id, primaryKey).then((s) => live && setSubs(s)).catch((e) => toast(e.message, true));
    return () => {
      live = false;
    };
  }, [media.id, primaryKey, toast]);

  useEffect(() => {
    setRefSubs(null);
    if (!refKey) return;
    let live = true;
    lib.loadSubtitles(media.id, refKey).then((s) => live && setRefSubs(s)).catch((e) => toast(e.message, true));
    return () => {
      live = false;
    };
  }, [media.id, refKey, toast]);

  useEffect(() => {
    if (!attached) return;
    lib
      .subtitleTracks(media.id)
      .then((ts) => {
        setTracks(ts);
        choosePrimary(attached.key);
      })
      .catch((e) => toast(e.message, true));
  }, [attached]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ clock

  // Cue sync needs finer granularity than `timeupdate` (~4 Hz), so cue indexes are
  // recomputed per frame; the seek bar reads a coarser 5 Hz clock.
  useEffect(() => {
    let raf;
    let last = -1;
    const tick = () => {
      const el = video.current;
      if (el) {
        const t = el.currentTime;
        const ci = cueAt(cues, t - delay);
        setCueIndex((p) => (p === ci ? p : ci));
        if (Math.abs(t - last) > 0.2) {
          last = t;
          setTime(t);
          const b = el.buffered;
          const ranges = [];
          for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)]);
          setBuffered((p) => (p.length === ranges.length && p.every((r, i) => r[0] === ranges[i][0] && r[1] === ranges[i][1]) ? p : ranges));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cues, delay]);

  const saveProgress = useCallback(() => {
    const el = video.current;
    if (el && didStart.current && Number.isFinite(el.duration)) lib.setPosition(media.id, el.currentTime, el.duration).catch(() => {});
  }, [media.id]);

  // A layout cleanup runs before React detaches the video ref, so leaving the player still saves.
  useLayoutEffect(() => {
    const t = setInterval(() => !video.current?.paused && saveProgress(), 5000);
    return () => {
      clearInterval(t);
      saveProgress();
    };
  }, [saveProgress]);

  // ------------------------------------------------------------ element state

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    store.set('volume', volume);
    store.set('muted', muted);
  }, [volume, muted, plan]);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.playbackRate = rate;
    el.defaultPlaybackRate = rate;
  }, [rate, plan]);

  useEffect(() => store.set('drawer', drawer), [drawer]);

  // ------------------------------------------------------------ actions

  const seek = useCallback((t) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = clamp(t, 0, Number.isFinite(el.duration) ? el.duration - 0.05 : t);
    setTime(el.currentTime);
  }, []);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch((e) => toast(e.message, true));
    else el.pause();
    setFlash({ icon: el.paused ? 'pause' : 'play', k: Date.now() });
  }, [toast]);

  const jumpCue = useCallback(
    (dir) => {
      if (!cues.length) return say('No subtitles');
      const t = (video.current?.currentTime ?? 0) - delay;
      const base = cueIndex >= 0 ? cueIndex : cueBefore(cues, t) + (dir < 0 ? 1 : 0);
      const next = clamp(base + dir, 0, cues.length - 1);
      seek(cues[next].start + delay + 0.01);
    },
    [cues, cueIndex, delay, seek, say]
  );

  const replayCue = useCallback(() => {
    const i = cueIndex >= 0 ? cueIndex : cueBefore(cues, (video.current?.currentTime ?? 0) - delay);
    if (i < 0) return;
    seek(cues[i].start + delay + 0.01);
    video.current?.play().catch(() => {});
  }, [cueIndex, cues, delay, seek]);

  const changeRate = useCallback(
    (next) => {
      const r = clamp(Math.round(next * 100) / 100, 0.25, 4);
      setRate(r);
      savePrefs({ rate: r });
      say(`Speed ${r.toFixed(2)}×`);
    },
    [savePrefs, say]
  );
  const bumpRate = (dir) => {
    const next = dir > 0 ? SPEEDS.find((s) => s > rate + 0.001) : SPEEDS.findLast((s) => s < rate - 0.001);
    changeRate(next ?? rate);
  };

  const changeDelay = useCallback(
    (ms) => {
      setDelayMs(ms);
      savePrefs({ subDelayMs: ms });
      say(`Subtitle delay ${ms > 0 ? '+' : ''}${ms} ms`);
    },
    [savePrefs, say]
  );

  const changeVolume = (v) => {
    const next = clamp(Math.round(v * 100) / 100, 0, 1);
    setVolume(next);
    setMuted(false);
    say(`Volume ${Math.round(next * 100)}%`);
  };
  const toggleMute = () => {
    setMuted((m) => !m);
    say(muted ? `Volume ${Math.round(volume * 100)}%` : 'Muted');
  };

  const choosePrimary = (key) => {
    setPrimaryKey(key);
    savePrefs({ subTrack: key });
    setShowSubs(true);
    say(key ? `Subtitles: ${tracks.find((t) => t.key === key)?.label}` : 'Subtitles off');
  };
  const chooseRef = (key) => {
    setRefKey(key);
    savePrefs({ refTrack: key });
    say(key ? `Translation: ${tracks.find((t) => t.key === key)?.label}` : 'Translation off');
  };
  const cycle = (list, cur, pick) => {
    if (!list.length) return say('No other tracks');
    pick(list[(list.indexOf(cur) + 1) % list.length]);
  };

  const changeFont = (d) => {
    const next = clamp(fontSize + d, 14, 72);
    onSettings({ subtitleFontSize: next });
    say(`Subtitle size ${next}`);
  };

  const openFile = useCallback(
    async (dir) => {
      try {
        let id = null;
        if (lib.adjacent) id = (await lib.adjacent(media.id, dir))?.id ?? null;
        else {
          const i = siblings.findIndex((s) => s.current);
          const s = i >= 0 ? siblings[i + dir] : null;
          if (s) id = (await lib.openSibling(s.path)).id;
        }
        if (id == null) return say(dir > 0 ? 'Last file in folder' : 'First file in folder');
        saveProgress();
        onOpenMedia(id);
      } catch (e) {
        toast(e.message, true);
      }
    },
    [media.id, siblings, onOpenMedia, saveProgress, say, toast]
  );

  const attachSubtitle = useCallback(async () => {
    try {
      const key = await lib.attachSubtitleDialog(media.id);
      if (!key) return;
      setTracks(await lib.subtitleTracks(media.id));
      choosePrimary(key);
    } catch (e) {
      toast(e.message, true);
    }
  }, [media.id, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mining always pauses: the card is built against the cue on screen, and letting
  // playback run on while the dialog is open would mine a different line.
  const mine = useCallback(
    (token) => {
      const el = video.current;
      el?.pause();
      const i = cueIndex >= 0 ? cueIndex : cueAt(cues, (el?.currentTime ?? 0) - delay);
      if (i < 0) return;
      const c = cues[i];
      onMine({
        mediaId: media.id,
        mediaTitle: media.title,
        cue: { start: c.start + delay, end: c.end + delay, text: c.text },
        cueIndex: i,
        token,
        translation: overlapText(refCues, c.start, c.end),
      });
    },
    [cueIndex, cues, delay, refCues, media.id, media.title, onMine]
  );

  const onHover = useCallback(
    (token) => {
      hovered.current = token;
      if (!settings.pauseOnHover) return;
      const el = video.current;
      if (!el) return;
      if (token && !el.paused) {
        resumeAfterHover.current = true;
        el.pause();
      } else if (!token && resumeAfterHover.current) {
        resumeAfterHover.current = false;
        el.play().catch(() => {});
      }
    },
    [settings.pauseOnHover]
  );

  const toggleDrawer = (name) => setDrawer((d) => (d === name ? null : name));

  // One live table of actions so the key and command listeners never go stale.
  const act = useRef({});
  act.current = {
    'toggle-play': toggle,
    'prev-line': () => jumpCue(-1),
    'next-line': () => jumpCue(1),
    'replay-line': replayCue,
    'prev-file': () => openFile(-1),
    'next-file': () => openFile(1),
    'speed-up': () => bumpRate(1),
    'speed-down': () => bumpRate(-1),
    'speed-reset': () => changeRate(1),
    'delay-up': () => changeDelay(delayMs + 100),
    'delay-down': () => changeDelay(delayMs - 100),
    'delay-reset': () => changeDelay(0),
    'volume-up': () => changeVolume(volume + 0.05),
    'volume-down': () => changeVolume(volume - 0.05),
    mute: toggleMute,
    'toggle-subs': () => {
      setShowSubs((v) => !v);
      say(showSubs ? 'Subtitles hidden' : 'Subtitles shown');
    },
    'cycle-subs': () => cycle(tracks.map((t) => t.key), primaryKey, choosePrimary),
    'toggle-transcript': () => toggleDrawer('transcript'),
    'toggle-playlist': () => toggleDrawer('playlist'),
    'attach-subtitle': attachSubtitle,
    'mine-hovered': () => hovered.current && mine(hovered.current),
    'font-up': () => changeFont(2),
    'font-down': () => changeFont(-2),
  };

  useEffect(
    () =>
      on('evt:command', (name) => {
        act.current[name]?.();
      }),
    []
  );

  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      const t = video.current?.currentTime ?? 0;
      const a = act.current;
      const keys = {
        ' ': a['toggle-play'],
        k: a['toggle-play'],
        ArrowLeft: () => seek(t - (e.shiftKey ? 1 : e.altKey ? 30 : 5)),
        ArrowRight: () => seek(t + (e.shiftKey ? 1 : e.altKey ? 30 : 5)),
        j: () => seek(t - 10),
        l: () => seek(t + 10),
        ArrowUp: a['volume-up'],
        ArrowDown: a['volume-down'],
        m: a.mute,
        '[': a['speed-down'],
        ']': a['speed-up'],
        '=': a['speed-reset'],
        Backspace: a['speed-reset'],
        ',': a['prev-line'],
        '.': a['next-line'],
        r: a['replay-line'],
        g: a['delay-down'],
        h: a['delay-up'],
        s: a['toggle-subs'],
        i: () => setPeeking(true),
        I: () => setPeeking(true),
        v: a['cycle-subs'],
        t: a['toggle-transcript'],
        p: a['toggle-playlist'],
        '<': a['prev-file'],
        '>': a['next-file'],
        e: a['mine-hovered'],
        '-': a['font-down'],
        '+': a['font-up'],
        f: onFullscreen,
        Escape: () => (menu ? setMenu(null) : fullscreen ? onFullscreen() : drawer ? setDrawer(null) : null),
      };
      let fn = keys[e.key];
      if (!fn && /^[0-9]$/.test(e.key) && duration) fn = () => seek((duration * Number(e.key)) / 10);
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, seek, duration, menu, drawer, fullscreen, onFullscreen]);

  // Peek is held, not toggled: any release of I ends it, as does losing focus.
  useEffect(() => {
    const up = (e) => e.key?.toLowerCase() === 'i' && setPeeking(false);
    const off = () => setPeeking(false);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', off);
    };
  }, []);

  // ------------------------------------------------------------ idle chrome

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (!overChrome.current && !hovered.current) setIdle(true);
    }, IDLE_MS);
  }, []);
  useEffect(() => () => clearTimeout(idleTimer.current), []);
  useEffect(() => {
    if (playing) wake();
  }, [playing, wake]);
  const chromeHidden = idle && playing && !menu;

  // ------------------------------------------------------------ render

  const tokens = showSubs && cueIndex >= 0 ? subs?.tokens?.[cueIndex] : null;
  const cue = showSubs && cueIndex >= 0 ? cues[cueIndex] : null;
  // Every translation cue overlapping the line on screen by more than 0.1 s (Mizune's rule).
  const peekText = !cue
    ? null
    : !refKey
      ? 'No translation track. Pick one under Subtitles.'
      : refCues.filter((r) => r.start < cue.end - 0.1 && r.end > cue.start + 0.1).map((r) => r.text).join('\n') || 'Nothing here in the translation.';
  const chapters = plan?.chapters ?? [];
  // Whatever part of a file Chromium plays still plays; only a file it plays nothing of fails.
  const failure = error ?? (plan?.unsupported && !plan.video && !plan.audio ? plan.unsupported : null);
  const sibIndex = siblings.findIndex((s) => s.current);
  const hasPrevFile = lib.adjacent ? true : sibIndex > 0;
  const hasNextFile = lib.adjacent ? true : sibIndex >= 0 && sibIndex < siblings.length - 1;
  const chromeEvents = { onMouseEnter: () => (overChrome.current = true), onMouseLeave: () => (overChrome.current = false) };

  return (
    <div className={`player${chromeHidden ? ' idle' : ''}`} data-testid="player" onMouseMove={wake}>
      <div className="stage">
        {plan && !failure ? (
          <video
            ref={video}
            src={plan.url}
            // Without CORS, Web Audio taps and canvas reads of kotoba://media come back silent/tainted.
            crossOrigin="anonymous"
            autoPlay
            muted={muted}
            onLoadedData={() => setLoading(false)}
            onError={(e) => setError(e.currentTarget.error?.message || 'The player refused this file.')}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              saveProgress();
            }}
            onWaiting={() => setLoading(true)}
            onPlaying={() => setLoading(false)}
            onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              el.volume = volume;
              el.playbackRate = rate;
              if (didStart.current) return;
              didStart.current = true;
              const pos = media.position ?? 0;
              const dur = el.duration || plan.duration || 0;
              if (settings.resumePlayback && pos > 5 && pos < dur - 15) {
                el.currentTime = pos;
                setResumed(pos);
                setTimeout(() => setResumed(null), 7000);
              }
            }}
            onEnded={() => {
              saveProgress();
              if (settings.autoplayNext && hasNextFile) openFile(1);
            }}
            onClick={toggle}
            onDoubleClick={onFullscreen}
            style={plan.video ? undefined : { opacity: 0 }}
          />
        ) : null}
        {failure ? (
          <div className="unplayable" role="alert" data-testid="unplayable">
            <b>Kotoba can't play this file</b>
            {failure}
          </div>
        ) : plan && !plan.video ? (
          <div className="audio-art">♪</div>
        ) : null}
        {!failure && (!plan || loading) ? <div className="spinner" role="status" aria-label="Loading" /> : null}
        {flash ? (
          <div className="center-flash" key={flash.k}>
            <span><Icon name={flash.icon} size={34} /></span>
          </div>
        ) : null}

        <Subtitles tokens={tokens} peeking={peeking} peekText={peekText} onPeek={setPeeking} fontSize={fontSize} mined={mined} onMine={mine} onHover={onHover} />

        {osd ? <div className="osd" role="status">{osd}</div> : null}
        {resumed != null ? (
          <div className="resume" role="status">
            <span>Resumed at {fmt(resumed)}</span>
            <button
              className="btn small"
              onClick={() => {
                seek(0);
                setResumed(null);
              }}
            >
              Start over
            </button>
            <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => setResumed(null)} aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}

        <div className="chrome top" {...chromeEvents}>
          <div className="titlebar">
            <button className="icon-btn" onClick={onHome} aria-label="Back to library (⌘L)" title="Library (⌘L)">
              <Icon name="back" />
            </button>
            <div className="ttl" title={media.path}>
              {media.title}
            </div>
            <span className="spacer" />
            <button className={`icon-btn${drawer === 'transcript' ? ' on' : ''}`} onClick={() => toggleDrawer('transcript')} aria-label="Transcript (T)" title="Transcript (T)" aria-pressed={drawer === 'transcript'}>
              <Icon name="transcript" />
            </button>
            <button className={`icon-btn${drawer === 'playlist' ? ' on' : ''}`} onClick={() => toggleDrawer('playlist')} aria-label="Playlist (P)" title="Playlist (P)" aria-pressed={drawer === 'playlist'}>
              <Icon name="playlist" />
            </button>
          </div>
        </div>

        <div className="chrome bottom" {...chromeEvents}>
          <Seek time={time} duration={duration} buffered={buffered} chapters={chapters} onSeek={seek} />
          <div className="bar">
            <button className="icon-btn" onClick={toggle} aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
              <Icon name={playing ? 'pause' : 'play'} size={24} />
            </button>
            <button className="icon-btn" onClick={() => jumpCue(-1)} aria-label="Previous line (,)" title="Previous line (,)" disabled={!cues.length}><Icon name="prevLine" /></button>
            <button className="icon-btn" onClick={replayCue} aria-label="Replay line (R)" title="Replay line (R)" disabled={!cues.length}><Icon name="replay" /></button>
            <button className="icon-btn" onClick={() => jumpCue(1)} aria-label="Next line (.)" title="Next line (.)" disabled={!cues.length}><Icon name="nextLine" /></button>
            <span className="sep hide-narrow" />
            <button className="icon-btn hide-narrow" onClick={() => openFile(-1)} disabled={!hasPrevFile} aria-label="Previous file (<)" title="Previous file (<)"><Icon name="prevFile" /></button>
            <button className="icon-btn hide-narrow" onClick={() => openFile(1)} disabled={!hasNextFile} aria-label="Next file (>)" title="Next file (>)"><Icon name="nextFile" /></button>
            <span className="sep" />
            <button className="icon-btn" onClick={toggleMute} aria-label={muted ? 'Unmute (M)' : 'Mute (M)'} title="Mute (M)">
              <Icon name={muted || volume === 0 ? 'muted' : 'volume'} />
            </button>
            <input className="vol hide-narrow" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(e) => changeVolume(Number(e.target.value))} aria-label="Volume" />
            <button className="time" onClick={() => setShowRemaining((v) => !v)} title="Toggle remaining time">
              <b>{fmt(time)}</b> / {showRemaining ? `-${fmt(duration - time)}` : fmt(duration)}
            </button>
            <span className="spacer" />

            <Pop id="speed" open={menu === 'speed'} setOpen={setMenu} label="Playback speed ([ ])" button={(p) => <button className="rate-btn" {...p}>{+rate.toFixed(2)}×</button>}>
              <h4>Speed</h4>
              {SPEEDS.map((s) => (
                <Opt key={s} checked={Math.abs(s - rate) < 0.001} onClick={() => changeRate(s)}>{s}×</Opt>
              ))}
            </Pop>

            <Pop id="subs" open={menu === 'subs'} setOpen={setMenu} label="Subtitles (V)" button={(p) => <button className={`icon-btn${showSubs && primaryKey ? '' : ' off'}`} {...p}><Icon name="subs" /></button>}>
              <h4>Subtitles</h4>
              <Opt checked={!primaryKey} onClick={() => choosePrimary(null)}>Off</Opt>
              {tracks.map((t) => (
                <Opt key={t.key} checked={t.key === primaryKey} onClick={() => choosePrimary(t.key)} hint={t.source}>{t.label}</Opt>
              ))}
              <hr />
              <h4>Translation (hold I to peek; fills card translations)</h4>
              <Opt checked={!refKey} onClick={() => chooseRef(null)}>None</Opt>
              {tracks.filter((t) => t.key !== primaryKey).map((t) => (
                <Opt key={t.key} checked={t.key === refKey} onClick={() => chooseRef(t.key)} hint={t.source}>{t.label}</Opt>
              ))}
              <hr />
              <Stepper label="Delay" value={`${delayMs > 0 ? '+' : ''}${delayMs} ms`} onMinus={() => changeDelay(delayMs - 100)} onPlus={() => changeDelay(delayMs + 100)} onReset={() => changeDelay(0)} />
              <Stepper label="Size" value={`${fontSize}px`} onMinus={() => changeFont(-2)} onPlus={() => changeFont(2)} onReset={() => onSettings({ subtitleFontSize: 30 })} />
              <label className="line">
                <input type="checkbox" checked={!!settings.pauseOnHover} onChange={(e) => onSettings({ pauseOnHover: e.target.checked })} />
                <span className="lbl">Pause while hovering a word</span>
              </label>
              <hr />
              <button className="opt" onClick={() => { setMenu(null); attachSubtitle(); }}>
                <span className="chk" />
                Add subtitle file…
              </button>
            </Pop>

            <button className="icon-btn" onClick={onFullscreen} aria-label={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} title="Fullscreen (F)">
              <Icon name={fullscreen ? 'exitFullscreen' : 'fullscreen'} />
            </button>
          </div>
        </div>
      </div>

      {drawer === 'transcript' ? (
        <Transcript cues={cues} index={cueIndex} delay={delay} onSeek={seek} onClose={() => setDrawer(null)} />
      ) : drawer === 'playlist' ? (
        <Playlist
          items={siblings}
          onOpen={(p) =>
            lib
              .openSibling(p)
              .then((m) => onOpenMedia(m.id))
              .catch((e) => toast(e.message, true))
          }
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </div>
  );
}
