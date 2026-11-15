/* Finca Zero desktop theme, for "Follow FZ theme" (src/theme.js).
 *
 * The active theme is in ~/.local/state/fz/theme (JSON, replaced atomically
 * on a switch); its colours are in <theme root>/<ID>/theme.toml. Reading
 * those two files is instant, so that is the main path. `fz-theme catalog
 * --json` (several seconds: it validates every theme) is only the fallback.
 * We watch the state file, so the app recolours the moment the desktop
 * does, the way Kitty follows it.
 *
 * Theme roots, as fz-theme-render finds them: the command center's themes/,
 * then FZ_THEME_EXTRA_ROOTS or FZ Theme Manager's export. FINCA_FZ_ROOT and
 * FINCA_FZ_THEME_CMD override the command center path and fz-theme. Without
 * FZ this returns null and the app keeps its own theme.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = os.homedir();
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'), 'fz');
const FZ_ROOT = process.env.FINCA_FZ_ROOT || path.join(HOME, 'Projects', 'finca-zero-command-center');

function themeRoots() {
  const extra = process.env.FZ_THEME_EXTRA_ROOTS != null
    ? process.env.FZ_THEME_EXTRA_ROOTS.split(path.delimiter).filter(Boolean)
    : [path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'fz-theme-manager', 'export', 'fz-packages')];
  return [path.join(FZ_ROOT, 'themes'), ...extra];
}

// theme.toml [colors] keys -> the catalog palette keys src/theme.js reads
const KEYS = {
  background: 'background', background_alt: 'surfaceAlt', surface: 'surface', surface_elevated: 'surfaceElevated',
  primary: 'accentPrimary', secondary: 'accentSecondary', accent: 'accentTertiary',
  success: 'success', warning: 'warning', danger: 'error',
  text_primary: 'textPrimary', text_secondary: 'textSecondary', text_muted: 'textMuted',
  border: 'border', border_active: 'borderActive', terminal_background: 'terminalBackground'
};

function readToml(file) {
  const out = { meta: {}, colors: {} };
  let section = '';
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1]; continue; }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (!kv) continue;
    if (section === 'metadata') out.meta[kv[1]] = kv[2];
    else if (section === 'colors' || section === 'terminal') out.colors[kv[1]] = kv[2];
  }
  return out;
}

function fast() {
  const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'theme'), 'utf8'));
  const id = state && state.activeTheme;
  if (!id || !/^[A-Za-z0-9_]+$/.test(id)) return null;
  for (const root of themeRoots()) {
    const file = path.join(root, id, 'theme.toml');
    if (!fs.existsSync(file)) continue;
    const t = readToml(file);
    const palette = {};
    for (const [k, v] of Object.entries(t.colors)) if (KEYS[k]) palette[KEYS[k]] = v;
    if (!palette.textPrimary) return null;
    return { id, name: t.meta.display_name || id, palette };
  }
  return null;
}

function catalog() {
  const cmd = process.env.FINCA_FZ_THEME_CMD || path.join(FZ_ROOT, 'scripts', 'fz-theme');
  try { fs.accessSync(cmd, fs.constants.X_OK); } catch (e) { return Promise.resolve(null); }
  return new Promise(resolve => {
    // it can exit non-zero while still printing the full catalog: trust parsed output
    execFile(cmd, ['catalog', '--json'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      try {
        const data = JSON.parse(stdout).data;
        const t = (data.themes || []).find(x => x.id === (data.state && data.state.activeTheme));
        resolve(t ? { id: t.id, name: t.name, palette: t.palette } : null);
      } catch (e) { resolve(null); }
    });
  });
}

function get() {
  try { const t = fast(); if (t) return Promise.resolve(t); } catch (e) { /* fall back */ }
  return catalog();
}

// cb(theme) whenever the desktop theme changes; returns a stop function
function watch(cb) {
  let timer = null, last = null, w = null;
  const check = () => get().then(t => { if (t && t.id !== last) { last = t.id; cb(t); } });
  get().then(t => { last = t ? t.id : null; });
  try {
    w = fs.watch(STATE_DIR, (ev, name) => {
      if (name && name !== 'theme') return;
      clearTimeout(timer);
      timer = setTimeout(check, 200);
    });
  } catch (e) { return () => {}; }
  return () => { clearTimeout(timer); if (w) w.close(); };
}

module.exports = { get, watch, _readToml: readToml };
