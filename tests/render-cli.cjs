/* Command-line batch render: opentoon-studio --render scene.otoon -o out.<ext>
 *
 *   node tests/render-cli.cjs [path/to/opentoon-studio]
 *
 * Defaults to the dev Electron binary running this checkout. Builds a small
 * scene in the browser, saves it as .otoon, renders every output type with
 * the real app and checks the files it writes.
 */
'use strict';
const { launch, FILE } = require('./launch-browser.cjs');
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.argv[2] || require('electron');          // electron package exports its binary path
const BASE_ARGS = process.argv[2] ? [] : [ROOT];

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  ' + JSON.stringify(detail) : ''));
}
function render(args) {
  const r = spawnSync(EXE, BASE_ARGS.concat(args), { encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const u32be = (b, o) => b.readUInt32BE(o);

(async () => {
  const startedAt = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opentoon-render-test-'));
  // 1. a 12-frame scene: red block on the left, blue block moving right
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const json = await page.evaluate(() => {
    const a = window.OT.app, p = a.project;
    p.name = 'cli-test'; p.width = 640; p.height = 360; p.fps = 24; p.frameCount = 12;
    a.addLayer('drawing'); const L = a.activeLayer();
    const c = L.drawingAt(0, p.width, p.height);
    c.ctx.fillStyle = '#ff0000'; c.ctx.fillRect(0, 0, 320, 360); c.dirty();
    for (let f = 1; f < 12; f++) L.exposure[f] = L.exposure[0];
    a.addLayer('drawing'); const B = a.activeLayer();
    const bc = B.drawingAt(0, p.width, p.height);
    bc.ctx.fillStyle = '#0000ff'; bc.ctx.fillRect(330, 140, 60, 60); bc.dirty();
    for (let f = 1; f < 12; f++) B.exposure[f] = B.exposure[0];
    B.transform.keyframes = [{ frame: 0, x: 0, y: 0, sx: 1, sy: 1, rot: 0 }, { frame: 11, x: 200, y: 0, sx: 1, sy: 1, rot: 0 }];
    // a 1 s, 48 kHz stereo tone as the soundtrack
    const n = 48000, b = new Uint8Array(44 + n * 4), v = new DataView(b.buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 48000, true); v.setUint32(28, 192000, true);
    v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { const x = Math.round(Math.sin(i / 48000 * 2 * Math.PI * 440) * 8000); v.setInt16(44 + i * 4, x, true); v.setInt16(46 + i * 4, x, true); }
    let bin = ''; for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    p.audio = { name: 'tone.wav', data: 'data:audio/wav;base64,' + btoa(bin) };
    return JSON.stringify(window.OT.IO.serialize(a));
  });
  const scene = path.join(tmp, 'scene.otoon');
  fs.writeFileSync(scene, json);

  // 2. every output type
  const out = ext => path.join(tmp, 'out.' + ext);
  let r = render(['--render', scene, '-o', out('gif'), '--scale', '0.5']);
  let b = fs.existsSync(out('gif')) ? fs.readFileSync(out('gif')) : Buffer.alloc(0);
  check('gif: exit 0 and written', r.code === 0 && b.length > 100, r.out);
  check('gif: header + 320x180', b.toString('latin1', 0, 6) === 'GIF89a' && b.readUInt16LE(6) === 320 && b.readUInt16LE(8) === 180);
  check('gif: 12 frames', (b.toString('latin1').match(/\x21\xF9\x04/g) || []).length === 12);
  check('progress printed', /Rendering .*scene\.otoon/.test(r.out) && /100%/.test(r.out), r.out);

  r = render(['--render', scene, '-o', out('png'), '--frame', '12']);
  b = fs.existsSync(out('png')) ? fs.readFileSync(out('png')) : Buffer.alloc(0);
  check('png: one frame at full size', r.code === 0 && b.toString('latin1', 1, 4) === 'PNG' && u32be(b, 16) === 640 && u32be(b, 20) === 360, r.out);
  // pixel check: blue block reached x≈530-590 on the last frame
  const px = await page.evaluate(async (dataUrl) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const at = (X, Y) => Array.from(x.getImageData(X, Y, 1, 1).data.slice(0, 3));
    return { red: at(100, 180), movedBlue: at(560, 170), oldBlue: at(360, 170) };
  }, 'data:image/png;base64,' + b.toString('base64'));
  check('png: matches the scene (red block, blue block moved by its keyframes)',
    px.red[0] > 240 && px.red[2] < 20 && px.movedBlue[2] > 240 && px.movedBlue[0] < 20 && px.oldBlue[0] > 240 && px.oldBlue[1] > 240, px);

  r = render(['--render', scene, '-o', out('zip'), '--from', '3', '--to', '7', '--scale', '0.25']);
  b = fs.existsSync(out('zip')) ? fs.readFileSync(out('zip')) : Buffer.alloc(0);
  const names = (b.toString('latin1').match(/frame_\d{4}\.png/g) || []);
  check('zip: frames 3-7 as PNGs', r.code === 0 && new Set(names).size === 5 && names.includes('frame_0003.png') && names.includes('frame_0007.png'), { code: r.code, names: [...new Set(names)] });

  r = render(['--render', scene, '-o', out('webm'), '--scale', '0.5']);
  b = fs.existsSync(out('webm')) ? fs.readFileSync(out('webm')) : Buffer.alloc(0);
  check('webm: EBML video written', r.code === 0 && b.length > 500 && b.readUInt32BE(0) === 0x1A45DFA3, r.out);

  r = render(['--render', scene, '--scale', '0.5']);            // default: <scene>.mp4
  const mp4 = path.join(tmp, 'scene.mp4');
  b = fs.existsSync(mp4) ? fs.readFileSync(mp4) : Buffer.alloc(0);
  const mp4ok = r.code === 0 && b.toString('latin1', 4, 8) === 'ftyp';
  const mp4unsupported = r.code === 1 && /MP4 recording is not supported/.test(r.out);
  check('mp4 (default output name): written, or a clear "not supported" error', mp4ok || mp4unsupported, r.out);
  check('video is not recorded in real time (a 12-frame clip renders without waiting it out)', !/recording in real time/.test(r.out) || !mp4ok, r.out);
  if (mp4unsupported) console.log('     note: this Electron build cannot record MP4; .webm works');

  // 2b. the same scene as a .finca (built here from the .otoon with the
  //     container code, so the CLI is also checked against a file the app
  //     did not write itself)
  const Z = require('../electron/finca-zip.js');
  const fscene = path.join(tmp, 'scene.finca');
  {
    const data = JSON.parse(json);
    const fd = fs.openSync(fscene, 'w');
    const w = Z.createWriter(fd);
    const entries = [];
    for (const l of data.layers) for (const n in l.cels) {
      const c = l.cels[n];
      if (c.k === 'v') {
        const name = 'drawings/' + l.id + '/' + n + '.json';
        entries.push([name, Buffer.from(JSON.stringify({ strokes: c.strokes, eraserMarks: c.eraserMarks || [] })), true]);
        l.cels[n] = { k: 'v', src: name, w: data.width, h: data.height };
      } else {
        const name = 'drawings/' + l.id + '/' + n + '.png';
        entries.push([name, Buffer.from(c.png.split(',')[1], 'base64'), false]);
        l.cels[n] = { k: 'r', src: name, w: data.width, h: data.height };
      }
    }
    data.format = 'finca'; data.version = 3;
    w.add('scene.json', Buffer.from(JSON.stringify(data)), true);
    for (const [name, buf, deflate] of entries) w.add(name, buf, deflate);
    w.finish();
    fs.closeSync(fd);
  }
  r = render(['--render', fscene, '-o', out('finca.png'), '--frame', '12']);
  const fb = fs.existsSync(out('finca.png')) ? fs.readFileSync(out('finca.png')) : Buffer.alloc(0);
  const fpx = await page.evaluate(async (dataUrl) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const at = (X, Y) => Array.from(x.getImageData(X, Y, 1, 1).data.slice(0, 3));
    return { red: at(100, 180), movedBlue: at(560, 170), oldBlue: at(360, 170) };
  }, 'data:image/png;base64,' + fb.toString('base64'));
  check('.finca input: renders the same frame as the .otoon', r.code === 0 && JSON.stringify(fpx) === JSON.stringify(px), { out: r.out, fpx, px });
  r = render(['--render', fscene, '-o', out('finca.gif'), '--scale', '0.5']);
  b = fs.existsSync(out('finca.gif')) ? fs.readFileSync(out('finca.gif')) : Buffer.alloc(0);
  check('.finca input: gif with all 12 frames', r.code === 0 && (b.toString('latin1').match(/\x21\xF9\x04/g) || []).length === 12, r.out);

  // 2c. frame-accurate video through ffmpeg
  const probe = (f, sel) => {
    const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
      'stream=codec_type,codec_name,pix_fmt,width,height,nb_read_frames,duration,sample_rate', '-of', 'json', f], { encoding: 'utf8' });
    try { return JSON.parse(r.stdout).streams; } catch (e) { return null; }
  };
  const haveFfmpeg = spawnSync('ffprobe', ['-version']).status === 0;
  if (!haveFfmpeg) console.log('     note: ffmpeg/ffprobe not installed; frame-accurate checks skipped');
  else {
    const vid = st => (st || []).find(x => x.codec_type === 'video') || {};
    const aud = st => (st || []).find(x => x.codec_type === 'audio') || {};
    let st = probe(mp4);
    check('mp4 via ffmpeg: H.264, all 12 frames, 320x180, with sound',
      vid(st).codec_name === 'h264' && +vid(st).nb_read_frames === 12 && vid(st).width === 320 && aud(st).codec_name === 'aac', st);

    r = render(['--render', fscene, '-o', out('mov'), '--from', '3', '--to', '7']);
    st = probe(out('mov'));
    check('mov (ProRes 4444): exactly frames 3-7, alpha pixel format', r.code === 0 && vid(st).codec_name === 'prores' &&
      +vid(st).nb_read_frames === 5 && /^yuva/.test(vid(st).pix_fmt || ''), { out: r.out, st });
    // 5 frames at 24 fps = 0.208333 s = exactly 10000 samples at 48 kHz
    check('mov: sound cut to the exported frames, sample-accurate (10000 samples)',
      aud(st).codec_name === 'pcm_s24le' && Math.round(+aud(st).duration * 48000) === 10000, aud(st));

    r = render(['--render', fscene, '-o', out('h265.mp4'), '--codec', 'h265', '--no-audio', '--scale', '0.5']);
    st = probe(out('h265.mp4'));
    check('h265 mp4, no audio', r.code === 0 && vid(st).codec_name === 'hevc' && +vid(st).nb_read_frames === 12 && !aud(st).codec_name, { out: r.out, st });

    r = render(['--render', fscene, '-o', out('png.mov'), '--codec', 'png', '--alpha', '--no-audio']);
    st = probe(out('png.mov'));
    // decode frame 12 back and compare with the PNG frame render: lossless means identical
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', out('png.mov'), '-vf', 'select=eq(n\\,11)', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 24 }).stdout || Buffer.alloc(0);
    const at = (X, Y) => Array.from(raw.subarray((Y * 640 + X) * 4, (Y * 640 + X) * 4 + 4));
    check('png mov --alpha: lossless, background left transparent, blocks where they belong',
      r.code === 0 && vid(st).codec_name === 'png' && raw.length === 640 * 360 * 4 &&
      at(360, 170)[3] === 0 && JSON.stringify(at(100, 180)) === '[255,0,0,255]' && JSON.stringify(at(560, 170)) === '[0,0,255,255]',
      { out: r.out, bg: at(360, 170), red: at(100, 180), blue: at(560, 170) });

    r = render(['--render', fscene, '-o', out('a.webm'), '--alpha', '--scale', '0.5']);
    st = probe(out('a.webm'));
    check('webm via ffmpeg: VP9, 12 frames, opus sound', r.code === 0 && vid(st).codec_name === 'vp9' && +vid(st).nb_read_frames === 12 && aud(st).codec_name === 'opus', { out: r.out, st });
    r = render(['--render', fscene, '-o', out('bad.mov'), '--codec', 'h264']);
    check('--codec that does not fit the extension: exit 2', r.code === 2 && /does not go in/.test(r.out), r);
    check('no partial files left next to the outputs', !fs.readdirSync(tmp).some(n => /\.part-/.test(n)), fs.readdirSync(tmp));
  }

  // 3. errors and help
  r = render(['--render', path.join(tmp, 'missing.otoon')]);
  check('missing scene: exit 2 + message', r.code === 2 && /scene not found/.test(r.out), r);
  r = render(['--render', scene, '-o', out('avi')]);
  check('unknown output type: exit 2', r.code === 2 && /unsupported output type/.test(r.out), r);
  r = render(['--render', scene, '--bogus']);
  check('unknown option: exit 2 + usage', r.code === 2 && /Usage: opentoon-studio --render/.test(r.out), r);
  r = render(['--render', '--help']);
  check('--help: exit 0 + usage', r.code === 0 && /Usage: opentoon-studio --render/.test(r.out), r);
  await new Promise(r => setTimeout(r, 2000));   // cleanup helper runs just after each exit
  const left = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('opentoon-render-') && !n.startsWith('opentoon-render-test-')
    && fs.statSync(path.join(os.tmpdir(), n)).mtimeMs >= startedAt);
  check('temporary render profiles cleaned up', left.length === 0, left);

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const fail = results.filter(x => !x).length;
  console.log(fail ? fail + ' render-cli check(s) failed' : 'All ' + results.length + ' render-cli checks passed.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
