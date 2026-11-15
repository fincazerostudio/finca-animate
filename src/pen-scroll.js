/* Scrolling with the pen.
 *
 * A pen in Chromium is a mouse with no wheel, so long panels could only be
 * scrolled by hitting a thin scrollbar. Two gestures, for pen and touch:
 *   - drag on empty space inside a scrolling area (sidebar, panel strip,
 *     layer list, menus, dialogs) scrolls it, like a phone. Controls keep
 *     their own drags: inputs, sliders, buttons, canvases (stage, colour
 *     picker, timeline) and draggable rows (layers, panels).
 *   - hold the pen's side button and drag: scrolls whatever is under the
 *     pen, the timeline included.
 * A press that does not travel 6 px is a normal tap.
 */
(function (OT) {
  'use strict';
  const THRESHOLD = 6;
  const SKIP = 'input,textarea,select,button,a,canvas,video,[draggable="true"],[contenteditable="true"],.no-pen-scroll';
  let s = null;   // { el, x, y, top, left, active, pid, barrel }

  function scrollable(el, axis) {
    const cs = getComputedStyle(el);
    if (axis === 'y') return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4;
    return /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 4;
  }
  // nearest ancestor that scrolls on either axis
  function scroller(from) {
    for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
      if (el.nodeType === 1 && (scrollable(el, 'y') || scrollable(el, 'x'))) return el;
    }
    return null;
  }

  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'pen' && e.pointerType !== 'touch') return;
    // side (barrel) buttons arrive as the right or middle button
    const barrel = e.pointerType === 'pen' && (e.button === 2 || e.button === 1 || (e.buttons & 6) !== 0);
    if (!barrel && (e.button !== 0 || (e.target.closest && e.target.closest(SKIP)))) return;
    const el = scroller(e.target);
    if (!el) return;
    s = { el, x: e.clientX, y: e.clientY, top: el.scrollTop, left: el.scrollLeft, active: false, pid: e.pointerId, barrel };
  }, true);

  document.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.pid) return;
    if (OT.PenDnD && OT.PenDnD.active()) { s = null; return; }
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.active) {
      if (Math.hypot(dx, dy) < THRESHOLD) return;
      s.active = true;
      document.body.classList.add('pen-scrolling');
    }
    e.preventDefault();
    const wantTop = s.top - dy, wantLeft = s.left - dx;
    s.el.scrollTop = wantTop;
    s.el.scrollLeft = wantLeft;
    // at its end: hand the drag on to the next scrolling area out, as phones do
    // only along the way the pen is mostly going, so a wobble sideways does not
    // jump to another area
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const stuckY = vertical && Math.abs(s.el.scrollTop - wantTop) > 1;
    const stuckX = !vertical && Math.abs(s.el.scrollLeft - wantLeft) > 1;
    if ((stuckY || stuckX) && s.el.parentElement) {
      const outer = scroller(s.el.parentElement);
      if (outer) { s.el = outer; s.x = e.clientX; s.y = e.clientY; s.top = outer.scrollTop; s.left = outer.scrollLeft; }
    }
  }, { capture: true, passive: false });

  function finish(e) {
    if (!s || e.pointerId !== s.pid) return;
    const st = s; s = null;
    if (!st.active) return;
    document.body.classList.remove('pen-scrolling');
    // the lift that ends a scroll is not a click (or a right-click menu)
    const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', eat, { capture: true, once: true });
    window.addEventListener('contextmenu', eat, { capture: true, once: true });
    setTimeout(() => { window.removeEventListener('click', eat, true); window.removeEventListener('contextmenu', eat, true); }, 0);
  }
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
  // a barrel-button press opens the context menu on some systems: not while scrolling
  document.addEventListener('contextmenu', e => { if (s && s.active) { e.preventDefault(); e.stopPropagation(); } }, true);

  OT.PenScroll = { active: () => !!(s && s.active) };
})(window.OT = window.OT || {});
