/* Finca Animate / OpenToon Studio - project save/load + export */
(function (OT) {
  'use strict';
  const U = OT.util;

  const wait = ms => new Promise(r => setTimeout(r, ms || 0));

  /* ---------------- CRC32 + store-only ZIP ---------------- */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  class Zip {
    constructor() { this.files = []; }
    add(name, data) { this.files.push({ name, data }); }
    build() {
      const enc = new TextEncoder();
      const u16 = v => [v & 255, (v >> 8) & 255];
      const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
      const chunks = [], central = [];
      let offset = 0;
      for (const f of this.files) {
        const nb = enc.encode(f.name);
        const crc = crc32(f.data), size = f.data.length;
        const lh = new Uint8Array([].concat(
          u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
          u32(crc), u32(size), u32(size), u16(nb.length), u16(0)));
        chunks.push(lh, nb, f.data);
        central.push(new Uint8Array([].concat(
          u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
          u32(crc), u32(size), u32(size),
          u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), nb);
        offset += lh.length + nb.length + size;
      }
      let cdSize = 0;
      for (const c of central) cdSize += c.length;
      const end = new Uint8Array([].concat(
        u32(0x06054b50), u16(0), u16(0),
        u16(this.files.length), u16(this.files.length),
        u32(cdSize), u32(offset), u16(0)));
      return new Blob(chunks.concat(central, [end]), { type: 'application/zip' });
    }
  }

  /* ---------------- helpers ---------------- */
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('image load failed'));
      img.src = src;
    });
  }
  function dataURLtoBytes(dataURL) {
    const b = atob(dataURL.split(',')[1]);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function canvasToBlob(cv, type, q) {
    if ((!type || type === 'image/png') && OT.encodePNG) return OT.encodePNG(cv);
    return new Promise(res => cv.toBlob(res, type || 'image/png', q));
  }

  /* ---------------- serialize / deserialize ---------------- */
  // Captured per-project so reopening drops the artist back where they
  // left off: stage view (zoom/pan/rotation), timeline zoom, the current
  // frame + active layer, and a snapshot of the tool settings. Stored
  // under `workspace` so we can extend later without breaking the format.
  function captureWorkspace(app) {
    const stage = app.stage || {};
    const tl = app.timeline || {};
    const settings = app.settings ? JSON.parse(JSON.stringify(app.settings)) : null;
    const active = app.activeLayer && app.activeLayer();
    // Pen window state: open flag + last known bounds (kept across
    // close→reopen by pencast). Reopening a project also reopens the
    // pen window at the saved position if it was open at save time.
    const pen = app.penCast && app.penCast.workspaceState
      ? app.penCast.workspaceState() : null;
    return {
      stage: stage.view ? {
        zoom: stage.view.zoom, x: stage.view.x, y: stage.view.y, rot: stage.view.rot,
        flipH: !!stage.flipH, flipV: !!stage.flipV
      } : null,
      timeline: { cellW: tl.cellW || null, namesWidth: tl.namesWidth || null },
      frame: app.frame | 0,
      activeLayerId: active ? active.id : null,
      tool: app.tools && app.tools.active ? app.tools.active.name : null,
      color: app.color || null,
      onion: app.onion ? JSON.parse(JSON.stringify(app.onion)) : null,
      settings,
      penWindow: pen
    };
  }

  // Bump whenever saved data gains something an older build would drop on
  // save. 2: pivots, easing + curves, Line/Colour Art, swatch links,
  // perspective guides. Files newer than this build open with a warning and
  // are never overwritten silently (see App.saveProject).
  const FORMAT_VERSION = 2;
  function serialize(app) {
    const p = app.project;
    return {
      format: 'otoon', version: FORMAT_VERSION,
      name: p.name, width: p.width, height: p.height,
      fps: p.fps, frameCount: p.frameCount, bg: p.bg,
      palette: app.palette.serialize(),
      camera: { keyframes: p.camera.keyframes.map(k => ({ ...k })) },
      audio: p.audio || null,
      perspective: p.perspective,
      workspace: captureWorkspace(app),
      layers: p.layers.map(l => {
        const cels = {};
        for (const num in l.cels) {
          const c = l.cels[num];
          cels[num] = (c.kind === 'vector')
            ? { k: 'v', strokes: c.strokes, eraserMarks: c.eraserMarks || [] }
            : { k: 'r', png: c.toDataURL() };
        }
        return {
          id: l.id, name: l.name, type: l.type,
          visible: l.visible, locked: l.locked, opacity: l.opacity, color: l.color,
          exposure: l.exposure.slice(), nextNum: l.nextNum,
          transform: JSON.parse(JSON.stringify(l.transform || { keyframes: [] })),
          pivot: l.pivot || null,
          video: l.video || null,
          parentId: l.parentId || null,
          collapsed: !!l._collapsed,
          cels: cels
        };
      })
    };
  }

  async function deserialize(data) {
    const p = new OT.Project({
      name: data.name, width: data.width, height: data.height,
      fps: data.fps, frameCount: data.frameCount, bg: data.bg, empty: true
    });
    p.camera = data.camera || { keyframes: [] };
    p.audio = data.audio || null;
    if (data.perspective && data.perspective.vp1) p.perspective = Object.assign(OT.Project.defaultPerspective(), data.perspective);
    for (const ld of data.layers || []) {
      const layer = new OT.Layer(ld.name, ld.type);
      layer.id = ld.id || layer.id;
      layer.visible = ld.visible !== false;
      layer.locked = !!ld.locked;
      layer.opacity = ld.opacity == null ? 1 : ld.opacity;
      layer.color = ld.color || '#3d9be0';
      layer.exposure = (ld.exposure || []).slice();
      layer.nextNum = ld.nextNum || 1;
      layer.transform = ld.transform && ld.transform.keyframes ? ld.transform : { keyframes: [] };
      layer.pivot = ld.pivot && isFinite(ld.pivot.x) && isFinite(ld.pivot.y) ? { x: +ld.pivot.x, y: +ld.pivot.y } : null;
      if (ld.video) layer.video = ld.video;
      layer.parentId = ld.parentId || null;
      layer._collapsed = !!ld.collapsed;
      const isVec = ld.type === 'vector';
      for (const num in (ld.cels || {})) {
        const cd = ld.cels[num];
        const cel = new OT.Cel(Number(num), p.width, p.height, isVec ? 'vector' : 'raster');
        try {
          if (typeof cd === 'string') {
            const img = await loadImage(cd);          // legacy raster format
            cel.ctx.drawImage(img, 0, 0);
          } else if (cd.k === 'v') {
            cel.strokes = cd.strokes || [];
            cel.eraserMarks = Array.isArray(cd.eraserMarks) ? cd.eraserMarks : [];
            // older saves: marks cut what was drawn then, not what comes next
            if (OT.Vector) OT.Vector.upgradeMarks(cel);
            cel.rebuild();
          } else {
            const img = await loadImage(cd.png);
            if (img.width !== cel.w || img.height !== cel.h) {
              cel.w = img.width; cel.h = img.height;
              cel.canvas.width = img.width; cel.canvas.height = img.height;
            }
            cel.ctx.drawImage(img, 0, 0);
          }
        } catch (e) { /* skip broken cel */ }
        cel.dirty();
        layer.cels[num] = cel;
      }
      p.layers.push(layer);
    }
    if (!p.layers.length) p.layers.push(new OT.Layer('Drawing 1'));
    return { project: p, palette: data.palette, workspace: data.workspace || null,
             version: data.version || 1, newer: (data.version || 1) > FORMAT_VERSION };
  }

  /* ---------------- frame rendering (camera-aware) ---------------- */
  // transparent: leave the background colour out (exports with alpha)
  function renderFrame(app, frame, outW, outH, transparent) {
    const p = app.project;
    const cam = p.cameraAt(frame);
    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = outH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!transparent) {
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, outW, outH);
    }
    const cx = p.width / 2 + cam.x, cy = p.height / 2 + cam.y;
    const viewW = p.width / cam.zoom, viewH = p.height / cam.zoom;
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(-cam.rot * Math.PI / 180);
    ctx.scale(outW / viewW, outH / viewH);
    ctx.translate(-cx, -cy);
    ctx.imageSmoothingEnabled = true;
    app.stage.compositeStage(frame, ctx, { bg: false, final: true });
    ctx.restore();
    return cv;
  }

  /* ---------------- export ---------------- */
  // Real-time canvas capture -> WebM or MP4 via MediaRecorder.
  async function recordVideo(app, opts, onProgress, fmt) {
    const { outW, outH, from, to } = opts;
    const fps = app.project.fps;
    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = outH;
    const ctx = cv.getContext('2d');
    const stream = cv.captureStream(0);
    const track = stream.getVideoTracks()[0];
    let mime;
    if (fmt === 'mp4') {
      mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('MP4 recording is not supported here — export as WebM instead.');
    } else {
      mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    }
    // Optionally mix the project's audio track into the recording. The
    // capture runs in real time, so the buffer plays in sync with the frames.
    let actx = null, asrc = null;
    if (opts.audio && app.audioBuffer) {
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = actx.createMediaStreamDestination();
        asrc = actx.createBufferSource();
        asrc.buffer = app.audioBuffer;
        asrc.connect(dest);
        const at = dest.stream.getAudioTracks()[0];
        if (at) stream.addTrack(at);
      } catch (e) { actx = asrc = null; }   // carry on with video only
    }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(r => { rec.onstop = r; });
    rec.start();
    if (asrc) { try { asrc.start(0, Math.max(0, from / fps)); } catch (e) { /* ignore */ } }
    const dur = 1000 / fps;
    for (let f = from; f <= to; f++) {
      await app.seekVideosTo(f);
      await IO.loadFrame(app, f);
      const fr = renderFrame(app, f, outW, outH);
      ctx.clearRect(0, 0, outW, outH);
      ctx.drawImage(fr, 0, 0);
      if (track.requestFrame) track.requestFrame();
      else if (cv.requestFrame) cv.requestFrame();
      if (onProgress) onProgress((f - from + 1) / (to - from + 1), 'Recording frame ' + (f + 1));
      await wait(dur);
    }
    await wait(250);
    rec.stop();
    await done;
    if (asrc) { try { asrc.stop(); } catch (e) { /* ignore */ } }
    if (actx) { try { actx.close(); } catch (e) { /* ignore */ } }
    return new Blob(chunks, { type: fmt === 'mp4' ? 'video/mp4' : 'video/webm' });
  }

  /* The soundtrack under frames [from, to] as a 32-bit float WAV, cut at
     exact sample positions (silence past the end of the track), so the
     sound starts and ends exactly with the exported frames. */
  function wavSlice(buf, startSec, durSec) {
    const sr = buf.sampleRate, ch = buf.numberOfChannels;
    const start = Math.round(startSec * sr), len = Math.max(1, Math.round(durSec * sr));
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    const bytes = new ArrayBuffer(44 + len * ch * 4), v = new DataView(bytes);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 4, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 4, true); v.setUint16(32, ch * 4, true); v.setUint16(34, 32, true);
    str(36, 'data'); v.setUint32(40, len * ch * 4, true);
    const out = new Float32Array(bytes, 44);
    for (let i = 0; i < len; i++) {
      const s = start + i;
      for (let c = 0; c < ch; c++) out[i * ch + c] = (s >= 0 && s < data[c].length) ? data[c][s] : 0;
    }
    return new Uint8Array(bytes);
  }

  // What the system ffmpeg can export (desktop only; cached).
  let videoInfo = null;
  function videoFormats() {
    const enc = window.OpenToonDesktop && window.OpenToonDesktop.encode;
    if (!enc) return Promise.resolve({ found: false, formats: {} });
    if (!videoInfo) videoInfo = enc.info().catch(() => ({ found: false, formats: {} }));
    return videoInfo;
  }

  const Export = {
    renderFrame, videoFormats, wavSlice,
    /* Frame-accurate video: every frame rendered exactly once, in order,
       encoded by ffmpeg straight into v.out (picked in the export dialog or
       given on the command line). v = { format: 'h264' | 'h265' | 'prores'
       | 'png' | 'vp9', out, alpha }. Resolves { path, bytes, frames }. */
    async offline(app, opts, onProgress, v) {
      const enc = window.OpenToonDesktop && window.OpenToonDesktop.encode;
      if (!enc) throw new Error('video export through ffmpeg needs the desktop app');
      const { outW, outH, from, to } = opts;
      const fps = app.project.fps, frames = to - from + 1;
      const audio = (opts.audio && app.audioBuffer) ? wavSlice(app.audioBuffer, from / fps, frames / fps) : null;
      const s = await enc.start({ format: v.format, width: outW, height: outH, fps, audio, alpha: !!v.alpha, out: v.out });
      if (!s || !s.ok) throw new Error((s && s.error) || 'could not start ffmpeg');
      const inflight = [];
      try {
        for (let f = from; f <= to; f++) {
          await app.seekVideosTo(f);
          await IO.loadFrame(app, f);
          const cv = renderFrame(app, f, outW, outH, !!v.alpha);
          const px = cv.getContext('2d').getImageData(0, 0, outW, outH).data;
          const sent = enc.frame(s.id, new Uint8Array(px.buffer, px.byteOffset, px.byteLength))
            .then(r => { if (!r || !r.ok) throw new Error((r && r.error) || 'ffmpeg stopped'); });
          sent.catch(() => {});
          inflight.push(sent);
          if (inflight.length >= 3) await inflight.shift();     // keep ffmpeg busy, memory bounded
          if (onProgress) onProgress((f - from + 1) / frames, 'Encoding frame ' + (f + 1));
        }
        await Promise.all(inflight);
      } catch (e) {
        enc.cancel(s.id);
        throw e;
      }
      const r = await enc.finish(s.id);
      if (!r || !r.ok) throw new Error((r && r.error) || 'ffmpeg failed');
      return r;
    },
    async sequence(app, opts, onProgress) {
      const zip = new Zip();
      const { outW, outH, from, to } = opts;
      for (let f = from; f <= to; f++) {
        await app.seekVideosTo(f);
        await IO.loadFrame(app, f);
        const cv = renderFrame(app, f, outW, outH);
        const blob = await canvasToBlob(cv, 'image/png');
        const buf = new Uint8Array(await blob.arrayBuffer());
        zip.add('frame_' + U.pad(f + 1, 4) + '.png', buf);
        if (onProgress) onProgress((f - from + 1) / (to - from + 1), 'Frame ' + (f + 1));
        await wait(0);
      }
      return zip.build();
    },
    async gif(app, opts, onProgress) {
      const { outW, outH, from, to } = opts;
      const enc = new OT.GIFEncoder(outW, outH, {
        delay: 1000 / app.project.fps, repeat: 0
      });
      for (let f = from; f <= to; f++) {
        await app.seekVideosTo(f);
        await IO.loadFrame(app, f);
        const cv = renderFrame(app, f, outW, outH);
        const id = cv.getContext('2d').getImageData(0, 0, outW, outH);
        enc.addFrame(id);
        if (onProgress) onProgress((f - from + 1) / (to - from + 1), 'Encoding frame ' + (f + 1));
        await wait(0);
      }
      return enc.finish();
    },
    webm(app, opts, onProgress) { return recordVideo(app, opts, onProgress, 'webm'); },
    mp4(app, opts, onProgress) { return recordVideo(app, opts, onProgress, 'mp4'); }
  };

  /* =====================================================================
     .finca: the native project format (format version 3)
     One zip file: a small scene.json plus one entry per drawing
     (drawings/<layer>/<num>-<hash>.png for raster, .json for vector) and
     one per imported sound / video (media/<hash>.<ext>).

     Saving never reads a vector cel's surface (strokes are the drawing),
     never needs a drawing to be in memory, and only encodes drawings that
     changed: everything else is copied byte for byte out of the previous
     file by the main process. Opening reads scene.json and the vector
     strokes; raster drawings stay in the file until they are needed
     (OT.Cel.load / the synchronous fallback in OT.Cel._alloc).
     ===================================================================== */
  const FINCA_VERSION = 3;
  const stats = { saves: 0, encoded: 0, copied: 0, lastSave: null };

  // 53-bit string / byte hash (cyrb53) as 11 base-36 characters: names the
  // entry after its content, so a changed drawing gets a new name.
  function hashBytes(b) {
    let h1 = 0xdeadbeef ^ b.length, h2 = 0x41c6ce57 ^ b.length;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return finishHash(h1, h2);
  }
  function hashString(s) {
    let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return finishHash(h1, h2);
  }
  function finishHash(h1, h2) {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
  }
  // Native hashing avoids long JavaScript scans of vector JSON on open
  // and explicit saves. Keep only the digest, not another copy of strokes.
  async function vectorDigest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
  const safeName = s => String(s).replace(/[^A-Za-z0-9_\-]/g, '_').replace(/^-/, '_') || '_';

  /* ---- where entries come from ----
     A source is an open project the renderer can ask for entries by name:
     numbers are .finca files held open by the desktop main process, 'm..'
     ids are zip files held in memory (browser build). */
  const memSources = new Map();
  let memSeq = 0;
  const liveSource = id => (typeof id === 'number' ? !!desktopFS() : memSources.has(id));
  function readEntries(id, names) {
    if (typeof id === 'number') {
      const fsd = desktopFS();
      return fsd ? fsd.fincaRead(id, names) : Promise.resolve(names.map(() => null));
    }
    const m = memSources.get(id);
    return Promise.all(names.map(n => (m ? m.read(n) : null)));
  }
  function readEntry(ref) {
    if (!ref) return Promise.resolve(null);
    return readEntries(ref.id, [ref.name]).then(r => r[0] || null, () => null);
  }
  function readEntrySync(ref) {
    if (!ref) return null;
    if (typeof ref.id === 'number') {
      const fsd = desktopFS();
      try { return fsd ? fsd.fincaReadSync(ref.id, ref.name) : null; } catch (e) { return null; }
    }
    const m = memSources.get(ref.id);
    return m ? m.readSync(ref.name) : null;
  }

  // Minimal zip reader for the browser build: the whole file is in memory.
  async function memZip(buf) {
    const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let e = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
      if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Not a Finca Animate project');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    if (count === 0xFFFF || p === 0xFFFFFFFF) throw new Error('This project is too large for the browser build; open it in the desktop app');
    const dec = new TextDecoder(), entries = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged project file');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
      const data = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      entries.set(name, { method, raw: b.subarray(data, data + csize) });
      p += 46 + nl + xl + cl;
    }
    // inflate the (few, small) deflated entries up front so reads can be synchronous
    for (const en of entries.values()) {
      if (en.method === 0) en.bytes = en.raw;
      else if (en.method === 8) {
        const ds = new Blob([en.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        en.bytes = new Uint8Array(await new Response(ds).arrayBuffer());
      } else throw new Error('Damaged project file');
    }
    const id = 'm' + (++memSeq);
    const get = n => { const en = entries.get(n); return en ? en.bytes : null; };
    memSources.set(id, { read: get, readSync: get });
    return id;
  }

  /* ---- imported sound / video ----
     In memory these are data: URLs on project.audio.data / layer.video.src.
     In the file they are raw bytes under media/. `mediaSaved` remembers
     which entry a data URL came from so it is copied, not re-encoded. */
  const mediaSaved = new WeakMap();        // holder object -> { url, id, name, mime }
  const MEDIA_EXT = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'weba',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' };
  function mediaEntry(holder, url, entries, pending) {
    if (typeof url !== 'string' || !/^data:/.test(url)) return null;
    const rec = mediaSaved.get(holder);
    if (rec && rec.url === url && liveSource(rec.id)) {
      entries.push({ name: rec.name, from: { id: rec.id, name: rec.name } });
      pending.push(newId => { rec.id = newId; });
      return { src: rec.name, mime: rec.mime };
    }
    const mime = (url.slice(5, url.indexOf(',')).split(';')[0] || 'application/octet-stream').toLowerCase();
    const bytes = dataURLtoBytes(url);
    const name = 'media/' + hashBytes(bytes) + '.' + (MEDIA_EXT[mime] || 'bin');
    entries.push({ name, data: bytes });
    pending.push(newId => { mediaSaved.set(holder, { url, id: newId, name, mime }); });
    return { src: name, mime };
  }
  function bytesToDataURL(bytes, mime) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('media read failed'));
      fr.readAsDataURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    });
  }

  // Cels that came from (or were saved into) a project file. Cels that
  // leave the scene but live on in the undo history keep pointing at their
  // entry; before a save drops that entry they are given their bytes.
  const fileCels = new Set();              // WeakRef<Cel>
  const trackCel = cel => { if (typeof WeakRef === 'function') fileCels.add(new WeakRef(cel)); };
  async function detachStrays(targetId, inScene) {
    const strays = [];
    for (const ref of fileCels) {
      const c = ref.deref();
      if (!c || !c._file) { fileCels.delete(ref); continue; }
      if (c._file.id === targetId && !inScene.has(c)) strays.push(c);
    }
    for (const c of strays) {
      if (c.kind !== 'vector' && c.parked && !c._png) {
        const bytes = await readEntry(c._file);
        if (bytes && c.parked && !c._png) {
          c._png = bytes; c._pngStamp = c._stamp;
          c._pngAt = c._file.x != null ? { x: c._file.x | 0, y: c._file.y | 0 } : null;
        }
      }
      c._file = null;
    }
  }

  // Run async jobs a few at a time (PNG encodes).
  async function pool(jobs, n) {
    let i = 0;
    const worker = async () => { while (i < jobs.length) await jobs[i++](); };
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  }

  /* Build what a save needs: the scene JSON and the entry list.
     slot 'file'  : saving the project file (cels then point into it)
     slot 'auto'  : crash-recovery autosave (cels keep pointing at their own file)
     slot 'bytes' : every entry as bytes (browser download)                  */
  async function buildFinca(app, slot, autoId, trust) {
    const p = app.project;
    const entries = [], names = new Set(), jobs = [], commits = [], inScene = new Set();
    let encoded = 0;
    const put = e => { if (!names.has(e.name)) { names.add(e.name); entries.push(e); } };
    const layers = p.layers.map(l => {
      const cels = {}, dir = 'drawings/' + safeName(l.id) + '/';
      for (const num in l.cels) {
        const c = l.cels[num];
        if (!c) continue;
        inScene.add(c);
        const ref = { k: c.kind === 'vector' ? 'v' : 'r', w: c.w, h: c.h };
        cels[num] = ref;
        const auto = slot === 'auto' && c._auto && c._auto.id === autoId && liveSource(autoId) ? c._auto : null;
        const fileOk = c._file && liveSource(c._file.id);
        if (c.kind === 'vector') {
          jobs.push(async () => {
            // Every stroke edit ends in rebuild() / appendStroke() / dirty(),
            // which move the stamp; background saves trust it and skip the
            // drawings that did not move. Other saves (Ctrl+S, Save As, closing)
            // look at every drawing's strokes again.
            const k = c._vec, stamp = c._stamp, strokes = c.strokes, sl = c.strokes.length,
              marks = c.eraserMarks, ml = (marks || []).length;
            const same = trust && k && k.stamp === c._stamp && k.strokes === c.strokes && k.sl === c.strokes.length &&
              k.marks === c.eraserMarks && k.ml === ml;
            let text = null, name, contentHash = k && k.hash;
            if (same) name = k.name;
            else {
              text = JSON.stringify({ strokes: c.strokes || [], eraserMarks: c.eraserMarks || [] });
              // Imported archives may use any valid entry name. If their
              // stroke JSON is unchanged, retain that name and copy its bytes
              // instead of recompressing every vector on the first Ctrl+S.
              contentHash = await vectorDigest(new TextEncoder().encode(text));
              name = k && k.hash === contentHash ? k.name : dir + safeName(num) + '-' + hashString(text) + '.json';
            }
            ref.src = name;
            if (auto && auto.name === name) put({ name, from: { id: autoId, name } });
            else if (fileOk && c._file.name === name) put({ name, from: c._file });
            else {
              if (text == null) text = JSON.stringify({ strokes: c.strokes || [], eraserMarks: c.eraserMarks || [] });
              put({ name, text }); encoded++;
            }
            const vec = { stamp, strokes, sl, marks, ml, name, hash: contentHash };
            commits.push(id => {
              c._vec = vec;
              if (slot === 'file') { if (!c._file) trackCel(c); c._file = { id, name }; }
              else if (slot === 'auto') c._auto = { id, name };
            });
          });
          continue;
        }
        if (!c._canvas && !c._png && !c._file) continue;          // never drawn on: nothing to store
        // Which stored copy (if any) is exactly this drawing right now?
        // Parked: _png when there is one, else the file. In memory: whichever
        // carries the current stamp. Stored copies are cropped to the drawn
        // area; x / y say where they go (absent = full size at 0,0).
        const resident = !!c._canvas, stamp = c._stamp;
        const at = o => { if (o && o.x != null) { ref.x = o.x | 0; ref.y = o.y | 0; } };
        const usePng = !!c._png && (!resident || c._pngStamp === stamp);
        const useFile = !usePng && fileOk && (resident ? c._fileStamp === stamp : true);
        if (resident && c._blankStamp === stamp) {
          // empty drawing: nothing to store
        } else if (auto && auto.stamp === stamp) {
          ref.src = auto.name; at(auto);
          put({ name: auto.name, from: { id: autoId, name: auto.name } });
        } else if (useFile) {
          const f = c._file, name = f.name;
          ref.src = name; at(f);
          put({ name, from: f });
          commits.push(id => {
            if (slot === 'file') { c._file = Object.assign({}, f, { id }); if (!c._canvas) c._fileStamp = c._stamp; }
            else if (slot === 'auto') c._auto = Object.assign({ stamp }, f, { id });
          });
        } else if (usePng) {
          const bytes = c._png, pos = c._pngAt;
          const name = dir + safeName(num) + '-' + hashBytes(bytes) + '.png';
          ref.src = name; at(pos);
          put({ name, data: bytes });
          commits.push(id => {
            const loc = Object.assign({ id, name }, pos || {});
            if (slot === 'file') {
              if (!c._file) trackCel(c);
              c._file = loc;
              c._fileStamp = c._canvas ? stamp : c._stamp;
              if (c._png === bytes) { c._png = null; c._pngAt = null; }   // the file holds it now
            } else if (slot === 'auto') c._auto = Object.assign({ stamp }, loc);
          });
        } else {
          // changed (or never saved): encode it now, cropped, off the main thread
          jobs.push(async () => {
            const st = c._stamp;
            const r = await OT.encodeCropped(c.canvas);
            if (r.empty) {
              commits.push(() => { if (slot === 'file') { c._file = null; c._blankStamp = st; } });
              return;
            }
            const name = dir + safeName(num) + '-' + hashBytes(r.bytes) + '.png';
            ref.src = name; ref.x = r.x; ref.y = r.y;
            put({ name, data: r.bytes });
            encoded++;
            commits.push(id => {
              const loc = { id, name, x: r.x, y: r.y };
              if (slot === 'file') {
                if (!c._file) trackCel(c);
                c._file = loc; c._fileStamp = st;
              } else if (slot === 'auto') c._auto = Object.assign({ stamp: st }, loc);
            });
          });
        }
      }
      const out = {
        id: l.id, name: l.name, type: l.type,
        visible: l.visible, locked: l.locked, opacity: l.opacity, color: l.color,
        exposure: l.exposure.slice(), nextNum: l.nextNum,
        transform: JSON.parse(JSON.stringify(l.transform || { keyframes: [] })),
        pivot: l.pivot || null,
        video: null,
        parentId: l.parentId || null,
        collapsed: !!l._collapsed,
        cels: cels
      };
      if (l.reference) out.reference = true;          // e.g. a storyboard panel layer
      if (l.video) {
        const m = mediaEntry(l.video, l.video.src, entries, commits);
        out.video = Object.assign({}, l.video, m ? { src: m.src, mime: m.mime } : {});
      }
      return out;
    });
    await pool(jobs, 4);
    let audio = null;
    if (p.audio) {
      const m = mediaEntry(p.audio, p.audio.data, entries, commits);
      audio = Object.assign({}, p.audio, m ? { data: null, src: m.src, mime: m.mime } : {});
    }
    // media entries were pushed straight onto `entries`: drop duplicates
    const seen = new Set(), unique = [];
    for (const e of entries) if (!seen.has(e.name)) { seen.add(e.name); unique.push(e); }
    const scene = {
      format: 'finca', version: FINCA_VERSION,
      name: p.name, width: p.width, height: p.height,
      fps: p.fps, frameCount: p.frameCount, bg: p.bg,
      palette: app.palette.serialize(),
      camera: { keyframes: p.camera.keyframes.map(k => ({ ...k })) },
      audio: audio,
      perspective: p.perspective,
      workspace: captureWorkspace(app),
      layers: layers
    };
    // written by Finca Storyboard; kept exactly as it came in
    if (p.storyboard !== undefined) scene.storyboard = p.storyboard;
    return { scene: JSON.stringify(scene), entries: unique, commits, inScene, encoded };
  }

  // Small preview of frame 1 for file browsers and the start screen.
  async function thumbnailEntry(app) {
    try {
      await IO.loadFrame(app, 0);
      const p = app.project, s = Math.min(1, 320 / p.width);
      const cv = renderFrame(app, 0, Math.max(2, Math.round(p.width * s)), Math.max(2, Math.round(p.height * s)));
      const blob = await canvasToBlob(cv);
      return { name: 'thumbnail.png', data: new Uint8Array(await blob.arrayBuffer()) };
    } catch (e) { return null; }
  }

  // Saves run one at a time (a timer save and Ctrl+S must not interleave).
  let saveChain = Promise.resolve();
  const queued = fn => {
    const run = saveChain.then(fn, fn);
    saveChain = run.catch(() => {});
    return run;
  };
  const pathIds = new Map();               // project path -> source id (desktop)
  let autosaveId = null;

  async function writeFinca(app, target, opts) {
    const fsd = desktopFS();
    if (!fsd) throw new Error('no file system');
    const auto = !!(target && target.autosave);
    const t0 = performance.now();
    const seq = app._dirtySeq;
    const b = await buildFinca(app, auto ? 'auto' : 'file', autosaveId, !!(auto || (opts && opts.background)));
    let r;
    {
      if (!auto && opts && opts.thumbnail) {
        const th = await thumbnailEntry(app);
        if (th) b.entries.push(th);
      } else if (!auto && pathIds.has(target)) {
        // keep the previous preview on quick background saves
        b.entries.push({ name: 'thumbnail.png', from: { id: pathIds.get(target), name: 'thumbnail.png' }, optional: true });
      }
      // a drawing that left the scene but is still in the undo history must
      // not be left pointing at an entry this save is about to drop
      if (!auto && pathIds.has(target)) await detachStrays(pathIds.get(target), b.inScene);
      r = await fsd.fincaWrite(target, { scene: b.scene, entries: b.entries });
    }
    if (!r || !r.ok) throw new Error((r && r.error) || 'write failed');
    for (const c of b.commits) c(r.id);
    if (auto) autosaveId = r.id; else pathIds.set(target, r.id);
    stats.saves++; stats.encoded += b.encoded; stats.copied += r.copied;
    stats.lastSave = { ms: Math.round(performance.now() - t0), encoded: b.encoded, written: r.written,
      copied: r.copied, bytes: r.bytes, auto };
    if (app._dirtySeq === seq) app.dirty = false;      // nothing was edited while saving
    return r;
  }

  // scene.json (+ its source) -> { project, palette, ... }. detach: read
  // every drawing into memory instead of leaving it in the file (used for
  // autosaves and in the browser, where the file may go away).
  async function deserializeFinca(data, id, detach) {
    if (!data || data.format !== 'finca') throw new Error('Not a Finca Animate project');
    const p = new OT.Project({
      name: data.name, width: data.width, height: data.height,
      fps: data.fps, frameCount: data.frameCount, bg: data.bg, empty: true
    });
    p.camera = data.camera || { keyframes: [] };
    if (data.storyboard !== undefined) p.storyboard = data.storyboard;
    p.audio = null;
    if (data.audio) {
      p.audio = Object.assign({}, data.audio);
      delete p.audio.src; delete p.audio.mime;
      if (data.audio.src) {
        const bytes = await readEntry({ id, name: data.audio.src });
        p.audio.data = bytes ? await bytesToDataURL(bytes, data.audio.mime) : null;
        if (bytes && !detach) mediaSaved.set(p.audio, { url: p.audio.data, id, name: data.audio.src, mime: data.audio.mime });
        if (!p.audio.data) p.audio = null;
      }
    }
    if (data.perspective && data.perspective.vp1) p.perspective = Object.assign(OT.Project.defaultPerspective(), data.perspective);
    const vec = [], ras = [];
    for (const ld of data.layers || []) {
      const layer = new OT.Layer(ld.name, ld.type);
      layer.id = ld.id || layer.id;
      layer.visible = ld.visible !== false;
      layer.locked = !!ld.locked;
      layer.opacity = ld.opacity == null ? 1 : ld.opacity;
      layer.color = ld.color || '#3d9be0';
      layer.exposure = (ld.exposure || []).slice();
      layer.nextNum = ld.nextNum || 1;
      layer.transform = ld.transform && ld.transform.keyframes ? ld.transform : { keyframes: [] };
      layer.pivot = ld.pivot && isFinite(ld.pivot.x) && isFinite(ld.pivot.y) ? { x: +ld.pivot.x, y: +ld.pivot.y } : null;
      if (ld.video) {
        layer.video = Object.assign({}, ld.video);
        delete layer.video.mime;
        if (ld.video.src && !/^data:/.test(ld.video.src)) {
          const bytes = await readEntry({ id, name: ld.video.src });
          layer.video.src = bytes ? await bytesToDataURL(bytes, ld.video.mime) : '';
          if (bytes && !detach) mediaSaved.set(layer.video, { url: layer.video.src, id, name: ld.video.src, mime: ld.video.mime });
        }
      }
      layer.parentId = ld.parentId || null;
      layer._collapsed = !!ld.collapsed;
      // reference layers (storyboard panels): locked unless the file says
      // otherwise, shown while animating, left out of renders and exports
      if (ld.reference === true) { layer.reference = true; if (ld.locked === undefined) layer.locked = true; }
      const isVec = ld.type === 'vector';
      for (const num in (ld.cels || {})) {
        const cd = ld.cels[num] || {};
        const cel = new OT.Cel(Number(num), cd.w || p.width, cd.h || p.height, isVec ? 'vector' : 'raster');
        if (cd.src) (isVec ? vec : ras).push([cel, cd.src, cd]);
        layer.cels[num] = cel;
      }
      p.layers.push(layer);
    }
    // vector strokes are the drawing: read them all (small, no surfaces)
    for (let i = 0; i < vec.length; i += 256) {
      const part = vec.slice(i, i + 256);
      const got = await readEntries(id, part.map(v => v[1]));
      await Promise.all(part.map(async ([cel, name], k) => {
        let contentHash;
        try {
          const text = new TextDecoder().decode(got[k]);
          const d = JSON.parse(text);
          contentHash = await vectorDigest(got[k]);
          cel.strokes = d.strokes || [];
          cel.eraserMarks = Array.isArray(d.eraserMarks) ? d.eraserMarks : [];
          // older saves: marks cut what was drawn then, not what comes next
          if (OT.Vector) OT.Vector.upgradeMarks(cel);
          if (!detach) { cel._file = { id, name }; trackCel(cel); }
        } catch (e) { console.error('Drawing ' + name + ' could not be read'); }
        cel.dirty();
        if (!detach && cel._file) cel._vec = { stamp: cel._stamp, strokes: cel.strokes, sl: cel.strokes.length,
          marks: cel.eraserMarks, ml: cel.eraserMarks.length, name, hash: contentHash };
      }));
    }
    // raster drawings stay where they are until they are needed
    if (detach) {
      for (let i = 0; i < ras.length; i += 64) {
        const part = ras.slice(i, i + 64);
        const got = await readEntries(id, part.map(r => r[1]));
        part.forEach(([cel, , cd], k) => {
          if (got[k]) { cel._png = got[k]; cel._pngAt = cd.x != null ? { x: cd.x | 0, y: cd.y | 0 } : null; cel._pngStamp = cel._stamp; }
          cel.dirty();
        });
      }
    } else {
      for (const [cel, name, cd] of ras) {
        cel._file = cd.x != null ? { id, name, x: cd.x | 0, y: cd.y | 0 } : { id, name };
        cel._fileStamp = cel._stamp; trackCel(cel); cel.dirty();
      }
    }
    if (!p.layers.length) p.layers.push(new OT.Layer('Drawing 1'));
    return { project: p, palette: data.palette, workspace: data.workspace || null,
             version: data.version || FINCA_VERSION, newer: (data.version || FINCA_VERSION) > FINCA_VERSION };
  }

  async function openFinca(target, detach) {
    const fsd = desktopFS();
    if (!fsd) throw new Error('no file system');
    const r = await fsd.fincaOpen(target);
    if (!r || !r.ok) throw new Error((r && r.error) || 'read failed');
    let data;
    try { data = JSON.parse(r.scene); } catch (e) { throw new Error('Not a Finca Animate project'); }
    const d = await deserializeFinca(data, r.id, !!detach);
    if (typeof target === 'string' && !detach) pathIds.set(target, r.id);
    d.time = r.time;
    return d;
  }

  /* ---------------- save / open / autosave ---------------- */
  const AUTO_KEY = 'opentoon.autosave';
  // the desktop file bridge (null in a plain browser)
  const desktopFS = () => (window.OpenToonDesktop && window.OpenToonDesktop.fs) || null;

  const IO = {
    serialize, deserialize, renderFrame, Export, loadImage,
    // newest project format this build reads and writes (.finca); .otoon
    // JSON files (OTOON_VERSION and older) are read-only imports
    FORMAT_VERSION: FINCA_VERSION, OTOON_VERSION: FORMAT_VERSION,
    stats, readEntry, readEntrySync, openFinca,

    // Bring the drawings a frame shows into memory (background decode).
    loadFrame(app, frame) {
      const jobs = [];
      for (const l of app.project.layers) {
        const c = l.celAt ? l.celAt(frame) : null;
        if (c && c.parked) jobs.push(c.load());
      }
      return jobs.length ? Promise.all(jobs) : Promise.resolve();
    },
    // Bring specific drawings into memory before an operation that reads many.
    loadCels(cels) {
      const jobs = [];
      for (const c of cels || []) if (c && c.parked) jobs.push(c.load());
      return jobs.length ? Promise.all(jobs) : Promise.resolve();
    },

    // browser fallback: download the project as a .finca file
    async saveProject(app) {
      const enc = new TextEncoder();
      const b = await buildFinca(app, 'bytes');
      const zip = new Zip();
      zip.add('mimetype', enc.encode('application/x-finca-animate'));
      zip.add('scene.json', enc.encode(b.scene));
      for (const e of b.entries) {
        const data = e.data || (e.text != null ? enc.encode(e.text) : await readEntry(e.from));
        if (data) zip.add(e.name, data);
      }
      const name = (app.project.name || 'untitled').replace(/[^\w\-]+/g, '_');
      U.download(name + '.finca', zip.build());
      app.dirty = false;
    },
    // desktop: write the project to a real .finca file. Only drawings that
    // changed since the last save are encoded; the rest is copied.
    writeProjectTo(app, filePath, opts) {
      if (!desktopFS()) return Promise.reject(new Error('no file system'));
      if (!/\.finca$/i.test(filePath || '')) return Promise.reject(new Error('projects are saved as .finca files'));
      return queued(() => writeFinca(app, filePath, opts)).then(() => filePath);
    },
    // desktop: open a project from a real file path. A .otoon (the older
    // one-file format) comes back with `imported: true`: it is never
    // written to, the first save asks for a .finca name.
    readProjectFrom(filePath) {
      const fsd = desktopFS();
      if (!fsd) return Promise.reject(new Error('no file system'));
      if (/\.finca$/i.test(filePath || '')) return openFinca(filePath, false);
      return fsd.readFile(filePath).then(r => {
        if (!r || !r.ok) throw new Error((r && r.error) || 'read failed');
        const data = JSON.parse(r.data);
        if (data.format !== 'otoon') throw new Error('Not an OpenToon project');
        return deserialize(data).then(d => { d.imported = true; return d; });
      });
    },
    // browser fallback: parse a project from a picked File object
    async openProjectFile(app, file) {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (head[0] === 0x50 && head[1] === 0x4b) {                 // "PK": a .finca
        const id = await memZip(buf);
        try {
          const scene = await readEntry({ id, name: 'scene.json' });
          if (!scene) throw new Error('Not a Finca Animate project');
          return await deserializeFinca(JSON.parse(new TextDecoder().decode(scene)), id, true);
        } finally { memSources.delete(id); }
      }
      const data = JSON.parse(new TextDecoder().decode(buf));
      if (data.format !== 'otoon') throw new Error('Not an OpenToon project');
      const d = await deserialize(data);
      d.imported = true;
      return d;
    },
    // crash-safe autosave: a real file on desktop, localStorage in the browser
    autosave(app) {
      if (desktopFS()) {
        queued(() => writeFinca(app, { autosave: true })).catch(e => console.error('autosave failed: ' + e.message));
        return true;
      }
      try {
        localStorage.setItem(AUTO_KEY, JSON.stringify(serialize(app)));
        localStorage.setItem(AUTO_KEY + '.time', Date.now().toString());
        return true;
      } catch (e) { return false; }    // localStorage quota exceeded
    },
    // resolve to { project, palette, time } or null
    readAutosave() {
      const fsd = desktopFS();
      if (fsd) {
        return fsd.autosaveRead().then(info => {
          if (!info) return null;
          const load = info.kind === 'finca' ? openFinca({ autosave: true }, true)
            : deserialize(JSON.parse(info.data));
          return load.then(d => ({ project: d.project, palette: d.palette, time: new Date(info.time) }));
        }).catch(() => null);
      }
      const raw = localStorage.getItem(AUTO_KEY);
      if (!raw) return Promise.resolve(null);
      const t = localStorage.getItem(AUTO_KEY + '.time');
      return deserialize(JSON.parse(raw)).then(d => ({
        project: d.project, palette: d.palette, time: t ? new Date(Number(t)) : null
      })).catch(() => null);
    },
    // one autosave snapshot from File > Recover Autosave (desktop)
    readAutosaveSnapshot(name) {
      const fsd = desktopFS();
      if (!fsd) return Promise.reject(new Error('no file system'));
      if (/\.finca$/.test(name)) return openFinca({ history: name }, true);
      return fsd.autosaveHistoryRead(name).then(txt => {
        if (!txt) throw new Error('snapshot is missing');
        return deserialize(JSON.parse(txt));
      });
    },
    clearAutosave() {
      const fsd = desktopFS();
      if (fsd) fsd.autosaveClear().catch(() => {});
      localStorage.removeItem(AUTO_KEY);
      localStorage.removeItem(AUTO_KEY + '.time');
    },

    async importImageAsLayer(app, file) {
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const layer = new OT.Layer(file.name.replace(/\.[^.]+$/, ''));
        const cel = layer.drawingAt(app.frame, app.project.width, app.project.height);
        // fit image centered
        const s = Math.min(app.project.width / img.width, app.project.height / img.height);
        const w = img.width * s, h = img.height * s;
        cel.ctx.drawImage(img, (app.project.width - w) / 2, (app.project.height - h) / 2, w, h);
        cel.dirty();
        app.project.addLayer(layer);
        app.selectLayer(layer);
        app.history.clear();
        app.emit('layerschange'); app.emit('render');
        app.ui.status('Imported ' + file.name);
      } finally { URL.revokeObjectURL(url); }
    }
  };

  OT.IO = IO;
  OT.Zip = Zip;
})(window.OT);
