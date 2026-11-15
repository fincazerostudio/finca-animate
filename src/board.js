/* Storyboard mode: Finca Animate as a Storyboard Pro style board.
 *
 * Model (project.board, saved with the scene):
 *   { version: 1,
 *     scenes: [{ id, name }],
 *     panels: [{ id, scene, duration, dialogue, action, notes, transition }] }
 * Panels play back to back in order: panel i covers the frames from the sum
 * of the earlier durations, for `duration` frames. Layers stay the project's
 * layers (Harmony style), and every panel has its own drawing on each layer:
 * drawing on an empty layer exposes the new drawing for the whole panel
 * (OT.boardSpan, used by Layer.drawingAt). So the animatic is plain playback
 * and every exporter already renders it.
 *
 * Every edit that moves frames goes through app.doStruct, whose snapshot
 * carries project.board, so undo / redo cover panels too.
 */
(function (OT) {
  'use strict';
  const U = OT.util;
  const el = U.el;

  const FIELDS = ['dialogue', 'action', 'notes'];
  const TRANSITIONS = ['cut', 'dissolve', 'wipe', 'fade'];

  /* ------------------------------ model ------------------------------ */
  function defaultDuration(project) { return Math.max(1, Math.round((project.fps || 24) * 2)); }

  function newPanel(scene, duration) {
    return { id: U.uid(), scene: scene, duration: duration, dialogue: '', action: '', notes: '', transition: 'cut' };
  }

  // A fresh board on a project: one scene, one panel spanning every frame.
  function create(project) {
    const scene = { id: U.uid(), name: '1' };
    const d = project.frameCount > 1 ? project.frameCount : defaultDuration(project);
    project.frameCount = d;
    project.board = { version: 1, scenes: [scene], panels: [newPanel(scene.id, d)] };
    return project.board;
  }

  // Bring a loaded board into a valid state (old or hand-edited files).
  function normalize(project) {
    const b = project.board;
    if (!b || !Array.isArray(b.panels)) { delete project.board; return null; }
    if (!Array.isArray(b.scenes) || !b.scenes.length) b.scenes = [{ id: U.uid(), name: '1' }];
    const sceneIds = new Set(b.scenes.map(s => s.id));
    b.panels = b.panels.filter(p => p && typeof p === 'object');
    if (!b.panels.length) b.panels.push(newPanel(b.scenes[0].id, project.frameCount || defaultDuration(project)));
    for (const p of b.panels) {
      p.id = p.id || U.uid();
      if (!sceneIds.has(p.scene)) p.scene = b.scenes[0].id;
      p.duration = Math.max(1, Math.round(+p.duration || 1));
      for (const f of FIELDS) if (typeof p[f] !== 'string') p[f] = '';
      if (TRANSITIONS.indexOf(p.transition) < 0) p.transition = 'cut';
    }
    // scenes stay contiguous and in panel order
    const order = [];
    for (const p of b.panels) if (order.indexOf(p.scene) < 0) order.push(p.scene);
    b.scenes = order.map(id => b.scenes.find(s => s.id === id));
    const total = b.panels.reduce((n, p) => n + p.duration, 0);
    if (total !== project.frameCount) {
      // the frame count wins over the last panel's length
      const last = b.panels[b.panels.length - 1];
      last.duration = Math.max(1, last.duration + project.frameCount - total);
      project.frameCount = b.panels.reduce((n, p) => n + p.duration, 0);
    }
    b.version = 1;
    return b;
  }

  // Storyboard mode is on when the project has a board that is not switched
  // off. Switching to Animation keeps every panel and caption; switching back
  // brings them back (frames added in Animation go to the last panel).
  function on(project) { return !!(project && project.board && !project.board.hidden); }

  function spans(board) {
    const out = [];
    let f = 0;
    board.panels.forEach((p, i) => { out.push({ panel: p, index: i, start: f, end: f + p.duration - 1 }); f += p.duration; });
    return out;
  }
  function spanAt(board, frame) {
    let f = 0;
    for (let i = 0; i < board.panels.length; i++) {
      const p = board.panels[i];
      if (frame < f + p.duration) return { panel: p, index: i, start: f, end: f + p.duration - 1 };
      f += p.duration;
    }
    const i = board.panels.length - 1, p = board.panels[i];
    return { panel: p, index: i, start: f - p.duration, end: f - 1 };
  }
  // Scene number, and panel number within its scene, as Storyboard Pro shows them.
  function labels(board) {
    const out = new Map();
    const count = {};
    for (const p of board.panels) {
      count[p.scene] = (count[p.scene] || 0) + 1;
      const s = board.scenes.find(x => x.id === p.scene);
      out.set(p.id, { scene: s ? s.name : '?', panel: count[p.scene] });
    }
    return out;
  }

  /* ----------------------- frame-range helpers ----------------------- */
  // Insert n frames at `at`; fill(layer) gives the cel number to expose there.
  function insertFrames(project, at, n, fill) {
    for (const l of project.layers) {
      if (l.isGroup && l.isGroup()) continue;
      while (l.exposure.length < at) l.exposure.push(0);
      const v = fill ? fill(l) : 0;
      l.exposure.splice(at, 0, ...new Array(n).fill(v));
    }
    const shift = k => { if (k.frame >= at) k.frame += n; };
    project.camera.keyframes.forEach(shift);
    for (const l of project.layers) if (l.transform && l.transform.keyframes) l.transform.keyframes.forEach(shift);
    project.frameCount += n;
  }
  // Remove n frames at `at`; keys inside the range go, later keys move up.
  function removeFrames(project, at, n) {
    for (const l of project.layers) if (l.exposure) l.exposure.splice(at, n);
    const keep = ks => ks.filter(k => k.frame < at || k.frame >= at + n)
      .map(k => (k.frame >= at + n ? Object.assign({}, k, { frame: k.frame - n }) : k));
    project.camera.keyframes = keep(project.camera.keyframes);
    for (const l of project.layers) if (l.transform && l.transform.keyframes) l.transform.keyframes = keep(l.transform.keyframes);
    project.frameCount -= n;
  }
  function cloneCel(layer, src) {
    const num = layer.nextNum++;
    const c = new OT.Cel(num, src.w, src.h, src.kind);
    if (src.kind === 'vector') {
      c.strokes = JSON.parse(JSON.stringify(src.strokes || []));
      c.eraserMarks = JSON.parse(JSON.stringify(src.eraserMarks || []));
      c.rebuild();
    } else {
      c.ctx.drawImage(src.canvas, 0, 0);
      c.dirty();
    }
    layer.cels[num] = c;
    return num;
  }

  /* ------------------------------ ops ------------------------------ */
  // All on the app; each is one undo step.
  const Ops = {
    current(app) { return app.project.board ? spanAt(app.project.board, app.frame) : null; },

    newPanel(app) {
      const b = app.project.board; if (!b) return;
      const cur = spanAt(b, app.frame);
      const d = defaultDuration(app.project);
      app.doStruct('New panel', () => {
        insertFrames(app.project, cur.end + 1, d, () => 0);
        b.panels.splice(cur.index + 1, 0, newPanel(cur.panel.scene, d));
      });
      app.setFrame(cur.end + 1);
    },

    duplicatePanel(app) {
      const b = app.project.board; if (!b) return;
      const cur = spanAt(b, app.frame);
      app.doStruct('Duplicate panel', () => {
        const map = new Map();
        for (const l of app.project.layers) {
          const src = l.celAt ? l.celAt(cur.start) : null;
          map.set(l, src ? cloneCel(l, src) : 0);
        }
        insertFrames(app.project, cur.end + 1, cur.panel.duration, l => map.get(l) || 0);
        const p = Object.assign(newPanel(cur.panel.scene, cur.panel.duration), {
          dialogue: cur.panel.dialogue, action: cur.panel.action, notes: cur.panel.notes, transition: cur.panel.transition
        });
        b.panels.splice(cur.index + 1, 0, p);
      });
      app.setFrame(cur.end + 1);
    },

    deletePanel(app) {
      const b = app.project.board; if (!b) return;
      if (b.panels.length <= 1) { app.ui.status('A storyboard keeps at least one panel'); return; }
      const cur = spanAt(b, app.frame);
      app.doStruct('Delete panel', () => {
        removeFrames(app.project, cur.start, cur.panel.duration);
        b.panels.splice(cur.index, 1);
        b.scenes = b.scenes.filter(s => b.panels.some(p => p.scene === s.id));
      });
      app.setFrame(Math.min(cur.start, app.project.frameCount - 1));
    },

    setDuration(app, frames) {
      const b = app.project.board; if (!b) return;
      frames = Math.max(1, Math.round(frames));
      const cur = spanAt(b, app.frame);
      const delta = frames - cur.panel.duration;
      if (!delta) return;
      app.doStruct('Panel duration', () => {
        if (delta > 0) insertFrames(app.project, cur.end + 1, delta, l => l.exposure[cur.end] || 0);
        else removeFrames(app.project, cur.start + frames, -delta);
        cur.panel.duration = frames;
      });
      app.setFrame(Math.min(app.frame, cur.start + frames - 1));
    },

    // Move panel `from` so it ends up at index `to` (in the list without it).
    movePanel(app, from, to) {
      const b = app.project.board; if (!b) return;
      const n = b.panels.length;
      if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
      app.doStruct('Move panel', () => {
        const sp = spans(b)[from];
        const p = b.panels[from], len = p.duration;
        const slices = new Map(app.project.layers.map(l => [l, (l.exposure || []).slice(sp.start, sp.end + 1)]));
        const inRange = k => k.frame >= sp.start && k.frame <= sp.end;
        const cam = app.project.camera.keyframes.filter(inRange).map(k => Object.assign({}, k, { frame: k.frame - sp.start }));
        const tr = new Map(app.project.layers.map(l => [l, (l.transform ? l.transform.keyframes : []).filter(inRange)
          .map(k => Object.assign({}, k, { frame: k.frame - sp.start }))]));
        removeFrames(app.project, sp.start, len);
        b.panels.splice(from, 1);
        b.panels.splice(to, 0, p);
        // a panel moved next to another scene's panels joins that scene
        const nb = b.panels[to - 1] || b.panels[to + 1];
        const prev = b.panels[to - 1], next = b.panels[to + 1];
        if (!(prev && prev.scene === p.scene) && !(next && next.scene === p.scene)) p.scene = nb.scene;
        const at = spans(b)[to].start;
        let i = 0;
        insertFrames(app.project, at, len, () => 0);
        for (const l of app.project.layers) {
          const s = slices.get(l) || [];
          for (i = 0; i < len; i++) l.exposure[at + i] = s[i] || 0;
          if (l.transform) for (const k of tr.get(l) || []) l.transform.keyframes.push(Object.assign(k, { frame: k.frame + at }));
        }
        for (const k of cam) app.project.camera.keyframes.push(Object.assign(k, { frame: k.frame + at }));
        b.scenes = normalizeScenes(b);
      });
      app.setFrame(spans(b)[to].start);
    },

    // New scene: one new panel after the current scene's last panel.
    newScene(app) {
      const b = app.project.board; if (!b) return;
      const cur = spanAt(b, app.frame);
      const all = spans(b);
      let last = cur.index;
      while (last + 1 < all.length && all[last + 1].panel.scene === cur.panel.scene) last++;
      const d = defaultDuration(app.project);
      const at = all[last].end + 1;
      app.doStruct('New scene', () => {
        const s = { id: U.uid(), name: String(b.scenes.length + 1) };
        insertFrames(app.project, at, d, () => 0);
        b.panels.splice(last + 1, 0, newPanel(s.id, d));
        b.scenes = normalizeScenes(b, s);
      });
      app.setFrame(at);
    },

    renameScene(app, name) {
      const cur = Ops.current(app); if (!cur) return;
      const s = app.project.board.scenes.find(x => x.id === cur.panel.scene);
      if (!s || !name || s.name === name) return;
      app.doStruct('Rename scene', () => { s.name = String(name); });
    },

    setText(app, field, value) {
      const cur = Ops.current(app); if (!cur || FIELDS.concat(['transition']).indexOf(field) < 0) return;
      if (cur.panel[field] === value) return;
      cur.panel[field] = value;
      app.dirty = true;
      app.emit('boardchange');
    },

    go(app, delta) {
      const b = app.project.board; if (!b) return;
      const all = spans(b);
      const cur = spanAt(b, app.frame);
      const i = U.clamp(cur.index + delta, 0, all.length - 1);
      app.setFrame(all[i].start);
    },
    goTo(app, index) {
      const b = app.project.board; if (!b) return;
      const s = spans(b)[index];
      if (s) app.setFrame(s.start);
    }
  };

  // Animate <-> Storyboard. One undo step; nothing is thrown away.
  function setMode(app, storyboard) {
    const p = app.project;
    if (storyboard && !p.board) { app.doStruct('Storyboard mode', () => create(p)); }
    else if (p.board && !!p.board.hidden === !storyboard) return;
    else app.doStruct(storyboard ? 'Storyboard mode' : 'Animation mode', () => {
      if (storyboard) { delete p.board.hidden; normalize(p); } else p.board.hidden = true;
    });
    app.ui.status(storyboard ? 'Storyboard mode' : 'Animation mode: panels are kept; switch back any time');
    app.emit('boardchange');
  }

  // The Animate | Storyboard switch at the right of the menu bar, shown for
  // any project that has a storyboard (re-attached when the menu rebuilds).
  function attachSwitch(app) {
    const bar = document.getElementById('menubar');
    if (!bar || !app.project) return;
    let sw = bar.querySelector('.fz-mode-switch');
    if (!app.project.board) { if (sw) sw.remove(); return; }
    if (!sw) {
      sw = el('div', { class: 'fz-mode-switch', role: 'group', 'aria-label': 'Mode' });
      const mk = (label, mode, tip) => {
        const b = el('button', { type: 'button', class: 'fz-mode-btn', 'data-mode': mode, title: tip }, [label]);
        b.addEventListener('click', e => { e.stopPropagation(); setMode(app, mode === 'board'); });
        return b;
      };
      sw.appendChild(mk('Animate', 'anim', 'Animation mode: frames and drawings, no panel strip'));
      sw.appendChild(mk('Storyboard', 'board', 'Storyboard mode: panels, captions, animatic'));
      bar.appendChild(sw);
    }
    const isOn = on(app.project);
    for (const b of sw.querySelectorAll('.fz-mode-btn')) b.classList.toggle('is-on', (b.dataset.mode === 'board') === isOn);
  }

  function normalizeScenes(b, extra) {
    const known = b.scenes.concat(extra ? [extra] : []);
    const order = [];
    for (const p of b.panels) if (order.indexOf(p.scene) < 0) order.push(p.scene);
    return order.map(id => known.find(s => s.id === id)).filter(Boolean);
  }

  // Layer.drawingAt: drawing on an empty layer exposes the drawing for the
  // whole panel under that frame.
  OT.boardSpan = function (frame) {
    const app = OT.app;
    if (!app || !on(app.project)) return null;
    const b = app.project.board;
    const s = spanAt(b, frame);
    return [s.start, s.end];
  };

  /* --------------------------- thumbnails --------------------------- */
  class Thumbs {
    constructor(app) {
      this.app = app;
      this.cache = new Map();     // panel id -> { key, url }
      this.h = 72;
    }
    key(span) {
      // changes when any drawing exposed at the panel's first frame changes
      const p = this.app.project, f = span.start;
      let k = p.width + 'x' + p.height + ':' + p.bg;
      for (const l of p.layers) {
        if (!l.visible) continue;
        const c = l.celAt ? l.celAt(f) : null;
        k += '|' + l.id + ':' + (c ? c.num + '.' + (c._rev || 0) + '.' + (c._stamp || 0) + '.' + (c.strokes ? c.strokes.length : 0) : 0);
      }
      return k;
    }
    url(span) {
      const k = this.key(span);
      const hit = this.cache.get(span.panel.id);
      if (hit && hit.key === k) return hit.url;
      const p = this.app.project;
      const w = Math.max(1, Math.round(this.h * p.width / p.height));
      let url = '';
      try { url = OT.IO.renderFrame(this.app, span.start, w * 2, this.h * 2).toDataURL('image/jpeg', 0.8); } catch (e) { url = ''; }
      this.cache.set(span.panel.id, { key: k, url });
      return url;
    }
  }

  /* --------------------------- the strip --------------------------- */
  // The panel strip across the top, as in Storyboard Pro's Thumbnails view.
  class Strip {
    constructor(app) {
      this.app = app;
      this.thumbs = new Thumbs(app);
      this.root = document.getElementById('boardstrip');
      this._raf = 0;
      this._timer = 0;
      const r = () => this.schedule();
      app.on('projectchange', r);
      app.on('framechange', () => this.markCurrent());
      app.on('layerschange', r);
      app.on('boardchange', r);
      // drawing: refresh the current panel's thumbnail once the stroke settles
      app.on('celchange', () => this.scheduleSoon(400));
    }
    scheduleSoon(ms) {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.schedule(), ms);
    }
    schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
    }
    markCurrent() {
      const b = this.app.project.board;
      if (!on(this.app.project) || !this.root) return;
      const cur = spanAt(b, this.app.frame);
      for (const c of this.root.querySelectorAll('.bs-card')) {
        const on = c.dataset.id === cur.panel.id;
        c.classList.toggle('is-current', on);
        if (on && !this._dragging) c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    render() {
      const app = this.app, b = app.project.board;
      document.body.classList.toggle('board-mode', on(app.project));
      attachSwitch(app);
      if (!this.root) return;
      if (!on(app.project)) { this.root.innerHTML = ''; return; }
      const lab = labels(b), fps = app.project.fps || 24;
      const cur = spanAt(b, app.frame);
      const tools = el('div', { class: 'bs-tools' }, [
        btn('+ Panel', 'New panel after this one (N)', () => Ops.newPanel(app), 'bs-new'),
        btn('Duplicate', 'Duplicate this panel and its drawings', () => Ops.duplicatePanel(app)),
        btn('Delete', 'Delete this panel', () => Ops.deletePanel(app)),
        btn('+ Scene', 'Start a new scene after this one', () => Ops.newScene(app))
      ]);
      const list = el('div', { class: 'bs-list' });
      let lastScene = null;
      for (const s of spans(b)) {
        const L = lab.get(s.panel.id);
        const card = el('div', {
          class: 'bs-card' + (s.panel.id === cur.panel.id ? ' is-current' : '') + (s.panel.scene !== lastScene ? ' bs-scene-start' : ''),
          draggable: 'true', title: 'Scene ' + L.scene + ', panel ' + L.panel + (s.panel.dialogue ? '\n' + s.panel.dialogue : '')
        });
        card.dataset.id = s.panel.id;
        card.dataset.index = s.index;
        const img = el('img', { class: 'bs-thumb', alt: '', draggable: 'false' });
        img.src = this.thumbs.url(s);
        img.style.aspectRatio = app.project.width + ' / ' + app.project.height;
        card.appendChild(el('div', { class: 'bs-head' }, [
          el('span', { class: 'bs-num' }, ['S' + L.scene + ' · P' + L.panel]),
          el('span', { class: 'bs-dur' }, [(s.panel.duration / fps).toFixed(1) + 's'])
        ]));
        card.appendChild(img);
        card.appendChild(el('div', { class: 'bs-caption' }, [s.panel.dialogue || s.panel.action || '']));
        if (s.panel.transition !== 'cut') card.appendChild(el('div', { class: 'bs-trans', title: s.panel.transition }, ['⟋']));
        card.addEventListener('click', () => Ops.goTo(app, s.index));
        card.addEventListener('dragstart', e => { this._dragging = s.index; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(s.index)); });
        card.addEventListener('dragend', () => { this._dragging = null; list.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
        card.addEventListener('dragover', e => {
          if (this._dragging == null) return;
          e.preventDefault();
          const r = card.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
          card.classList.toggle('drop-after', after); card.classList.toggle('drop-before', !after);
        });
        card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
        card.addEventListener('drop', e => {
          e.preventDefault();
          const from = this._dragging; this._dragging = null;
          if (from == null) return;
          const r = card.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
          let to = s.index + (after ? 1 : 0);
          if (from < to) to--;
          Ops.movePanel(app, from, to);
        });
        list.appendChild(card);
        lastScene = s.panel.scene;
      }
      this.root.innerHTML = '';
      this.root.appendChild(tools);
      this.root.appendChild(list);
      this.markCurrent();
    }
  }

  function btn(label, title, fn, cls) {
    const b = el('button', { class: 'bs-btn' + (cls ? ' ' + cls : ''), title: title, type: 'button' }, [label]);
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    return b;
  }

  /* ------------------------ panel properties ------------------------ */
  // Sidebar section: scene, panel, duration, dialogue, action, notes, transition.
  class PanelProps {
    constructor(app) {
      this.app = app;
      this.root = document.getElementById('boardpanel');
      const r = () => this.render();
      app.on('projectchange', r);
      app.on('framechange', () => { if (this._shownId !== this._curId()) this.render(); });
      // captions changed elsewhere (undo, scripts): redraw unless being typed in
      app.on('boardchange', () => {
        if (this.root && this.root.contains(document.activeElement)) this.refreshHead();
        else this.render();
      });
      app.on('layerschange', r);
    }
    _curId() { const c = Ops.current(this.app); return c ? c.panel.id : null; }
    refreshHead() {
      if (!this.head) return;
      const c = Ops.current(this.app); if (!c) return;
      const L = labels(this.app.project.board).get(c.panel.id);
      this.head.textContent = 'Scene ' + L.scene + ' · Panel ' + L.panel;
    }
    render() {
      const app = this.app, b = app.project.board;
      if (!this.root) return;
      this.root.innerHTML = '';
      if (!on(app.project)) return;
      const c = Ops.current(app);
      this._shownId = c.panel.id;
      const L = labels(b).get(c.panel.id);
      const fps = app.project.fps || 24;
      const scene = b.scenes.find(s => s.id === c.panel.scene);
      this.head = el('span', {}, ['Scene ' + L.scene + ' · Panel ' + L.panel]);
      this.root.appendChild(el('div', { class: 'panel-head' }, [this.head]));
      const body = el('div', { class: 'panel-body' });
      this.root.appendChild(body);

      const sceneIn = el('input', { type: 'text', class: 'bp-input', value: scene ? scene.name : '' });
      sceneIn.addEventListener('change', () => Ops.renameScene(app, sceneIn.value.trim()));
      const durIn = el('input', { type: 'number', class: 'bp-input bp-num', min: '0.1', step: '0.1', value: (c.panel.duration / fps).toFixed(2) });
      durIn.addEventListener('change', () => Ops.setDuration(app, Math.max(1, Math.round(parseFloat(durIn.value || '0') * fps))));
      const frIn = el('input', { type: 'number', class: 'bp-input bp-num', min: '1', step: '1', value: String(c.panel.duration) });
      frIn.addEventListener('change', () => Ops.setDuration(app, parseInt(frIn.value || '1', 10)));
      const trans = el('select', { class: 'bp-input' }, TRANSITIONS.map(t => el('option', { value: t }, [t[0].toUpperCase() + t.slice(1)])));
      trans.value = c.panel.transition;
      trans.addEventListener('change', () => Ops.setText(app, 'transition', trans.value));

      const grid = el('div', { class: 'bp-grid' }, [
        el('label', {}, ['Scene']), sceneIn,
        el('label', {}, ['Duration']), el('div', { class: 'bp-dur' }, [durIn, el('span', {}, ['s']), frIn, el('span', {}, ['fr'])]),
        el('label', {}, ['Transition']), trans
      ]);
      body.appendChild(grid);
      const area = (field, label, ph) => {
        const t = el('textarea', { class: 'bp-text', rows: '2', placeholder: ph });
        t.value = c.panel[field] || '';
        t.addEventListener('input', () => Ops.setText(app, field, t.value));
        // typing in a caption must not trigger drawing shortcuts
        t.addEventListener('keydown', e => e.stopPropagation());
        return el('div', { class: 'bp-field' }, [el('div', { class: 'bp-label' }, [label]), t]);
      };
      body.appendChild(area('dialogue', 'Dialogue', 'What is said…'));
      body.appendChild(area('action', 'Action Notes', 'What happens…'));
      body.appendChild(area('notes', 'Notes', 'Camera, sound, slugging…'));
      for (const i of [sceneIn, durIn, frIn]) i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
    }
  }

  /* ----------------------------- install ----------------------------- */
  function install(app) {
    app.board = { strip: new Strip(app), props: new PanelProps(app), ops: Ops };
    app.board.strip.render();
    app.board.props.render();
  }

  OT.Board = { create, normalize, spans, spanAt, labels, insertFrames, removeFrames, Ops, install, defaultDuration, on, setMode, attachSwitch };
})(window.OT = window.OT || {});
