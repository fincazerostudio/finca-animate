/* Storyboard mode (src/board.js): panels, drawing per panel, undo, save/load, UI */
const { launch, FILE } = require('./launch-browser.cjs');
const path = require('path');

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
  await page.evaluate(() => {
    const a = window.OT.app;
    a.newProject({ name: 'Board', width: 1920, height: 1080, fps: 24, frameCount: 48, bg: '#ffffff', board: true });
    window.T = {
      client(px, py) {
        const r = a.stage.canvas.getBoundingClientRect(), s = a.stage.projectToScreen(px, py);
        return { x: r.left + s.x, y: r.top + s.y };
      },
      B: () => a.project.board,
      spans: () => window.OT.Board.spans(a.project.board).map(s => [s.start, s.end]),
      layerA: () => a.project.layers.find(l => l.name === 'A')
    };
  });
  const stroke = async (pts) => {
    const c = await page.evaluate(p => p.map(q => window.T.client(q[0], q[1])), pts);
    await page.mouse.move(c[0].x, c[0].y); await page.mouse.down();
    for (let i = 1; i < c.length; i++) await page.mouse.move(c[i].x, c[i].y, { steps: 5 });
    await page.mouse.up(); await page.waitForTimeout(80);
  };
  const line = (x0, y0, x1, y1) => { const o = []; for (let i = 0; i <= 8; i++) o.push([x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8]); return o; };
  const res = {};
  const checks = [];
  await page.waitForTimeout(200);   // the strip redraws on the next animation frame

  res.start = await page.evaluate(() => {
    const a = window.OT.app;
    return { mode: document.body.classList.contains('board-mode'), panels: T.B().panels.length, frames: a.project.frameCount,
             layers: a.project.layers.map(l => l.name), cards: document.querySelectorAll('#boardstrip .bs-card').length,
             props: !!document.querySelector('#boardpanel .bp-text') };
  });
  checks.push(['new storyboard: board mode, one panel, BG + A layers, strip and panel props shown',
    res.start.mode && res.start.panels === 1 && res.start.frames === 48 && res.start.layers.join() === 'BG,A' &&
    res.start.cards === 1 && res.start.props]);

  // draw on layer A in panel 1: the drawing covers the whole panel
  await page.evaluate(() => { const a = window.OT.app; a.selectLayer ? a.selectLayer(T.layerA()) : (a._activeLayer = T.layerA()); a.setFrame(5); a.tools.select('brush'); });
  await stroke(line(600, 400, 1200, 600));
  res.draw = await page.evaluate(() => { const e = T.layerA().exposure; return { first: e[0], mid: e[20], last: e[47], same: e.slice(0, 48).every(n => n && n === e[0]) }; });
  checks.push(['drawing on an empty layer fills the whole panel', res.draw.same]);

  // new panel, duplicate, duration, captions
  res.ops = await page.evaluate(() => {
    const a = window.OT.app, O = window.OT.Board.Ops;
    O.newPanel(a);                       // panel 2, empty, 48 frames
    const afterNew = { frames: a.project.frameCount, frame: a.frame, spans: T.spans(), p2empty: !T.layerA().exposure[60] };
    O.goTo(a, 0);
    O.duplicatePanel(a);                 // panel 2 = copy of panel 1, old panel 2 -> 3
    const e = T.layerA().exposure;
    const dup = { panels: T.B().panels.length, frames: a.project.frameCount, copyNum: e[48], origNum: e[0], copyFilled: e.slice(48, 96).every(n => n === e[48]) };
    O.setDuration(a, 12);                // panel 2 shortened to 12 frames
    const dur = { spans: T.spans(), frames: a.project.frameCount };
    O.setText(a, 'dialogue', 'Hello there');
    return { afterNew, dup, dur, text: T.B().panels[1].dialogue };
  });
  checks.push(['new panel adds an empty panel after the current one', res.ops.afterNew.frames === 96 && res.ops.afterNew.frame === 48 && res.ops.afterNew.p2empty]);
  checks.push(['duplicate copies the drawings into a new drawing', res.ops.dup.panels === 3 && res.ops.dup.frames === 144 && res.ops.dup.copyNum && res.ops.dup.copyNum !== res.ops.dup.origNum && res.ops.dup.copyFilled]);
  checks.push(['duration change resizes only that panel', JSON.stringify(res.ops.dur.spans) === JSON.stringify([[0, 47], [48, 59], [60, 107]]) && res.ops.dur.frames === 108]);
  checks.push(['captions are kept on the panel', res.ops.text === 'Hello there']);

  // move panel 1 to the end, undo, redo
  res.move = await page.evaluate(() => {
    const a = window.OT.app, O = window.OT.Board.Ops;
    const ids = () => T.B().panels.map(p => p.id);
    const before = ids(), drawn = T.layerA().exposure[0];
    O.movePanel(a, 0, 2);
    const moved = { ids: ids(), drawnAt: T.layerA().exposure[60 + 0], frame: a.frame };
    a.undo();
    const undone = { ids: ids(), first: T.layerA().exposure[0] };
    a.redo();
    return { before, moved, undone, redone: ids(), drawn };
  });
  checks.push(['moving a panel moves its drawings and timing', res.move.moved.ids[2] === res.move.before[0] && res.move.moved.drawnAt === res.move.drawn && res.move.moved.frame === 60]);
  checks.push(['undo / redo restore panels', JSON.stringify(res.move.undone.ids) === JSON.stringify(res.move.before) && res.move.undone.first === res.move.drawn && JSON.stringify(res.move.redone) === JSON.stringify(res.move.moved.ids)]);

  // scenes, delete, insert frame
  res.scene = await page.evaluate(() => {
    const a = window.OT.app, O = window.OT.Board.Ops;
    O.goTo(a, 0); O.newScene(a);
    const lab = window.OT.Board.labels(T.B());
    const names = T.B().panels.map(p => lab.get(p.id).scene + '.' + lab.get(p.id).panel);
    const n = T.B().panels.length;
    O.deletePanel(a);
    const afterDelete = T.B().panels.length;
    O.goTo(a, 0);
    const d0 = T.B().panels[0].duration;
    a.insertFrame();
    return { names, n, afterDelete, grew: T.B().panels[0].duration === d0 + 1, total: a.project.frameCount === T.B().panels.reduce((s, p) => s + p.duration, 0) };
  });
  checks.push(['new scene starts scene 2 after scene 1', res.scene.names.join() === '1.1,1.2,1.3,2.1' && res.scene.n === 4]);
  checks.push(['delete panel / insert frame keep panels and frames in step', res.scene.afterDelete === 3 && res.scene.grew && res.scene.total]);

  // save / load (.otoon) keeps the board
  res.io = await page.evaluate(async () => {
    const a = window.OT.app;
    const before = JSON.stringify(T.B());
    const data = JSON.parse(JSON.stringify(window.OT.IO.serialize(a)));
    a.loadProjectData(await window.OT.IO.deserialize(data));
    return { same: JSON.stringify(T.B()) === before, mode: document.body.classList.contains('board-mode'),
             cards: document.querySelectorAll('#boardstrip .bs-card').length };
  });
  await page.waitForTimeout(300);
  res.ui = await page.evaluate(() => ({ cards: document.querySelectorAll('#boardstrip .bs-card').length,
    thumbs: Array.from(document.querySelectorAll('#boardstrip .bs-thumb')).filter(i => i.src.startsWith('data:image')).length,
    head: document.querySelector('#boardpanel .panel-head').textContent }));
  checks.push(['save/load keeps the storyboard', res.io.same && res.io.mode]);
  checks.push(['strip shows a card with a thumbnail per panel', res.ui.cards === 3 && res.ui.thumbs === 3 && /Scene 1 · Panel 1/.test(res.ui.head)]);

  // PDF export: a real PDF with one page per three panels
  const pdfB64 = await page.evaluate(async () => {
    const a = window.OT.app;
    window.OT.Board.Ops.goTo(a, 0); window.OT.Board.Ops.setText(a, 'action', 'She runs (fast) across the street \\ into the rain.');
    const blob = await window.OT.BoardPDF.build(a, { perPage: 3, paper: 'letter', captions: true });
    const b = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  });
  const fs = require('fs'), cp = require('child_process');
  const pdfPath = path.join(__dirname, 'storyboard.pdf');
  fs.writeFileSync(pdfPath, Buffer.from(pdfB64, 'base64'));
  res.pdf = { header: fs.readFileSync(pdfPath).slice(0, 5).toString() };
  try {
    const info = cp.execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
    res.pdf.pages = +(info.match(/Pages:\s+(\d+)/) || [])[1];
    cp.execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '1', pdfPath, path.join(__dirname, 'storyboard-pdf')]);
  } catch (e) { res.pdf.pages = e.code === 'ENOENT' ? 'skip' : 'error: ' + e.message; }
  checks.push(['PDF export is a valid PDF (3 panels -> 1 page)', res.pdf.header === '%PDF-' && (res.pdf.pages === 1 || res.pdf.pages === 'skip')]);

  // Animate <-> Storyboard switch: panels kept, animation behaves normally
  res.mode = await page.evaluate(async () => {
    const a = window.OT.app, B = window.OT.Board;
    const panelsBefore = JSON.stringify(a.project.board.panels.map(p => [p.id, p.duration]));
    const btn = m => document.querySelector('#menubar .fz-mode-btn[data-mode="' + m + '"]');
    const hasSwitch = !!btn('anim') && btn('board').classList.contains('is-on');
    btn('anim').click();
    await new Promise(r => setTimeout(r, 60));
    const anim = { on: B.on(a.project), body: document.body.classList.contains('board-mode'),
      cards: document.querySelectorAll('#boardstrip .bs-card').length, kept: !!a.project.board,
      animOn: btn('anim').classList.contains('is-on'), span: window.OT.boardSpan(0) };
    const frames = a.project.frameCount, d0 = a.project.board.panels[0].duration;
    a.setFrame(0); a.insertFrame();                   // a plain frame insert, not a panel resize
    const ins = { frames: a.project.frameCount === frames + 1, panelSame: a.project.board.panels[0].duration === d0 };
    const data = JSON.parse(JSON.stringify(window.OT.IO.serialize(a)));
    const hiddenSaved = !!(data.board && data.board.hidden);
    btn('board').click();
    await new Promise(r => setTimeout(r, 60));
    const back = { on: B.on(a.project), body: document.body.classList.contains('board-mode'),
      cards: document.querySelectorAll('#boardstrip .bs-card').length,
      inStep: a.project.frameCount === a.project.board.panels.reduce((n, p) => n + p.duration, 0) };
    a.undo();
    const undone = !B.on(a.project) && !!a.project.board;
    a.redo();
    return { hasSwitch, anim, ins, hiddenSaved, back, undone, panelsSame: JSON.stringify(a.project.board.panels.map(p => p.id)) === JSON.stringify(JSON.parse(panelsBefore).map(x => x[0])) };
  });
  checks.push(['Animate | Storyboard switch shows for storyboard projects', res.mode.hasSwitch]);
  checks.push(['Animation mode hides the strip, keeps the panels, draws per frame',
    !res.mode.anim.on && !res.mode.anim.body && res.mode.anim.cards === 0 && res.mode.anim.kept && res.mode.anim.animOn && res.mode.anim.span === null]);
  checks.push(['Insert Frame in Animation mode is a plain frame insert', res.mode.ins.frames && res.mode.ins.panelSame]);
  checks.push(['back to Storyboard: strip returns, panels and frames in step', res.mode.back.on && res.mode.back.body && res.mode.back.cards === 3 && res.mode.back.inStep && res.mode.panelsSame]);
  checks.push(['mode switch is undoable and saved with the project', res.mode.undone && res.mode.hiddenSaved]);

  // audit fixes: Add 12 frames, caption undo, New Drawing, Duplicate Panel moves
  res.audit = await page.evaluate(async () => {
    const a = window.OT.app, B = window.OT.Board, O = B.Ops;
    a.newProject({ name: 'Audit', width: 1280, height: 720, fps: 24, frameCount: 48, bg: '#ffffff', board: true });
    O.newPanel(a);                                   // panel 2 at frames 48..95
    const total = () => a.project.board.panels.reduce((n, p) => n + p.duration, 0);
    const d2 = a.project.board.panels[1].duration;
    a.addFrames(12);
    const frames = { grew: a.project.board.panels[1].duration === d2 + 12, inStep: total() === a.project.frameCount };
    a.undo();
    frames.undone = a.project.board.panels[1].duration === d2 && total() === a.project.frameCount;
    // captions: one undo step per stretch of typing
    O.setText(a, 'dialogue', 'H'); O.setText(a, 'dialogue', 'He'); O.setText(a, 'dialogue', 'Hey');
    const typed = a.project.board.panels[1].dialogue;
    a.undo();
    const caption = { typed, undone: a.project.board.panels[1].dialogue === '' };
    a.redo();
    caption.redone = a.project.board.panels[1].dialogue === 'Hey';
    // New Drawing covers the whole panel
    const L = a.project.layers.find(l => l.name === 'A'); a.selectLayer(L);
    a.setFrame(60); a.newDrawing();
    const sp = B.spanAt(a.project.board, 60), n = L.exposure[60];
    const fills = n && L.exposure.slice(sp.start, sp.end + 1).every(x => x === n);
    // Duplicate Panel copies the panel's camera move
    a.setFrame(10); a.project.camera.keyframes.push({ frame: 10, x: 30, y: 0, zoom: 1.2, rot: 0 });
    O.goTo(a, 0); O.duplicatePanel(a);
    const dupKey = a.project.camera.keyframes.some(k => k.frame === 10 + 48 && k.zoom === 1.2);
    return { frames, caption, fills, dupKey };
  });
  const au = res.audit;
  checks.push(['Add 12 frames lengthens the current panel and undoes in one step', au.frames.grew && au.frames.inStep && au.frames.undone]);
  checks.push(['typing a caption is one undo step (and redo)', au.caption.typed === 'Hey' && au.caption.undone && au.caption.redone]);
  checks.push(['New Drawing covers the whole panel', au.fills]);
  checks.push(['Duplicate Panel copies the camera move', au.dupKey]);

  // a plain project is not in board mode
  res.plain = await page.evaluate(() => { window.OT.app.newProject({}); return document.body.classList.contains('board-mode'); });
  await page.waitForTimeout(100);
  res.plain2 = await page.evaluate(() => document.body.classList.contains('board-mode') || !!window.OT.app.project.board);
  checks.push(['a normal project stays a normal project', !res.plain2]);
  res.plainFrames = await page.evaluate(() => {
    const a = window.OT.app; a.newProject({}); const n = a.project.frameCount;
    a.addFrames(12); const grew = a.project.frameCount === n + 12; a.undo();
    return grew && a.project.frameCount === n;
  });
  checks.push(['Add 12 frames in a normal project is one undo step', res.plainFrames]);
  {
    const fs = require('fs');
    const pen = fs.readFileSync(path.join(__dirname, '../pen/pen.html'), 'utf8');
    checks.push(['the pen window loads the theme colours and engine', /theme-colors\.css/.test(pen) && /src\/theme\.js/.test(pen) && !/#[0-9a-fA-F]{6}\b/.test((pen.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1])]);
  }

  await page.evaluate(() => window.OT.app.newProject({ name: 'Board', width: 1920, height: 1080, fps: 24, frameCount: 48, bg: '#ffffff', board: true }));
  await page.waitForTimeout(200);
  await page.evaluate(() => { const a = window.OT.app; a.selectLayer(T.layerA()); a.tools.select('brush'); });
  await stroke(line(500, 300, 1400, 800));
  await page.evaluate(() => { const a = window.OT.app; window.OT.Board.Ops.newPanel(a); window.OT.Board.Ops.setText(a, 'dialogue', 'Where did it go?'); });
  await stroke(line(500, 800, 1400, 300));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(__dirname, 'storyboard.png') });

  checks.push(['no page errors', errors.length === 0]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  if (fail) console.log(JSON.stringify(res, null, 1), errors);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
