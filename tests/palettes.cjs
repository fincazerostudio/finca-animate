/* Line Art / Colour Art + linked palette colours */
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
      px(x, y) { return Array.from(window.T.cel().ctx.getImageData(x, y, 1, 1).data); }
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
  const res = {};
  const checks = [];

  /* ---------- Line Art / Colour Art ---------- */
  await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(0); a.tools.select('brush'); a.settings.size = 24;
    if (a.tools.active.size != null) a.tools.active.size = 24;
    a.setColor('#000000');
  });
  await stroke(line(700, 300, 700, 700));                      // black vertical, Line Art
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await page.keyboard.press('Alt+c');
  await page.evaluate(() => window.OT.app.setColor('#ff0000'));
  await stroke(line(500, 500, 900, 500));                      // red horizontal, Colour Art, drawn later
  res.art = await page.evaluate(() => {
    const a = window.OT.app, s = window.T.cel().strokes;
    return { mode: a.artMode, tags: s.map(st => st.art || 'line'), btn: a.ui.artBtn.textContent,
             cross: window.T.px(700, 500), redOnly: window.T.px(560, 500), blackOnly: window.T.px(700, 360) };
  });
  checks.push(
    ['Alt+C switches to Colour Art (viewbar shows it)', res.art.mode === 'color' && res.art.btn === 'Colour Art'],
    ['strokes are tagged with their art layer', JSON.stringify(res.art.tags) === JSON.stringify(['line', 'color'])],
    ['colour art drawn later still sits under the line art', isBlack(res.art.cross) && isRed(res.art.redOnly)]
  );
  // eraser on Colour Art cuts colour only
  await page.evaluate(() => { const a = window.OT.app; a.tools.select('eraser'); if (a.tools.active.size != null) a.tools.active.size = 40; });
  await stroke(line(690, 490, 710, 510));                      // across the crossing
  res.eraseColor = await page.evaluate(() => ({ cross: window.T.px(700, 500), marks: window.T.cel().eraserMarks.map(m => m.art) }));
  // eraser on Line Art cuts line only (colour stays under where the line was)
  await page.keyboard.press('Alt+c');
  await stroke(line(600, 490, 600, 510));                      // red-only spot
  res.eraseLine = await page.evaluate(() => ({ red: window.T.px(600, 500), mode: window.OT.app.artMode }));
  checks.push(
    ['colour-art eraser cuts the colour but not the line on top', isBlack(res.eraseColor.cross) && res.eraseColor.marks.every(m => m === 'color')],
    ['line-art eraser leaves colour art alone', res.eraseLine.mode === 'line' && isRed(res.eraseLine.red)]
  );
  // older drawings (no tags): new renderer == the old one, pixel for pixel
  res.compat = await page.evaluate(() => {
    const V = window.OT.Vector, cel = new window.OT.Cel(1, 400, 300, 'vector');
    cel.strokes = [
      { id: 'a', type: 'line', color: '#000', width: 12, opacity: 1, pts: [{ x: 20, y: 20, p: 1 }, { x: 380, y: 280, p: 1 }] },
      { id: 'b', type: 'fill', color: '#3a6', opacity: 1, contour: [{ x: 50, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 250 }, { x: 50, y: 250 }], grow: 0 },
      { id: 'c', type: 'line', color: '#c33', width: 8, opacity: 0.6, pts: [{ x: 380, y: 20, p: 1 }, { x: 20, y: 280, p: 1 }] }
    ];
    cel.eraserMarks = [{ x: 200, y: 150, r: 30 }, { x: 100, y: 75, r: 15 }];
    cel.rebuild();
    const now = cel.ctx.getImageData(0, 0, 400, 300).data;
    // the previous algorithm: fills, then lines, then every mark
    const o = document.createElement('canvas'); o.width = 400; o.height = 300; const x = o.getContext('2d');
    for (const st of cel.strokes) if (st.type === 'fill') V.renderStroke(x, st);
    for (const st of cel.strokes) if (st.type !== 'fill') V.renderStroke(x, st);
    x.globalCompositeOperation = 'destination-out';
    for (const m of cel.eraserMarks) { x.beginPath(); x.arc(m.x, m.y, m.r, 0, Math.PI * 2); x.fill(); }
    const old = x.getImageData(0, 0, 400, 300).data;
    let diff = 0; for (let i = 0; i < old.length; i++) diff = Math.max(diff, Math.abs(old[i] - now[i]));
    return diff;
  });
  res.pen = await page.evaluate(() => {
    const st = window.OT._serializeStroke({ id: 'x', type: 'line', pts: [], color: '#f00', art: 'color', swatch: 'sw1' });
    return st.art === 'color' && st.swatch === 'sw1';
  });
  checks.push(
    ['older drawings render exactly as before (max pixel diff 0)', res.compat === 0],
    ['pen window keeps art + swatch on strokes', res.pen]
  );

  /* ---------- linked palette colours ---------- */
  await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(1); a.newDrawing(); a.tools.select('brush'); a.setArtMode('line');
  });
  const sw = await page.$$('.swatches .swatch:not(.add)');
  await sw[4].click();                                          // #e0533d in the default palette
  await stroke(line(300, 200, 500, 200));
  res.link = await page.evaluate(() => {
    const a = window.OT.app, st = window.T.cel().strokes[0], s = a.palette.byId(a.swatchId);
    return { id: a.swatchId, color: s && s.color, stSwatch: st.swatch, stColor: st.color,
             sel: !!document.querySelector('.swatches .swatch.sel') };
  });
  // a non-palette colour unlinks
  await page.evaluate(() => window.OT.app.setColor('#123456'));
  await stroke(line(300, 260, 500, 260));
  // another layer + frame 0 use the swatch too
  await page.evaluate(() => {
    const a = window.OT.app; a.swatchId = null;
    a.setColor(a.palette.swatches[4].color);                     // picking the swatch's colour re-links
    window.__relink = a.swatchId === a.palette.swatches[4].id;
    a.addLayer('vector'); a.setFrame(0);
  });
  await stroke(line(300, 800, 500, 800));
  res.unlink = await page.evaluate(() => {
    const a = window.OT.app, L = a.project.layers;
    const f1 = L[0].cels[L[0].exposure[1]].strokes;
    return { second: f1[1].swatch === undefined, relink: window.__relink,
             count: a.swatchUseCount(a.palette.swatches[4].id) };
  });
  checks.push(
    ['clicking a swatch links new strokes to it', res.link.id && res.link.stSwatch === res.link.id && res.link.stColor === res.link.color && res.link.sel],
    ['a non-palette colour draws unlinked', res.unlink.second],
    ['picking a swatch colour (eyedropper / hex) re-links', res.unlink.relink],
    ['links counted across layers and frames', res.unlink.count === 2]
  );
  // edit the swatch via its right-click menu: live, then Apply
  const swEl = (await page.$$('.swatches .swatch:not(.add)'))[4];
  await swEl.click({ button: 'right' });
  await page.waitForTimeout(100);
  res.menu = await page.$$eval('.menu-pop .menu-row', r => r.map(x => x.textContent.trim()));
  await page.$$eval('.menu-pop .menu-row', r => r.find(x => x.textContent.includes('Edit Colour')).click());
  await page.waitForTimeout(100);
  await page.fill('.modal input[type=text]', '#00aa00');
  await page.waitForTimeout(80);
  res.live = await page.evaluate(() => {
    const a = window.OT.app, L = a.project.layers, id = a.palette.swatches[4].id;
    const all = [];
    for (const l of L) for (const n in l.cels) for (const st of (l.cels[n].strokes || [])) if (st.swatch === id) all.push(st.color);
    const other = L[0].cels[L[0].exposure[1]].strokes[1].color;
    return { all, other, undo: a.history.undoStack.length };
  });
  await page.$$eval('.modal .btn', b => b.find(x => x.textContent === 'Apply').click());
  await page.waitForTimeout(80);
  res.applied = await page.evaluate(() => {
    const a = window.OT.app, L = a.project.layers;
    const st0 = L[0].cels[L[0].exposure[1]].strokes[0];
    const px = (() => { const c = L[0].cels[L[0].exposure[1]]; return Array.from(c.ctx.getImageData(400, 200, 1, 1).data); })();
    const r = { color: st0.color, px, undoLen: a.history.undoStack.length };
    a.undo();
    r.undone = [st0.color, L[0].cels[L[0].exposure[1]].strokes[0].color, a.palette.swatches[4].color];
    a.redo();
    r.redone = [L[0].cels[L[0].exposure[1]].strokes[0].color, a.palette.swatches[4].color];
    return r;
  });
  checks.push(
    ['swatch right-click menu: Edit Colour (n linked) / Rename / Delete',
      res.menu.some(t => /^Edit Colour… +\(2 linked\)$/.test(t)) && res.menu.includes('Rename…') && res.menu.includes('Delete Swatch')],
    ['editing recolours every linked stroke live', res.live.all.length === 2 && res.live.all.every(c => c === '#00aa00')],
    ['unlinked strokes keep their colour', res.live.other === '#123456'],
    ['applied: drawing re-rendered in the new colour', res.applied.color === '#00aa00' && res.applied.px[1] > 140 && res.applied.px[0] < 40],
    ['undo restores strokes + swatch in one step', res.applied.undone[1] === '#e0533d' && res.applied.undone[2] === '#e0533d'],
    ['redo re-applies', res.applied.redone[0] === '#00aa00' && res.applied.redone[1] === '#00aa00']
  );
  // Esc cancels a live edit, no history entry
  res.cancel = await (async () => {
    const before = await page.evaluate(() => window.OT.app.history.undoStack.length);
    await page.evaluate(() => window.OT.app.ui.editSwatchDialog(window.OT.app.palette.swatches[4].id));
    await page.fill('.modal input[type=text]', '#0000ff');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    return page.evaluate((b) => {
      const a = window.OT.app, L = a.project.layers;
      return { color: L[0].cels[L[0].exposure[1]].strokes[0].color, sw: a.palette.swatches[4].color,
               same: a.history.undoStack.length === b };
    }, before);
  })();
  checks.push(['Esc cancels: colours back, no undo entry', res.cancel.color === '#00aa00' && res.cancel.sw === '#00aa00' && res.cancel.same]);
  // save / load keeps the links
  res.io = await page.evaluate(async () => {
    const a = window.OT.app;
    const data = JSON.parse(JSON.stringify(window.OT.IO.serialize(a)));
    const d = await window.OT.IO.deserialize(data);
    a.loadProjectData(d);
    const id = a.palette.swatches[4].id;
    const n = a.swatchUseCount(id);
    a.beginSwatchEdit(id); a.previewSwatch('#884400'); a.commitSwatchEdit();
    const L = a.project.layers;
    return { idKept: id === data.palette[4].id, n, after: L[0].cels[L[0].exposure[1]].strokes[0].color,
             art: L[0].cels[L[0].exposure[0]].strokes.map(s => s.art || 'line') };
  });
  checks.push(
    ['save/load keeps swatch ids and stroke links', res.io.idKept && res.io.n === 2 && res.io.after === '#884400'],
    ['save/load keeps Line / Colour Art tags', JSON.stringify(res.io.art) === JSON.stringify(['line', 'color'])]
  );

  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
