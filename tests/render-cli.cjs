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
  if (mp4unsupported) console.log('     note: this Electron build cannot record MP4; .webm works');

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
