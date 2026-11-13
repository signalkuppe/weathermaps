// Aiutante di tests/test_catena_valori.py: la parte "browser" della catena dei valori, con il codice vero della pagina.
// Legge un campo in formato compatto (.bin, come sul sito statico), lo decodifica con unpackField, legge i punti con
// valueAt (il valore del tooltip) e disegna l'immagine dei colori con wmRenderPixels (render.js, celle nette).
//
// Uso: node tests/helpers/catena_valori.mjs <richiesta.json>
//   richiesta: { bin, decimals, scale, points: [{ lat, lon }], pixels: [[x, y]] }
// Risposta (stdout): { grid, W, H, upscale, values: [numero|null], texts: [stringa], rgba: [[r, g, b, a]] }
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
vm.runInContext(render, ctx); // definisce wmRenderPixels sul contesto (come script normale)

const buf = readFileSync(req.bin);
const f = ctx.api.unpackField(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const values = req.points.map((p) => ctx.api.valueAt(f, p.lat, p.lon));
// testo del tooltip, come showProbe: valore con i decimali della grandezza
const texts = values.map((v) => (v == null ? null : v.toFixed(req.decimals)));

// immagine come fieldImage, con "celle nette": ogni pixel prende la cella più vicina, senza ammorbidire
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
