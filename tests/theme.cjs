/* Interface themes (src/theme.js): presets, Follow FZ theme, live change, Classic untouched */
const { launch, FILE } = require('./launch-browser.cjs');
const cp = require('child_process'), path = require('path');

(async () => {
  const checks = [], res = {};
  // the stylesheets carry no fixed colours outside the theme
  let tokOk = true;
  try { cp.execFileSync('node', [path.join(__dirname, '../tools/theme-tokenize.cjs'), '--check'], { stdio: 'pipe' }); } catch (e) { tokOk = false; res.tok = String(e.stdout || e.message); }
  checks.push(['every interface colour is a theme colour (theme-tokenize --check)', tokOk]);

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.removeItem('finca.theme'); } catch (e) {} const l = window.OT.app._launcher; if (l) l.close(); });

  const WISTERIA = { id: 'WISTERIA_DUSK', name: 'Wisteria Dusk', palette: {
    accentPrimary: '#CCA5F4', accentTertiary: '#BD92DF', background: '#E615101D', error: '#DD8F9D', success: '#ACCBA9',
    surface: '#EE211829', surfaceAlt: '#211829', surfaceElevated: '#39274C', terminalBackground: '#15101D',
    textMuted: '#786787', textPrimary: '#EFE3F7', textSecondary: '#D8C9E6', warning: '#E5C08B' } };

  res.r = await page.evaluate(async (W) => {
    const T = window.OT.Theme, root = document.documentElement;
    const v = n => getComputedStyle(root).getPropertyValue(n).trim().toLowerCase();
    const bodyBg = () => getComputedStyle(document.body).backgroundColor;
    const tl = document.querySelector('#timeline canvas').getContext('2d');
    const CK = '--c-' + Object.keys(window.OT.THEME_COLORS).find(k => k === '14161a' || k === '1f2228' || k.length === 6);
    const CV = '#' + CK.slice(4);
    const probe = c => { tl.fillStyle = c; return tl.fillStyle; };
    const out = {};
    out.classic = { choice: T.choice, bg: v('--bg'), c: v(CK), cv: CV, probe: probe('#272b32'), inline: root.style.getPropertyValue('--bg') };
    T.set('graphite');
    out.graphite = { bg: v('--bg'), panel: v('--panel'), c: v(CK), cv: CV, body: bodyBg(), probe: probe('#272b32'), scheme: root.style.colorScheme };
    T.set('paper');
    out.paper = { bg: v('--bg'), text: v('--text'), scheme: root.style.colorScheme, probe: probe('#272b32') };
    T.fz = W; T.set('fz');
    out.fz = { bg: v('--bg'), panel: v('--panel'), panel3: v('--panel3'), accent: v('--accent'), text: v('--text'), label: T.label() };
    // a live desktop switch to a light theme recolours at once
    T.fz = { id: 'LIGHT', name: 'Light', palette: { terminalBackground: '#F4F1EA', surfaceAlt: '#FFFFFF', surfaceElevated: '#E6E1D8', textPrimary: '#222222', accentPrimary: '#D2691E' } };
    T.apply();
    out.live = { bg: v('--bg'), accent: v('--accent'), scheme: root.style.colorScheme };
    let saved = null; try { saved = localStorage.getItem('finca.theme'); } catch (e) {}
    out.saved = saved;
    T.set('classic');
    out.back = { bg: v('--bg'), inline: root.style.getPropertyValue('--bg'), c: v(CK), cv: CV, probe: probe('#272b32') };
    // the View menu lists the themes
    const items = window.OT.app.ui._menuData ? JSON.stringify(window.OT.app.ui._menuData().find(m => m[0] === 'View')[1].map(i => i.label || '')) : '';
    out.menu = /Theme: Harmony Graphite/.test(items) && /Theme: Paper/.test(items) && /Theme: Follow FZ Theme/.test(items);
    return out;
  }, WISTERIA);
  const r = res.r;
  checks.push(['Classic is the default without FZ and changes nothing', r.classic.choice === 'classic' && r.classic.bg === '#14161a' && r.classic.c === r.classic.cv && r.classic.probe === '#272b32' && !r.classic.inline]);
  checks.push(['Harmony Graphite recolours named and converted colours', r.graphite.bg === '#2b2b2b' && r.graphite.panel === '#383838' && r.graphite.c && r.graphite.c !== r.graphite.cv && r.graphite.body === 'rgb(43, 43, 43)']);
  checks.push(['the timeline canvas follows the theme', r.graphite.probe !== '#272b32' && r.paper.probe !== r.graphite.probe]);
  checks.push(['Paper is light, with light native controls', r.paper.bg === '#e8e4dc' && r.paper.text === '#2b2824' && r.paper.scheme === 'light']);
  checks.push(['Follow FZ theme maps the desktop palette (Qt #aarrggbb)', r.fz.bg === '#15101d' && r.fz.panel === '#211829' && r.fz.panel3 === '#39274c' && r.fz.accent === '#cca5f4' && r.fz.text === '#efe3f7' && /Wisteria Dusk/.test(r.fz.label)]);
  checks.push(['a desktop theme switch recolours live (light FZ theme)', r.live.bg === '#f4f1ea' && r.live.accent === '#d2691e' && r.live.scheme === 'light']);
  checks.push(['the choice is remembered', r.saved === 'fz']);
  checks.push(['back to Classic restores everything', r.back.bg === '#14161a' && !r.back.inline && r.back.c === r.back.cv && r.back.probe === '#272b32']);
  checks.push(['View menu lists the themes', r.menu]);
  checks.push(['no page errors', errors.length === 0]);

  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
