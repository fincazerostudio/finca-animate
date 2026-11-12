/* OpenToon Studio - Electron preload (safe bridge to the renderer) */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('OpenToonDesktop', {
  platform: process.platform,
  isDesktop: true,
  // real app version (works in packaged builds, unlike npm_package_version)
  getVersion: () => ipcRenderer.invoke('opentoon:get-version'),
  // ask the main process to check GitHub Releases for an update
  checkForUpdates: () => ipcRenderer.invoke('opentoon:check-updates'),
  // subscribe to update lifecycle events (checking / available / ... )
  onUpdateStatus: cb =>
    ipcRenderer.on('opentoon:update-status', (_e, data) => cb(data)),
  quitAndInstall: () => ipcRenderer.send('opentoon:quit-install'),
  // 'auto' | 'manual' | 'off' — manual means every download/install needs a click
  getUpdatePolicy: () => ipcRenderer.invoke('opentoon:update-policy'),
  // manual policy: download the update found by the last check (user-approved)
  downloadUpdate: () => ipcRenderer.invoke('opentoon:download-update'),
  // manual policy: open the release page when self-update isn't possible
  openReleasePage: () => ipcRenderer.invoke('opentoon:open-release-page'),
  // tell the main process the app has finished booting (dismisses the splash)
  signalReady: () => ipcRenderer.send('app:ready'),
  splashProgress: (pct, label) => ipcRenderer.send('app:loading', { pct: pct, label: label }),
  // a project double-clicked while the app is already running
  onOpenFile: cb => ipcRenderer.on('opentoon:open-file', (_e, p) => cb(p)),
  // secondary "pen display" drawing window (see src/pencast.js)
  openPenWindow: (opts) => ipcRenderer.invoke('opentoon:pen-open', opts),
  // one-shot query for the current pen-window open state + bounds —
  // used by io.js#captureWorkspace when saving the project.
  getPenWindowState: () => ipcRenderer.invoke('opentoon:pen-window-state'),
  // streamed bounds — fires whenever the user moves or resizes the
  // pen window so the renderer can cache the latest values without
  // a round-trip on every save.
  onPenBounds: cb => ipcRenderer.on('opentoon:pen-bounds', (_e, b) => cb(b)),
  onPenAttach: cb => ipcRenderer.on('opentoon:pen-attach', () => cb()),
  onPenDetach: cb => ipcRenderer.on('opentoon:pen-detach', () => cb()),
  // STATE CHANNEL for the pen window — see pen-preload.js. Tiny JSON ops
  // (project/cel/layer/tool/live-stroke). Acks ride back so the publisher
  // can detect divergence and resync.
  sendPenState: msg => ipcRenderer.send('opentoon:pen-state', msg),
  onPenStateAck: cb => ipcRenderer.on('opentoon:pen-state-ack', (_e, seq) => cb(seq)),
  onPenInput: cb => ipcRenderer.on('opentoon:pen-input', (_e, msg) => cb(msg)),
  onPenCommand: cb => ipcRenderer.on('opentoon:pen-command', (_e, msg) => cb(msg)),
  // command-line batch render (opentoon-studio --render ...): null otherwise
  render: {
    job: () => ipcRenderer.invoke('opentoon:render-job').catch(() => null),
    progress: msg => ipcRenderer.send('opentoon:render-progress', String(msg)),
    done: bytes => ipcRenderer.invoke('opentoon:render-done', bytes),
    written: info => ipcRenderer.invoke('opentoon:render-written', info),
    fail: msg => ipcRenderer.send('opentoon:render-fail', String(msg))
  },
  // offline video export through ffmpeg (frames are sent as raw RGBA)
  encode: {
    info: () => ipcRenderer.invoke('opentoon:ffmpeg-info'),
    saveDialog: (name, format) => ipcRenderer.invoke('opentoon:export-dialog', name, format),
    start: (opts) => ipcRenderer.invoke('opentoon:encode-start', opts),
    frame: (id, bytes) => ipcRenderer.invoke('opentoon:encode-frame', id, bytes),
    finish: (id) => ipcRenderer.invoke('opentoon:encode-finish', id),
    cancel: (id) => ipcRenderer.invoke('opentoon:encode-cancel', id)
  },
  // real file IO for the desktop app: native dialogs, save-in-place, autosave
  fs: {
    saveDialog: (defaultPath) => ipcRenderer.invoke('opentoon:save-dialog', defaultPath),
    openDialog: () => ipcRenderer.invoke('opentoon:open-dialog'),
    // .otoon (the older one-file JSON format): read only
    readFile: (file) => ipcRenderer.invoke('opentoon:read-file', file),
    // .finca: open -> { ok, id, scene }, then ask for entries by name.
    // target = a path, { autosave: true } or { history: '<snapshot name>' }
    fincaOpen: (target) => ipcRenderer.invoke('opentoon:finca-open', target),
    fincaRead: (id, names) => ipcRenderer.invoke('opentoon:finca-read', id, names),
    fincaReadSync: (id, name) => ipcRenderer.sendSync('opentoon:finca-read-sync', id, name),
    fincaWrite: (target, payload) => ipcRenderer.invoke('opentoon:finca-write', target, payload),
    fincaClose: (id) => ipcRenderer.invoke('opentoon:finca-close', id),
    autosaveRead: () => ipcRenderer.invoke('opentoon:autosave-read'),
    autosaveClear: () => ipcRenderer.invoke('opentoon:autosave-clear'),
    autosaveHistory: () => ipcRenderer.invoke('opentoon:autosave-history'),
    autosaveHistoryRead: (name) => ipcRenderer.invoke('opentoon:autosave-history-read', name),
    pendingFile: () => ipcRenderer.invoke('opentoon:pending-file'),
    statFile: (file) => ipcRenderer.invoke('opentoon:stat-file', file)
  }
});
