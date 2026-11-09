# Kotoba architecture

Desktop app (Electron 45 · Node 24 · Chromium 156). Files are never imported, moved or
copied: a media file's absolute path is its identity, like VLC.

```
src/
  core/        Plain Node ESM. Never imports Electron, so it runs under `node --test`.
    paths.mjs        configurePaths({ userDataDir, dictDbPath, tempDir }) — main/tests call first
    db.mjs           dictDb() (JMdict, read-mostly) · userDb() (library, corpus, settings)
    settings.mjs     settings table + in-memory decrypted Claude key
    ffmpeg.mjs       resolve ffmpeg/ffprobe (setting → env → bundled → PATH), encoder caps
    media.mjs        probe, clip extraction, subtitle-file decoding, display titles
    library.mjs      opened-media records, siblings playlist, subtitle discovery/loading
    playback.mjs     playbackPlan(id): direct vs stream from a measured format table; streamArgs() for ffmpeg
    subs.mjs         SRT/VTT/ASS parsing → [{ start, end, text }]
    deinflect.mjs    Japanese deinflection rules
    dict.mjs         lookup, segmentation (JMdict words + JMnedict names), homophones, shared-kanji
    corpus.mjs       watched-line index (collocation / prediction cards)
    cards.mjs        the 12 card generators
    anki.mjs         AnkiConnect + the 12 note types
    llm.mjs          Claude, for Contrast / Situation / Naturalness
    migrate-legacy.mjs  one-time import from the pre-desktop data/kotoba.db
  main/        Electron main process (ESM)
    main.mjs         composition root: single-instance, open-file, window, wiring
    ipc-util.mjs     handle(channel, fn): trusted-sender check + { ok, value | error } envelope
    ipc-core.mjs     app/settings/dict/cards/anki channels
    files.mjs        library/subs/dialog channels, openPaths(), argv handling
    protocol.mjs     kotoba:// scheme: app (renderer), media (byte ranges), stream (ffmpeg fMP4), playback channels
    menu.mjs         native menu; playback commands are sent to the renderer as evt:command
  preload/preload.cjs   window.kotoba = { invoke, on, pathForFile, platform }
  renderer/      React, built by Vite into out/renderer (or $KOTOBA_RENDERER_DIR)
    src/api/*.js     one module per domain; the only place that names IPC channels
    src/player/      VideoSurface (direct src or MSE) and mse.js, the kotoba://stream client
    src/ui/          App shell, Home (library), Player, Subtitles, CardMaker, Settings, Shortcuts
```

Segmentation quality: `node scripts/eval-segmentation.mjs --dump x.txt` over a subtitle
folder; diff two dumps to see what a dict.mjs/deinflect.mjs change moved.
Playback coverage: `node scripts/make-fixtures.mjs` then `node scripts/verify-playback.mjs`.
Its tone detector misses audio on a different file most runs (also in `--matrix`, with no app
code involved): rerun a "no audio heard" file before believing it.

## Process boundary

- Renderer is sandboxed, context-isolated, no Node. It reaches main only through
  `window.kotoba.invoke('<domain>:<name>', ...args)` and `window.kotoba.on('evt:<name>', cb)`.
- Channel names match `/^[a-z]+:[A-Za-z]+$/`, events `/^evt:[a-z-]+$/` (enforced in preload).
- Main registers channels with `handle()` from `ipc-util.mjs`. Errors come back to the
  renderer as thrown `Error(message)`.
- The renderer page itself is served from `kotoba://app/`, media bytes from
  `kotoba://media/<mediaId>`. Only ids registered in the library are served: the library
  is the access-control list for the filesystem.

## Data

| Store | Where | What |
|---|---|---|
| dict.db | dev `data/dict.db`, packaged `Resources/dict.db` | JMdict (read-only at runtime) |
| user.db | `app.getPath('userData')/user.db` | media, media_sub, line, mined, settings, meta |
| temp | `$TMPDIR/kotoba` | clip files for one card build; deleted after AnkiConnect copies them |

There is no media cache. Playback is direct or streamed; nothing is written to disk.

## Playback

- **direct**: `kotoba://media/<id>` byte ranges; Chromium demuxes and decodes. Only for the
  container × codec × pixel-format table in playback.mjs, measured with
  `scripts/verify-playback.mjs --matrix`, and only for the file's first audio track (Chromium
  ignores the default flag; switching `audioTracks` proved unreliable).
- **stream**: `kotoba://stream/<id>?start=<sec>&audio=<stream index>` pipes ffmpeg → fragmented
  MP4. Video is copied when Chromium decodes it, else h264_videotoolbox (libx264 fallback);
  audio is copied if aac/opus stereo, else stereo AAC. `-copyts -start_at_zero` with
  `+frag_discont`, `-avoid_negative_ts disabled` and `-use_editlist 0` make every fragment carry
  media time, so a restart just appends. Copy mode starts 12 s early (keyframes, late TS seeks).
  The renderer's MSE client (player/mse.js) restarts the stream on seeks outside the range being
  filled and stops reading 60 s ahead, which blocks ffmpeg on its pipe. Cancelling the response
  kills ffmpeg.

## Environment variables (dev / test)

| Var | Effect |
|---|---|
| `KOTOBA_USER_DATA` | userData dir (also isolates the single-instance lock) |
| `KOTOBA_DICT_DB` | dictionary database path |
| `KOTOBA_RENDERER_URL` | load the renderer from a Vite dev server instead of out/renderer |
| `KOTOBA_RENDERER_DIR` | where `npm run build` writes and where kotoba://app reads |
| `KOTOBA_VITE_PORT` | Vite dev server port |

`node scripts/shot.mjs --out x.png [--open file] [--eval "js"]` launches the real app with
Playwright, runs JS in the renderer and screenshots it.

## IPC channels

| Channel | Owner | Returns |
|---|---|---|
| app:status | ipc-core | { dictReady, ffmpeg, anki, llm, corpusLines, deckName, cardTypes, … } |
| settings:get / settings:set(patch) / settings:setApiKey(key) | ipc-core | settings |
| dict:lookup(word) / dict:tokenize(text) | ipc-core | entries / tokens |
| cards:preview(req) / cards:create(req) / cards:minedWords | ipc-core | — |
| anki:setup | ipc-core | — |
| library:list / get / remove / open(paths) / siblings / openSibling / setPosition / setPrefs / reveal | files | media records |
| files:classify(paths) | files | [{ path, kind: media·subtitle·folder·other }] |
| subs:tracks(id) / subs:load(id, key) / subs:attach(id, file) | files | tracks · { key, cues, tokens } |
| dialog:openMedia / openFolder / attachSubtitle(id) | files | — |
| playback:plan(id) | protocol | { mode, reason, url, streamUrl, duration, video, audioStream, audio[{…, directPlayable, reason}], chapters[] } |

Events main → renderer: `evt:open-media { id, ids }`, `evt:command <name>`.

A media record: `{ id, path, title, folder, size, duration, addedAt, lastOpenedAt, position, prefs, exists }`.
`prefs` is free-form per-media state: `subTrack`, `refTrack`, `audioTrack`, `subDelayMs`, `rate`.
Subtitle track keys are stable strings: `file:<abs path>` or `stream:<ffprobe stream index>`.
