import path from 'node:path';
import { isMediaFile } from './media.mjs';

// Port of Mizune's Titles: readable names from file and folder names, by heuristics. Release
// groups, checksums and encoding notes come off; in a folder of episodes the shared series name
// comes off too, so each reads "Episode 1". Anything that doesn't look like those is left alone.

// Encoding notes that can't be mistaken for words in a title, in any case.
const TECHNICAL = new RegExp(
  '(?<![A-Za-z0-9])(?:\\d{3,4}[pi]|4k|bd-?rip|bd-?remux|blu-?ray|remux|web-?dl|web-?rip|hdtv(?:rip)?|dvd-?rip|' +
    'tv-?rip|x26[45]|h[ .]?26[45]|hevc|xvid|1[02]-?bits?|8-?bits?|hi10p?|flac|truehd|dual[- ]?audio|' +
    'multi[- ]?subs?)(?![A-Za-z0-9])',
  'i'
);
// Short ones that are only notes in capitals ("Charlotte's Web" keeps its web).
const TECHNICAL_CAPS = new RegExp(
  '(?<![A-Za-z0-9])(?:WEB|BD|DVD|AVC|AV1|AAC(?:[ .]?2[ .]0)?|OPUS|DTS(?:-HD)?|E?AC-?3|DDP?(?:[ .]?[257][ .][01])?|' +
    'HDR(?:10\\+?)?|UHD|CHS|CHT|BIG5|RAW)(?![A-Za-z0-9])'
);
const RELEASE_WORDS = /\b(?:complete|batch|uncensored|raw|subs?|subbed|dub|dubbed|fin)\b/i;
const CHECKSUM = /^[0-9A-Fa-f]{8}$/;
const BRACKETS = /\[[^\]]*\]|【[^】]*】|\{[^}]*\}/g;
const PARENS = /\(([^)]*)\)/g;
const VERSION = /(?<=\d)v\d(?![A-Za-z0-9])/gi;
const SEASON = /(?<![A-Za-z0-9])S(\d{1,2})(?![A-Za-z0-9])/gi;
const EDGES = /^[\s\-–—~_.,:|+]+|[\s\-–—~_.,:|+]+$/g;

const isTechnical = (text) => TECHNICAL.test(text) || TECHNICAL_CAPS.test(text) || CHECKSUM.test(text.trim());
const tidy = (text) => text.replace(/\s+/g, ' ').replace(EDGES, '');
const stem = (name) => (isMediaFile(name) ? name.slice(0, -path.extname(name).length) : name);

/** Everything from the first encoding note on goes ("Show 01 1080p WEB H264-GROUP" is "Show 01"). */
function cutAtFirstNote(text) {
  let rest = text;
  for (;;) {
    const first = [TECHNICAL.exec(rest), TECHNICAL_CAPS.exec(rest)].filter(Boolean).sort((a, b) => a.index - b.index)[0];
    if (!first) return rest;
    if (rest.slice(0, first.index).trim()) return rest.slice(0, first.index);
    rest = rest.slice(first.index + first[0].length); // a note before anything else: drop just the note
  }
}

/** `name` without its extension or release tags; the name itself if nothing would be left. */
export function clean(name) {
  const base = stem(name);
  let text = base.replace(BRACKETS, ' ');
  text = text.replace(PARENS, (whole, inside) => (isTechnical(inside) || RELEASE_WORDS.test(inside) || !inside.trim() ? ' ' : whole));
  // Scene names use dots and underscores for spaces.
  text = text.replaceAll('_', ' ');
  if (!text.trim().includes(' ') && (text.match(/\./g)?.length ?? 0) >= 2) text = text.replaceAll('.', ' ');
  text = cutAtFirstNote(text);
  text = text.replace(VERSION, '').replace(SEASON, (_, n) => `Season ${Number(n)}`);
  text = tidy(text);
  if (text) return text;
  // A name made only of brackets: the first is the group, notes and checksums go, the rest is the title.
  const parts = [...base.matchAll(BRACKETS)].map((m) => m[0].slice(1, -1).trim()).filter((p) => p && !isTechnical(p));
  return tidy((parts.length > 1 ? parts.slice(1) : parts).join(' ')) || tidy(base) || base;
}

// Words that number a series of their own: "Lesson 1" stays "Lesson 1", not "Episode 1".
const COUNTERS = new Set(['lesson', 'lecture', 'chapter', 'part', 'track', 'unit', 'day', 'week', 'vol', 'volume', 'class', 'session']);
const SEASON_EPISODE = /^S(\d{1,2})\s*E(\d{1,4})(.*)$/i;
const NUMBERED = /^(?:(?:ep(?:isode)?|e)\.?\s*|#)?(\d{1,4})(?![0-9])(.*)$/i;
const JAPANESE = /^第\s*(\d{1,4})\s*[話话集回](.*)$/;
const ENDING = /^\s*(?:end|final)(?![A-Za-z])/i;

/** What follows an episode number, as its title: nothing, or words after a separator. Null if it runs on. */
function titled(rest) {
  const text = rest.replace(ENDING, '');
  return /^[\p{L}\p{N}]/u.test(text) ? null : tidy(text);
}

function episode(remainder) {
  const text = remainder.trim();
  let m = SEASON_EPISODE.exec(text);
  if (m) {
    const title = titled(m[3]);
    return title == null ? null : { season: Number(m[1]), number: Number(m[2]), title };
  }
  m = JAPANESE.exec(text) ?? NUMBERED.exec(text);
  if (!m) return null;
  const title = titled(m[2]);
  return title == null ? null : { season: null, number: Number(m[1]), title };
}

/** The start every name shares, back to the last word break, so a shared "0" of "01" and "02" stays. */
function sharedPrefix(names) {
  let length = Math.min(...names.map((n) => n.length));
  for (const name of names) {
    let i = 0;
    while (i < length && name[i] === names[0][i]) i++;
    length = i;
  }
  while (length > 0 && !/[\s\-–—_.~:]/.test(names[0][length - 1])) length--;
  return names[0].slice(0, length);
}

/** Titles for the files in one folder, in order: cleaned, and when they're episodes of one series, which episode each is. */
export function episodes(names) {
  const cleaned = names.map(clean);
  if (cleaned.length < 2) return cleaned;
  const shared = sharedPrefix(cleaned);
  if (COUNTERS.has(shared.trim().toLowerCase().replace(/\.+$/, ''))) return cleaned;
  const parsed = cleaned.map((c) => episode(c.slice(shared.length)));
  if (parsed.some((e) => !e)) return cleaned;
  const seasons = new Set(parsed.map((e) => e.season).filter((s) => s != null));
  return parsed.map((e) => {
    const label = seasons.size > 1 ? `S${e.season ?? 1} E${e.number}` : `Episode ${e.number}`;
    return e.title ? `${label} · ${e.title}` : label;
  });
}

/** A title that already says which episode it is needs no place number beside it. */
export const namesEpisode = (title) => title.startsWith('Episode ') || /^S\d+ E\d+/.test(title);

/** How a file or folder called `name` is shown. */
export const nameOf = (name, tidyNames) => (tidyNames ? clean(name) : stem(name));

/** An episode's name under Continue watching, among its folder's file names. */
export function episodeTitle(name, siblings, tidyNames) {
  const i = siblings.indexOf(name);
  return tidyNames && i >= 0 ? episodes(siblings)[i] : stem(name);
}

/** The show above an episode's name, or null for one at the top or a film alone, which isn't named twice. */
export const showTitle = (folderTitle, title) => (folderTitle != null && folderTitle !== title ? folderTitle : null);
