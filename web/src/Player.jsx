import React, { useCallback, useEffect, useRef, useState } from 'react';
import SubOverlay from './Subtitles.jsx';

const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${m}:${String(t % 60).padStart(2, '0')}`;
};

/** Index of the cue covering `t`, or the last one that started before it. */
function cueAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 && t <= cues[best].end ? best : -1;
}

const readVolume = () => {
  try {
    const v = Number(localStorage.getItem('kotoba.volume'));
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
  } catch {
    return 1;
  }
};

export default function Player({ url, isVideo, subs, minedWords, onMine, onError }) {
  const video = useRef(null);
  const cueList = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(readVolume);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [cueIndex, setCueIndex] = useState(-1);
  const [pauseOnHover, setPauseOnHover] = useState(false);
  const [showSubs, setShowSubs] = useState(true);
  const hovering = useRef(false);
  const resumeAfterHover = useRef(false);

  const cues = subs?.cues ?? [];

  // Subtitle sync needs finer granularity than `timeupdate` (~4Hz) provides, so
  // the cue index is recomputed per animation frame. State only changes when
  // the cue actually changes; the seek bar reads a coarser 5Hz clock.
  useEffect(() => {
    let raf;
    let lastClock = 0;
    const tick = () => {
      const el = video.current;
      if (el) {
        const t = el.currentTime;
        const idx = cueAt(cues, t);
        setCueIndex((prev) => (prev === idx ? prev : idx));
        if (t - lastClock > 0.2 || t < lastClock) {
          lastClock = t;
          setTime(t);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cues]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate, url]);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    try {
      localStorage.setItem('kotoba.volume', String(volume));
    } catch { /* private window or blocked storage - volume just won't persist */ }
  }, [volume, muted, url]);

  useEffect(() => {
    const el = cueList.current?.querySelector('.cue.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cueIndex]);

  const seek = useCallback((t) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(t, el.duration || t));
  }, []);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch((e) => onError?.(e.message));
    else el.pause();
  }, [onError]);

  const jumpCue = useCallback(
    (delta) => {
      if (!cues.length) return;
      const from = cueIndex >= 0 ? cueIndex : cueAt(cues, video.current?.currentTime ?? 0);
      const base = from >= 0 ? from : cues.findIndex((c) => c.start > (video.current?.currentTime ?? 0)) - 1;
      const next = Math.max(0, Math.min(cues.length - 1, base + delta));
      seek(cues[next].start + 0.01);
    },
    [cues, cueIndex, seek]
  );

  const bumpRate = useCallback((dir) => {
    setRate((r) => {
      const i = SPEEDS.indexOf(r);
      const at = i === -1 ? SPEEDS.indexOf(1) : i;
      return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + dir))];
    });
  }, []);

  const replayCue = useCallback(() => {
    if (cueIndex >= 0) seek(cues[cueIndex].start + 0.01);
  }, [cueIndex, cues, seek]);

  // Mining always pauses first: the card is built against whichever cue is on
  // screen, and letting playback run past it while the dialog is open would
  // silently mine a different line than the one being looked at.
  const mine = useCallback(
    (token) => {
      video.current?.pause();
      onMine(token, cueAt(cues, video.current?.currentTime ?? 0));
    },
    [cues, onMine]
  );

  // Keyboard map, deliberately close to VLC / mpv muscle memory.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches('input, textarea, select')) return;
      const map = {
        ' ': () => toggle(),
        k: () => toggle(),
        ArrowLeft: () => seek((video.current?.currentTime ?? 0) - (e.shiftKey ? 1 : 5)),
        ArrowRight: () => seek((video.current?.currentTime ?? 0) + (e.shiftKey ? 1 : 5)),
        ArrowUp: () => bumpRate(1),
        ArrowDown: () => bumpRate(-1),
        ',': () => jumpCue(-1),
        '.': () => jumpCue(1),
        r: () => replayCue(),
        s: () => setShowSubs((v) => !v),
        m: () => setMuted((v) => !v),
        e: () => {
          const t = hovering.current;
          if (t) mine(t);
        },
      };
      const fn = map[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seek, bumpRate, jumpCue, replayCue, mine]);

  const onHoverChange = useCallback(
    (token) => {
      hovering.current = token;
      if (!pauseOnHover) return;
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
    [pauseOnHover]
  );

  const activeTokens = cueIndex >= 0 ? subs?.tokens?.[cueIndex] : null;

  return (
    <>
      <div className="videowrap">
        <video
          ref={video}
          src={url}
          controls={false}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
          onError={() => onError?.('The browser refused this stream.')}
          onClick={toggle}
          style={isVideo ? undefined : { display: 'none' }}
        />
        {!isVideo ? <div className="audioart">♪</div> : null}
        {showSubs ? (
          <SubOverlay
            tokens={activeTokens}
            minedWords={minedWords}
            onMine={mine}
            onHoverChange={onHoverChange}
          />
        ) : null}
      </div>

      <div className="controls">
        <input
          className="seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className="row">
          <button onClick={toggle} style={{ minWidth: 44 }}>{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => jumpCue(-1)} title="previous line (,)">⤺ line</button>
          <button onClick={replayCue} title="replay line (r)">↻</button>
          <button onClick={() => jumpCue(1)} title="next line (.)">line ⤻</button>
          <span className="time">{fmt(time)} / {fmt(duration)}</span>
          <button onClick={() => setMuted((v) => !v)} title="mute (m)" style={{ minWidth: 38 }}>
            {muted || volume === 0 ? '🔇' : '🔊'}
          </button>
          <input
            className="vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setVolume(Number(e.target.value));
              setMuted(false);
            }}
            title="volume"
          />
          <span className="spacer" />
          <label className="row dim" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={pauseOnHover} onChange={(e) => setPauseOnHover(e.target.checked)} />
            pause on hover
          </label>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))} title="speed (↑/↓)">
            {SPEEDS.map((s) => <option key={s} value={s}>{s.toFixed(2)}×</option>)}
          </select>
          <button onClick={() => setShowSubs((v) => !v)} title="toggle subtitles (s)">
            {showSubs ? '字幕 on' : '字幕 off'}
          </button>
        </div>
      </div>

      <div className="cuelist" ref={cueList}>
        {cues.map((c, i) => (
          <div
            key={i}
            className={`cue${i === cueIndex ? ' active' : ''}`}
            onClick={() => seek(c.start + 0.01)}
          >
            <span className="t">{fmt(c.start)}</span>
            <span className="jp">{c.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
