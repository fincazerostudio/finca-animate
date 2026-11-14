/* Phase 0: safe saves, file access rules, autosave history, format version.
 *
 *   node tests/phase0.cjs [path/to/opentoon-studio]
 *
 * Runs the real Electron app (dev runner by default) with a throwaway
 * settings folder; the native Save dialog is replaced from the main process.
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
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opentoon-phase0-'));
  const cfg = path.join(tmp, 'config');
  const app = await _electron.launch({ executablePath: EXE, args: ARGS, timeout: 60000,
    env: Object.assign({}, process.env, { XDG_CONFIG_HOME: cfg, OPENTOON_UPDATES: 'off' }) });
  let page = null;
  for (let i = 0; i < 150 && !page; i++) {
    page = app.windows().find(w => /index\.html$/.test(w.url())) || null;
    if (!page) await new Promise(r => setTimeout(r, 200));
  }
  await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.ui, null, { timeout: 30000 });
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
  // replace the native Save dialog; record calls
  await app.evaluate(({ dialog }, p) => {
    global.__saveCalls = 0;
    dialog.showSaveDialog = async () => { global.__saveCalls++; return { canceled: false, filePath: p }; };
  }, path.join(tmp, 'picked'));

  // real scenes on disk, made by the app itself
  fs.mkdirSync(path.join(tmp, 'imports'));
  const legacy = path.join(tmp, 'imports', 'legacy.otoon');
  const v1 = await page.evaluate(() => JSON.stringify(window.OT.IO.serialize(window.OT.app)));
  fs.writeFileSync(legacy, v1);
  const other = path.join(tmp, 'other.finca');
  fs.writeFileSync(other, 'DO NOT TOUCH');
  const scene = path.join(tmp, 'scene.finca');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, scene);
  await page.evaluate(async () => {
    const OT = window.OT, a = OT.app;
    const p = await window.OpenToonDesktop.fs.saveDialog('scene.finca');
    await OT.IO.writeProjectTo(a, p);
  });
  const sceneV1 = fs.readFileSync(scene);
  await app.evaluate(({ dialog }, p) => {
    global.__saveCalls = 0;
    dialog.showSaveDialog = async () => { global.__saveCalls++; return { canceled: false, filePath: p }; };
  }, path.join(tmp, 'picked'));
  // a fresh app: nothing has been opened or picked yet
  await page.reload();
  await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.ui, null, { timeout: 30000 });
  await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });

  /* ---------- file access rules ---------- */
  const r = await page.evaluate(async (p) => {
    const fsd = window.OpenToonDesktop.fs, out = {};
    const W = (f) => fsd.fincaWrite(f, { scene: '{"format":"finca"}', entries: [] });
    out.readPasswd = await fsd.readFile('/etc/passwd');
    out.openPasswd = await fsd.fincaOpen('/etc/passwd');
    out.statPasswd = await fsd.statFile('/etc/passwd');
    out.openRelative = await fsd.fincaOpen('scene.finca');
    out.writeUnknown = await W(p.other);                                   // exists, never opened
    out.writeTxt = await W(p.tmp + '/evil.sh');
    out.writeOtoonUnopened = await W(p.legacy);
    out.readOtoon = await fsd.readFile(p.legacy);                          // import it ...
    out.writeOtoon = await W(p.legacy);                                    // ... never writable
    out.writeOtoonAsFinca = await W(p.legacy.replace(/\.otoon$/, '.finca'));
    out.open = await fsd.fincaOpen(p.scene);                               // open it ...
    out.entryTricks = await fsd.fincaRead(out.open.id, ['../../etc/passwd', '/etc/passwd', 'drawings/../../x', 'drawings/a/../../scene.json', 'mimetype', 'scene.json']);
    out.syncTrick = fsd.fincaReadSync(out.open.id, '../scene.json');
    out.badHandle = await fsd.fincaRead(99999, ['scene.json']);
    out.write = await window.OT.IO.writeProjectTo(window.OT.app, p.scene).then(() => ({ ok: true }), e => ({ ok: false, error: e.message }));   // ... save over it
    out.writeEntryTrick = await fsd.fincaWrite(p.scene, { scene: '{}', entries: [{ name: '../escape.png', data: new Uint8Array(4) }] });
    out.copyFromUnopened = await fsd.fincaWrite(p.scene, { scene: '{}', entries: [{ name: 'drawings/x/1.png', from: { id: 424242, name: 'scene.json' } }] });
    out.writeIncrement = await W(p.tmp + '/scene_002.finca');              // new sibling
    out.writeTraversal = await W(p.tmp + '/../escape.finca');
    out.picked = await fsd.saveDialog('x.finca');
    out.writePicked = await W(out.picked);
    return out;
  }, { tmp, scene, other, legacy });
  const zipOk = f => { try { const fd = fs.openSync(f, 'r'); try { return Z.readDirectory(fd).has('scene.json'); } finally { fs.closeSync(fd); } } catch (e) { return false; } };
  check('reading a non-project file is refused', !r.readPasswd.ok && !r.openPasswd.ok && !r.statPasswd.ok, r.readPasswd);
  check('relative paths are refused', !r.openRelative.ok, r.openRelative);
  check('writing a project never opened is refused', !r.writeUnknown.ok && fs.readFileSync(other, 'utf8') === 'DO NOT TOUCH', r.writeUnknown);
  check('writing a non-project file is refused', !r.writeTxt.ok && !fs.existsSync(path.join(tmp, 'evil.sh')));
  check('a .otoon can be read but is never written (before or after opening it)',
    r.readOtoon.ok && !r.writeOtoonUnopened.ok && !r.writeOtoon.ok && fs.readFileSync(legacy, 'utf8') === v1, r.writeOtoon);
  check('importing a .otoon does not make a .finca of the same name writable', !r.writeOtoonAsFinca.ok && !fs.existsSync(legacy.replace(/\.otoon$/, '.finca')), r.writeOtoonAsFinca);
  check('entries are read by name only: path tricks and unknown names come back empty',
    r.entryTricks.slice(0, 5).every(x => x === null) && r.entryTricks[5] && r.syncTrick === null && r.badHandle.every(x => x === null), r.entryTricks.map(x => x && x.length));
  check('opened project can be saved over', r.open.ok && r.write.ok && zipOk(scene), r.write);
  check('save keeps the previous version as .bak', fs.existsSync(scene + '.bak') && fs.readFileSync(scene + '.bak').equals(sceneV1));
  check('entry names that escape the project are refused', !r.writeEntryTrick.ok && zipOk(scene), r.writeEntryTrick);
  check('copying from a project that is not open is refused', !r.copyFromUnopened.ok && zipOk(scene), r.copyFromUnopened);
  check('no temp file left behind', !fs.readdirSync(tmp).some(n => /\.tmp-/.test(n)), fs.readdirSync(tmp));
  check('Save Increment can create a new file next to it', r.writeIncrement.ok && fs.existsSync(path.join(tmp, 'scene_002.finca')), r.writeIncrement);
  check('path tricks to escape the folder are refused', !r.writeTraversal.ok && !fs.existsSync(path.join(os.tmpdir(), 'escape.finca')), r.writeTraversal);
  check('Save dialog picks become writable (.finca added)', r.picked === path.join(tmp, 'picked.finca') && r.writePicked.ok);

  /* ---------- autosave history ---------- */
  const histDir = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'autosave-history');
  const autoFile = path.join(path.dirname(histDir), 'autosave.finca');
  const autoWrite = n => page.evaluate(async n => {
    const r = await window.OpenToonDesktop.fs.fincaWrite({ autosave: true }, { scene: JSON.stringify({ format: 'finca', a: n }), entries: [] });
    return r.ok;
  }, n);
  const ah = await page.evaluate(async () => (await window.OpenToonDesktop.fs.autosaveHistory()).length).then(async before => {
    await autoWrite(1); await autoWrite(2);
    return page.evaluate(async () => (await window.OpenToonDesktop.fs.autosaveHistory()).length);
  });
  check('autosave keeps at most one snapshot per 5 minutes', ah === 1, ah);
  check('the snapshot is a separate file from the live autosave (later writes do not change it)', (() => {
    const snap = fs.readdirSync(histDir).find(n => /\.finca$/.test(n));
    const fd = fs.openSync(path.join(histDir, snap), 'r');
    try { return JSON.parse(Z.readEntry(fd, Z.readDirectory(fd).get('scene.json')).toString()).a === 1; } finally { fs.closeSync(fd); }
  })());
  // pretend ten old snapshots exist; the next write adds one and prunes to 8
  for (let i = 0; i < 10; i++) fs.copyFileSync(autoFile, path.join(histDir, 'autosave-' + (Date.now() - 3600e3 - i * 600e3) + '.finca'));
  fs.readdirSync(histDir).filter(n => Date.now() - +n.match(/\d+/)[0] < 3600e3).forEach(n => fs.unlinkSync(path.join(histDir, n)));
  await autoWrite(3);
  const ah2 = await page.evaluate(async () => {
    const fsd = window.OpenToonDesktop.fs;
    const h = await fsd.autosaveHistory();
    const o = await fsd.fincaOpen({ history: h[0].name });
    return { n: h.length, newest: o.ok ? JSON.parse(o.scene).a : null,
             evil: (await fsd.fincaOpen({ history: '../../autosave.finca' })).ok,
             evil2: await fsd.autosaveHistoryRead('../../autosave.otoon') };
  });
  check('history pruned to the newest 8', ah2.n === 8, ah2.n);
  check('newest snapshot holds the latest autosave', ah2.newest === 3, ah2);
  check('history reader refuses path tricks', ah2.evil === false && ah2.evil2 === null);
  // an autosave.otoon left by an older build is still offered
  fs.writeFileSync(path.join(path.dirname(histDir), 'autosave.otoon'), JSON.stringify(Object.assign(JSON.parse(v1), { name: 'old-build-autosave' })));
  const future = Date.now() / 1000 + 60;
  fs.utimesSync(path.join(path.dirname(histDir), 'autosave.otoon'), future, future);
  const legacyAuto = await page.evaluate(async () => { const i = await window.OT.IO.readAutosave(); return i && i.project.name; });
  check('an older build\'s autosave.otoon is still offered for recovery', legacyAuto === 'old-build-autosave', legacyAuto);
  fs.unlinkSync(path.join(path.dirname(histDir), 'autosave.otoon'));

  /* ---------- format version ---------- */
  const fv = await page.evaluate(() => ({ current: window.OT.IO.FORMAT_VERSION, otoon: window.OT.IO.OTOON_VERSION }));
  const savedVersion = (() => {
    const fd = fs.openSync(scene, 'r');
    try { return JSON.parse(Z.readEntry(fd, Z.readDirectory(fd).get('scene.json')).toString()).version; } finally { fs.closeSync(fd); }
  })();
  check('projects are saved as format version 3 (.finca); .otoon stays at 2', savedVersion === 3 && fv.current === 3 && fv.otoon === 2, { savedVersion, fv });
  // a .finca from a newer build: scene.json says version 99
  const newer = path.join(tmp, 'future.finca');
  {
    const fd = fs.openSync(scene, 'r'), out = fs.openSync(newer, 'w');
    try {
      const dir = Z.readDirectory(fd), w = Z.createWriter(out);
      const sc = JSON.parse(Z.readEntry(fd, dir.get('scene.json')).toString());
      sc.version = 99;
      w.add('scene.json', Buffer.from(JSON.stringify(sc)), true);
      for (const [n, e] of dir) if (n !== 'mimetype' && n !== 'scene.json') w.copy(fd, e);
      w.finish();
    } finally { fs.closeSync(fd); fs.closeSync(out); }
  }
  const before = fs.readFileSync(newer);
  await app.evaluate(() => { global.__saveCalls = 0; });
  const nv = await page.evaluate(async (f) => {
    const a = window.OT.app;
    const d = await window.OT.IO.readProjectFrom(f);
    a._opened(f, d);
    await new Promise(r => setTimeout(r, 100));
    const warned = /newer version/.test(document.querySelector('.modal-body') ? document.querySelector('.modal-body').textContent : '');
    document.querySelectorAll('.modal-bg').forEach(m => m.remove());
    const held = a.projectPath;                             // what the 20 s background save would write to
    a.saveProject();                                        // plain Save
    for (let i = 0; i < 50 && !a.projectPath; i++) await new Promise(r => setTimeout(r, 100));
    return { newer: d.newer, warned, held, path: a.projectPath };
  }, newer);
  const calls = await app.evaluate(() => global.__saveCalls);
  check('opening a newer-format file warns', nv.newer && nv.warned, nv);
  check('a newer-format file is not the scene\'s save target, so the background save cannot overwrite it', nv.held === null, nv);
  check('plain Save on it asks for a new name and leaves the original intact',
    calls === 1 && fs.readFileSync(newer).equals(before) && nv.path === path.join(tmp, 'picked.finca'), { calls, path: nv.path });

  /* ---------- Recover Autosave dialog ---------- */
  const rec = await page.evaluate(async () => {
    const a = window.OT.app;
    const keep = a.project.name;
    a.project.name = 'recovered-scene';
    await window.OT.IO.writeProjectTo(a, a.projectPath).catch(() => {});
    a.dirty = true;
    window.OT.IO.autosave(a);
    for (let i = 0; i < 50 && !(window.OT.IO.stats.lastSave && window.OT.IO.stats.lastSave.auto); i++) await new Promise(r => setTimeout(r, 100));
    a.project.name = keep;
    await a.ui.recoverAutosaveDialog();
    await new Promise(r => setTimeout(r, 100));
    const btns = [...document.querySelectorAll('.modal-bg:last-child .modal-body .btn')];
    const labels = btns.map(b => b.textContent);
    btns[0].click();
    await new Promise(r => setTimeout(r, 300));
    return { labels, name: a.project.name, path: a.projectPath, dirty: a.dirty, menu: true };
  });
  check('Recover Autosave lists the latest + snapshots', rec.labels.length >= 2 && /^Latest autosave/.test(rec.labels[0]), rec.labels);
  check('recovering opens it as an unsaved copy', rec.name === 'recovered-scene' && rec.path === null && rec.dirty === true, rec);

  await page.evaluate(() => { window.OT.app.dirty = false; });   // skip the unsaved-changes prompt
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const fail = results.filter(x => !x).length;
  console.log(fail ? fail + ' phase-0 check(s) failed' : 'All ' + results.length + ' phase-0 checks passed.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
