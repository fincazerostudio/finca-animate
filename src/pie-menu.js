/* Pie menu: a ring of tools around the pen tip, for switching without
 * leaving the canvas.
 *
 * Opens on a tap of the pen's side button on the canvas (the side button
 * still pans when dragged), or with the Q key at the pointer. Tap an item to
 * use it; tap the centre, outside, or press Esc to close.
 */
(function (OT) {
  'use strict';
  const U = OT.util, el = U.el;
  const R = 92;                 // ring radius, px
  const TAP_PX = 6, TAP_MS = 450;

  const ARROW = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const UNDO = ARROW('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>');
  const REDO = ARROW('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>');

  class PieMenu {
    constructor(app) {
      this.app = app;
      this.root = null;
      this.last = { x: innerWidth / 2, y: innerHeight / 2 };
      // the pointer's last spot, for the keyboard shortcut
      window.addEventListener('pointermove', e => { this.last = { x: e.clientX, y: e.clientY }; }, { passive: true });
      // a side-button tap on the canvas (a drag stays a pan)
      const cv = document.getElementById('canvas');
      let down = null;
      cv.addEventListener('pointerdown', e => {
        if (e.pointerType === 'pen' && (e.button === 2 || e.button === 1)) down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
      }, true);
      window.addEventListener('pointerup', e => {
        if (!down || e.pointerId !== down.id) return;
        const d = down; down = null;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= TAP_PX && performance.now() - d.t <= TAP_MS) this.open(d.x, d.y);
      }, true);
      cv.addEventListener('contextmenu', e => { if (this.root) e.preventDefault(); });
    }
    items() {
      const a = this.app, tb = (a.ui && a.ui.toolBtns) || {};
      const tool = (name, label, key) => ({ label, key, icon: tb[name] ? tb[name].innerHTML : '', on: a.tools.active.name === name, run: () => a.tools.select(name) });
      return [
        tool('brush', 'Brush', 'B'), tool('pencil', 'Pencil', 'P'), tool('eraser', 'Eraser', 'E'),
        { label: 'Redo', key: 'Ctrl+Y', icon: REDO, run: () => a.redo() },
        tool('fill', 'Paint Bucket', 'K'), tool('eyedropper', 'Eyedropper', 'I'), tool('lasso', 'Lasso', 'L'),
        { label: 'Undo', key: 'Ctrl+Z', icon: UNDO, run: () => a.undo() }
      ];
    }
    open(x, y) {
      this.close();
      const items = this.items();
      // keep the whole ring on screen
      const pad = R + 34;
      x = U.clamp(x, pad, innerWidth - pad); y = U.clamp(y, pad, innerHeight - pad);
      const root = el('div', { class: 'pie', role: 'menu', 'aria-label': 'Tools' });
      root.style.left = x + 'px'; root.style.top = y + 'px';
      const label = el('div', { class: 'pie-label' }, ['Tools']);
      const centre = el('button', { class: 'pie-centre', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close' }, [label]);
      centre.addEventListener('click', e => { e.stopPropagation(); this.close(); });
      root.appendChild(centre);
      items.forEach((it, i) => {
        const ang = -Math.PI / 2 + i * (2 * Math.PI / items.length);   // first item at the top
        const b = el('button', { class: 'pie-item' + (it.on ? ' is-on' : ''), type: 'button', role: 'menuitem',
          title: it.label + '  (' + it.key + ')', 'aria-label': it.label, html: it.icon });
        b.style.left = Math.cos(ang) * R + 'px'; b.style.top = Math.sin(ang) * R + 'px';
        b.addEventListener('pointerenter', () => { label.textContent = it.label; });
        b.addEventListener('pointerleave', () => { label.textContent = 'Tools'; });
        b.addEventListener('click', e => { e.stopPropagation(); this.close(); it.run(); });
        root.appendChild(b);
      });
      document.body.appendChild(root);
      this.root = root;
      requestAnimationFrame(() => root.classList.add('is-open'));
      // close on a tap outside or Esc
      this._outside = e => { if (this.root && !this.root.contains(e.target)) { this.close(); } };
      this._key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } };
      setTimeout(() => {
        window.addEventListener('pointerdown', this._outside, true);
        window.addEventListener('keydown', this._key, true);
      }, 0);
    }
    openAtPointer() { this.open(this.last.x, this.last.y); }
    close() {
      if (!this.root) return;
      this.root.remove(); this.root = null;
      window.removeEventListener('pointerdown', this._outside, true);
      window.removeEventListener('keydown', this._key, true);
    }
    get isOpen() { return !!this.root; }
  }

  OT.PieMenu = { install(app) { app.pie = new PieMenu(app); return app.pie; } };
})(window.OT = window.OT || {});
