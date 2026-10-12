/* Keyframe easing presets: interpolation, back-compat, undo, save/load */
const { launch, FILE } = require('./launch-browser.cjs');

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const res = await page.evaluate(async () => {
    const a = window.OT.app, U = window.OT.util;
    const out = {};
    let l = a.activeLayer();
    const id = l.id, cur = () => (l = a.project.layers.find(x => x.id === id));
    // keys at 0 and 10, x 0 -> 100; sample the midpoint and a quarter in
    l.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
                             { frame: 10, x: 100, y: 0, sx: 1, sy: 1, rot: 0 }];
    const k0 = l.transform.keyframes[0];
    const sample = () => [U.round(l.transformAt(2.5).x, 3), U.round(l.transformAt(5).x, 3),
                          U.round(l.transformAt(10).x, 3)];
    out.legacy = sample();                       // no ease field = smooth
    for (const [id] of U.EASES) { k0.ease = id; out[id] = sample(); }

    // camera uses the same curves
    a.project.camera.keyframes = [{ frame: 0, x: 0, y: 0, zoom: 1, rot: 0, ease: 'linear' },
                                  { frame: 10, x: 50, y: 0, zoom: 1, rot: 0 }];
    out.camLinear = a.project.cameraAt(5).x;

    // app setters are undoable and survive re-keying
    k0.ease = 'smooth';
    a.setLayerKeyEase(l, 0, 'hold');
    out.afterSet = cur().transform.keyframes.find(k => k.frame === 0).ease;
    a.setFrame(0); a.setLayerKeyHere();
    out.afterRekey = cur().transform.keyframes.find(k => k.frame === 0).ease;
    a.undo(); a.undo();
    out.afterUndo = cur().transform.keyframes.find(k => k.frame === 0).ease;
    a.setCameraKeyEase(0, 'in');
    a.setCameraKey(0, { x: 0, y: 0, zoom: 1, rot: 0 });
    out.camRekey = a.project.camera.keyframes.find(k => k.frame === 0).ease;

    // save / load round-trip
    a.setLayerKeyEase(cur(), 0, 'out');
    const data = JSON.parse(JSON.stringify(window.OT.IO.serialize(a)));
    const p2 = (await window.OT.IO.deserialize(data)).project;
    const l2 = p2.layers.find(x => x.transform.keyframes.length);
    out.loaded = [l2.transform.keyframes.find(k => k.frame === 0).ease,
                  p2.camera.keyframes.find(k => k.frame === 0).ease];

    // timeline right-click on the key offers the presets
    const items = a.timeline._easeItems(l, 0).filter(i => i.label).map(i => i.label.trim());
    out.menu = items;
    out.menuNoKey = a.timeline._easeItems(l, 3).length;
    return out;
  });

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const checks = [
    ['legacy keys keep smoothstep', eq(res.legacy, [15.625, 50, 100])],
    ['smooth == legacy', eq(res.smooth, res.legacy)],
    ['linear', eq(res.linear, [25, 50, 100])],
    ['ease in (slow start)', eq(res.in, [1.563, 12.5, 100])],
    ['ease out (fast start)', eq(res.out, [57.813, 87.5, 100])],
    ['hold steps at next key', eq(res.hold, [0, 0, 100])],
    ['camera linear', res.camLinear === 25],
    ['setLayerKeyEase', res.afterSet === 'hold'],
    ['re-key keeps ease', res.afterRekey === 'hold'],
    ['undo restores ease', res.afterUndo === 'smooth'],
    ['camera re-key keeps ease', res.camRekey === 'in'],
    ['save/load round-trip', eq(res.loaded, ['out', 'in'])],
    ['timeline menu lists 5 presets, current ticked',
      res.menu.length === 5 && res.menu.some(s => s === '✓ Ease: Ease Out')],
    ['no menu without a key', res.menuNoKey === 0],
    ['no page errors', errors.length === 0]
  ];
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
