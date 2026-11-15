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
// FZ renders each theme's terminal artwork here (Kitty's background_image)
const RENDER_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'fz', 'theme');

// The theme's artwork and tint, exactly as FZ hands them to Kitty, when the
// render in ~/.cache/fz/theme/current is for theme `id` (a switch renders it
// a moment after the state changes).
function artwork(id) {
  try {
    const conf = fs.readFileSync(path.join(RENDER_DIR, 'current', 'kitty-theme.conf'), 'utf8');
    const forId = (conf.match(/theme:\s*([A-Za-z0-9_]+)/) || [])[1];
    if (id && forId !== id) return null;
    const img = (conf.match(/^background_image\s+(.+)$/m) || [])[1];
    if (!img) return null;
    const tint = parseFloat((conf.match(/^background_tint\s+([\d.]+)/m) || [])[1] || '0.8');
    const file = img.trim();
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    const st = fs.statSync(file);
    if (st.size > 24 * 1024 * 1024) return null;
    return { url: 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64'), tint, key: id + ':' + st.mtimeMs + ':' + st.size };
  } catch (e) { return null; }
}

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
    return { id, name: t.meta.display_name || id, palette, artwork: artwork(id) };
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
        resolve(t ? { id: t.id, name: t.name, palette: t.palette, artwork: artwork(t.id) } : null);
      } catch (e) { resolve(null); }
    });
  });
}

function get() {
  try { const t = fast(); if (t) return Promise.resolve(t); } catch (e) { /* fall back */ }
  return catalog();
}

// cb(theme) whenever the desktop theme or its artwork changes; returns a stop function
function watch(cb) {
  let timer = null, last = null;
  const key = t => t ? t.id + '|' + (t.artwork ? t.artwork.key : '') : null;
  const check = () => get().then(t => { const k = key(t); if (t && k !== last) { last = k; cb(t); } });
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 250); };
  get().then(t => { last = key(t); });
  const watchers = [];
  try { watchers.push(fs.watch(STATE_DIR, (ev, name) => { if (!name || name === 'theme') soon(); })); } catch (e) { /* no FZ state */ }
  // the artwork is rendered a moment after the switch: watch the render folder too
  try { watchers.push(fs.watch(RENDER_DIR, () => soon())); } catch (e) { /* not rendered yet */ }
  return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
}

module.exports = { get, watch, _readToml: readToml };
