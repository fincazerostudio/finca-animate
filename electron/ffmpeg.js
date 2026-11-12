/* Finca Animate - offline, frame-accurate video export through ffmpeg
   The renderer draws every frame exactly (no real-time recording) and hands
   the raw RGBA pixels to this module, which pipes them into an ffmpeg it
   finds on the system. The soundtrack arrives as a WAV cut to exactly the
   exported frames (sample-accurate), and is muxed in the same run.

   ffmpeg is found through, in order: $FINCA_FFMPEG, a bundled copy next to
   the app (resources/ffmpeg[.exe]), then PATH and the usual install folders.
   Without it, the app falls back to the old real-time recorder for MP4/WebM
   and says so; ProRes and PNG QuickTime need ffmpeg. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// What each export format asks of ffmpeg. `alpha`: keeps transparency.
const FORMATS = {
  h264: { ext: 'mp4', label: 'MP4 (H.264)', encoder: 'libx264', alpha: false,
    video: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    audio: ['-c:a', 'aac', '-b:a', '256k'], even: true },
  h265: { ext: 'mp4', label: 'MP4 (H.265 / HEVC)', encoder: 'libx265', alpha: false,
    video: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
      '-x265-params', 'log-level=error', '-movflags', '+faststart'],
    audio: ['-c:a', 'aac', '-b:a', '256k'], even: true },
  prores: { ext: 'mov', label: 'QuickTime (ProRes 4444, with alpha)', encoder: 'prores_ks', alpha: true,
    video: ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-alpha_bits', '16'],
    audio: ['-c:a', 'pcm_s24le'] },
  png: { ext: 'mov', label: 'QuickTime (PNG, lossless with alpha)', encoder: 'png', alpha: true,
    video: ['-c:v', 'png', '-pix_fmt', 'rgba'],
    audio: ['-c:a', 'pcm_s24le'] },
  vp9: { ext: 'webm', label: 'WebM (VP9)', encoder: 'libvpx-vp9', alpha: true,
    video: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2'],
    alphaVideo: ['-pix_fmt', 'yuva420p', '-auto-alt-ref', '0'], opaqueVideo: ['-pix_fmt', 'yuv420p'],
    audio: ['-c:a', 'libopus', '-b:a', '192k'] }
};

let cached;           // { path, version, encoders: Set } | null

function candidates() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const out = [];
  if (process.env.FINCA_FFMPEG) out.push(process.env.FINCA_FFMPEG);
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, exe));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) out.push(path.join(dir, exe));
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, 'C:\\'])
      if (base) out.push(path.join(base, 'ffmpeg', 'bin', exe));
    if (process.env.LOCALAPPDATA)
      out.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    if (process.env.USERPROFILE) out.push(path.join(process.env.USERPROFILE, 'scoop', 'shims', exe));
  } else {
    out.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/snap/bin/ffmpeg');
  }
  return [...new Set(out)];
}

// Find ffmpeg and what it can encode (once per run).
function probe() {
  if (cached !== undefined) return cached;
  cached = null;
  for (const p of candidates()) {
    try {
      if (!fs.statSync(p).isFile()) continue;
      const v = spawnSync(p, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (v.status !== 0) continue;
      const e = spawnSync(p, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 1 << 22 });
      const encoders = new Set();
      for (const line of String(e.stdout || '').split('\n')) {
        const m = line.match(/^\s*[VAS][\w.]{5}\s+(\S+)/);
        if (m) encoders.add(m[1]);
      }
      cached = { path: p, version: (String(v.stdout).match(/ffmpeg version (\S+)/) || [])[1] || '?', encoders };
      break;
    } catch (e) { /* try the next one */ }
  }
  return cached;
}

// For the renderer: which formats this machine can export.
function info() {
  const f = probe();
  const formats = {};
  for (const [id, fmt] of Object.entries(FORMATS))
    formats[id] = { ext: fmt.ext, label: fmt.label, alpha: fmt.alpha, ok: !!(f && f.encoders.has(fmt.encoder)) };
  return { found: !!f, path: f ? f.path : null, version: f ? f.version : null, formats };
}

/* One export run. Frames are written in order; write() resolves once ffmpeg
   has taken the frame (backpressure), finish() once the file is complete. */
class Encoder {
  constructor(opts) {
    const f = probe();
    if (!f) throw new Error('ffmpeg was not found. Install it (e.g. "pacman -S ffmpeg", "winget install ffmpeg") or set FINCA_FFMPEG.');
    const fmt = FORMATS[opts.format];
    if (!fmt) throw new Error('unknown video format ' + opts.format);
    if (!f.encoders.has(fmt.encoder)) throw new Error('this ffmpeg (' + f.path + ') has no ' + fmt.encoder + ' encoder');
    const w = opts.width | 0, h = opts.height | 0, fps = Number(opts.fps);
    if (!(w > 1 && h > 1 && w <= 16384 && h <= 16384 && fps > 0 && fps <= 240)) throw new Error('bad video size or frame rate');
    this.frameBytes = w * h * 4;
    this.frames = 0;
    this.out = opts.out;
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finca-export-'));
    // write next to the target, move into place when done: a failed export
    // never leaves a broken file under the real name
    this.partial = path.join(path.dirname(this.out), '.' + path.basename(this.out) + '.part-' + process.pid + '.' + fmt.ext);
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', w + 'x' + h, '-framerate', String(fps), '-i', 'pipe:0'];
    if (opts.audio && opts.audio.byteLength) {
      const wav = path.join(this.tmpDir, 'audio.wav');
      fs.writeFileSync(wav, Buffer.from(opts.audio.buffer || opts.audio, opts.audio.byteOffset || 0, opts.audio.byteLength));
      args.push('-i', wav);
    }
    args.push('-map', '0:v');
    if (opts.audio && opts.audio.byteLength) args.push('-map', '1:a', ...fmt.audio);
    const vf = [];
    if (fmt.even && (w % 2 || h % 2)) vf.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
    if (vf.length) args.push('-vf', vf.join(','));
    args.push(...fmt.video);
    if (fmt.alphaVideo) args.push(...(opts.alpha ? fmt.alphaVideo : fmt.opaqueVideo));
    args.push('-r', String(fps), '-f', fmt.ext === 'mov' ? 'mov' : fmt.ext, this.partial);
    this.args = args;
    this.stderr = '';
    this.proc = spawn(f.path, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    this.exited = new Promise(res => this.proc.on('close', (code, sig) => res({ code, sig })));
    this.proc.on('error', e => { this.stderr += '\n' + e.message; });
    this.proc.stdin.on('error', () => { /* reported through the exit code */ });
  }
  write(bytes) {
    if (!bytes || bytes.byteLength !== this.frameBytes) return Promise.reject(new Error('frame has the wrong size'));
    if (this.proc.exitCode !== null) return Promise.reject(new Error(this.failText()));
    this.frames++;
    const buf = Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
    return new Promise((res, rej) => {
      const ok = this.proc.stdin.write(buf, err => { if (err) rej(new Error(this.failText())); });
      if (ok) res(); else this.proc.stdin.once('drain', res);
    });
  }
  failText() {
    const tail = this.stderr.trim().split('\n').slice(-3).join(' | ');
    return 'ffmpeg stopped' + (tail ? ': ' + tail : '');
  }
  async finish() {
    this.proc.stdin.end();
    const r = await this.exited;
    try {
      if (r.code !== 0) throw new Error(this.failText());
      fs.renameSync(this.partial, this.out);
      return { ok: true, path: this.out, bytes: fs.statSync(this.out).size, frames: this.frames };
    } finally { this.cleanup(); }
  }
  cancel() {
    try { this.proc.kill('SIGKILL'); } catch (e) { /* gone */ }
    this.cleanup();
  }
  cleanup() {
    try { fs.rmSync(this.partial, { force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = { FORMATS, probe, info, Encoder };
