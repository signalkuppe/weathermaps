/* Weathermaps: frontend. Tutto ciò che dipende da area, modelli e grandezze
   arriva da /api/meta e /api/runs: qui non ci sono coordinate né soglie fisse. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ui = {
    model: $("model"), varSel: $("var"), varRow: $("var-row"), run: $("run"),
    mode: $("mode"), modeRow: $("mode-row"), step: $("step"), prev: $("prev"),
    next: $("next"), play: $("play"), opacity: $("opacity"), crisp: $("crisp"),
    valid: $("valid"), range: $("range"), status: $("status"), legend: $("legend"),
    probe: $("probe"), panel: $("panel"), collapse: $("collapse"),
    badge: $("badge"), runAge: $("run-age"),
    runLive: $("run-live"), runLiveText: $("run-live-text"), refresh: $("refresh"), runLiveNote: $("run-live-note"),
    pointsBox: $("points-box"), points: $("points"), pointsUnit: $("points-unit"),
    modelInfo: $("model-info"), modelInfoBtn: $("model-info-btn"),
  };

  // runPinned: la corsa è stata scelta a mano; altrimenti si segue sempre l'ultima disponibile
  const state = { model: null, var: null, run: null, runPinned: false, step: null, mode: null, opacity: 0.55, crisp: false, base: "osm" };
  // "static": sito pubblicato su GitHub Pages (file JSON pre-generati, nessun server)
  const STATIC = document.documentElement.dataset.mode === "static";
  let publishedAt = null; // solo statico: quando sono stati pubblicati i dati
  let meta = null;
  let runs = null;
  let current = null; // risposta /api/field mostrata
  let overlay = null;
  let playTimer = null;
  const cache = new Map();

  // ---------- mappa
  const map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    // zoom frazionario: lo zoom minimo può aderire esattamente all'area coperta
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    maxBoundsViscosity: 1.0, // impedisce di trascinare fuori dall'area
  });
  map.zoomControl.setPosition("topright");
  const bases = {
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      crossOrigin: "anonymous",
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      crossOrigin: "anonymous",
      maxZoom: 17,
      attribution: 'Mappa &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), dati &copy; OpenStreetMap',
    }),
  };
  map.createPane("labels");
  map.getPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
  const labels = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png", {
    crossOrigin: "anonymous",
    pane: "labels",
    subdomains: "abcd",
    maxZoom: 19,
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  });
  L.control.layers(
    { "OpenStreetMap": bases.osm, "OpenTopoMap (rilievo)": bases.topo },
    { "Etichette sopra i dati": labels },
    { position: "topright" },
  ).addTo(map);
  map.attributionControl.addAttribution("Dati: NOAA/NCEP GFS · ECMWF Open Data (CC-BY-4.0) · ItaliaMeteo ICON-2I (CC-BY) · DWD ICON-D2 · MeteoSvizzera ICON-CH1/CH2 (CC-BY)");
  map.on("baselayerchange", (e) => {
    state.base = e.layer === bases.topo ? "topo" : "osm";
    writeHash();
  });

  // ---------- util
  const fmtRun = (rid) => {
    const d = runDate(rid);
    const day = d.toLocaleDateString("it-IT", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
    return `${day} ${rid.slice(8, 10)}Z`;
  };
  const cycle = (rid) => `${rid.slice(8, 10)}Z`;
  const fmtRunDay = (rid) =>
    runDate(rid).toLocaleDateString("it-IT", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  const fmtAge = (rid) => {
    const h = Math.max(0, Math.round((Date.now() - runDate(rid).getTime()) / 3600e3));
    return h < 48 ? `${h}h fa` : `${Math.round(h / 24)} giorni fa`;
  };
  const shortLabel = (id) => (meta.models.find((m) => m.id === id)?.label || id).split(" ")[0];
  const modelLabel = () => meta.models.find((m) => m.id === state.model)?.label || state.model;
  const runDate = (rid) =>
    new Date(Date.UTC(+rid.slice(0, 4), +rid.slice(4, 6) - 1, +rid.slice(6, 8), +rid.slice(8, 10)));
  const fmtLocal = (d) =>
    d.toLocaleString("it-IT", { timeZone: "Europe/Rome", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtUTC = (d) => d.toLocaleString("it-IT", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const variable = () => meta.variables.find((v) => v.id === state.var);
  // passi del modello scelto: lo slider si ferma all'orizzonte del modello (es. ICON-CH2 a +120h)
  const steps = () => {
    const max = meta.models.find((m) => m.id === state.model)?.max_step ?? Infinity;
    return meta.steps.filter((s) => s <= max);
  };
  const runInfo = () => (runs[state.model] || []).find((r) => r.run === state.run);
  const availableSteps = () => new Set(runInfo()?.variables[state.var]?.steps || []);

  function setStatus(text, warn = false) {
    ui.status.textContent = text || "";
    ui.status.classList.toggle("warn", !!warn);
  }

  // ---------- stato nell'URL
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const k of ["model", "var", "mode"]) if (p.get(k)) state[k] = p.get(k);
    // "corsa" = corsa fissata a mano (il vecchio parametro "run" viene ignorato di proposito)
    if (p.get("corsa")) { state.run = p.get("corsa"); state.runPinned = true; }
    if (p.get("step")) state.step = +p.get("step");
    if (p.get("opacity")) state.opacity = Math.min(1, Math.max(0.1, +p.get("opacity")));
    if (p.get("crisp")) state.crisp = p.get("crisp") === "1";
  }
  function writeHash() {
    const p = new URLSearchParams();
    for (const k of ["model", "var", "step", "mode", "opacity"]) if (state[k] != null) p.set(k, state[k]);
    // la corsa va nell'URL solo se scelta a mano: un link "normale" mostra sempre l'ultima
    if (state.runPinned && state.run) p.set("corsa", state.run);
    if (state.crisp) p.set("crisp", "1");
    history.replaceState(null, "", "#" + p.toString());
  }

  // ---------- popolamento controlli
  // bandiere: libreria flag-icons (tutte in formato 4:3, stessa larghezza); per la media un'icona Lucide "layers" (ISC)
  const LAYERS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>';
  const modelIcon = (m) =>
    m.country ? `<span class="fi fi-${m.country}"></span>` : m.id === "mean" ? LAYERS_ICON : "";

  /** Select dei modelli: bandiera + nome. Il <button><selectedcontent> iniziale resta al suo posto. */
  function fillModelSelect(models, value) {
    for (const o of [...ui.model.querySelectorAll("option")]) o.remove();
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m.id;
      const kind = m.country ? "flag" : "glyph";
      o.innerHTML = `<span class="opt-icon ${kind}" aria-hidden="true">${modelIcon(m)}</span><span class="opt-label"></span>`;
      o.querySelector(".opt-label").textContent = m.label;
      o.selected = m.id === value;
      ui.model.append(o);
    }
    ui.model.value = value;
  }

  function fillSelect(sel, items, value) {
    sel.replaceChildren(...items.map(([v, label]) => new Option(label, v, false, v === value)));
  }

  function setupModels() {
    const models = meta.models.filter((m) => variable().models.includes(m.id));
    if (!models.find((m) => m.id === state.model)) state.model = models[0].id;
    fillModelSelect(models, state.model);
    renderModelInfo();
  }

  // ---------- icona informazioni sul modello scelto
  function renderModelInfo() {
    const m = meta.models.find((x) => x.id === state.model);
    const text = m?.description || "";
    ui.modelInfo.textContent = text;
    ui.modelInfoBtn.title = text ? `${m.label}: ${text}` : "";
    ui.modelInfoBtn.hidden = !text;
    if (!text) setModelInfoOpen(false);
  }
  function setModelInfoOpen(open) {
    ui.modelInfo.hidden = !open;
    ui.modelInfoBtn.setAttribute("aria-expanded", String(open));
  }
  ui.modelInfoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setModelInfoOpen(ui.modelInfo.hidden);
  });
  document.addEventListener("click", (e) => {
    if (!ui.modelInfo.hidden && !e.target.closest("#model-info, #model-info-btn")) setModelInfoOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setModelInfoOpen(false);
  });

  function setupVars() {
    if (!meta.variables.find((v) => v.id === state.var)) state.var = meta.variables[0].id;
    fillSelect(ui.varSel, meta.variables.map((v) => [v.id, v.label]), state.var);
    ui.varRow.hidden = meta.variables.length < 2;
  }

  function setupModes() {
    const v = variable();
    if (!v.modes.includes(state.mode)) state.mode = v.modes[0];
    const labels = { total: "Totale", interval: "Intervallo", value: "Valore" };
    ui.mode.replaceChildren(
      ...v.modes.map((m) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = labels[m] || m;
        b.setAttribute("aria-pressed", String(m === state.mode));
        b.addEventListener("click", () => { state.mode = m; setupModes(); update(); });
        return b;
      }),
    );
    ui.modeRow.hidden = v.modes.length < 2;
  }

  function runList() {
    return (runs[state.model] || []).filter((r) => r.variables[state.var]);
  }

  /** Ritorna true se la corsa selezionata è cambiata. */
  function setupRuns() {
    const before = state.run;
    const list = runList();
    if (!list.length) {
      ui.run.replaceChildren(Object.assign(document.createElement("span"), { className: "runs-empty", textContent: "nessuna corsa disponibile" }));
      state.run = null;
      ui.runAge.textContent = "";
      return before !== state.run;
    }
    const latest = list[0].run;
    if (!state.runPinned || !list.find((r) => r.run === state.run)) {
      state.run = latest;
      state.runPinned = false;
    }
    ui.run.replaceChildren(
      ...list.map((r) => {
        const info = r.variables[state.var];
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(r.run === state.run));
        b.className = "run-btn";
        const partial = info.complete ? "" : `<em>${info.steps.length}/${steps().length} passi</em>`;
        const tag = r.run === latest ? '<i class="latest">ultima</i>' : "";
        b.innerHTML = `<strong>${cycle(r.run)}</strong><small>${fmtRunDay(r.run)}</small>${tag}${partial}`;
        b.title = `Corsa delle ${cycle(r.run)} del ${fmtRunDay(r.run)}${info.complete ? "" : " (ancora in arrivo)"}`;
        b.addEventListener("click", () => {
          state.run = r.run;
          state.runPinned = r.run !== latest;
          setupRuns();
          setupSteps();
          update();
        });
        return b;
      }),
    );
    const sel = list.find((r) => r.run === state.run)?.variables[state.var];
    ui.runAge.textContent =
      state.model === "mean" && sel?.members
        ? `media di ${Object.keys(sel.members).length} modelli`
        : `emessa ${fmtAge(state.run)}`;
    renderRunLive(list[0]);
    return before !== state.run;
  }

  // ---------- corsa in arrivo: stato + pulsante "Aggiorna"
  let refreshing = false;

  function renderRunLive(latest) {
    const info = latest?.variables[state.var];
    const partial = info && !info.complete;
    ui.runLive.hidden = !partial && !refreshing;
    if (partial) ui.runLiveText.textContent = `${cycle(latest.run)} in arrivo · ${info.steps.length}/${steps().length} passi`;
    else if (latest) ui.runLiveText.textContent = `Corsa ${cycle(latest.run)} completa`;
  }

  /** Passi scaricati dell'ultima corsa del modello, su tutte le grandezze. */
  function latestSnapshot(model) {
    const r = (runs[model] || [])[0];
    if (!r) return { run: null, n: 0 };
    return { run: r.run, n: Object.values(r.variables).reduce((a, v) => a + v.steps.length, 0) };
  }

  async function doRefresh() {
    if (refreshing) return;
    refreshing = true;
    const model = state.model;
    const before = latestSnapshot(model);
    ui.refresh.disabled = true;
    ui.refresh.textContent = "Controllo…";
    ui.runLiveNote.textContent = "";
    let note;
    if (STATIC) {
      try {
        await refreshRuns();
        if (state.model === model) {
          const changed = setupRuns();
          if (changed) setupSteps();
          if (changed || !current) update();
        }
        const after = latestSnapshot(model);
        const at = publishedAt ? new Date(publishedAt).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }) : "?";
        if (after.run && after.run !== before.run) note = `Nuova corsa ${cycle(after.run)} disponibile`;
        else if (after.n > before.n) note = `${after.n - before.n} nuovi passi`;
        else note = `Nessun passo nuovo · dati pubblicati alle ${at}, aggiornati ogni 30 min`;
      } catch (e) {
        note = `Aggiornamento non riuscito: ${e.message}`;
      }
      refreshing = false;
      ui.refresh.disabled = false;
      ui.refresh.textContent = "↻ Aggiorna";
      ui.runLiveNote.textContent = note;
      if (state.model === model) renderRunLive(runList()[0]);
      return;
    }
    try {
      const res = await fetch(`api/refresh?model=${encodeURIComponent(model)}`, { method: "POST" });
      if (!res.ok) throw new Error(res.statusText);
      const started = await res.json();
      const t0 = Date.now();
      // segue l'aggiornamento sul server e mostra i passi man mano che arrivano
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const st = await fetch(`api/refresh?model=${encodeURIComponent(model)}`, { cache: "no-store" }).then((r) => r.json());
        await refreshRuns();
        if (state.model === model) {
          const changed = setupRuns();
          if (changed) setupSteps();
          if (changed || !current) update();
        }
        const now = latestSnapshot(model);
        const added = now.run === before.run ? now.n - before.n : now.n;
        if (st.running) ui.refresh.textContent = added > 0 ? `Scarico… +${added}` : "Controllo…";
        if (!st.running || Date.now() - t0 > 5 * 60e3) break;
      }
      const after = latestSnapshot(model);
      if (after.run && after.run !== before.run) note = `Nuova corsa ${cycle(after.run)} disponibile`;
      else if (after.n > before.n) note = `${after.n - before.n} nuovi passi scaricati`;
      else if (started.reason === "cooldown" && started.finished) {
        const ago = Math.round(Date.now() / 1000 - started.finished);
        note = `Nessun passo nuovo (ultimo controllo ${ago}s fa, riprova fra ${Math.max(1, started.cooldown_s - ago)}s)`;
      }
      else note = "Nessun passo nuovo per ora";
    } catch (e) {
      note = `Aggiornamento non riuscito: ${e.message}`;
    }
    refreshing = false;
    ui.refresh.disabled = false;
    ui.refresh.textContent = "↻ Aggiorna";
    ui.runLiveNote.textContent = note;
    if (state.model === model) renderRunLive(runList()[0]);
  }
  ui.refresh.addEventListener("click", doRefresh);

  function setupSteps() {
    const s = steps();
    ui.step.max = s.length - 1;
    if (!s.includes(state.step)) {
      const avail = [...availableSteps()];
      state.step = avail.includes(24) ? 24 : avail[0] ?? s[0];
    }
    ui.step.value = s.indexOf(state.step);
  }

  function renderLegend() {
    const v = variable();
    const { thresholds, colors } = v.scale;
    const modeLabel = state.mode === "interval" ? "nell'intervallo" : state.mode === "total" ? "totale" : "";
    const num = (x) => String(x).replace("-", "−");
    const openLow = v.scale.transparent_below == null; // la prima classe include anche i valori più bassi
    const items = thresholds.map((t, i) => {
      const next = thresholds[i + 1];
      const text =
        next == null ? `> ${num(t)}` : i === 0 && openLow ? `< ${num(next)}` : `${num(t)} … ${num(next)}`;
      return `<li><i style="background:${colors[i]}"></i>${text}</li>`;
    });
    ui.legend.innerHTML = `<h2>${v.label} ${modeLabel} (${v.units})</h2><ol>${items.join("")}</ol>`;
  }

  // ---------- dati
  const ctxNow = () => ({ model: state.model, var: state.var, run: state.run });

  function fieldUrl(step, mode, ctx) {
    if (STATIC) return `data/field/${ctx.model}/${ctx.var}/${ctx.run}/${step}.json`;
    const p = new URLSearchParams({ ...ctx, step, mode });
    return `api/field?${p}`;
  }

  async function getField(step, mode = state.mode, ctx = ctxNow()) {
    // statico: c'è solo il totale; l'intervallo è la differenza fra due totali (come fa il server)
    if (STATIC && mode === "interval") return getIntervalStatic(step, ctx);
    const url = fieldUrl(step, mode, ctx);
    if (!cache.has(url)) {
      const pr = fetch(url).then(async (r) => {
        if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || r.statusText), { status: r.status });
        return r.json();
      });
      cache.set(url, pr);
      pr.catch(() => cache.delete(url));
    }
    return cache.get(url);
  }

  function getIntervalStatic(step, ctx) {
    const key = `interval|${ctx.model}|${ctx.var}|${ctx.run}|${step}`;
    if (!cache.has(key)) {
      const pr = (async () => {
        const cur = await getField(step, "total", ctx);
        const i = meta.steps.indexOf(step);
        const prevStep = i > 0 ? meta.steps[i - 1] : 0;
        if (!prevStep) return { ...cur, mode: "interval", prev_step: 0 };
        const prev = await getField(prevStep, "total", ctx);
        const v = meta.variables.find((x) => x.id === ctx.var);
        const f = 10 ** v.decimals;
        let max = null;
        let min = null;
        const values = cur.values.map((x, k) => {
          const y = prev.values[k];
          if (x == null || y == null) return null;
          const d = Math.round(Math.max(0, x - y) * f) / f;
          if (max == null || d > max) max = d;
          if (min == null || d < min) min = d;
          return d;
        });
        return { ...cur, mode: "interval", prev_step: prevStep, values, max, min };
      })();
      cache.set(key, pr);
      pr.catch(() => cache.delete(key));
    }
    return cache.get(key);
  }

  function prefetch() {
    const s = steps();
    const i = s.indexOf(state.step);
    const avail = availableSteps();
    for (const j of [i + 1, i - 1, i + 2]) if (s[j] != null && avail.has(s[j])) getField(s[j]).catch(() => {});
  }

  // ---------- rendering
  function mercY(lat) {
    const r = (lat * Math.PI) / 180;
    return Math.log(Math.tan(Math.PI / 4 + r / 2));
  }
  function invMercY(y) {
    return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
  }

  function colorizer(scale) {
    const rgb = scale.colors.map(hexToRgb);
    const th = scale.thresholds;
    const below = scale.transparent_below;
    return (v) => {
      if (v == null || Number.isNaN(v)) return null;
      if (below != null && v < below) return null;
      let k = 0;
      while (k + 1 < th.length && v >= th[k + 1]) k++;
      if (v < th[0]) k = 0;
      return rgb[k];
    };
  }

  function sampler(f, crisp) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    const vals = f.values;
    const at = (iy, ix) => vals[iy * nx + ix];
    if (crisp) {
      return (lat, lon) => {
        const ix = Math.round((lon - lon0) / dlon);
        const iy = Math.round((lat - lat0) / dlat);
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return null;
        return at(iy, ix);
      };
    }
    return (lat, lon) => {
      let fx = (lon - lon0) / dlon;
      let fy = (lat - lat0) / dlat;
      if (fx < -0.5 || fy < -0.5 || fx > nx - 0.5 || fy > ny - 0.5) return null;
      fx = Math.min(Math.max(fx, 0), nx - 1);
      fy = Math.min(Math.max(fy, 0), ny - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1);
      const tx = fx - x0, ty = fy - y0;
      const a = at(y0, x0), b = at(y0, x1), c = at(y1, x0), d = at(y1, x1);
      if (a == null || b == null || c == null || d == null) return at(Math.round(fy), Math.round(fx));
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };
  }

  function draw(f) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    // bordi delle celle
    const south = lat0 - dlat / 2, north = lat0 + (ny - 1) * dlat + dlat / 2;
    const west = lon0 - dlon / 2, east = lon0 + (nx - 1) * dlon + dlon / 2;
    const upscale = Math.max(2, Math.ceil(1100 / nx));
    const W = nx * upscale;
    const yN = mercY(north), yS = mercY(south);
    const lonSpanRad = ((east - west) * Math.PI) / 180;
    const H = Math.max(1, Math.round((W * (yN - yS)) / lonSpanRad));

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const color = colorizer(variable().scale);
    const sample = sampler(f, state.crisp);
    const lons = new Float64Array(W);
    for (let x = 0; x < W; x++) lons[x] = west + ((x + 0.5) / W) * (east - west);
    for (let y = 0; y < H; y++) {
      const lat = invMercY(yN - ((y + 0.5) / H) * (yN - yS));
      for (let x = 0; x < W; x++) {
        const c = color(sample(lat, lons[x]));
        if (!c) continue;
        const o = (y * W + x) * 4;
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const bounds = L.latLngBounds([south, west], [north, east]);
    const url = canvas.toDataURL("image/png");
    if (!overlay) {
      overlay = L.imageOverlay(url, bounds, { opacity: state.opacity, className: "wm-overlay", interactive: false }).addTo(map);
    } else {
      overlay.setUrl(url);
      overlay.setBounds(bounds);
    }
    overlay.getElement()?.classList.toggle("crisp", state.crisp);
  }

  function clearOverlay() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
  }

  function renderTime() {
    const s = state.step;
    const run = runDate(state.run || "1970010100");
    const valid = new Date(run.getTime() + s * 3600e3);
    ui.valid.textContent = state.run ? `${fmtLocal(valid)} · +${s}h` : "—";
    if (!state.run) {
      ui.range.textContent = "—";
      ui.badge.innerHTML = `<b>${modelLabel()}</b> · nessuna corsa`;
      return;
    }
    const runWord = state.model === "mean" ? "dalle" : "corsa";
    ui.badge.innerHTML =
      `<b>${modelLabel()}</b><span class="badge-run">${runWord} <strong>${cycle(state.run)}</strong> ${fmtRunDay(state.run)}</span>` +
      `<span class="badge-valid">+${s}h · ${fmtLocal(valid)}</span>`;
    const i = steps().indexOf(s);
    const prev = i > 0 ? steps()[i - 1] : 0;
    const utc = `${fmtUTC(valid)} UTC`;
    if (state.mode === "interval") ui.range.textContent = `${utc} · pioggia fra +${prev}h e +${s}h (${s - prev}h)`;
    else if (state.mode === "total") ui.range.textContent = `${utc} · accumulo da +0h a +${s}h`;
    else ui.range.textContent = utc;
  }

  let seq = 0;
  async function update() {
    writeHash();
    renderLegend();
    renderTime();
    if (!state.run) { clearOverlay(); current = null; renderPoints(); setStatus("Nessun dato ancora scaricato per questo modello.", true); return; }
    if (!availableSteps().has(state.step)) {
      clearOverlay(); current = null; renderPoints();
      setStatus("");
      return;
    }
    const my = ++seq;
    setStatus("Caricamento…");
    try {
      const f = await getField(state.step);
      if (my !== seq) return;
      current = f;
      draw(f);
      renderPoints();
      let text = "";
      if (f.max != null) {
        text = variable().kind === "accum" ? `Massimo nell'area: ${f.max} ${f.units}` : `Nell'area: min ${f.min} · max ${f.max} ${f.units}`;
      }
      if (f.members && f.member_runs) {
        const names = f.members.map((id) => `${shortLabel(id)} ${cycle(f.member_runs[id])}`).join(", ");
        text += `${text ? " · " : ""}media di ${f.members.length}: ${names}`;
      }
      setStatus(text);
      prefetch();
    } catch (e) {
      if (my !== seq) return;
      clearOverlay(); current = null; renderPoints();
      setStatus(`Errore: ${e.message}`, true);
    }
  }

  // ---------- punti fissi (da /api/meta): marcatore numerato + valore, elenco nel pannello
  const pointMarkers = [];
  const pointRows = [];

  /** Valore del punto di griglia più vicino (come il tooltip), null se fuori griglia o mancante. */
  function valueAt(f, lat, lon) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    const ix = Math.round((lon - lon0) / dlon);
    const iy = Math.round((lat - lat0) / dlat);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return null;
    return f.values[iy * nx + ix];
  }

  function setupPoints() {
    const pts = meta.points || [];
    ui.pointsBox.hidden = !pts.length;
    // su schermi stretti l'elenco parte chiuso per non coprire la mappa
    if (window.matchMedia("(max-width: 600px)").matches) ui.pointsBox.open = false;
    for (const p of pts) {
      const icon = L.divIcon({
        className: `pt pt-${p.label || "right"}`,
        html: `<span class="pt-num">–</span><span class="pt-val">—</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const m = L.marker([p.lat, p.lon], { icon, keyboard: false, riseOnHover: true })
        .bindTooltip(p.name, { direction: "top", offset: [0, -12] })
        .addTo(map);
      pointMarkers.push(m);

      const li = document.createElement("li");
      li.innerHTML = `<span class="pt-num">–</span><span class="pt-name"></span><span class="pt-v">—</span>`;
      li.querySelector(".pt-name").textContent = p.name;
      li.title = `Centra la mappa su ${p.name}`;
      li.addEventListener("click", () => map.panTo([p.lat, p.lon]));
      li.addEventListener("mouseenter", () => m.openTooltip());
      li.addEventListener("mouseleave", () => m.closeTooltip());
      ui.points.append(li);
      pointRows.push(li);
    }
  }

  function renderPoints() {
    const pts = meta.points || [];
    const dec = variable().decimals;
    const color = colorizer(variable().scale);
    const values = [];
    const dir = variable().rank === "asc" ? "dal più basso" : "dal più alto";
    ui.pointsUnit.textContent = current ? `(${current.units}${state.mode === "interval" ? ", intervallo" : state.mode === "total" ? ", totale" : ""}, ${dir})` : "";
    pts.forEach((p, i) => {
      const v = current ? valueAt(current, p.lat, p.lon) : null;
      const text = v == null ? "—" : v.toFixed(dec);
      const c = v == null ? null : color(v);
      const el = pointMarkers[i].getElement();
      if (el) {
        el.querySelector(".pt-val").textContent = text;
        el.querySelector(".pt-num").style.background = c ? `rgb(${c.join(",")})` : "";
        el.classList.toggle("pt-dark", !!c && c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 140);
      }
      pointRows[i].querySelector(".pt-v").textContent = v == null ? "—" : `${text} ${current.units}`;
      const n = pointRows[i].querySelector(".pt-num");
      n.style.background = c ? `rgb(${c.join(",")})` : "";
      n.classList.toggle("pt-dark", !!c && c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 140);
      values[i] = v;
    });
    // classifica: dal valore più alto; a parità stessa posizione (1, 2, 2, 4), i "—" in fondo senza numero.
    // Si confrontano i valori arrotondati come mostrati, così due "2.4" hanno la stessa posizione.
    const shown = values.map((v) => (v == null ? null : Number(v.toFixed(dec))));
    // direzione dalla grandezza: "desc" = più alto primo (pioggia), "asc" = più basso primo (temperatura)
    const sign = variable().rank === "asc" ? -1 : 1;
    const key = (i) => (shown[i] == null ? -Infinity : sign * shown[i]);
    const order = pts.map((_, i) => i).sort((a, b) => key(b) - key(a) || a - b);
    let rank = 0;
    order.forEach((i, pos) => {
      if (shown[i] == null) rank = null;
      else if (pos === 0 || shown[i] !== shown[order[pos - 1]]) rank = pos + 1;
      const label = rank == null ? "–" : String(rank);
      pointRows[i].querySelector(".pt-num").textContent = label;
      const el = pointMarkers[i].getElement();
      if (el) el.querySelector(".pt-num").textContent = label;
      // i primi in classifica sopra gli altri se i marcatori si toccano
      pointMarkers[i].setZIndexOffset((order.length - pos) * 10);
    });
    ui.points.append(...order.map((i) => pointRows[i]));
  }

  // ---------- condivisione: immagine della mappa che si sta guardando
  const shareUi = {
    btn: $("share"), toast: $("share-toast"), dialog: $("share-dialog"), preview: $("share-preview"),
    send: $("share-send"), download: $("share-download"), close: $("share-close"),
  };
  let shareFile = null;
  let shareText = "";

  /** Link alla stessa vista, con la corsa fissata (chi lo apre vede proprio questa corsa). */
  function shareUrl() {
    const p = new URLSearchParams();
    for (const k of ["model", "var", "step", "mode"]) if (state[k] != null) p.set(k, state[k]);
    if (state.run) p.set("corsa", state.run);
    return `${location.origin}${location.pathname}#${p}`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

  /** Spezza un testo in righe che stanno in `maxWidth` (con il font già impostato su ctx). */
  function wrapLines(ctx, text, maxWidth) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Compone mappa + dati + punti + intestazione + legenda in un'immagine JPEG. */
  async function composeImage() {
    const container = map.getContainer();
    const cr = container.getBoundingClientRect();
    const W = Math.round(cr.width);
    const Hm = Math.round(cr.height);

    // testi di intestazione e fonti, spezzati sulla larghezza dell'immagine
    const v = variable();
    const s = state.step;
    const valid = new Date(runDate(state.run).getTime() + s * 3600e3);
    const modeText = state.mode === "interval" ? ` nell'intervallo +${current?.prev_step ?? 0}h → +${s}h` : state.mode === "total" ? " totale" : "";
    const runText = state.model === "mean" ? `dalle ${cycle(state.run)} ${fmtRunDay(state.run)}` : `corsa ${cycle(state.run)} ${fmtRunDay(state.run)}`;
    const baseAttr = map.hasLayer(bases.topo) ? "Mappa © OpenTopoMap (CC-BY-SA), dati © OpenStreetMap" : "Mappa © OpenStreetMap contributors";
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `700 17px ${FONT}`;
    const titleLines = wrapLines(measure, `${modelLabel()} · ${runText}`, W - 24);
    measure.font = `500 14px ${FONT}`;
    const subLines = wrapLines(measure, `${v.label}${modeText} (${v.units}) · +${s}h · ${fmtLocal(valid)}`, W - 24);
    measure.font = `400 10px ${FONT}`;
    // l'attribuzione di OpenStreetMap è obbligatoria anche sulle immagini
    const attrLines = wrapLines(measure, `${baseAttr} · Dati: NOAA, ECMWF, ItaliaMeteo, DWD, MeteoSvizzera · ${location.host}${location.pathname}`, W - 24);
    const HEAD = 12 + titleLines.length * 21 + subLines.length * 18 + 6;
    const FOOT = 40 + attrLines.length * 13 + 6;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = (HEAD + Hm + FOOT) * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, HEAD + Hm + FOOT);

    // mappa: stessa porzione visibile a schermo
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEAD, W, Hm);
    ctx.clip();
    const drawImg = (img, alpha = 1) => {
      if (!img.complete || !img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      if (r.right < cr.left || r.left > cr.right || r.bottom < cr.top || r.top > cr.bottom) return;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, r.left - cr.left, HEAD + r.top - cr.top, r.width, r.height);
      ctx.globalAlpha = 1;
    };
    const drawTiles = (pane) => {
      const levels = [...pane.querySelectorAll(".leaflet-tile-container")]
        .sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
      for (const lvl of levels) for (const img of lvl.querySelectorAll("img.leaflet-tile-loaded")) drawImg(img);
    };
    drawTiles(map.getPane("tilePane"));
    if (overlay?.getElement()) {
      ctx.imageSmoothingEnabled = !state.crisp;
      drawImg(overlay.getElement(), state.opacity);
      ctx.imageSmoothingEnabled = true;
    }
    if (map.hasLayer(labels)) drawTiles(map.getPane("labels"));
    // punti: stessa grafica dei marcatori
    for (const m of pointMarkers) {
      const el = m.getElement();
      if (!el) continue;
      const num = el.querySelector(".pt-num");
      const val = el.querySelector(".pt-val");
      const nr = num.getBoundingClientRect();
      const cx = nr.left - cr.left + nr.width / 2;
      const cy = HEAD + nr.top - cr.top + nr.height / 2;
      if (cx < -20 || cx > W + 20 || cy < HEAD - 20 || cy > HEAD + Hm + 20) continue;
      const vr = val.getBoundingClientRect();
      ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textBaseline = "middle";
      const vx = vr.left - cr.left;
      const vy = HEAD + vr.top - cr.top;
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      roundRect(ctx, vx, vy + 1, vr.width, vr.height, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      roundRect(ctx, vx, vy, vr.width, vr.height, 4);
      ctx.fill();
      ctx.fillStyle = "#1d2330";
      ctx.textAlign = "center";
      ctx.fillText(val.textContent, vx + vr.width / 2, vy + vr.height / 2 + 0.5);
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.fillStyle = getComputedStyle(num).backgroundColor || "#fff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#1d2330";
      ctx.stroke();
      ctx.fillStyle = getComputedStyle(num).color;
      ctx.font = "700 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.fillText(num.textContent, cx, cy + 0.5);
    }
    ctx.restore();

    // intestazione: modello, corsa, grandezza e istante
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    let ty = 6;
    ctx.fillStyle = "#1d2330";
    ctx.font = `700 17px ${FONT}`;
    for (const l of titleLines) ctx.fillText(l, 12, (ty += 21));
    ctx.fillStyle = "#3d4656";
    ctx.font = `500 14px ${FONT}`;
    for (const l of subLines) ctx.fillText(l, 12, (ty += 18));

    // legenda orizzontale
    const { thresholds, colors } = v.scale;
    const n = thresholds.length;
    const lw = Math.min(W - 24, 560);
    const cw = lw / n;
    const ly = HEAD + Hm + 10;
    thresholds.forEach((t, i) => {
      ctx.fillStyle = colors[i];
      ctx.fillRect(12 + i * cw, ly, cw, 10);
      ctx.fillStyle = "#3d4656";
      ctx.font = "500 10px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(t).replace("-", "−"), 12 + i * cw, ly + 22);
    });
    // fonti
    ctx.font = `400 10px ${FONT}`;
    ctx.fillStyle = "#5d6677";
    attrLines.forEach((l, i) => ctx.fillText(l, 12, ly + 42 + i * 13));

    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
    const name = `weathermaps-${state.model}-${state.var}-${state.run}-${String(s).padStart(3, "0")}.jpg`;
    shareText = `${modelLabel()} ${runText}: ${v.label.toLowerCase()}${modeText}, +${s}h (${fmtLocal(valid)})\n${shareUrl()}`;
    return new File([blob], name, { type: "image/jpeg" });
  }

  function toast(text) {
    shareUi.toast.textContent = text;
    shareUi.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { shareUi.toast.hidden = true; }, 4500);
  }

  function downloadShareFile() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(shareFile);
    a.download = shareFile.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Condivisione nativa (telefono: menu con WhatsApp); altrimenti scarica e apre WhatsApp con il link. */
  async function sendShare() {
    const data = { files: [shareFile], text: shareText, title: "Weathermaps" };
    if (navigator.canShare?.(data)) {
      try {
        await navigator.share(data);
        return true;
      } catch (e) {
        if (e.name === "AbortError") return true; // annullato dall'utente
        if (e.name !== "NotAllowedError") throw e;
        return false; // gesto scaduto: si riprova dal pulsante dell'anteprima
      }
    }
    downloadShareFile();
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener");
    toast("Immagine scaricata: allegala al messaggio WhatsApp che si è appena aperto.");
    return true;
  }

  shareUi.btn.addEventListener("click", async () => {
    if (!current) { toast("Niente da condividere: scegli un istante con dati."); return; }
    shareUi.btn.disabled = true;
    try {
      shareFile = await composeImage();
      shareUi.preview.src = URL.createObjectURL(shareFile);
      // anteprima con pulsanti: il clic su "Condividi" è un gesto nuovo, valido per la condivisione nativa
      shareUi.dialog.showModal();
    } catch (e) {
      toast(`Impossibile creare l'immagine: ${e.message}`);
    } finally {
      shareUi.btn.disabled = false;
    }
  });
  shareUi.send.addEventListener("click", async () => {
    try {
      if (await sendShare()) shareUi.dialog.close();
    } catch (e) {
      toast(`Condivisione non riuscita: ${e.message}`);
    }
  });
  shareUi.download.addEventListener("click", () => { downloadShareFile(); });
  shareUi.close.addEventListener("click", () => shareUi.dialog.close());
  shareUi.dialog.addEventListener("close", () => { URL.revokeObjectURL(shareUi.preview.src); });

  // ---------- tooltip puntuale (griglia nativa, nearest neighbour)
  map.on("mousemove", (e) => {
    if (!current) { ui.probe.hidden = true; return; }
    const { lat0, lon0, dlat, dlon, nx, ny } = current.grid;
    const ix = Math.round((e.latlng.lng - lon0) / dlon);
    const iy = Math.round((e.latlng.lat - lat0) / dlat);
    let text;
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) text = "—";
    else {
      const v = current.values[iy * nx + ix];
      text = v == null ? "—" : `<b>${v.toFixed(variable().decimals)}</b> ${current.units}`;
    }
    ui.probe.innerHTML = `${text} <span style="opacity:.7">${e.latlng.lat.toFixed(2)}N ${e.latlng.lng.toFixed(2)}E</span>`;
    ui.probe.style.left = `${e.containerPoint.x}px`;
    ui.probe.style.top = `${e.containerPoint.y}px`;
    ui.probe.hidden = false;
  });
  map.on("mouseout", () => { ui.probe.hidden = true; });

  // ---------- eventi
  function goStep(delta) {
    const s = steps();
    let i = s.indexOf(state.step) + delta;
    if (i < 0) i = s.length - 1;
    if (i >= s.length) i = 0;
    state.step = s[i];
    ui.step.value = i;
    update();
  }

  function togglePlay(force) {
    const on = force ?? !playTimer;
    if (on && !playTimer) {
      ui.play.textContent = "❚❚";
      playTimer = setInterval(() => {
        const s = steps();
        const avail = availableSteps();
        let i = s.indexOf(state.step);
        // salta i passi non disponibili, ricomincia dal primo
        for (let k = 0; k < s.length; k++) {
          i = (i + 1) % s.length;
          if (avail.has(s[i])) break;
        }
        state.step = s[i];
        ui.step.value = i;
        update();
      }, 650);
    } else if (!on && playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      ui.play.textContent = "▶";
    }
  }

  ui.step.addEventListener("input", () => { state.step = steps()[+ui.step.value]; update(); });
  ui.prev.addEventListener("click", () => goStep(-1));
  ui.next.addEventListener("click", () => goStep(1));
  ui.play.addEventListener("click", () => togglePlay());
  ui.opacity.addEventListener("input", () => {
    state.opacity = +ui.opacity.value;
    overlay?.setOpacity(state.opacity);
    writeHash();
  });
  ui.crisp.addEventListener("change", () => { state.crisp = ui.crisp.checked; if (current) draw(current); writeHash(); });
  ui.model.addEventListener("change", () => { state.model = ui.model.value; state.runPinned = false; renderModelInfo(); setupRuns(); setupSteps(); update(); });
  ui.varSel.addEventListener("change", () => { state.var = ui.varSel.value; setupModels(); setupModes(); setupRuns(); setupSteps(); update(); });
  ui.collapse.addEventListener("click", () => {
    const c = ui.panel.classList.toggle("collapsed");
    ui.collapse.textContent = c ? "+" : "−";
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("select, input:not([type=range])")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); goStep(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goStep(1); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  });

  async function refreshRuns() {
    if (STATIC) {
      const data = await fetch(`data/runs.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
      publishedAt = data.generated_at;
      runs = data.models;
    } else {
      runs = await fetch("api/runs", { cache: "no-cache" }).then((r) => r.json());
    }
  }

  // ---------- avvio
  async function init() {
    readHash();
    try {
      const [m] = await Promise.all([fetch(STATIC ? "data/meta.json" : "api/meta").then((r) => r.json()), refreshRuns()]);
      meta = m;
    } catch (e) {
      setStatus(`Impossibile contattare il server: ${e.message}`, true);
      return;
    }
    const toBounds = (b) => L.latLngBounds([b.lat_min, b.lon_min], [b.lat_max, b.lon_max]);
    const box = toBounds(meta.bbox);
    const start = toBounds(meta.initial_view || meta.bbox);
    // Lo zoom minimo è quello per cui la vista sta tutta dentro l'area coperta dai dati:
    // non si può mai vedere mappa senza dati. Si ricalcola se la finestra cambia dimensione.
    const updateMinZoom = () => {
      map.setMinZoom(0);
      map.setMinZoom(map.getBoundsZoom(box, true));
    };
    map.setMaxBounds(box);
    updateMinZoom();
    map.fitBounds(start, { animate: false });
    map.on("resize", () => {
      updateMinZoom();
      if (map.getZoom() < map.getMinZoom()) map.setZoom(map.getMinZoom(), { animate: false });
      map.panInsideBounds(box, { animate: false });
    });
    bases.osm.addTo(map); // all'avvio sempre OpenStreetMap; il rilievo si sceglie dal selettore livelli

    ui.opacity.value = state.opacity;
    ui.crisp.checked = state.crisp;
    setupVars();
    setupPoints();
    setupModels();
    setupModes();
    setupRuns();
    setupSteps();
    update();

    // nuove corse/passi arrivano mentre la pagina è aperta
    setInterval(async () => {
      try {
        await refreshRuns();
        const changed = setupRuns(); // se non è fissata a mano, passa da sola all'ultima corsa
        if (changed) setupSteps();
        if (changed || !current) update();
      } catch { /* offline: riprova al prossimo giro */ }
    }, 2 * 60e3);
  }

  init();
})();
