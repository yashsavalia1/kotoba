# Kotoba architecture

Desktop app (Electron 45 · Node 24 · Chromium 156). Files are never imported, moved or
copied: a media file's absolute path is its identity, like VLC.

```
src/
  core/        Plain Node ESM. Never imports Electron, so it runs under `node --test`.
    paths.mjs        configurePaths({ userDataDir, dictDbPath, tempDir }) — main/tests call first
    db.mjs           dictDb() (JMdict, read-mostly) · userDb() (library, corpus, settings)
    settings.mjs     settings table + in-memory decrypted Claude key
    ffmpeg.mjs       ffmpeg() / ffprobe(): the bundled binaries' paths; a missing one throws
    media.mjs        media extensions, probe, clip extraction, subtitle-file decoding, display titles
    library.mjs      opened-media records, watch rules on setPosition, siblings playlist, subtitle discovery/loading
    browse.mjs       the library root as on disk: folder/video cards, Continue watching, marks, checkPath()
    titles.mjs       Mizune's Titles: clean() release tags, episodes() "Episode 3" in a folder of episodes
    watch.mjs        Mizune's rules: finished (last 10%, 30 s–5 min), skimmed (< 60 s or ¼ of a short video), wording
    thumbs.mjs       ffmpeg frame cache (20% in, 480 px JPEG), Continue watching frames, 2-job queue
    playback.mjs     playbackPlan(id): what Chromium plays of a file, from a measured format table
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
    protocol.mjs     kotoba:// scheme: app (renderer), media (byte ranges), thumb (frames), playback channels
    menu.mjs         native menu; playback commands are sent to the renderer as evt:command
    log.mjs          console tee to main.log + renderer errors/crashes
  preload/preload.cjs   window.kotoba = { invoke, on, pathForFile, platform }
  renderer/      React, built by Vite into out/renderer (or $KOTOBA_RENDERER_DIR)
    src/api/*.js     one module per domain; the only place that names IPC channels
    src/ui/          App shell, Home (library), Player, Subtitles, CardMaker, Settings, Shortcuts
```

Segmentation quality: `node scripts/eval-segmentation.mjs --dump x.txt` over a subtitle
folder; diff two dumps to see what a dict.mjs/deinflect.mjs change moved.
Playback coverage: `node scripts/make-fixtures.mjs` then `node scripts/verify-playback.mjs`, which
plays each fixture in a bare `<video>` in the app and fails unless the plan's `video` and `audio`
are exactly what Chromium decoded (`webkit{Video,Audio}DecodedByteCount`).

## Process boundary

- Renderer is sandboxed, context-isolated, no Node. It reaches main only through
  `window.kotoba.invoke('<domain>:<name>', ...args)` and `window.kotoba.on('evt:<name>', cb)`.
- Channel names match `/^[a-z]+:[A-Za-z]+$/`, events `/^evt:[a-z-]+$/` (enforced in preload).
- Main registers channels with `handle()` from `ipc-util.mjs`. Errors come back to the
  renderer as thrown `Error(message)`.
- The renderer page itself is served from `kotoba://app/`, media bytes from
  `kotoba://media/<mediaId>`. Only ids registered in the library are served: the library
  is the access-control list for the filesystem.
- The library root (`libraryRoot` setting) widens that list to everything under one folder:
  `kotoba://thumb/?path=<abs>[&at=<sec>]` and the path-taking `library:*` channels go through
  `checkPath()` (browse.mjs), which allows a path under the root (folders compared by real path,
  so a symlinked folder can't lead out) or a media file already registered. `settings:set`
  refuses `libraryRoot`; only `dialog:libraryRoot` (the native folder picker) sets it.

## Library

- One root folder, browsed as it is on disk: each folder is a card, nested folders are seasons,
  natural sort, dot-names skipped. A folder card counts its own videos plus subfolders 2 levels
  down (a group per season, for progress slices); its cover is its first video, else the first
  one in subfolders up to 3 levels down.
- A sitting starts when a file is opened (`last_opened_at`). `setPosition` ignores a sitting that
  was only a look, and a stop inside the last tenth (30 s–5 min) sets `watched` and resets the
  position. A saved stop sets `played_at`, which orders Continue watching: one card per show
  folder, videos at the root or opened from outside it (drag-drop, Open, Open with) stand alone.
- Names, counts and Continue watching text are built in main from the settings (`tidyNames`,
  `episodeNumbers`, `continueWatching`, `showProgress`); the renderer only toggles the overlays
  (`progressChecks`, `videoProgress`, `folderProgress`) and refetches when those settings change.

## Data

| Store | Where | What |
|---|---|---|
| dict.db | dev `data/dict.db`, packaged `Resources/dict.db` | JMdict (read-only at runtime) |
| user.db | `app.getPath('userData')/user.db` | media (+ `watched`, `played_at`; older files gain them on open, finished stops marked watched), media_sub, line, mined, settings, meta |
| thumbs | `userData/thumbs/<sha1(path\|size\|mtime)>[@<sec>].jpg` | library frames; `@<sec>` is a Continue watching frame, retaken past 30 s. Never pruned |
| temp | `$TMPDIR/kotoba` | clip files for one card build; deleted after AnkiConnect copies them |

There is no media cache: Chromium plays the files themselves; only library thumbnails are written.

## Playback

- Chromium's own `<video>` plays `kotoba://media/<id>` byte ranges. Nothing is remuxed or
  transcoded, and there is no other player.
- `playbackPlan(id)` checks ffprobe's streams against `PLAYS`, the container × codec ×
  pixel-format table in playback.mjs: `video` and `audio` are what Chromium will play (null when
  nothing), `unsupported` is a plain reason for the rest ("AC3 audio isn't supported").
- What Chromium (Electron 45) does with the rest, measured: avi, flv, ts, m2ts and wmv don't open,
  so the media extensions (media.mjs, `fileAssociations`) are only mkv mp4 m4v webm mov and mp3
  flac m4a aac ogg oga opus wav mka; `openPaths` refuses any other file with an `evt:error` toast.
  MPEG-2, MPEG-4 Part 2, ProRes, Theora and Hi10P H.264 video play as sound over a black picture.
  AC3, E-AC3, DTS and TrueHD audio are dropped without an error: Chromium plays the first audio
  track it can decode, whatever the default flags say, and offers no track switching.
- The player shows a file it plays nothing of as an error in place of the video, and toasts the
  reason for a file it plays only part of.
- ffmpeg is internal, for the jobs `<video>` can't do (Chromium's own FFmpeg isn't reachable from
  JS): ffprobe for streams and chapters, ffmpeg for embedded text subtitles, card clips (from the
  audio track that plays), screenshots and thumbnails. Packaged, the binaries are
  `Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg` and `Resources/bin/ffprobe`;
  dev and tests use the same repo copies (`node_modules/ffmpeg-static`, `build/ffprobe-<platform>-<arch>`
  from `node build/fetch-ffprobe.mjs`). No setting, env var or PATH.

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

Logs: `~/Library/Logs/Kotoba/main.log` (`$KOTOBA_USER_DATA/logs` under tests). Main-process
console plus renderer errors, warnings and crashes; rotated to `main.log.old` past 5 MB.

## IPC channels

| Channel | Owner | Returns |
|---|---|---|
| app:status | ipc-core | { dictReady, anki, llm, corpusLines, deckName, cardTypes, … } |
| settings:get / settings:set(patch) / settings:setApiKey(key) | ipc-core | settings |
| dict:lookup(word) / dict:tokenize(text) | ipc-core | entries / tokens |
| cards:preview(req) / cards:create(req) / cards:minedWords | ipc-core | create: { added, skipped, duplicates } — duplicates are Anki first-field hits held back unless `req.allowDuplicates` or the `warnDuplicates` setting is off |
| anki:setup | ipc-core | — |
| library:list / get / remove / open(paths) / siblings / openSibling / setPosition / setPrefs / reveal | files | media records |
| files:classify(paths) | files | [{ path, kind: media·subtitle·folder·other }] |
| subs:tracks(id) / subs:load(id, key) / subs:attach(id, file) | files | tracks · { key, cues, tokens } |
| library:browse(dir \| null) | files | { root, dir, title, detail, crumbs[{ path, title }], resume[], folders[], videos[] }, or { root: null, resume } with no root |
| library:markWatched(path) / clearProgress(path) / forget(path) | files | — · a folder means every video under it (3 levels); forget = Remove from row |
| library:revealPath(path) / copyPath(path) | files | — |
| dialog:openMedia / attachSubtitle(id) / libraryRoot | files | libraryRoot: settings, or null if cancelled |
| playback:plan(id) | protocol | { url, duration, video: { codec, width, height } \| null, audio: { codec, language } \| null, chapters[], unsupported: reason \| null } |

Events main → renderer: `evt:open-media { id, ids }`, `evt:command <name>`, `evt:error <message>` (a file it can't play).

A media record: `{ id, path, title, folder, size, duration, addedAt, lastOpenedAt, position, prefs, watched, exists }`.
`prefs` is free-form per-media state: `subTrack`, `refTrack`, `subDelayMs`, `rate`.
Subtitle track keys are stable strings: `file:<abs path>` or `stream:<ffprobe stream index>`.

## Releases

`.github/workflows/release.yml` runs on every push to `main`. A Linux job builds the
dictionary (cached for a week, keyed on the build scripts) and passes `build/dict.db` on.
macOS (arm64 dmg), Windows (x64 NSIS installer) and Linux (x64 AppImage) jobs then fetch
their platform's ffprobe and package with `electron-builder --publish never`. The Linux job
also runs the unit tests. A last job publishes the installers as release
`v<major>.<minor>.<run number>`, with the version stamped into the app through
`-c.extraMetadata.version`. Builds are ad-hoc signed on macOS and unsigned on Windows.
