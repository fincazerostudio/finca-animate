/* Project-format benchmark: open/save time, file size and memory on a large
 * synthetic scene (made here, no outside artwork).
 *
 *   node tests/bench-format.cjs [drawings=300] [path/to/opentoon-studio]
 *
 * Builds a 1920x1080 scene with ~5/6 raster and ~1/6 vector drawings full of
 * random line work, then times the app's real desktop save path
 * (IO.writeProjectTo -> atomic write + .bak) and open path
 * (IO.readProjectFrom -> parse + decode every drawing). Not part of npm test.
 */
'use strict';
const { _electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const N = Number(process.argv[2]) || 300;
const EXE = process.argv[3] || require('electron');
const ARGS = process.argv[3] ? [] : [ROOT];
const mb = b => (b / 1048576).toFixed(1) + ' MB';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finca-bench-'));
  const app = await _electron.launch({ executablePath: EXE, args: ARGS, timeout: 60000,
    env: Object.assign({}, process.env, { XDG_CONFIG_HOME: path.join(tmp, 'config'), OPENTOON_UPDATES: 'off' }) });
  let page = null;
  for (let i = 0; i < 150 && !page; i++) {
    page = app.windows().find(w => /index\.html$/.test(w.url())) || null;
    if (!page) await new Promise(r => setTimeout(r, 200));
  }
  await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.ui, null, { timeout: 30000 });
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  const scene = path.join(tmp, 'bench.otoon');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, scene);
  const rendererMem = () => app.evaluate(({ app }) => app.getAppMetrics()
    .filter(m => m.type === 'Tab').reduce((s, m) => s + m.memory.workingSetSize * 1024, 0));
  const heap = () => page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));

  // ---- build the synthetic scene (12 layers, N drawings, 1 per 2 frames) ----
  await page.evaluate((N) => {
    const OT = window.OT, a = OT.app;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const p = new OT.Project({ name: 'bench', width: 1920, height: 1080, frameCount: 2 * Math.ceil(N / 12), empty: true });
    const L = 12, per = Math.ceil(N / L);
    let made = 0;
    for (let li = 0; li < L && made < N; li++) {
      const vec = li >= 10;                        // 2 of 12 layers are vector
      const layer = new OT.Layer('L' + li, vec ? 'vector' : 'raster');
      for (let k = 0; k < per && made < N; k++, made++) {
        const num = k + 1;
        const cel = new OT.Cel(num, p.width, p.height, vec ? 'vector' : 'raster');
        const cx = 300 + rnd() * 1300, cy = 200 + rnd() * 700;
        if (vec) {
          for (let s = 0; s < 40; s++) {
            const pts = []; let x = cx + rnd() * 300 - 150, y = cy + rnd() * 300 - 150;
            for (let q = 0; q < 30; q++) { x += rnd() * 16 - 8; y += rnd() * 16 - 8; pts.push({ x, y, p: 0.5 + rnd() * 0.5 }); }
            cel.strokes.push({ pts, color: '#222222', width: 3, pencil: true });
          }
          cel.rebuild();
        } else {
          const c = cel.ctx;
          c.lineCap = c.lineJoin = 'round';
          // a coloured fill blob + 40 pencil-ish lines
          c.fillStyle = 'hsl(' + Math.floor(rnd() * 360) + ',60%,70%)';
          c.beginPath(); c.ellipse(cx, cy, 120 + rnd() * 120, 90 + rnd() * 120, 0, 0, 7); c.fill();
          c.strokeStyle = '#1a1a1a';
          for (let s = 0; s < 40; s++) {
            c.lineWidth = 1 + rnd() * 3;
            c.beginPath(); let x = cx + rnd() * 400 - 200, y = cy + rnd() * 400 - 200; c.moveTo(x, y);
            for (let q = 0; q < 30; q++) { x += rnd() * 16 - 8; y += rnd() * 16 - 8; c.lineTo(x, y); }
            c.stroke();
          }
        }
        cel.dirty();
        layer.cels[num] = cel;
        layer.exposure[2 * k] = num; layer.exposure[2 * k + 1] = num;
      }
      layer.nextNum = per + 1;
      p.layers.push(layer);
    }
    a.loadProjectData({ project: p, palette: null, workspace: null });
  }, N);
  await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
  const memBuilt = await rendererMem();

  // ---- SAVE: real desktop path (serialize + stringify + IPC + atomic write) ----
  const save = await page.evaluate(async () => {
    const OT = window.OT, a = OT.app, fsd = window.OpenToonDesktop.fs;
    const p = await fsd.saveDialog('bench.otoon');
    const t0 = performance.now();
    const data = OT.IO.serialize(a);
    const t1 = performance.now();
    const json = JSON.stringify(data);
    const t2 = performance.now();
    const r = await fsd.writeFile(p, json);
    const t3 = performance.now();
    // second full save (what the 20 s timer does after any edit) via the real API
    const t4 = performance.now();
    await OT.IO.writeProjectTo(a, p);
    const t5 = performance.now();
    // cost of encoding ONE raster drawing to PNG (what an incremental save would pay per changed cel)
    const cel = a.project.layers[0].cels[1];
    const t6 = performance.now();
    const png = cel.canvas.toDataURL();
    const t7 = performance.now();
    return { ok: r.ok, serialize: t1 - t0, stringify: t2 - t1, write: t3 - t2, fullSave2: t5 - t4,
             onePng: t7 - t6, onePngBytes: Math.round((png.length - 22) * 3 / 4), jsonChars: json.length };
  });
  const size = fs.statSync(scene).size;

  // ---- OPEN: fresh renderer (reload) then real readProjectFrom + load ----
  await page.reload();
  await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.ui, null, { timeout: 30000 });
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
  const memIdle = await rendererMem(), heapIdle = await heap();
  const open = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app;
    const t0 = performance.now();
    const d = await OT.IO.readProjectFrom(f);
    const t1 = performance.now();
    a.loadProjectData(d); a.projectPath = f;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t2 = performance.now();
    let cels = 0; for (const l of a.project.layers) cels += Object.keys(l.cels).length;
    return { read: t1 - t0, firstPaint: t2 - t0, cels };
  }, scene);
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
  const memOpen = await rendererMem(), heapOpen = await heap();

  const out = {
    drawings: N, scene: '1920x1080, 12 layers (10 raster, 2 vector)',
    fileSize: mb(size),
    save: { serializeMs: Math.round(save.serialize), stringifyMs: Math.round(save.stringify),
            ipcAtomicWriteMs: Math.round(save.write), totalMs: Math.round(save.serialize + save.stringify + save.write),
            secondFullSaveMs: Math.round(save.fullSave2), onePngEncodeMs: +save.onePng.toFixed(1), onePngBytes: save.onePngBytes },
    open: { readParseDecodeMs: Math.round(open.read), untilFirstPaintMs: Math.round(open.firstPaint), celsLoaded: open.cels },
    memory: { rendererAfterBuild: mb(memBuilt), rendererIdleBeforeOpen: mb(memIdle), rendererAfterOpen: mb(memOpen),
              jsHeapIdle: mb(heapIdle), jsHeapAfterOpen: mb(heapOpen) }
  };
  console.log(JSON.stringify(out, null, 2));
  await page.evaluate(() => { window.OT.app.dirty = false; });
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
