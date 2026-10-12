# `.finca` project format: design note (Phase 1, "Project format v2")

Status: **proposal, waiting for Julio's choice of (a), (b) or (c).** Nothing
in the app has changed yet. Branch: `feat/finca-format` (based on
`finca-animate` @ 93ba22b).

## 1. Today (what we are replacing)

- A scene is one `.otoon` JSON file. Every raster drawing is a base64 PNG
  data URL, every vector drawing is its stroke list, and imported audio and
  video are base64 data URLs too (`project.audio.data`, `layer.video.src`).
- **Save** (`IO.serialize`, `src/io.js`) re-encodes every raster cel with
  `canvas.toDataURL()` on the renderer's main thread, stringifies the lot
  and sends it over IPC. `electron/main.js` `writeFileAtomic` writes a temp
  file, fsyncs, copies the old file to `<name>.bak`, renames temp over it.
- **The 20-second timer** (`src/main.js` ~L281) does a *full* save into the
  real file whenever the scene is dirty and has a path. It only writes the
  userData `autosave.otoon` (and its history: one snapshot per 5 min,
  newest 8) for scenes that were never saved, or when the real write fails.
  Side effect: `.bak` is usually only ~20 s older than the file.
- **Open** (`IO.readProjectFrom` -> `deserialize`) parses the whole JSON and
  decodes every drawing into a full-size canvas before showing anything.
- **File access** (`isProject`, `writableFiles`): the renderer may read any
  absolute `*.otoon`; may write only paths that came from the Save dialog,
  a successful read, or a *new* sibling of a writable file (Save Increment).
- **CLI** (`--render scene.otoon`) boots the same renderer hidden and goes
  through `readProjectFrom`, so it inherits whatever open path we build.

### Baseline measurement (this machine, Electron 44.7, dev runner)

Synthetic scene made by `tests/bench-format.cjs` (no outside artwork):
1920x1080, 12 layers (10 raster, 2 vector), **300 drawings**, each with a
colour fill and 40 random pencil lines. Two runs:

| What | Run 1 | Run 2 |
|---|---|---|
| File size | 39.5 MB | 39.5 MB |
| Save, total (first save) | 4.35 s | 3.96 s |
|  of which `serialize` (PNG re-encode of every cel, **UI frozen**) | 4.17 s | 3.80 s |
|  `JSON.stringify` | 86 ms | 78 ms |
|  IPC + atomic write + `.bak` (40 MB) | 98 ms | 81 ms |
| Second full save (what the 20 s timer does after any edit) | 2.68 s | 2.43 s |
| Encode ONE raster drawing to PNG | 11.6 ms (106 KB) | 12.1 ms |
| Open: read + parse + decode all 300 | 2.83 s | 2.73 s |
| Open: until first paint | 2.91 s | 2.79 s |
| Renderer memory before open / after open | 538 / 760 MB | 541 / 770 MB |

What the numbers say:

1. **The cost is PNG encoding, not the disk.** Writing 40 MB atomically
   takes ~0.1 s; re-encoding 300 drawings takes ~2.5-4 s, on the UI thread.
   With the 20 s timer, an artist working on a 300-drawing scene gets a
   2.5-4 s freeze every 20 s while drawing. This gets linearly worse.
2. Any design that **re-encodes only changed drawings** removes almost all
   of it (1 changed drawing = ~12 ms). Whether the bytes then land in a zip
   or a folder matters much less for speed than for safety, sharing and
   OS behaviour.
3. Open is dominated by decoding every drawing up front; lazy loading
   (decode only what the current frame needs) is the fix for both time and
   memory. (Renderer memory understates the real cost: cel canvases are
   GPU-backed; the "Memory per drawing" item covers that.)

Re-run with `node tests/bench-format.cjs [drawings]`; the same script will
give the "after" numbers.

## 2. What the new format contains (same for every option)

```
scene.json                 layers, xsheet/exposures, keys, pivots, palettes,
                           camera, audio/video refs, workspace, metadata,
                           format: "finca", version: 3
drawings/<layerId>/<num>-<hash>.png    raster cel (PNG bytes, not base64)
drawings/<layerId>/<num>-<hash>.json   vector cel { strokes, eraserMarks }
media/<hash>.<ext>         imported audio / video (raw bytes)
thumbnail.png              small preview of frame 1 (for the start screen,
                           later for OS thumbnailers)
```

- `scene.json` is today's v2 JSON with each cel replaced by a reference:
  `{ k: 'r'|'v', src: 'drawings/...' , w, h }`. Same field names, so the
  v2 `deserialize` logic is reused and `.otoon` import is a small adapter.
- `version: 3` continues the existing `FORMAT_VERSION` counter, so the
  Phase 0 "newer file -> warn, never overwrite" rule keeps working.
- File names carry a short content hash (SHA-1 of the bytes, first 12 hex).
  A changed drawing gets a **new** name, never an overwrite in place. This
  is what makes crash-safe incremental saves and cheap history possible.
- **Serialising never depends on `cel.canvas`** (constraint from the
  memory-per-drawing work, where vector cels will be rasterised lazily and
  `cel.canvas` may be empty): vector cels are written from `strokes` /
  `eraserMarks` only; raster cels from their pixel data; drawings that were
  never loaded are carried over as their stored bytes, never decoded.
- **Change tracking.** Each cel remembers the entry it came from
  (`cel.src`) and a "saved" marker. Raster: re-encode if `cel._rev` moved
  since load/save (false positives just cost ~12 ms). Vector: `_rev` is
  also bumped by `rebuild()` (re-rasterising), so it can't be trusted; we
  hash the stroke JSON instead (cheap, no canvas). Unloaded cels: unchanged
  by definition.

## 3. The three options

### (a) `.finca` = one zip file

A normal zip (the same container idea as `.docx`, `.kra`, `.ora`). First
entry is an uncompressed `mimetype` file containing
`application/x-finca-animate`, so Linux can recognise the file by content
(the trick ODF and EPUB use). PNGs are stored uncompressed inside the zip
(they're already compressed); JSON entries are deflated.

- **Saving**: build a new zip in a temp file next to the original. Changed
  drawings are encoded and added; **unchanged entries are copied byte for
  byte from the old zip** (no decode, no re-encode). fsync, keep `.bak`,
  rename over. CPU work is incremental; disk work is the whole file
  (~0.1 s per 40 MB, ~2-4 s at 1.5 GB), done in the main process so the UI
  never freezes.
- **Crash safety**: same as Phase 0. The original is untouched until the
  final rename; a crash leaves the old file or the new one.
- **`.bak`**: the previous file, as a full copy (doubles disk use).
- **Autosave**: if the 20 s timer keeps writing the real file, a huge scene
  rewrites its whole file every 20 s. History snapshots are full copies (8 x
  1.5 GB = 12 GB for a long shot). Workable for small scenes, wasteful for
  big ones.
- **Lazy loading**: main process reads the zip's table of contents once and
  hands out single entries on request (random access, cheap).
- **OS**: looks and behaves like one document everywhere. Double-click
  opens it, it gets the `.finca` icon, Windows and Linux file associations
  work, Explorer does not treat it as a zip (unknown extension). Dialogs:
  normal "open file".
- **Sharing**: one file to email, upload, put on a USB stick. (Email limits,
  ~25 MB, still apply; big scenes need a cloud link.)
- **Risk**: one corrupt byte in the wrong place (the table of contents at
  the end) makes the whole file look broken; mitigated by `.bak`, by
  writing via temp + rename, and by a "salvage" reader that scans local
  headers when the table of contents is damaged.

### (b) `.finca` = a folder

`MyScene.finca/` containing the files above, loose.

- **Saving**: write only the changed drawing files (each atomically, under
  new hashed names), then atomically replace `scene.json`. That rename is
  the single "commit" moment. Old drawing files no longer referenced by
  `scene.json` or `scene.json.bak` are deleted afterwards. Truly incremental
  on CPU *and* disk: one changed drawing = one ~100 KB file + `scene.json`.
- **Crash safety**: good: before the commit the old `scene.json` still
  points at the old, untouched drawings; after it, at the new ones. A crash
  can leave a few orphan files, cleaned up next save.
- **`.bak`**: `scene.json.bak` plus keeping the drawings it references:
  almost free.
- **Autosave history**: a snapshot is just a copy of `scene.json` (the
  drawings are shared): cheap at any size.
- **Lazy loading**: trivial, one file per drawing.
- **OS (the big catch)**: on both Windows and Linux it **is a folder**.
  - Double-click opens Explorer / Files, not Finca Animate. Folders can't
    have file associations, and the "Finca Animate Project" icon and
    `application/x-finca-animate` type in requirement 7 can't apply (Linux
    types every folder as `inode/directory`; Windows custom folder icons
    need `desktop.ini` + system attributes and don't survive copying).
  - The Open dialog can't pick files and folders at the same time on
    Windows/Linux, so we'd need a separate "Open Project Folder" or "open
    the scene.json inside" (this is how Harmony does it: you open the
    `.xstage` file inside the scene folder).
  - Nothing stops someone deleting or renaming one drawing inside it.
  - Windows: thousands of small files copy slowly, antivirus scans each
    one, and deep paths can hit the 260-character limit.
- **Sharing**: can't be emailed or uploaded as-is; you zip it first.
  Folder-sync tools (Syncthing, Nextcloud, Dropbox) handle it well, even
  better than one big file.

### (c) Hybrid: one `.finca` zip outside, folder-style saving inside (recommended)

The artist only ever sees (a): one `.finca` file. Inside the app, saving
works like (b):

- **Working journal.** While a scene is open, the 20 s timer writes only the
  changed drawings plus `scene.json` into a per-scene recovery folder in the
  app's settings folder (`userData/recovery/<scene-id>/`), using the (b)
  commit protocol. That is fast at any scene size and crash-safe. Unsaved
  scenes use the same mechanism (replacing today's `autosave.otoon`).
- **Autosave history** lives in that recovery folder: one snapshot per
  5 minutes, newest 8, as before, but each snapshot is a `scene.json` copy
  sharing the drawing files (hard links or reference counting), so history
  is cheap even for huge scenes. Recover Autosave keeps its current UI.
- **The `.finca` file** is written with the (a) method (changed drawings
  encoded, unchanged entries copied byte for byte, temp + rename) on:
  Ctrl+S, Save Increment, closing the scene, and in the background every
  2 minutes while dirty (so "the file is kept current without Ctrl+S"
  still holds, without rewriting a 1.5 GB file every 20 s). Encoding work
  done for the journal is reused, so packing is mostly a disk copy in the
  main process; the UI does not freeze.
- **`.bak`**: refreshed on Ctrl+S and on the first write of a session (not
  on every background write), so it really is "the version before you
  started / last chose to save", not "20 seconds ago". Full copy of the
  previous `.finca`.
- **After a crash**: on next launch the recovery folder is newer than the
  `.finca`, and the existing "Recover Autosave" prompt offers it. Nothing
  more than ~20 s of work is lost, and the `.finca` itself is never left
  half-written.
- **OS and sharing**: identical to (a) (single file, icon, double-click,
  email/upload).
- **Cost**: two mechanisms instead of one (about two extra days), and the
  recovery folder uses disk in the settings folder while a scene is open
  (deleted when the scene is closed cleanly; old ones pruned).

### Trade-off table

| | (a) zip file | (b) folder | (c) hybrid |
|---|---|---|---|
| What the artist sees | one file | a folder | one file |
| Double-click opens app / own icon | yes | **no** | yes |
| Email / upload / USB | as-is | must zip first | as-is |
| Save after 1 small change (UI freeze) | ~12 ms | ~12 ms | ~12 ms |
| Disk written per save | whole file | changed drawings only | journal: changed only; file: whole file every 2 min / Ctrl+S |
| Crash during save | old file intact | old version intact | old file intact + journal |
| `.bak` | full copy | almost free | full copy, refreshed on Ctrl+S |
| Autosave history at 1.5 GB scene | ~12 GB | tiny | tiny |
| Lazy loading | yes | yes (simplest) | yes |
| Can be broken by poking inside | hard | easy | hard |
| Windows many-small-files issues | none | yes | settings folder only |
| Extra code vs. (a) | - | about the same | + ~2 days |

## 4. Things that work the same in every option

### Open / import / export

- **Open** accepts `.finca`, `.otoon` v1 and v2 (filter "Finca Animate
  Project (*.finca)", "OpenToon Project (*.otoon)", "All projects").
- **Opening an `.otoon`** loads it the old way (all in memory: those files
  are self-contained JSON), marks the scene "imported", leaves
  `projectPath` empty. Ctrl+S, Save Increment and the 20 s timer then go
  through **Save As -> `<name>.finca`** in the same folder. The `.otoon` is
  never written. Opening an `.otoon` will no longer make it writable at all
  (file-access change).
- **Optional "File > Export > OpenToon (.otoon)"**: loads every drawing,
  writes a v2 `.otoon` JSON (base64 inside) through a Save dialog. Today a
  `.finca` holds nothing `.otoon` v2 can't, so nothing is lost for *this
  app*. But the **original OpenToon** app (upstream, writes format 1)
  ignores pivots, easing + curves, Line/Colour Art, swatch links and
  perspective guides; the export dialog says exactly that before writing.
  Any future `.finca`-only feature is added to that list.

### Lazy loading (basics only)

- Open reads `scene.json` and shows the scene with every cel as a
  lightweight placeholder (`cel.src`, size, no canvas yet).
- A cel is loaded when it is needed: compositing the current frame,
  onion skin / light table neighbours, thumbnails coming into view,
  playback (prefetch a few frames ahead), export / render (all frames,
  in order). Loading = ask main for the bytes -> `createImageBitmap` /
  `JSON.parse` -> canvas.
- Editing an unloaded cel loads it first (tools await it).
- No eviction yet: once loaded, a cel stays. Eviction belongs to "Memory per
  drawing" (see boundary below); the format only provides `load(cel)` and
  "is it safe to drop" (unchanged since last write).

### CLI

`--render scene.finca` uses the same lazy open, and Export walks frames in
order, so it loads drawings as it goes. Default output becomes
`<scene>.mp4` for `.finca` too. The render run's throwaway profile also
gets a throwaway recovery folder (never touches the user's). `.otoon`
input keeps working.

### File access rules (Phase 0, same strictness)

- `isProject` accepts `.finca` and `.otoon`, absolute paths only.
- The renderer never gets raw paths into a project's inside. New IPC is
  handle-based: `projectOpen(path) -> id` (only for a path from the Open
  dialog / argv / recent list, read-only for `.otoon`), `readEntry(id,
  name)` (name must match `scene.json | drawings/... | media/... |
  thumbnail.png`, no `..`, no absolute paths), `writeProject(id, changes)`.
- Writes only to `.finca` paths from the Save dialog, a successful
  `.finca` open, or a new sibling (Save Increment). Never to `.otoon`
  except through the Export dialog's own pick.
- Recovery-folder IPC takes scene ids, never paths (like
  `autosave-history-read` validates names today).
- `tests/phase0.cjs` gains the `.finca` versions of every existing check
  plus: entry-name tricks are refused; `.otoon` is read-only after open.

### Zip library

**Recommendation: no new runtime dependency.** We need a small subset:
STORE (PNG) and DEFLATE (JSON) entries, central-directory reading for
random access, raw copy of entries, and **ZIP64** (scenes over 4 GB or
65,535 entries; a 2-minute 1080p 10-layer scene on twos is ~14,000
drawings at ~1.5 GB, so we must not hit the limit silently).

- Main process: ~300 lines in a new `electron/finca-zip.js` using Node's
  built-in `zlib` (deflateRaw / inflateRaw) and `fs` positional reads.
  `src/io.js` already contains a store-only zip writer + CRC32 we can build
  on.
- Browser fallback (plain web build, no file system): STORE-only writer
  (the existing `OT.Zip`) to download a `.finca`, reader using Chromium's
  built-in `DecompressionStream('deflate-raw')`.
- If we'd rather not own zip code: **yauzl** (read) + **yazl** (write),
  MIT, by Josh Wolfe, small, no native code, ZIP64 support, widely used.
  `fflate` (MIT) is faster but has no ZIP64, so it's out.

Option (b) needs no zip code for saving, but still needs a zip writer for a
"share as .zip" command.

### OS integration (requirement 7)

- `build.fileAssociations`: `.finca` first ("Finca Animate Project",
  `application/x-finca-animate`, `assets/finca-file.ico`), `.otoon` kept.
- Linux: the per-user installer / `.desktop` gets a shared-mime-info XML
  (glob `*.finca` + zip magic: the name `mimetype` at byte 30 and `application/x-finca-animate` at byte 38, as ODF does) so file managers
  show the icon and open it with Finca Animate.
- `argvFile`, the single-instance hand-off and drag-onto-exe accept
  `.finca`.
- Windows `rename` over a file that the indexer, antivirus or OneDrive
  has open can fail with EPERM/EBUSY; the atomic write gets a short
  retry-with-backoff (Phase 0 has the same latent issue today).

## 5. Ownership boundary

Agreed with the feature session ("opentoon studio harmony gap") that owns
the rest of Phase 1:

- **This work (format v2) owns**: the container, `serialize` /
  `deserialize`, every save / open / autosave / recovery / `.bak` path,
  the file-access IPC, `.otoon` import/export, the CLI's file input,
  file associations and icons.
- **The feature session owns**: memory per drawing (lazy rasterisation of
  vector cels, cache eviction), offline ffmpeg export, the performance
  budget. It stays out of save/load code.
- **Contract between them**: the format never reads `cel.canvas` for vector
  cels and never requires a cel to be resident to save it (unchanged,
  unloaded cels are copied as stored bytes). It exposes
  `IO.loadCel(cel)` and `cel.isSaved()` so eviction can drop a cel safely
  and bring it back. A *changed* raster cel that eviction wants to drop must
  be written to the recovery journal first (an `IO.flushCel(cel)` hook).

## 6. Recommendation

**(c) Hybrid.** It is the only option that gives Julio one double-clickable
`.finca` file with its own icon (what requirement 7 asks for and what an
artist expects to email or copy), *and* fast, crash-safe saves plus cheap
autosave history for long shots. (a) alone is fine for short scenes but
rewrites big files every 20 s and makes history very large; (b) is the
fastest and simplest to build but is a folder everywhere: no icon, no
double-click, can't be emailed, easy to damage.

If simplicity matters more than long shots, (a) is a reasonable smaller
step: (c) can be added later without changing the file format, because
the journal is internal to the app.

## 7. Migration plan

1. `.otoon` files keep opening forever (v1 and v2 readers stay).
   Nothing is converted automatically or in bulk.
2. Opening an `.otoon` shows it normally; the first save asks for a
   `.finca` name (pre-filled, same folder). The `.otoon` stays untouched.
3. Recent projects: existing `.otoon` entries stay; after Save As the new
   `.finca` replaces that entry.
4. Existing `autosave.otoon` / `autosave-history/*.otoon` in the settings
   folder are still offered by Recover Autosave (read-only) for one release,
   then ignored. Internal names may stay `otoon` where only the app sees them.
5. New projects save as `.finca` by default; the browser build downloads
   `.finca` too.
6. Release notes (v1.1.0-beta.2): ".finca is the native format; .otoon
   files still open; use Export > OpenToon to share with the original app".

## 8. Test plan (requirement 8)

New `tests/finca-format.cjs` (Electron, throwaway profile, run in CI as
part of `test:files`) plus updates to existing suites:

1. **Round trip**: synthetic `.otoon` (raster + vector + audio + pivots +
   easing + palettes + camera) -> open -> Save As `.finca` -> reopen ->
   deep-equal scene data and pixel-equal drawings vs. the original; the
   `.otoon` bytes unchanged.
2. **Incremental save**: open a `.finca`, change 1 raster and 1 vector
   drawing, save; the save reports exactly 2 entries encoded, all other
   entries byte-identical (same CRC/offsets copied), and (c) journal wrote
   exactly those 2 drawing files + `scene.json`.
3. **Crash during save**: kill the main process (a test hook that throws /
   `process.kill` between temp write and rename, and between journal
   writes and commit); the `.finca` still opens as the previous version;
   no temp files left after the next successful save.
4. **Lazy loading**: the 300-drawing bench scene opens with only the
   current frame's drawings loaded (counter on `IO.loadCel`), and loading
   the rest happens on seek/playback.
5. **Export .otoon**: output opens in this app identically; the warning
   lists the features the original OpenToon drops.
6. **File access** (`tests/phase0.cjs`): all current checks for `.finca`,
   entry-name traversal refused, `.otoon` not writable after open.
7. **CLI** (`tests/render-cli.cjs`): render from `.finca` to every output
   type; default output name.
8. **Numbers**: `tests/bench-format.cjs` before/after (time, size, memory)
   on the 300-drawing scene, reported in the PR / release notes.
9. `npm test`, `npm run test:electron`, `npm run test:render`,
   `npm run test:files` and CI on the fork green. (CI runs tests on Linux
   only; the Windows-specific rename retry is unit-tested with a simulated
   EBUSY.)

## 9. Effort estimate

Counted in focused working days (Claude sessions plus Julio trying it):

| Piece | (a) | (b) | (c) |
|---|---|---|---|
| Scene split + v3 serializer, change tracking | 1.5 | 1.5 | 1.5 |
| Container (zip with ZIP64 + raw copy / folder commit + cleanup) | 2 | 1.5 | 2 |
| Journal + cheap history in settings folder | (0.5, plain) | (included) | 1.5 |
| Lazy cel loading in the renderer | 1.5 | 1.5 | 1.5 |
| Open/Save As/.otoon import + Export .otoon | 1 | 1.5 (folder dialogs) | 1 |
| File-access IPC + phase0 tests, CLI | 1 | 1 | 1 |
| File association, icon, Linux mime | 0.5 | n/a | 0.5 |
| Tests, bench, docs, fixes | 1.5 | 1.5 | 2 |
| **Total** | **~9.5 days** | **~9 days** | **~11 days** |

Export > OpenToon (.otoon) is about half a day of that and can be dropped.

Expected after the change (estimates to be verified by the bench): saving
after a small edit goes from 2.5-4 s of frozen UI to well under 0.1 s; the
300-drawing scene opens to first paint in ~0.3 s instead of ~2.8 s; files
shrink by about a quarter (no base64).
