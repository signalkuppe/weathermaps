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

  root.wmRenderPixels = wmRenderPixels;

  // as a worker: one job at a time, answered with the PNG (or with the error)
  if (typeof document === "undefined" && typeof root.postMessage === "function") {
    root.onmessage = async (e) => {
      const job = e.data;
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
