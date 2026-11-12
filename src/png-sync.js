/* =====================================================================
   Finca Animate - synchronous PNG decoder
   Drawings that are not in memory (not loaded from the project file yet,
   or parked as compressed PNG to save memory) are normally decoded in the
   background, off the main thread, before they are needed. This decoder
   is the safety net for code that reads `cel.canvas` right now: it turns
   PNG bytes into pixels without waiting, so a drawing can never be seen
   as blank just because it had not been loaded yet.

   Handles what the app itself writes (canvas.toBlob): 8-bit RGB / RGBA,
   non-interlaced. Anything else throws, and the caller falls back.
   ===================================================================== */
(function (OT) {
  'use strict';

  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  // Lookup table for a canonical Huffman code: index by the next `bits`
  // input bits, get (symbol << 4) | code length.
  function buildTable(lens, n) {
    const count = new Uint16Array(16);
    let max = 0;
    for (let i = 0; i < n; i++) { const l = lens[i]; if (l) { count[l]++; if (l > max) max = l; } }
    if (!max) return { table: new Uint32Array(2), bits: 1 };
    const next = new Uint16Array(16);
    let code = 0;
    for (let l = 1; l <= max; l++) { code = (code + count[l - 1]) << 1; next[l] = code; }
    const size = 1 << max, table = new Uint32Array(size);
    for (let s = 0; s < n; s++) {
      const l = lens[s];
      if (!l) continue;
      let c = next[l]++, r = 0;
      for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }
      const entry = (s << 4) | l, step = 1 << l;
      for (let i = r; i < size; i += step) table[i] = entry;
    }
    return { table, bits: max };
  }

  let FIXED = null;
  function fixedTables() {
    if (FIXED) return FIXED;
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    const d = new Uint8Array(30).fill(5);
    FIXED = { lit: buildTable(l, 288), dist: buildTable(d, 30) };
    return FIXED;
  }

  // Raw DEFLATE -> `out` (a Uint8Array of exactly the expected size).
  function inflateInto(src, pos, out) {
    let bitbuf = 0, bitcnt = 0, op = 0;
    const end = src.length, outLen = out.length;
    const need = n => {
      while (bitcnt < n) {
        if (pos >= end) throw new Error('PNG data ends early');
        bitbuf |= src[pos++] << bitcnt; bitcnt += 8;
      }
    };
    const take = n => {
      if (!n) return 0;
      need(n);
      const v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n; bitcnt -= n;
      return v;
    };
    const sym = t => {
      // top up without demanding bits past the end of the stream
      while (bitcnt < t.bits && pos < end) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
      const e = t.table[bitbuf & ((1 << t.bits) - 1)];
      const l = e & 15;
      if (!l || l > bitcnt) throw new Error('bad PNG data');
      bitbuf >>>= l; bitcnt -= l;
      return e >>> 4;
    };
    for (;;) {
      const last = take(1), type = take(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;                       // skip to the byte boundary
        if (pos + 4 > end) throw new Error('PNG data ends early');
        const len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        if (pos + len > end || op + len > outLen) throw new Error('bad PNG data');
        out.set(src.subarray(pos, pos + len), op);
        pos += len; op += len;
      } else if (type === 1 || type === 2) {
        let lit, dist;
        if (type === 1) { const f = fixedTables(); lit = f.lit; dist = f.dist; }
        else {
          const hlit = take(5) + 257, hdist = take(5) + 1, hclen = take(4) + 4;
          const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = take(3);
          const clt = buildTable(cl, 19);
          const lens = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const s = sym(clt);
            if (s < 16) lens[i++] = s;
            else {
              let rep, val = 0;
              if (s === 16) { if (!i) throw new Error('bad PNG data'); val = lens[i - 1]; rep = 3 + take(2); }
              else if (s === 17) rep = 3 + take(3);
              else rep = 11 + take(7);
              if (i + rep > hlit + hdist) throw new Error('bad PNG data');
              while (rep--) lens[i++] = val;
            }
          }
          lit = buildTable(lens, hlit);
          dist = buildTable(lens.subarray(hlit), hdist);
        }
        for (;;) {
          const s = sym(lit);
          if (s < 256) {
            if (op >= outLen) throw new Error('bad PNG data');
            out[op++] = s;
          } else if (s === 256) break;
          else {
            const li = s - 257;
            if (li >= 29) throw new Error('bad PNG data');
            const len = LEN_BASE[li] + take(LEN_EXTRA[li]);
            const di = sym(dist);
            if (di >= 30) throw new Error('bad PNG data');
            const d = DIST_BASE[di] + take(DIST_EXTRA[di]);
            if (d > op || op + len > outLen) throw new Error('bad PNG data');
            if (d >= len) { out.copyWithin(op, op - d, op - d + len); op += len; }
            else if (d === 1) { out.fill(out[op - 1], op, op + len); op += len; }
            else { for (let k = 0, from = op - d; k < len; k++) out[op++] = out[from + k]; }
          }
        }
      } else throw new Error('bad PNG data');
      if (last) break;
    }
    if (op !== outLen) throw new Error('PNG data is shorter than its size');
    return out;
  }

  // PNG bytes -> { width, height, data: Uint8ClampedArray (RGBA, straight alpha) }
  function decode(bytes) {
    if (!bytes || bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47)
      throw new Error('not a PNG');
    const u32 = o => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    let w = 0, h = 0, ctype = -1;
    const idat = [];
    let total = 0;
    for (let p = 8; p + 12 <= bytes.length;) {
      const len = u32(p);
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      const d = p + 8;
      if (d + len > bytes.length) throw new Error('PNG data ends early');
      if (type === 'IHDR') {
        w = u32(d); h = u32(d + 4); ctype = bytes[d + 9];
        if (bytes[d + 8] !== 8 || (ctype !== 2 && ctype !== 6) || bytes[d + 12] !== 0)
          throw new Error('unsupported PNG type');
      } else if (type === 'IDAT') { idat.push(bytes.subarray(d, d + len)); total += len; }
      else if (type === 'IEND') break;
      p = d + len + 4;
    }
    if (!w || !h || !total) throw new Error('not a PNG');
    let z = idat[0];
    if (idat.length > 1) { z = new Uint8Array(total); let o = 0; for (const c of idat) { z.set(c, o); o += c.length; } }
    const bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
    const raw = inflateInto(z, 2, new Uint8Array(h * (stride + 1)));   // 2 = zlib header
    const out = new Uint8ClampedArray(w * h * 4);
    // undo the per-row filters in place, then copy into RGBA
    for (let y = 0; y < h; y++) {
      const row = y * (stride + 1) + 1, prev = row - (stride + 1), f = raw[row - 1];
      if (f === 1) {
        for (let i = bpp; i < stride; i++) raw[row + i] = (raw[row + i] + raw[row + i - bpp]) & 255;
      } else if (f === 2) {
        if (y) for (let i = 0; i < stride; i++) raw[row + i] = (raw[row + i] + raw[prev + i]) & 255;
      } else if (f === 3) {
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? raw[row + i - bpp] : 0, b = y ? raw[prev + i] : 0;
          raw[row + i] = (raw[row + i] + ((a + b) >> 1)) & 255;
        }
      } else if (f === 4) {
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? raw[row + i - bpp] : 0, b = y ? raw[prev + i] : 0;
          const c = (y && i >= bpp) ? raw[prev + i - bpp] : 0;
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - c - c);
          raw[row + i] = (raw[row + i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
        }
      } else if (f !== 0) throw new Error('bad PNG filter');
      if (bpp === 4) out.set(raw.subarray(row, row + stride), y * stride);
      else {
        for (let x = 0, o = y * w * 4, i = row; x < w; x++, o += 4, i += 3) {
          out[o] = raw[i]; out[o + 1] = raw[i + 1]; out[o + 2] = raw[i + 2]; out[o + 3] = 255;
        }
      }
    }
    return { width: w, height: h, data: out };
  }

  OT.PNGSync = { decode };
})(window.OT);
