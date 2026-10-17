/* Drawing substitution and the existing basic scripting console. */
const assert = require('node:assert/strict');
const { launch, FILE } = require('./launch-browser.cjs');

(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(FILE);
    await page.waitForFunction(() => window.OT && OT.app && OT.app.ui);
    await page.evaluate(() => { const l = OT.app._launcher; if (l) l.close(); });

    // Both drawing types: shared cel identity, boundaries, no-ops, undo/redo,
    // gap semantics, invalid input and lock guards, including file round-trip.
    for (const type of ['vector', 'drawing']) {
      const result = await page.evaluate(async type => {
        const a = OT.app, l = new OT.Layer('Mouths', type);
        a.project.width = 160; a.project.height = 90; a.project.frameCount = 8;
        a.project.layers = [l]; a._activeLayer = l;
        a.selectedLayers.clear(); a.selectedLayers.add(l);
        for (let n = 1; n <= 3; n++) {
          const c = new OT.Cel(n, 160, 90, type === 'vector' ? 'vector' : 'raster');
          if (type === 'vector') {
            c.strokes = [{ type: 'line', pts: [{ x: 10, y: 10, p: 1 }, { x: 120, y: n * 20, p: 1 }], color: '#ff0000', width: 5, opacity: 1 }];
            c.rebuild();
          } else { c.ctx.fillStyle = '#ff0000'; c.ctx.fillRect(10, 10, 40, n * 10); }
          c.dirty(); l.cels[n] = c;
        }
        l.nextNum = 4; l.exposure = [1, 1, 1, 2, 0, 0, 1, 1];
        a.history.clear(); a.setFrame(1);
        const original = l.cels[3];
        a.substituteDrawing(3);
        const single = l.exposure.slice();
        const shared = l.celAt(1) === original;
        a.undo(); const undone = l.exposure.slice();
        a.redo(); const redone = l.exposure.slice();
        a.undo();
        a.substituteDrawing(3, 'held'); const held = l.exposure.slice();
        const count = a.history.undoStack.length;
        const noop = a.substituteDrawing(3) === false && a.history.undoStack.length === count;
        a.setFrame(4); a.substituteDrawing(3, 'held'); const gap = l.exposure.slice();
        a.setFrame(6); a.substituteDrawing(0, 'held'); const empty = l.exposure.slice();
        const before = JSON.stringify(l.exposure), size = a.history.undoStack.length;
        const invalid = [99, -1, 1.5, NaN, '1'].every(n => a.substituteDrawing(n) === false)
          && a.substituteDrawing(1, 'invalid') === false;
        l.locked = true;
        const locked = a.substituteDrawing(1) === false;
        l.locked = false;
        const untouched = before === JSON.stringify(l.exposure) && size === a.history.undoStack.length;
        const loaded = await OT.IO.deserialize(JSON.parse(JSON.stringify(OT.IO.serialize(a))));
        const restored = loaded.project.layers[0];
        const roundtrip = JSON.stringify(restored.exposure) === JSON.stringify(l.exposure)
          && Object.keys(restored.cels).length === 3 && restored.nextNum === 4;
        const retainedArt = restored.cels[3].ctx.getImageData(0, 0, 160, 90).data.some((v, i) => i % 4 === 3 && v > 0);
        // A held exposure at the project end must stop at frameCount.
        l.exposure = [1, 1, 1, 2, 0, 0, 1, 1]; a.setFrame(7);
        a.substituteDrawing(2, 'held'); const tail = l.exposure.slice();
        const group = new OT.Layer('Group', 'group'); a.project.layers.push(group); a._activeLayer = group;
        const nonDrawing = a.substituteDrawing(1) === false;
        a._activeLayer = l; a.emitAll();
        return { single, shared, undone, redone, held, noop, gap, empty, invalid, locked, untouched, roundtrip, retainedArt, tail, nonDrawing };
      }, type);
      assert.deepEqual(result.single, [1, 3, 1, 2, 0, 0, 1, 1]);
      assert.deepEqual(result.undone, [1, 1, 1, 2, 0, 0, 1, 1]);
      assert.deepEqual(result.redone, result.single);
      assert.deepEqual(result.held, [1, 3, 3, 2, 0, 0, 1, 1]);
      assert.deepEqual(result.gap, [1, 3, 3, 2, 3, 0, 1, 1]);
      assert.deepEqual(result.empty, [1, 3, 3, 2, 3, 0, 0, 0]);
      assert.deepEqual(result.tail, [1, 1, 1, 2, 0, 0, 1, 2]);
      for (const key of ['shared', 'noop', 'invalid', 'locked', 'untouched', 'roundtrip', 'retainedArt', 'nonDrawing']) assert.equal(result[key], true, type + ': ' + key);
      console.log('PASS ' + type + ' substitution, undo/redo, validation and save/reload');
    }

    const menu = async (title, row) => {
      await page.locator('.menu-item').filter({ hasText: title }).click();
      await page.locator('.menu-pop .menu-row').filter({ hasText: row }).click();
    };
    await page.evaluate(() => { OT.app.setFrame(0); });
    await menu('Animation', 'Drawing Substitution');
    assert.equal(await page.locator('.drawing-choice').count(), 4);
    assert.equal(await page.locator('.drawing-choice canvas').count(), 3);
    await page.locator('[data-drawing="3"]').click();
    await page.keyboard.press('.');
    assert.equal(await page.evaluate(() => OT.app.frame), 0);
    await page.getByLabel('Apply to', { exact: true }).selectOption('held');
    await page.screenshot({ path: '/tmp/finca-animate-substitution.png' });
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => OT.app.activeLayer().exposure.slice(0, 4)), [3, 3, 3, 2]);
    await menu('Animation', 'Drawing Substitution');
    await page.locator('[data-drawing="1"]').click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => OT.app.activeLayer().exposure[0]), 3);
    await menu('Animation', 'Drawing Substitution');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.drawing-substitution').count(), 0);
    console.log('PASS thumbnail picker, apply, cancel and Escape');

    await menu('Help', 'Scripting Console');
    const input = page.getByLabel('JavaScript source');
    const script = "app.addLayer('vector'); return app.project.layers.length;";
    const previous = await page.evaluate(() => OT.app.project.layers.length);
    await input.fill(script);
    await input.press('Control+Enter');
    assert.equal(await page.locator('.modal pre').textContent(), String(previous + 1));
    await page.evaluate(() => OT.app.undo());
    assert.equal(await page.evaluate(() => OT.app.project.layers.length), previous);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await menu('Help', 'Scripting Console');
    assert.equal(await input.inputValue(), script);
    await input.fill('return {frame: app.frame, available: !!OT.Cel};');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    assert.equal(JSON.parse(await page.locator('.modal pre').textContent()).available, true);
    await input.fill('throw new Error("Example error");');
    await input.press('Control+Enter');
    assert.equal(await page.locator('.modal pre').textContent(), 'Error: Example error');
    await input.fill('return (');
    await input.press('Control+Enter');
    assert.match(await page.locator('.modal pre').textContent(), /^SyntaxError:/);
    await input.fill('return 42;');
    await input.press('Meta+Enter');
    assert.equal(await page.locator('.modal pre').textContent(), '42');
    await page.keyboard.press('Escape');
    console.log('PASS scripting console commands, undo, return values, persistence, errors and shortcuts');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
