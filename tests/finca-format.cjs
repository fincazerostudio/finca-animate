/* The .finca project format, end to end in the real desktop app.
 *
 *   node tests/finca-format.cjs [path/to/opentoon-studio]
 *
 * Covers: .otoon -> .finca round trip, incremental saves, a crash in the
 * middle of a save, lazy loading of a 300-drawing scene, the synchronous
 * decode fallback, parking raster drawings under a memory budget, drawings
 * kept alive by undo, autosave, and bulk operations on a lazily opened scene.
 * Every scene is made here; no outside artwork.
 */
'use strict';
const { _electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');
const Z = require('../electron/finca-zip.js');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.argv[2] || require('electron');
const ARGS = process.argv[2] ? [] : [ROOT];
const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
};
const zipEntries = file => {
  const fd = fs.openSync(file, 'r');
  try { return Z.readDirectory(fd); } finally { fs.closeSync(fd); }
};

async function launch(tmp, extraEnv) {
  const app = await _electron.launch({ executablePath: EXE, args: ARGS, timeout: 60000,
    env: Object.assign({}, process.env, { XDG_CONFIG_HOME: path.join(tmp, 'config'), OPENTOON_UPDATES: 'off' }, extraEnv || {}) });
  let page = null;
  for (let i = 0; i < 150 && !page; i++) {
    page = app.windows().find(w => /index\.html$/.test(w.url())) || null;
    if (!page) await new Promise(r => setTimeout(r, 200));
  }
  await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.ui, null, { timeout: 30000 });
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  // helpers used by the checks below
  await page.evaluate(() => {
    const OT = window.OT;
    // pixels of a cel without going through cel.ctx (which counts as an edit)
    window.pxHash = cel => {
      const c = document.createElement('canvas');
      c.width = cel.w; c.height = cel.h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(cel.canvas, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let h1 = 0x811c9dc5, h2 = 7, n = 0;
      for (let i = 0; i < d.length; i++) {
        h1 = Math.imul(h1 ^ d[i], 16777619); h2 = (Math.imul(h2, 31) + d[i]) | 0;
        if ((i & 3) === 3 && d[i]) n++;
      }
      return (h1 >>> 0) + ':' + (h2 >>> 0) + ':' + n;
    };
    window.sceneHashes = () => OT.app.project.layers.map(l => Object.keys(l.cels).sort().map(n => {
      const c = l.cels[n];
      return n + '=' + (c.kind === 'vector' ? JSON.stringify([c.strokes, c.eraserMarks]) : window.pxHash(c));
    }));
    // everything in the scene except drawings and the workspace
    window.sceneMeta = () => {
      const d = JSON.parse(JSON.stringify(OT.IO.serialize(OT.app)));
      delete d.workspace; delete d.format; delete d.version;
      for (const l of d.layers) for (const n in l.cels) l.cels[n] = l.cels[n].k;
      return JSON.stringify(d);
    };
    // a deterministic test scene: raster + vector, soft edges, sound, keys
    window.makeScene = (W, H, drawings, opts) => {
      opts = opts || {};
      let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const L = opts.layers || 4, per = Math.ceil(drawings / L);
      const p = new OT.Project({ name: opts.name || 'finca-test', width: W, height: H, fps: 12, frameCount: Math.max(4, 2 * per), empty: true });
      let made = 0;
      for (let li = 0; li < L && made < drawings; li++) {
        const vec = li === L - 1;
        const layer = new OT.Layer('L' + li, vec ? 'vector' : 'drawing');
        for (let k = 0; k < per && made < drawings; k++, made++) {
          const num = k + 1;
          const cel = new OT.Cel(num, W, H, vec ? 'vector' : 'raster');
          const cx = W * (0.2 + rnd() * 0.6), cy = H * (0.2 + rnd() * 0.6);
          if (vec) {
            for (let s = 0; s < 6; s++) {
              const pts = []; let x = cx, y = cy;
              for (let q = 0; q < 12; q++) { x += rnd() * 16 - 8; y += rnd() * 16 - 8; pts.push({ x, y, p: 0.5 + rnd() * 0.5 }); }
              cel.strokes.push({ pts, color: '#222222', width: 3, pencil: true });
            }
          } else {
            const c = cel.ctx;
            // soft, semi-transparent edges exercise alpha handling
            const g = c.createRadialGradient(cx, cy, 2, cx, cy, 40 + rnd() * 40);
            g.addColorStop(0, 'hsla(' + Math.floor(rnd() * 360) + ',70%,55%,0.9)');
            g.addColorStop(1, 'hsla(200,70%,55%,0)');
            c.fillStyle = g; c.fillRect(0, 0, W, H);
            c.strokeStyle = 'rgba(20,20,20,0.6)'; c.lineWidth = 2.5;
            c.beginPath(); c.moveTo(cx - 30, cy - 20 + k % 7); c.lineTo(cx + 35, cy + 22); c.stroke();
          }
          cel.dirty();
          layer.cels[num] = cel;
          layer.exposure[2 * k] = num; layer.exposure[2 * k + 1] = num;
        }
        layer.nextNum = per + 1;
        if (li === 0) {
          layer.pivot = { x: 12, y: 34 };
          layer.transform = { keyframes: [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 0, ease: 'easeInOut' }, { frame: 3, x: 5, y: -4, sx: 1.1, sy: 1.1, rot: 10 }] };
        }
        p.layers.push(layer);
      }
      p.camera = { keyframes: [{ frame: 0, x: 0, y: 0, zoom: 1, rot: 0 }, { frame: 2, x: 10, y: 5, zoom: 1.2, rot: 3 }] };
      if (opts.audio) {
        // 0.1 s of silence as a WAV data URL
        const n = 800, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
        v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
        let bin = ''; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
        p.audio = { name: 'silence.wav', data: 'data:audio/wav;base64,' + btoa(bin) };
      }
      OT.app.loadProjectData({ project: p, palette: null, workspace: null });
    };
    window.rasterCels = () => {
      const out = [];
      for (const l of OT.app.project.layers) for (const n in l.cels) if (l.cels[n].kind !== 'vector') out.push(l.cels[n]);
      return out;
    };
    window.tick = ms => new Promise(r => setTimeout(r, ms || 50));
    window.openScene = async f => {
      const d = await OT.IO.readProjectFrom(f);
      OT.app._opened(f, d);
      await window.tick(100);
    };
  });
  return { app, page };
}
const setSavePath = (app, p) => app.evaluate(({ dialog }, f) => {
  global.__saveCalls = 0;
  dialog.showSaveDialog = async () => { global.__saveCalls++; return { canceled: false, filePath: f }; };
}, p);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finca-format-'));
  let { app, page } = await launch(tmp);

  /* ---------- 1. .otoon -> .finca round trip ---------- */
  const otoon = path.join(tmp, 'old scene.otoon');
  const finca = path.join(tmp, 'old scene.finca');
  const orig = await page.evaluate(() => {
    window.makeScene(320, 180, 24, { audio: true });
    return { json: JSON.stringify(window.OT.IO.serialize(window.OT.app)), hashes: window.sceneHashes(), meta: window.sceneMeta() };
  });
  fs.writeFileSync(otoon, orig.json);
  await setSavePath(app, finca);
  const imp = await page.evaluate(async (f) => {
    const a = window.OT.app;
    a._importedFrom = null; a.projectPath = null;
    a._openPath(f);
    for (let i = 0; i < 100 && !a._importedFrom; i++) await window.tick(50);
    await window.tick(100);
    const before = { path: a.projectPath, from: a._importedFrom, hashes: window.sceneHashes() };
    a.dirty = true;
    a.saveProject();                       // plain Save: must go through the dialog to a .finca
    for (let i = 0; i < 100 && !a.projectPath; i++) await window.tick(50);
    return { msg: a.ui.msgEl && a.ui.msgEl.textContent, before, path: a.projectPath, from: a._importedFrom, recent: a.recentFiles.slice(), dirty: a.dirty,
             save: window.OT.IO.stats.lastSave, refused: await window.OpenToonDesktop.fs.fincaWrite(f, { scene: '{}', entries: [] }) };
  }, otoon);
  const calls = await app.evaluate(() => global.__saveCalls);
  check('opening a .otoon imports it without a file to save back to', imp.before.path === null && imp.before.from === otoon, imp.before);
  check("Save on an imported .otoon asks for a name and writes a .finca", calls === 1 && imp.path === finca && fs.existsSync(finca), { calls, path: imp.path, msg: imp.msg });
  check('the .otoon is byte-for-byte untouched and cannot be written', fs.readFileSync(otoon, 'utf8') === orig.json && imp.refused.ok === false, imp.refused);
  check('the .finca replaces the .otoon in the recent list', imp.recent[0] === finca && !imp.recent.includes(otoon), imp.recent);
  const ent = zipEntries(finca);
  const names = [...ent.keys()];
  check('container: mimetype first, scene.json, one entry per drawing, media, thumbnail',
    names[0] === 'mimetype' && ent.has('scene.json') && ent.has('thumbnail.png') &&
    names.filter(n => /^drawings\/.+\.png$/.test(n)).length === 18 && names.filter(n => /^drawings\/.+\.json$/.test(n)).length === 6 &&
    names.filter(n => /^media\/.+\.wav$/.test(n)).length === 1, names);
  check('PNG entries are stored, JSON entries deflated',
    names.filter(n => /\.png$/.test(n)).every(n => ent.get(n).method === 0) && ent.get('scene.json').method === 8);
  check('the .finca is smaller than the .otoon', fs.statSync(finca).size < fs.statSync(otoon).size,
    { finca: fs.statSync(finca).size, otoon: fs.statSync(otoon).size });
  await page.reload();
  await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.ui, null, { timeout: 30000 });
  await app.close();
  ({ app, page } = await launch(tmp));
  const back = await page.evaluate(async (f) => {
    const a = window.OT.app;
    await window.openScene(f);
    const parked = window.rasterCels().filter(c => c.parked).length, total = window.rasterCels().length;
    return { path: a.projectPath, parked, total, meta: window.sceneMeta(), hashes: window.sceneHashes(),
             audio: a.project.audio && a.project.audio.data.slice(0, 30), failed: window.OT.Cel.stats.failed };
  }, finca);
  check('reopened .finca: same scene data (layers, keys, pivots, camera, palette, sound)', back.meta === orig.meta && back.path === finca && /^data:audio\/wav;base64,/.test(back.audio || ''));
  check('reopened .finca: every drawing is pixel-identical / stroke-identical',
    JSON.stringify(back.hashes) === JSON.stringify(orig.hashes) && JSON.stringify(imp.before.hashes) === JSON.stringify(orig.hashes) && back.failed === 0);
  check('drawings off the current frame were not loaded on open', back.parked >= back.total - 3, { parked: back.parked, total: back.total });

  /* ---------- 2. incremental save ---------- */
  const before2 = zipEntries(finca);
  const inc = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app;
    await window.openScene(f);
    const r = a.project.layers[1].cels[2], v = a.project.layers[3].cels[3];
    r.ctx.fillStyle = '#ff0000'; r.ctx.fillRect(5, 5, 20, 20); r.dirty();
    v.strokes.push({ pts: [{ x: 1, y: 1, p: 1 }, { x: 50, y: 60, p: 1 }], color: '#00aa00', width: 4 }); v.rebuild(); v.dirty();
    a.dirty = true;
    await OT.IO.writeProjectTo(a, f);
    const first = OT.IO.stats.lastSave;
    a.dirty = true;
    await OT.IO.writeProjectTo(a, f);            // nothing changed
    return { first, second: OT.IO.stats.lastSave, dirty: a.dirty, changedPx: window.pxHash(r) };
  }, finca);
  const after2 = zipEntries(finca);
  const drawings = n => /^drawings\//.test(n);
  const kept = [...after2.keys()].filter(n => drawings(n) && before2.has(n));
  check('save after editing 2 drawings encodes exactly those 2', inc.first.encoded === 2 && inc.first.written === 2, inc.first);
  check('the other 22 drawings are copied untouched (same name, crc and size)',
    kept.length === 22 && kept.every(n => after2.get(n).crc === before2.get(n).crc && after2.get(n).csize === before2.get(n).csize), kept.length);
  check('a save with no changes encodes nothing', inc.second.encoded === 0 && inc.second.copied >= 24, inc.second);
  check('the previous version is kept as .bak', fs.existsSync(finca + '.bak') && zipEntries(finca + '.bak').size === after2.size);
  check('no temp file left behind', !fs.readdirSync(tmp).some(n => /\.tmp-/.test(n)), fs.readdirSync(tmp));

  /* ---------- 3. synchronous fallback == background load ---------- */
  const syn = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app;
    const d1 = await OT.IO.readProjectFrom(f), d2 = await OT.IO.readProjectFrom(f);
    const ras = d => { const o = []; for (const l of d.project.layers) for (const n in l.cels) if (l.cels[n].kind !== 'vector') o.push(l.cels[n]); return o; };
    const A = ras(d1), B = ras(d2);
    const s0 = OT.Cel.stats.syncDecodes, l0 = OT.Cel.stats.loads;
    const sync = A.map(c => window.pxHash(c));                    // cel.canvas right now
    await Promise.all(B.map(c => c.load()));
    const bg = B.map(c => window.pxHash(c));
    return { n: A.length, same: JSON.stringify(sync) === JSON.stringify(bg), syncDecodes: OT.Cel.stats.syncDecodes - s0, loads: OT.Cel.stats.loads - l0 };
  }, finca);
  check('reading cel.canvas of an unloaded drawing decodes it on the spot', syn.syncDecodes === syn.n && syn.n === 18, syn);
  check('the on-the-spot decode is pixel-identical to the background load', syn.same && syn.loads === syn.n, syn);

  /* ---------- 4. bulk operations on a lazily opened scene ---------- */
  const bulk = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app;
    await window.openScene(f);
    const layer = a.project.layers[0];
    const ref = (await OT.IO.readProjectFrom(f)).project.layers[0];
    const want = Object.keys(ref.cels).sort().map(n => window.pxHash(ref.cels[n]));
    const parkedBefore = Object.values(layer.cels).filter(c => c.parked).length;
    a.selectLayer(layer);
    a.duplicateLayer(layer);
    const copy = a.project.layers[a.project.layers.indexOf(layer) + 1];
    const got = Object.keys(copy.cels).sort().map(n => window.pxHash(copy.cels[n]));
    const blank = Object.values(copy.cels).filter(c => c.isBlank()).length;
    return { parkedBefore, same: JSON.stringify(want) === JSON.stringify(got), blank, n: got.length };
  }, finca);
  check('Duplicate Layer on unloaded drawings copies the real pixels', bulk.parkedBefore > 0 && bulk.same && bulk.blank === 0 && bulk.n === 6, bulk);

  /* ---------- 5. memory budget parks raster drawings ---------- */
  const mem = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app;
    await window.openScene(f);
    a.setFrame(0);
    const cels = window.rasterCels();
    const want = cels.map(c => window.pxHash(c));                 // loads everything
    // draw on three far-away drawings: they have no stored copy any more
    const edited = [a.project.layers[0].cels[6], a.project.layers[1].cels[5], a.project.layers[2].cels[6]];
    edited.forEach((c, i) => { c.ctx.fillStyle = '#0000ff'; c.ctx.fillRect(40 + i, 40, 9, 9); c.dirty(); });
    const editedWant = edited.map(c => window.pxHash(c));
    const all = OT.CelMemory.stats(a.project);
    const budget = 7 * 320 * 180 * 4;                              // room for seven drawings
    // encodes run in the background and can take a while: wait for them, not a fixed time
    for (let i = 0; i < 20; i++) {
      OT.CelMemory.trim(a, budget);
      await Promise.all(window.rasterCels().map(c => c._stashing).filter(Boolean));
      await window.tick(20);
      if (OT.CelMemory.stats(a.project).rasterBytes <= budget) break;
    }
    const after = OT.CelMemory.stats(a.project);
    const parkedEdited = edited.filter(c => c.parked && c._png).length;
    const again = edited.map(c => window.pxHash(c));
    // saving parked, edited drawings uses their stored bytes: nothing is re-encoded
    edited.forEach(c => c.release());
    const e0 = OT.Cel.stats.encodes;
    a.dirty = true;
    await OT.IO.writeProjectTo(a, f);
    const save = OT.IO.stats.lastSave;
    const d = await OT.IO.readProjectFrom(f);
    const reread = [d.project.layers[0].cels[6], d.project.layers[1].cels[5], d.project.layers[2].cels[6]].map(c => window.pxHash(c));
    const still = cels.filter(c => !edited.includes(c)).map(c => window.pxHash(c));
    return { all: all.rasterAllocated, after: after.rasterAllocated, rasterBytes: after.rasterBytes, budget, parkedEdited,
             editedOk: JSON.stringify(again) === JSON.stringify(editedWant) && JSON.stringify(reread) === JSON.stringify(editedWant),
             othersOk: JSON.stringify(still) === JSON.stringify(want.filter((_, i) => !edited.includes(cels[i]))),
             save, stashEncodes: OT.Cel.stats.encodes - e0, pngHeld: after.pngBytes };
  }, finca);
  check('over budget: raster surfaces are released down to the budget', mem.all === 18 && mem.rasterBytes <= mem.budget, mem);
  check('drawn-on drawings are parked as PNG in memory and come back identical', mem.parkedEdited === 3 && mem.editedOk && mem.pngHeld > 0, mem);
  check('untouched drawings come back identical from the file', mem.othersOk);
  check('saving parked drawings writes their stored bytes without re-encoding', mem.save.encoded === 0 && mem.save.written === 3 && mem.stashEncodes === 0, mem.save);

  /* ---------- 6. a drawing kept alive only by undo survives a save ---------- */
  const stray = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app;
    await window.openScene(f);
    const layer = a.project.layers[2];
    const cel = layer.cels[4];
    const parked = cel.parked;
    const d = await OT.IO.readProjectFrom(f);
    const want = window.pxHash(d.project.layers[2].cels[4]);
    delete layer.cels[4];                                  // "delete drawing": the cel now only lives in undo
    a.dirty = true;
    await OT.IO.writeProjectTo(a, f);
    layer.cels[4] = cel;                                   // undo
    return { parked, stillParked: cel.parked, hasPng: !!cel._png, file: cel._file, same: window.pxHash(cel) === want };
  }, finca);
  check('deleting an unloaded drawing, saving, then undoing brings its pixels back', stray.parked && stray.same && stray.file === null, stray);

  /* ---------- 7. lazy loading on a 300-drawing scene ---------- */
  const big = path.join(tmp, 'big.finca');
  await setSavePath(app, big);
  const lazy = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app, fsd = window.OpenToonDesktop.fs;
    window.makeScene(640, 360, 300, { layers: 6, name: 'big' });
    const p = await fsd.saveDialog('big.finca');
    const t0 = performance.now();
    await OT.IO.writeProjectTo(a, p, { thumbnail: true });
    const firstSave = performance.now() - t0, first = OT.IO.stats.lastSave;
    a.project.layers[0].cels[9].ctx.fillStyle = '#000'; a.project.layers[0].cels[9].ctx.fillRect(1, 1, 5, 5); a.project.layers[0].cels[9].dirty();
    const t1 = performance.now();
    await OT.IO.writeProjectTo(a, p);
    const secondSave = performance.now() - t1, second = OT.IO.stats.lastSave;
    const l0 = OT.Cel.stats.loads, s0 = OT.Cel.stats.syncDecodes;
    const t2 = performance.now();
    const d = await OT.IO.readProjectFrom(p);
    a.loadProjectData(d); a.projectPath = p;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const openMs = performance.now() - t2;
    await window.tick(400);
    const st = OT.CelMemory.stats(a.project);
    const loadsOpen = OT.Cel.stats.loads - l0;
    a.setFrame(40);
    await window.tick(400);
    const loadsSeek = OT.Cel.stats.loads - l0;
    return { firstSave: Math.round(firstSave), first, secondSave: Math.round(secondSave), second, openMs: Math.round(openMs),
             cels: st.cels, allocated: st.allocated, parked: st.parked, loadsOpen, loadsSeek, sync: OT.Cel.stats.syncDecodes - s0 };
  }, big);
  check('300 drawings: first save encodes all, the next one only the edited drawing',
    lazy.first.encoded === 300 && lazy.second.encoded === 1 && lazy.second.copied === 299 + 1 /* thumbnail */, { first: lazy.first, second: lazy.second });
  check('300 drawings: opening loads only what the first frames show', lazy.cels === 300 && lazy.loadsOpen <= 12 && lazy.parked >= 238, lazy);
  check('seeking loads the drawings of the new frame in the background (no on-the-spot decodes)', lazy.loadsSeek > lazy.loadsOpen && lazy.sync === 0, lazy);
  console.log('     300 x 640x360: first save ' + lazy.firstSave + ' ms, save after one edit ' + lazy.secondSave + ' ms, open to first paint ' + lazy.openMs + ' ms');

  /* ---------- 8. autosave of a never-saved scene ---------- */
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const auto = await page.evaluate(async () => {
    const OT = window.OT, a = OT.app, fsd = window.OpenToonDesktop.fs;
    window.makeScene(320, 180, 12, { name: 'never-saved' });
    const want = window.sceneHashes();
    a.dirty = true;
    OT.IO.autosave(a);
    for (let i = 0; i < 100 && !(OT.IO.stats.lastSave && OT.IO.stats.lastSave.auto && OT.IO.stats.lastSave.encoded === 12); i++) await window.tick(50);
    const first = OT.IO.stats.lastSave, dirtyAfter = a.dirty;
    const e = a.project.layers[0].cels[1];
    e.ctx.fillStyle = '#000'; e.ctx.fillRect(2, 2, 6, 6); e.dirty();
    const want2 = window.sceneHashes();
    a.dirty = true;
    OT.IO.autosave(a);
    for (let i = 0; i < 100 && OT.IO.stats.lastSave === first; i++) await window.tick(50);
    const second = OT.IO.stats.lastSave;
    const info = await OT.IO.readAutosave();
    a.loadProjectData({ project: info.project, palette: info.palette });
    const got = window.sceneHashes();
    const hist = await fsd.autosaveHistory();
    const snap = await OT.IO.readAutosaveSnapshot(hist[0].name);
    return { first, second, dirtyAfter, path: a.projectPath, same: JSON.stringify(got) === JSON.stringify(want2), differs: JSON.stringify(want) !== JSON.stringify(want2),
             hist: hist.map(h => h.name), snapLayers: snap.project.layers.length, evil: await fsd.fincaOpen({ history: '../autosave.finca' }),
             detached: window.rasterCels().every(c => !c._file) };
  });
  check('autosave writes a .finca in the settings folder and clears the unsaved flag', auto.first.auto && auto.first.encoded === 12 && auto.dirtyAfter === false &&
    fs.existsSync(path.join(userData, 'autosave.finca')), auto.first);
  check('the next autosave only encodes the edited drawing', auto.second.encoded === 1 && auto.second.copied === 11, auto.second);
  check('restoring the autosave gives back the latest drawings, detached from the autosave file', auto.same && auto.differs && auto.detached && auto.path === null, auto);
  check('autosave history has a snapshot that opens; path tricks are refused', auto.hist.length === 1 && /^autosave-\d+\.finca$/.test(auto.hist[0]) && auto.snapLayers === 4 && auto.evil.ok === false, auto);
  await page.evaluate(() => { window.OT.app.dirty = false; });
  await app.close();

  /* ---------- 9. a crash in the middle of a save ---------- */
  const beforeCrash = fs.readFileSync(finca);
  ({ app, page } = await launch(tmp, { OPENTOON_TEST_CRASH: 'before-rename' }));
  let died = false;
  app.process().once('exit', () => { died = true; });
  await page.evaluate((f) => {
    const OT = window.OT, a = OT.app;
    a._openPath(f);
    const go = async () => {
      for (let i = 0; i < 100 && a.projectPath !== f; i++) await window.tick(50);
      a.project.layers[0].cels[1].ctx.fillStyle = '#000'; a.project.layers[0].cels[1].ctx.fillRect(0, 0, 50, 50); a.project.layers[0].cels[1].dirty();
      a.dirty = true;
      OT.IO.writeProjectTo(a, f).catch(() => {});
    };
    go();
  }, finca).catch(() => {});
  for (let i = 0; i < 100 && !died; i++) await new Promise(r => setTimeout(r, 100));
  try { await app.close(); } catch (e) { /* already gone */ }
  check('the app died mid-save (test hook)', died);
  check('after the crash the project file is exactly the previous version', fs.readFileSync(finca).equals(beforeCrash));
  const leftovers = fs.readdirSync(tmp).filter(n => /\.tmp-/.test(n));
  check('the interrupted save left its temp file (and nothing else changed)', leftovers.length === 1, leftovers);
  ({ app, page } = await launch(tmp));
  const rec = await page.evaluate(async (f) => {
    const OT = window.OT, a = OT.app;
    await window.openScene(f);
    const ok = a.project.layers.length === 4 && window.OT.Cel.stats.failed === 0;
    a.dirty = true;
    await OT.IO.writeProjectTo(a, f);
    return ok;
  }, finca);
  check('the file opens after the crash, and the next save clears the stale temp file', rec && !fs.readdirSync(tmp).some(n => /\.tmp-/.test(n)), fs.readdirSync(tmp));

  await page.evaluate(() => { window.OT.app.dirty = false; });
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const fail = results.filter(x => !x).length;
  console.log(fail ? fail + ' .finca check(s) failed' : 'All ' + results.length + ' .finca checks passed.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
