# Interface themes

View › Theme picks the look of the interface. Drawings are never recoloured.

- **Follow FZ Theme**: the Finca Zero desktop's active theme, live. Switch the
  desktop theme and Finca Animate recolours at once, the way Kitty follows it.
  This is the default on a Finca Zero desktop.
- **Harmony Graphite**: neutral mid-greys in the Toon Boom style.
- **Paper**: light panels and ink text, for daylight and pen displays.
- **Classic**: the original look. This is the default without Finca Zero.

## How it works

- `styles/main.css` keeps a named palette (`--bg`, `--panel`, `--accent`, …).
  Every other colour in a rule is a theme colour, `var(--c-<hex>)`, defined
  in a generated block with its original value. `tools/theme-tokenize.cjs`
  converts new fixed colours; `--check` fails if any are left (it runs in
  `tests/theme.cjs`). Write colours normally and rerun the tool.
- A theme is seven neutrals (edge, bg, panel, panel2, panel3, text-dim,
  text) plus accents. `src/theme.js` sets the named palette from it and maps
  each `--c-<hex>` by role: greys by brightness onto the neutrals, accents by
  hue. The timeline is drawn on a canvas, so its colours take the same
  mapping.
- Follow FZ Theme: `electron/fz-theme.js` reads the active theme from
  `~/.local/state/fz/theme` and its colours from that theme's `theme.toml`
  (the command center's `themes/`, then FZ Theme Manager's export), and
  watches the state file for switches. `fz-theme catalog --json` is the
  fallback. `FINCA_FZ_ROOT`, `FZ_THEME_EXTRA_ROOTS` and `FINCA_FZ_THEME_CMD`
  override where it looks.
- The choice is kept per user (`finca.theme` in local storage).
