import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../static/app.js", import.meta.url), "utf8");
const helperSource = source.slice(
  source.indexOf("  function rangePlaybackSteps("),
  source.indexOf("  const runInfo ="),
);
const context = vm.createContext({});
vm.runInContext(
  `${helperSource}\nglobalThis.rangePlaybackSteps = rangePlaybackSteps;`,
  context,
);

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
    value(value) { this.values = Array.from(value); },
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
          commitStyles() { this.committed = true; },
          cancel() { this.cancelled = true; },
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
    // range fisso da +3h a +12h, cumulata Totale: il play fa crescere l'accumulo dentro il range
    state: { mode: "interval", rangeFrom: 3, rangeTo: 12, cum: "total", step: 12, hours: 9 },
    playTimer: null,
    playbackSelection: null,
    intervalSliders: [slider],
    intervalSteps: () => [0, 3, 6, 9, 12, 15],
    steps: () => [3, 6, 9, 12, 15],
    availableSteps: () => new Set([3, 6, 9, 12, 15]),
    intervalPrev: () => playback.state.rangeFrom,
    rangeMode: () => true,
    rangeFrames: (from, to) => [3, 6, 9, 12, 15].filter((x) => x > from && x <= to),
    syncMode() {},
    dualMode: () => true, // Totale: slider a due maniglie
    slideSteps: () => [3, 6, 9, 12, 15],
    ui: { play: button(), mPlay: button(), step: {} },
    setInterval(callback) { tick = callback; return 1; },
    clearInterval() { tick = null; },
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
  assert.deepEqual(animations[0].keyframes.map(({ left }) => left), slider.progressBounds);
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
  assert.equal(slider.progress.style.top, "calc(50% - var(--interval-thumb-size) / 2 - 12px)");
  playback.play(false);
});

test("time bars show the interval as dates, with the start", () => {
  const state = { run: "2026111306", model: "icon-d2", mode: "interval", step: 9 };
  const time = vm.createContext({
    state,
    playbackSelection: { from: 3, to: 24 },
    ui: {
      valid: { classList: { toggle() {} } },
      range: {},
      badgeText: {},
      step: { style: { setProperty() {} } },
    },
    // come quella vera: con la corsa vuota si rompe (slice di null)
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
  // formattatori veri delle date (fmtDay … fmtShown) e renderTime
  vm.runInContext(
    source.slice(source.indexOf("  const fmtDay ="), source.indexOf("  const hexToRgb =")) +
      source.slice(source.indexOf("  function renderTime()"), source.indexOf("  let seq = 0;")) +
      "\nrenderTime();",
    time,
  );
  // intervallo da +3h (10:00 a Roma) al passo mostrato +9h (16:00), stesso giorno: il giorno una volta sola
  const span = "ven 13, 10:00 → 16:00";
  assert.match(time.ui.badgeText.innerHTML, new RegExp(`badge-valid badge-d">${span}</span>`));
  assert.match(time.ui.badgeText.innerHTML, new RegExp(`badge-m-time"><b>${span}</b><span class="badge-m-range">6h</span>`));
  assert.equal(time.ui.valid.textContent, span);
  assert.equal(time.ui.range.textContent, "");
  assert.match(time.ui.badgeText.innerHTML, /<strong>06z<\/strong> 13\/11/);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /corsa|Da \+/);

  time.playbackSelection = null;
  vm.runInContext("renderTime();", time);
  assert.match(time.ui.badgeText.innerHTML, new RegExp(`badge-valid badge-d">${span}</span>`));

  // totale dalla corsa: istante e passo, niente data d'inizio
  state.mode = "total";
  time.playbackSelection = { from: 0, to: 24 };
  vm.runInContext("renderTime();", time);
  assert.match(time.ui.badgeText.innerHTML, /badge-valid badge-d">ven 13 nov, 15:00 · \+9h<\/span>/);
  // durante il play la barra dice la cumulata dell'immagine mostrata (fino a +9h), non la fine del range
  assert.match(time.ui.badgeText.innerHTML, /badge-m-range">\+9 ore<\/span>/);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /→/);

  // grandezza istantanea: niente intervallo, l'ora UTC sotto nel pannello
  state.mode = "value";
  time.rangeMode = () => false;
  vm.runInContext("renderTime();", time);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /badge-m-range/);
  assert.equal(time.ui.range.textContent, "14:00 UTC");

  // grandezza che il modello non ha: nessuna corsa, niente date (prima l'avvio si fermava con un errore)
  state.run = null;
  time.variable = () => ({ models: ["gfs"] });
  vm.runInContext("renderTime();", time);
  assert.equal(time.ui.valid.textContent, "");
  assert.match(time.ui.badgeText.innerHTML, /grandezza non disponibile/);
});

test("range frames: every step with the total, one image every chosen hours otherwise", () => {
  const fnSource = source.slice(
    source.indexOf("  function rangeFrames("),
    source.indexOf("  // durata effettiva della cumulata al passo mostrato"),
  );
  // passi ogni 3 ore fino a +144h, poi ogni 6 ore
  const all = [...Array.from({ length: 48 }, (_, i) => 3 * (i + 1)), 150, 156, 162, 168];
  const ctx = vm.createContext({
    state: { rangeFrom: 6, rangeTo: 30, cum: "total", hours: 6, step: 30 },
    steps: () => all,
    availableSteps: () => new Set(all),
  });
  vm.runInContext(`${fnSource}\nglobalThis.frames = rangeFrames;`, ctx);
  // Totale: ogni passo dopo l'inizio del range, fino alla fine
  assert.deepEqual([...ctx.frames()], [9, 12, 15, 18, 21, 24, 27, 30]);
  // 6h dentro lo stesso range: 06-12, 12-18, 18-24, 24-30
  ctx.state.cum = "hours";
  assert.deepEqual([...ctx.frames()], [12, 18, 24, 30]);
  // 3h oltre +144h (passi ogni 6 ore): una sola immagine per passo, senza doppioni
  Object.assign(ctx.state, { rangeFrom: 138, rangeTo: 168, hours: 3 });
  assert.deepEqual([...ctx.frames()], [141, 144, 150, 156, 162, 168]);
});
