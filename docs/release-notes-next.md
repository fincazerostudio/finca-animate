# Next Finca Animate beta (unreleased)

- Native `.finca` projects: incremental drawing encoding, cropped raster
  storage, lazy loading, atomic saves, backups and autosave history.
- Existing `.otoon` projects still open and save into new `.finca` files.
- Raster drawings now share the configurable cel surface memory budget.
- Frame-accurate ffmpeg export: H.264, H.265, ProRes 4444, PNG MOV and VP9,
  with sample-aligned audio. ffmpeg must be available on the system when
  it is not bundled; MP4/WebM retain a real-time fallback.
- Preserve storyboard metadata and reference layers from other Finca tools.
- Timeline rendering uses the visible scroll area for long scenes.
- The two-minute, 1080p, ten-layer performance scene passes all eight
  targets; see `performance-budget.md` for measurements and conditions.

This is a feature-branch preview. No release or installed-app update has
been performed. Optional OpenToon export is not included.
