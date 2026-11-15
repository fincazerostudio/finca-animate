/* Storyboard PDF export (Storyboard mode, src/board.js).
 *
 * A small self-contained PDF 1.4 writer: each panel's first frame rendered
 * as JPEG (DCTDecode), the captions as Helvetica text. Layouts as in
 * Storyboard Pro's PDF export: 1, 3 (side by side) or 6 (two rows of
 * three) panels per page, on Letter or A4 landscape.
 */
(function (OT) {
  'use strict';

  const PAPER = { letter: [792, 612], a4: [842, 595] };   // landscape, points
  const LAYOUT = { 1: [1, 1], 3: [1, 3], 6: [3, 2] };      // columns, rows; 3 = rows with captions beside

  // WinAnsi-safe string for a PDF literal (Helvetica's standard encoding).
  function pdfStr(s) {
    let out = '';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      const map = { 0x2018: 39, 0x2019: 39, 0x201c: 34, 0x201d: 34, 0x2013: 45, 0x2014: 45, 0x2026: 46, 0xb7: 0xb7 };
      let code = c < 256 ? c : (map[c] != null ? map[c] : 63);
      if (code < 32) code = 32;
      const t = String.fromCharCode(code);
      out += (t === '(' || t === ')' || t === '\\') ? '\\' + t : t;
    }
    return '(' + out + ')';
  }

  // Text width in points for Helvetica, measured through a canvas.
  const measure = (() => {
    const cx = document.createElement('canvas').getContext('2d');
    return (text, size, bold) => {
      cx.font = (bold ? 'bold ' : '') + '100px Helvetica, Arial, sans-serif';
      return cx.measureText(text).width * size / 100;
    };
  })();
  function wrap(text, size, width, maxLines) {
    const lines = [];
    for (const para of String(text || '').split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + ' ' + word : word;
        if (measure(test, size) <= width || !line) line = test;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    if (maxLines && lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.?.?.?$/, '...');
    }
    return lines;
  }

  async function jpeg(app, frame, w, h) {
    const cv = OT.IO.renderFrame(app, frame, w, h);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
    return new Uint8Array(await blob.arrayBuffer());
  }

  class Writer {
    constructor() { this.parts = []; this.len = 0; this.offsets = []; }
    add(x) {
      const b = typeof x === 'string' ? latin1(x) : x;
      this.parts.push(b); this.len += b.length;
    }
    obj(n, body) { this.offsets[n] = this.len; this.add(n + ' 0 obj\n'); body(); this.add('\nendobj\n'); }
    blob() { return new Blob(this.parts, { type: 'application/pdf' }); }
  }
  function latin1(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    return b;
  }

  // opts: { perPage: 1|3|6, paper: 'letter'|'a4', captions: bool, onProgress(f) }
  async function build(app, opts) {
    opts = opts || {};
    const B = OT.Board, b = app.project.board;
    if (!b) throw new Error('not a storyboard');
    const [PW, PH] = PAPER[opts.paper] || PAPER.letter;
    const [cols, rows] = LAYOUT[opts.perPage] || LAYOUT[3];
    const per = cols * rows;
    const captions = opts.captions !== false;
    const p = app.project, fps = p.fps || 24;
    const labels = B.labels(b), spans = B.spans(b);
    const M = 36, HEAD = 26, GAP = 14;
    const cellW = (PW - 2 * M - GAP * (cols - 1)) / cols;
    const cellH = (PH - 2 * M - HEAD - GAP * (rows - 1)) / rows;
    // one column of several rows: captions beside the panel, as on a paper sheet
    const side = cols === 1 && rows > 1;
    const capH = captions && !side ? Math.min(cellH * 0.42, rows === 1 ? 120 : 150) : 0;
    const imgW = side ? Math.min(cellW * 0.55, (cellH - 16) * p.width / p.height)
      : Math.min(cellW, (cellH - 16 - capH) * p.width / p.height);
    const imgH = imgW * p.height / p.width;
    const px = Math.round(Math.min(1600, imgW * 3));
    const pxH = Math.round(px * p.height / p.width);

    // object numbers: 1 catalog, 2 pages, 3 font, 4 bold font, then per page
    // [page, contents] and per panel one image
    const pages = Math.ceil(spans.length / per);
    let next = 5;
    const pageObjs = [], imgObjs = [];
    for (let i = 0; i < pages; i++) pageObjs.push([next++, next++]);
    for (let i = 0; i < spans.length; i++) imgObjs.push(next++);

    const w = new Writer();
    w.add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    w.obj(1, () => w.add('<< /Type /Catalog /Pages 2 0 R >>'));
    w.obj(2, () => w.add('<< /Type /Pages /Count ' + pages + ' /Kids [' + pageObjs.map(o => o[0] + ' 0 R').join(' ') + '] >>'));
    w.obj(3, () => w.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
    w.obj(4, () => w.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));

    const text = (x, y, size, s, bold) => 'BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Td ' + pdfStr(s) + ' Tj ET\n';
    for (let pg = 0; pg < pages; pg++) {
      let c = '0.1 0.1 0.1 rg 0.1 0.1 0.1 RG\n';
      c += text(M, PH - M - 12, 13, p.name || 'Storyboard', true);
      const pageLabel = 'Page ' + (pg + 1) + ' of ' + pages;
      c += text(PW - M - measure(pageLabel, 9), PH - M - 12, 9, pageLabel);
      const xobjs = [];
      for (let k = 0; k < per; k++) {
        const i = pg * per + k;
        if (i >= spans.length) break;
        const s = spans[i], L = labels.get(s.panel.id);
        const col = k % cols, row = Math.floor(k / cols);
        const x = M + col * (cellW + GAP);
        const top = PH - M - HEAD - row * (cellH + GAP);
        // header line: scene / panel / duration
        c += text(x, top - 10, 9, 'Scene ' + L.scene + '   Panel ' + L.panel, true);
        const dur = (s.panel.duration / fps).toFixed(1) + 's' + (s.panel.transition !== 'cut' ? '  ' + s.panel.transition : '');
        c += text(x + imgW - measure(dur, 8), top - 10, 8, dur);
        const iy = top - 14 - imgH;
        c += 'q ' + imgW.toFixed(2) + ' 0 0 ' + imgH.toFixed(2) + ' ' + x.toFixed(2) + ' ' + iy.toFixed(2) + ' cm /Im' + i + ' Do Q\n';
        c += '0.5 w ' + x.toFixed(2) + ' ' + iy.toFixed(2) + ' ' + imgW.toFixed(2) + ' ' + imgH.toFixed(2) + ' re S\n';
        xobjs.push('/Im' + i + ' ' + imgObjs[i] + ' 0 R');
        if (captions) {
          const size = cols * rows === 1 || side ? 10 : 8, lh = size * 1.25;
          let y = side ? top - 26 : iy - 12;
          const bottom = side ? iy : iy - capH;
          const tx = side ? x + imgW + 18 : x, tw = side ? cellW - imgW - 18 : imgW;
          for (const [label, field] of [['Dialogue', 'dialogue'], ['Action', 'action'], ['Notes', 'notes']]) {
            const v = s.panel[field];
            if (!v || y < bottom) continue;
            c += text(tx, y, size - 1, label.toUpperCase(), true);
            y -= lh;
            const room = Math.max(1, Math.floor((y - bottom) / lh));
            for (const ln of wrap(v, size, tw, Math.min(room, side ? 8 : 6))) { c += text(tx, y, size, ln); y -= lh; }
            y -= 3;
          }
        }
      }
      const [pageN, contN] = pageObjs[pg];
      w.obj(pageN, () => w.add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] ' +
        '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ' + xobjs.join(' ') + ' >> >> /Contents ' + contN + ' 0 R >>'));
      const bytes = latin1(c);
      w.obj(contN, () => { w.add('<< /Length ' + bytes.length + ' >>\nstream\n'); w.add(bytes); w.add('\nendstream'); });
    }
    for (let i = 0; i < spans.length; i++) {
      if (opts.onProgress) opts.onProgress(i / spans.length);
      if (OT.IO.loadFrame) await OT.IO.loadFrame(app, spans[i].start);
      const data = await jpeg(app, spans[i].start, px, pxH);
      w.obj(imgObjs[i], () => {
        w.add('<< /Type /XObject /Subtype /Image /Width ' + px + ' /Height ' + pxH +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + data.length + ' >>\nstream\n');
        w.add(data); w.add('\nendstream');
      });
    }
    const xref = w.len, count = next;
    let x = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
    for (let n = 1; n < count; n++) x += String(w.offsets[n]).padStart(10, '0') + ' 00000 n \n';
    w.add(x + 'trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    if (opts.onProgress) opts.onProgress(1);
    return w.blob();
  }

  // File > Export Storyboard PDF: layout, paper and captions, then save.
  function dialog(app) {
    const U = OT.util, el = U.el;
    if (!app.project.board) { app.ui.status('Not a storyboard'); return; }
    const per = el('select', {}, [el('option', { value: '3' }, ['3 panels per page']), el('option', { value: '6' }, ['6 panels per page']), el('option', { value: '1' }, ['1 panel per page'])]);
    const paper = el('select', {}, [el('option', { value: 'letter' }, ['Letter (landscape)']), el('option', { value: 'a4' }, ['A4 (landscape)'])]);
    const cap = el('input', { type: 'checkbox', checked: 'checked' });
    const body = el('div', { class: 'bp-export' }, [
      el('label', {}, ['Layout ', per]), el('br'),
      el('label', {}, ['Paper ', paper]), el('br'),
      el('label', {}, [cap, ' Dialogue, action and notes under each panel'])
    ]);
    app.ui.modal('Export Storyboard PDF', body, [
      { label: 'Cancel' },
      { label: 'Export', primary: true, fn: () => {
        app.ui.status('Exporting storyboard PDF…');
        build(app, { perPage: +per.value, paper: paper.value, captions: cap.checked }).then(blob => {
          U.download((app.project.name || 'storyboard').replace(/[^\w.-]+/g, '_') + '_storyboard.pdf', blob);
          app.ui.status('Storyboard PDF exported');
        }).catch(e => app.ui.status('PDF export failed: ' + (e && e.message ? e.message : e)));
      } }
    ]);
  }

  OT.BoardPDF = { build, dialog, wrap };
})(window.OT = window.OT || {});
