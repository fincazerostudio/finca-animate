/* Interface themes: Classic, Harmony Graphite, Paper, and Follow FZ theme
 * (the Finca Zero desktop's live theme, like Kitty follows it).
 *
 * A theme is a ramp of seven neutrals (edge, bg, panel, panel2, panel3,
 * text-dim, text) plus accents. Every interface colour is a variable
 * (styles/main.css named palette + the --c-<hex> colours from
 * tools/theme-tokenize.cjs); a theme sets the named ones directly and maps
 * each --c-<hex> by role: greys by brightness onto the ramp, accents by hue.
 * The timeline is drawn on a canvas, so its fill / stroke colours go through
 * the same mapping. Drawings are never touched.
 */
(function (OT) {
  'use strict';

  // Classic's ramp: the reference the --c-<hex> colours are placed on
  const CLASSIC = ['#080a0c', '#14161a', '#1f2228', '#272b32', '#343942', '#7d838f', '#cdd2d9'];
  const PRESETS = {
    graphite: { name: 'Harmony Graphite', dark: true,
      ramp: ['#1e1e1e', '#2b2b2b', '#383838', '#424242', '#4d4d4d', '#a0a0a0', '#e2e2e2'],
      accent: '#4a90d9', accentLo: '#3b7cc2', hot: '#f0962d', ok: '#6fb36f', amber: '#f0962d', cream: '#f2f2f2' },
    paper: { name: 'Paper', dark: false,
      ramp: ['#cfc9bd', '#e8e4dc', '#f6f3ee', '#efebe4', '#e4dfd6', '#6e685e', '#2b2824'],
      accent: '#2f6fb0', accentLo: '#285f98', hot: '#c4452f', ok: '#3c8a4c', amber: '#c4701a', cream: '#3a352f' }
  };
  const CHOICES = [['fz', 'Follow FZ Theme'], ['graphite', 'Harmony Graphite'], ['paper', 'Paper'], ['classic', 'Classic']];

  /* ----------------------------- colour maths ----------------------------- */
  // '#rgb' '#rrggbb' '#rrggbbaa', 'rgb()/rgba()'; qt=true reads 8 digits as #aarrggbb (FZ / Qt)
  function parse(s, qt) {
    if (typeof s !== 'string') return null;
    s = s.trim();
    let m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split('').map(c => c + c).join('');
      if (h.length === 8 && qt) h = h.slice(2) + h.slice(0, 2);
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    return null;
  }
  const hex2 = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  const fmt = (c, a) => (a >= 0.999 ? '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) : '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + hex2(a * 255));
  const lum = c => (c.r + c.g + c.b) / 765;
  const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  function hsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return { h: 0, s: 0, l };
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s, l };
  }
  const ANCHORS = CLASSIC.map(s => lum(parse(s)));

  // A function mapping any Classic interface colour into theme `t`.
  function mapper(t) {
    const ramp = t.ramp.map(s => parse(s));
    const P = s => parse(s);
    const cache = new Map();
    return s => {
      if (typeof s !== 'string') return s;
      if (cache.has(s)) return cache.get(s);
      const c = parse(s);
      let out = s;
      if (c) {
        const L = lum(c), { h, s: sat, l } = hsl(c);
        if (L <= 0.001 || L >= 0.999) out = s;                     // pure black shadows, pure white
        else if (sat > 0.3 && l > 0.2 && l < 0.88) {                // an accent: by hue
          let to = null;
          if (h >= 180 && h <= 230) to = l > 0.5 ? t.accent : t.accentLo;
          else if (h < 22 || h >= 335) to = t.hot;
          else if (h >= 22 && h < 60) to = t.amber;
          else if (h >= 80 && h < 170) to = t.ok;
          out = to ? fmt(P(to), c.a) : s;
        } else if (L >= 0.9) out = fmt(P(t.cream), c.a);           // cream highlights
        else {                                                      // a grey: onto the ramp
          let i = 0;
          while (i < ANCHORS.length - 2 && L > ANCHORS[i + 1]) i++;
          const k = Math.max(0, Math.min(1, (L - ANCHORS[i]) / (ANCHORS[i + 1] - ANCHORS[i])));
          out = fmt(mix(ramp[i], ramp[i + 1], k), c.a);
        }
      }
      cache.set(s, out);
      return out;
    };
  }

  // An FZ catalog palette (Qt #aarrggbb colours) as a theme.
  function fromFZ(fz) {
    const p = fz && fz.palette;
    if (!p) return null;
    const C = k => parse(p[k], true);
    const bg = C('terminalBackground') || C('background'), text = C('textPrimary');
    if (!bg || !text) return null;
    const dark = lum(bg) < lum(text);
    const panel = C('surfaceAlt') || C('surface') || bg, elev = C('surfaceElevated') || panel;
    const dim = mix(C('textMuted') || text, C('textSecondary') || text, 0.5);
    const edge = mix(bg, dark ? { r: 0, g: 0, b: 0 } : { r: 120, g: 110, b: 100 }, dark ? 0.35 : 0.18);
    const f = c => fmt(c, 1);
    return { name: fz.name || fz.id, id: fz.id, dark,
      ramp: [f(edge), f(bg), f(panel), f(mix(panel, elev, 0.5)), f(elev), f(dim), f(text)],
      accent: f(C('accentPrimary') || C('borderActive') || text),
      accentLo: f(C('accentTertiary') || C('accentPrimary') || text),
      hot: f(C('error') || C('warning') || text), ok: f(C('success') || text),
      amber: f(C('warning') || C('error') || text), cream: f(text) };
  }

  /* -------------------------------- apply -------------------------------- */
  const NAMED = {
    '--edge': t => t.ramp[0], '--bg': t => t.ramp[1], '--panel': t => t.ramp[2], '--panel2': t => t.ramp[3],
    '--panel3': t => t.ramp[4], '--text-dim': t => t.ramp[5], '--text': t => t.ramp[6],
    '--accent': t => t.accent, '--accent-lo': t => t.accentLo, '--accent-glow': t => t.accent + '33',
    '--accent2': t => t.amber, '--hot': t => t.hot, '--ok': t => t.ok, '--cream': t => t.cream
  };
  let remap = s => s;           // Classic: colours as they are

  function applyTheme(t) {
    const st = document.documentElement.style;
    remap = t ? mapper(t) : (s => s);
    for (const k of Object.keys(NAMED)) { if (t) st.setProperty(k, NAMED[k](t)); else st.removeProperty(k); }
    if (t) st.setProperty('--line', remap('#0d0f1299')); else st.removeProperty('--line');
    for (const [k, v] of Object.entries(OT.THEME_COLORS || {})) {
      if (t) st.setProperty('--c-' + k, remap(v)); else st.removeProperty('--c-' + k);
    }
    st.colorScheme = t ? (t.dark === false ? 'light' : 'dark') : '';
    document.documentElement.dataset.fincaTheme = t ? (t.id || t.name) : 'classic';
    wrapCanvases();
    const app = OT.app;
    if (app) { if (app.timeline) app.timeline.render(); app.emit('render'); }
  }

  // the timeline draws with fixed colours: send them through the theme
  const wrapped = new WeakSet();
  function wrapCanvases() {
    const proto = CanvasRenderingContext2D.prototype;
    const D = {};
    for (const prop of ['fillStyle', 'strokeStyle']) D[prop] = Object.getOwnPropertyDescriptor(proto, prop);
    for (const cv of document.querySelectorAll('#timeline canvas')) {
      const ctx = cv.getContext('2d');
      if (!ctx || wrapped.has(ctx)) continue;
      wrapped.add(ctx);
      for (const prop of ['fillStyle', 'strokeStyle']) {
        Object.defineProperty(ctx, prop, { configurable: true,
          get() { return D[prop].get.call(this); },
          set(v) { D[prop].set.call(this, typeof v === 'string' ? remap(v) : v); } });
      }
    }
  }

  /* ------------------------------- choice ------------------------------- */
  const Theme = {
    choices: CHOICES,
    choice: 'classic',
    fz: null,                   // last FZ desktop theme seen
    async init(app) {
      const D = window.OpenToonDesktop && window.OpenToonDesktop.fzTheme;
      let saved = null;
      try { saved = localStorage.getItem('finca.theme'); } catch (e) { /* private window */ }
      if (D) {
        try { this.fz = await D.get(); } catch (e) { this.fz = null; }
        D.onChange(t => { this.fz = t; if (this.choice === 'fz') this.apply(); });
      }
      // first run on a Finca Zero desktop: follow it; elsewhere Classic
      this.choice = saved || (this.fz ? 'fz' : 'classic');
      this.apply();
    },
    set(choice) {
      this.choice = choice;
      try { localStorage.setItem('finca.theme', choice); } catch (e) { /* ignore */ }
      this.apply();
      const app = OT.app;
      if (app && app.ui) app.ui.status('Theme: ' + this.label());
    },
    label() {
      if (this.choice === 'fz') return 'Follow FZ theme' + (this.fz ? ' (' + this.fz.name + ')' : ' (FZ not found: Classic)');
      const c = CHOICES.find(x => x[0] === this.choice);
      return c ? c[1] : 'Classic';
    },
    current() {
      if (this.choice === 'fz') return fromFZ(this.fz);
      return PRESETS[this.choice] || null;
    },
    apply() { applyTheme(this.current()); },
    // exposed for tests and the mockup renderer
    mapper, fromFZ, presets: PRESETS
  };
  OT.Theme = Theme;
})(window.OT = window.OT || {});
