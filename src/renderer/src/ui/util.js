export const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${m}:${String(t % 60).padStart(2, '0')}`;
};

/** Index of the cue covering `t`, or -1. Cues are sorted by start. */
export function cueAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 && t <= cues[best].end ? best : -1;
}

/** Index of the last cue that started at or before `t` (for prev/next line when between cues). */
export function cueBefore(cues, t) {
  let i = -1;
  for (let lo = 0, hi = cues.length - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return i;
}

/** Text of reference cues overlapping [start, end] by at least a third of the shorter span. */
export function overlapText(cues, start, end) {
  return (cues ?? [])
    .filter((c) => {
      const o = Math.min(end, c.end) - Math.max(start, c.start);
      return o > 0 && o >= Math.min(end - start, c.end - c.start) / 3;
    })
    .map((c) => c.text.replace(/\s*\n\s*/g, ' '))
    .join(' ');
}

const JA = /\b(ja|jp|jpn|japanese)\b|日本語/i;
const EN = /\b(en|eng|english)\b/i;
const trackText = (t) => `${t.label ?? ''} ${t.language ?? ''} ${t.file ?? ''}`;
export const isJapanese = (t) => JA.test(trackText(t));
export const isEnglish = (t) => EN.test(trackText(t));

export const pickPrimary = (tracks, prefs) =>
  tracks.find((t) => t.key === prefs.subTrack) ?? tracks.find(isJapanese) ?? tracks[0] ?? null;

export const pickReference = (tracks, prefs, primaryKey) => {
  if (prefs.refTrack === null) return null;
  return tracks.find((t) => t.key === prefs.refTrack) ?? tracks.find((t) => t.key !== primaryKey && isEnglish(t)) ?? null;
};

export const audioLabel = (a, i) =>
  [a.title, a.language && a.language !== 'und' ? a.language.toUpperCase() : null, a.codec, a.channels ? `${a.channels}ch` : null]
    .filter(Boolean)
    .join(' · ') || `Track ${i + 1}`;

export function ago(ms) {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`kotoba.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`kotoba.${key}`, JSON.stringify(value));
    } catch { /* storage blocked: preference just won't persist */ }
  },
};

export const isTyping = (e) => e.target?.closest?.('input, textarea, select, [contenteditable="true"]');
