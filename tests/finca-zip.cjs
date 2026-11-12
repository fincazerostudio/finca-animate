// Unit test for the .finca zip container (electron/finca-zip.js). Plain Node:
// no browser, no Electron. Cross-checks our files with the system `unzip`
// when it is installed.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const Z = require('../electron/finca-zip.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finca-zip-'));
const rnd = n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 131 + (i >> 3)) & 255; return b; };

try {
  const a = path.join(dir, 'a.finca');
  const png = rnd(70000), json = Buffer.from(JSON.stringify({ strokes: new Array(400).fill({ x: 1, y: 2, pts: [1, 2, 3] }) }));
  let fd = fs.openSync(a, 'w');
  let w = Z.createWriter(fd);
  w.add('scene.json', Buffer.from('{"format":"finca"}'), true);
  w.add('drawings/L1/1-aa.png', png, false);
  w.add('drawings/L1/2-bb.json', json, true);
  w.add('drawings/L1/ünï-3.png', rnd(10), false);
  w.finish();
  fs.closeSync(fd);

  const head = fs.readFileSync(a).subarray(0, 38 + Z.MIMETYPE.length);
  check('mimetype is first, stored, at the ODF offsets',
    head.toString('latin1', 30, 38) === 'mimetype' && head.toString('latin1', 38) === Z.MIMETYPE);

  fd = fs.openSync(a, 'r');
  const dirA = Z.readDirectory(fd);
  check('directory lists every entry', dirA.size === 5 && dirA.has('drawings/L1/ünï-3.png'), [...dirA.keys()].join());
  check('stored entry reads back', Z.readEntry(fd, dirA.get('drawings/L1/1-aa.png')).equals(png));
  check('deflated entry reads back and is smaller',
    Z.readEntry(fd, dirA.get('drawings/L1/2-bb.json')).equals(json) && dirA.get('drawings/L1/2-bb.json').csize < json.length);

  // incremental rewrite: copy two entries raw, replace one, drop one
  const b = path.join(dir, 'b.finca');
  const fd2 = fs.openSync(b, 'w');
  w = Z.createWriter(fd2);
  w.add('scene.json', Buffer.from('{"format":"finca","n":2}'), true);
  w.copy(fd, dirA.get('drawings/L1/1-aa.png'));
  w.copy(fd, dirA.get('drawings/L1/2-bb.json'));
  const mapB = w.finish();
  fs.closeSync(fd2);
  const fdb = fs.openSync(b, 'r');
  const dirB = Z.readDirectory(fdb);
  check('raw copy keeps bytes, crc and compression',
    Z.readEntry(fdb, dirB.get('drawings/L1/1-aa.png')).equals(png) &&
    Z.readEntry(fdb, dirB.get('drawings/L1/2-bb.json')).equals(json) &&
    dirB.get('drawings/L1/2-bb.json').csize === dirA.get('drawings/L1/2-bb.json').csize && dirB.size === 4);
  check('the writer\'s own table matches what is read back',
    [...mapB.values()].every(e => { const r = dirB.get(e.name); return r && r.offset === e.offset && r.crc === e.crc && r.csize === e.csize; }));
  fs.closeSync(fdb);

  // damage: flipped byte inside an entry, and a truncated file
  const bad = path.join(dir, 'bad.finca');
  const bytes = Buffer.from(fs.readFileSync(a));
  bytes[Z.dataOffset(fd, dirA.get('drawings/L1/1-aa.png')) + 100] ^= 0xff;
  fs.writeFileSync(bad, bytes);
  const fdBad = fs.openSync(bad, 'r');
  let threw = false;
  try { Z.readEntry(fdBad, Z.readDirectory(fdBad).get('drawings/L1/1-aa.png')); } catch (e) { threw = /checksum/.test(e.message); }
  fs.closeSync(fdBad);
  check('a damaged entry is refused (checksum)', threw);
  fs.writeFileSync(bad, fs.readFileSync(a).subarray(0, 60000));
  const fdT = fs.openSync(bad, 'r');
  threw = false;
  try { Z.readDirectory(fdT); } catch (e) { threw = true; }
  fs.closeSync(fdT);
  check('a truncated file is refused', threw);
  fs.closeSync(fd);

  // zip64: more than 65,535 entries
  const many = path.join(dir, 'many.finca');
  fd = fs.openSync(many, 'w');
  w = Z.createWriter(fd);
  const N = 70000, tiny = Buffer.from('x');
  for (let i = 0; i < N; i++) w.add('drawings/L/' + i + '.png', tiny, false);
  w.finish();
  fs.closeSync(fd);
  fd = fs.openSync(many, 'r');
  const dirM = Z.readDirectory(fd);
  check('zip64: 70,000 entries round-trip', dirM.size === N + 1 && Z.readEntry(fd, dirM.get('drawings/L/69999.png')).equals(tiny), 'size ' + dirM.size);
  fs.closeSync(fd);

  // zip64: an entry that starts beyond 4 GB (sparse file, so no real disk use)
  const far = path.join(dir, 'far.finca');
  fd = fs.openSync(far, 'w');
  w = Z.createWriter(fd);
  w.pos = 0x100000000 + 4096;              // pretend 4 GB of drawings came first
  w.add('drawings/L/far.png', png, false);
  w.finish();
  fs.closeSync(fd);
  fd = fs.openSync(far, 'r');
  const dirF = Z.readDirectory(fd);
  check('zip64: entry past the 4 GB mark round-trips',
    dirF.get('drawings/L/far.png').offset > 0xFFFFFFFF && Z.readEntry(fd, dirF.get('drawings/L/far.png')).equals(png));
  fs.closeSync(fd);

  // other tools agree it is a valid zip
  let unzip = false;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); unzip = true; } catch (e) { /* not installed */ }
  if (unzip) {
    let ok = true, out = '';
    try { out = execFileSync('unzip', ['-t', a]).toString(); } catch (e) { ok = false; out = String(e.stdout || e.message); }
    check('system unzip accepts the file', ok && /No errors detected/.test(out), out.slice(-200));
    try { out = execFileSync('unzip', ['-t', many], { maxBuffer: 1 << 26 }).toString(); ok = /No errors detected/.test(out); } catch (e) { ok = false; }
    check('system unzip accepts the zip64 file', ok);
  } else console.log('SKIP  system unzip not installed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
