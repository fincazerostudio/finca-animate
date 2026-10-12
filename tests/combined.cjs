/* Cross-feature checks: easing x pegs x light table on one rig */
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

  const res = await page.evaluate(() => {
    const a = window.OT.app, p = a.project, W = p.width, H = p.height, Peg = window.OT.Peg, out = {};
    a.addLayer('drawing'); const arm = a.activeLayer(); arm.name = 'Arm';
    const c = arm.drawingAt(0, W, H); c.ctx.fillStyle = '#ff0000';
    c.ctx.fillRect(W / 2 + 150, H / 2 - 10, 100, 20); c.dirty();
    a.addPeg(arm); const peg = a.activeLayer();
    peg.pivot = { x: W / 2, y: H / 2 };
    peg.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
                               { frame: 10, x: 0, y: 0, sx: 1, sy: 1, rot: 90 }];
    const tip = f => { a.setFrame(f); return Peg.apply(Peg.world(arm, f, p, a.layerAncestors(arm)), W / 2 + 200, H / 2); };

    // easing on a folder (peg) key drives the child's motion
    a.setLayerKeyEase(peg, 0, 'linear');
    const lin = tip(5);
    a.setLayerKeyEase(peg, 0, 'hold');
    const held = tip(5), end = tip(10);
    out.linearHalfway = Math.abs(Math.atan2(lin.y - H / 2, lin.x - W / 2) * 180 / Math.PI - 45) < 0.01;
    out.holdStays = Math.abs(held.x - (W / 2 + 200)) < 1e-6 && Math.abs(held.y - H / 2) < 1e-6;
    out.holdArrives = Math.abs(end.x - W / 2) < 1e-6 && Math.abs(end.y - (H / 2 + 200)) < 1e-6;

    // the timeline offers the ease menu on a folder row's key
    out.folderMenu = a.timeline._easeItems(peg, 0).filter(i => i.label).length === 5;

    // moving the pivot keeps each key's ease
    a.selectLayer(peg); a.tools.select('transform'); a.setFrame(0);
    const t = a.tools.tools.transform;
    const pw = Peg.apply(Peg.parentWorld(peg, 0, p, a.layerAncestors(peg)), W / 2, H / 2);
    const z = a.stage.view.zoom;
    t.pointerDown({ x: pw.x, y: pw.y, sx: 0, sy: 0 }, {}, a);
    t.pointerMove({ x: pw.x + 30 / z, y: pw.y }, {}, a);
    t.pointerUp({ x: pw.x + 30 / z, y: pw.y }, {}, a);
    out.pivotMoved = !!peg.pivot && peg.pivot.x !== W / 2;
    out.easeKept = peg.transform.keyframes.find(k => k.frame === 0).ease === 'hold';

    // the light table still hides / washes the non-active layer
    a.selectLayer(arm);
    a.lightTable.on = false;
    out.ltOff = a.stage._focusComposite().focusDim === 0;
    a.lightTable.on = true;
    out.ltOn = a.stage._focusComposite().focusDim === a.lightTable.opacity;
    return out;
  });

  const checks = [
    ['linear ease on a peg key swings the child halfway at the midpoint', res.linearHalfway],
    ['hold ease on a peg key keeps the child still', res.holdStays],
    ['hold ease jumps to the next key', res.holdArrives],
    ['ease menu on folder rows', res.folderMenu],
    ['Transform tool moves the folder pivot', res.pivotMoved],
    ['moving the pivot keeps key easing', res.easeKept],
    ['light table off / on with pegs present', res.ltOff && res.ltOn],
    ['no page errors', errors.length === 0]
  ];
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
