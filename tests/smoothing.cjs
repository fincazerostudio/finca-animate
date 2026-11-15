/* Brush smoothing: a wobbly stroke gets smoother as Smoothing goes up, the ends
   stay put, and 0 leaves the line as drawn. */
const { launch, FILE } = require('./launch-browser.cjs');

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  await page.evaluate(() => {
    const a = window.OT.app;
    window.T = { client(px, py) { const r = a.stage.canvas.getBoundingClientRect(), s = a.stage.projectToScreen(px, py); return { x: r.left + s.x, y: r.top + s.y }; } };
  });
  const checks = [], res = {};

  // a brisk pen stroke with a broad hand wobble (a few px over ~80 px), sent as
  // pen events at a tablet's report rate
  const draw = async (smooth, y0) => page.evaluate(async ([sm, y0]) => {
    const a = window.OT.app; a.tools.select('brush'); a.settings.smoothing = sm;
    const cv = document.getElementById('canvas');
    const pts = []; for (let i = 0; i <= 160; i++) pts.push([400 + i * 6, y0 + Math.sin(i * 0.47) * 5 + Math.sin(i * 0.13) * 4]);
    const fire = (type, q) => { const c = window.T.client(q[0], q[1]); cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
      pointerId: 3, pointerType: 'pen', isPrimary: true, pressure: 0.6, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: c.x, clientY: c.y })); };
    // paced like a tablet (~250 reports a second), 6 px apart: a brisk stroke
    const wait = ms => new Promise(r => { const t0 = performance.now(); (function spin() { if (performance.now() - t0 >= ms) r(); else setTimeout(spin, 0); })(); });
    fire('pointerdown', pts[0]);
    for (let i = 1; i < pts.length; i++) { await wait(4); fire('pointermove', pts[i]); }
    fire('pointerup', pts[pts.length - 1]);
    return new Promise(r => setTimeout(() => {
      const cel = a.activeLayer().celAt(a.frame), st = cel.strokes[cel.strokes.length - 1], P = st.pts;
      let turn = 0, len = 0;
      for (let i = 1; i < P.length - 1; i++) {
        const a1 = Math.atan2(P[i].y - P[i - 1].y, P[i].x - P[i - 1].x), a2 = Math.atan2(P[i + 1].y - P[i].y, P[i + 1].x - P[i].x);
        let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d; turn += d;
      }
      for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
      // wobble left: deviation from a straight line between the ends
      const f = P[0], l = P[P.length - 1];
      let dev = 0; for (const p of P) { const t = (p.x - f.x) / ((l.x - f.x) || 1); dev = Math.max(dev, Math.abs(p.y - (f.y + (l.y - f.y) * t))); }
      r({ jag: turn / len * 100, n: P.length, first: P[0], last: l, dev });
    }, 150));
  }, [smooth, y0]);
  res.s0 = await draw(0, 300);
  res.s5 = await draw(0.5, 500);
  res.s1 = await draw(1, 700);
  checks.push(['Smoothing 1 takes out most of the wobble', res.s1.jag < res.s0.jag * 0.35 && res.s1.dev < res.s0.dev]);
  checks.push(['smoothing grows with the slider', res.s5.jag < res.s0.jag && res.s1.jag < res.s5.jag]);
  checks.push(['the ends stay where the pen put them', Math.abs(res.s1.first.x - 400) < 6 && Math.abs(res.s1.last.x - 1360) < 6]);
  // Photoshop-style string: shakes inside the string never reach the line, the
  // brush trails the pen, and the line catches up to the pen on release
  res.string = await page.evaluate(async () => {
    const a = window.OT.app; a.tools.select('brush'); a.settings.smoothing = 1;
    const cv = document.getElementById('canvas'), tool = a.tools.active;
    const fire = (type, x, y) => { const c = window.T.client(x, y); cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
      pointerId: 4, pointerType: 'pen', isPrimary: true, pressure: 0.6, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: c.x, clientY: c.y })); };
    const zoom = a.stage.view.zoom, r = 40 / zoom;            // string length in drawing px
    fire('pointerdown', 500, 850);
    const n0 = tool.raw.length;
    for (let i = 0; i < 30; i++) fire('pointermove', 500 + Math.sin(i) * r * 0.6, 850 + Math.cos(i * 1.3) * r * 0.6);   // shaking in place
    const shakeAdded = tool.raw.length - n0;
    for (let i = 1; i <= 40; i++) fire('pointermove', 500 + i * 15, 850);                                  // pull away
    const trail = Math.hypot(tool._liveTip.x - tool._lz.x, tool._liveTip.y - tool._lz.y);
    fire('pointerup', 1100, 850);
    await new Promise(res => setTimeout(res, 120));
    const cel = a.activeLayer().celAt(a.frame), P = cel.strokes[cel.strokes.length - 1].pts, last = P[P.length - 1];
    // no string at 0
    a.settings.smoothing = 0;
    fire('pointerdown', 500, 950); fire('pointermove', 503, 950);
    const noString = tool.raw.length >= 2;
    fire('pointerup', 503, 950);
    return { shakeAdded, trail, r, endGap: Math.hypot(last.x - 1100, last.y - 850), noString };
  });
  checks.push(['Smoothing 1: shaking inside the string adds nothing to the line', res.string.shakeAdded === 0]);
  checks.push(['the brush trails the pen by the string while drawing', Math.abs(res.string.trail - res.string.r) < 1.5]);
  checks.push(['on release the line catches up and ends under the pen', res.string.endGap < 3]);
  checks.push(['Smoothing 0: no string, the line follows the pen at once', res.string.noString]);

  // finalize itself: 0 leaves points untouched
  res.zero = await page.evaluate(() => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: -2 }, { x: 15, y: 4 }, { x: 20, y: 0 }];
    const f = window.OT.StrokeFinalize.smoothStroke; if (!f) return false;
    return JSON.stringify(f(pts, 0)) === JSON.stringify(pts);
  });
  checks.push(['Smoothing 0 leaves the line exactly as drawn', res.zero]);

  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  console.log('jaggedness per 100px: s0', res.s0.jag.toFixed(1), 's0.5', res.s5.jag.toFixed(1), 's1', res.s1.jag.toFixed(1), '| max wobble px', res.s0.dev.toFixed(1), res.s1.dev.toFixed(1));
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
