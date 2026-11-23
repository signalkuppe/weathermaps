// Helper of tests/test_static_site.py: the "browser" part of the meteograms, with the page's real code.
// Reads the series of an already built static site with getSeries (.bin tiles, grids from runs.json) and the map
// fields with unpackField and valueAt (the tooltip value), so the test compares chart, map and API.
//
// Usage: node tests/helpers/page_series.mjs <request.json>
//   request: { site, queries: [{ model, run, lat, lon, field? }] }   field: map .bin (relative to site)
// Response (stdout): [{ series: {lat, lon, vars} | { error }, map: number|null }]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const req = JSON.parse(readFileSync(process.argv[2], "utf8"));
const app = readFileSync(new URL("../../static/app.js", import.meta.url), "utf8");
const slice = (from, to) => {
  const a = app.indexOf(from),
    b = app.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`pezzo di app.js non trovato: ${from} … ${to}`);
  return app.slice(a, b);
};

const runs = JSON.parse(readFileSync(join(req.site, "data", "runs.json"), "utf8")).models;
const bufOf = (path) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
// fetch of the static site: files from disk, 404 if missing
const fetch = async (url) => {
  try {
    const buf = bufOf(join(req.site, url));
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  } catch {
    return { ok: false, status: 404 };
  }
};

const ctx = vm.createContext({
  TextDecoder, F32: new WeakMap(), STATIC: true, runs, fetch,
  Response, Blob, DecompressionStream, Uint8Array, // gunzip: the site's files are compressed
});
vm.runInContext(
  slice("  async function gunzip(buf) {", "  function getIntervalStatic(") +
    slice("  function valueAt(f, lat, lon) {", "  function loadPlaces() {") +
    slice("  async function getSeries(", "  let climFile = null;") +
    "\nglobalThis.api = { gunzip, unpackField, valueAt, getSeries };",
  ctx,
);

const out = [];
for (const q of req.queries) {
  let series;
  try {
    series = await ctx.api.getSeries(q.model, q.run, q.lat, q.lon);
  } catch (e) {
    series = { error: String(e.message || e) };
  }
  const map = q.field
    ? ctx.api.valueAt(ctx.api.unpackField(await ctx.api.gunzip(bufOf(join(req.site, q.field)))), q.lat, q.lon)
    : null;
  out.push({ series, map });
}
process.stdout.write(JSON.stringify(out));
