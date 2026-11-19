import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../static/app.js", import.meta.url),
  "utf8",
);
const helperSource = source.slice(
  source.indexOf("  function rangePlaybackSteps("),
  source.indexOf("  const runInfo ="),
);
const context = vm.createContext({});
vm.runInContext(
  `${helperSource}\nglobalThis.rangePlaybackSteps = rangePlaybackSteps;`,
  context,
);

test("incoming run notice reports progress and hides manual refresh on static pages", () => {
  const noticeSource = source.slice(
    source.indexOf("  function renderRunLive("),
    source.indexOf("  function setupSteps("),
  );
  for (const isStatic of [false, true]) {
    let requests = 0;
    const notice = vm.createContext({
      STATIC: isStatic,
      refreshing: false,
      state: { run: "2026111800" },
      ui: {
        runLive: { hidden: true },
        runLiveText: { textContent: "" },
        refresh: {
          hidden: false,
          addEventListener(type, callback) {
            assert.equal(type, "click");
            this.listener = callback;
          },
        },
      },
      dataVar: () => "z500",
      cycle: (run) => `${run.slice(-2)}Z`,
      steps: () => [0, 6, 12, 18],
      fetch() {
        requests++;
        throw new Error("Rendering the notice must not request downloads");
      },
    });
    vm.runInContext(noticeSource, notice);
    assert.equal(notice.ui.refresh.hidden, isStatic);
    assert.equal(notice.ui.refresh.listener, notice.doRefresh);

    notice.renderRunLive({
      run: "2026111812",
      variables: { z500: { steps: Array.from({ length: 37 }), expected: 56 } },
    });
    assert.equal(notice.ui.runLive.hidden, false);
    assert.equal(
      notice.ui.runLiveText.textContent,
      "12Z in arrivo · 37/56 passi",
    );

    notice.renderRunLive({
      run: "2026111812",
      variables: { z500: { steps: [0, 6] } },
    });
    assert.equal(
      notice.ui.runLiveText.textContent,
      "12Z in arrivo · 2/4 passi",
    );

    for (const incoming of [undefined, { variables: {} }]) {
      notice.renderRunLive(incoming);
      assert.equal(notice.ui.runLive.hidden, true);
    }

    notice.refreshing = true;
    notice.renderRunLive(undefined);
    assert.equal(notice.ui.runLive.hidden, false);
    assert.equal(notice.ui.runLiveText.textContent, "Corsa 00Z aggiornata");
    assert.equal(requests, 0);
  }

  const html = readFileSync(
    new URL("../static/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="refresh"/);
  assert.match(html, /id="run-live-note"/);
});

test("incoming run notice uses the shared info icon and style", () => {
  const html = readFileSync(
    new URL("../static/index.html", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../static/style.css", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="run-live"[^>]*>\s*<svg\b[^>]*aria-hidden="true"/);
  assert.match(css, /\.run-live\s*\{[^}]*background:\s*var\(--accent-tint\)/);
  assert.match(css, /\.run-live svg\s*\{[^}]*flex:\s*none;/);
  assert.match(css, /\.run-live svg\s*\{[^}]*color:\s*var\(--accent\)/);
});

test("switching between model maps and extra layers resets zoom to the current minimum", () => {
  let minimum = 5;
  let zoom = 9;
  const changes = [];
  const stops = [];
  const element = () => ({
    dataset: {},
    append() {},
    replaceChildren() {},
    setAttribute() {},
    addEventListener() {},
  });
  const layers = vm.createContext({
    state: { extra: "none", var: "tp" },
    EXTRAS: {
      radar: { name: "Radar", stepMin: 5 },
      sat: { name: "Satellite", stepMin: 10 },
    },
    meta: null,
    radarTimer: null,
    radarFrames: [],
    radarIdx: -1,
    radarAutoplay: false,
    radarReadyOnce: false,
    glBase: { stop: () => stops.push("mapbox") },
    glImgs: new Map(),
    map: {
      getMinZoom: () => minimum,
      stop: () => stops.push("leaflet"),
      setZoom(value, options) {
        assert.deepEqual(
          stops.splice(0),
          layers.glBase ? ["mapbox", "leaflet"] : ["leaflet"],
        );
        zoom = value;
        changes.push({ zoom: value, animate: options.animate });
      },
    },
    document: {
      body: { classList: { toggle() {} } },
      createElement: element,
    },
    ui: { probe: {} },
    $: element,
    synoptic: () => false,
    extraCfg: () => layers.EXTRAS[layers.state.extra],
    clearInterval() {},
    setInterval: () => 1,
    stopRadarPlay() {},
    renderSoundings() {},
    glSatBase() {},
    togglePlay() {},
    updateRadarLoading() {},
    refreshRadar() {},
    saveSettings() {},
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  const EXTRA_NAMES ="),
      source.indexOf('  $("extra-close").addEventListener'),
    ),
    layers,
  );

  layers.setExtra("none", false);
  assert.equal(zoom, 9);
  assert.equal(changes.length, 0);

  for (const extra of ["radar", "sat", "snd"]) {
    minimum += 0.5;
    zoom = minimum + 3;
    layers.setExtra(extra);
    assert.equal(layers.state.extra, extra);
    assert.equal(zoom, minimum);
    assert.deepEqual(changes.at(-1), { zoom: minimum, animate: false });

    zoom = minimum + 2;
    const count = changes.length;
    layers.setExtra(extra, false);
    assert.equal(zoom, minimum + 2);
    assert.equal(changes.length, count);

    layers.setExtra("none");
    assert.equal(zoom, minimum);
    assert.equal(changes.length, count + 1);
    assert.deepEqual(changes.at(-1), { zoom: minimum, animate: false });
  }

  layers.glBase = null;
  zoom = minimum + 3;
  layers.setExtra("radar");
  assert.equal(zoom, minimum);
  zoom = minimum + 2;
  layers.setExtra("none");
  assert.equal(zoom, minimum);
});

test("range playback includes available steps after its start through its end", () => {
  const sequence = context.rangePlaybackSteps(
    [0, 3, 6, 9, 12, 15],
    new Set([0, 3, 9, 12, 15]),
    3,
    12,
  );

  assert.deepEqual(Array.from(sequence), [9, 12]);
});

test("playback keeps both range thumbs fixed while its progress advances", () => {
  const attributes = new Map();
  const classes = new Set();
  const animations = [];
  const slider = {
    max() {},
    value(value) {
      this.values = Array.from(value);
    },
    element: {
      clientWidth: 300,
      querySelectorAll: () => [button(), button()],
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
    },
    progress: {
      style: {},
      setAttribute: (name, value) => attributes.set(name, value),
      animate(keyframes, options) {
        const animation = {
          keyframes,
          options,
          currentTime: 0,
          effect: { getTiming: () => options },
          commitStyles() {
            this.committed = true;
          },
          cancel() {
            this.cancelled = true;
          },
        };
        animations.push(animation);
        return animation;
      },
    },
  };
  function button() {
    return { innerHTML: "play", offsetWidth: 22, setAttribute() {} };
  }
  let tick;
  const playback = vm.createContext({
    meta: {},
    // fixed range from +3h to +12h, Total accumulation: play grows the accumulation inside the range
    state: {
      mode: "interval",
      rangeFrom: 3,
      rangeTo: 12,
      cum: "total",
      step: 12,
      hours: 9,
    },
    playTimer: null,
    playbackSelection: null,
    intervalSliders: [slider],
    intervalSteps: () => [0, 3, 6, 9, 12, 15],
    steps: () => [3, 6, 9, 12, 15],
    availableSteps: () => new Set([3, 6, 9, 12, 15]),
    intervalPrev: () => playback.state.rangeFrom,
    rangeMode: () => true,
    rangeFrames: (from, to) =>
      [3, 6, 9, 12, 15].filter((x) => x > from && x <= to),
    syncMode() {},
    dualMode: () => true, // Total: two-thumb slider
    slideSteps: () => [3, 6, 9, 12, 15],
    ui: { play: button(), mPlay: button(), step: {} },
    setInterval(callback) {
      tick = callback;
      return 1;
    },
    clearInterval() {
      tick = null;
    },
  });
  const syncSource = source.slice(
    source.indexOf("  function stopProgressAnimation("),
    source.indexOf('  // "in 3h"'),
  );
  const playSource = source.slice(
    source.indexOf("  const M_PLAY = ui.mPlay.innerHTML;"),
    source.indexOf('  ui.step.addEventListener("input"'),
  );
  vm.runInContext(
    `${helperSource}\n${syncSource}\n${playSource}
     function update() { syncIntervalSliders(); }
     globalThis.play = togglePlay;`,
    playback,
  );

  playback.play();
  assert.deepEqual(slider.values, [1, 4]);
  assert.equal(playback.state.step, 6);
  const initialPosition = slider.progress.style.left;
  assert.equal(animations[0].options.duration, 1300);
  assert.equal(animations[0].options.easing, "linear");
  assert.deepEqual(
    animations[0].keyframes.map(({ left }) => left),
    slider.progressBounds,
  );
  assert.equal(slider.progress.hidden, false);
  assert.equal(slider.progress.style.top, "50%");
  assert.equal(classes.has("playback-complete"), false);
  tick();
  assert.deepEqual(slider.values, [1, 4]);
  assert.equal(playback.state.step, 9);
  assert.equal(slider.progress.style.left, initialPosition);
  animations[0].currentTime = 800;
  playback.play(false);
  assert.equal(animations[0].committed, true);
  assert.equal(animations[0].cancelled, true);
  assert.equal(playback.playbackSelection.progress, 800 / 1300);
  assert.deepEqual(slider.values, [1, 4]);
  assert.equal(classes.has("playback-complete"), false);
  playback.play();
  assert.equal(playback.state.step, 6);
  tick();
  animations[1].currentTime = 1300;
  tick();
  assert.equal(playback.state.step, 12);
  assert.deepEqual(slider.values, [1, 4]);
  assert.equal(attributes.get("aria-valuenow"), 12);
  assert.equal(classes.has("playback-complete"), true);
  assert.equal(animations[1].cancelled, true);
  assert.equal(tick, null);
  assert.equal(playback.state.step, 12);
  slider.element.clientWidth = 40;
  playback.play();
  assert.equal(slider.progress.hidden, false);
  assert.equal(
    slider.progress.style.top,
    "calc(50% - var(--interval-thumb-size) / 2 - 12px)",
  );
  playback.play(false);
});

test("time bars show the interval as dates, with the start", () => {
  const state = {
    run: "2026111306",
    model: "icon-d2",
    mode: "interval",
    step: 9,
  };
  const time = vm.createContext({
    state,
    playbackSelection: { from: 3, to: 24 },
    ui: {
      valid: { classList: { toggle() {} } },
      range: {},
      badgeText: {},
      step: { style: { setProperty() {} } },
    },
    // like the real one: with an empty run it breaks (slice of null)
    runDate: (rid) => (rid.slice(0, 4), new Date("2026-11-13T06:00:00Z")),
    fmtLocal: () => "ven 13 nov, 15:00",
    fmtUTC: () => "14:00",
    cycle: () => "06Z",
    fmtRunDay: () => "ven 13 nov",
    modelLabel: () => "ICON-D2",
    shortLabel: () => "ICON-D2",
    rangeMode: () => true,
    intervalPrev: () => (state.mode === "interval" ? 3 : 0),
    intervalHours: () => 6,
    syncIntervalSliders() {},
    steps: () => [3, 6, 9, 12, 24],
    slideSteps: () => [3, 6, 9, 12, 24],
    $: () => ({ style: { setProperty() {} } }),
  });
  // the real date formatters (fmtDay … fmtShown) and renderTime
  vm.runInContext(
    source.slice(
      source.indexOf("  const fmtDay ="),
      source.indexOf("  const hexToRgb ="),
    ) +
      source.slice(
        source.indexOf("  function renderTime()"),
        source.indexOf("  let seq = 0;"),
      ) +
      "\nrenderTime();",
    time,
  );
  // interval from +3h (10:00 in Rome) to the shown step +9h (16:00), same day: the day only once
  const span = "ven 13, 10:00 → 16:00";
  assert.match(
    time.ui.badgeText.innerHTML,
    new RegExp(`badge-valid badge-d">${span}</span>`),
  );
  assert.match(
    time.ui.badgeText.innerHTML,
    new RegExp(
      `badge-m-time"><b>${span}</b><span class="badge-m-range">6h</span>`,
    ),
  );
  assert.equal(time.ui.valid.textContent, span);
  assert.equal(time.ui.range.textContent, "");
  assert.match(time.ui.badgeText.innerHTML, /<strong>06z<\/strong> 13\/11/);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /corsa|Da \+/);

  time.playbackSelection = null;
  vm.runInContext("renderTime();", time);
  assert.match(
    time.ui.badgeText.innerHTML,
    new RegExp(`badge-valid badge-d">${span}</span>`),
  );

  // total since the start of the run: here too start and end (06Z = 07:00 in Rome, +9h = 16:00) and the duration
  state.mode = "total";
  time.playbackSelection = { from: 0, to: 24 };
  vm.runInContext("renderTime();", time);
  assert.match(
    time.ui.badgeText.innerHTML,
    /badge-valid badge-d">ven 13, 07:00 → 16:00<\/span>/,
  );
  // during play the bar shows the accumulation of the image shown (up to +9h), not the end of the range
  assert.match(time.ui.badgeText.innerHTML, /badge-m-range">9h<\/span>/);

  // instantaneous field: no interval, the forecast hour in the compact bar, the UTC time below in the panel
  state.mode = "value";
  time.rangeMode = () => false;
  vm.runInContext("renderTime();", time);
  assert.match(time.ui.badgeText.innerHTML, /badge-m-range">\+9h<\/span>/);
  assert.equal(time.ui.range.textContent, "14:00 UTC");

  // field the model does not have: no run, no dates (startup used to stop with an error)
  state.run = null;
  time.variable = () => ({ models: ["gfs"] });
  vm.runInContext("renderTime();", time);
  assert.equal(time.ui.valid.textContent, "");
  assert.match(time.ui.badgeText.innerHTML, /grandezza non disponibile/);
});

test("range frames: every step with the total, one image every chosen hours otherwise", () => {
  const fnSource = source.slice(
    source.indexOf("  function rangeFrames("),
    source.indexOf(
      "  // actual duration of the accumulation at the step shown",
    ),
  );
  // steps every 3 hours up to +144h, then every 6 hours
  const all = [
    ...Array.from({ length: 48 }, (_, i) => 3 * (i + 1)),
    150,
    156,
    162,
    168,
  ];
  const ctx = vm.createContext({
    state: { rangeFrom: 6, rangeTo: 30, cum: "total", hours: 6, step: 30 },
    steps: () => all,
    availableSteps: () => new Set(all),
  });
  vm.runInContext(`${fnSource}\nglobalThis.frames = rangeFrames;`, ctx);
  // Total: every step after the start of the range, up to the end
  assert.deepEqual([...ctx.frames()], [9, 12, 15, 18, 21, 24, 27, 30]);
  // 6h inside the same range: 06-12, 12-18, 18-24, 24-30
  ctx.state.cum = "hours";
  assert.deepEqual([...ctx.frames()], [12, 18, 24, 30]);
  // 3h beyond +144h (steps every 6 hours): a single image per step, without duplicates
  Object.assign(ctx.state, { rangeFrom: 138, rangeTo: 168, hours: 3 });
  assert.deepEqual([...ctx.frames()], [141, 144, 150, 156, 162, 168]);
});

test("multimodel charts align map periods across model runs without changing the ensemble range", async () => {
  const steps = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30];
  const rendered = [];
  const chart = vm.createContext({
    state: {
      model: "gfs",
      run: "2026111800",
      mode: "interval",
      step: 24,
      rangeFrom: 6,
      rangeTo: 24,
    },
    meta: {
      models: [{ id: "gfs" }, { id: "icon-d2" }],
      ensemble: { gfs: { run: "2026111800", label: "GEFS" } },
    },
    runs: {
      gfs: [{ run: "2026111800", variables: { tp: {}, t850: {} } }],
      "icon-d2": [{ run: "2026111806", variables: { tp: {}, t850: {} } }],
    },
    chartUi: {
      title: {},
      model: {},
      multi: { querySelectorAll: () => [] },
      sounding: {},
      details: {},
      warn: {},
      body: { clientWidth: 800, clientHeight: 600 },
      dialog: {
        open: false,
        classList: { remove() {} },
        showModal() {
          this.open = true;
        },
        focus() {},
      },
    },
    chartContext: null,
    chartData: null,
    chartPin: 18,
    intervalPrev: () => 6,
    dualMode: () => chart.state.mode === "interval",
    fillModelSelect() {},
    writeChartHash() {},
    $: () => ({}),
    runDate: (run) => new Date(`2026-11-18T${run.slice(8, 10)}:00:00Z`),
    fmtLocal: (date) => date.toISOString(),
    fmtSpan: (from, until) => `${from.toISOString()} - ${until.toISOString()}`,
    shortLabel: (model) => model,
    getSeries: async () => ({
      vars: {
        tp: { steps, values: steps },
        t850: { steps, values: steps.map((step) => (step > 24 ? 999 : step)) },
      },
    }),
    niceTicks: (lo, hi) => [lo, hi],
    CHART_R: 30,
    CHART_AXIS: 40,
    loadChart: async () => chart.loadMulti(),
    drawChart() {
      rendered.push(chart.drawMulti(800, 600));
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  async function openChart("),
      source.indexOf("  /** Safety net:"),
    ) +
      source.slice(
        source.indexOf("  const MULTI_COLORS ="),
        source.indexOf("  // ---------- observed soundings"),
      ),
    chart,
  );

  const reference = Date.parse("2026-11-18T00:00:00Z");
  const validTime = (hour) => chart.chartData.t0 + hour * 3600e3;
  const offset = (hour) =>
    (reference + hour * 3600e3 - chart.chartData.t0) / 3600e3;
  function assertPeriod(from, until) {
    const start = reference + from * 3600e3;
    const end = reference + until * 3600e3;
    assert.deepEqual(
      Array.from(chart.chartData.lines, (line) => line.id),
      ["gfs", "icon-d2"],
    );
    for (const line of chart.chartData.lines) {
      assert.equal(validTime(line.pts[0][0]), start);
      assert.equal(validTime(line.pts.at(-1)[0]), end);
      assert.equal(line.pts[0][1], 0);
      assert.equal(line.pts.at(-1)[1], until - from);
      for (const [hour, value] of line.pts) {
        assert(validTime(hour) >= start && validTime(hour) <= end);
        assert.equal(value, (validTime(hour) - start) / 3600e3);
      }
    }
    assert.doesNotMatch(rendered.at(-1).markup, /NaN|Infinity/);
  }

  await chart.openChart({ name: "Bormio", lat: 46, lon: 10 }, { multi: "tp" });
  assert.equal(chart.chartContext.from, 6);
  assert.equal(chart.chartContext.until, 24);
  assert.equal(chart.chartContext.run, "2026111800");
  assertPeriod(6, 24);
  chart.chartPin = offset(18);
  const image = chart.drawMulti(800, 600);
  assert.equal(image.pinBox.head, "2026-11-18T18:00:00.000Z");
  assert(image.pinBox.rows.every((row) => row[1][0] === "12.0 mm"));

  chart.chartContext.multi = "t850";
  await chart.loadMulti();
  const temperature = chart.chartData.lines.find(
    (line) => line.id === "icon-d2",
  );
  assert.equal(validTime(temperature.pts[0][0]), reference + 9 * 3600e3);
  for (const line of chart.chartData.lines) {
    for (const [hour, value] of line.pts) {
      assert(validTime(hour) >= reference + 6 * 3600e3);
      assert(validTime(hour) <= reference + 24 * 3600e3);
      assert.notEqual(value, 999);
    }
  }
  assert.doesNotMatch(rendered.at(-1).markup, />999<|NaN|Infinity/);

  await chart.openChart(
    { name: "Bormio", lat: 46, lon: 10 },
    {
      multi: "tp",
      model: "gfs",
      run: "2026111800",
      from: 10,
      until: 20,
      pushHistory: false,
    },
  );
  assertPeriod(10, 20);

  chart.state.step = 12;
  await chart.openChart({ name: "Bormio", lat: 46, lon: 10 }, { multi: "tp" });
  assert.equal(chart.chartContext.until, 12);
  assertPeriod(6, 12);

  chart.state.mode = "value";
  chart.state.step = 18;
  await chart.openChart({ name: "Bormio", lat: 46, lon: 10 }, { multi: "tp" });
  assert.equal(chart.chartContext.from, 0);
  assert.equal(chart.chartContext.until, 18);
  assertPeriod(6, 18);

  chart.chartContext.multi = "t850";
  await chart.loadMulti();
  chart.chartPin = offset(9);
  const early = chart.drawMulti(800, 600);
  assert.equal(early.pinBox.head, "2026-11-18T09:00:00.000Z");
  assert.deepEqual(
    new Set(early.pinBox.rows.map((row) => row[0][0].trim())),
    new Set(["gfs", "icon-d2"]),
  );

  chart.getSeries = async () => ({ vars: {} });
  await chart.openChart(
    { name: "Bormio", lat: 46, lon: 10 },
    {
      multi: "tp",
      from: 6,
      until: 24,
    },
  );
  assert.equal(chart.chartData, null);
  assert.match(
    chart.chartUi.body.innerHTML,
    /Nessun modello ha dati in questo punto/,
  );

  chart.loadChart = async () => {};
  await chart.openChart(
    { name: "Bormio", lat: 46, lon: 10 },
    { ensemble: true },
  );
  assert.equal(chart.chartContext.from, 0);
  assert.equal(chart.chartContext.until, 384);
});
