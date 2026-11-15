/* Pen (and touch) drag-and-drop for [draggable] elements.
 *
 * Chromium only starts HTML5 drag-and-drop from a mouse: a pen on Wayland
 * presses, moves and lifts without one, so layers, timeline rows and
 * storyboard panels could not be reordered with the pen. This shim watches
 * pen / touch presses on draggable elements and, once the pen has moved a
 * few pixels, sends the same dragstart / dragover / drop / dragend events a
 * mouse drag would (with a real DataTransfer), so every existing drag handler
 * works unchanged. A real browser drag, if one does start, wins.
 */
(function (OT) {
  'use strict';
  const THRESHOLD = 6;     // px of travel before a press becomes a drag
  let s = null;            // { src, id, x, y, dt, over, active }

  function fire(target, type, e, dt) {
    if (!target) return null;
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      dataTransfer: dt
    });
    target.dispatchEvent(ev);
    return ev;
  }
  const under = e => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el.closest('[draggable="true"]') || el;
  };

  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'pen' && e.pointerType !== 'touch') return;
    if (e.button !== 0) return;
    const src = e.target.closest && e.target.closest('[draggable="true"]');
    if (!src || e.target.closest('input,textarea,select,button')) return;
    s = { src, x: e.clientX, y: e.clientY, dt: null, over: null, active: false, pid: e.pointerId };
  }, true);

  // a genuine drag started by the browser: leave it alone
  document.addEventListener('dragstart', e => { if (e.isTrusted && s) s = null; }, true);

  document.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.pid) return;
    if (!s.active) {
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < THRESHOLD) return;
      s.active = true;
      s.dt = new DataTransfer();
      s.dt.effectAllowed = 'move';
      fire(s.src, 'dragstart', e, s.dt);
      document.body.classList.add('pen-dragging');
    }
    e.preventDefault();
    const t = under(e);
    if (t !== s.over) {
      if (s.over) fire(s.over, 'dragleave', e, s.dt);
      s.over = t;
      if (t) fire(t, 'dragenter', e, s.dt);
    }
    if (t) fire(t, 'dragover', e, s.dt);
  }, { capture: true, passive: false });

  function finish(e, drop) {
    if (!s || e.pointerId !== s.pid) return;
    const st = s; s = null;
    if (!st.active) return;
    document.body.classList.remove('pen-dragging');
    const t = drop ? under(e) : null;
    if (t) fire(t, 'drop', e, st.dt);
    fire(st.src, 'dragend', e, st.dt);
    // the lift that ended a drag is not a click on whatever is underneath
    const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', eat, true), 0);
  }
  document.addEventListener('pointerup', e => finish(e, true), true);
  document.addEventListener('pointercancel', e => finish(e, false), true);

  OT.PenDnD = { active: () => !!(s && s.active) };
})(window.OT = window.OT || {});
