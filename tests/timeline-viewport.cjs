/* Long timelines: bounded rendering and correct input after scrolling. */
'use strict';
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
    await page.evaluate(() => {
      OT.app._launcher?.close();
      const p = new OT.Project({ width: 160, height: 90, frameCount: 2880, empty: true });
      const l = new OT.Layer('Long shot', 'vector');
      for (let f = 0; f < 2880; f += 2) {
        const c = new OT.Cel(f / 2 + 1, 160, 90, 'vector');
        l.cels[c.num] = c; l.exposure[f] = l.exposure[f + 1] = c.num;
      }
      p.layers.push(l); OT.app.loadProjectData({ project: p });
      const t = OT.app.timeline;
      t.showThumbs = true;
      window.thumbCalls = 0;
      for (const c of Object.values(l.cels)) c.getThumb = () => {
        window.thumbCalls++; return document.createElement('canvas');
      };
      t.render();
    });
    const initial = await page.evaluate(() => {
      const t = OT.app.timeline;
      return { width: t.grid.width, viewport: t.gridWrap.clientWidth, scroll: t.gridWrap.scrollWidth, thumbs: window.thumbCalls };
    });
    assert(initial.width <= initial.viewport * 2);
    assert(initial.scroll >= 2880 * 15);
    assert(initial.thumbs < 100, JSON.stringify(initial));
    await page.evaluate(() => { OT.app.timeline.gridWrap.scrollLeft = 30000; });
    await page.waitForFunction(() => OT.app.timeline._gridX >= 30000);
    const point = await page.evaluate(() => {
      const t = OT.app.timeline, r = t.grid.getBoundingClientRect();
      const x = Math.min(100, r.width / 2);
      return { x: r.left + x, y: r.top + 10, frame: Math.floor((t._gridX + x) / t.cellW) };
    });
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => OT.app.frame), point.frame);
    // The scrollable end handle remains reachable beyond the last frame.
    await page.evaluate(() => { const t = OT.app.timeline; t.gridWrap.scrollLeft = t.gridWrap.scrollWidth; });
    await page.waitForTimeout(50);
    const end = await page.evaluate(() => {
      const t = OT.app.timeline, r = t.grid.getBoundingClientRect();
      return { x: r.left + OT.app.project.frameCount * t.cellW - t._gridX, y: r.top + 10 };
    });
    await page.mouse.move(end.x, end.y);
    await page.mouse.down(); await page.mouse.move(end.x - 45, end.y); await page.mouse.up();
    assert.equal(await page.evaluate(() => OT.app.project.frameCount), 2877);
    assert.deepEqual(errors, []);
    console.log('PASS bounded long-timeline canvas, visible thumbnails, scrolled frame input and end-handle drag');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
