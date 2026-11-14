/* Eraser marks cut only what was drawn before them: drawing over an erased
   spot draws again (it used to stay erased forever). */
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
      cel() { return a.activeLayer().celAt(a.frame); },
      px(x, y) { return Array.from(window.T.cel().ctx.getImageData(x, y, 1, 1).data); },
      // what the stage shows (composite.js path), in project coordinates
      stagePx(x, y) {
        const c = a.stage.canvas, s = a.stage.projectToScreen(x, y);
        const k = c.width / c.getBoundingClientRect().width;
        return Array.from(c.getContext('2d').getImageData(Math.round(s.x * k), Math.round(s.y * k), 1, 1).data);
      },
      brush(color, size = 24) {
        a.tools.select('brush'); a.settings.size = size;
        if (a.tools.active.size != null) a.tools.active.size = size;
        a.setColor(color);
      },
      eraser() { a.tools.select('eraser'); a.settings.size = 60; if (a.tools.active.size != null) a.tools.active.size = 60; }
    };
  });
  const stroke = async (pts) => {
    const c = await page.evaluate(p => p.map(q => window.T.client(q[0], q[1])), pts);
    await page.mouse.move(c[0].x, c[0].y); await page.mouse.down();
    for (let i = 1; i < c.length; i++) await page.mouse.move(c[i].x, c[i].y, { steps: 6 });
    await page.mouse.up(); await page.waitForTimeout(80);
  };
  const line = (x0, y0, x1, y1) => { const o = []; for (let i = 0; i <= 10; i++) o.push([x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10]); return o; };
  const isBlack = d => d[3] > 200 && d[0] < 60 && d[1] < 60 && d[2] < 60;
  const isRed = d => d[3] > 200 && d[0] > 200 && d[1] < 80 && d[2] < 80;
  const isClear = d => d[3] < 20;
  const isPaper = d => d[0] > 200 && d[1] > 200 && d[2] > 200;
  const res = {};
  const checks = [];
  const render = () => page.evaluate(() => new Promise(r => { window.OT.app.emit('render'); requestAnimationFrame(() => requestAnimationFrame(r)); }));

  // black line, erase its middle, then draw red over the erased spot
  await page.evaluate(() => window.T.brush('#000000'));
  await stroke(line(400, 500, 1000, 500));
  await page.evaluate(() => window.T.eraser());
  await stroke(line(700, 500, 701, 500));
  res.erased = await page.evaluate(() => ({ mid: window.T.px(700, 500), marks: window.T.cel().eraserMarks.map(m => m.g) }));
  await page.evaluate(() => window.T.brush('#ff0000', 8));
  await stroke(line(700, 300, 700, 700));
  res.redrawn = await page.evaluate(() => ({ live: window.T.px(700, 500), eg: window.T.cel().strokes.map(s => s.eg) }));
  await page.evaluate(() => window.T.cel().rebuild());
  res.rebuilt = await page.evaluate(() => ({ red: window.T.px(700, 500), blackGap: window.T.px(692, 500), blackFar: window.T.px(450, 500) }));
  await render();
  res.stage = await page.evaluate(() => ({ red: window.T.stagePx(700, 500), gap: window.T.stagePx(692, 500), black: window.T.stagePx(450, 500) }));
  checks.push(
    ['eraser cuts the line', isClear(res.erased.mid) && res.erased.marks.length > 0 && res.erased.marks.every(g => g === 1)],
    ['a new stroke over the erased spot shows', isRed(res.redrawn.live)],
    ['the old stroke is stamped with the pass, the new one is not', res.redrawn.eg[0] === 1 && res.redrawn.eg[1] == null],
    ['still shows after a full rebuild, old line still cut', isRed(res.rebuilt.red) && isClear(res.rebuilt.blackGap) && isBlack(res.rebuilt.blackFar)],
    ['the stage shows the same', isRed(res.stage.red) && isPaper(res.stage.gap) && isBlack(res.stage.black)]
  );

  // a second erase pass cuts the red line too; undo brings it back
  await page.evaluate(() => window.T.eraser());
  await stroke(line(700, 400, 701, 400));
  await page.evaluate(() => window.T.cel().rebuild());
  res.second = await page.evaluate(() => ({ cut: window.T.px(700, 400), kept: window.T.px(700, 500), eg: window.T.cel().strokes.map(s => s.eg) }));
  await page.evaluate(() => window.OT.app.undo());
  await page.waitForTimeout(80);
  await page.evaluate(() => window.T.cel().rebuild());
  res.undo = await page.evaluate(() => ({ back: window.T.px(700, 400), gap: window.T.px(692, 500) }));
  checks.push(
    ['a later erase pass cuts the newer stroke', isClear(res.second.cut) && isRed(res.second.kept) && res.second.eg[1] === 2],
    ['undo of that pass restores the stroke', isRed(res.undo.back) && isClear(res.undo.gap)]
  );

  // save / load keeps passes; a drawing saved before passes is upgraded
  res.io = await page.evaluate(async () => {
    const a = window.OT.app;
    const data = JSON.parse(JSON.stringify(window.OT.IO.serialize(a)));
    const keep = await window.OT.IO.deserialize(JSON.parse(JSON.stringify(data)));
    a.loadProjectData(keep);
    const c1 = window.T.cel();
    const kept = { g: c1.eraserMarks.map(m => m.g), eg: c1.strokes.map(s => s.eg) };
    // strip passes and stamps = a file from before this fix
    for (const l of data.layers) for (const k in l.cels || {}) {
      const cd = l.cels[k];
      if (cd && cd.k === 'v') {
        for (const m of cd.eraserMarks || []) delete m.g;
        for (const s of cd.strokes || []) delete s.eg;
      }
    }
    a.loadProjectData(await window.OT.IO.deserialize(data));
    const c2 = window.T.cel();
    return { kept, upgraded: { g: c2.eraserMarks.map(m => m.g), eg: c2.strokes.map(s => s.eg) },
             gap: window.T.px(692, 500), pen: window.OT._serializeStroke(c2.strokes[0]).eg };
  });
  await page.evaluate(() => window.T.brush('#000000'));
  await stroke(line(660, 520, 660, 480));
  await page.evaluate(() => window.T.cel().rebuild());
  res.legacyDraw = await page.evaluate(() => window.T.px(660, 500));
  checks.push(
    ['save/load keeps erase passes and stamps', res.io.kept.g.every(g => g === 1) && res.io.kept.eg[0] === 1],
    ['an older file opens with its erased look', res.io.upgraded.g.every(g => g === 0) && res.io.upgraded.eg.every(e => e === 0) && isClear(res.io.gap)],
    ['drawing over an erased spot of an older file shows', isBlack(res.legacyDraw)],
    ['the pen window gets the stamps', res.io.pen === 0]
  );

  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
