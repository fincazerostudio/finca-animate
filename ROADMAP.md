# Finca Animate Roadmap

Goal: a 2D animation studio you can trust with real projects, then parity
with Toon Boom Harmony where it matters for character animation.

Order of work: **protect the artist's work first, then scale and output,
then features.** A missing feature costs an afternoon; a corrupted scene
costs a week.

---

## Phase 0 — Protect the work ✅

- [x] **Safe saves.** Temp file + rename (atomic), previous version kept as
      `scene.finca.bak`.
- [x] **Autosave history.** A snapshot at most every 5 minutes, newest 8
      kept; File → Recover Autosave… opens one as an unsaved copy.
- [x] **File-format versioning.** Native format 3; `.otoon` formats 1 and 2 still import. Files from a newer version open
      with a warning, and Save becomes Save As so the original is never
      overwritten with data missing.
- [x] **Continuous testing.** `.github/workflows/tests.yml` runs `npm test`,
      the packaged-app, render and file-safety tests on every push. The
      flaky lasso check now feeds realistic pen timing.
- [x] **Tighter file access.** The renderer can only read `.finca` and `.otoon` files and
      only write projects it opened, picked in a dialog, or new increments
      next to them.

## Phase 1 — Scale and output *(before relying on it for long shots)*

- [x] **Memory per drawing (vector).** Cels allocate their full-resolution
      surface (≈8 MB at 1080p) only when it is first used; vector drawings
      rasterise from their strokes on demand, and cached vector surfaces are
      kept under a budget (default 1 GB, `settings.celMemoryMB`), releasing
      the ones furthest from the playhead first. Opening a 300-drawing
      1080p vector scene went from ≈2.4 GB of surfaces to none.
- [x] **Memory per drawing (raster).** Far-away drawings are parked as PNG
      bytes in the project file or memory, loaded ahead of the playhead, and
      released under the same surface budget as vector drawings.
- [x] **Native `.finca` project format.** One ZIP64 container with scene
      metadata and separate drawings. Saves encode changed drawings and copy
      unchanged entries. Raster PNGs are cropped with placement coordinates;
      vectors are saved from strokes. Existing `.otoon` projects open as
      imports and save to a new `.finca` file. Includes file associations,
      icons, atomic saves, backups and autosave history.
      Design and schema: `docs/finca-format-design.md`.
      Optional OpenToon export remains undecided.
- [x] **Offline, frame-accurate export.** ffmpeg encodes H.264/H.265,
      ProRes 4444, PNG/QuickTime and VP9, with sample-aligned audio.
      `--render` uses the same path. MP4/WebM retain a real-time fallback
      when ffmpeg is unavailable.
- [x] **Performance budget.** `npm run test:perf` checks open/save time,
      playback, scrubbing and memory for a 2-minute, 1080p, 10-layer scene.
      All eight targets pass; measurements: `docs/performance-budget.md`.

## Phase 2 — Character rigging *(builds on pegs, pivots and curves)*

- [x] **Drawing substitution.** Thumbnail picker for existing drawings on
      a layer, current-frame or remaining-held-exposure replacement, undo/redo.
- [ ] **Library.** Reusable drawings, rigs and templates across projects.
- [ ] **Lip-sync.** Detect phonemes in the soundtrack, map them to mouth
      drawings via substitution, editable in the timeline.
- [ ] **Deformers.** Bone and curve deformers that bend a drawing, with IK
      on chains of pegs/bones.
- [ ] **Master controllers & morphing.** One control driving several
      layers; in-betweens generated between two vector drawings.

## Phase 3 — Look and finish

- [ ] **Gradient fills** (linear/radial) for the bucket and shapes,
      linkable to palette swatches.
- [ ] **Variable-width line editing.** Reshape thickness along a stroke
      after drawing.
- [ ] **Pencil / texture line styles** on vector strokes.
- [ ] **Effects:** blur, glow, drop shadow, tone/highlight, colour override,
      cutter/masking; particles later.
- [ ] **Multiplane camera:** layer depth and parallax camera moves.

## Phase 4 — Pipeline

- [ ] **Import:** SVG as editable strokes; PSD layers as bitmap layers.
      *(Toon Boom TVG is proprietary with no public spec; not planned.)*
- [ ] **Multi-scene projects / storyboard view.**
- [ ] **Scripting API.** The Scripting Console exists; document a stable
      API on top of it (scene, layers, drawings, keys, export).
- [ ] **Node compositing view** over the effects above.

## Ongoing — Maintainability

- [ ] Split `src/tools.js` (≈4,300 lines) into one file per tool.
- [ ] Type-check with `// @ts-check` + JSDoc, file by file, starting with
      the data model (`core.js`, `io.js`).
- [ ] Every feature lands with a test in `npm test`.

---

## Done

**Drawing & painting**
- [x] Paperless raster drawing engine; brush / pencil / eraser with pressure
- [x] Vector layers: smooth spline strokes, de-jitter, auto-connect
- [x] Smart paint bucket with gap closing and hover preview
- [x] Shape tools + fill, eyedropper, select + free transform
- [x] Vector stroke editing (erase, select / move / delete)
- [x] Line Art / Colour Art on vector drawings (Alt+C)
- [x] Linked palette colours (edit a swatch → linked strokes recolour)
- [x] Colour palette, HSV picker, palette library / import / export

**Timeline & animation**
- [x] Project model (scene, layers, cels, exposure xsheet)
- [x] Timeline / xsheet editing: drag cels, extend exposure, thumbnails,
      copy / cut / paste drawings, insert / remove frames
- [x] Onion skinning; light table (Alt+L); Shift & Trace (Alt+S)
- [x] Playback (loop / ping-pong, in/out range), audio waveform + sync
- [x] Camera framing + camera keyframes
- [x] Cut-out: transform keyframes, pegs (folders inherit transforms),
      per-layer pivots, Transform tool (A) with a box that fits the drawing
- [x] Easing presets and a function-curve editor (bezier, per channel)

**Aids**
- [x] Grid, rule-of-thirds, symmetry / mirror, perspective guides (1/2-point)
- [x] Flip / rotate canvas; Wacom eraser-flip

**Files & output**
- [x] Save / load `.finca`, import `.otoon` + autosave; canvas resize after drawing
- [x] Import images and video (frames + audio) as reference
- [x] Export GIF / MP4 / WebM / PNG sequence / single frame
- [x] Command-line batch render (`--render`)
- [x] Licence notices shipped with builds

**Desktop**
- [x] Basic JavaScript scripting console (Help menu; `app` and `OT` in scope)
- [x] Electron app with updates (Windows: automatic; Linux: approval-based,
      per-user install / rollback)
- [x] Pen-display drawing window; settings persist between sessions
