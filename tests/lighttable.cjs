/* Light table: other layers washed out / hidden in the stage preview only */
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
    const a = window.OT.app, p = a.project, out = {};
    const W = p.width, H = p.height;
    // bitmap layer A: red square left; bitmap layer B (active): blue square right
    a.addLayer('drawing'); const A = a.activeLayer();
    let c = A.drawingAt(0, W, H); c.ctx.fillStyle = '#ff0000'; c.ctx.fillRect(0, 0, W / 2, H); c.dirty();
    a.addLayer('drawing'); const B = a.activeLayer();
    c = B.drawingAt(0, W, H); c.ctx.fillStyle = '#0000ff'; c.ctx.fillRect(W / 2, 0, W / 2, H); c.dirty();
    a.setFrame(0);

    // render the stage composite the way canvas.render() does, sample red
    const red = () => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const x = cv.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
      a.stage.compositeStage(0, x, Object.assign({ bg: false }, a.stage._focusComposite()));
      const d = x.getImageData(W / 4, H / 2, 1, 1).data;
      const e = x.getImageData(3 * W / 4, H / 2, 1, 1).data;
      return { g: d[1], blueB: e[2], blueG: e[1] };
    };
    out.default = { on: a.lightTable.on, opacity: a.lightTable.opacity, px: red() };
    a.toggleLightTable(); out.off = red();
    a.toggleLightTable(); out.backOn = red();
    a.setLightTableOpacity(1); out.full = red();
    a.setLightTableOpacity(0.5); out.half = red();
    // export ignores the light table
    a.toggleLightTable();
    const f = window.OT.IO.renderFrame(a, 0, 64, 36);
    const fd = f.getContext('2d').getImageData(16, 18, 1, 1).data;
    out.exportRed = [fd[0], fd[1], fd[2]];
    // pen window gets the setting
    out.penMeta = a.penCast && a.penCast._meta ? a.penCast._meta().lightTable : 'n/a';
    // prefs round-trip
    a._savePrefs();
    out.prefs = JSON.parse(localStorage.getItem('opentoon.prefs')).lightTable;
    // menu + viewbar
    out.btnOn = a.ui.lightBtn.classList.contains('on');
    return out;
  });

  // paper is white (g=255); red layer at opacity o over white gives g = 255*(1-o)
  const near = (v, want) => Math.abs(v - want) <= 3;
  const checks = [
    ['defaults: on at 30% (matches old behaviour)', res.default.on === true && res.default.opacity === 0.3],
    ['on: other layer washed out (~30%)', near(res.default.px.g, 178)],
    ['active layer full strength', res.default.px.blueB === 255 && res.default.px.blueG === 0],
    ['off: other layer hidden', res.off.g === 255],
    ['off: active layer still drawn', res.off.blueB === 255 && res.off.blueG === 0],
    ['toggle back on', near(res.backOn.g, 178)],
    ['strength 100% = full', res.full.g === 0],
    ['strength 50%', near(res.half.g, 128)],
    ['export unaffected by light table', res.exportRed[0] > 250 && res.exportRed[1] < 5],
    ['pen window meta carries setting', res.penMeta === 'n/a' ||
      (res.penMeta && res.penMeta.on === false && res.penMeta.opacity === 0.5)],
    ['saved to prefs', res.prefs && res.prefs.on === false && res.prefs.opacity === 0.5],
    ['viewbar button reflects state', res.btnOn === false],
    ['no page errors', errors.length === 0]
  ];
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
