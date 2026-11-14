// Data-safety tests for saving and opening .finca files
// (electron/finca-store.js). Plain Node: no browser, no Electron.
//
//   round trips ........ what is saved is what comes back, save after save
//   interrupted saves .. the process is killed at many points inside a save
//   full disk .......... the save fails cleanly and says why
//   backups ............ .bak is always a complete earlier version
//   damaged files ...... a cut-short file opens with what is still there
//   large scenes ....... 70,000 drawings (past the classic zip limit)
//
// The "killed mid-save" cases run the save in a child process (this same
// file with --child) that sends itself SIGKILL from inside a chosen fs call,
// which is as close to pulling the plug as a test can get.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Store = require('../electron/finca-store.js');
const Z = require('../electron/finca-zip.js');

/* ------------------------- shared scene builders ------------------------- */
const bytes = (n, seed) => { const b = Buffer.alloc(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; } return b; };
const DRAWINGS = 30;
const pngName = (i, v) => 'drawings/L1/' + i + '-v' + v + '.png';
// version v of the test scene: drawing i has content version ver[i]
function sceneFor(ver) {
  const cels = {};
  ver.forEach((v, i) => { cels[i + 1] = { k: 'r', src: pngName(i + 1, v), w: 1920, h: 1080 }; });
  cels.v1 = { k: 'v', src: 'drawings/L2/1-a.json', w: 1920, h: 1080 };
  return JSON.stringify({ format: 'finca', version: 3, name: 'safety', layers: [{ id: 'L1', cels }], note: 'é✓ ' + ver.join('') });
}
const vecText = JSON.stringify({ strokes: new Array(300).fill({ pts: [1, 2, 3, 4], w: 2 }), eraserMarks: [] });
const media = bytes(50000, 99);
// payload for a first save (everything fresh) or an incremental one (unchanged entries copied from `id`)
function payloadFor(ver, prev, id) {
  const entries = [];
  ver.forEach((v, i) => {
    const name = pngName(i + 1, v);
    if (prev && prev[i] === v) entries.push({ name, from: { id, name } });
    else entries.push({ name, data: new Uint8Array(bytes(20000 + i * 37, (i + 1) * 1000 + v)) });
  });
  if (prev) {
    entries.push({ name: 'drawings/L2/1-a.json', from: { id, name: 'drawings/L2/1-a.json' } });
    entries.push({ name: 'media/snd.wav', from: { id, name: 'media/snd.wav' } });
    entries.push({ name: 'thumbnail.png', from: { id, name: 'thumbnail.png' }, optional: true });
  } else {
    entries.push({ name: 'drawings/L2/1-a.json', text: vecText });
    entries.push({ name: 'media/snd.wav', data: new Uint8Array(media) });
  }
  return { scene: sceneFor(ver), entries };
}
// Does `file` hold exactly scene version `ver`, every entry intact?
function holds(file, ver) {
  try {
    const r = Store.open(file);
    if (r.damaged || r.scene !== sceneFor(ver)) return 'scene differs' + (r.damaged ? ' (damaged)' : '');
    const names = ver.map((v, i) => pngName(i + 1, v)).concat(['drawings/L2/1-a.json', 'media/snd.wav']);
    const got = Store.read(r.id, names);
    for (let i = 0; i < ver.length; i++) {
      const want = bytes(20000 + i * 37, (i + 1) * 1000 + ver[i]);
      if (!got[i] || !Buffer.from(got[i]).equals(want)) return 'drawing ' + (i + 1) + ' differs';
    }
    if (!got[ver.length] || Buffer.from(got[ver.length]).toString() !== vecText) return 'vector drawing differs';
    if (!got[ver.length + 1] || !Buffer.from(got[ver.length + 1]).equals(media)) return 'sound differs';
    return true;
  } catch (e) { return e.message; }
}
const V1 = new Array(DRAWINGS).fill(1);
const V2 = V1.map((v, i) => (i === 3 || i === 17 ? 2 : v));
const V3 = V2.map((v, i) => (i === 0 || i === 17 || i === 29 ? 3 : v));

/* ------------------------------ child mode ------------------------------ */
// node finca-save.cjs --child <file> <fn> <when> <at>
//   Open <file> (which holds V2), save V3 over it, and die inside the
//   <at>-th call of fs.<fn> ("before" it runs or "after"). <at> below 1 is
//   a fraction of all the calls one such save makes (measured on a copy).
if (process.argv[2] === '--child') {
  const [file, fn, when, atArg] = process.argv.slice(3);
  const save = target => { const o = Store.open(target); return Store.write(target, payloadFor(V3, V2, o.id), true); };
  const real = fs[fn];
  let at = Number(atArg);
  if (at < 1) {
    const dry = path.join(fs.mkdtempSync(path.join(path.dirname(file), 'dry-')), path.basename(file));
    fs.copyFileSync(file, dry);
    let total = 0;
    fs[fn] = function () { total++; return real.apply(fs, arguments); };
    save(dry);
    fs[fn] = real;
    fs.rmSync(path.dirname(dry), { recursive: true, force: true });
    at = Math.max(1, Math.min(total, Math.ceil(total * at)));
  }
  let n = 0;
  fs[fn] = function () {
    if (++n === at) {
      if (when === 'before') process.kill(process.pid, 'SIGKILL');
      const r = real.apply(fs, arguments);
      process.kill(process.pid, 'SIGKILL');
      return r;
    }
    return real.apply(fs, arguments);
  };
  save(file);
  process.exit(0);          // reached only if the kill point was never hit
}

/* -------------------------------- checks -------------------------------- */
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok === true) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : (typeof ok === 'string' ? '  -> ' + ok : ''))); }
};
const root = fs.mkdtempSync(path.join(process.env.FINCA_TEST_DIR || os.tmpdir(), 'finca-save-'));
const temps = d => fs.readdirSync(d).filter(n => /\.tmp-/.test(n));
const throws = fn => { try { fn(); return null; } catch (e) { return e; } };
// a folder holding scene.finca = V2 and scene.finca.bak = V1
function fixture(name) {
  const d = path.join(root, name); fs.mkdirSync(d);
  const f = path.join(d, 'scene.finca');
  const a = Store.write(f, payloadFor(V1), true);
  Store.write(f, payloadFor(V2, V1, a.id), true);
  return f;
}
const patch = (fn, repl) => { const real = fs[fn]; fs[fn] = repl(real); return () => { fs[fn] = real; }; };

try {
  /* ---- round trips ---- */
  {
    const d = path.join(root, 'round'); fs.mkdirSync(d);
    const f = path.join(d, 'scene.finca');
    const a = Store.write(f, payloadFor(V1), true);
    check('first save: every drawing, the vector drawing, the sound and the scene come back identical', holds(f, V1));
    check('first save reports what it wrote and makes no backup (nothing to back up)',
      a.written === DRAWINGS + 2 && a.copied === 0 && a.backup === null && !fs.existsSync(f + '.bak'), a);
    const v1bytes = fs.readFileSync(f);
    const b = Store.write(f, payloadFor(V2, V1, a.id), true);
    check('second save: 2 changed drawings written, the rest copied, all of it reads back', b.written === 2 && b.copied === DRAWINGS && holds(f, V2) === true, b);
    check('the previous version is kept, byte for byte, as .bak', b.backup === true && fs.readFileSync(f + '.bak').equals(v1bytes));
    const c = Store.write(f, payloadFor(V3, V2, b.id), true);
    check('third save reads back; .bak is now the second version', holds(f, V3) === true && holds(f + '.bak', V2) === true && c.backup === true);
    const same = Store.write(f, payloadFor(V3, V3, c.id), true);
    check('saving with no changes copies everything and changes nothing', same.written === 0 && holds(f, V3) === true, same);
    const g = path.join(d, 'copy.finca');
    Store.write(g, payloadFor(V3, V3, same.id), true);
    check('Save As to a new file copies every drawing across', holds(g, V3) === true && holds(f, V3) === true);
    check('no temp files are left behind', temps(d).length === 0, temps(d));
    // the same bytes in, the same file out (no timestamps): safe for sync tools and diffing
    const h = path.join(d, 'again.finca');
    Store.write(h, payloadFor(V3, V3, same.id), true);
    check('saving the same scene twice gives byte-identical files', fs.readFileSync(g).equals(fs.readFileSync(h)));
  }

  /* ---- a save that cannot find one of its drawings never touches the disk ---- */
  {
    const f = fixture('missing');
    const before = fs.readFileSync(f);
    const o = Store.open(f);
    const p = payloadFor(V3, V2, o.id);
    p.entries.push({ name: 'drawings/L1/99-x.png', from: { id: o.id, name: 'drawings/L1/99-gone.png' } });
    const e = throws(() => Store.write(f, p, true));
    check('a save that refers to a drawing the file does not have is refused', !!e && /missing/.test(e.message), e && e.message);
    check('... before anything was written: file and backup unchanged, no temp file',
      fs.readFileSync(f).equals(before) && holds(f + '.bak', V1) === true && temps(path.dirname(f)).length === 0);
  }

  /* ---- interrupted saves ---- */
  const kill = (name, fn, when, at, expectNew) => {
    const f = fixture('kill-' + name);
    const before = fs.readFileSync(f);
    const r = spawnSync(process.execPath, [__filename, '--child', f, fn, when, String(at)], { encoding: 'utf8' });
    const died = r.signal === 'SIGKILL';
    const now = fs.readFileSync(f);
    const state = expectNew ? holds(f, V3) : (now.equals(before) ? holds(f, V2) : 'file changed');
    const bak = expectNew ? holds(f + '.bak', V2) : (holds(f + '.bak', V1) === true || holds(f + '.bak', V2) === true ? true : 'backup unreadable');
    check('killed ' + name + ': ' + (expectNew ? 'the new version is complete' : 'the project file is exactly the previous version') + ', backup intact',
      died && state === true && bak === true, { died, signal: r.signal, status: r.status, state, bak, err: (r.stderr || '').slice(-200) });
    return f;
  };
  kill('just as the save starts writing', 'writeSync', 'before', 1, false);
  kill('2% into writing the new file', 'writeSync', 'before', 0.02, false);
  kill('halfway through writing', 'writeSync', 'before', 0.5, false);
  kill('while writing the table of contents', 'writeSync', 'before', 0.98, false);
  kill('with the new file written but not yet flushed', 'fsyncSync', 'before', 1, false);
  kill('after the flush, before the backup', 'linkSync', 'before', 1, false);
  kill('with the new backup half made', 'linkSync', 'after', 1, false);
  kill('just before the backup is swapped in', 'renameSync', 'before', 1, false);
  const mid = kill('between the backup and the final rename', 'renameSync', 'after', 1, false);
  kill('right after the final rename', 'renameSync', 'after', 2, true);
  {
    // carry on after a crash: leftovers do no harm and are cleaned up
    const left = temps(path.dirname(mid));
    const o = Store.open(mid);
    const r = Store.write(mid, payloadFor(V3, V2, o.id), true);
    check('after a crash the next save works and clears the leftover temp file',
      left.length >= 1 && r.ok && holds(mid, V3) === true && temps(path.dirname(mid)).length === 0, { left, now: temps(path.dirname(mid)) });
  }

  /* ---- full disk ---- */
  {
    const f = fixture('full');
    const before = fs.readFileSync(f), bakBefore = fs.readFileSync(f + '.bak');
    const o = Store.open(f);
    for (const limit of [10, 30000, 400000]) {
      let room = limit;
      const undo = patch('writeSync', real => function (fd, buf, off, len, pos) {
        if (Buffer.isBuffer(buf) && typeof pos === 'number') {
          if (room <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
          const n = Math.min(len, room); room -= n;
          return real.call(fs, fd, buf, off, n, pos);
        }
        return real.apply(fs, arguments);
      });
      let e; try { e = throws(() => Store.write(f, payloadFor(V3, V2, o.id), true)); } finally { undo(); }
      check('disk fills up after ' + limit + ' bytes: the save fails and says the disk is full',
        !!e && e.code === 'ENOSPC' && /disk is full/i.test(e.message) && /not changed/.test(e.message), e && e.message);
      check('... project file and backup untouched, no half-written file left',
        fs.readFileSync(f).equals(before) && fs.readFileSync(f + '.bak').equals(bakBefore) && temps(path.dirname(f)).length === 0, temps(path.dirname(f)));
    }
    // the flush to disk can be where a full disk shows up
    let undo = patch('fsyncSync', () => () => { throw Object.assign(new Error('ENOSPC: no space left on device, fsync'), { code: 'ENOSPC' }); });
    let e; try { e = throws(() => Store.write(f, payloadFor(V3, V2, o.id), true)); } finally { undo(); }
    check('disk full at the final flush: same clean failure', !!e && e.code === 'ENOSPC' && fs.readFileSync(f).equals(before) && temps(path.dirname(f)).length === 0, e && e.message);

    // known up front: not even started
    let wrote = 0;
    undo = patch('statfsSync', () => () => ({ bavail: 3, bsize: 4096 }));
    const undo2 = patch('writeSync', real => function () { wrote++; return real.apply(fs, arguments); });
    try { e = throws(() => Store.write(f, payloadFor(V3, V2, o.id), true)); } finally { undo(); undo2(); }
    check('too little free space is noticed before writing anything, with the sizes in the message',
      !!e && e.code === 'ENOSPC' && /Not enough free disk space/.test(e.message) && /MB needed/.test(e.message) && wrote === 0 && fs.readFileSync(f).equals(before), e && e.message);
    const ok = Store.write(f, payloadFor(V3, V2, o.id), true);
    check('once there is room again the same save goes through', ok.ok && holds(f, V3) === true);
  }

  /* ---- backups on drives without hard links (USB sticks: FAT / exFAT) ---- */
  {
    const f = fixture('nolink');
    const o = Store.open(f);
    const v2bytes = fs.readFileSync(f);
    let undo = patch('linkSync', () => () => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); });
    let r; try { r = Store.write(f, payloadFor(V3, V2, o.id), true); } finally { undo(); }
    check('no hard links: the backup is a real copy of the previous version',
      r.backup === true && fs.readFileSync(f + '.bak').equals(v2bytes) && fs.statSync(f + '.bak').ino !== fs.statSync(f).ino && holds(f, V3) === true);
    // ... and no room for that copy: the work is saved anyway, the older backup stays whole
    const V4 = V3.map((v, i) => (i === 5 ? 4 : v));
    undo = patch('linkSync', () => () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
    const undo2 = patch('copyFileSync', () => (src, dst) => {
      fs.writeFileSync(dst, fs.readFileSync(src).subarray(0, 1000));          // a cut-short copy, then "disk full"
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    });
    try { r = Store.write(f, payloadFor(V4, V3, r.id), true); } finally { undo(); undo2(); }
    check('backup cannot be made (disk full): the save still succeeds and says so', r.ok && r.backup === false && holds(f, V4) === true, r);
    check('... and the older backup is still complete, never a cut-short one',
      holds(f + '.bak', V2) === true && temps(path.dirname(f)).length === 0, { bak: holds(f + '.bak', V2), temps: temps(path.dirname(f)) });
  }

  /* ---- Windows: the file is briefly held by antivirus / indexer / sync ---- */
  {
    const f = fixture('busy');
    const o = Store.open(f);
    let busy = 0;
    const undo = patch('renameSync', real => function (from, to) {
      if (to === f && busy < 3) { busy++; throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' }); }
      return real.apply(fs, arguments);
    });
    let r; try { r = Store.write(f, payloadFor(V3, V2, o.id), true); } finally { undo(); }
    check('a busy target file is retried until the rename goes through', busy === 3 && r.ok && holds(f, V3) === true);
    const undo2 = patch('renameSync', real => function (from, to) {
      if (to === f) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return real.apply(fs, arguments);
    });
    let e; try { e = throws(() => Store.write(f, payloadFor(V3, V3, r.id), true)); } finally { undo2(); }
    check('a target that stays locked fails the save, leaving the file readable and no temp file',
      !!e && e.code === 'EBUSY' && holds(f, V3) === true && temps(path.dirname(f)).length === 0, e && e.message);
  }

  /* ---- the file changed on disk behind our back ---- */
  {
    const f = fixture('swapped');
    const o = Store.open(f);
    // another program (sync tool, restore from backup) puts an older version in its place
    const other = path.join(path.dirname(f), 'other.finca');
    Store.write(other, payloadFor(V1), false);
    fs.renameSync(other, f);
    const before = fs.readFileSync(f);
    const e = throws(() => Store.write(f, payloadFor(V3, V2, o.id), true));
    check('file replaced by another program: a save that would lose drawings is refused, nothing is overwritten',
      !!e && /missing from its project file/.test(e.message) && fs.readFileSync(f).equals(before), e && e.message);
  }

  /* ---- damaged files ---- */
  {
    const f = fixture('damaged');
    const whole = fs.readFileSync(f);
    const dir = path.dirname(f);
    // cut short at 60% (interrupted copy / download)
    const cut = path.join(dir, 'cut.finca');
    fs.writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.6)));
    let r = Store.open(cut);
    const names = V2.map((v, i) => pngName(i + 1, v));
    const got = Store.read(r.id, names);
    const good = got.filter((g, i) => g && Buffer.from(g).equals(bytes(20000 + i * 37, (i + 1) * 1000 + V2[i]))).length;
    const lost = got.filter(g => !g).length;
    check('a file cut short at 60% still opens: scene intact, flagged as damaged',
      r.ok && r.scene === sceneFor(V2) && !!r.damaged && r.damaged.missing > 0, r.damaged);
    check('... the drawings before the cut are recovered intact, the rest are reported missing (none are wrong)',
      good > 10 && good + lost === DRAWINGS && r.damaged.missing === lost + 1 /* + the vector drawing */, { good, lost, missing: r.damaged.missing });
    Store.close(r.id);
    // cut inside the scene itself: nothing to recover, but point at the backup
    const stub = path.join(dir, 'stub.finca');
    fs.writeFileSync(stub, whole.subarray(0, 60));
    let e = throws(() => Store.open(stub));
    check('a file with no readable scene is refused', !!e && !/\.bak/.test(e.message), e && e.message);
    fs.writeFileSync(stub + '.bak', whole);
    e = throws(() => Store.open(stub));
    check('... and the message points at the .bak when there is one', !!e && /stub\.finca\.bak/.test(e.message), e && e.message);
    const junk = path.join(dir, 'junk.finca');
    fs.writeFileSync(junk, bytes(5000, 7));
    check('a file that is not a project at all is refused', !!throws(() => Store.open(junk)));
    check('a missing file is refused', !!throws(() => Store.open(path.join(dir, 'nope.finca'))));
    // one flipped bit inside a drawing
    const rot = path.join(dir, 'rot.finca');
    const b = Buffer.from(whole);
    const ents = (() => { const fd = fs.openSync(f, 'r'); try { const m = Z.readDirectory(fd); const en = m.get(pngName(8, 1)); return Z.dataOffset(fd, en); } finally { fs.closeSync(fd); } })();
    b[ents + 500] ^= 0x10;
    fs.writeFileSync(rot, b);
    r = Store.open(rot);
    const two = Store.read(r.id, [pngName(8, 1), pngName(9, 1)]);
    check('a drawing with a flipped bit is reported unreadable instead of being shown wrong; its neighbours are fine',
      !r.damaged && two[0] === null && !!two[1] && Buffer.from(two[1]).equals(bytes(20000 + 8 * 37, 9 * 1000 + 1)));
    Store.close(r.id);
  }

  /* ---- large scenes ---- */
  {
    const d = path.join(root, 'large'); fs.mkdirSync(d);
    const f = path.join(d, 'long.finca');
    const N = 70000;                                      // past the 65,535-entry limit of classic zip
    const cels = {}, entries = [];
    for (let i = 0; i < N; i++) {
      const name = 'drawings/L' + (i % 10) + '/' + i + '-a.png';
      cels[i] = { k: 'r', src: name, w: 1920, h: 1080 };
      entries.push({ name, data: new Uint8Array(bytes(64 + (i % 7), i + 1)) });
    }
    const scene = JSON.stringify({ format: 'finca', version: 3, layers: [{ id: 'L', cels }] });
    let t = Date.now();
    const a = Store.write(f, { scene, entries }, true);
    const tFirst = Date.now() - t;
    // change one drawing, copy the other 69,999
    const next = entries.map((e, i) => (i === 12345 ? { name: e.name.replace('-a', '-b'), data: new Uint8Array(bytes(80, 5)) } : { name: e.name, from: { id: a.id, name: e.name } }));
    t = Date.now();
    const b = Store.write(f, { scene, entries: next }, true);
    const tNext = Date.now() - t;
    const r = Store.open(f);
    const pick = Store.read(r.id, ['drawings/L0/0-a.png', 'drawings/L5/12345-b.png', 'drawings/L9/69999-a.png', 'drawings/L5/12345-a.png']);
    check('70,000 drawings: save, change one, save again, reopen (' + tFirst + ' ms, then ' + tNext + ' ms)',
      a.written === N && b.written === 1 && b.copied === N - 1 && r.scene === scene &&
      Buffer.from(pick[0]).equals(bytes(64, 1)) && Buffer.from(pick[1]).equals(bytes(80, 5)) &&
      Buffer.from(pick[2]).equals(bytes(64 + (69999 % 7), 70000)) && pick[3] === null);
    // the same big file, cut short: the walk-from-the-start reader copes with zip64 too
    const cut = path.join(d, 'cut.finca');
    const whole = fs.readFileSync(f);
    fs.writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.5)));
    const c = Store.open(cut);
    check('a cut-short 70,000-drawing file opens with tens of thousands of drawings recovered',
      !!c.damaged && c.damaged.recovered > 20000 && c.damaged.missing > 0 && c.damaged.recovered + c.damaged.missing >= N, c.damaged);
  }
} catch (e) {
  fail++; console.log('FAIL  test run crashed  -> ' + (e.stack || e));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
