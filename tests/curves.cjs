/* Function-curve editor: bezier eases, per-channel curves, the dialog */
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
  const res = {};
  const checks = [];

  /* ---------- the maths ---------- */
  res.math = await page.evaluate(() => {
    const U = window.OT.util, out = {};
    // presets as curves == the preset functions
    let worst = 0;
    for (const id of ['linear', 'smooth', 'in', 'out'])
      for (let i = 0; i <= 200; i++) { const t = i / 200; worst = Math.max(worst, Math.abs(U.ease(t, id) - U.cubicBezier(U.EASE_CURVES[id], t))); }
    out.presetMatch = worst;
    out.ends = [U.cubicBezier([0.9, -0.2, 0.1, 1.3], 0), U.cubicBezier([0.9, -0.2, 0.1, 1.3], 1)];
    const a = window.OT.app, l = a.activeLayer();
    l.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 0 }, { frame: 10, x: 100, y: 0, sx: 2, sy: 2, rot: 80 }];
    const k = l.transform.keyframes[0];
    out.legacy = l.transformAt(5).x;                        // smoothstep at 0.5 = 50
    k.ease = [0.3, 1.5, 0.6, 1];                              // overshoot
    let max = 0; for (let f = 0; f <= 10; f += 0.25) max = Math.max(max, l.transformAt(f).x);
    out.overshoot = max;
    k.ease = 'linear'; k.curves = { rot: U.EASE_CURVES.in.slice() };
    const t5 = l.transformAt(5);
    out.perChannel = [t5.x, +t5.sx.toFixed(4), +t5.rot.toFixed(4)];
    delete k.curves; k.ease = undefined;
    return out;
  });
  checks.push(
    ['presets as bezier curves == preset formulas (max err < 1e-6)', res.math.presetMatch < 1e-6],
    ['curve ends pinned at 0 and 1', res.math.ends[0] === 0 && res.math.ends[1] === 1],
    ['keys without curves animate as before', res.math.legacy === 50],
    ['custom curve can overshoot', res.math.overshoot > 105],
    ['per-channel curve only affects its channel', res.math.perChannel[0] === 50 && res.math.perChannel[1] === 1.5 && res.math.perChannel[2] === 10]
  );

  /* ---------- the dialog, through the real UI ---------- */
  const open = async () => {
    const p = await page.evaluate(() => {
      const t = window.OT.app.timeline, r = t.grid.getBoundingClientRect();
      const row = t.layerRows ? 0 : 0;
      return { x: r.left + t.cellW / 2, y: r.top + t.headerH + t.rowH / 2 };
    });
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.waitForTimeout(120);
    const items = await page.$$eval('.menu-pop .menu-row', r => r.map(x => x.textContent.trim()));
    await page.$$eval('.menu-pop .menu-row', r => r.find(x => x.textContent.includes('Edit Curve')).click());
    await page.waitForTimeout(120);
    return items;
  };
  const handle = async (i) => page.evaluate((i) => {
    const c = document.querySelector('.modal canvas'), r = c.getBoundingClientRect();
    const info = document.querySelector('.modal canvas').nextSibling.textContent;
    const cv = info.match(/cubic-bezier\(([^)]*)\)/)[1].split(',').map(Number);
    const S = 260, PAD = 34, R = S - PAD * 2;
    const X = x => PAD + x * R, Y = y => PAD + (1 - (y + 0.25) / 1.5) * R;
    const k = r.width / S;
    return { x: r.left + X(cv[i * 2]) * k, y: r.top + Y(cv[i * 2 + 1]) * k, unit: R * k / 1.5 };
  }, i);
  await page.evaluate(() => {
    const a = window.OT.app, l = a.activeLayer();
    l.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 0 }, { frame: 10, x: 100, y: 0, sx: 1, sy: 1, rot: 60 }];
    a.selectLayer(l); a.setFrame(5); a.emit('render');
  });
  res.items = await open();
  res.dialog = await page.evaluate(() => ({ title: document.querySelector('.modal-title').textContent, hasCanvas: !!document.querySelector('.modal canvas'),
    undo: window.OT.app.history.undoStack.length }));
  // drag handle 1 (x1, y1) straight up by 1.0 in curve units -> overshoot-ish start
  const h = await handle(0);
  await page.mouse.move(h.x, h.y); await page.mouse.down();
  await page.mouse.move(h.x, h.y - h.unit, { steps: 6 }); await page.mouse.up();
  res.live = await page.evaluate(() => {
    const l = window.OT.app.activeLayer(), k = l.transform.keyframes[0];
    return { ease: k.ease, x5: l.transformAt(5).x };
  });
  await page.$$eval('.modal .btn', b => b.find(x => x.textContent === 'Apply').click());
  await page.waitForTimeout(80);
  res.applied = await page.evaluate((u0) => {
    const a = window.OT.app, l = a.activeLayer();
    const r = { undoGrew: a.history.undoStack.length === u0 + 1, ease: l.transform.keyframes[0].ease };
    r.menu = a.timeline._easeItems(l, 0).filter(i => i.label).map(i => i.label.trim());
    a.undo();
    r.undone = a.activeLayer().transform.keyframes[0].ease;
    a.redo();
    return r;
  }, res.dialog.undo);
  checks.push(
    ['right-click a key → "Edit Curve…"', res.items.some(t => t.endsWith('Edit Curve…'))],
    ['curve dialog opens with the graph', res.dialog.hasCanvas && /Curve/.test(res.dialog.title)],
    ['dragging a handle edits the curve live', Array.isArray(res.live.ease) && Math.abs(res.live.ease[1] - 1) < 0.05 && res.live.x5 > 50],
    ['Apply is one undo step; undo restores the preset', res.applied.undoGrew && Array.isArray(res.applied.ease) && res.applied.undone === undefined],
    ['menu ticks "Edit Curve…" for custom keys', res.applied.menu.includes('✓ Edit Curve…') && !res.applied.menu.some(t => t.startsWith('✓ Ease'))]
  );
  // channel: rotation only, preset button, then Esc reverts
  await open();
  await page.selectOption('.modal select', 'rot');
  await page.$$eval('.modal .btn', b => b.find(x => x.textContent === 'Ease In').click());
  res.chan = await page.evaluate(() => {
    const k = window.OT.app.activeLayer().transform.keyframes[0];
    return { rot: k.curves && k.curves.rot, easeKept: Array.isArray(k.ease) };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  res.esc = await page.evaluate(() => {
    const k = window.OT.app.activeLayer().transform.keyframes[0];
    return { curves: k.curves || null, ease: k.ease };
  });
  checks.push(
    ['channel select + preset button set a per-channel curve', JSON.stringify(res.chan.rot) === JSON.stringify([1 / 3, 0, 2 / 3, 0]) && res.chan.easeKept],
    ['Esc reverts the edit', res.esc.curves === null && Array.isArray(res.esc.ease)]
  );
  // a preset from the menu clears custom curves
  res.preset = await page.evaluate(() => {
    const a = window.OT.app, l = a.activeLayer();
    l.transform.keyframes[0].curves = { rot: [0.1, 0.2, 0.3, 0.4] };
    a.setLayerKeyEase(l, 0, 'out');
    const k = a.activeLayer().transform.keyframes[0];
    return { ease: k.ease, curves: k.curves || null };
  });
  checks.push(['choosing a preset replaces custom curves', res.preset.ease === 'out' && res.preset.curves === null]);

  /* ---------- camera keys ---------- */
  await page.evaluate(() => {
    const a = window.OT.app;
    a.project.camera.keyframes = [{ frame: 0, x: 0, y: 0, zoom: 1, rot: 0 }, { frame: 8, x: 400, y: 0, zoom: 2, rot: 0 }];
    a.ui.cameraDialog();
  });
  await page.waitForTimeout(100);
  res.camBtn = await page.$$eval('.modal .btn', b => b.filter(x => x.textContent === 'Curve…').length);
  await page.$$eval('.modal .btn', b => b.find(x => x.textContent === 'Curve…').click());
  await page.waitForTimeout(100);
  await page.locator('.modal-bg').last().locator('select').selectOption('zoom');
  await page.locator('.modal-bg').last().locator('.btn', { hasText: 'Ease Out' }).click();
  await page.locator('.modal-bg').last().locator('.btn', { hasText: 'Apply' }).click();
  await page.waitForTimeout(80);
  res.cam = await page.evaluate(() => {
    const a = window.OT.app, k = a.project.camera.keyframes.find(k => k.frame === 0), c = a.project.cameraAt(4);
    return { zoomCurve: k.curves && k.curves.zoom, x: +c.x.toFixed(3), zoom: +c.zoom.toFixed(4) };
  });
  // last key: nothing to shape
  res.last = await page.evaluate(() => {
    const a = window.OT.app, k = a.project.camera.keyframes.find(k => k.frame === 8);
    const n = document.querySelectorAll('.modal-bg').length;
    a.ui.curveDialog({ key: k });
    return document.querySelectorAll('.modal-bg').length === n;
  });
  res.io = await page.evaluate(async () => {
    const a = window.OT.app;
    const p2 = (await window.OT.IO.deserialize(JSON.parse(JSON.stringify(window.OT.IO.serialize(a))))).project;
    const k = p2.camera.keyframes.find(k => k.frame === 0);
    return !!(k.curves && Array.isArray(k.curves.zoom));
  });
  checks.push(
    ['camera editor has a Curve… button per key', res.camBtn === 2],
    ['camera zoom curve shapes zoom only', JSON.stringify(res.cam.zoomCurve) === JSON.stringify([1 / 3, 1, 2 / 3, 1]) && res.cam.x === 200 && res.cam.zoom === +(1 + (1 - Math.pow(0.5, 3))).toFixed(4)],
    ['last key: no dialog (nothing to shape)', res.last],
    ['curves saved with the project', res.io],
    ['no page errors', errors.length === 0]
  );

  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
