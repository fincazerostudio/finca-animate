/* Tool properties bar (top of the stage) and the pie menu (pen side button / Q) */
const { launch, FILE } = require('./launch-browser.cjs');
const path = require('path');

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  const checks = [], res = {};

  res.bar = await page.evaluate(async () => {
    const a = window.OT.app, s = a.settings;
    a.tools.select('brush');
    const bar = document.getElementById('toolprops');
    const ranges = () => Array.from(bar.querySelectorAll('input[type=range]'));
    const brush = { label: bar.querySelector('.tp-tool').textContent, n: ranges().length, presets: !!bar.querySelector('.tp-presets') };
    // bar -> setting -> sidebar
    const r0 = ranges()[0];
    r0.value = '42'; r0.dispatchEvent(new Event('input')); r0.dispatchEvent(new Event('change'));
    const sideSize = document.querySelector('#toolopts input[type=range]').value;
    const fromBar = { setting: s.brushSize, side: sideSize };
    // sidebar -> setting -> bar
    const side = document.querySelector('#toolopts input[type=range]');
    side.value = '17'; side.dispatchEvent(new Event('input'));
    const fromSide = { setting: s.brushSize, bar: ranges()[0].value };
    // preset
    const sel = bar.querySelector('.tp-presets');
    const preset = a.brushPresets.find(p => p.tool === 'brush' && p.size !== s.brushSize);
    sel.value = preset.id; sel.dispatchEvent(new Event('change'));
    const presetApplied = s.brushSize === preset.size;
    a.tools.select('eraser');
    const eraser = { label: bar.querySelector('.tp-tool').textContent, n: ranges().length };
    a.tools.select('hand');
    const hand = { n: ranges().length, label: bar.querySelector('.tp-tool').textContent };
    a.tools.select('brush');
    return { brush, fromBar, fromSide, presetApplied, eraser, hand };
  });
  const b = res.bar;
  checks.push(['tool bar shows the brush with size, opacity, smoothing and presets', /Brush/.test(b.brush.label) && b.brush.n === 3 && b.brush.presets]);
  checks.push(['moving a bar slider sets the tool and the sidebar follows', b.fromBar.setting === 42 && b.fromBar.side === '42']);
  checks.push(['moving the sidebar slider updates the bar', b.fromSide.setting === 17 && b.fromSide.bar === '17']);
  checks.push(['picking a preset in the bar applies it', b.presetApplied]);
  checks.push(['the bar follows the tool (eraser: 2 sliders; pan: none)', /Eraser/.test(b.eraser.label) && b.eraser.n === 2 && b.hand.n === 0]);

  // pie menu by key
  await page.mouse.move(700, 450);
  await page.keyboard.press('q');
  await page.waitForTimeout(200);
  res.pieKey = await page.evaluate(() => ({ open: !!document.querySelector('.pie'), items: document.querySelectorAll('.pie .pie-item').length,
    on: (document.querySelector('.pie .pie-item.is-on') || {}).title || '' }));
  await page.screenshot({ path: path.join(__dirname, 'pie-menu.png') });
  await page.evaluate(() => Array.from(document.querySelectorAll('.pie .pie-item')).find(x => /Eraser/.test(x.title)).click());
  res.pieRun = await page.evaluate(() => ({ tool: window.OT.app.tools.active.name, open: !!document.querySelector('.pie') }));
  checks.push(['Q opens the ring of 8 at the pointer, current tool marked', res.pieKey.open && res.pieKey.items === 8 && /Brush/.test(res.pieKey.on)]);
  checks.push(['tapping an item picks it and closes the ring', res.pieRun.tool === 'eraser' && !res.pieRun.open]);

  // pen side button: a tap opens it, a drag pans instead
  res.pen = await page.evaluate(async () => {
    const cv = document.getElementById('canvas'), r = cv.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const fire = (t, px, py, tgt) => (tgt || cv).dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'pen',
      button: t === 'pointermove' ? -1 : 2, buttons: t === 'pointerup' ? 0 : 2, clientX: px, clientY: py }));
    const a = window.OT.app, vx = a.stage.view.x;
    fire('pointerdown', x, y); fire('pointerup', x + 2, y + 1);
    await new Promise(r => setTimeout(r, 30));
    const tapOpen = !!document.querySelector('.pie');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escClosed = !document.querySelector('.pie');
    fire('pointerdown', x, y);
    for (let i = 1; i <= 6; i++) fire('pointermove', x + i * 20, y);
    fire('pointerup', x + 120, y);
    await new Promise(r => setTimeout(r, 30));
    return { tapOpen, escClosed, dragOpen: !!document.querySelector('.pie'), panned: a.stage.view.x !== vx };
  });
  checks.push(['a pen side-button tap opens the ring; Esc closes it', res.pen.tapOpen && res.pen.escClosed]);
  checks.push(['a side-button drag still pans and does not open the ring', !res.pen.dragOpen && res.pen.panned]);

  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
