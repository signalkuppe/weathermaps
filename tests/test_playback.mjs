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
    state: { mode: "interval", startStep: 3, step: 12, hours: 9 },
    playTimer: null,
    playbackSelection: null,
    intervalSliders: [slider],
    intervalSteps: () => [0, 3, 6, 9, 12, 15],
    steps: () => [3, 6, 9, 12, 15],
    availableSteps: () => new Set([3, 6, 9, 12, 15]),
    intervalPrev: () => playback.state.startStep,
    rangeMode: () => true,
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

test("desktop time bar shows the fixed selected range during playback", () => {
  const state = { run: "2026111306", model: "icon-d2", mode: "interval", step: 9 };
  const time = vm.createContext({
    state,
    playbackSelection: { from: 3, to: 24 },
    ui: { valid: {}, range: {}, badgeText: {}, step: { style: { setProperty() {} } } },
    runDate: () => new Date("2026-11-13T06:00:00Z"),
    fmtLocal: () => "ven 13 nov, 16:00",
    fmtUTC: () => "15:00",
    cycle: () => "06Z",
    fmtRunDay: () => "ven 13 nov",
    modelLabel: () => "ICON-D2",
    shortLabel: () => "ICON-D2",
    rangeMode: () => true,
    intervalPrev: () => 3,
    intervalHours: () => 6,
    syncIntervalSliders() {},
    steps: () => [3, 6, 9, 12, 24],
    $: () => ({ style: { setProperty() {} } }),
  });
  vm.runInContext(source.slice(
    source.indexOf("  function renderTime()"),
    source.indexOf("  let seq = 0;"),
  ) + "\nrenderTime();", time);
  assert.match(time.ui.badgeText.innerHTML, /Da \+3h a \+24h · 21h/);
  assert.match(time.ui.badgeText.innerHTML, /badge-m-range">\+3&ndash;24h · 21h<\/span><\/span>/);
  assert.match(time.ui.badgeText.innerHTML, /badge-valid badge-d">\+9h/);
  assert.match(time.ui.badgeText.innerHTML, /<strong>06z<\/strong> 13\/11/);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /corsa/);

  time.playbackSelection = null;
  vm.runInContext("renderTime();", time);
  assert.match(time.ui.badgeText.innerHTML, /Da \+3h a \+9h · 6h/);
  assert.match(time.ui.badgeText.innerHTML, /badge-m-range">\+3&ndash;9h · 6h<\/span><\/span>/);

  time.playbackSelection = { from: 0, to: 24 };
  vm.runInContext("renderTime();", time);
  assert.match(time.ui.badgeText.innerHTML, /badge-range badge-d">\+24 ore<\/span>/);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /Da \+0h/);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /badge-valid badge-d">\+9h/);
  assert.match(time.ui.badgeText.innerHTML, /badge-m-range">\+24 ore<\/span>/);

  time.rangeMode = () => false;
  vm.runInContext("renderTime();", time);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /badge-range/);
  assert.doesNotMatch(time.ui.badgeText.innerHTML, /badge-m-range/);
});