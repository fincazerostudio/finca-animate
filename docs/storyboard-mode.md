# Storyboard mode

Finca Animate's Storyboard Pro: boards, captions and the animatic in the same
app and the same files as the animation. It replaces Finca Storyboard (the
Ztoryc/Tahoma2D copy), whose model kept leaking Tahoma into the workflow.

## How it works

- A project with `project.board` is a storyboard. It holds `scenes` and
  ordered `panels`, each with a scene, a duration in frames, dialogue,
  action notes, notes and a transition.
- Panels play back to back, so the animatic is ordinary playback, and every
  export (MP4, ProRes, GIF, PNG sequence) renders it.
- Layers are the project's layers, as in Harmony. Each panel has its own
  drawing on each layer: drawing on an empty layer exposes the new drawing
  for the whole panel (`Layer.drawingAt` via `OT.boardSpan`).
- Panel edits (new, duplicate, delete, duration, move, new scene, rename
  scene) are single undo steps, because the structural snapshot carries the
  board. Insert / Remove Frame lengthen or shorten the current panel.
- The board is saved in both `.otoon` and `.finca` (`board`, next to the
  untouched `storyboard` block that Finca Storyboard exports write).

Code: `src/board.js` (model, operations, strip, Panel section),
`src/board-pdf.js` (PDF export), plus small hooks in `core.js`, `main.js`,
`io.js`, `ui.js`, `timeline.js`, `launcher.js` and `styles/main.css`.
Tests: `tests/storyboard.cjs`.

## Done

- Thumbnail strip: S#/P# numbering, durations, captions, scene breaks; click
  to go, drag to reorder; + Panel, Duplicate, Delete, + Scene.
- Scene / Panel section: scene name, duration (seconds or frames),
  transition, dialogue, action notes, notes.
- Panels on the timeline: a band on the ruler and a line where each panel
  starts; scene starts in coral.
- Storyboard menu, File > New Storyboard, the launcher's Storyboard template.
  Keys: N new panel, PgUp / PgDn previous / next panel, Enter plays the
  animatic.
- PDF export: 3 per page (rows, captions beside), 6 per page, 1 per page;
  Letter or A4.

## Next

1. **Overview:** a full-screen grid of every panel (Storyboard Pro's
   Thumbnails view), to read and reorder the whole board at once.
2. **Camera per panel:** pan / zoom / rotate inside a panel, drawn as
   start / end frames on thumbnails and in the PDF.
3. **Transitions that render:** dissolve, fade and wipe in playback and in
   exports, not only as a label.
4. **Animatic burn-in:** scene / panel number, timecode and dialogue on the
   exported movie.
5. **Script in, panels out:** import a `.fountain` / `.fdx` script into
   scenes and panels with their dialogue and action; images as panels.
6. **Per-panel layers:** a layer that exists only in some panels, and per-panel
   visibility, as in Storyboard Pro.
7. **Editorial:** EDL / FCP XML out, and conform back in (the Finca
   Storyboard work, redone on this model).
8. **Hand-off to animation:** turn a scene into its own Finca Animate scene,
   with the panels as a locked reference layer and the timing kept.
9. **Sound:** scene-level audio clips on the timeline.
