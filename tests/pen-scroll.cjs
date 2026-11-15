/* Pen scrolling (src/pen-scroll.js): drag empty space in a scrolling area,
   or hold the side button and drag anywhere. */
const { launch, FILE } = require('./launch-browser.cjs');

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  await page.evaluate(() => {
    window.pen = async (el, dx, dy, button = 0, steps = 8) => {
      const r = el.getBoundingClientRect();
      const a = { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
      const buttons = button === 2 ? 2 : 1;
      const ev = (type, x, y, target) => (target || document.elementFromPoint(x, y) || document.body).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'pen', isPrimary: true,
        button: type === 'pointermove' ? -1 : button, buttons: type === 'pointerup' ? 0 : buttons, clientX: x, clientY: y
      }));
      ev('pointerdown', a.x, a.y, el);
      for (let i = 1; i <= steps; i++) { ev('pointermove', a.x + dx * i / steps, a.y + dy * i / steps, el); await new Promise(r => setTimeout(r, 12)); }
      ev('pointerup', a.x + dx, a.y + dy, el);
      await new Promise(r => setTimeout(r, 40));
    };
  });
  const checks = [], res = {};

  // storyboard mode: the sidebar is taller than the window and scrolls
  res.side = await page.evaluate(async () => {
    const a = window.OT.app;
    a.newProject({ name: 'S', width: 1920, height: 1080, fps: 24, frameCount: 48, bg: '#ffffff', board: true });
    await new Promise(r => setTimeout(r, 200));
    const sb = document.getElementById('sidebar');
    sb.scrollTop = 0;
    const can = sb.scrollHeight > sb.clientHeight;
    await window.pen(document.querySelector('#boardpanel .bp-label'), 0, -220);
    const afterDrag = sb.scrollTop;
    // dragging a slider moves the slider, not the sidebar
    sb.scrollTop = 0;
    const range = document.querySelector('#toolopts input[type="range"]');
    await window.pen(range, 0, -120);
    const afterSlider = sb.scrollTop;
    return { can, afterDrag, afterSlider };
  });
  checks.push(['pen drag on empty sidebar space scrolls it', res.side.can && res.side.afterDrag > 100]);
  checks.push(['pen drag on a slider does not scroll', res.side.afterSlider === 0]);

  // side button + drag scrolls the timeline sideways (its grid is a canvas)
  res.tl = await page.evaluate(async () => {
    const a = window.OT.app;
    a.newProject({ name: 'T', width: 640, height: 360, fps: 24, frameCount: 600 });
    await new Promise(r => setTimeout(r, 200));
    const wrap = document.querySelector('.tl-grid-wrap');
    wrap.scrollLeft = 0;
    const can = wrap.scrollWidth > wrap.clientWidth;
    const frame0 = a.frame;
    await window.pen(wrap.querySelector('canvas') || wrap, -300, 0, 2);
    const barrel = wrap.scrollLeft;
    wrap.scrollLeft = 0;
    await window.pen(wrap.querySelector('canvas') || wrap, -300, 0, 0);   // plain pen drag on the grid: no scroll
    return { can, barrel, plain: wrap.scrollLeft, frameKept: a.frame >= 0 && frame0 === 0 };
  });
  checks.push(['side-button drag scrolls the timeline', res.tl.can && res.tl.barrel > 150]);
  checks.push(['a plain pen drag on the timeline grid does not scroll it', res.tl.plain === 0]);

  // a tap is still a click: folding a sidebar section by its header
  res.tap = await page.evaluate(async () => {
    const head = document.querySelector('#toolopts .panel-head');
    const before = document.getElementById('toolopts').classList.contains('collapsed');
    await window.pen(head, 0, 0, 0, 1);
    head.click();
    await new Promise(r => setTimeout(r, 50));
    const after = document.getElementById('toolopts').classList.contains('collapsed');
    head.click();
    return { before, after };
  });
  checks.push(['a pen tap still clicks', res.tap.before !== res.tap.after]);

  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
