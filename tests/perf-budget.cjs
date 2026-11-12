/* Performance budget (roadmap Phase 1).
 *
 *   node tests/perf-budget.cjs [--quick] [path/to/opentoon-studio]
 *   npm run test:perf
 *
 * Builds the reference scene straight into a .finca (no outside artwork):
 * 2 minutes at 24 fps, 1920x1080, 10 layers (8 raster, 2 vector) on twos,
 * i.e. 14,400 drawings. Then, in the real desktop app:
 *   open    : open the file until the first frame is on screen
 *   save    : edit one drawing, save; and save again with nothing changed
 *   playback: play 6 s and count frames shown vs. due, and how many frames
 *             were shown with a drawing still missing
 *   scrub   : jump to 20 far-apart frames, time until each is complete
 *   memory  : renderer memory after open and after playback
 * Each number has a budget (BUDGET below); the run fails if one is over.
 * --quick uses a 20-second scene (for a fast look; budgets still apply).
 * FINCA_PERF_DIR picks where the scene file goes (default: the temp folder).
 */
'use strict';
const { _electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const Z = require('../electron/finca-zip.js');

const ROOT = path.resolve(__dirname, '..');
const QUICK = process.argv.includes('--quick');
const exeArg = process.argv.slice(2).find(a => !a.startsWith('--'));
const EXE = exeArg || require('electron');
const ARGS = exeArg ? [] : [ROOT];

const BUDGET = {
  openToFirstPaintMs: 1500,      // double-click to a usable first frame
  saveAfterEditMs: 500,          // the 20 s background save after a small edit
  saveUnchangedMs: 500,
  saveFullMs: 3000,              // Ctrl+S / Save As: every vector drawing is checked again
  playbackFps: 22,               // of 24
  playbackIncompletePct: 5,      // frames shown while one of their drawings was still loading
  scrubCompleteMs: 250,          // jump anywhere: all drawings of that frame on screen
  rendererMemoryMB: 2048         // after playing through (cel budget is 1 GB by default)
};

const W = 1920, H = 1080, FPS = 24, SECONDS = QUICK ? 20 : 120, LAYERS = 10, VECTOR_LAYERS = 2;
const FRAMES = SECONDS * FPS, PER_LAYER = FRAMES / 2;
const VARIANTS = 24;             // distinct drawings per layer, reused along the shot

/* ---- a tiny PNG writer: RGBA, no filtering, fast deflate ---- */
function crcTable() { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; }
const CRC = crcTable();
function crc(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
// a character-sized blob with an outline and some line work
function drawing(layer, v) {
  const buf = Buffer.alloc(W * H * 4);
  const cx = 200 + ((layer * 157 + v * 61) % (W - 400)), cy = 180 + ((layer * 89 + v * 37) % (H - 360));
  const rx = 90 + (layer * 7) % 60, ry = 120 + (v * 5) % 50;
  const hue = [[220, 90, 70], [80, 160, 220], [240, 200, 80], [120, 200, 120], [200, 120, 220], [250, 150, 90], [90, 210, 200], [180, 180, 180]][layer % 8];
  for (let y = Math.max(0, cy - ry - 4); y < Math.min(H, cy + ry + 4); y++) {
    for (let x = Math.max(0, cx - rx - 4); x < Math.min(W, cx + rx + 4); x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2, o = (y * W + x) * 4;
      if (d <= 1.0) { buf[o] = hue[0]; buf[o + 1] = hue[1]; buf[o + 2] = hue[2]; buf[o + 3] = 255; }
      if (d > 0.9 && d <= 1.1) { buf[o] = buf[o + 1] = buf[o + 2] = 25; buf[o + 3] = 255; }
    }
  }
  for (let k = 0; k < 6; k++) {            // a few "pencil" lines inside
    const y = cy - ry / 2 + k * ry / 6 | 0;
    for (let x = cx - rx / 2 | 0; x < cx + rx / 2; x++) { const o = (y * W + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = 30; buf[o + 3] = 230; }
  }
  // stored cropped to the drawn area, the way the app writes drawings
  const x0 = Math.max(0, cx - rx - 4), y0 = Math.max(0, cy - ry - 4);
  const x1 = Math.min(W, cx + rx + 4), y1 = Math.min(H, cy + ry + 4), bw = x1 - x0, bh = y1 - y0;
  const crop = Buffer.alloc(bw * bh * 4);
  for (let y = 0; y < bh; y++) buf.copy(crop, y * bw * 4, ((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1) * 4);
  return { bytes: png(bw, bh, crop), x: x0, y: y0 };
}
function vectorDrawing(layer, v) {
  let seed = layer * 1000 + v + 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cx = 300 + rnd() * 1300, cy = 200 + rnd() * 700, strokes = [];
  for (let s = 0; s < 30; s++) {
    const pts = []; let x = cx + rnd() * 300 - 150, y = cy + rnd() * 300 - 150;
    for (let q = 0; q < 25; q++) { x += rnd() * 16 - 8; y += rnd() * 16 - 8; pts.push({ x: +x.toFixed(1), y: +y.toFixed(1), p: +(0.5 + rnd() * 0.5).toFixed(2) }); }
    strokes.push({ pts, color: '#222222', width: 3, pencil: true });
  }
  return Buffer.from(JSON.stringify({ strokes, eraserMarks: [] }));
}

function buildScene(file) {
  const t0 = Date.now();
  const fd = fs.openSync(file, 'w');
  const w = Z.createWriter(fd);
  const layers = [];
  const entries = [];
  for (let li = 0; li < LAYERS; li++) {
    const vec = li >= LAYERS - VECTOR_LAYERS, id = 'perf' + li;
    const variants = [];
    for (let v = 0; v < VARIANTS; v++) variants.push(vec ? vectorDrawing(li, v) : drawing(li, v));
    const cels = {}, exposure = [];
    for (let k = 0; k < PER_LAYER; k++) {
      const num = k + 1, name = 'drawings/' + id + '/' + num + (vec ? '.json' : '.png');
      const v = variants[k % VARIANTS];
      cels[num] = vec ? { k: 'v', src: name, w: W, h: H } : { k: 'r', src: name, w: W, h: H, x: v.x, y: v.y };
      entries.push([name, vec ? v : v.bytes, vec]);
      exposure[2 * k] = exposure[2 * k + 1] = num;
    }
    layers.push({ id, name: 'L' + li, type: vec ? 'vector' : 'drawing', visible: true, locked: false, opacity: 1,
      exposure, nextNum: PER_LAYER + 1, transform: { keyframes: [] }, cels });
  }
  w.add('scene.json', Buffer.from(JSON.stringify({ format: 'finca', version: 3, name: 'perf', width: W, height: H,
    fps: FPS, frameCount: FRAMES, bg: '#ffffff', camera: { keyframes: [] }, layers })), true);
  for (const [name, data, deflate] of entries) w.add(name, data, deflate);
  w.finish();
  fs.closeSync(fd);
  return { drawings: entries.length, bytes: fs.statSync(file).size, ms: Date.now() - t0 };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.FINCA_PERF_DIR || os.tmpdir(), 'finca-perf-'));
  const scene = path.join(dir, 'perf.finca');
  let app;
  try {
    const built = buildScene(scene);
    console.log('scene: ' + SECONDS + ' s, ' + W + 'x' + H + ', ' + LAYERS + ' layers, ' + built.drawings + ' drawings, ' +
      (built.bytes / 1048576).toFixed(0) + ' MB (built in ' + (built.ms / 1000).toFixed(1) + ' s)');

    app = await _electron.launch({ executablePath: EXE, args: ARGS, timeout: 60000,
      env: Object.assign({}, process.env, { XDG_CONFIG_HOME: path.join(dir, 'config'), OPENTOON_UPDATES: 'off' }) });
    let page = null;
    for (let i = 0; i < 150 && !page; i++) {
      page = app.windows().find(w => /index\.html$/.test(w.url())) || null;
      if (!page) await new Promise(r => setTimeout(r, 200));
    }
    await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.ui, null, { timeout: 30000 });
    await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
    // keep the window on screen and in front: hidden windows are throttled
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => x.isVisible()) || BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } });
    await page.waitForTimeout(500);
    const rendererMB = () => app.evaluate(({ app }) => app.getAppMetrics()
      .filter(m => m.type === 'Tab').reduce((s, m) => s + m.memory.workingSetSize / 1024, 0)).then(Math.round);

    // complete = every visible drawing of the frame is in memory
    await page.evaluate(() => {
      window.frameComplete = f => window.OT.app.project.layers.every(l => { const c = l.celAt(f); return !c || !c.parked; });
    });

    // Timings on a desktop session jump by whole seconds now and then (the
    // compositor holding back frames for a window it considers hidden), so
    // open and save are measured three times and judged on the median.
    const median = xs => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    /* open */
    const opens = [];
    for (let i = 0; i < 3; i++) opens.push(await page.evaluate(async (f) => {
      const OT = window.OT, a = OT.app;
      const t0 = performance.now();
      const d = await OT.IO.readProjectFrom(f);
      const tRead = performance.now();
      a._opened(f, d);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tPaint = performance.now();
      while (!window.frameComplete(a.frame)) await new Promise(r => setTimeout(r, 5));
      return { readMs: Math.round(tRead - t0), firstPaintMs: Math.round(tPaint - t0), completeMs: Math.round(performance.now() - t0) };
    }, scene));
    const open = { readMs: median(opens.map(o => o.readMs)), firstPaintMs: median(opens.map(o => o.firstPaintMs)),
      completeMs: median(opens.map(o => o.completeMs)), runs: opens.map(o => o.firstPaintMs) };
    const memOpen = await rendererMB();

    // Optional timings distinguish file IPC from main-thread UI work.
    if (process.env.FINCA_PERF_PROFILE) await page.evaluate(() => {
      window.__perf = {};
      const wrap = (obj, key, label, async = false) => {
        const original = obj[key];
        obj[key] = function (...args) {
          const t = performance.now();
          const record = () => { const r = window.__perf[label] || (window.__perf[label] = { calls: 0, ms: 0 }); r.calls++; r.ms += performance.now() - t; };
          const result = original.apply(this, args);
          if (async) return Promise.resolve(result).finally(record);
          record(); return result;
        };
      };
      const a = window.OT.app;
      wrap(a.timeline, '_renderGrid', 'timeline');
      wrap(a.timeline, '_renderNames', 'names');
      wrap(window.OT.CelMemory, 'trim', 'trim');
      wrap(window.OT.IO, 'readEntry', 'entry', true);
      wrap(a.stage, 'render', 'stage');
    });

    /* save */
    const save = await page.evaluate(async (f) => {
      const OT = window.OT, a = OT.app;
      const c = a.project.layers[0].celAt(a.frame);
      c.ctx.fillStyle = '#000'; c.ctx.fillRect(10, 10, 40, 40); c.dirty(); a.dirty = true;
      // first save after opening: the full kind (Ctrl+S), looks at every drawing
      let t0 = performance.now();
      await OT.IO.writeProjectTo(a, f, { thumbnail: true });
      const full = { ms: Math.round(performance.now() - t0), encoded: OT.IO.stats.lastSave.encoded };
      // then what the 20 s timer does while you draw (three edits)
      const runs = [];
      let edit = null;
      for (let i = 0; i < 3; i++) {
        c.ctx.fillRect(60 + i * 50, 10, 40, 40); c.dirty(); a.dirty = true;
        t0 = performance.now();
        await OT.IO.writeProjectTo(a, f, { background: true });
        runs.push(Math.round(performance.now() - t0));
        edit = { encoded: OT.IO.stats.lastSave.encoded, copied: OT.IO.stats.lastSave.copied };
      }
      edit.runs = runs;
      edit.ms = runs.slice().sort((p, q) => p - q)[1];
      a.dirty = true;
      t0 = performance.now();
      await OT.IO.writeProjectTo(a, f, { background: true });
      return { ctrlS: full, edit, unchangedMs: Math.round(performance.now() - t0) };
    }, scene);

    /* how long one drawing takes to come into memory (file read + decode) */
    const load = await page.evaluate(async () => {
      const a = window.OT.app, cels = [];
      for (const l of a.project.layers) for (let n = 200; n < 400 && cels.length < 64; n += 25) { const c = l.cels[n]; if (c && c.parked) cels.push(c); }
      const one = [];
      for (const c of cels.slice(0, 16)) { const t = performance.now(); await c.load(); one.push(performance.now() - t); }
      const batch = cels.slice(16, 48);
      const t = performance.now();
      await Promise.all(batch.map(c => c.load()));
      const par = (performance.now() - t) / Math.max(1, batch.length);
      one.sort((x, y) => x - y);
      for (const c of cels) c.release();
      return { oneByOneMedianMs: +one[8].toFixed(1), parallelPerDrawingMs: +par.toFixed(1) };
    });

    if (process.env.FINCA_PERF_PROFILE) console.log('profile before playback: ' + JSON.stringify(await page.evaluate(() => window.__perf)));
    /* playback */
    const play = await page.evaluate(async () => {
      const a = window.OT.app;
      a.setFrame(0);
      while (!window.frameComplete(0)) await new Promise(r => setTimeout(r, 5));
      let shown = 0, incomplete = 0;
      const off = a.on ? null : null;
      const why = { loading: 0, idle: 0 };
      const onFrame = () => {
        shown++;
        if (window.frameComplete(a.frame)) return;
        incomplete++;
        for (const l of a.project.layers) { const c = l.celAt(a.frame); if (c && c.parked) { if (c._loading) why.loading++; else why.idle++; } }
      };
      window.__why = why;
      a.on('framechange', onFrame);
      const t0 = performance.now();
      a.playback.play();
      await new Promise(r => setTimeout(r, 6000));
      a.playback.stop();
      const secs = (performance.now() - t0) / 1000;
      const h = a._h && a._h.framechange; if (h) h.splice(h.indexOf(onFrame), 1);
      return { fps: +(shown / secs).toFixed(1), shown, incompletePct: +(100 * incomplete / Math.max(1, shown)).toFixed(1),
               endFrame: a.frame, why: window.__why };
    });
    const memPlay = await rendererMB();

    /* scrub */
    const scrub = await page.evaluate(async () => {
      const a = window.OT.app, n = a.project.frameCount, times = [];
      for (let i = 0; i < 20; i++) {
        const f = Math.floor((i * 7919) % n);
        const t0 = performance.now();
        a.setFrame(f);
        while (!window.frameComplete(f)) await new Promise(r => setTimeout(r, 2));
        await new Promise(r => requestAnimationFrame(r));
        times.push(performance.now() - t0);
      }
      times.sort((x, y) => x - y);
      return { medianMs: Math.round(times[10]), worstMs: Math.round(times[19]), syncDecodes: window.OT.Cel.stats.syncDecodes };
    });
    if (process.env.FINCA_PERF_PROFILE) console.log('profile final: ' + JSON.stringify(await page.evaluate(() => window.__perf)));
    const memEnd = await rendererMB();
    const cel = await page.evaluate(() => window.OT.CelMemory.stats(window.OT.app.project));

    await page.evaluate(() => { window.OT.app.dirty = false; });
    await app.close();
    app = null;

    const result = {
      scene: { seconds: SECONDS, size: W + 'x' + H, layers: LAYERS, drawings: built.drawings, fileMB: Math.round(built.bytes / 1048576) },
      open, save, load, playback: play, scrub,
      memory: { rendererAfterOpenMB: memOpen, rendererAfterPlaybackMB: memPlay, rendererAtEndMB: memEnd,
        celSurfacesMB: cel.mb, surfacesInMemory: cel.allocated, parked: cel.parked }
    };
    console.log(JSON.stringify(result));
    const checks = [
      ['open to first paint', open.firstPaintMs, BUDGET.openToFirstPaintMs, '<='],
      ['background save after one edit', save.edit.ms, BUDGET.saveAfterEditMs, '<='],
      ['Ctrl+S (checks every drawing)', save.ctrlS.ms, BUDGET.saveFullMs, '<='],
      ['save with nothing changed', save.unchangedMs, BUDGET.saveUnchangedMs, '<='],
      ['playback fps', play.fps, BUDGET.playbackFps, '>='],
      ['playback frames shown incomplete (%)', play.incompletePct, BUDGET.playbackIncompletePct, '<='],
      ['scrub: frame complete (median ms)', scrub.medianMs, BUDGET.scrubCompleteMs, '<='],
      ['renderer memory after playback (MB)', Math.max(memPlay, memEnd), BUDGET.rendererMemoryMB, '<=']
    ];
    let over = 0;
    for (const [name, v, b, op] of checks) {
      const ok = op === '<=' ? v <= b : v >= b;
      if (!ok) over++;
      console.log((ok ? 'PASS ' : 'OVER ') + name + ': ' + v + ' (budget ' + op + ' ' + b + ')');
    }
    console.log(over ? over + ' number(s) over budget' : 'All within budget.');
    process.exitCode = over ? 1 : 0;
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
