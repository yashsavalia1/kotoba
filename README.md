# 言葉 kotoba

Migaku-style sentence mining for **your own media files**. Play a video or audio
file, hover a word in the subtitles to get its definition, and turn the line into
Anki cards — with the audio clip, the frame, and the sentence attached.

Twelve card types, not one. Most of them are built from the dictionary and from
the subtitles you have already watched, so they cost nothing and work offline.

---

## Why this is an app and not a VLC plugin

VLC rasterises subtitles into a bitmap before the video output blends them. By
the time the text is on screen, per-word positions no longer exist, and no plugin
API exposes them. Lua extensions get a dialog box, four playback listeners, and
no mouse events at all; C modules get native power but cannot extend the Qt UI,
so a dictionary popup would mean maintaining a VLC fork.

Migaku sidesteps this by being a browser extension — it re-renders subtitles as
DOM, which makes hover free. Kotoba uses the same trick locally: a `<video>`
element plays, and the subtitles are HTML on top.

---

## Setup

Requires **Node 22.13+**. ffmpeg is bundled; in a fresh checkout, fetch the
matching ffprobe once with `node build/fetch-ffprobe.mjs`.

```bash
npm install
npm run dict
```

`npm run dict` downloads the latest [jmdict-simplified](https://github.com/scriptin/jmdict-simplified)
English release (~11 MB) and flattens 218k entries into SQLite. Takes about a
minute; you only do it once.

Point it at your media and start it:

```bash
npm start
```

Then edit `kotoba.config.json` (written on first run) and restart:

```json
{
  "mediaDirs": ["/Users/you/Anime", "/Users/you/Podcasts"],
  "deckName": "Kotoba",
  "clipPadding": 0.25
}
```

It ships with a tiny sample file in `sample/` so the first run does something.

### Anki

Install the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on
(code `2055492159`), leave Anki running, and hit **Install note types** once.
That creates twelve `Kotoba::*` note types and the target deck.

### Claude (optional)

Three of the twelve card types need linguistic judgment rather than lookup.
Set `ANTHROPIC_API_KEY` and they light up; leave it unset and the other nine
still work, fully offline.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Playback

Chromium's own player, nothing in between: mkv, mp4, m4v, webm and mov video, and
mp3, flac, m4a, aac, ogg, oga, opus, wav and mka audio. Kotoba refuses other files
(avi, ts, wmv…) and says so. When a file holds something Chromium can't decode,
such as AC3 or DTS audio or MPEG-2 video, the player says what, and plays whatever
part it can. Only the first audio track Chromium can decode plays.

ffmpeg stays behind the scenes: it lists tracks and chapters, reads embedded text
subtitles, cuts each card's audio clip, video clip and screenshot, and makes the
library thumbnails.

| key | |
|---|---|
| `space` / `k` | play / pause |
| `←` `→` | seek 5 s (`⇧` 1 s, `⌥` 30 s); `j` `l` seek 10 s |
| `,` `.` | previous / next subtitle line |
| `r` | replay the current line |
| hold `i` | peek at the translation line, in place of the Japanese |
| `[` `]` `=` | slower / faster / normal speed |
| `↑` `↓` `m` | volume / mute |
| `g` `h` | subtitle delay −/+ 100 ms |
| `s` | show / hide subtitles |
| `v` | next subtitle track |
| `e` | make cards from the hovered word |
| `t` `p` | transcript / playlist drawer |
| `<` `>` | previous / next file in the folder |
| `?` | every shortcut |

Holding the subtitle line with the mouse peeks too. The translation track is picked in
the subtitles menu (an English track is chosen automatically when there is one); it also
fills the cards' Translation field.

## Library

Choose a media folder once (the library's first screen, or Settings › Library). Each
folder in it is a show and folders inside those are seasons, browsed with breadcrumbs.
Every video gets a frame thumbnail; Continue watching keeps one card per show at the
point you stopped. Names are tidied (release groups, `1080p` and the like dropped,
episodes numbered), and videos carry watched ticks and progress lines. Right-click a
card to play from the start, mark watched, clear progress, show it in Finder or copy
its path. Files dropped on the window or opened with ⌘O play too, without joining the
library.

---

## Hovering

Every cue is segmented when the track loads, so hover costs nothing.

Inline furigana is stripped first — Japanese broadcast subtitles write
`西片(にしかた)`, and left alone the reading is segmented as its own words and
ends up in every mined sentence. Parenthesised kana is only removed when it
directly follows kanji, so speaker labels like `（西片）` and stage directions
like `（ため息）` survive.

Segmentation is Yomitan's approach, not a morphological analyser: longest-match
against the dictionary, with rule-based deinflection and a part-of-speech check
on the result. That means multi-word entries win over their parts — `正直に` is
one token, `世の中だ` resolves to `世の中`, `食べたくなかった` resolves to
`食べる` — and a spurious deinflection cannot resolve to an unrelated noun that
happens to share a reading.

Click a word (or press `e`) to open the card maker. Playback pauses so the card
is always built against the line you were looking at.

---

## The twelve card types

Six need nothing but the dictionary and the file. Three are computed from your
own watched subtitles. Three need Claude.

| # | Type | Front | Back | Source |
|---|---|---|---|---|
| 1 | **Context cloze** | the line as-is | reading, gloss, translation, audio, frame | dictionary |
| 2 | **Contrast** | forced choice between the word and its nearest confusable | the answer + why | Claude |
| 3 | **Reading contrast** | the word beside others sharing a kanji | the readings | dictionary |
| 4 | **Audio** | the clip, nothing else | word, reading, meaning, sentence | file |
| 5 | **Production** | the English | the Japanese line + audio | dictionary |
| 6 | **Situation** | a described situation | what a native would say | Claude |
| 7 | **Collocation** | the word + gloss | the phrases it lives in | dictionary + your corpus |
| 8 | **Image** | a frame from the scene | the line, no English | file |
| 9 | **Minimal pair** | 保証 / 保障 / 補償 | readings + meanings | dictionary |
| 10 | **Would a native say this?** | a plausible-but-off sentence | the verdict + the natural version | Claude |
| 11 | **Prediction** | `正直＿＿＿` | what most often follows it | your corpus |
| 12 | **Reverse context** | the line with the word blanked | the missing word | dictionary |

Context cloze is the default, and is meant to be most of your deck.

**Cards 7 and 11 grow with you.** Every subtitle line the player loads is
recorded. Collocations and predictions are mined from that corpus and ranked by
how often you have actually met them, so the deck bends toward your media rather
than a generic frequency list. Early on there is not enough data and those two
types decline with a message saying so — that is expected, not a failure.

**Cards 3 and 9 are computed, not guessed.** Reading contrast pulls words that
share a kanji but are read differently; minimal pairs pull common words of the
same length with an identical reading. JMdict files 保証, 保障 and 補償 under a
single entry, so all three surface as one card.

**Cards 2, 6 and 10 are one Claude request.** Selecting all three (plus a
translation) costs a single round trip, not four.

A card type that cannot produce something worth reviewing is skipped with a
reason rather than emitted half-empty.

---

## Layout

Electron 45: plain Node ESM in `src/core` (runs under `node --test`), the main process in
`src/main`, a sandboxed React renderer in `src/renderer`. The whole map, the IPC table and
the data stores are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/core/       dictionary, segmentation, subtitles, library, cards, Anki, Claude, ffmpeg
src/main/       window, kotoba:// protocol, IPC, menu, log
src/preload/    window.kotoba bridge
src/renderer/   React: Home (library), Player, Subtitles, CardMaker, Settings
scripts/        dictionary build, playback fixtures and checks, screenshots, mock Anki
test/           node --test unit tests
e2e/            Playwright against the dev build or the packaged app
```

## Tests

```bash
npm test
```

Unit tests cover deinflection, segmentation, subtitle parsing, titles and watch
rules, the library scan, the card generators, Anki and the corpus queries.
Dictionary-dependent tests skip cleanly if you have not run `npm run dict`.

End to end, with Playwright driving the real app against a mock AnkiConnect:

```bash
npm run e2e                                   # dev build
npm run dist && npx playwright test --project=packaged
```

The e2e suite plays `sample/Shoujiki S01E01.mkv` (H.264 + AAC with a Japanese
subtitle track), which is gitignored; put any short clip like that there first.

## Known ceilings

- **Segmentation is greedy.** `今日は` matches the dictionary entry こんにちは
  rather than 今日 + は. The popup lists every candidate entry and the card maker
  lets you pick, so it is recoverable, but the first guess is sometimes the
  wrong one.
- **Corpus queries are `LIKE '%word%'` full scans.** Milliseconds at personal
  scale. FTS5 if that ever stops being true.
- **`npm run dict` parses ~200 MB of JSON in one go** and needs the raised heap
  in its npm script. It runs once.
- **Bitmap subtitles (PGS, VobSub) are ignored** — there is no text to hover.
  OCR would be a separate project.
- **One audio track.** Chromium plays the first audio track it can decode; there
  is no track switching.
- **Japanese only.** The deinflection table and JMdict are both language-specific;
  the player, clipping, and Anki layers are not.
