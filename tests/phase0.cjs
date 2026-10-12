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

  // a real scene on disk, made by the app's own serializer
  const scene = path.join(tmp, 'scene.otoon');
  const v1 = await page.evaluate(() => JSON.stringify(window.OT.IO.serialize(window.OT.app)));
  fs.writeFileSync(scene, v1);
  const other = path.join(tmp, 'other.otoon');
  fs.writeFileSync(other, 'DO NOT TOUCH');

  /* ---------- file access rules ---------- */
  const r = await page.evaluate(async (p) => {
    const fsd = window.OpenToonDesktop.fs, out = {};
    out.readPasswd = await fsd.readFile('/etc/passwd');
    out.statPasswd = await fsd.statFile('/etc/passwd');
    out.writeUnknown = await fsd.writeFile(p.other, 'x');                 // exists, never opened
    out.writeTxt = await fsd.writeFile(p.tmp + '/evil.sh', 'x');
    out.read = await fsd.readFile(p.scene);                               // open it ...
    out.write = await fsd.writeFile(p.scene, p.v2);                       // ... then save over it
    out.writeIncrement = await fsd.writeFile(p.tmp + '/scene_002.otoon', p.v2);   // new sibling
    out.writeTraversal = await fsd.writeFile(p.tmp + '/../escape.otoon', 'x');
    out.picked = await fsd.saveDialog('x.otoon');
    out.writePicked = await fsd.writeFile(out.picked, p.v2);
    return out;
  }, { tmp, scene, other, v2: v1.replace('"name":', '"name2":"edited","name":') });
  check('reading a non-project file is refused', !r.readPasswd.ok && !r.statPasswd.ok, r.readPasswd);
  check('writing a project never opened is refused', !r.writeUnknown.ok && fs.readFileSync(other, 'utf8') === 'DO NOT TOUCH', r.writeUnknown);
  check('writing a non-.otoon file is refused', !r.writeTxt.ok && !fs.existsSync(path.join(tmp, 'evil.sh')));
  check('opened project can be saved over', r.read.ok && r.write.ok, r.write);
  check('save keeps the previous version as .bak', fs.readFileSync(scene + '.bak', 'utf8') === v1 && /"name2":"edited"/.test(fs.readFileSync(scene, 'utf8')));
  check('no temp file left behind', !fs.readdirSync(tmp).some(n => /\.tmp-/.test(n)), fs.readdirSync(tmp));
  check('Save Increment can create a new file next to it', r.writeIncrement.ok && fs.existsSync(path.join(tmp, 'scene_002.otoon')), r.writeIncrement);
  check('path tricks to escape the folder are refused', !r.writeTraversal.ok && !fs.existsSync(path.join(os.tmpdir(), 'escape.otoon')), r.writeTraversal);
  check('Save dialog picks become writable (.otoon added)', r.picked === path.join(tmp, 'picked.otoon') && r.writePicked.ok);

  /* ---------- autosave history ---------- */
  const histDir = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'autosave-history');
  const ah = await page.evaluate(async () => {
    const fsd = window.OpenToonDesktop.fs;
    await fsd.autosaveWrite('{"format":"otoon","a":1}');
    await fsd.autosaveWrite('{"format":"otoon","a":2}');
    return (await fsd.autosaveHistory()).length;
  });
  check('autosave keeps at most one snapshot per 5 minutes', ah === 1, ah);
  // pretend ten old snapshots exist; the next write adds one and prunes to 8
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(histDir, 'autosave-' + (Date.now() - 3600e3 - i * 600e3) + '.otoon'), '{}');
  fs.readdirSync(histDir).filter(n => Date.now() - +n.match(/\d+/)[0] < 3600e3).forEach(n => fs.unlinkSync(path.join(histDir, n)));
  const ah2 = await page.evaluate(async () => {
    const fsd = window.OpenToonDesktop.fs;
    await fsd.autosaveWrite('{"format":"otoon","a":3}');
    const h = await fsd.autosaveHistory();
    return { n: h.length, newest: await fsd.autosaveHistoryRead(h[0].name),
             evil: await fsd.autosaveHistoryRead('../../autosave.otoon') };
  });
  check('history pruned to the newest 8', ah2.n === 8, ah2.n);
  check('newest snapshot holds the latest autosave', ah2.newest === '{"format":"otoon","a":3}');
  check('history reader refuses path tricks', ah2.evil === null);

  /* ---------- format version ---------- */
  const fv = await page.evaluate(() => {
    const IO = window.OT.IO;
    return { saved: IO.serialize(window.OT.app).version, current: IO.FORMAT_VERSION };
  });
  check('projects are saved as format version 2', fv.saved === 2 && fv.current === 2, fv);
  const newer = path.join(tmp, 'future.otoon');
  fs.writeFileSync(newer, v1.replace('"version":1', '"version":99').replace('"version":2', '"version":99'));
  const before = fs.readFileSync(newer, 'utf8');
  await app.evaluate(() => { global.__saveCalls = 0; });
  const nv = await page.evaluate(async (f) => {
    const a = window.OT.app;
    const d = await window.OT.IO.readProjectFrom(f);
    a.loadProjectData(d); a.projectPath = f;
    await new Promise(r => setTimeout(r, 100));
    const warned = /newer version/.test(document.querySelector('.modal-body') ? document.querySelector('.modal-body').textContent : '');
    document.querySelectorAll('.modal-bg').forEach(m => m.remove());
    a.saveProject();                                        // plain Save
    await new Promise(r => setTimeout(r, 400));
    return { newer: d.newer, warned, path: a.projectPath };
  }, newer);
  const calls = await app.evaluate(() => global.__saveCalls);
  check('opening a newer-format file warns', nv.newer && nv.warned, nv);
  check('plain Save on it asks for a new name and leaves the original intact',
    calls === 1 && fs.readFileSync(newer, 'utf8') === before && nv.path === path.join(tmp, 'picked.otoon'), { calls, path: nv.path });

  /* ---------- Recover Autosave dialog ---------- */
  const rec = await page.evaluate(async () => {
    const a = window.OT.app;
    await window.OpenToonDesktop.fs.autosaveWrite(JSON.stringify(Object.assign(window.OT.IO.serialize(a), { name: 'recovered-scene' })));
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
