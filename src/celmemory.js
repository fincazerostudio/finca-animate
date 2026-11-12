/* =====================================================================
   OpenToon - cel memory budget
   Every cel's full-resolution surface costs width x height x 4 bytes
   (about 8 MB at 1080p). Cels allocate it lazily (see OT.Cel in core.js)
   and can give it back:
     - a vector cel's strokes are the drawing; its surface is only a cache
     - a raster cel can be "parked": its pixels live on as compressed PNG,
       either in the open .finca file (unchanged since it was loaded or
       saved) or in memory (encoded here first, when it was drawn on), and
       are decoded again when the cel is next shown (OT.Cel.load).
   This module keeps the surfaces under a budget: when they go over it,
   the ones furthest from the playhead (then least recently used) go first.

   Never released: any cel exposed on the current frame, raster cels within
   a few frames of it, and anything at all while a stroke is in progress.
   ===================================================================== */
(function (OT) {
  'use strict';

  const DEFAULT_BUDGET_MB = 1024;
  const MIN_INTERVAL_MS = 400;
  const RASTER_KEEP_NEAR = 2;       // frames around the playhead that stay decoded
  const MAX_ENCODES = 6;            // PNG encodes started per pass

  function allCels(project) {
    const out = [];
    for (const l of (project && project.layers) || []) {
      if (!l.cels) continue;
      for (const num in l.cels) { const c = l.cels[num]; if (c) out.push([l, c]); }
    }
    return out;
  }

  // Frames between `frame` and the nearest exposure of `num` on `layer`.
  function distance(layer, num, frame) {
    const ex = layer.exposure || [];
    let best = Infinity;
    for (let f = 0; f < ex.length; f++) {
      if (ex[f] === num) {
        const d = Math.abs(f - frame);
        if (d < best) { best = d; if (!d) break; }
      }
    }
    return best;
  }

  const CelMemory = {
    budgetBytes(app) {
      const mb = app && app.settings && Number(app.settings.celMemoryMB);
      return (mb > 0 ? mb : DEFAULT_BUDGET_MB) * 1024 * 1024;
    },

    // Memory held by cel surfaces right now (for the console and tests).
    stats(project) {
      const s = { cels: 0, allocated: 0, vectorAllocated: 0, rasterAllocated: 0,
        bytes: 0, vectorBytes: 0, rasterBytes: 0, parked: 0, pngBytes: 0 };
      for (const [, c] of allCels(project)) {
        s.cels++;
        if (c._png) s.pngBytes += c._png.length;
        if (c.parked) s.parked++;
        if (!c.hasCanvas) continue;
        const b = c.canvasBytes;
        s.allocated++; s.bytes += b;
        if (c.kind === 'vector') { s.vectorAllocated++; s.vectorBytes += b; }
        else { s.rasterAllocated++; s.rasterBytes += b; }
      }
      s.mb = Math.round(s.bytes / 1048576);
      return s;
    },

    // Release surfaces until they fit in `budget` bytes (default: the app
    // budget). Returns the number of bytes freed now. Raster cels that were
    // drawn on have to be encoded first; that happens in the background and
    // `again` is called when one is ready to be released by a later pass.
    trim(app, budget, again) {
      if (!app || !app.project) return 0;
      if (app.tools && app.tools.dragging) return 0;
      if (budget == null) budget = this.budgetBytes(app);
      const frame = app.frame | 0;
      let used = 0;
      const candidates = [];
      for (const [layer, c] of allCels(app.project)) {
        if (!c.hasCanvas) continue;
        used += c.canvasBytes;
        const d = distance(layer, c.num, frame);
        if (d === 0) continue;                       // on screen now
        if (c.kind !== 'vector' && d <= RASTER_KEEP_NEAR) continue;
        candidates.push({ c, d });
      }
      if (used <= budget) return 0;
      // furthest from the playhead first; among equals, least recently used
      candidates.sort((a, b) => (b.d - a.d) || (a.c._used - b.c._used));
      let freed = 0, pending = 0, encodes = 0;
      for (const { c } of candidates) {
        if (used - freed - pending <= budget) break;
        if (c.kind === 'vector' || c.parkable) { freed += c.release(); continue; }
        // drawn on since it was last stored: encode it, release it next pass
        if (encodes >= MAX_ENCODES) continue;
        encodes++; pending += c.canvasBytes;
        c.stash().then(ok => { if (ok && again) again(); });
      }
      return freed;
    },

    // Throttled trim, hooked to frame changes and project loads.
    attach(app) {
      let last = 0, timer = null;
      const run = () => {
        timer = null; last = Date.now();
        try { CelMemory.trim(app, null, schedule); } catch (e) { console.error(e); }
      };
      function schedule() {
        if (timer) return;
        const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - last));
        timer = setTimeout(run, wait);
      }
      app.on('framechange', schedule);
      app.on('celchange', schedule);
      app.on('projectchange', schedule);
      return { trimNow: run };
    }
  };

  OT.CelMemory = CelMemory;
})(window.OT);
