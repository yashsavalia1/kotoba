// Subtitle parsing: SRT, WebVTT and ASS/SSA. All three collapse to the same
// cue shape: { start, end, text, kind, style? } with times in seconds.
// kind is 'dialogue' | 'sign' | 'song' so the UI and corpus can keep dialogue only.

// Japanese broadcast subtitles carry inline furigana - 西片(にしかた) - which
// would otherwise be segmented as its own words and pollute both the overlay
// and every mined sentence. Strip a parenthesised run only when it is pure kana
// AND directly follows kanji; that spares speaker labels like （西片）and
// stage directions like （ため息）, which contain kanji and are real content.
const FURIGANA = /([一-鿿々㐀-䶿]+)[(（]([ぁ-ゟ゠-ヿー]+)[)）]/g;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

const tidy = (s) =>
  s
    .replace(FURIGANA, '$1')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

const htmlText = (s) =>
  tidy(
    s
      .replace(/\{\\[^}]*\}/g, '') // {\an8} in SRT
      .replace(/<[^>]*>/g, '') // <i>, <c.yellow>, <v Name>, <00:01.000>
      .replace(/&(#\d+|[a-z]+);/gi, (m, e) =>
        e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)
      )
  );

const SONG_MARK = /^[\s～〜~]*[♪♫♬〽]/;

// [hh:]mm:ss[.,]fff - hours are optional in WebVTT.
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?/;
const seconds = (m, i) =>
  Number(m[i] ?? 0) * 3600 + Number(m[i + 1]) * 60 + Number(m[i + 2]) + Number(`0.${m[i + 3] ?? 0}`);
const TIMING = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}`);

function parseSrtVtt(body) {
  const cues = [];
  let cur = null;
  const close = () => {
    if (cur) cues.push(cur);
    cur = null;
  };
  for (const line of body.split('\n')) {
    const m = TIMING.exec(line);
    if (m) {
      // A cue number with no blank line before it belongs to this cue, not the last one.
      if (cur && /^\d+$/.test(cur.lines.at(-1)?.trim() ?? '')) cur.lines.pop();
      close();
      cur = { start: seconds(m, 1), end: seconds(m, 5), lines: [] };
    } else if (!line.trim()) {
      close();
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  close();
  return cues.map(({ start, end, lines }) => {
    const text = htmlText(lines.join('\n'));
    return { start, end, text, kind: SONG_MARK.test(text) ? 'song' : 'dialogue' };
  });
}

const words = (s) => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const SONG_STYLE = new Set(['op', 'ed', 'opening', 'ending', 'song', 'songs', 'insert', 'kara', 'karaoke', 'lyric', 'lyrics', 'theme', 'romaji', 'kanji']);
const SIGN_STYLE = new Set(['sign', 'signs', 'ts', 'typeset', 'title', 'note', 'notes', 'caption', 'logo', 'card', 'eyecatch', 'board', 'chalkboard', 'screen', 'text']);
// Actor names are free text ("Ed" may be a character), so only unambiguous labels count there.
const SIGN_NAME = new Set(['sign', 'signs', 'ts', 'typeset']);
const SONG_NAME = new Set(['song', 'lyrics', 'karaoke']);

// ponytail: style-name + positioning heuristic. Covers fansub conventions seen in the wild;
// a per-track style picker in the UI is the upgrade if it misfires.
function assKind(style, name, raw) {
  const s = words(style);
  const n = words(name);
  if (s.some((w) => SONG_STYLE.has(w)) || n.some((w) => SONG_NAME.has(w)) || /\\k[fo]?\d/i.test(raw)) return 'song';
  if (s.some((w) => SIGN_STYLE.has(w)) || n.some((w) => SIGN_NAME.has(w))) return 'sign';
  if (/\\(pos|move|clip|iclip|org)\s*\(|\\p[1-9]/.test(raw)) return 'sign';
  return 'dialogue';
}

function assText(raw) {
  let out = '';
  let drawing = false;
  // Alternate plain runs and {override} blocks; text inside {\p1}…{\p0} is vector drawing, not words.
  for (const [, block, plain] of raw.matchAll(/(\{[^}]*\})|([^{]+|\{)/g)) {
    if (block) {
      const p = [...block.matchAll(/\\p(\d+)/g)].at(-1);
      if (p) drawing = Number(p[1]) > 0;
    } else if (!drawing) {
      out += plain;
    }
  }
  return tidy(out.replace(/\\N/g, '\n').replace(/\\n/g, ' ').replace(/\\h/g, ' '));
}

function parseAss(body) {
  const cues = [];
  let section = '';
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  for (const line of body.split('\n')) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) {
      section = head[1].toLowerCase();
      continue;
    }
    if (section !== 'events') continue;
    if (/^Format:/i.test(line)) {
      fields = line.replace(/^Format:\s*/i, '').split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue; // Comment:, Picture:, Sound:, Movie:, Command:
    // Text is the last field and may itself contain commas.
    const parts = line.replace(/^Dialogue:\s*/i, '').split(',');
    const iText = fields.indexOf('text');
    const f = (k) => (parts[fields.indexOf(k)] ?? '').trim();
    const raw = parts.slice(iText).join(',');
    const text = assText(raw);
    if (!text) continue;
    const t = (v) => {
      const m = TIME.exec(v);
      return m ? seconds(m, 1) : NaN;
    };
    const style = f('style').replace(/^\*/, '');
    cues.push({ start: t(f('start')), end: t(f('end')), text, kind: assKind(style, f('name'), raw), style });
  }
  return cues;
}

export function parseSubtitles(body, ext = '') {
  body = String(body ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = (/ass|ssa/i.test(ext) || /^\[Script Info\]/im.test(body) ? parseAss(body) : parseSrtVtt(body))
    // Zero-length and inverted cues never display.
    .filter((c) => c.text && Number.isFinite(c.start) && c.end > c.start);

  // Stable sort keeps overlapping cues in file order. Same-timed cues of one kind are
  // merged (stacked lines, ASS layers); exact duplicates (border/shadow layers) collapse.
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const cue of cues) {
    let prev = null;
    for (let i = out.length - 1; i >= 0 && out[i].start === cue.start && !prev; i--) {
      if (out[i].end === cue.end && out[i].kind === cue.kind) prev = out[i];
    }
    if (!prev) out.push(cue);
    else if (!`\n${prev.text}\n`.includes(`\n${cue.text}\n`)) prev.text += '\n' + cue.text;
  }
  return out;
}

export const SUB_EXTS = ['.srt', '.vtt', '.ass', '.ssa'];
