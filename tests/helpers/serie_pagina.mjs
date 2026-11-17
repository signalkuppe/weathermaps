// Aiutante di tests/test_sito_statico.py: la parte "browser" dei meteogrammi, con il codice vero della pagina.
// Legge le serie di un sito statico già costruito con getSeries (riquadri .bin, griglie da runs.json) e i campi della
// mappa con unpackField e valueAt (il valore del tooltip), così il test confronta grafico, mappa e API.
//
// Uso: node tests/helpers/serie_pagina.mjs <richiesta.json>
//   richiesta: { site, queries: [{ model, run, lat, lon, field? }] }   field: .bin della mappa (relativo a site)
// Risposta (stdout): [{ series: {lat, lon, vars} | { error }, map: numero|null }]
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
// fetch del sito statico: i file dal disco, 404 se mancano
const fetch = async (url) => {
  try {
    const buf = bufOf(join(req.site, url));
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  } catch {
    return { ok: false, status: 404 };
  }
};

const ctx = vm.createContext({ TextDecoder, F32: new WeakMap(), STATIC: true, runs, fetch });
vm.runInContext(
  slice("  function unpackField(buf) {", "  function getIntervalStatic(") +
    slice("  function valueAt(f, lat, lon) {", "  function loadPlaces() {") +
    slice("  /** Serie nel punto: dal server (api/series)", "  /** Climatologia della T850") +
    "\nglobalThis.api = { unpackField, valueAt, getSeries };",
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
  const map = q.field ? ctx.api.valueAt(ctx.api.unpackField(bufOf(join(req.site, q.field))), q.lat, q.lon) : null;
  out.push({ series, map });
}
process.stdout.write(JSON.stringify(out));
