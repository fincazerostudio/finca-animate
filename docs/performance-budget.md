# Phase 1 performance budget

Measured on 2026-11-11 on the fz-razer Linux desktop, Electron 44.7.0,
using `FINCA_PERF_DIR=~/Documents npm run test:perf` (expanded to an absolute
path by the shell). Synthetic scene: two minutes, 1920×1080, 24 fps,
ten layers (eight raster, two vector), drawings on twos: 14,400 drawings
in a 65 MB `.finca`. This is one machine and synthetic artwork; it is a
regression baseline, not a guarantee for every scene or computer.

| Metric | Result | Budget |
| --- | ---: | ---: |
| Open to first paint (median of three) | 1,088 ms | ≤1,500 ms |
| Background save after one edit (median of three) | 185 ms | ≤500 ms |
| Ctrl+S, checking all drawings | 1,821 ms | ≤3,000 ms |
| Unchanged background save | 169 ms | ≤500 ms |
| Playback | 23.9 fps | ≥22 fps |
| Frames shown with drawings still loading | 0.7% | ≤5% |
| Scrub to complete frame (median) | 33 ms | ≤250 ms |
| Renderer memory after playback / scrubbing (maximum) | 1,270 MB | ≤2,048 MB |

A sequential drawing load took 0.7 ms (median), down from about 195 ms
before the timeline fix. The first Ctrl+S encoded one edited drawing;
14,400 other entries (including the thumbnail) were copied on the next
background save. Scrub worst case was 113 ms; no synchronous fallback
decodes were needed during this run.

## What changed

The apparent file-read slowdown came from timeline redraws blocking the
renderer. Profiling found 17 timeline redraws taking 2,974 ms, compared
with 15 ms of stage rendering. The old timeline allocated a canvas over
43,000 pixels wide and drew every frame on every update. It now uses a
viewport-sized canvas over a scroll spacer and visits visible frames and
rows. Input coordinates still refer to the complete timeline.

Explicit saves also retain custom vector entry names when the serialized
stroke content is unchanged. Native asynchronous SHA-256 fingerprints
avoid retaining another copy of vector JSON. Edits during hashing retain
the older saved stamp, so a later save still detects them.

The surface cache trims periodically, so its instantaneous surface count
can exceed its configured budget between passes. The memory target above
uses Electron renderer working-set metrics, as enforced by the harness.

## Validation

- `npm test`, including the long-timeline viewport and scrolled-input test.
- Phase-0 file safety: 26/26.
- `.finca` integration: 40/40 against the packaged app, including custom
  vector entry names, direct script edits and edits during asynchronous save.
- Render CLI / ffmpeg export: 25/25.
- Linux package build and packaged-app smoke test: 19/19.
- Ported `tests/bench-format.cjs`: exercised with 24 drawings.
- Full `npm run test:perf`: all eight targets passed.

Earlier runs taken while a separate C++ compilation saturated the host
had slower open/save times, higher memory use, and one renderer failure.
The passing run above was taken after that compilation ended. The
performance harness closes its temporary app even on failure.

Set `FINCA_PERF_PROFILE=1` to print optional entry-read and UI timing
counters. Use a disk-backed `FINCA_PERF_DIR`; `/tmp` is RAM-backed on the
reference machine.
