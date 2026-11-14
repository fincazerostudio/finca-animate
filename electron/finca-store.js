/* Finca Animate - opening and saving .finca files (main process side)
   Plain Node (no Electron), so the whole save path can be unit-tested:
   tests/finca-save.cjs.

   Saving rules, in the order they protect the artist's file:
     1. Nothing is written until every drawing the save needs has been
        found and there is room on the disk for it.
     2. The new file is built under a temp name in the same folder, flushed
        to disk and read back before it replaces anything.
     3. The previous version becomes <name>.bak. The old .bak is only
        replaced once the new one is complete; if a backup cannot be made
        (no room, no permission) the save still goes through and the older
        .bak stays.
     4. One rename puts the new file in place. A crash or power cut at any
        point leaves the old file or the new one, never a mix. */
'use strict';
const fs = require('fs');
const path = require('path');
const FincaZip = require('./finca-zip.js');

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ }
}
// Windows: the indexer, antivirus or a sync client may hold the target for
// a moment, which fails the rename with EPERM / EBUSY. Retry briefly.
function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (attempt >= 6 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code || '')) throw e;
      sleepSync(40 << attempt);
    }
  }
}
// Make a rename survive a power cut (the folder entry is data too).
function syncDir(dir) {
  if (process.platform === 'win32') return;
  try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (e) { /* best effort */ }
}

// Put the finished temp file in place. Returns true / false for "a backup
// of the previous version was made", null when none was asked for or needed.
function replaceAtomic(tmp, file, keepBak) {
  let backup = null;
  try {
    if (keepBak && fs.existsSync(file)) {
      const bak = file + '.bak', bakTmp = tmp + '.bak';
      backup = false;
      try {
        // a hard link costs no space; file systems without them (FAT, exFAT,
        // some network shares) get a real copy. Either way the old .bak is
        // only replaced by a complete new one.
        fs.rmSync(bakTmp, { force: true });
        try { fs.linkSync(file, bakTmp); } catch (e) { fs.copyFileSync(file, bakTmp); }
        renameRetry(bakTmp, bak);
        backup = true;
      } catch (e) {
        try { fs.rmSync(bakTmp, { force: true }); } catch (_) { /* ignore */ }
      }
    }
    renameRetry(tmp, file);
    syncDir(path.dirname(file));
  } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } throw e; }
  return backup;
}

const ENTRY_NAME = /^(scene\.json|thumbnail\.png|(drawings|media)(\/[A-Za-z0-9_][A-Za-z0-9_.\-]*)+)$/;
const validEntry = n => typeof n === 'string' && n.length < 300 && ENTRY_NAME.test(n) && !/\.\./.test(n);

const mb = n => (n < 10 * 1048576 ? (n / 1048576).toFixed(1) : Math.round(n / 1048576)) + ' MB';
const diskFull = () => Object.assign(
  new Error('The disk is full, so the save could not finish. The project file on disk was not changed. Free some space and save again.'),
  { code: 'ENOSPC' });

/* ---- open .finca files (handles) ---- */
const handles = new Map();     // id -> { id, path, entries, size, mtimeMs, damaged }
let seq = 0;
function stat(fd) { const s = fs.fstatSync(fd); return { size: s.size, mtimeMs: s.mtimeMs }; }
function handleFor(file) {
  const full = path.resolve(file);
  for (const h of handles.values()) if (h.path === full) return h;
  const h = { id: ++seq, path: full, entries: null, size: -1, mtimeMs: -1, damaged: null };
  handles.set(h.id, h);
  return h;
}
// (Re)read a handle's table of contents if the file changed on disk since
// we last looked (replaced by another program, restored from a backup...).
function refresh(h, fd) {
  const st = stat(fd);
  if (h.entries && st.size === h.size && st.mtimeMs === h.mtimeMs) return;
  try { h.entries = FincaZip.readDirectory(fd); h.damaged = null; }
  catch (e) {
    if (!h.damaged) throw e;
    h.entries = FincaZip.salvageDirectory(fd);        // still the damaged file we opened
  }
  h.size = st.size; h.mtimeMs = st.mtimeMs;
}
function withFinca(h, fn) {
  const fd = fs.openSync(h.path, 'r');
  try { refresh(h, fd); return fn(fd, h.entries); }
  finally { fs.closeSync(fd); }
}

// Drawings the scene refers to that are not in the file.
function missingDrawings(sceneText, entries) {
  const lost = [];
  try {
    for (const l of JSON.parse(sceneText).layers || [])
      for (const k in l.cels || {}) { const c = l.cels[k]; if (c && c.src && !entries.has(c.src)) lost.push(c.src); }
  } catch (e) { /* not our business here */ }
  return lost;
}

function open(file) {
  const h = handleFor(file);
  h.entries = null; h.damaged = null;                 // always a fresh look on open
  const readScene = (fd, entries) => {
    const e = entries.get('scene.json');
    if (!e) throw new Error('not a Finca Animate project (no scene inside)');
    return FincaZip.readEntry(fd, e).toString('utf8');
  };
  let scene;
  try { scene = withFinca(h, readScene); }
  catch (err) {
    // The table of contents sits at the end of the file, so a file that was
    // cut short (interrupted copy or download, failing disk) has none. The
    // entries themselves may still be there: walk them from the start.
    let fd = null;
    try {
      fd = fs.openSync(h.path, 'r');
      const entries = FincaZip.salvageDirectory(fd);
      scene = readScene(fd, entries);
      const st = stat(fd);
      h.entries = entries; h.size = st.size; h.mtimeMs = st.mtimeMs;
      const lost = missingDrawings(scene, entries);
      h.damaged = { reason: err.message, recovered: entries.size, missing: lost.length, lost };
    } catch (_) {
      handles.delete(h.id);
      const bak = h.path + '.bak';
      if (err.code !== 'ENOENT' && fs.existsSync(bak))
        err.message += '. The previous version is next to it as "' + path.basename(bak) +
          '": copy it, remove ".bak" from the copy\'s name and open that';
      throw err;
    } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
  const r = { ok: true, id: h.id, scene, time: h.mtimeMs };
  if (h.damaged) r.damaged = h.damaged;
  return r;
}

function read(id, names) {
  const h = handles.get(id);
  if (!h || !Array.isArray(names)) return [];
  return withFinca(h, (fd, entries) => names.map(n => {
    const e = validEntry(n) ? entries.get(n) : null;
    if (!e) return null;
    try { const b = FincaZip.readEntry(fd, e); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    catch (err) { console.error('finca: ' + err.message); return null; }
  }));
}

function close(id) { handles.delete(id); return true; }

// Write a whole .finca: scene + entries. An entry is fresh bytes (`data`),
// fresh text (`text`), or `from: { id, name }` = copied untouched out of an
// open project (usually the previous version of this same file).
function write(file, payload, keepBak) {
  if (!payload || typeof payload.scene !== 'string' || !Array.isArray(payload.entries))
    throw new Error('bad project data');
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid);
  const sources = new Map();          // handle id -> { fd, entries }
  const source = id => {
    if (sources.has(id)) return sources.get(id);
    const h = handles.get(id);
    if (!h) throw new Error('a drawing refers to a project that is no longer open');
    const fd = fs.openSync(h.path, 'r');
    const s = { fd, entries: null };
    sources.set(id, s);                 // registered first, so it is closed whatever happens
    refresh(h, fd);
    s.entries = h.entries;
    return s;
  };
  const closeSources = () => { for (const s of sources.values()) try { fs.closeSync(s.fd); } catch (e) { /* ignore */ } };

  let written = 0, copied = 0, entries, backup;
  try {
    /* 1. plan: find every piece before touching the disk */
    const plan = [];
    let need = 4096;                    // a floor, never an over-estimate: text is compressed
    for (const e of payload.entries) {
      if (!e || !validEntry(e.name) || e.name === 'scene.json') throw new Error('bad entry name ' + JSON.stringify(e && e.name));
      if (e.from) {
        let s = null;
        try { s = source(e.from.id); } catch (err) { if (!e.optional) throw err; }
        const src = s && validEntry(e.from.name) ? s.entries.get(e.from.name) : null;
        if (!src) {
          if (e.optional) continue;
          throw new Error('drawing "' + e.from.name + '" is missing from its project file');
        }
        plan.push({ name: e.name, fd: s.fd, src });
        need += src.csize + 100;
      } else if (typeof e.text === 'string') {
        plan.push({ name: e.name, buf: Buffer.from(e.text, 'utf8'), deflate: true });
      } else if (e.data && e.data.byteLength != null) {
        const d = e.data, deflate = /\.json$/.test(e.name);
        plan.push({ name: e.name, buf: Buffer.from(d.buffer || d, d.byteOffset || 0, d.byteLength), deflate });
        if (!deflate) need += d.byteLength + 100;
      } else throw new Error('entry "' + e.name + '" has no content');
    }

    /* 2. is there room? (the old file stays until the new one is complete,
          so a save needs space for a whole second copy) */
    let free = null;
    try { const s = fs.statfsSync(dir); free = Number(s.bavail) * Number(s.bsize); } catch (e) { /* unknown: just try */ }
    if (free != null && free < need)
      throw Object.assign(new Error('Not enough free disk space to save: about ' + mb(need) + ' needed, ' + mb(free) +
        ' free. The project file on disk was not changed. Free some space and save again.'), { code: 'ENOSPC' });

    /* 3. build the new file next to the old one */
    const out = fs.openSync(tmp, 'w+');
    try {
      try {
        const w = FincaZip.createWriter(out);
        w.add('scene.json', Buffer.from(payload.scene, 'utf8'), true);
        for (const p of plan) {
          if (p.src) { w.copy(p.fd, p.src, p.name); copied++; }
          else { w.add(p.name, p.buf, p.deflate); written++; }
        }
        entries = w.finish();
        fs.fsyncSync(out);
        /* 4. read it back before it is allowed to replace anything */
        const check = FincaZip.readDirectory(out);
        if (check.size !== entries.size || FincaZip.readEntry(out, check.get('scene.json')).toString('utf8') !== payload.scene)
          throw new Error('the new file did not read back correctly; the previous version was kept');
      } finally { fs.closeSync(out); }
      // test hook: die between "new file complete" and "new file in place"
      if (process.env.OPENTOON_TEST_CRASH === 'before-rename') process.kill(process.pid, 'SIGKILL');
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      throw (e && e.code === 'ENOSPC') ? diskFull() : e;
    }
  } finally { closeSources(); }

  /* 5. backup, then the one rename that commits the save */
  backup = replaceAtomic(tmp, file, keepBak);
  // temp files left behind by a run that crashed mid-save are of no use now
  try {
    const stale = '.' + path.basename(file) + '.tmp-';
    for (const n of fs.readdirSync(dir)) if (n.startsWith(stale)) fs.rmSync(path.join(dir, n), { force: true });
  } catch (e) { /* ignore */ }
  const h = handleFor(file);
  const st = fs.statSync(file);
  h.entries = entries; h.size = st.size; h.mtimeMs = st.mtimeMs; h.damaged = null;
  return { ok: true, id: h.id, written, copied, bytes: st.size, backup };
}

module.exports = { open, read, write, close, validEntry, replaceAtomic, handles };
