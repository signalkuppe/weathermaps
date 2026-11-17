// Helper of tests/test_value_chain.py: the "browser" part of the value chain, with the page's real code.
// Reads a field in compact format (.bin, as on the static site), decodes it with unpackField, reads the points with
// valueAt (the tooltip value) and draws the colour image with wmRenderPixels (render.js, sharp cells).
//
// Usage: node tests/helpers/value_chain.mjs <request.json>
//   request: { bin, decimals, scale, points: [{ lat, lon }], pixels: [[x, y]] }
// Response (stdout): { grid, W, H, upscale, values: [number|null], texts: [string], rgba: [[r, g, b, a]] }
import { readFileSync } from "node:fs";
import vm from "node:vm";

const req = JSON.parse(readFileSync(process.argv[2], "utf8"));
const app = readFileSync(new URL("../../static/app.js", import.meta.url), "utf8");
const render = readFileSync(new URL("../../static/render.js", import.meta.url), "utf8");
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));

const ctx = vm.createContext({ TextDecoder, F32: new WeakMap() });
vm.runInContext(
  slice("  function unpackField(buf) {", "  function getIntervalStatic(") +
    slice("  function valueAt(f, lat, lon) {", "  function loadPlaces() {") +
    "\nglobalThis.api = { unpackField, valueAt };",
  ctx,
);
vm.runInContext(render, ctx); // defines wmRenderPixels on the context (as a plain script)

const buf = readFileSync(req.bin);
const f = ctx.api.unpackField(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const values = req.points.map((p) => ctx.api.valueAt(f, p.lat, p.lon));
// tooltip text, like showProbe: value with the field's decimals
const texts = values.map((v) => (v == null ? null : v.toFixed(req.decimals)));

// image like fieldImage, with "sharp cells": each pixel takes the nearest cell, without smoothing
const { nx, ny, lat0, lon0, dlat, dlon } = f.grid;
const upscale = Math.max(2, Math.ceil(1100 / nx));
const { W, H, pixels } = ctx.wmRenderPixels({
  values: Float32Array.from(f.values, (v) => v ?? NaN),
  nx, ny, lat0, lon0, dlat, dlon,
  scale: req.scale,
  crisp: true,
  upscale,
  smooth: 0,
});
const bytes = new Uint8Array(pixels.buffer);
const rgba = req.pixels.map(([x, y]) => {
  const i = 4 * (y * W + x);
  return [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
});

process.stdout.write(JSON.stringify({ grid: f.grid, W, H, upscale, values, texts, rgba }));
