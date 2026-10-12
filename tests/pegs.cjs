/* Pegs / layer parenting: folder transforms, pivots, Transform tool, input mapping */
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

  // helpers live in the page
  await page.evaluate(() => {
    const a = window.OT.app;
    window.T = {
      client(px, py) {
        const r = a.stage.canvas.getBoundingClientRect(), s = a.stage.projectToScreen(px, py);
        return { x: r.left + s.x, y: r.top + s.y };
      },
      sample(px, py) {
        const p = a.project, cv = document.createElement('canvas');
        cv.width = p.width; cv.height = p.height;
        const x = cv.getContext('2d');
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, p.width, p.height);
        a.stage.compositeStage(a.frame, x, { bg: false });
        const d = x.getImageData(Math.round(px), Math.round(py), 1, 1).data;
        return [d[0], d[1], d[2]];
      },
      world(layer, x, y) {
        const m = window.OT.Peg.world(layer, a.frame, a.project, a.layerAncestors(layer));
        return window.OT.Peg.apply(m, x, y);
      }
    };
  });
  const isRed = c => c[0] > 200 && c[1] < 90 && c[2] < 90;
  async function drag(from, to, opts) {
    await page.mouse.move(from.x, from.y);
    if (opts && opts.shift) await page.keyboard.down('Shift');
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
    await page.mouse.up();
    if (opts && opts.shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(60);
  }
  const res = {};

  // 1. backward compat: default pivot reproduces the pre-pivot formula exactly
  res.compat = await page.evaluate(() => {
    const a = window.OT.app, p = a.project, l = a.activeLayer();
    const old = (tr, x, y) => {           // the old forward map from tools.js
      const px = p.width / 2, py = p.height / 2;
      const lx = (x - px) * tr.sx, ly = (y - py) * tr.sy;
      const r = tr.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      return { x: lx * c - ly * s + px + tr.x, y: lx * s + ly * c + py + tr.y };
    };
    l.transform.keyframes = [{ frame: 0, x: 37, y: -12, sx: 1.3, sy: 0.7, rot: 33 }];
    const m = window.OT.Peg.local(l, 0, p);
    const pts = [[0, 0], [100, 900], [1500, 300]];
    const ok = pts.every(([x, y]) => {
      const A = window.OT.Peg.apply(m, x, y), B = old(l.transformAt(0), x, y);
      return Math.abs(A.x - B.x) < 1e-6 && Math.abs(A.y - B.y) < 1e-6;
    });
    l.transform.keyframes = [];
    return ok;
  });

  // 2. a folder peg moves its child when rendered
  res.inherit = await page.evaluate(() => {
    const a = window.OT.app, p = a.project, W = p.width, H = p.height;
    a.addLayer('drawing'); const arm = a.activeLayer(); arm.name = 'Arm';
    const c = arm.drawingAt(0, W, H);
    c.ctx.fillStyle = '#ff0000'; c.ctx.fillRect(W / 2 + 190, H / 2 - 10, 20, 20); c.dirty();
    a.addPeg(arm);
    const peg = a.activeLayer();
    const out = { name: peg.name, type: peg.type, parent: arm.parentId === peg.id,
                  order: a.project.layers.indexOf(peg) === a.project.layers.indexOf(arm) + 1 };
    a.setFrame(0);
    peg.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 90 }];
    out.rotated = window.T.sample(W / 2, H / 2 + 200);     // child swung down
    out.oldSpot = window.T.sample(W / 2 + 200, H / 2);
    window.__peg = peg.id; window.__arm = arm.id;
    return out;
  });

  // 3. drawing through a rotated + moved folder lands under the cursor
  const drawPt = await page.evaluate(() => {
    const a = window.OT.app, p = a.project;
    const peg = p.layers.find(l => l.id === window.__peg), arm = p.layers.find(l => l.id === window.__arm);
    peg.transform.keyframes = [{ frame: 0, x: 120, y: -40, sx: 1, sy: 1, rot: 90 }];
    a.selectLayer(arm); a.setFrame(0); a.setColor('#ff0000');
    a.tools.select('brush');
    a.stage.fitToCamera && a.stage.fitToCamera();
    a.emit('render');
    return { px: p.width * 0.3, py: p.height * 0.3 };
  });
  {
    const c0 = await page.evaluate(({ px, py }) => window.T.client(px - 12, py), drawPt);
    const c1 = await page.evaluate(({ px, py }) => window.T.client(px + 12, py), drawPt);
    await page.evaluate(() => { window.OT.app.settings.size = 18; });
    await drag(c0, c1);
    res.drawUnderCursor = await page.evaluate(({ px, py }) => window.T.sample(px, py), drawPt);
  }

  // 4. Transform tool (real mouse): move the arm inside the rotated folder
  res.move = await (async () => {
    const before = await page.evaluate(() => {
      const a = window.OT.app, arm = a.project.layers.find(l => l.id === window.__arm);
      a.selectLayer(arm); a.setFrame(5); a.tools.select('transform'); a.emit('render');
      return window.T.world(arm, 100, 100);
    });
    const from = await page.evaluate(() => window.T.client(window.OT.app.project.width * 0.62, window.OT.app.project.height * 0.71));
    const to = await page.evaluate(() => window.T.client(window.OT.app.project.width * 0.62 + 150, window.OT.app.project.height * 0.71 + 50));
    await drag(from, to);
    return page.evaluate((b) => {
      const a = window.OT.app, arm = a.project.layers.find(l => l.id === window.__arm);
      const w = window.T.world(arm, 100, 100);
      return { dx: w.x - b.x, dy: w.y - b.y, keyed: arm.transform.keyframes.some(k => k.frame === 5) };
    }, before);
  })();
  res.moveUndo = await page.evaluate(() => {
    const a = window.OT.app; a.undo();
    const arm = a.project.layers.find(l => l.id === window.__arm);
    return arm.transform.keyframes.some(k => k.frame === 5);
  });

  // 5. folder rotation via the rotate handle, Shift-snapped to 15°
  res.rotate = await (async () => {
    const h = await page.evaluate(() => {
      const a = window.OT.app, p = a.project, peg = p.layers.find(l => l.id === window.__peg);
      a.selectLayer(peg); a.setFrame(0); a.tools.select('transform');
      peg.transform.keyframes = [];
      a.emit('render');
      const c = window.T.world(peg, p.width / 2, p.height / 2);
      const rr = 56 / a.stage.view.zoom;
      const w = { x: c.x, y: c.y - rr };
      // target: 30° clockwise around the centre, plus a little wobble
      const ang = -Math.PI / 2 + (31 * Math.PI / 180);
      return { from: window.T.client(w.x, w.y), to: window.T.client(c.x + rr * Math.cos(ang), c.y + rr * Math.sin(ang)) };
    });
    await drag(h.from, h.to, { shift: true });
    return page.evaluate(() => {
      const peg = window.OT.app.project.layers.find(l => l.id === window.__peg);
      const k = peg.transform.keyframes.find(k => k.frame === 0);
      return k ? k.rot : null;
    });
  })();

  // 6. pivot drag keeps keyed poses, changes in-betweens; save/load + reset
  res.pivot = await (async () => {
    const setup = await page.evaluate(() => {
      const a = window.OT.app, p = a.project, peg = p.layers.find(l => l.id === window.__peg);
      peg.pivot = null;
      peg.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
                                 { frame: 10, x: 50, y: 0, sx: 1.5, sy: 1.5, rot: 80 }];
      a.selectLayer(peg); a.tools.select('transform'); a.setFrame(0); a.emit('render');
      const probe = [[300, 200], [1200, 800]];
      const pose = f => { a.setFrame(f); return probe.map(([x, y]) => window.T.world(peg, x, y)); };
      window.__poses = { k0: pose(0), k10: pose(10), mid: pose(5) };
      a.setFrame(0);
      const c = window.T.world(peg, p.width / 2, p.height / 2);
      return { from: window.T.client(c.x, c.y), to: window.T.client(c.x - 400, c.y - 200), want: { x: c.x - 400, y: c.y - 200 } };
    });
    await drag(setup.from, setup.to);
    return page.evaluate(async (want) => {
      const a = window.OT.app, p = a.project, peg = p.layers.find(l => l.id === window.__peg);
      const probe = [[300, 200], [1200, 800]];
      const pose = f => { a.setFrame(f); return probe.map(([x, y]) => window.T.world(peg, x, y)); };
      const same = (A, B) => A.every((q, i) => Math.abs(q.x - B[i].x) < 0.01 && Math.abs(q.y - B[i].y) < 0.01);
      const P = window.__poses;
      a.setFrame(0);
      const pv = peg.pivot;
      const out = {
        pivotSet: !!pv,
        pivotUnderCursor: pv && Math.hypot(pv.x - want.x, pv.y - want.y) < 2,
        k0Kept: same(pose(0), P.k0), k10Kept: same(pose(10), P.k10), midChanged: !same(pose(5), P.mid)
      };
      // save / load keeps the pivot
      const data = JSON.parse(JSON.stringify(window.OT.IO.serialize(a)));
      const p2 = (await window.OT.IO.deserialize(data)).project;
      const peg2 = p2.layers.find(l => l.name === peg.name);
      out.saved = !!(peg2.pivot && Math.abs(peg2.pivot.x - pv.x) < 1e-6);
      // undo restores the old (centre) pivot; redo brings it back
      a.undo(); const pegU = a.project.layers.find(l => l.id === window.__peg);
      out.undo = pegU.pivot === null && same(pose(5), P.mid);
      a.redo();
      // reset pivot keeps key poses, returns to centre in-betweens
      const pegR = a.project.layers.find(l => l.id === window.__peg);
      a.resetPivot(pegR);
      out.reset = pegR.pivot === null && same(pose(0), P.k0) && same(pose(10), P.k10) && same(pose(5), P.mid);
      return out;
    }, setup.want);
  })();

  // 7. export renders folder transforms too
  res.export = await page.evaluate(() => {
    const a = window.OT.app, p = a.project, W = p.width, H = p.height;
    const peg = p.layers.find(l => l.id === window.__peg), arm = p.layers.find(l => l.id === window.__arm);
    arm.transform.keyframes = [];
    peg.pivot = null;
    peg.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 90 }];
    const f = window.OT.IO.renderFrame(a, 0, W / 4, H / 4);
    const d = f.getContext('2d').getImageData(W / 8, (H / 2 + 200) / 4, 1, 1).data;
    return [d[0], d[1], d[2]];
  });

  // 8. grouping a layer together with a folder keeps the folder's children with it
  res.groupFolder = await page.evaluate(() => {
    const a = window.OT.app, L = a.project.layers;
    const peg = L.find(l => l.id === window.__peg), arm = L.find(l => l.id === window.__arm);
    a.addLayer('drawing'); const body = a.activeLayer();
    a.selectLayer(body); a.toggleLayerSelection(peg); a.groupSelectedLayers();
    const P = a.project.layers, outer = P.find(l => l.id === peg.parentId);
    return {
      armUnderPeg: P.indexOf(arm) === P.indexOf(peg) - 1 && arm.parentId === peg.id,
      bothInOuter: !!outer && body.parentId === outer.id && outer.type === 'group'
    };
  });

  const checks = [
    ['grouping a folder keeps its children with it', res.groupFolder.armUnderPeg && res.groupFolder.bothInOuter],
    ['default pivot == old transform maths', res.compat],
    ['Add Peg wraps layer in "-P" folder', res.inherit.name === 'Arm-P' && res.inherit.type === 'group' && res.inherit.parent && res.inherit.order],
    ['folder rotation carries child (render)', isRed(res.inherit.rotated) && !isRed(res.inherit.oldSpot)],
    ['drawing inside rotated folder lands under cursor', isRed(res.drawUnderCursor)],
    ['Transform tool move follows the mouse in world space',
      Math.abs(res.move.dx - 150) < 3 && Math.abs(res.move.dy - 50) < 3 && res.move.keyed],
    ['Transform tool move is undoable', res.moveUndo === false],
    ['rotate handle + Shift snaps to 30°', res.rotate === 30],
    ['pivot lands under the cursor', res.pivot.pivotSet && res.pivot.pivotUnderCursor],
    ['moving pivot keeps keyed poses', res.pivot.k0Kept && res.pivot.k10Kept],
    ['moving pivot changes the in-betweens', res.pivot.midChanged],
    ['pivot saved in project file', res.pivot.saved],
    ['pivot move undoable', res.pivot.undo],
    ['reset pivot restores centre without moving keys', res.pivot.reset],
    ['export applies folder transforms', isRed(res.export)],
    ['no page errors', errors.length === 0]
  ];
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
