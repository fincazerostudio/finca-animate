/* Pen drag-and-drop shim (src/pen-dnd.js): reorder layers and storyboard
   panels with pen pointer events, which Chromium never turns into HTML5 DnD. */
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

  // a pen gesture: down on `from`, a few moves, up on `to` (element centres
  // shifted by dy so a drop lands in the row's upper or lower half)
  await page.evaluate(() => {
    window.penDrag = async (fromEl, toEl, dy, steps = 6, dx = 0) => {
      const c = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const a = c(fromEl), b = c(toEl); b.y += dy || 0; b.x += dx || 0;
      const ev = (type, p, target) => (target || document.elementFromPoint(p.x, p.y)).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'pen', isPrimary: true,
        button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y
      }));
      ev('pointerdown', a, fromEl);
      for (let i = 1; i <= steps; i++) {
        ev('pointermove', { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps });
        await new Promise(r => setTimeout(r, 16));
      }
      ev('pointerup', b);
      await new Promise(r => setTimeout(r, 60));
    };
  });
  const checks = [], res = {};

  // layers: two layers, drag the bottom one above the top one in the Layers panel
  res.layers = await page.evaluate(async () => {
    const a = window.OT.app;
    a.newProject({ name: 'L', width: 640, height: 360, fps: 24, frameCount: 12 });
    a.addLayer('vector');
    await new Promise(r => setTimeout(r, 100));
    const names = () => a.project.layers.map(l => l.name);
    const before = names();
    const rowOf = l => document.querySelector('#layerpanel [data-layer-id="' + l.id + '"]');
    const bottom = a.project.layers[0], top = a.project.layers[a.project.layers.length - 1];
    await window.penDrag(rowOf(bottom), rowOf(top), -8);   // drop in the top half = above
    const after = names();
    // a pen tap (no travel) still selects, and does not reorder
    const other = a.project.layers.find(l => l !== a.activeLayer());
    const r = rowOf(other).getBoundingClientRect();
    const p = { clientX: r.left + 20, clientY: r.top + r.height / 2, pointerId: 8, pointerType: 'pen', bubbles: true, button: 0, buttons: 1 };
    rowOf(other).dispatchEvent(new PointerEvent('pointerdown', p));
    rowOf(other).dispatchEvent(new PointerEvent('pointerup', Object.assign({}, p, { buttons: 0 })));
    rowOf(other).click();
    return { before, after, tapSelected: a.activeLayer() === other, unchanged: names().join() === after.join() };
  });
  checks.push(['pen drag reorders layers in the Layers panel', res.layers.after.join() === res.layers.before.slice().reverse().join()]);
  checks.push(['a pen tap still selects without reordering', res.layers.tapSelected && res.layers.unchanged]);
  // undo puts it back
  res.undo = await page.evaluate(() => { window.OT.app.undo(); return window.OT.app.project.layers.map(l => l.name); });
  checks.push(['the pen reorder is one undo step', res.undo.join() === res.layers.before.join()]);

  // storyboard: drag panel 1 after panel 2 in the strip
  res.board = await page.evaluate(async () => {
    const a = window.OT.app, O = window.OT.Board.Ops;
    a.newProject({ name: 'B', width: 1280, height: 720, fps: 24, frameCount: 24, board: true });
    O.newPanel(a);
    await new Promise(r => setTimeout(r, 150));
    const ids = () => a.project.board.panels.map(p => p.id);
    const before = ids();
    const cards = document.querySelectorAll('#boardstrip .bs-card');
    const r = cards[1].getBoundingClientRect();
    await window.penDrag(cards[0], cards[1], 0, 6, 50);
    // dragover picks before/after by x: move to the right half of card 2
    return { before, after: ids(), w: r.width };
  });
  // the drop landed on card 2's centre-or-right, so panel 1 now comes second
  checks.push(['pen drag reorders storyboard panels', res.board.after[1] === res.board.before[0] && res.board.after[0] === res.board.before[1]]);

  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
