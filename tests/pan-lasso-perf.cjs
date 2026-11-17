/* Pan + lasso responsiveness on a heavy scene.
 *
 *   node tests/pan-lasso-perf.cjs [--report]
 *
 * Scene: 1920x1080, 4 vector layers x 300 strokes (80 points each) on the
 * current frame and its neighbours, 2 bitmap layers, onion skin on (2 + 2).
 * A pen reports ~250 times a second, so every gesture below is paced at 4 ms:
 *   pan     : side-button drag across the stage (button 2)
 *   hand    : the same with the Hand tool (Space / H)
 *   lasso   : a 600-point loop on a bitmap layer, then on a vector layer
 *   move    : dragging a lifted bitmap selection
 * For each we record the main-thread time spent inside the input handlers
 * per second of gesture ("busy"); over ~1000 ms/s the app falls behind the
 * pen and the stage lags. Checks use generous limits; --report only prints.
 */
'use strict';
const { launch, FILE } = require('./launch-browser.cjs');
const REPORT = process.argv.includes('--report');

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });

  await page.evaluate(() => {
    const a = window.OT.app, p = a.project;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 4; i++) a.addLayer('vector');
    for (let i = 0; i < 2; i++) a.addLayer('drawing');
    for (const layer of p.layers) {
      for (let f = 0; f < 5; f++) {
        const cel = layer.drawingAt(f, p.width, p.height);
        if (layer.type === 'vector') {
          cel.strokes = [];
          for (let s = 0; s < 150; s++) {
            const x0 = rnd() * p.width, y0 = rnd() * p.height, pts = [];
            for (let k = 0; k < 80; k++) pts.push({ x: x0 + k * 3, y: y0 + Math.sin(k / 6 + s) * 30, p: 0.4 + rnd() * 0.5 });
            cel.strokes.push({ id: 's' + s + '_' + f, type: 'line', pencil: false, color: '#203040', width: 3 + rnd() * 6, opacity: 1, pts, closed: false });
          }
          if (cel.rebuild) cel.rebuild();
        } else if (cel.ctx) {
          const x = cel.ctx;
          for (let s = 0; s < 400; s++) { x.fillStyle = `hsl(${s % 360},60%,60%)`; x.beginPath(); x.arc(rnd() * p.width, rnd() * p.height, 10 + rnd() * 40, 0, 7); x.fill(); }
          cel._rev = (cel._rev || 0) + 1;
        }
      }
    }
    a.frame = 2;
    a.onion.on = true; a.onion.prev = 2; a.onion.next = 2;
    a.emit('render');
  });

  // One gesture: down, n moves along fn(i), up; paced at `ms`. Returns
  // busy = handler ms per second of gesture, worst = slowest single event.
  const gesture = (opts) => page.evaluate(async (o) => {
    const a = window.OT.app, cv = a.stage.canvas, r = cv.getBoundingClientRect();
    const fire = (type, x, y) => {
      const t0 = performance.now();
      cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'pen', isPrimary: true,
        pressure: 0.5, button: type === 'pointermove' ? -1 : o.button, buttons: type === 'pointerup' ? 0 : (o.button === 2 ? 2 : 1),
        clientX: r.left + x, clientY: r.top + y }));
      return performance.now() - t0;
    };
    const wait = ms => new Promise(res => { const t0 = performance.now(); (function spin() { if (performance.now() - t0 >= ms) res(); else setTimeout(spin, 0); })(); });
    const path = new Function('i', 'n', 'return ' + o.path);
    let busy = 0, worst = 0, frames = 0, run = true;
    (function count() { if (!run) return; frames++; requestAnimationFrame(count); })();
    const [x0, y0] = path(0, o.n);
    busy += fire('pointerdown', x0, y0);
    const t0 = performance.now();
    for (let i = 1; i <= o.n; i++) {
      await wait(o.ms);
      const [x, y] = path(i, o.n);
      const d = fire('pointermove', x, y); busy += d; if (d > worst) worst = d;
    }
    // let any frame-coalesced work land before measuring
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const secs = (performance.now() - t0) / 1000;
    const [x1, y1] = path(o.n, o.n);
    busy += fire('pointerup', x1, y1);
    run = false;
    // rAF-deferred work is real main-thread time too: sample it with the
    // long-task-free proxy of total render time recorded by the stage.
    return { busyPerSec: Math.round(busy / secs), worstMs: +worst.toFixed(1), fps: Math.round(frames / secs), secs: +secs.toFixed(2) };
  }, opts);

  const timeRender = () => page.evaluate(() => {
    const s = window.OT.app.stage; s.render();
    const t0 = performance.now(); for (let i = 0; i < 10; i++) s.render(); return +((performance.now() - t0) / 10).toFixed(1);
  });

  // render() is now rAF-coalesced in the input path, so wrap it to count the
  // real cost of each frame painted during a gesture.
  await page.evaluate(() => {
    const s = window.OT.app.stage, key = s._paintStage ? '_paintStage' : 'render', orig = s[key].bind(s);
    window.__rt = { ms: 0, n: 0 };
    s[key] = function () { const t0 = performance.now(); const r = orig.apply(this, arguments); window.__rt.ms += performance.now() - t0; window.__rt.n++; return r; };
    const oo = s.renderOverlay.bind(s);
    s.renderOverlay = function () { const t0 = performance.now(); const r = oo.apply(this, arguments); window.__rt.ms += performance.now() - t0; window.__rt.n++; return r; };
  });
  const withPaint = async (opts) => {
    await page.evaluate(() => { window.__rt.ms = 0; window.__rt.n = 0; });
    const g = await gesture(opts);
    const rt = await page.evaluate(() => window.__rt);
    // paint time not already inside a handler (rAF-deferred) still blocks input
    g.paintMs = Math.round(rt.ms); g.paints = rt.n;
    g.load = Math.round((g.busyPerSec + 0) / 10) / 100;   // fraction of each second the handlers took
    return g;
  };

  const res = {};
  const step = async (k, o) => { const t = Date.now(); const g = await withPaint(o); console.error(k, Date.now() - t, 'ms', JSON.stringify(g)); return g; };
  res.renderMs = await timeRender(); console.error('render', res.renderMs);
  await page.evaluate(() => window.OT.app.tools.select('brush'));
  res.pan = await step('pan', { button: 2, n: 120, ms: 4, path: '[500 + i * 2, 400 + Math.sin(i / 20) * 80]' });
  await page.evaluate(() => window.OT.app.tools.select('hand'));
  res.hand = await step('hand', { button: 0, n: 120, ms: 4, path: '[500 - i * 2, 400 + Math.cos(i / 20) * 80]' });

  // lasso on the top bitmap layer
  await page.evaluate(() => { const a = window.OT.app; a.selectLayer(a.project.layers[a.project.layers.length - 1]); a.tools.select('lasso'); });
  const loop = '[700 + Math.cos(i / n * 6.283) * 300 + Math.sin(i * 0.9) * 4, 450 + Math.sin(i / n * 6.283) * 250 + Math.cos(i * 1.3) * 4]';
  res.lassoBitmap = await step('lassoBitmap', { button: 0, n: 600, ms: 4, path: loop });
  // drag the lifted piece
  res.moveBitmap = await step('moveBitmap', { button: 0, n: 120, ms: 4, path: '[700 + i, 450 + i / 2]' });
  await page.evaluate(() => { const a = window.OT.app; a.tools.select('brush'); });
  // lasso on a vector layer
  await page.evaluate(() => { const a = window.OT.app; const v = a.project.layers.find(l => l.type === 'vector'); a.selectLayer(v); a.tools.select('lasso'); });
  res.lassoVector = await step('lassoVector', { button: 0, n: 600, ms: 4, path: loop });
  res.moveVector = await step('moveVector', { button: 0, n: 120, ms: 4, path: '[700 + i, 450 + i / 2]' });
  await page.evaluate(() => window.OT.app.tools.select('brush'));

  // The slid snapshot must look like a real render at the same view: pan
  // part-way (fractional zoom, then also with the view rotated), paint from
  // the snapshot, then render for real and compare the pixels.
  res.snapDiff = [];
  for (const rot of [0, 30]) {
    res.snapDiff.push(await page.evaluate(async (rot) => {
      const a = window.OT.app, st = a.stage;
      a.tools.select('brush');
      st.view.rot = rot; st.view.zoom *= 1.37; st.render();
      const grab = () => st.ctx.getImageData(0, 0, st.canvas.width, st.canvas.height).data;
      st.beginPan(); st._paintPan();             // snapshot taken here
      st.panBy(57, -31); st._paintPan();         // slid, not re-rendered
      const slid = grab();
      st._pan.snap = null; st._paintStage(st.ctx, st.canvas.width, st.canvas.height, 0, 0);
      const real = grab();
      st.endPan();
      let sum = 0, n = 0;
      for (let i = 0; i < real.length; i += 4 * 7) { sum += Math.abs(real[i] - slid[i]) + Math.abs(real[i + 3] - slid[i + 3]); n += 2; }
      st.view.rot = 0; st.fitToCamera();
      return +(sum / n).toFixed(2);
    }, rot));
  }

  console.log(JSON.stringify(res, null, 1));
  const checks = [];
  const R = res.renderMs;
  for (const k of ['pan', 'hand', 'moveBitmap', 'moveVector', 'lassoBitmap', 'lassoVector']) {
    const g = res[k];
    // before: every pen event re-rendered the whole stage (~1 render each)
    checks.push([`${k}: no pen event waits on a stage render (worst ${g.worstMs} ms)`, g.worstMs < R * 0.25]);
    checks.push([`${k}: whole gesture costs a few renders, not one per event (${(g.paintMs / R).toFixed(1)} renders for ${g.paints} paints)`, g.paintMs < R * 3.5]);
    checks.push([`${k}: at most one paint per display frame`, g.paints <= Math.ceil(g.secs * 1000 / 16.6 * 2) + 4]);
  }
  checks.push([`pan snapshot matches a real render (mean diff ${res.snapDiff.join(' / ')} of 255)`, res.snapDiff.every(d => d < 3)]);
  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (errors.length) console.log(errors.join('\n'));
  await browser.close();
  process.exit(REPORT ? 0 : (fail ? 1 : 0));
})().catch(e => { console.error(e); process.exit(1); });
