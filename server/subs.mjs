// Subtitle parsing: SRT, WebVTT and ASS/SSA. All three collapse to the same
// cue shape: { start, end, text } with times in seconds.

// Japanese broadcast subtitles carry inline furigana - 西片(にしかた) - which
// would otherwise be segmented as its own words and pollute both the overlay
// and every mined sentence. Strip a parenthesised run only when it is pure kana
// AND directly follows kanji; that spares speaker labels like （西片）and
// stage directions like （ため息）, which contain kanji and are real content.
const FURIGANA = /([\u4e00-\u9fff\u3005\u3400-\u4dbf]+)[(（]([\u3041-\u309f\u30a0-\u30ff\u30fc]+)[)）]/g;

const stripTags = (s) =>
  s
    .replace(/\{\\[^}]*\}/g, '')      // ASS override blocks: {\an8}, {\i1}
    .replace(/<[^>]+>/g, '')          // SRT/VTT inline HTML
    .replace(/\\[Nnh]/g, '\n')        // ASS line breaks
    .replace(FURIGANA, '$1')
    .replace(/\r/g, '')
    .trim();

const hms = (h, m, s, frac) =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac || 0}`);

function parseSrtVtt(body) {
  const cues = [];
  const re =
    /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})([^\n]*)\n([\s\S]*?)(?=\n\s*\n|\n\s*\d+\s*\n\d{1,2}:|$)/g;
  let m;
  while ((m = re.exec(body))) {
    const text = stripTags(m[10]);
    if (!text) continue;
    cues.push({
      start: hms(m[1], m[2], m[3], m[4]),
      end: hms(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  return cues;
}

function parseAss(body) {
  const cues = [];
  const lines = body.split(/\r?\n/);
  const fmtLine = lines.find((l) => /^Format:/i.test(l) && /Text\s*$/i.test(l));
  const fields = fmtLine
    ? fmtLine.replace(/^Format:\s*/i, '').split(',').map((f) => f.trim().toLowerCase())
    : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const iStart = fields.indexOf('start');
  const iEnd = fields.indexOf('end');
  const iText = fields.indexOf('text');

  for (const line of lines) {
    if (!/^Dialogue:/i.test(line)) continue;
    // Text is the last field and may itself contain commas.
    const parts = line.replace(/^Dialogue:\s*/i, '').split(',');
    const head = parts.slice(0, iText);
    const text = stripTags(parts.slice(iText).join(','));
    if (!text) continue;
    const t = (v) => {
      const m = /(\d+):(\d{2}):(\d{2})[.,](\d+)/.exec(v || '');
      return m ? hms(m[1], m[2], m[3], m[4]) : 0;
    };
    cues.push({ start: t(head[iStart]), end: t(head[iEnd]), text });
  }
  return cues;
}

export function parseSubtitles(body, ext = '') {
  const cues = /ass|ssa/i.test(ext) || /^\[Script Info\]/im.test(body)
    ? parseAss(body)
    : parseSrtVtt(body);

  // Merge duplicate-timed cues (common in ASS karaoke/signs) and sort.
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.start === cue.start && prev.end === cue.end) {
      prev.text += '\n' + cue.text;
    } else {
      out.push(cue);
    }
  }
  return out;
}

export const SUB_EXTS = ['.srt', '.vtt', '.ass', '.ssa'];
