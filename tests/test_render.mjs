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
    meta: { variables: [{ id: "tp", decimals: 1 }] },
    getField: async (step) => fields.get(step),
    variable: () => ({ scale: {} }),
    state: { var: "tp", crisp: false },
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
