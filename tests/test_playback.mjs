import { gzipSync } from "node:zlib";
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

test("startup fades only the loader without making the ready app transparent", async () => {
  for (const reducedMotion of [false, true]) {
    const fades = [];
    let removed = false;
    let restored = false;
    const loader = {
      animate(frames) {
        fades.push(Array.from(frames, (frame) => frame.opacity));
        return { finished: Promise.resolve() };
      },
      remove() {
        removed = true;
      },
    };
    const context = vm.createContext({
      init: async () => {},
      glBase: null,
      requestAnimationFrame: (callback) => callback(),
      matchMedia: () => ({ matches: reducedMotion }),
      document: {
        body: {
          classList: { remove() {} },
          removeAttribute() {},
          animate() {
            assert.fail("The ready app must never fade through a blank frame");
          },
        },
      },
      $: () => loader,
      restoreChartFromHash: () => { restored = true; },
      setStatus: (message) => assert.fail(message),
    });
    vm.runInContext(
      source.slice(source.indexOf("  async function start()"), source.lastIndexOf("  start();")),
      context,
    );
    await context.start();
    assert.deepEqual(fades, reducedMotion ? [] : [[1, 0]]);
    assert.equal(removed, true);
    assert.equal(restored, true);
  }
});

test("visible satellite preserves true colours and uses its own image times", async () => {
  const requests = [];
  const pixels = new Uint8ClampedArray([32, 96, 160, 255]);
  const state = { extra: "sat" };
  const context = vm.createContext({
    state,
    variable: () => ({}),
    runDate: () => new Date("2026-11-19T00:00:00Z"),
    cycle: () => "00Z",
    fmtRunDay: () => "19/11",
    fmtLocal: () => "19/11 11:00",
    glBase: {},
    radarFrames: [{ time: "2026-11-19T10:00:00Z" }],
    radarIdx: 0,
    location: { host: "localhost", pathname: "/" },
    meta: { bbox: { lat_min: 0, lon_min: 0, lat_max: 1, lon_max: 1 } },
    L: {
      latLng: (lat, lon) => ({ x: lon, y: lat }),
      CRS: { EPSG3857: { project: (point) => point } },
    },
    Image: class {
      set src(url) {
        requests.push(url);
        this.onload();
      }
    },
    document: {
      createElement: () => ({
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: pixels }),
          putImageData() {},
        }),
        toBlob: (callback) => callback({}),
      }),
    },
    URL: { createObjectURL: () => "blob:visible" },
    radarGrid: () => null,
    wmsUrl: (base, params) => `${base}?${new URLSearchParams(params)}`,
    fetch: async (url) => {
      requests.push(url);
      return {
        ok: true,
        headers: { get: () => "image/jpeg" },
        blob: async () => ({}),
        text: async () =>
          '<Dimension name="time" default="2026-11-19T10:00:00Z" />',
      };
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  const EXTRAS ="),
      source.indexOf('  map.createPane("radar")'),
    ) +
    source.slice(
      source.indexOf("  const EXTRA_W ="),
      source.indexOf("  const fmtRadarTime ="),
    ) +
    source.slice(
      source.indexOf("  function shareTexts()"),
      source.indexOf("  // crop in coordinates"),
    ) +
    "\nglobalThis.config = extraCfg;",
    context,
  );
  const infrared = context.config();
  assert.equal(infrared.layer, "mtg_fd:ir105_hrfi");
  assert.equal(typeof infrared.clean, "function");
  state.extra = "vis";
  const visible = context.config();
  assert.equal(visible.layer, "mtg_fd:rgb_truecolour");
  assert.equal(visible.clean, null);
  assert.equal(visible.stepMin, 10);
  assert.equal(await visible.latest(), "2026-11-19T10:00:00.000Z");
  assert.match(requests.at(-1), /mtg_fd\/rgb_truecolour\/ows/);
  assert.equal(
    (await context.extraImage(visible, "2026-11-19T10:00:00Z")).url,
    "blob:visible",
  );
  assert.deepEqual(Array.from(pixels), [32, 96, 160, 255]);
  assert.match(requests.at(-1), /layers=mtg_fd%3Argb_truecolour/);
  // downloaded as JPEG and used as it is (no canvas round trip)
  assert.match(requests.at(-1), /format=image%2Fjpeg/);
  const shared = context.shareTexts();
  assert.match(shared.title, /Satellite visibile/);
  assert.match(shared.sub, /Colori naturali/);
  assert.equal(shared.v.scale.thresholds.length, 0);
  assert.equal(shared.v.scale.colors.length, 0);
  state.extra = "sat";
  assert.equal(context.config(), infrared);
  state.extra = "radar";
  assert.equal(context.config().layer, "meteohub:radar-sri");
});

test("visible satellite has no legend and infrared restores its legend", () => {
  const state = { extra: "vis" };
  const legend = { hidden: false, innerHTML: "previous legend" };
  const context = vm.createContext({
    state,
    ui: { legend },
    SAT_SHADES: ["gray", "white", "cyan", "blue", "navy"],
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  function renderLegend()"),
      source.indexOf("  function fieldUrl("),
    ),
    context,
  );
  context.renderLegend();
  assert.equal(legend.hidden, true);
  assert.equal(legend.innerHTML, "");
  state.extra = "sat";
  context.renderLegend();
  assert.equal(legend.hidden, false);
  assert.match(legend.innerHTML, /infrarosso/);
});

test("infrared and visible satellite are separate saved layers", () => {
  const saved = new Map();
  const state = { extra: "none" };
  const context = vm.createContext({
    state,
    INTERVALS: [3, 6, 12, 24],
    BORDER_NAMES: {},
    localStorage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  const SETTINGS_KEY ="),
      source.indexOf("  // ---------- state in the URL"),
    ),
    context,
  );
  for (const extra of ["sat", "vis"]) {
    state.extra = extra;
    context.saveSettings();
    state.extra = "none";
    context.loadSettings();
    assert.equal(state.extra, extra);
  }
  assert.doesNotMatch(saved.get("weathermaps.settings.v1"), /satProduct/);
  // settings saved when visible was a channel of the satellite layer
  for (const [satProduct, extra] of [["vis", "vis"], ["ir", "sat"]]) {
    saved.set(
      "weathermaps.settings.v1",
      JSON.stringify({ extra: "sat", satProduct }),
    );
    state.extra = "none";
    context.loadSettings();
    assert.equal(state.extra, extra);
  }
});

test("radar and satellite landscape dates follow the displayed image", () => {
  for (const extra of ["radar", "sat", "vis"]) {
    const time = { textContent: "forecast time" };
    const context = vm.createContext({
      state: { extra },
      extraCfg: () => ({}),
      radarFrames: [
        { time: "2026-11-19T10:00:00Z" },
        { time: "2026-11-19T10:10:00Z" },
      ],
      radarIdx: 0,
      lvNav: { querySelector: () => time },
      fmtLocal: (date) => date.toISOString(),
    });
    vm.runInContext(
      source.slice(
        source.indexOf("  function renderLandscapeNav()"),
        source.indexOf("  function applyLandscape()"),
      ),
      context,
    );
    context.renderLandscapeNav();
    assert.equal(time.textContent, "2026-11-19T10:00:00.000Z");
    context.radarIdx = 1;
    context.renderLandscapeNav();
    assert.equal(time.textContent, "2026-11-19T10:10:00.000Z");
    context.radarFrames = [];
    context.renderLandscapeNav();
    assert.equal(time.textContent, "");
  }
});

test("mobile landscape resumes extra-layer loops without duplicating playback", () => {
  for (const extra of ["none", "radar", "sat"]) {
    let updates = 0;
    const context = vm.createContext({
      landscapeMq: { matches: true },
      document: { body: { classList: { toggle() {} } } },
      glBase: null,
      map: { doubleClickZoom: { disable() {}, enable() {} } },
      hoverMq: { matches: false },
      closeMapMenu() {},
      closePlacePop() {},
      extraCfg: () => extra === "none" ? undefined : {},
      radarPlay: null,
      radarAutoplay: false,
      updateRadarLoading: () => updates++,
      ui: { probe: {} },
      renderLandscapeNav() {},
      setTimeout() {},
    });
    vm.runInContext(
      source.slice(
        source.indexOf("  function applyLandscape()"),
        source.indexOf('  landscapeMq.addEventListener("change"'),
      ),
      context,
    );
    context.applyLandscape();
    assert.equal(context.radarAutoplay, extra !== "none");
    assert.equal(updates, extra === "none" ? 0 : 1);
    context.radarPlay = 1;
    context.radarAutoplay = false;
    context.applyLandscape();
    assert.equal(context.radarAutoplay, false);
    assert.equal(updates, extra === "none" ? 0 : 1);
    context.landscapeMq.matches = false;
    context.radarPlay = null;
    context.applyLandscape();
    assert.equal(context.radarAutoplay, false);
    assert.equal(updates, extra === "none" ? 0 : 1);
  }
});

test("satellite controls and legends stay hidden while images load", () => {
  const css = readFileSync(
    new URL("../static/style.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /body\.radar-loading \.badge,\s*body\.radar-loading \.legend\s*\{\s*visibility:\s*hidden/);
  assert.doesNotMatch(css, /body\.sat-mode\.radar-loading \.badge\s*\{[^}]*visibility:\s*visible/);
  assert.doesNotMatch(css, /body\.landscape-view\.radar-mode \.radar-loader/);
});

test("infrared and visible satellite are separate layer tiles, with no channel switch in the bar", () => {
  const html = readFileSync(
    new URL("../static/index.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(html, /satellite-mode/);
  const bar = html.slice(html.indexOf('id="badge"'), html.indexOf('id="share-dialog"'));
  assert.match(bar, /id="radar-slider"/);
  assert.match(bar, /id="extra-close"/);
  const names = source.slice(
    source.indexOf("  const EXTRA_NAMES ="),
    source.indexOf("  function setExtra("),
  );
  assert.match(names, /sat: "Infrarosso"/);
  assert.match(names, /vis: "Visibile"/);
  assert.ok(
    readFileSync(new URL("../static/icons/extra/vis.jpg", import.meta.url))
      .length > 0,
  );
  const css = readFileSync(
    new URL("../static/style.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.panel \.extra-tiles\s*\{\s*grid-template-columns:\s*repeat\(3, 1fr\)/);
});

test("ensemble is its own extra layer: places and map points open the spaghetti", () => {
  const opened = [];
  const context = vm.createContext({
    meta: {
      models: [{ id: "icon" }, { id: "gfs" }, { id: "ecmwf" }],
      ensemble: { gfs: { run: "2026112100" }, ecmwf: { run: "2026112100" } },
    },
    state: { model: "icon" },
    openChart: (p, options) => opened.push({ p, ...options }),
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  const EXTRA_NAMES ="),
      source.indexOf("  function setExtra("),
    ) + "\nglobalThis.hasEnsemble = hasEnsemble;",
    context,
  );
  assert.equal(context.hasEnsemble(), true);
  context.openEnsemble({ name: "Milano" });
  assert.deepEqual(opened.at(-1), { p: { name: "Milano" }, ensemble: true, model: "gfs" });
  context.state.model = "ecmwf";
  context.openEnsemble({ name: "Roma" });
  assert.equal(opened.at(-1).model, "ecmwf");
  context.meta.ensemble = {};
  assert.equal(context.hasEnsemble(), false);

  const popup = source.slice(
    source.indexOf("  function openPlacePop(idx)"),
    source.indexOf("  /** Position: centred on the point"),
  );
  assert.doesNotMatch(popup, /pt-pop-ens/);
  assert.match(popup, /state\.extra === "ens"[\s\S]*?openEnsemble\(places\[idx\]\)/);
  // a tap (or click) on a map point in ensemble mode opens its spaghetti; touch: the point menu right away
  const actionAt = source.indexOf("  function pointAction(ll)");
  const pointAction = source.slice(actionAt, source.indexOf('  map.on("click"', actionAt));
  assert.match(pointAction, /state\.extra === "ens"[\s\S]*openEnsemble\(/);
  assert.match(source, /if \(!hoverMq\.matches\) \{\s*pointAction\(e\.latlng\);/);
  const css = readFileSync(
    new URL("../static/style.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /body\.ens-mode \.wm-overlay/);
  assert.doesNotMatch(css, /body\.ens-mode \.pt\b/);
  assert.ok(
    readFileSync(new URL("../static/icons/extra/ens.jpg", import.meta.url))
      .length > 0,
  );
});

test("radar intensity at a place is read from the class colour of the image shown", () => {
  const context = vm.createContext({
    L: {
      latLng: (lat, lon) => ({ lat, lon }),
      CRS: { EPSG3857: { project: ({ lat, lon }) => ({ x: lon, y: lat }) } },
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  const RADAR_CLASSES ="),
      source.indexOf("  const radarSld ="),
    ) + "\nObject.assign(globalThis, { RADAR_CLASSES, RADAR_RGB });",
    context,
  );
  // 4×2 image over lon 0…4, lat 0…2: top row a 4–6 mm/h pixel (#80ff5a) then a slightly off one (compression),
  // bottom row dry (transparent) and a colour that is not ours
  const W = 4, H = 2;
  const d = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, rgba) => d.set(rgba, (y * W + x) * 4);
  put(0, 0, [0x80, 0xff, 0x5a, 255]);
  put(2, 0, [0x9a + 3, 0x25 - 2, 0xd6, 255]);
  put(0, 1, [0x80, 0xff, 0x5a, 0]);
  put(2, 1, [0, 0, 0, 255]);
  const grid = context.radarGrid(d, W, H, { x: 0, y: 0 }, { x: 4, y: 2 });
  assert.equal(grid.w, 2);
  assert.equal(grid.h, 1);
  assert.equal(context.radarClassAt(grid, 1.5, 0.5), 4);
  assert.equal(context.radarClassText(4), "4–6 mm/h");
  assert.equal(context.radarClassAt(grid, 1.5, 2.5), 9);
  assert.equal(context.radarClassText(9), "> 60 mm/h");
  assert.equal(context.radarClassText(1), "0,2–1 mm/h");
  assert.equal(context.radarClassAt(grid, 1.5, 9), null); // outside the image
  assert.equal(context.radarClassAt(null, 1, 1), null);
  const dry = new Uint8ClampedArray(W * H * 4);
  dry.set([0, 0, 0, 255], 0); // not one of our colours
  assert.equal(context.radarGrid(dry, W, H, { x: 0, y: 0 }, { x: 4, y: 2 }).data[0], 0);
  assert.match(source, /renderRadarPoints\(\);\n/);
});

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
      sat: { name: "Infrarosso", stepMin: 10 },
      vis: { name: "Visibile", stepMin: 10 },
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
    satOn: () => ["sat", "vis"].includes(layers.state.extra),
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

  for (const extra of ["radar", "sat", "vis", "snd"]) {
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

test("a single time position replaces panel controls with a notice and hides mobile navigation", () => {
  const state = { run: "2026111900", step: 24, hours: 24, cum: "hours" };
  let horizon = 33;
  const stepper = {};
  const elements = Object.fromEntries(
    [
      "step",
      "badge",
      "single-time-info",
      "single-time-text",
      "m-first",
      "m-prev",
      "m-next",
      "m-play",
      "m-step",
      "m-interval-step",
    ].map((id) => [id, {}]),
  );
  elements.step.closest = () => stepper;
  const landscapeButtons = [{}, {}, {}, {}];
  const steps = () =>
    Array.from({ length: horizon / 3 }, (_, index) => (index + 1) * 3);
  const context = vm.createContext({
    state,
    meta: {},
    variable: () => ({}),
    intervalStartDate: () => true,
    lvNav: {
      querySelectorAll: () => landscapeButtons,
      querySelector: () => ({}),
    },
    steps,
    availableSteps: () => new Set(steps()),
    slideSteps: () => context.rangeFrames(0, horizon),
    extraCfg: () => undefined,
    rangeMode: () => state.cum !== "value",
    intervalHours: () => state.hours,
    fmtShown: () => "gio 19 nov, 01:00 → ven 20 nov, 01:00",
    $: (id) => elements[id],
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  function rangeFrames("),
      source.indexOf("  // actual duration"),
    ) +
      source.slice(
        source.indexOf("  function renderTimeControls()"),
        source.indexOf("  function renderTime()"),
      ) +
      source.slice(
        source.indexOf("  function renderLandscapeNav()"),
        source.indexOf("  function applyLandscape()"),
      ),
    context,
  );
  const check = (single) => {
    vm.runInContext("renderTimeControls(); renderLandscapeNav();", context);
    assert.equal(stepper.hidden, single);
    for (const id of [
      "m-first",
      "m-prev",
      "m-next",
      "m-play",
      "m-step",
      "m-interval-step",
    ])
      assert.equal(elements[id].hidden, single, id);
    assert.equal(elements["single-time-info"].hidden, !single);
    for (const button of landscapeButtons) assert.equal(button.hidden, single);
    if (!single) assert.equal(elements["single-time-text"].textContent, "");
  };
  check(true);
  assert.match(
    elements["single-time-text"].textContent,
    /Un solo intervallo di 24 ore/,
  );
  assert.match(
    elements["single-time-text"].textContent,
    /gio 19 nov.*ven 20 nov/,
  );
  state.hours = 12;
  check(false);
  state.hours = 24;
  check(true);
  for (horizon of [48, 51, 72, 120, 192]) check(false);
  horizon = 33;
  state.cum = "total";
  check(false);
  state.cum = "hours";
  state.run = null;
  check(false);
});

test("static ensemble samples the official run on its native grid", async () => {
  const grid = { lat0: 45, lon0: 9, dlat: 0.5, dlon: 0.5, ny: 3, nx: 3 };
  const opGrid = { ...grid, dlat: 0.25, dlon: 0.25, ny: 5, nx: 5 };
  const info = { run: "2026111900", grid, op_grid: opGrid };
  const coarse = { lat: 45.5, lon: 10, tp: [[1]], op: { tp: [13.4] } };
  const native = { tp: [18.6], t850: [3] };
  const requests = [];
  let officialStatus = 200;
  const context = vm.createContext({
    STATIC: true,
    URLSearchParams,
    TextDecoder,
    Response,
    Blob,
    DecompressionStream,
    Uint8Array,
    meta: { ensemble: { gfs: info } },
    fetch: async (url) => {
      requests.push(url);
      const official = url.includes("/op/");
      // the static site stores the points gzip-compressed (scripts/build_static.py)
      const gz = gzipSync(JSON.stringify(official ? native : coarse));
      return {
        ok: !official || officialStatus === 200,
        arrayBuffer: async () =>
          gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
        json: async () => ({}), // server API (STATIC false): plain JSON
      };
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  async function gunzip("),
      source.indexOf("  /** Static site: field in compact format"),
    ) +
      source.slice(
        source.indexOf("  async function getEnsemble("),
        source.indexOf("  function writeChartHash("),
      ),
    context,
  );
  // parsed inside the sandbox (other realm): compared as plain data
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const point = plain(await context.getEnsemble("gfs", 45.65, 9.85));
  assert.deepEqual(point.tp, coarse.tp);
  assert.deepEqual(point.op, native);
  assert.deepEqual(requests.sort(), [
    "data/ensemble/gfs/2026111900/1_2.json",
    "data/ensemble/gfs/2026111900/op/3_3.json",
  ]);
  requests.length = 0;
  await context.getEnsemble("gfs", 45.625, 9.625);
  assert.ok(requests.includes("data/ensemble/gfs/2026111900/op/3_3.json"));
  officialStatus = 404;
  assert.equal((await context.getEnsemble("gfs", 45.65, 9.85)).op, null);
  delete info.op_grid;
  requests.length = 0;
  assert.deepEqual(
    plain((await context.getEnsemble("gfs", 45.65, 9.85)).op),
    coarse.op,
  );
  assert.equal(requests.length, 1);
  context.STATIC = false;
  requests.length = 0;
  await context.getEnsemble("gfs", 45.65, 9.85);
  assert.equal(requests[0], "api/ensemble?model=gfs&lat=45.65&lon=9.85");
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
    renderTimeControls() {},
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
