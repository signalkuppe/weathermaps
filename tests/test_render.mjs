import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../static/app.js", import.meta.url),
  "utf8",
);
const intervalSource = source.slice(
  source.indexOf("  function getIntervalStatic("),
  source.indexOf("  function prefetch("),
);
const imageSource = source.slice(
  source.indexOf("  const IMG_KEEP ="),
  source.indexOf("  let drawSeq ="),
);

function renderer() {
  const fields = new Map(
    [9, 6, 3].map((step) => [
      step,
      {
        grid: { nx: 2, ny: 2, lat0: 45, lon0: 9, dlat: 1, dlon: 1 },
        values: [step === 3 ? 20 : 40, null, 0, 10],
        mode: "total",
      },
    ]),
  );
  const rendered = [];
  const context = vm.createContext({
    cache: new Map(),
    cacheKeys: new WeakMap(),
    meta: { variables: [{ id: "tp", decimals: 1 }] },
    getField: async (step) => fields.get(step),
    variable: () => ({ scale: {} }),
    synoptic: () => false,
    state: { var: "tp", crisp: false },
    crispNow: () => false,
    renderWorker: null,
    renderSeq: 0,
    renderJobs: new Map(),
    f32Of: (values) => Float32Array.from(values, (value) => value ?? NaN),
    renderInPage: async (job) => {
      rendered.push(Array.from(job.values));
      return `blob:test-${rendered.length}`;
    },
  });
  vm.runInContext(
    `${intervalSource}\n${imageSource}\nglobalThis.api = { getIntervalStatic, fieldImage };`,
    context,
  );
  return { ...context.api, fields, rendered };
}

test("static precipitation intervals render their own values after the total", async () => {
  const { getIntervalStatic, fieldImage, fields, rendered } = renderer();
  const ctx = { model: "gfs", var: "tp", run: "2026111206" };
  const total = fields.get(9);
  const totalImage = await fieldImage(total);
  const threeHours = await getIntervalStatic(9, ctx, 6);
  const threeHourImage = await fieldImage(threeHours);
  const sixHours = await getIntervalStatic(9, ctx, 3);
  const sixHourImage = await fieldImage(sixHours);

  assert.notEqual(threeHourImage, totalImage);
  assert.notEqual(sixHourImage, threeHourImage);
  assert.deepEqual(rendered, [
    [40, NaN, 0, 10],
    [0, NaN, 0, 0],
    [20, NaN, 0, 0],
  ]);
  assert.equal(await fieldImage(total), totalImage);
  assert.equal(
    await fieldImage(await getIntervalStatic(9, ctx, 6)),
    threeHourImage,
  );
  assert.equal(rendered.length, 3);
});

test("derived fields do not inherit an image identity from a copied field", async () => {
  const { fieldImage, fields, rendered } = renderer();
  const total = fields.get(9);
  const totalImage = await fieldImage(total);
  const derived = { ...total, values: [0, 0, 0, 0] };

  assert.notEqual(await fieldImage(derived), totalImage);
  assert.deepEqual(rendered[1], [0, 0, 0, 0]);
});

test("field cache stays within its cell budget and keeps the most recently used", async () => {
  const context = vm.createContext({ IOS: true });
  vm.runInContext(
    source.slice(
      source.indexOf("  const FIELD_BUDGET ="),
      source.indexOf("  const cache = new FieldCache();"),
    ) +
      "\nglobalThis.api = { cache: new FieldCache(), cacheKeys, budget: FIELD_BUDGET };",
    context,
  );
  const { cache, cacheKeys, budget } = context.api;
  const big = budget / 4; // four fit, the fifth pushes out the oldest
  const fields = [];
  for (let k = 0; k < 12; k++) {
    const f = { values: { length: big } };
    fields.push(f);
    cache.set(`f${k}`, Promise.resolve(f));
    if (k === 9) cache.get("f0"); // used again: no longer the oldest
  }
  await new Promise((r) => setTimeout(r));
  assert.ok(cache.size >= 8); // the last few always stay
  assert.ok(cache.has("f0"));
  assert.ok(!cache.has("f1"));
  assert.ok(cache.has("f11"));
  assert.equal(cacheKeys.get(fields[11]), "f11");
  cache.delete("f11");
  assert.ok(!cache.has("f11"));
});

test("worker contour lines: levels, closed rings and missing cells", () => {
  const worker = {};
  vm.runInNewContext(
    readFileSync(new URL("../static/render.js", import.meta.url), "utf8"),
    { self: worker, document: {} },
  );
  const nx = 12,
    ny = 12;
  const grid = { nx, ny, lat0: 45, lon0: 9, dlat: 0.1, dlon: 0.1 };
  // a hill: one ring per level around the centre
  const hill = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      hill[y * nx + x] = Math.max(4.5, 10 - Math.hypot(x - 5.5, y - 5.5)); // flat below 4.5: rings inside the grid
  const rings = worker.wmContours({ kind: "contours", values: hill, ...grid, passes: 0, step: 2 });
  assert.deepEqual(
    Array.from(rings, (l) => l.level),
    [6, 8],
  );
  for (const { pts } of rings) {
    assert.ok(pts.length % 2 === 0 && pts.BYTES_PER_ELEMENT === 8);
    assert.equal(pts[0], pts.at(-2)); // closed: back to the start
    assert.equal(pts[1], pts.at(-1));
  }
  // a slope from west to east: one open line per level, at the right longitude; missing cells are skipped
  const slope = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) slope[y * nx + x] = y >= 10 ? NaN : x;
  const lines = worker.wmContours({ kind: "contours", values: slope, ...grid, passes: 0, step: 5 });
  assert.deepEqual(
    Array.from(lines, (l) => l.level),
    [0, 5, 10],
  );
  const five = lines[1].pts;
  for (let k = 0; k < five.length; k += 2) {
    assert.ok(Math.abs(five[k + 1] - 9.5) < 1e-3);
    assert.ok(five[k] <= 45 + 9 * 0.1 + 1e-9); // not into the missing rows
  }
  assert.equal(
    worker.wmContours({ kind: "contours", values: new Float32Array(4).fill(3), nx: 2, ny: 2, lat0: 0, lon0: 0, dlat: 1, dlon: 1, passes: 0, step: 1 }).length,
    0,
  );
});
