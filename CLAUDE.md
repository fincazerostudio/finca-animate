# Finca Animate / OpenToon Studio: agent notes

This is the user's fork of OpenToon Studio (helliott20/opentoon, MIT), a 2D animation app in the style of Toon Boom Harmony. It is plain browser JavaScript with no bundler (`index.html` loads `src/*.js` in order) wrapped in Electron (`electron/main.js`), and is published as **Finca Animate**. Remotes: `origin` = upstream, `fork` = fincazerostudio/finca-animate. Keep `origin` pointed at upstream, because `tools/linux/user-install.sh` fetches release tags from it.

## Branches (check which one you're on first)
- `linux-support` (the main checkout, `~/Projects/finca-animate`): plain OpenToon plus the Linux port. It backs upstream PR #1, so no Finca branding and no fork-only features here.
- `feat/*`: feature work, one worktree each under `.claude/worktrees/`. `feat/phase0` is the newest feature tip (curve-editor → phase0). `feat/finca-format` holds the `.finca` zip-format design (paused).
- `finca-animate`: the release branch and the fork's default (rename, appId `com.fincazero.animate`, publish config, `.github/workflows/release.yml`, version 1.1.0-beta.x). Change package.json `build`/publish and release.yml **only** there, never on feat/*.
- Releases: merge the newest feat branch into `finca-animate`, bump the version, add `.github/release-notes/<tag>.md`, tag `v*`. CI then builds a DRAFT release that is published by hand.
- The user-facing rename only: keep `.otoon`, `~/.config/opentoon`, the `OPENTOON_*` env vars and IPC ids unchanged.

## Layout
- `src/`: app modules (`core.js` model, `canvas.js`/`composite.js` rendering, `vector.js`, `tools.js`, `timeline.js`, `io.js` save/load/export, `ui.js`, `main.js` boot). `styles/`, `pen/` (pen window), `splash/`, `fonts/`, `assets/`.
- `electron/`: main process, preloads, `update-check.js` (Linux updates need approval).
- `tests/*.cjs`: headless Playwright-core tests. The browser is picked by `tests/launch-browser.cjs` (`OPENTOON_TEST_BROWSER` overrides it).
- `tools/`: `genicons.cjs` (icons), `check-update.cjs`, `linux/user-install.sh` (per-user install/update/rollback).
- Ignore `node_modules/`, `dist/` (~400 MB of build output), `tests/*.png`, the stray root `*.png`, and other branches' worktrees under `.claude/worktrees/`.

## Commands (package.json)
- `npm install`, `npm run dev` (Electron with live reload), `npm start`, `npm run dist:linux` (AppImage + unpacked), `npm run dist` (Windows NSIS).
- `npm test` runs the full headless suite. `npm run test:electron` is the smoke test. The `features2.cjs` LASSO test is a known timing flake under full-suite load.

## Gotchas
- Installed apps: OpenToon at `~/.local/opt/opentoon-studio` (update only via `opentoon-studio-update check|update|rollback`, and only after the user approves a version). Finca Animate at `~/.local/opt/finca-animate`. Both share `~/.config/opentoon`.
- Public repo docs may contain plans but no time or effort estimates. Those go in `~/Documents/Finca Animate Notes/`.

## Docs
- `README.md`, `BUILD.md` (desktop build/distribution), `ROADMAP.md` (Harmony parity), `docs/superpowers/` (older design specs and plans).
