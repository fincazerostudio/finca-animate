/* OpenToon Studio - shared stroke finalize pipeline.

   Both the main brush/pencil tools and the pen window's wet-stroke
   handler call into this module so the wet preview and the committed
   stroke produce IDENTICAL pts -- which is what eliminates the
   "settle" visible on commit today.

   All exports are pure: no `this`, no DOM, no `app`, no mutation of
   inputs. The pen window depends on this so the per-rAF finalize
   doesn't accidentally mutate state shared with main. */
(function (OT) {
  'use strict';

  // ---------------- One Euro filter ----------------
  // Adaptive lowpass on (x, y, pressure). Cutoff drops at low speed
  // (kills tablet jitter) and rises at high speed (no lag during fast
  // confident strokes). This is the same smoothing the brush/pencil
  // tools apply mid-stroke on main; lifted here so the pen window can
  // run the same filter on its raw input -- otherwise pen's wet preview
  // sees raw-cursor and main's commit sees One-Euro-smoothed, and they
  // produce different finalize outputs (visible "settle" on commit).
  class OneEuroFilter {
    constructor(mincutoff, beta, dcutoff) {
      this.mincutoff = mincutoff != null ? mincutoff : 1.0;
      this.beta = beta != null ? beta : 0.0;
      this.dcutoff = dcutoff != null ? dcutoff : 1.0;
      this.xPrev = null; this.dxPrev = 0; this.tPrev = null;
    }
    setParams(mincutoff, beta, dcutoff) {
      this.mincutoff = mincutoff;
      this.beta = beta;
      if (dcutoff != null) this.dcutoff = dcutoff;
    }
    reset(x, t) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = t;
    }
    _alpha(cutoff, dt) {
      const tau = 1.0 / (2 * Math.PI * cutoff);
      return 1.0 / (1.0 + tau / dt);
    }
    filter(x, t) {
      if (this.xPrev == null || this.tPrev == null) {
        this.xPrev = x; this.tPrev = t; this.dxPrev = 0;
        return x;
      }
      let dt = t - this.tPrev;
      if (!(dt > 0)) dt = 0.016;
      if (dt < 0.0005) dt = 0.0005;
      const dxRaw = (x - this.xPrev) / dt;
      const aD = this._alpha(this.dcutoff, dt);
      const dxSmoothed = aD * dxRaw + (1 - aD) * this.dxPrev;
      const cutoff = this.mincutoff + this.beta * Math.abs(dxSmoothed);
      const aX = this._alpha(cutoff, dt);
      const xSmoothed = aX * x + (1 - aX) * this.xPrev;
      this.xPrev = xSmoothed;
      this.dxPrev = dxSmoothed;
      this.tPrev = t;
      return xSmoothed;
    }
  }

  // Live stabilising while the pen moves. At low settings it stays out of the
  // way (no lag); towards 1 it holds the line steady even on fast strokes,
  // like a stabiliser. (The old curve kept beta high, so at drawing speed
  // even Smoothing 1 filtered almost nothing.)
  function oneEuroParams(smooth) {
    const s = Math.max(0, Math.min(1, smooth || 0));
    const mincutoff = 2.0 + (0.12 - 2.0) * s;
    const beta = 0.05 * (1 - s) * (1 - s) + 0.0008 * s;
    return { mincutoff, beta, dcutoff: 1.0 };
  }

  // Smooth a finished stroke by distance along the line (Harmony's
  // smoothness): resample evenly, then a Gaussian average whose width grows
  // with the setting. Measured in drawing pixels, so it behaves the same at
  // any pen report rate. The window shrinks near the ends, so the ends stay
  // where the pen put them. 0 returns the stroke untouched.
  function smoothStroke(pts, smooth) {
    const s = Math.max(0, Math.min(1, smooth || 0));
    if (s < 0.02 || !pts || pts.length < 4) return pts;
    const sigma = 0.6 + 14 * s * s;                    // drawing px
    const step = Math.max(0.75, sigma / 4);
    // resample at an even step, carrying pressure and time
    const res = [Object.assign({}, pts[0])];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (!seg) continue;
      let d = step - carry;
      while (d <= seg) {
        const k = d / seg;
        res.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k,
          p: (a.p == null ? 1 : a.p) + (((b.p == null ? 1 : b.p)) - (a.p == null ? 1 : a.p)) * k,
          t: a.t != null && b.t != null ? a.t + (b.t - a.t) * k : b.t });
        d += step;
      }
      carry = seg - (d - step);
    }
    const last = pts[pts.length - 1];
    if (Math.hypot(res[res.length - 1].x - last.x, res[res.length - 1].y - last.y) > 0.01) res.push(Object.assign({}, last));
    const n = res.length;
    if (n < 4) return pts;
    const r = Math.ceil((3 * sigma) / step);
    const w = [];
    for (let k = 0; k <= r; k++) w.push(Math.exp(-0.5 * Math.pow((k * step) / sigma, 2)));
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const lim = Math.min(r, i, n - 1 - i);           // symmetric: ends stay put
      let sx = 0, sy = 0, sp = 0, sw = 0;
      for (let k = -lim; k <= lim; k++) {
        const q = res[i + k], wk = w[Math.abs(k)];
        sx += q.x * wk; sy += q.y * wk; sp += (q.p == null ? 1 : q.p) * wk; sw += wk;
      }
      out[i] = { x: sx / sw, y: sy / sw, p: sp / sw, t: res[i].t };
    }
    return out;
  }

  // Initialize a 3-axis One Euro filter set on a "tool-like" target with
  // `_oneEuroX/_oneEuroY/_oneEuroP` fields and a `smooth` number in [0,1].
  // Both main's tool instances and the pen's wetStroke object qualify.
  function initOneEuro(target, pt) {
    const t = performance.now() / 1000;
    const params = oneEuroParams(target.smooth);
    target._oneEuroX = new OneEuroFilter(params.mincutoff, params.beta, params.dcutoff);
    target._oneEuroY = new OneEuroFilter(params.mincutoff, params.beta, params.dcutoff);
    target._oneEuroP = new OneEuroFilter(params.mincutoff, params.beta, params.dcutoff);
    target._oneEuroX.reset(pt.x, t);
    target._oneEuroY.reset(pt.y, t);
    target._oneEuroP.reset(pt.pressure != null ? pt.pressure : 1, t);
  }

  // Apply current smoothing params and filter (x, y, pressure). Returns
  // a NEW {x, y, p} object -- does not mutate the input pt.
  function applyOneEuro(target, pt) {
    const t = performance.now() / 1000;
    const params = oneEuroParams(target.smooth);
    target._oneEuroX.setParams(params.mincutoff, params.beta, params.dcutoff);
    target._oneEuroY.setParams(params.mincutoff, params.beta, params.dcutoff);
    target._oneEuroP.setParams(params.mincutoff, params.beta, params.dcutoff);
    const sx = target._oneEuroX.filter(pt.x, t);
    const sy = target._oneEuroY.filter(pt.y, t);
    const sp = target._oneEuroP.filter(pt.pressure != null ? pt.pressure : 1, t);
    return { x: sx, y: sy, p: sp };
  }

  // Back-compat exports (tools.js previously exposed these on OT directly).
  OT.OneEuroFilter = OneEuroFilter;
  OT.oneEuroParams = oneEuroParams;

  // Ink-pen velocity dynamics. Scales each point's pressure by a factor
  // that shrinks with stroke speed. Returns a NEW pts array with new
  // point objects -- does NOT mutate the input. Requires `.t` timestamps
  // in ms on each point (set by the tool's _vMove). Points without `.t`
  // are passed through unmodified.
  function applyInkDynamics(pts) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const out = new Array(n);
    const speed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dt = (b.t - a.t) || 1;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      speed[i] = d / Math.max(0.5, dt);
    }
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = speed[Math.max(0, i - 1)], b = speed[i], c = speed[Math.min(n - 1, i + 1)];
      sm[i] = (a + 2 * b + c) * 0.25;
    }
    const k = 0.2, lo = 0.45;
    for (let i = 0; i < n; i++) {
      const m = Math.max(lo, Math.min(1, 1 - k * sm[i]));
      const src = pts[i];
      const p = src.p == null ? 1 : src.p;
      out[i] = { x: src.x, y: src.y, t: src.t, p: p * m };
    }
    return out;
  }

  // Nearest line-stroke endpoint within `radius`. Mirrors OT.Vector's
  // snapPoint but returns a NEW pts array with first/last point moved
  // to the snap targets (if found). Does not mutate input. `cel` must
  // have a `strokes` array; if cel is null the input passes through.
  function snapEndpoints(pts, cel, radius) {
    if (!cel || !cel.strokes || pts.length < 2 || radius <= 0) return pts;
    const V = OT.Vector;
    if (!V || !V.snapPoint) return pts;
    const first = pts[0], last = pts[pts.length - 1];
    const s0 = V.snapPoint(cel, first.x, first.y, radius);
    const sN = V.snapPoint(cel, last.x, last.y, radius);
    if (!s0 && !sN) return pts;
    const out = pts.slice();
    if (s0) out[0] = { x: s0.x, y: s0.y, p: first.p, t: first.t };
    if (sN) out[out.length - 1] = { x: sN.x, y: sN.y, p: last.p, t: last.t };
    return out;
  }

  // If first/last points are within `radius`, set last := first and
  // return closed=true. Otherwise return closed=false and pts unchanged.
  // Returns `{ pts, closed }`. Requires pts.length > 3 to avoid closing
  // tiny tick marks the artist didn't mean to loop.
  function maybeAutoClose(pts, radius) {
    if (pts.length <= 3 || radius <= 0) return { pts, closed: false };
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) >= radius * 1.3) return { pts, closed: false };
    const out = pts.slice();
    out[out.length - 1] = { x: a.x, y: a.y, p: b.p, t: b.t };
    return { pts: out, closed: true };
  }

  // The full finalize pipeline. Apply in order:
  //   inkDynamics (opt-in)  ->  simplify  ->  snapEndpoints (when cel given)
  //   ->  maybeAutoClose (opt-in)
  //
  // Deterministic and idempotent: finalize(finalize(x).pts).pts has the
  // same shape as finalize(x).pts. Calling per-rAF during a drag and
  // once more at commit produces the SAME pts both times -- which is
  // the entire point of the module.
  //
  // opts: {
  //   tol:         number  (RDP simplify tolerance, e.g. 0.4 + smooth*0.8)
  //   snapDist:    number  (endpoint snap radius)
  //   inkDynamics: bool
  //   autoClose:   bool
  //   cel:         Cel | null  (only used by snapEndpoints; pen window
  //                              passes its mirrored cel; main passes
  //                              the active cel)
  // }
  function finalize(rawPts, opts) {
    if (!rawPts || rawPts.length === 0) return { pts: [], closed: false };
    opts = opts || {};
    const V = OT.Vector;
    let pts = rawPts;
    if (opts.inkDynamics) pts = applyInkDynamics(pts);
    if (opts.smooth) pts = smoothStroke(pts, opts.smooth);
    if (V && V.simplify && opts.tol != null) {
      pts = V.simplify(pts, opts.tol);
      if (pts.length < 2 && rawPts.length >= 2) pts = rawPts.slice(0, 2);
    }
    if (opts.cel && opts.snapDist) pts = snapEndpoints(pts, opts.cel, opts.snapDist);
    let closed = false;
    if (opts.autoClose && opts.snapDist) {
      const ac = maybeAutoClose(pts, opts.snapDist);
      pts = ac.pts; closed = ac.closed;
    }
    return { pts, closed };
  }

  OT.StrokeFinalize = {
    applyInkDynamics, snapEndpoints, maybeAutoClose, finalize, smoothStroke,
    OneEuroFilter, oneEuroParams, initOneEuro, applyOneEuro
  };
})(window.OT = window.OT || {});
