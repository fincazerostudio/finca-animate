/* Finca Animate - the .finca container (a plain zip file)
   Just the subset a project file needs, on Node's built-in zlib and fs:
     - read the table of contents and single entries (random access)
     - write a new archive where each entry is either fresh bytes or a raw,
       byte-for-byte copy of an entry from another open archive (so a save
       never decodes or re-compresses a drawing that did not change)
     - ZIP64, so long shots are not capped at 4 GB / 65,535 drawings
   Entries are STORED (PNG is already compressed) or DEFLATED (JSON).
   The first entry is an uncompressed `mimetype` file, as in ODF / EPUB, so
   the file type can be recognised from its first bytes. */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const MIMETYPE = 'application/x-finca-animate';
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50, SIG_LOC64 = 0x07064b50;
const MAX32 = 0xFFFFFFFF, MAX16 = 0xFFFF;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, pos + got);
    if (!n) throw new Error('unexpected end of file');
    got += n;
  }
  return b;
}
function writeAll(fd, buf, pos) {
  let done = 0;
  while (done < buf.length) done += fs.writeSync(fd, buf, done, buf.length - done, pos + done);
}
const big = (b, o) => Number(b.readBigUInt64LE(o));

/* ------------------------------ reading ------------------------------ */

// Read the table of contents. Returns Map name -> entry
// { name, method, crc, csize, usize, offset (of the local header) }.
function readDirectory(fd) {
  const size = fs.fstatSync(fd).size;
  if (size < 22) throw new Error('not a .finca file (too small)');
  const tailLen = Math.min(size, 22 + MAX16);
  const tail = readAt(fd, size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_END && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) { e = i; break; }
  }
  if (e < 0) throw new Error('not a .finca file (no table of contents; the file may be cut short)');
  let count = tail.readUInt16LE(e + 10);
  let cdSize = tail.readUInt32LE(e + 12);
  let cdOffset = tail.readUInt32LE(e + 16);
  const endPos = size - tailLen + e;
  if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    if (endPos < 20) throw new Error('damaged .finca file (zip64 locator missing)');
    const loc = readAt(fd, endPos - 20, 20);
    if (loc.readUInt32LE(0) !== SIG_LOC64) throw new Error('damaged .finca file (zip64 locator missing)');
    const end64 = readAt(fd, big(loc, 8), 56);
    if (end64.readUInt32LE(0) !== SIG_END64) throw new Error('damaged .finca file (zip64 record missing)');
    count = big(end64, 32);
    cdSize = big(end64, 40);
    cdOffset = big(end64, 48);
  }
  if (cdOffset + cdSize > size) throw new Error('damaged .finca file (table of contents out of range)');
  const cd = readAt(fd, cdOffset, cdSize);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('damaged .finca file (bad table of contents)');
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nl);
    // zip64 extended information: only the fields that overflowed, in order
    let x = p + 46 + nl;
    const xEnd = x + xl;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === MAX32) { usize = big(cd, q); q += 8; }
        if (csize === MAX32) { csize = big(cd, q); q += 8; }
        if (offset === MAX32) { offset = big(cd, q); q += 8; }
      }
      x += 4 + len;
    }
    entries.set(name, { name, method, crc, csize, usize, offset });
    p += 46 + nl + xl + cl;
  }
  return entries;
}

// Where an entry's (compressed) bytes start.
function dataOffset(fd, entry) {
  if (entry.data != null) return entry.data;
  const lh = readAt(fd, entry.offset, 30);
  if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error('damaged .finca file (entry "' + entry.name + '")');
  entry.data = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  return entry.data;
}

// The entry's contents as a Buffer, checked against its CRC.
function readEntry(fd, entry) {
  const raw = readAt(fd, dataOffset(fd, entry), entry.csize);
  let out;
  if (entry.method === 0) out = raw;
  else if (entry.method === 8) out = zlib.inflateRawSync(raw);
  else throw new Error('unsupported compression in "' + entry.name + '"');
  if (out.length !== entry.usize || crc32(out) !== entry.crc)
    throw new Error('damaged .finca file (entry "' + entry.name + '" fails its checksum)');
  return out;
}

/* ------------------------------ writing ------------------------------ */

class Writer {
  constructor(fd) {
    this.fd = fd;
    this.pos = 0;
    this.entries = [];          // { name, method, crc, csize, usize, offset, data }
    this.names = new Set();
  }
  _header(name, method, crc, csize, usize) {
    if (this.names.has(name)) throw new Error('duplicate entry "' + name + '"');
    this.names.add(name);
    const nb = Buffer.from(name, 'utf8');
    const z64 = csize >= MAX32 || usize >= MAX32;
    const extra = z64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (z64) {
      extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(usize), 4); extra.writeBigUInt64LE(BigInt(csize), 12);
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(z64 ? 45 : 20, 4);
    h.writeUInt16LE(0x0800, 6);                 // names are UTF-8
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);   // fixed date: 1980-01-01
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(z64 ? MAX32 : csize, 18);
    h.writeUInt32LE(z64 ? MAX32 : usize, 22);
    h.writeUInt16LE(nb.length, 26);
    h.writeUInt16LE(extra.length, 28);
    const offset = this.pos;
    const head = Buffer.concat([h, nb, extra]);
    writeAll(this.fd, head, this.pos);
    this.pos += head.length;
    const e = { name, method, crc, csize, usize, offset, data: this.pos };
    this.entries.push(e);
    return e;
  }
  // Add fresh bytes. deflate: compress (JSON); otherwise stored as-is (PNG).
  add(name, data, deflate) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let body = buf, method = 0;
    if (deflate && buf.length > 64) {
      const d = zlib.deflateRawSync(buf, { level: 6 });
      if (d.length < buf.length) { body = d; method = 8; }
    }
    const e = this._header(name, method, crc32(buf), body.length, buf.length);
    writeAll(this.fd, body, this.pos);
    this.pos += body.length;
    return e;
  }
  // Copy an entry out of another open archive without touching its bytes.
  copy(srcFd, src, name) {
    const from = dataOffset(srcFd, src);
    const e = this._header(name || src.name, src.method, src.crc, src.csize, src.usize);
    const chunk = Buffer.alloc(Math.min(src.csize, 4 << 20) || 1);
    let left = src.csize, at = from;
    while (left > 0) {
      const n = fs.readSync(srcFd, chunk, 0, Math.min(left, chunk.length), at);
      if (!n) throw new Error('unexpected end of file while copying "' + src.name + '"');
      writeAll(this.fd, n === chunk.length ? chunk : chunk.subarray(0, n), this.pos);
      this.pos += n; at += n; left -= n;
    }
    return e;
  }
  // Write the table of contents. Returns Map name -> entry for the new file.
  finish() {
    const parts = [];
    const cdOffset = this.pos;
    for (const e of this.entries) {
      const nb = Buffer.from(e.name, 'utf8');
      const fields = [];
      if (e.usize >= MAX32) fields.push(e.usize);
      if (e.csize >= MAX32) fields.push(e.csize);
      if (e.offset >= MAX32) fields.push(e.offset);
      const extra = Buffer.alloc(fields.length ? 4 + 8 * fields.length : 0);
      if (fields.length) {
        extra.writeUInt16LE(1, 0); extra.writeUInt16LE(8 * fields.length, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(SIG_CENTRAL, 0);
      c.writeUInt16LE(fields.length ? 45 : 20, 4);
      c.writeUInt16LE(fields.length ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(Math.min(e.csize, MAX32), 20);
      c.writeUInt32LE(Math.min(e.usize, MAX32), 24);
      c.writeUInt16LE(nb.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE(Math.min(e.offset, MAX32), 42);
      parts.push(c, nb, extra);
    }
    const cd = Buffer.concat(parts);
    writeAll(this.fd, cd, this.pos);
    this.pos += cd.length;
    const n = this.entries.length;
    if (n >= MAX16 || cd.length >= MAX32 || cdOffset >= MAX32) {
      const r = Buffer.alloc(56 + 20);
      r.writeUInt32LE(SIG_END64, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(n), 24); r.writeBigUInt64LE(BigInt(n), 32);
      r.writeBigUInt64LE(BigInt(cd.length), 40); r.writeBigUInt64LE(BigInt(cdOffset), 48);
      r.writeUInt32LE(SIG_LOC64, 56);
      r.writeBigUInt64LE(BigInt(this.pos), 64);
      r.writeUInt32LE(1, 72);
      writeAll(this.fd, r, this.pos);
      this.pos += r.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(Math.min(n, MAX16), 8); end.writeUInt16LE(Math.min(n, MAX16), 10);
    end.writeUInt32LE(Math.min(cd.length, MAX32), 12);
    end.writeUInt32LE(Math.min(cdOffset, MAX32), 16);
    writeAll(this.fd, end, this.pos);
    this.pos += end.length;
    const map = new Map();
    for (const e of this.entries) map.set(e.name, e);
    return map;
  }
}

// Start an archive: the `mimetype` entry must come first and uncompressed.
function createWriter(fd) {
  const w = new Writer(fd);
  w.add('mimetype', Buffer.from(MIMETYPE, 'latin1'), false);
  return w;
}

module.exports = { MIMETYPE, crc32, readDirectory, readEntry, dataOffset, createWriter, Writer };
