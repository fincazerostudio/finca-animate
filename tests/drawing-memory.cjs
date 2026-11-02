/* Memory per drawing: lazy cel surfaces, vector surface release, budget trim. */
const assert = require('node:assert/strict');
const { launch, FILE } = require('./launch-browser.cjs');

(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(FILE);
    await page.waitForFunction(() => window.OT && OT.app && OT.app.ui && OT.CelMemory);
    await page.evaluate(() => { const l = OT.app._launcher; if (l) l.close(); });

    // A single cel: lazy allocation, pixel-identical re-rasterising,
    // no double-drawn appended strokes, borrowed thumbnails.
    const unit = await page.evaluate(() => {
      const W = 200, H = 120;
      const line = (y, color) => ({ type: 'line', pts: [{ x: 10, y: 10, p: 1 }, { x: 180, y, p: 1 }], color, width: 6, opacity: 0.5 });
      const px = c => Array.from(c.ctx.getImageData(0, 0, W, H).data);
      const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const r = {};
      const c = new OT.Cel(1, W, H, 'vector');
      r.lazyNew = !c.hasCanvas;
      c.strokes = [line(60, '#ff0000'), { type: 'fill', pts: [{ x: 20, y: 20 }, { x: 90, y: 20 }, { x: 90, y: 90 }], color: '#00ff00', opacity: 1 }];
      c.eraserMarks = [{ x: 50, y: 40, r: 8 }];
      c.rebuild();
      r.lazyAfterRebuild = !c.hasCanvas;
      const rev = c._rev;
      const a = px(c);
      r.allocatedOnAccess = c.hasCanvas;
      r.revKept = c._rev === rev;
      // eager reference: render the same strokes the old way
      const ref = new OT.Cel(2, W, H, 'vector');
      ref.strokes = c.strokes; ref.eraserMarks = c.eraserMarks;
      ref.ctx; OT.Vector.renderCel(ref);
      r.matchesEager = same(a, px(ref));
      r.freed = c.release();
      r.releasedAgain = c.release() === 0 && !c.hasCanvas;
      r.identicalAfterRealloc = same(a, px(c));
      // appendStroke on a released cel must not draw the stroke twice
      c.release();
      const s3 = line(100, '#0000ff');
      c.strokes.push(s3); c.appendStroke(s3);
      r.lazyAfterAppend = !c.hasCanvas;
      const appended = px(c);
      const full = new OT.Cel(3, W, H, 'vector');
      full.strokes = c.strokes; full.eraserMarks = c.eraserMarks; full.ctx; OT.Vector.renderCel(full);
      r.appendNoDouble = same(appended, px(full));
      // thumbnails borrow a surface and give it back
      c.release();
      const t = c.getThumb(48, 27);
      r.thumbBorrowed = !c.hasCanvas && t.getContext('2d').getImageData(0, 0, 48, 27).data.some((v, i) => i % 4 === 3 && v);
      // snapshot / restore across a release (undo path)
      const snap = c.snapshot(); c.release(); c.restore(snap);
      r.restoreOk = same(px(c), appended);
      // blank checks without allocating
      const empty = new OT.Cel(4, W, H, 'vector'), rempty = new OT.Cel(5, W, H, 'raster');
      r.blankNoAlloc = empty.isBlank() && rempty.isBlank() && !empty.hasCanvas && !rempty.hasCanvas;
      // raster surfaces are the drawing: never released
      rempty.ctx.fillRect(0, 0, 5, 5);
      r.rasterKept = rempty.release() === 0 && rempty.hasCanvas && !rempty.isBlank();
      return r;
    });
    for (const [k, v] of Object.entries(unit)) if (k !== 'freed') assert.equal(v, true, 'unit: ' + k);
    assert.equal(unit.freed, 200 * 120 * 4);
    console.log('PASS lazy vector surfaces, identical re-rasterising, append, thumbnails, undo restore');

    // A 300-drawing 1080p vector scene: opening it allocates no surfaces;
    // touching all of them and trimming brings them under the budget while
    // the current frame stays resident; nothing is freed mid-stroke.
    const scene = await page.evaluate(async () => {
      const a = OT.app, N = 300, W = 1920, H = 1080;
      const l = new OT.Layer('Anim', 'vector');
      a.project.width = W; a.project.height = H; a.project.frameCount = N;
      a.project.layers = [l]; a._activeLayer = l;
      a.selectedLayers.clear(); a.selectedLayers.add(l);
      for (let n = 1; n <= N; n++) {
        const c = new OT.Cel(n, W, H, 'vector');
        c.strokes = [{ type: 'line', pts: [{ x: 100, y: 100, p: 1 }, { x: 100 + n * 5, y: 900, p: 1 }], color: '#222222', width: 8, opacity: 1 }];
        l.cels[n] = c; l.exposure[n - 1] = n;
      }
      l.nextNum = N + 1;
      const file = JSON.parse(JSON.stringify(OT.IO.serialize(a)));
      const loaded = await OT.IO.deserialize(file);
      a.project = loaded.project; a._activeLayer = a.project.layers[0];
      a.selectedLayers.clear(); a.selectedLayers.add(a._activeLayer);
      a.history.clear();
      const r = {};
      r.afterLoad = OT.CelMemory.stats(a.project);
      a.setFrame(150);
      for (const n in a._activeLayer.cels) a._activeLayer.cels[n].canvas;  // touch everything
      r.touched = OT.CelMemory.stats(a.project);
      const budget = 64 * 1024 * 1024;
      a.tools.dragging = true;
      r.freedWhileDragging = OT.CelMemory.trim(a, budget);
      a.tools.dragging = false;
      r.freed = OT.CelMemory.trim(a, budget);
      r.trimmed = OT.CelMemory.stats(a.project);
      r.budget = budget;
      const cur = a._activeLayer.celAt(150);
      r.currentKept = cur.hasCanvas;
      // kept ones are the nearest to the playhead
      const kept = Object.values(a._activeLayer.cels).filter(c => c.hasCanvas).map(c => c.num);
      r.keptNear = kept.every(n => Math.abs(n - 151) <= 8);
      // the throttled hook trims on its own after a frame change
      OT.app.settings.celMemoryMB = 32;
      for (const n in a._activeLayer.cels) a._activeLayer.cels[n].canvas;
      a.setFrame(10);
      await new Promise(res => setTimeout(res, 700));
      r.autoTrimmed = OT.CelMemory.stats(a.project);
      delete OT.app.settings.celMemoryMB;
      // the scene still renders and saves the same after all that
      const again = JSON.stringify(OT.IO.serialize(a).layers[0].cels);
      r.saveSame = again === JSON.stringify(file.layers[0].cels);
      return r;
    });
    const MB = 1920 * 1080 * 4;
    assert.equal(scene.afterLoad.allocated, 0, 'opening allocates no surfaces');
    assert.equal(scene.touched.vectorAllocated, 300);
    assert.equal(scene.freedWhileDragging, 0, 'no release mid-stroke');
    assert.ok(scene.trimmed.vectorBytes <= scene.budget, 'trimmed under budget');
    assert.equal(scene.freed, (300 - scene.trimmed.vectorAllocated) * MB);
    assert.ok(scene.currentKept, 'current frame stays resident');
    assert.ok(scene.keptNear, 'nearest drawings kept');
    assert.ok(scene.autoTrimmed.vectorBytes <= 32 * 1024 * 1024, 'auto trim on frame change');
    assert.ok(scene.saveSame, 'save output unchanged');
    console.log(`PASS 300-drawing 1080p scene: open ${scene.afterLoad.mb} MB (was ${Math.round(300 * MB / 1048576)} MB), ` +
      `all touched ${scene.touched.mb} MB, trimmed ${scene.trimmed.mb} MB, auto ${scene.autoTrimmed.mb} MB`);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
