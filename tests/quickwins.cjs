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

  /* ---------- 2. Shift & Trace ---------- */
  await page.evaluate(() => {
    const a = window.OT.app, p = a.project, W = p.width, H = p.height;
    a.addLayer('drawing'); const L = a.activeLayer(); L.name = 'ST';
    a.setFrame(0);
    const c = L.drawingAt(0, W, H); c.ctx.fillStyle = '#000'; c.ctx.fillRect(400, 300, 100, 100); c.dirty();
    a.setFrame(1); a.newDrawing();                      // empty frame to trace on
    a.onion.on = false; a.onion.prev = 1; a.onion.next = 0;
    a.tools.select('brush');
    window.__st = L.id;
    // onion skin as drawn on the stage, in project space
    window.T.onionAt = (x, y) => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      a.stage._drawOnion(ctx);
      return ctx.getImageData(x, y, 1, 1).data[3] > 0;
    };
    a.emit('render');
  });
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.focus(); });
  await page.keyboard.press('Alt+s');
  await page.waitForTimeout(100);
  res.st = await page.evaluate(() => {
    const a = window.OT.app;
    return { on: a.shiftTrace.on, onion: a.onion.on, tool: a.tools.active.name, before: window.T.onionAt(450, 350) };
  });
  {
    const pts = await page.evaluate(() => ({ from: window.T.client(450, 350), to: window.T.client(750, 350) }));
    await drag(pts.from, pts.to);
  }
  res.stMove = await page.evaluate(() => {
    const a = window.OT.app, L = a.project.layers.find(l => l.id === window.__st);
    const d = L.cels[L.exposure[0]].ctx.getImageData(450, 350, 1, 1).data;
    return { x: Math.round(a.shiftTrace.x), y: Math.round(a.shiftTrace.y),
             shifted: window.T.onionAt(750, 350), oldSpot: window.T.onionAt(450, 350),
             drawingUntouched: d[3] === 255,
             pen: a.penCast && a.penCast._meta ? a.penCast._meta().shiftTrace : 'n/a' };
  });
  // Shift-drag rotates, Alt-drag scales (about the canvas centre)
  {
    const pts = await page.evaluate(() => {
      const p = window.OT.app.project, cx = p.width / 2, cy = p.height / 2;
      return { a: window.T.client(cx + 300 + 400, cy), b: window.T.client(cx + 300, cy + 400),
               c: window.T.client(cx + 300 + 200, cy), d: window.T.client(cx + 300 + 400, cy) };
    });
    await page.keyboard.down('Shift'); await drag(pts.a, pts.b); await page.keyboard.up('Shift');
    await page.keyboard.down('Alt'); await drag(pts.c, pts.d); await page.keyboard.up('Alt');
  }
  res.stRS = await page.evaluate(() => ({ rot: Math.round(window.OT.app.shiftTrace.rot), scale: +window.OT.app.shiftTrace.scale.toFixed(2) }));
  await page.keyboard.press('Alt+s');
  await page.waitForTimeout(100);
  res.stOff = await page.evaluate(() => {
    const a = window.OT.app, st = a.shiftTrace;
    return { on: st.on, reset: st.x === 0 && st.y === 0 && st.rot === 0 && st.scale === 1,
             tool: a.tools.active.name, back: window.T.onionAt(450, 350) };
  });
  checks.push(
    ['Alt+S turns on Shift & Trace, onion skin and its tool', res.st.on && res.st.onion && res.st.tool === 'shifttrace'],
    ['reference visible before shifting', res.st.before],
    ['drag moves the onion reference', res.stMove.x === 300 && res.stMove.y === 0 && res.stMove.shifted && !res.stMove.oldSpot],
    ['the drawing itself is untouched', res.stMove.drawingUntouched],
    ['pen window gets the offset', res.stMove.pen === 'n/a' || (res.stMove.pen && Math.round(res.stMove.pen.x) === res.stMove.x)],
    ['Shift-drag rotates the reference', res.stRS.rot === 90],
    ['Alt-drag scales the reference', res.stRS.scale === 2],
    ['Alt+S again resets and returns to the previous tool',
      !res.stOff.on && res.stOff.reset && res.stOff.tool === 'brush' && res.stOff.back]
  );

  /* ---------- 3. perspective guides ---------- */
  res.pv0 = await page.evaluate(() => {
    const a = window.OT.app, p = a.project, g = p.perspective;
    const out = { defaultOff: g.on === false };
    a.togglePerspective();
    out.on = g.on;
    a.tools.select('perspective'); a.emit('render');
    // what the overlay draws, in project space
    window.T.persp = (x, y) => {
      const cv = document.createElement('canvas'); cv.width = p.width; cv.height = p.height;
      const ctx = cv.getContext('2d'); a.stage._drawPerspective(ctx);
      return ctx.getImageData(x, y, 1, 1).data;
    };
    const hz = window.T.persp(p.width / 2, Math.round(0.42 * p.height));
    out.horizon = hz[3] > 0 && hz[0] > hz[2];          // amber line
    let red = 0, blue = 0;
    for (let x = 0; x < p.width; x += 4) {
      const d = window.T.persp(x, Math.round(p.height * 0.85));
      if (d[3] && d[0] > d[2]) red++; if (d[3] && d[2] > d[0]) blue++;
    }
    out.rays = [red, blue];
    return out;
  });
  {
    // drag vp2 right and down: horizon stays level (vp1 follows in v)
    const pts = await page.evaluate(() => {
      const p = window.OT.app.project, g = p.perspective;
      const v = { x: g.vp2.u * p.width, y: g.vp2.v * p.height };
      return { from: window.T.client(v.x, v.y), to: window.T.client(v.x - 100, v.y + 54) };
    });
    await drag(pts.from, pts.to);
    res.pvDrag = await page.evaluate(() => JSON.parse(JSON.stringify(window.OT.app.project.perspective)));
    // Shift-drag tilts: only vp1 moves
    const pts2 = await page.evaluate(() => {
      const p = window.OT.app.project, g = p.perspective;
      const v = { x: g.vp1.u * p.width, y: g.vp1.v * p.height };
      return { from: window.T.client(v.x, v.y), to: window.T.client(v.x, v.y - 108) };
    });
    await page.keyboard.down('Shift'); await drag(pts2.from, pts2.to); await page.keyboard.up('Shift');
    res.pvTilt = await page.evaluate(() => JSON.parse(JSON.stringify(window.OT.app.project.perspective)));
    // drag empty space: horizon (both VPs) moves together
    const pts3 = await page.evaluate(() => ({ from: window.T.client(960, 900), to: window.T.client(960, 846) }));
    await drag(pts3.from, pts3.to);
    res.pvHorizon = await page.evaluate(() => JSON.parse(JSON.stringify(window.OT.app.project.perspective)));
  }
  res.pvIO = await page.evaluate(async () => {
    const a = window.OT.app, p = a.project, g = p.perspective;
    g.mode = 1; a.emit('render');
    let blue = 0;
    for (let x = 0; x < p.width; x += 4) { const d = window.T.persp(x, Math.round(p.height * 0.85)); if (d[3] && d[2] > d[0]) blue++; }
    const data = JSON.parse(JSON.stringify(window.OT.IO.serialize(a)));
    const p2 = (await window.OT.IO.deserialize(data)).project;
    const old = JSON.parse(JSON.stringify(data)); delete old.perspective;
    const p3 = (await window.OT.IO.deserialize(old)).project;
    return { onePointBlue: blue, saved: JSON.stringify(p2.perspective) === JSON.stringify(g),
             oldFileDefault: p3.perspective && p3.perspective.on === false };
  });
  const r3 = v => Math.round(v * 1000) / 1000;
  checks.push(
    ['perspective guides off by default, toggle on', res.pv0.defaultOff && res.pv0.on],
    ['horizon line drawn', res.pv0.horizon],
    ['rays fan from both vanishing points', res.pv0.rays[0] > 3 && res.pv0.rays[1] > 3],
    ['dragging a VP moves it', r3(res.pvDrag.vp2.u) === r3(0.94 - 100 / 1920) && r3(res.pvDrag.vp2.v) === r3(0.42 + 54 / 1080)],
    ['2-point horizon stays level', r3(res.pvDrag.vp1.v) === r3(res.pvDrag.vp2.v) && r3(res.pvDrag.vp1.u) === 0.06],
    ['Shift-drag tilts the horizon (one VP only)', r3(res.pvTilt.vp1.v) === r3(res.pvDrag.vp1.v - 0.1) && r3(res.pvTilt.vp2.v) === r3(res.pvDrag.vp2.v)],
    ['dragging elsewhere moves the horizon', r3(res.pvHorizon.vp1.v) === r3(res.pvTilt.vp1.v - 0.05) && r3(res.pvHorizon.vp2.v) === r3(res.pvTilt.vp2.v - 0.05)],
    ['1-point mode draws one fan', res.pvIO.onePointBlue === 0],
    ['saved with the project', res.pvIO.saved],
    ['older files load with guides off', res.pvIO.oldFileDefault]
  );

  // (later sections append to `checks` above this line)
  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
