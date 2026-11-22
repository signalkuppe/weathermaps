/* Drawing the colours of a field: from values on a regular grid to an image in Mercator projection.
 *
 * The same file is used in two ways:
 *  - as a Web Worker (new Worker("render.js")): it receives a job and answers with the already encoded PNG image, so
 *    the computation (millions of pixels for the 1-2 km models) and the encoding do not block the page;
 *  - as a plain script: it defines wmRenderPixels, used by the page where workers or OffscreenCanvas are missing.
 *
 * Job: { id, values: Float32Array (NaN = missing), nx, ny, lat0, lon0, dlat, dlon, scale: { thresholds, colors,
 * transparent_below, continuous }, crisp, upscale, smooth (3×3 mean passes before the colours) }.
 */
(function (root) {
  "use strict";

  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const invMercY = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

  /** 3×3 moving average over the cells present, repeated `passes` times (like `blurred` in the page). */
  function blur(vals, nx, ny, passes) {
    let a = vals;
    for (let it = 0; it < passes; it++) {
      const b = new Float32Array(a.length);
      for (let y = 0; y < ny; y++) {
        const y0 = y > 0 ? y - 1 : 0, y1 = y < ny - 1 ? y + 1 : ny - 1;
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (a[i] !== a[i]) { b[i] = NaN; continue; }
          const x0 = x > 0 ? x - 1 : 0, x1 = x < nx - 1 ? x + 1 : nx - 1;
          let sum = 0, n = 0;
          for (let yy = y0; yy <= y1; yy++) {
            const row = yy * nx;
            for (let xx = x0; xx <= x1; xx++) {
              const w = a[row + xx];
              if (w === w) { sum += w; n++; }
            }
          }
          b[i] = sum / n;
        }
      }
      a = b;
    }
    return a;
  }

  /** Colour (RGBA pixel in an integer, machine byte order) per value: sharp bands with a binary search on the
   *  thresholds, smooth scales with a table of 2048 colours between the first and last threshold. 0 = transparent. */
  function colorFn(scale) {
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    const pack = (r, g, b) => (little ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
    const rgb = scale.colors.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    const th = Float64Array.from(scale.thresholds);
    if (scale.continuous) {
      const n = th.length - 1, N = 2048, lo = th[0], span = th[n] - lo || 1;
      const lut = new Uint32Array(N + 1);
      for (let i = 0; i <= N; i++) {
        const v = lo + (i / N) * span;
        let k = 0;
        while (k + 1 < n && v >= th[k + 1]) k++;
        const t = Math.min(1, Math.max(0, (v - th[k]) / (th[k + 1] - th[k])));
        const a = rgb[k], b = rgb[k + 1];
        lut[i] = pack(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t));
      }
      const inv = N / span;
      return (v) => {
        if (v !== v) return 0;
        const i = (v - lo) * inv;
        return lut[i <= 0 ? 0 : i >= N ? N : (i + 0.5) | 0];
      };
    }
    const cols = Uint32Array.from(rgb.map((c) => pack(c[0], c[1], c[2])));
    const below = scale.transparent_below, hasBelow = below != null, last = th.length - 1;
    return (v) => {
      if (v !== v) return 0;
      if (hasBelow && v < below) return 0;
      let a = 0, b = last; // last threshold <= v (the first class also collects the lowest values)
      while (a < b) {
        const m = (a + b + 1) >> 1;
        if (th[m] <= v) a = m; else b = m - 1;
      }
      return cols[a];
    };
  }

  /** Image pixels: { W, H, pixels: Uint32Array }. Bilinear interpolation of the values (or nearest cell with
   *  `crisp`), then colour; if one of the four cells is missing the nearest is used, as the page used to do. */
  function wmRenderPixels(job) {
    const { nx, ny, lat0, lon0, dlat, dlon, crisp, upscale } = job;
    const vals = job.smooth > 0 ? blur(job.values, nx, ny, job.smooth) : job.values;
    const south = lat0 - dlat / 2, north = lat0 + (ny - 1) * dlat + dlat / 2;
    const west = lon0 - dlon / 2, east = lon0 + (nx - 1) * dlon + dlon / 2;
    const W = nx * upscale;
    const yN = mercY(north), yS = mercY(south);
    const H = Math.max(1, Math.round((W * (yN - yS)) / (((east - west) * Math.PI) / 180)));
    const color = colorFn(job.scale);
    const pixels = new Uint32Array(W * H);
    // columns: index of the left cell and weight of the right one (the same for all rows)
    const cx0 = new Int32Array(W), cx1 = new Int32Array(W), ctx = new Float32Array(W), cxn = new Int32Array(W);
    for (let x = 0; x < W; x++) {
      const fx = Math.min(Math.max((west + ((x + 0.5) / W) * (east - west) - lon0) / dlon, 0), nx - 1);
      const x0 = Math.floor(fx);
      cx0[x] = x0; cx1[x] = Math.min(x0 + 1, nx - 1); ctx[x] = fx - x0; cxn[x] = Math.round(fx);
    }
    for (let y = 0; y < H; y++) {
      const lat = invMercY(yN - ((y + 0.5) / H) * (yN - yS));
      const fy = Math.min(Math.max((lat - lat0) / dlat, 0), ny - 1);
      const y0 = Math.floor(fy), ty = fy - y0;
      const r0 = y0 * nx, r1 = Math.min(y0 + 1, ny - 1) * nx, rn = Math.round(fy) * nx;
      const o = y * W;
      if (crisp) {
        for (let x = 0; x < W; x++) pixels[o + x] = color(vals[rn + cxn[x]]);
        continue;
      }
      for (let x = 0; x < W; x++) {
        const x0 = cx0[x], x1 = cx1[x], tx = ctx[x];
        const a = vals[r0 + x0], b = vals[r0 + x1], c = vals[r1 + x0], d = vals[r1 + x1];
        const top = a * (1 - tx) + b * tx, bot = c * (1 - tx) + d * tx;
        const v = top * (1 - ty) + bot * ty;
        pixels[o + x] = color(v === v ? v : vals[rn + cxn[x]]); // NaN: one of the four cells is missing
      }
    }
    return { W, H, pixels };
  }

  /** Contour lines (isotherms, freezing level, isobars) by marching squares. Job: { kind: "contours", values: Float32Array
   *  (NaN = missing), nx, ny, lat0, lon0, dlat, dlon, passes (3×3 mean passes first: on fine grids the lines would
   *  follow every valley), step (one level every `step`) }. Returns [{ level, pts: Float64Array [lat, lon, ...] }]. */
  function wmContours(job) {
    const { nx, ny, lat0, lon0, dlat, dlon, step } = job;
    let lo = Infinity, hi = -Infinity;
    for (const x of job.values) if (x === x) { if (x < lo) lo = x; if (x > hi) hi = x; }
    const out = [];
    if (!(hi > lo)) return out;
    const levels = [];
    for (let l = Math.ceil(lo / step) * step; l <= hi; l += step) levels.push(+l.toFixed(6));
    const v = job.passes > 0 ? blur(job.values, nx, ny, job.passes) : job.values;
    // points closer than 1/20 of a cell to the line are dropped (a third remain on the 1 km grids): the page builds
    // and draws far fewer, with no visible difference
    const tol = 0.05 * Math.min(dlat, dlon);
    for (const lvl of levels) {
      // values arrive rounded (0.1 °C): one exactly equal to the level would make stepped lines along the cells;
      // the level is shifted by a hair so no value touches it
      const L0 = lvl + 1e-4;
      const pos = new Map(); // side id -> [lat, lon] of the crossing
      const segA = [], segB = [];
      const cross = (id, ya, xa, va, yb, xb, vb) => {
        if (!pos.has(id)) {
          const t = (L0 - va) / (vb - va);
          pos.set(id, [lat0 + (ya + (yb - ya) * t) * dlat, lon0 + (xa + (xb - xa) * t) * dlon]);
        }
        return id;
      };
      for (let y = 0; y < ny - 1; y++) {
        for (let x = 0; x < nx - 1; x++) {
          const a = v[y * nx + x], b = v[y * nx + x + 1], c = v[(y + 1) * nx + x + 1], d = v[(y + 1) * nx + x];
          if (a !== a || b !== b || c !== c || d !== d) continue; // a missing corner
          const sa = a >= L0, sb = b >= L0, sc = c >= L0, sd = d >= L0;
          if (sa === sb && sb === sc && sc === sd) continue;
          // sides: 0 = a-b (bottom), 1 = b-c (right), 2 = d-c (top), 3 = a-d (left)
          const e = [];
          if (sa !== sb) e[0] = cross((y * nx + x) * 2, y, x, a, y, x + 1, b);
          if (sb !== sc) e[1] = cross((y * nx + x + 1) * 2 + 1, y, x + 1, b, y + 1, x + 1, c);
          if (sd !== sc) e[2] = cross(((y + 1) * nx + x) * 2, y + 1, x, d, y + 1, x + 1, c);
          if (sa !== sd) e[3] = cross((y * nx + x) * 2 + 1, y, x, a, y + 1, x, d);
          const ids = [];
          for (let i = 0; i < 4; i++) if (e[i] !== undefined) ids.push(e[i]);
          if (ids.length === 2) {
            segA.push(ids[0]);
            segB.push(ids[1]);
            continue;
          }
          // saddle: the value at the cell centre decides
          const center = (a + b + c + d) / 4 >= L0;
          if (center === sa) {
            segA.push(e[0], e[2]);
            segB.push(e[1], e[3]);
          } else {
            segA.push(e[0], e[1]);
            segB.push(e[3], e[2]);
          }
        }
      }
      // joining the segments that share a side
      const at = new Map();
      const link = (id, k) => {
        const l = at.get(id);
        if (l) l.push(k);
        else at.set(id, [k]);
      };
      for (let k = 0; k < segA.length; k++) {
        link(segA[k], k);
        link(segB[k], k);
      }
      const used = new Uint8Array(segA.length);
      const next = (id) => (at.get(id) || []).find((j) => !used[j]);
      const walk = (start, k0) => {
        const ids = [];
        let id = start, k = k0;
        while (k !== undefined) {
          used[k] = 1;
          id = segA[k] === id ? segB[k] : segA[k];
          ids.push(id);
          k = next(id);
        }
        return ids;
      };
      for (let k = 0; k < segA.length; k++) {
        if (used[k]) continue;
        used[k] = 1;
        const nf = next(segB[k]);
        const fwd = nf === undefined ? [] : walk(segB[k], nf);
        const nb = next(segA[k]);
        const back = nb === undefined ? [] : walk(segA[k], nb);
        const ids = [...back.reverse(), segA[k], segB[k], ...fwd];
        const closed = ids[0] === ids[ids.length - 1];
        if (ids.length < (closed ? 12 : 4)) continue; // tiny fragments and rings: just noise
        out.push({ level: lvl, pts: simplify(chaikin(ids.map((id) => pos.get(id)), closed), tol) });
      }
    }
    return out;
  }

  /** Rounds the corners (Chaikin, one pass: the lines stay on the colour edges), flat [lat, lon, ...]. */
  function chaikin(p, closed) {
    const n = p.length - 1;
    if (n < 2) return Float64Array.from(p.flat());
    const q = new Float64Array(2 * (closed ? 2 * n + 1 : 2 * n + 2));
    let o = 0;
    const put = (lat, lon) => { q[o++] = lat; q[o++] = lon; };
    if (!closed) put(p[0][0], p[0][1]);
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[i + 1];
      put(0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]);
      put(0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]);
    }
    if (closed) put(q[0], q[1]);
    else put(p[n][0], p[n][1]);
    return q;
  }

  /** Douglas-Peucker on a flat [lat, lon, ...] line: keeps the points farther than `tol` degrees from the
   *  simplified line (ends always kept, so closed rings stay closed). */
  function simplify(p, tol) {
    const n = p.length / 2;
    if (n < 3 || !(tol > 0)) return p;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [0, n - 1], t2 = tol * tol;
    while (stack.length) {
      const b = stack.pop(), a = stack.pop();
      const ax = p[2 * a], ay = p[2 * a + 1], dx = p[2 * b] - ax, dy = p[2 * b + 1] - ay, len = dx * dx + dy * dy;
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const px = p[2 * i] - ax, py = p[2 * i + 1] - ay;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len));
        const qx = px - t * dx, qy = py - t * dy, d = qx * qx + qy * qy;
        if (d > md) { md = d; mi = i; }
      }
      if (md > t2) stack.push(a, mi, mi, b), (keep[mi] = 1);
    }
    let m = 0;
    for (let i = 0; i < n; i++) m += keep[i];
    const out = new Float64Array(2 * m);
    for (let i = 0, o = 0; i < n; i++) if (keep[i]) { out[o++] = p[2 * i]; out[o++] = p[2 * i + 1]; }
    return out;
  }

  root.wmRenderPixels = wmRenderPixels;
  root.wmContours = wmContours;

  // as a worker: one job at a time, answered with the PNG or the lines (or with the error)
  if (typeof document === "undefined" && typeof root.postMessage === "function") {
    root.onmessage = async (e) => {
      const job = e.data;
      if (job.kind === "contours") {
        try {
          const lines = wmContours(job);
          root.postMessage({ id: job.id, lines }, lines.map((l) => l.pts.buffer));
        } catch (err) {
          root.postMessage({ id: job.id, error: String(err && err.message || err) });
        }
        return;
      }
      try {
        const { W, H, pixels } = wmRenderPixels(job);
        const canvas = new OffscreenCanvas(W, H);
        canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), W, H), 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        root.postMessage({ id: job.id, blob });
      } catch (err) {
        root.postMessage({ id: job.id, error: String(err && err.message || err) });
      }
    };
  }
})(typeof self !== "undefined" ? self : this);
