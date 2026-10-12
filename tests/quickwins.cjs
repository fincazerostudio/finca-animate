/* Quick wins: fitted transform box, Shift & Trace, perspective guides */
const { launch, FILE } = require('./launch-browser.cjs');

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const a = window.OT.app;
    window.T = {
      client(px, py) {
        const r = a.stage.canvas.getBoundingClientRect(), s = a.stage.projectToScreen(px, py);
        return { x: r.left + s.x, y: r.top + s.y };
      },
      geo(layer) { return a.tools.tools.transform._geo(a, layer); }
    };
  });
  async function drag(from, to) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
    await page.mouse.up();
    await page.waitForTimeout(60);
  }
  const res = {};
  const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1 : tol);

  /* ---------- 1. transform box hugs the drawing ---------- */
  res.box = await page.evaluate(() => {
    const a = window.OT.app, p = a.project, W = p.width, H = p.height, out = {};
    a.addLayer('drawing'); const L = a.activeLayer(); L.name = 'Box';
    a.setFrame(0);
    out.empty = window.T.geo(L).corners.map(c => [Math.round(c.x), Math.round(c.y)]);
    const c = L.drawingAt(0, W, H);
    c.ctx.fillStyle = '#000'; c.ctx.fillRect(400, 300, 200, 100); c.dirty();
    out.raster = window.T.geo(L).corners.map(c => [Math.round(c.x), Math.round(c.y)]);
    // vector layer: bounds from strokes
    a.addLayer('vector'); const V = a.activeLayer();
    const vc = V.drawingAt(0, W, H);
    vc.strokes.push({ type: 'line', pts: [{ x: 1000, y: 500, p: 1 }, { x: 1200, y: 700, p: 1 }], width: 6, color: '#000', closed: false });
    vc.rebuild();
    out.vector = window.T.geo(V).corners.map(c => [Math.round(c.x), Math.round(c.y)]);
    // folder: wraps a rotated child, in world space
    a.addPeg(L); const peg = a.activeLayer();
    L.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 90 }];
    L.pivot = { x: 500, y: 350 };   // rotate the rect about its own centre
    const g = window.T.geo(peg);
    const xs = g.corners.map(c => c.x), ys = g.corners.map(c => c.y);
    out.folder = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round);
    L.transform.keyframes = []; L.pivot = null;
    window.__box = L.id;
    return out;
  });
  // corner handle (now near the art, on-screen) scales the layer
  res.boxScale = await (async () => {
    const pts = await page.evaluate(() => {
      const a = window.OT.app, L = a.project.layers.find(l => l.id === window.__box);
      a.selectLayer(L); a.setFrame(0); a.tools.select('transform'); a.emit('render');
      const g = window.T.geo(L), br = g.corners[2], tl = g.corners[0];
      window.__tl = { x: tl.x, y: tl.y }; window.__target = { x: br.x + 100, y: br.y + 100 };
      return { from: window.T.client(br.x, br.y), to: window.T.client(br.x + 100, br.y + 100) };
    });
    await drag(pts.from, pts.to);
    return page.evaluate(() => {
      const L = window.OT.app.project.layers.find(l => l.id === window.__box);
      const k = L.transform.keyframes.find(k => k.frame === 0);
      if (!k) return null;
      // the box was measured before scaling: map its old corners through the new pose
      const W = window.OT.Peg.world(L, 0, window.OT.app.project, window.OT.app.layerAncestors(L));
      const tl = window.OT.Peg.apply(W, 390, 290), br = window.OT.Peg.apply(W, 610, 410);
      return { sx: +k.sx.toFixed(3), sy: +k.sy.toFixed(3),
               tlMoved: Math.hypot(tl.x - window.__tl.x, tl.y - window.__tl.y),
               brMiss: Math.hypot(br.x - window.__target.x, br.y - window.__target.y) };
    });
  })();

  const checks = [
    ['empty layer: box falls back to the canvas', JSON.stringify(res.box.empty) === JSON.stringify([[0, 0], [1920, 0], [1920, 1080], [0, 1080]])],
    ['bitmap layer: box hugs the drawing (+10 px pad)',
      near(res.box.raster[0][0], 390, 4) && near(res.box.raster[0][1], 290, 4) && near(res.box.raster[2][0], 610, 4) && near(res.box.raster[2][1], 410, 4)],
    ['vector layer: box hugs the strokes',
      near(res.box.vector[0][0], 986, 2) && near(res.box.vector[0][1], 486, 2) && near(res.box.vector[2][0], 1214, 2) && near(res.box.vector[2][1], 714, 2)],
    ['folder: box wraps its rotated contents',
      near(res.box.folder[0], 440, 5) && near(res.box.folder[1], 240, 5) && near(res.box.folder[2], 560, 5) && near(res.box.folder[3], 460, 5)],
    ['corner drag outward grows the layer', !!res.boxScale && res.boxScale.sx > 1.3 && res.boxScale.sy > 1.6],
    ['opposite corner stays pinned', !!res.boxScale && res.boxScale.tlMoved < 6],
    ['dragged corner lands under the mouse', !!res.boxScale && res.boxScale.brMiss < 6]
  ];

  // (later sections append to `checks` above this line)
  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
