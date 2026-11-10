/* Weathermaps: frontend. Tutto ciò che dipende da area, modelli e grandezze
   arriva da /api/meta e /api/runs: qui non ci sono coordinate né soglie fisse. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ui = {
    model: $("model"), varSel: $("var"), varRow: $("var-row"), run: $("run"),
    mode: $("mode"), modeRow: $("mode-row"), step: $("step"), prev: $("prev"),
    next: $("next"), play: $("play"), opacity: $("opacity"), crisp: $("crisp"),
    valid: $("valid"), range: $("range"), status: $("status"), attrib: $("attrib"), base: $("base"), iso: $("iso"), isoRow: $("iso-row"), isoText: $("iso-text"), legend: $("legend"),
    probe: $("probe"), panel: $("panel"), collapse: $("collapse"),
    badge: $("badge"), badgeText: $("badge-text"), mPlay: $("m-play"), runAge: $("run-age"),
    runLive: $("run-live"), runLiveText: $("run-live-text"), refresh: $("refresh"), runLiveNote: $("run-live-note"),
    pointsBox: $("points-box"), points: $("points"),
    loading: $("loading"), placeQ: $("place-q"), placeResults: $("place-results"), placesEdit: $("places-edit"), placesEmpty: $("places-empty"),
    modelInfo: $("model-info"), modelInfoBtn: $("model-info-btn"),
  };

  // run: sempre l'ultima corsa completa del modello (non si sceglie più a mano)
  const state = { model: null, var: null, run: null, step: null, mode: null, opacity: 0.55, crisp: false, iso: true, hours: 3, base: "osm" };
  // "static": sito pubblicato su GitHub Pages (file JSON pre-generati, nessun server)
  const STATIC = document.documentElement.dataset.mode === "static";
  let publishedAt = null; // solo statico: quando sono stati pubblicati i dati
  let meta = null;
  let runs = null;
  let current = null; // risposta /api/field mostrata
  let currentContour = null; // campo delle linee nelle voci combinate (es. zero termico sopra la pioggia)
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
    // "Essenziale": nessuna tessera, fondo bianco e solo coste e confini sopra i colori (stile carte meteo classiche)
    plain: L.layerGroup(),
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
  // sfondo: dalla sezione "Impostazioni" del pannello (niente selettore livelli di Leaflet)
  const BASE_NAMES = { osm: "Strade", plain: "Essenziale", topo: "Rilievo" };
  const baseCredit = () =>
    state.base === "topo" ? "© OpenTopoMap, OpenStreetMap" : state.base === "plain" ? "Confini: Natural Earth" : "© OpenStreetMap";
  function setBase(name) {
    state.base = bases[name] ? name : "osm";
    const credit = ui.legend.querySelector(".lg-credit");
    if (credit) credit.textContent = baseCredit();
    const osm = document.querySelector(".credits-osm"); // credito breve accanto a "Info & crediti"
    if (osm) osm.textContent = baseCredit();
    for (const [k, layer] of Object.entries(bases)) {
      if (k === state.base) layer.addTo(map);
      else map.removeLayer(layer);
    }
    map.getContainer().classList.toggle("base-plain", state.base === "plain");
    if (typeof styleBorders === "function") styleBorders(); // con "Essenziale" i contorni ci sono sempre
    ui.base.replaceChildren(
      ...Object.entries(BASE_NAMES).map(([k, text]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.setAttribute("aria-pressed", String(k === state.base));
        b.addEventListener("click", () => setBase(k));
        return b;
      }),
    );
  }
  // attribuzione della mappa sempre nel pannello, nella sezione "Info & crediti" (dove ci sono anche le fonti
  // dei dati dei modelli, in index.html); Leaflet continua ad aggiornarla da solo. Un credito breve, sempre
  // visibile anche a pannello ridotto (obbligatorio), sta in piccolo nella legenda: vedi baseCredit.
  ui.attrib.appendChild(map.attributionControl.getContainer());

  // su mobile badge e legenda diventano un solo riquadro in basso: la legenda entra nel badge
  const mobileMq = window.matchMedia("(max-width: 600px)");
  const hoverMq = window.matchMedia("(hover: hover)"); // dispositivi col mouse: c'è il tooltip al passaggio
  const legendHome = ui.legend.parentNode;
  function placeLegend() {
    (mobileMq.matches ? ui.badge : legendHome).appendChild(ui.legend);
  }
  placeLegend();
  mobileMq.addEventListener("change", placeLegend);

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
  // grandezza dei dati (colori, località, passi): per le voci combinate è quella dei colori (es. "tp")
  const dataVar = () => variable()?.field || variable()?.vector?.u || state.var;
  // nome per legenda e testi: per le combinate quello della grandezza dei colori ("Precipitazione")
  const baseLabel = () => variable().base_label || variable().label;
  // cumulate su 3, 6, 12 o 24 ore: differenza fra il totale al passo mostrato e quello `state.hours` ore prima
  const INTERVALS = [3, 6, 12, 24];
  /** Passo da cui parte la cumulata che finisce a `s`: il più vicino a s − ore fra quelli esistenti (oltre le +144h i
   *  passi sono ogni 6 ore, quindi "3h" diventa 6h); 0 se la corsa è iniziata da meno ore. */
  function intervalPrev(s = state.step, hours = state.hours) {
    const target = s - hours;
    if (target <= 0) return 0;
    let best = 0;
    for (const x of meta.steps) if (x <= target && x > best) best = x;
    return best;
  }
  // durata effettiva della cumulata al passo mostrato: sempre scritta, mai "intervallo" e basta
  const intervalHours = (s = state.step) => s - intervalPrev(s);
  // "in 3h" / "totale" / "" (grandezze istantanee), dopo il nome della grandezza
  const modePhrase = () => (state.mode === "interval" ? `in ${intervalHours()}h` : state.mode === "total" ? "totale" : "");
  // voci combinate: cosa sono le linee ("· linee zero termico ogni 250 m"), in legenda e nell'immagine condivisa
  const isoNote = () => {
    const c = variable().contour_field && variable().contours;
    if (!c || !state.iso) return "";
    return weightedContour() ? ` · linee ${contourName().toLowerCase()}` : ` · linee ${c.label.toLowerCase()} ogni ${c.step} ${c.units}`;
  };
  // con le cumulate le linee non sono dell'istante finale ma la media del periodo pesata con la precipitazione
  const weightedContour = () => !!variable()?.contour_field && state.mode === "interval";
  // nome del valore delle linee per legenda, riquadro e tooltip: con le cumulate "Zero termico in 24h", come
  // "Precipitazione in 24h" (è la media del periodo pesata con la pioggia, vedi contourFieldAt)
  const contourName = () => `${variable().contours.label}${weightedContour() ? ` in ${intervalHours()}h` : ""}`;
  // passi del modello scelto: lo slider si ferma all'orizzonte del modello (es. ICON-CH2 a +120h)
  const steps = () => {
    const max = meta.models.find((m) => m.id === state.model)?.max_step ?? Infinity;
    return meta.steps.filter((s) => s <= max);
  };
  const runInfo = () => (runs[state.model] || []).find((r) => r.run === state.run);
  const availableSteps = () => new Set(runInfo()?.variables[dataVar()]?.steps || []);

  function setStatus(text, warn = false) {
    ui.status.textContent = text || "";
    ui.status.classList.toggle("warn", !!warn);
  }

  // ---------- stato nell'URL
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const k of ["model", "var", "mode"]) if (p.get(k)) state[k] = p.get(k);
    if (INTERVALS.includes(+p.get("ore"))) state.hours = +p.get("ore");
    // i parametri "corsa"/"run" dei link vecchi si ignorano: si mostra sempre l'ultima corsa completa
    if (p.get("step")) state.step = +p.get("step");
    if (p.get("opacity")) state.opacity = Math.min(1, Math.max(0.1, +p.get("opacity")));
    if (p.get("crisp")) state.crisp = p.get("crisp") === "1";
    if (p.get("iso")) state.iso = p.get("iso") !== "0";
  }
  function writeHash() {
    const p = new URLSearchParams();
    for (const k of ["model", "var", "step", "mode", "opacity"]) if (state[k] != null) p.set(k, state[k]);
    if (state.mode === "interval") p.set("ore", state.hours);
    if (state.crisp) p.set("crisp", "1");
    if (!state.iso) p.set("iso", "0");
    history.replaceState(null, "", "#" + p.toString());
  }

  // ---------- popolamento controlli
  // bandiere: libreria flag-icons (tutte in formato 4:3, stessa larghezza); per la mediana un'icona Lucide "layers" (ISC)
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
    // grandezze accumulate: Totale · 3h · 6h · 12h · 24h (cumulata che finisce all'ora mostrata)
    const opts = v.modes.flatMap((m) =>
      m === "interval" ? INTERVALS.map((h) => [m, h, `${h}h`]) : [[m, null, { total: "Totale", value: "Valore" }[m] || m]]);
    ui.mode.replaceChildren(
      ...opts.map(([m, h, text]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        if (h) b.title = `Cumulata nelle ${h} ore che finiscono all'ora mostrata`;
        b.setAttribute("aria-pressed", String(m === state.mode && (h == null || h === state.hours)));
        b.addEventListener("click", () => { state.mode = m; if (h) state.hours = h; setupModes(); update(); });
        return b;
      }),
    );
    ui.modeRow.hidden = v.modes.length < 2;
  }

  /** Corsa da mostrare: l'ultima completa (le corse ancora in arrivo non si mostrano). */
  function runList() {
    return (runs[state.model] || []).filter((r) => !r.incoming && r.variables[dataVar()]);
  }
  /** Corsa più nuova ancora in arrivo, solo per l'avviso. */
  const incomingRun = () => (runs[state.model] || []).find((r) => r.incoming && r.variables[dataVar()]);

  /** Ritorna true se la corsa mostrata è cambiata. */
  function setupRuns() {
    const before = state.run;
    const r = runList()[0];
    state.run = r ? r.run : null;
    if (!r) {
      ui.run.textContent = "nessuna corsa disponibile";
      ui.runAge.textContent = "";
    } else {
      ui.run.innerHTML = `<strong>${cycle(r.run)}</strong> ${fmtRunDay(r.run)}`;
      ui.run.title = `Corsa delle ${cycle(r.run)} del ${fmtRunDay(r.run)}: l'ultima completa`;
      const sel = r.variables[dataVar()];
      // testo corto: la riga "Corsa" sta su una sola riga anche nel pannello stretto; quello lungo nel tooltip
      const n = sel?.members ? Object.keys(sel.members).length : 0;
      ui.runAge.textContent = state.model === "mean" && n ? `${n} modelli` : fmtAge(r.run);
      ui.runAge.title = state.model === "mean" && n ? `Mediana di ${n} modelli` : `Emessa ${fmtAge(r.run)}`;
    }
    renderRunLive(incomingRun());
    return before !== state.run;
  }

  // ---------- corsa in arrivo: stato + pulsante "Aggiorna"
  let refreshing = false;

  /** Avviso della corsa in arrivo: si mostra quando sarà completa, intanto se ne vede l'avanzamento. */
  function renderRunLive(incoming) {
    const info = incoming?.variables[dataVar()];
    ui.runLive.hidden = !info && !refreshing;
    if (info) ui.runLiveText.textContent = `${cycle(incoming.run)} in arrivo · ${info.steps.length}/${info.expected ?? steps().length} passi`;
    else if (state.run) ui.runLiveText.textContent = `Corsa ${cycle(state.run)} aggiornata`;
  }

  /** Corsa mostrata e passi scaricati (anche della corsa in arrivo), su tutte le grandezze. */
  function latestSnapshot(model) {
    const list = runs[model] || [];
    const n = list.reduce((a, r) => a + Object.values(r.variables).reduce((b, v) => b + v.steps.length, 0), 0);
    return { run: list.find((r) => !r.incoming)?.run || null, n };
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
        else note = `Nessun passo nuovo · dati pubblicati alle ${at}, aggiornati ogni ora`;
      } catch (e) {
        note = `Aggiornamento non riuscito: ${e.message}`;
      }
      refreshing = false;
      ui.refresh.disabled = false;
      ui.refresh.textContent = "↻ Aggiorna";
      ui.runLiveNote.textContent = note;
      if (state.model === model) renderRunLive(incomingRun());
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
    if (state.model === model) renderRunLive(incomingRun());
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
    const modeLabel = modePhrase();
    const num = (x) => String(x).replace("-", "−");
    const openLow = v.scale.transparent_below == null; // la prima classe include anche i valori più bassi
    // con molte soglie (T850 ogni 2 °C) se ne scrive una su due, per non affollare la barra
    const every = thresholds.length > 14 ? 2 : 1;
    if (v.scale.continuous) {
      // barra sfumata: un tratto per ogni coppia di punti di colore, soglie sui bordi (l'ultima a destra)
      const n = thresholds.length;
      const segs = thresholds.slice(0, -1).map((t, i) => {
        const tick = i % every ? "" : num(t);
        const end = i === n - 2 ? `<span class="lg-tick lg-tick-end">${(n - 1) % every ? "" : num(thresholds[n - 1])}</span>` : "";
        return `<li><i style="background:linear-gradient(to right, ${colors[i]}, ${colors[i + 1]})"></i><span class="lg-tick">${tick}</span>${end}</li>`;
      });
      ui.legend.innerHTML =
        `<h2><span class="lg-label">${baseLabel()} ${modeLabel} </span>(${v.units})${isoNote()}</h2><ol class="lg-continuous">${segs.join("")}</ol>` +
        `<a class="lg-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${baseCredit()}</a>`;
      return;
    }
    const items = thresholds.map((t, i) => {
      const next = thresholds[i + 1];
      const text =
        next == null ? `> ${num(t)}` : i === 0 && openLow ? `< ${num(next)}` : `${num(t)} … ${num(next)}`;
      // tick: soglia inferiore della classe, mostrata solo nella barra compatta su mobile
      const tick = (i === 0 && openLow) || i % every ? "" : num(t);
      return `<li><i style="background:${colors[i]}"></i><span class="lg-text">${text}</span><span class="lg-tick">${tick}</span></li>`;
    });
    ui.legend.innerHTML =
      `<h2><span class="lg-label">${baseLabel()} ${modeLabel} </span>(${v.units})${isoNote()}</h2><ol>${items.join("")}</ol>` +
      `<a class="lg-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${baseCredit()}</a>`;
  }

  // ---------- dati
  const ctxNow = () => ({ model: state.model, var: dataVar(), run: state.run });

  function fieldUrl(step, mode, ctx, prev) {
    if (STATIC) return `data/field/${ctx.model}/${ctx.var}/${ctx.run}/${step}.json`;
    const p = new URLSearchParams({ ...ctx, step, mode });
    if (mode === "interval") p.set("prev", prev);
    return `api/field?${p}`;
  }

  async function getField(step, mode = state.mode, ctx = ctxNow(), prev = mode === "interval" ? intervalPrev(step) : null) {
    // statico: c'è solo il totale; la cumulata è la differenza fra due totali (come fa il server)
    if (STATIC && mode === "interval") return getIntervalStatic(step, ctx, prev);
    // statico: i campi dei dettagli (es. z850) stanno nel file della grandezza a cui appartengono (t850)
    if (STATIC) {
      const owner = meta.variables.find((x) => x.details?.some((d) => d.var === ctx.var));
      if (owner) {
        return getField(step, "value", { ...ctx, var: owner.id }).then((f) =>
          f.extra?.[ctx.var] ?? Promise.reject(new Error(`${ctx.var} non disponibile`)));
      }
    }
    const url = fieldUrl(step, mode, ctx, prev);
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

  function getIntervalStatic(step, ctx, prevStep) {
    const key = `interval|${ctx.model}|${ctx.var}|${ctx.run}|${step}|${prevStep}`;
    if (!cache.has(key)) {
      const pr = (async () => {
        const cur = await getField(step, "total", ctx);
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
    const cv = variable().contour_field;
    for (const j of [i + 1, i - 1, i + 2]) {
      if (s[j] == null || !avail.has(s[j])) continue;
      mainField(s[j]).catch(() => {});
      if (cv) contourFieldAt(s[j]).catch(() => {});
    }
  }

  // ---------- vento: le voci "Vento" chiedono le due componenti (verso est `u`, verso nord `v`, in km/h) e ne ricavano
  // la velocità (colori, località, classifica) e la direzione (frecce)
  function mainField(step) {
    const vec = variable()?.vector;
    if (!vec) return getField(step);
    const ctx = ctxNow();
    const key = `vec|${ctx.model}|${ctx.run}|${vec.u}|${step}`;
    if (!cache.has(key)) {
      // statico: le due componenti stanno in un solo file per passo (meno file da pubblicare)
      const parts = STATIC
        ? getField(step, "value", { ...ctx, var: state.var }).then((b) => [{ ...b, values: b.u }, { ...b, values: b.v }])
        : Promise.all([getField(step, "value", { ...ctx, var: vec.u }), getField(step, "value", { ...ctx, var: vec.v })]);
      const pr = parts.then(([fu, fv]) => {
        let max = null, min = null;
        const values = fu.values.map((u, k) => {
          const v = fv.values[k];
          if (u == null || v == null) return null;
          const s = Math.round(Math.hypot(u, v));
          if (max == null || s > max) max = s;
          if (min == null || s < min) min = s;
          return s;
        });
        return { ...fu, var: state.var, values, u: fu.values, v: fv.values, max, min };
      });
      cache.set(key, pr);
      pr.catch(() => cache.delete(key));
    }
    return cache.get(key);
  }

  const DIRS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  /** Da dove soffia il vento (convenzione meteo): gradi da nord in senso orario e punto cardinale. */
  function windDirAt(f, lat, lon) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    const ix = Math.round((lon - lon0) / dlon), iy = Math.round((lat - lat0) / dlat);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return null;
    const u = f.u[iy * nx + ix], v = f.v[iy * nx + ix];
    if (u == null || v == null || Math.hypot(u, v) < 1) return null;
    const deg = Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360);
    return { deg, name: DIRS[Math.round(deg / 45) % 8] };
  }

  /** Frecce della direzione (verso dove va il vento) su una griglia regolare di pixel, ricalcolate a ogni spostamento:
   *  sempre la stessa densità a ogni zoom. Lunghezza crescente con la velocità. */
  map.createPane("arrows");
  map.getPane("arrows").style.zIndex = 425;
  map.getPane("arrows").style.pointerEvents = "none";
  const arrowsRenderer = L.canvas({ pane: "arrows", padding: 0.1 });
  const arrowsLayer = L.layerGroup().addTo(map);
  const ARROW_STEP = 46; // px fra le frecce
  function drawArrows() {
    arrowsLayer.clearLayers();
    const f = current;
    if (!f?.u) return;
    const su = sampler({ grid: f.grid, values: f.u }, false), sv = sampler({ grid: f.grid, values: f.v }, false);
    const size = map.getSize();
    const segs = [];
    const toLL = (x, y) => map.containerPointToLatLng([x, y]);
    for (let y = ARROW_STEP / 2; y < size.y; y += ARROW_STEP) {
      for (let x = ARROW_STEP / 2; x < size.x; x += ARROW_STEP) {
        const ll = toLL(x, y);
        const u = su(ll.lat, ll.lng), v = sv(ll.lat, ll.lng);
        if (u == null || v == null) continue;
        const sp = Math.hypot(u, v);
        if (sp < 2) continue; // calma: niente freccia
        const len = 9 + Math.min(sp, 80) / 80 * 13; // 9–22 px
        const dx = u / sp, dy = -v / sp; // schermo: y verso il basso
        const x0 = x - dx * len / 2, y0 = y - dy * len / 2, x1 = x + dx * len / 2, y1 = y + dy * len / 2;
        const h = 5, wx = -dy, wy = dx; // punta: due tratti a 30° circa
        segs.push([toLL(x0, y0), toLL(x1, y1)]);
        segs.push([toLL(x1 - dx * h + wx * h * 0.6, y1 - dy * h + wy * h * 0.6), toLL(x1, y1),
          toLL(x1 - dx * h - wx * h * 0.6, y1 - dy * h - wy * h * 0.6)]);
      }
    }
    if (segs.length) {
      L.polyline(segs, { renderer: arrowsRenderer, interactive: false, color: "#1f2328", weight: 1.3, opacity: 0.8,
        lineCap: "round", lineJoin: "round", smoothFactor: 0 }).addTo(arrowsLayer);
    }
  }
  map.on("moveend", () => { if (current?.u) drawArrows(); });

  /** Campo delle linee nelle voci combinate al passo `step`. Con le cumulate (es. pioggia in 24h) è lo zero termico
   *  medio del periodo pesato con la precipitazione: per ogni punto, ogni sotto-intervallo fra due passi conta quanto
   *  la pioggia caduta in esso, con lo zero termico medio fra i suoi due estremi. Dove nel periodo non piove (meno di
   *  0,1 mm) si usa la media semplice. Con il Totale è il valore all'ora mostrata. */
  function contourFieldAt(step) {
    const ctx = ctxNow();
    const cv = variable().contour_field;
    const lines = (x) => getField(x, "value", { ...ctx, var: cv });
    if (!weightedContour()) return lines(step);
    const prev = intervalPrev(step);
    const key = `weighted|${ctx.model}|${ctx.var}|${cv}|${ctx.run}|${prev}|${step}`;
    if (!cache.has(key)) {
      const pr = (async () => {
        const avail = availableSteps();
        const chain = [prev, ...meta.steps.filter((x) => x > prev && x <= step && avail.has(x))];
        if (chain.length < 2) return lines(step);
        const [tot, hz] = await Promise.all([
          Promise.all(chain.map((x) => (x === 0 ? null : getField(x, "total", ctx)))),
          Promise.all(chain.map((x) => (x === 0 ? null : lines(x).catch(() => null)))),
        ]);
        const end = hz[hz.length - 1];
        const n = end?.values.length;
        // griglie diverse fra pioggia e linee (non dovrebbe capitare): solo l'istante finale
        if (!end || tot.some((t) => t && t.values.length !== n) || hz.some((h) => h && h.values.length !== n)) return end;
        const values = new Array(n);
        for (let k = 0; k < n; k++) {
          let num = 0, den = 0, sum = 0, cnt = 0;
          for (let i = 1; i < chain.length; i++) {
            const a = hz[i - 1]?.values[k], b = hz[i]?.values[k];
            const z = a != null && b != null ? (a + b) / 2 : b ?? a; // al passo 0 lo zero termico non c'è
            if (z == null) continue;
            const t1 = tot[i].values[k], t0 = tot[i - 1] ? tot[i - 1].values[k] : 0;
            const p = t1 != null && t0 != null ? Math.max(0, t1 - t0) : 0;
            num += z * p; den += p; sum += z; cnt++;
          }
          values[k] = cnt === 0 ? null : den >= 0.1 ? num / den : sum / cnt;
        }
        return { ...end, values, prev_step: prev, weighted: true };
      })();
      cache.set(key, pr);
      pr.catch(() => cache.delete(key));
    }
    return cache.get(key);
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
    if (scale.continuous) {
      // sfumata: interpolazione lineare fra i due punti di colore vicini, costante oltre gli estremi
      const n = th.length - 1;
      return (v) => {
        if (v == null || Number.isNaN(v)) return null;
        if (v <= th[0]) return rgb[0];
        if (v >= th[n]) return rgb[n];
        let k = 0;
        while (k + 1 < n && v >= th[k + 1]) k++;
        const t = (v - th[k]) / (th[k + 1] - th[k]);
        const a = rgb[k], b = rgb[k + 1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      };
    }
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
    // grandezze con le loro linee (T850, zero termico): colori dallo stesso campo ammorbidito delle linee, così ogni
    // linea cade esattamente su un cambio di colore; "celle nette" mostra invece il dato grezzo
    const own = variable().contours && !variable().contour_field && !state.crisp;
    const sample = sampler(own ? smoothField(f) : f, state.crisp);
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
    drawContours(variable().contour_field ? currentContour : f);
    drawArrows();
  }

  function clearOverlay() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    currentContour = null;
    drawContours(null);
    arrowsLayer.clearLayers();
  }

  // ---------- linee di livello (isoterme a 850 hPa): calcolate qui dal campo, disegnate sopra i colori
  map.createPane("contours");
  map.getPane("contours").style.zIndex = 420;
  map.getPane("contours").style.pointerEvents = "none";
  map.createPane("contourLabels");
  map.getPane("contourLabels").style.zIndex = 430;
  map.getPane("contourLabels").style.pointerEvents = "none";
  const isoRenderer = L.canvas({ pane: "contours", padding: 0.5 });

  // ---------- contorni geografici (coste, laghi, confini di stato e di provincia, Natural Earth) sopra i colori:
  // solo con l'opacità al massimo, quando la mappa di sfondo non si vede più (prima sarebbero linee doppie).
  // Il file si scarica la prima volta che servono.
  map.createPane("borders");
  map.getPane("borders").style.zIndex = 410;
  map.getPane("borders").style.pointerEvents = "none";
  const bordersRenderer = L.canvas({ pane: "borders", padding: 0.5 });
  const bordersLayer = L.layerGroup();
  const BORDER_STYLE = {
    coast: { weight: 1.5, opacity: 0.85 },
    lakes: { weight: 1.5, opacity: 0.85 },
    countries: { weight: 2, opacity: 0.9 },
    regions: { weight: 1.1, opacity: 0.65 },
  };
  // sopra i colori solo quando lo sfondo non si vede: opacità al massimo, oppure sfondo "Essenziale" (senza tessere)
  const bordersOn = () => state.opacity >= 0.999 || state.base === "plain";
  let bordersLoad = null;
  function styleBorders() {
    if (!bordersOn()) { bordersLayer.remove(); return; }
    bordersLayer.addTo(map);
    bordersLoad ??= fetch("borders.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((b) => {
        for (const [key, st] of Object.entries(BORDER_STYLE)) {
          if (!b[key]?.length) continue;
          L.polyline(b[key], { renderer: bordersRenderer, interactive: false, smoothFactor: 1, color: "#1f2328", ...st })
            .addTo(bordersLayer);
        }
      })
      .catch(() => { bordersLoad = null; }); // senza contorni la mappa funziona lo stesso: si riproverà
  }
  const isoLines = L.layerGroup().addTo(map);
  const isoLabels = L.layerGroup().addTo(map);
  let isoData = []; // [{ level, bold, pts: [[lat, lon], ...] }]

  /** Marching squares: per ogni livello i segmenti nelle celle, poi uniti in linee (aperte o chiuse). */
  function contourLines(f, levels) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    const v = f.values; // già ammorbidito (smoothField)
    const out = [];
    for (const lvl of levels) {
      // i valori arrivano arrotondati (0,1 °C): uno esattamente uguale al livello farebbe linee a gradini lungo
      // le celle; il livello si sposta di un'inezia così nessun valore lo tocca
      const L0 = lvl + 1e-4;
      const pos = new Map(); // id del lato -> [lat, lon] dell'attraversamento
      const segA = [], segB = [];
      const cross = (id, ya, xa, va, yb, xb, vb) => {
        if (!pos.has(id)) {
          const t = (L0 - va) / (vb - va);
          pos.set(id, [lat0 + (ya + (yb - ya) * t) * dlat, lon0 + (xa + (xb - xa) * t) * dlon]);
        }
        return id;
      };
      for (let y = 0; y < ny - 1; y++) {
        for (let x = 0; x < nx - 1; x++) {
          const a = v[y * nx + x], b = v[y * nx + x + 1], c = v[(y + 1) * nx + x + 1], d = v[(y + 1) * nx + x];
          if (a == null || b == null || c == null || d == null) continue;
          const sa = a >= L0, sb = b >= L0, sc = c >= L0, sd = d >= L0;
          if (sa === sb && sb === sc && sc === sd) continue;
          // lati: 0 = a-b (basso), 1 = b-c (destra), 2 = d-c (alto), 3 = a-d (sinistra)
          const e = [];
          if (sa !== sb) e[0] = cross((y * nx + x) * 2, y, x, a, y, x + 1, b);
          if (sb !== sc) e[1] = cross((y * nx + x + 1) * 2 + 1, y, x + 1, b, y + 1, x + 1, c);
          if (sd !== sc) e[2] = cross(((y + 1) * nx + x) * 2, y + 1, x, d, y + 1, x + 1, c);
          if (sa !== sd) e[3] = cross((y * nx + x) * 2 + 1, y, x, a, y + 1, x, d);
          const ids = e.map((id, i) => [i, id]).filter((z) => z[1] !== undefined);
          if (ids.length === 2) { segA.push(ids[0][1]); segB.push(ids[1][1]); continue; }
          // sella: decide il valore al centro della cella
          const center = (a + b + c + d) / 4 >= L0;
          if (center === sa) { segA.push(e[0], e[2]); segB.push(e[1], e[3]); }
          else { segA.push(e[0], e[1]); segB.push(e[3], e[2]); }
        }
      }
      // unione dei segmenti che condividono un lato
      const at = new Map();
      const link = (id, k) => { const l = at.get(id); if (l) l.push(k); else at.set(id, [k]); };
      for (let k = 0; k < segA.length; k++) { link(segA[k], k); link(segB[k], k); }
      const used = new Uint8Array(segA.length);
      const walk = (start, k0) => {
        const ids = [];
        let id = start, k = k0;
        while (k !== undefined) {
          used[k] = 1;
          id = segA[k] === id ? segB[k] : segA[k];
          ids.push(id);
          k = (at.get(id) || []).find((j) => !used[j]);
        }
        return ids;
      };
      for (let k = 0; k < segA.length; k++) {
        if (used[k]) continue;
        used[k] = 1;
        const fwd = (() => { const n = (at.get(segB[k]) || []).find((j) => !used[j]); return n === undefined ? [] : walk(segB[k], n); })();
        const back = (() => { const n = (at.get(segA[k]) || []).find((j) => !used[j]); return n === undefined ? [] : walk(segA[k], n); })();
        const ids = [...back.reverse(), segA[k], segB[k], ...fwd];
        const closed = ids[0] === ids[ids.length - 1];
        if (ids.length < (closed ? 12 : 4)) continue; // frammenti e anelli minuscoli: solo rumore
        out.push({ level: lvl, pts: smooth(ids.map((id) => pos.get(id)), closed) });
      }
    }
    return out;
  }

  /** Campo ammorbidito per linee di livello e relativi colori (calcolato una volta per campo). Sulle griglie fini
   *  (ICON 2 km) più passate, così le linee non diventano tanti anellini; GFS (0,25°) resta com'è. */
  function smoothField(f) {
    if (!f._smooth) {
      const { nx, ny, dlon } = f.grid;
      f._smooth = { ...f, values: blurred(f.values, nx, ny, Math.min(4, Math.round(0.1 / dlon))) };
    }
    return f._smooth;
  }

  /** Media mobile 3×3 ripetuta `passes` volte (solo per le linee, i colori restano quelli del campo): sulle griglie
   *  fini (ICON 2 km) le isoterme seguono ogni valle e diventano tanti anellini; così somigliano alle carte classiche. */
  function blurred(vals, nx, ny, passes) {
    let a = vals;
    for (let it = 0; it < passes; it++) {
      const b = new Array(a.length);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (a[y * nx + x] == null) { b[y * nx + x] = null; continue; }
          let sum = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx) continue;
              const w = a[yy * nx + xx];
              if (w != null) { sum += w; n++; }
            }
          }
          b[y * nx + x] = sum / n;
        }
      }
      a = b;
    }
    return a;
  }

  /** Arrotonda gli spigoli (Chaikin, due passate): le griglie larghe (GFS 0,25°) non fanno linee a scalini. */
  function smooth(pts, closed) {
    let p = pts;
    for (let it = 0; it < 1 && p.length > 2; it++) { // una passata: le linee restano sul bordo dei colori
      const q = closed ? [] : [p[0]];
      const n = p.length - 1;
      for (let i = 0; i < n; i++) {
        const [a, b] = [p[i], p[i + 1]];
        q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
      }
      if (closed) q.push(q[0]); else q.push(p[n]);
      p = q;
    }
    return p;
  }

  function drawContours(f) {
    isoLines.clearLayers();
    isoLabels.clearLayers();
    isoData = [];
    const cfg = variable()?.contours;
    ui.isoRow.hidden = !cfg;
    if (cfg) ui.isoText.textContent = `${cfg.label} (ogni ${cfg.step} ${cfg.units || variable().units})`;
    if (!f || !cfg || !state.iso) return;
    let lo = Infinity, hi = -Infinity;
    for (const x of f.values) if (x != null) { if (x < lo) lo = x; if (x > hi) hi = x; }
    if (!(hi > lo)) return;
    const levels = [];
    for (let l = Math.ceil(lo / cfg.step) * cfg.step; l <= hi; l += cfg.step) levels.push(+l.toFixed(6));
    const bold = new Set(cfg.bold || []);
    isoData = contourLines(smoothField(f), levels).map((c) => ({ ...c, bold: bold.has(c.level) }));
    for (const c of isoData) {
      L.polyline(c.pts, {
        renderer: isoRenderer, interactive: false, smoothFactor: 0.5,
        color: "#1f2328", weight: c.bold ? 2 : 0.9, opacity: c.bold ? 0.85 : 0.55,
      }).addTo(isoLines);
    }
    placeContourLabels();
  }

  /** Etichette lungo le linee, a distanza fissa in pixel (si ricalcolano allo zoom), senza sovrapporsi. */
  function placeContourLabels() {
    isoLabels.clearLayers();
    if (!isoData.length) return;
    const FIRST = 90, EVERY = 320, CELL = 46;
    const taken = new Set();
    const free = (p) => {
      const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (taken.has(`${cx + dx},${cy + dy}`)) return false;
      taken.add(`${cx},${cy}`);
      return true;
    };
    const signed = !!variable()?.contours?.signed;
    const fmt = (l) => (signed && l > 0 ? `+${l}` : `${l}`).replace("-", "−");
    // prima le linee in evidenza, poi le più lunghe
    const order = [...isoData].sort((a, b) => (b.bold - a.bold) || (b.pts.length - a.pts.length));
    for (const c of order) {
      let dist = 0, next = FIRST, prev = null;
      for (const ll of c.pts) {
        const p = map.latLngToLayerPoint(ll);
        if (prev) dist += p.distanceTo(prev);
        prev = p;
        if (dist < next) continue;
        next = dist + EVERY;
        if (!free(p)) continue;
        L.marker(ll, {
          pane: "contourLabels", interactive: false, keyboard: false,
          icon: L.divIcon({ className: `iso-lbl${c.bold ? " iso-bold" : ""}`, html: `<span>${fmt(c.level)}</span>`, iconSize: null }),
        }).addTo(isoLabels);
      }
    }
  }
  map.on("zoomend", placeContourLabels);

  function renderTime() {
    const s = state.step;
    const run = runDate(state.run || "1970010100");
    const valid = new Date(run.getTime() + s * 3600e3);
    ui.valid.textContent = state.run ? `${fmtLocal(valid)} · +${s}h` : "—";
    if (!state.run) {
      ui.range.textContent = "—";
      ui.badgeText.innerHTML = `<b>${modelLabel()}</b> · nessuna corsa`;
      return;
    }
    const runWord = state.model === "mean" ? "dalle" : "corsa";
    // desktop: modello, corsa e istante; mobile (badge-m): prima l'istante, poi modello breve e corsa
    ui.badgeText.innerHTML =
      `<b class="badge-d">${modelLabel()}</b><span class="badge-run badge-d">${runWord} <strong>${cycle(state.run)}</strong> ${fmtRunDay(state.run)}</span>` +
      `<span class="badge-valid badge-d">+${s}h · ${fmtLocal(valid)}</span>` +
      `<span class="badge-m badge-m-time"><b>${fmtLocal(valid)}</b></span>` +
      `<span class="badge-m badge-m-model">${shortLabel(state.model)} ${cycle(state.run)}</span>`;
    const prev = intervalPrev(s);
    const utc = `${fmtUTC(valid)} UTC`;
    if (state.mode === "interval") ui.range.textContent = `${utc} · accumulo da +${prev}h a +${s}h`;
    else if (state.mode === "total") ui.range.textContent = `${utc} · accumulo da +0h a +${s}h`;
    else ui.range.textContent = utc;
  }

  let seq = 0;
  async function update() {
    writeHash();
    renderLegend();
    renderTime();
    if (!state.run) { setLoading(false); clearOverlay(); current = null; renderPoints(); setStatus("Nessun dato ancora scaricato per questo modello.", true); return; }
    if (!availableSteps().has(state.step)) {
      setLoading(false);
      clearOverlay(); current = null; renderPoints();
      setStatus("");
      return;
    }
    const my = ++seq;
    setLoading(true); // spinner nella riga dell'ora: niente testo che compare e sparisce spostando il pannello
    try {
      // voci combinate: anche il campo delle linee, alla stessa ora (se manca, solo i colori)
      const cv = variable().contour_field;
      const [f, cf] = await Promise.all([
        mainField(state.step),
        cv ? contourFieldAt(state.step).catch(() => null) : null,
      ]);
      if (my !== seq) return;
      current = f;
      currentContour = cf;
      draw(f);
      renderPoints();
      let text = "";
      if (f.members && f.member_runs) {
        const names = f.members.map((id) => `${shortLabel(id)} ${cycle(f.member_runs[id])}`).join(", ");
        text = `Mediana di ${f.members.length}: ${names}`;
      }
      setStatus(text);
      prefetch();
      if (hoverMq.matches && extras().length) loadExtras(); // per il tooltip (sui touch solo aprendo un riquadro)
    } catch (e) {
      if (my !== seq) return;
      clearOverlay(); current = null; renderPoints();
      setStatus(`Errore: ${e.message}`, true);
    } finally {
      if (my === seq) setLoading(false);
    }
  }

  // spinner del caricamento: compare solo se l'attesa supera 150 ms (con i dati in cache non lampeggia)
  let loadingTimer = null;
  function setLoading(on) {
    clearTimeout(loadingTimer);
    if (on) loadingTimer = setTimeout(() => { ui.loading.hidden = false; }, 150);
    else ui.loading.hidden = true;
  }

  // ---------- località preferite: scelte dall'utente con la ricerca, salvate nel browser (localStorage).
  // Ognuna ha marcatore numerato + valore sulla mappa e una riga nell'elenco del pannello.
  const PLACES_KEY = "weathermaps.places.v1";
  const MAX_PLACES = 20;
  const pointMarkers = [];
  const pointRows = [];
  let places = loadPlaces();
  let editing = false;

  /** Valore del punto di griglia più vicino (come il tooltip), null se fuori griglia o mancante. */
  function valueAt(f, lat, lon) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    const ix = Math.round((lon - lon0) / dlon);
    const iy = Math.round((lat - lat0) / dlat);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return null;
    return f.values[iy * nx + ix];
  }

  function loadPlaces() {
    try {
      const d = JSON.parse(localStorage.getItem(PLACES_KEY) || "null");
      if (Array.isArray(d?.places)) {
        return d.places
          .filter((p) => p && typeof p.name === "string" && Number.isFinite(p.lat) && Number.isFinite(p.lon))
          .slice(0, MAX_PLACES);
      }
    } catch { /* storage non disponibile o dato rovinato: si parte vuoti */ }
    return [];
  }
  function savePlaces() {
    try {
      localStorage.setItem(PLACES_KEY, JSON.stringify({ v: 1, places }));
    } catch { /* navigazione privata o storage pieno: le modifiche valgono finché resti sulla pagina */ }
  }

  function inBox(lat, lon) {
    const b = meta.bbox;
    return lat >= b.lat_min && lat <= b.lat_max && lon >= b.lon_min && lon <= b.lon_max;
  }

  /** Ricostruisce marcatori ed elenco da `places` (dopo ogni aggiunta, modifica o eliminazione). */
  function setupPoints() {
    closePlacePop(); // gli indici possono cambiare (eliminazione)
    for (const m of pointMarkers) m.remove();
    pointMarkers.length = 0;
    pointRows.length = 0;
    ui.points.replaceChildren();
    places.forEach((p, idx) => {
      const icon = L.divIcon({
        className: "pt pt-right",
        html: `<span class="pt-num">–</span><span class="pt-val">—</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const m = L.marker([p.lat, p.lon], { icon, keyboard: false, riseOnHover: true })
        .on("click", (e) => { L.DomEvent.stopPropagation(e); openPlacePop(idx); })
        .addTo(map);
      pointMarkers.push(m);

      const li = document.createElement("li");
      li.innerHTML = `<span class="pt-num">–</span><span class="pt-name"></span><span class="pt-v">—</span>`;
      if (editing) {
        // modifica: nome rinominabile al posto del testo, pulsante per eliminare al posto del valore
        const input = document.createElement("input");
        input.className = "pt-name pt-rename";
        input.value = p.name;
        input.maxLength = 60;
        input.setAttribute("aria-label", `Nome di ${p.name}`);
        input.addEventListener("change", () => {
          const name = input.value.trim();
          if (name) { p.name = name; savePlaces(); } else input.value = p.name;
        });
        li.querySelector(".pt-name").replaceWith(input);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "pt-del";
        del.textContent = "✕";
        del.title = `Elimina ${p.name}`;
        del.setAttribute("aria-label", `Elimina ${p.name}`);
        del.addEventListener("click", () => {
          places.splice(idx, 1);
          savePlaces();
          if (!places.length) editing = false;
          setupPoints();
        });
        li.querySelector(".pt-v").replaceWith(del);
        li.classList.add("editing");
      } else {
        li.querySelector(".pt-name").textContent = p.name;
        li.title = `Centra la mappa su ${p.name}`;
        li.addEventListener("click", () => { map.panTo([p.lat, p.lon]); openPlacePop(idx); });
      }
      ui.points.append(li);
      pointRows.push(li);
    });
    ui.placesEmpty.hidden = places.length > 0;
    ui.placesEdit.hidden = !places.length;
    ui.placesEdit.textContent = editing ? "Fine" : "Modifica";
    ui.placesEdit.setAttribute("aria-pressed", String(editing));
    ui.placeQ.disabled = places.length >= MAX_PLACES;
    ui.placeQ.placeholder = places.length >= MAX_PLACES ? `Massimo ${MAX_PLACES} località` : "Cerca una località";
    if (meta && variable()) renderPoints();
  }

  ui.placesEdit.addEventListener("click", () => { editing = !editing; setupPoints(); });

  function addPlace(name, lat, lon) {
    if (places.some((p) => Math.abs(p.lat - lat) < 0.005 && Math.abs(p.lon - lon) < 0.005)) {
      toast(`${name} è già fra le località.`);
      return;
    }
    places.push({ id: Date.now().toString(36), name, lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    savePlaces();
    setupPoints();
  }

  // ricerca: Photon (geocoder su dati OpenStreetMap), limitata all'area della mappa e a località abitate
  // (città, paesi, frazioni), cime e passi: senza filtro "Sondrio" restituirebbe anche vie, stazioni e provincia.
  // Il testo cercato va al servizio esterno photon.komoot.io; nient'altro esce dal browser.
  let searchTimer = null;
  let searchCtl = null;
  // la lista dei risultati sta fuori dal pannello (che scorre e la taglierebbe): in body, posizione fissa sotto il
  // campo di ricerca (sopra se sotto non c'è posto), alta al massimo quanto lo spazio libero nella finestra
  document.body.append(ui.placeResults);
  function placeResults() {
    if (ui.placeResults.hidden) return;
    const r = ui.placeQ.getBoundingClientRect();
    const M = 8, GAP = 4;
    const below = window.innerHeight - r.bottom - GAP - M;
    const above = r.top - GAP - M;
    const down = below >= 160 || below >= above;
    const el = ui.placeResults;
    el.style.left = `${Math.max(M, r.left)}px`;
    el.style.width = `${Math.min(r.width, window.innerWidth - 2 * M)}px`;
    el.style.maxHeight = `${Math.max(80, Math.min(down ? below : above, 440))}px`; // 8 risultati senza scorrere
    el.style.top = down ? `${r.bottom + GAP}px` : "";
    el.style.bottom = down ? "" : `${window.innerHeight - r.top + GAP}px`;
  }
  window.addEventListener("resize", placeResults);
  ui.placeQ.closest(".panel-body")?.addEventListener("scroll", placeResults);
  window.visualViewport?.addEventListener("resize", placeResults); // tastiera del telefono

  function hideResults() {
    ui.placeResults.hidden = true;
    ui.placeResults.replaceChildren();
  }
  const PLACE_KINDS = { "natural:peak": "cima", "mountain_pass:yes": "passo" };
  function placeContext(pr) {
    const kind = PLACE_KINDS[`${pr.osm_key}:${pr.osm_value}`];
    return [kind, pr.city !== pr.name ? pr.city : null, pr.county, pr.state, pr.country !== "Italia" ? pr.country : null]
      .filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(", ");
  }
  async function searchPlaces(q) {
    searchCtl?.abort();
    searchCtl = new AbortController();
    const b = meta.bbox;
    const url = `https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: "8" })}` +
      `&bbox=${b.lon_min},${b.lat_min},${b.lon_max},${b.lat_max}` +
      "&osm_tag=place&osm_tag=natural:peak&osm_tag=mountain_pass";
    try {
      const r = await fetch(url, { signal: searchCtl.signal });
      if (!r.ok) throw new Error(r.statusText);
      const d = await r.json();
      const items = (d.features || [])
        .map((f) => ({ pr: f.properties || {}, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
        .filter((x) => x.pr.name && inBox(x.lat, x.lon));
      if (!items.length) {
        ui.placeResults.innerHTML = `<li class="place-none">Nessun risultato nell'area della mappa</li>`;
      } else {
        ui.placeResults.replaceChildren(...items.map(({ pr, lat, lon }) => {
          const li = document.createElement("li");
          li.setAttribute("role", "option");
          li.tabIndex = 0;
          li.innerHTML = `<span class="place-name"></span><span class="place-ctx"></span>`;
          li.querySelector(".place-name").textContent = pr.name;
          li.querySelector(".place-ctx").textContent = placeContext(pr);
          const pick = () => { addPlace(pr.name, lat, lon); ui.placeQ.value = ""; hideResults(); };
          li.addEventListener("click", pick);
          li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
          return li;
        }));
      }
      ui.placeResults.hidden = false;
      placeResults();
    } catch (e) {
      if (e.name === "AbortError") return;
      ui.placeResults.innerHTML = `<li class="place-none">Ricerca non riuscita, riprova più tardi</li>`;
      ui.placeResults.hidden = false;
      placeResults();
    }
  }
  ui.placeQ.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = ui.placeQ.value.trim();
    if (q.length < 2) { searchCtl?.abort(); hideResults(); return; }
    searchTimer = setTimeout(() => searchPlaces(q), 300);
  });
  ui.placeQ.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { ui.placeQ.value = ""; hideResults(); }
    if (e.key === "ArrowDown") { e.preventDefault(); ui.placeResults.querySelector("li[role=option]")?.focus(); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".places-search, .place-results")) hideResults(); });

  function renderPoints() {
    const pts = places;
    const dec = variable().decimals;
    const color = colorizer(variable().scale);
    const values = [];
    pts.forEach((p, i) => {
      const v = current ? valueAt(current, p.lat, p.lon) : null;
      const text = v == null ? "—" : v.toFixed(dec);
      const c = v == null ? null : color(v);
      const el = pointMarkers[i].getElement();
      if (el) {
        // sulla mappa col simbolo attaccato (2575m, 8.2°C): compatto ma senza ambiguità
        el.querySelector(".pt-val").textContent = v == null ? text : `${text}${current.units}`;
        el.querySelector(".pt-num").style.background = c ? `rgb(${c.join(",")})` : "";
        el.classList.toggle("pt-dark", !!c && c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 140);
      }
      const pv = pointRows[i].querySelector(".pt-v"); // in modifica al suo posto c'è il pulsante elimina
      if (pv) pv.textContent = v == null ? "—" : `${text} ${current.units}`;
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
    pointOrder = order;
    placePointLabels();
    renderPlacePop();
  }

  // ---------- riquadro della località (click sul cerchio o sulla riga dell'elenco): nome, valori, classifica, ora.
  // Uno solo alla volta; sopra il cerchio, sotto se in alto non c'è posto, sempre dentro la finestra.
  const pop = document.createElement("div");
  pop.className = "pt-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  document.body.append(pop);
  let popIdx = null;
  const detailFields = new Map(); // campi del dettaglio già scaricati (null = non disponibile)
  const POP_MARGIN = 8; // distanza minima dai bordi della finestra
  const POP_GAP = 16; // distanza dal centro del cerchio alla punta della freccia

  function openPlacePop(idx) {
    popIdx = idx;
    ui.probe.hidden = true; // col riquadro aperto niente tooltip del mouse
    renderPlacePop();
  }
  function closePlacePop() {
    popIdx = null;
    pop.hidden = true;
    markPoppedPoint();
  }
  // l'etichetta bianca della località col riquadro aperto si nasconde (stesso valore, sarebbe un doppione)
  function markPoppedPoint() {
    pointMarkers.forEach((m, i) => m.getElement()?.classList.toggle("pt-popped", i === popIdx));
  }

  // nome breve per la seconda riga del tooltip
  const SHORT = { z850: "quota 850" };
  /** Grandezze in più della grandezza mostrata (`details`, es. l'altezza di 850 hPa sulla mappa della T850): nel
   *  riquadro della località e nella seconda riga del tooltip; si scaricano con l'ora mostrata e restano in detailFields. */
  const extras = () => variable()?.details || [];
  const extraKey = (d) => `${state.model}|${state.run}|${d.var}|${state.step}`;
  function loadExtras() {
    for (const d of extras()) {
      const key = extraKey(d);
      if (detailFields.has(key)) continue;
      detailFields.set(key, undefined); // in arrivo
      const step = state.step;
      getField(step, "value", { ...ctxNow(), var: d.var }).catch(() => null).then((f) => {
        detailFields.set(key, f);
        if (popIdx != null && state.step === step) renderPlacePop();
      });
    }
  }
  /** Valore formattato di una grandezza in più nel punto: undefined = ancora in arrivo, null = non disponibile. */
  function extraValue(d, lat, lon) {
    const f = detailFields.get(extraKey(d));
    if (f === undefined) return undefined;
    const x = f ? valueAt(f, lat, lon) : null;
    if (x == null) return null;
    const dec = meta.variables.find((y) => y.id === d.var)?.decimals ?? 0;
    return `${x.toFixed(dec)} ${f.units}`;
  }

  function renderPlacePop() {
    const p = places[popIdx];
    if (popIdx == null || !p || !meta || !variable()) { closePlacePop(); return; }
    const v = variable();
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const val = current ? valueAt(current, p.lat, p.lon) : null;
    const modeLabel = modePhrase() ? ` ${modePhrase()}` : "";
    const rows = [[`${baseLabel()}${modeLabel}`, val == null ? "—" : `${val.toFixed(v.decimals)} ${current.units}`]];
    if (v.contour_field && currentContour) {
      const z = valueAt(currentContour, p.lat, p.lon);
      rows.push([contourName(), z == null ? "—" : `${Math.round(z)} ${currentContour.units}`]);
    }
    if (current?.u) {
      const d = windDirAt(current, p.lat, p.lon);
      rows.push(["Direzione", d == null ? "—" : `da ${d.name} (${d.deg}°)`]);
    }
    // grandezze in più (sulla mappa della T850 l'altezza della superficie di 850 hPa)
    loadExtras();
    for (const d of extras()) {
      const x = extraValue(d, p.lat, p.lon);
      rows.push([d.label, x === undefined ? "…" : x ?? "—"]);
    }
    const foot = state.run && state.step != null ? fmtLocal(new Date(runDate(state.run).getTime() + state.step * 3600e3)) : "";
    pop.innerHTML =
      `<div class="pt-pop-head"><strong>${esc(p.name)}</strong>` +
      `<button type="button" class="pt-pop-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div>` +
      rows.map(([k, x]) => `<div class="pt-pop-row"><span>${esc(k)}</span><b>${esc(x)}</b></div>`).join("") +
      (foot ? `<div class="pt-pop-foot">${esc(foot)}</div>` : "") +
      `<i class="pt-pop-arrow"></i>`;
    pop.querySelector(".pt-pop-close").addEventListener("click", closePlacePop);
    pop.hidden = false;
    markPoppedPoint();
    placePlacePop();
  }

  /** Posizione: centrata sul punto, sopra (o sotto), spostata di lato quanto serve per restare nella finestra. */
  function placePlacePop() {
    if (popIdx == null || pop.hidden) return;
    const p = places[popIdx];
    if (!p) { closePlacePop(); return; }
    const mr = map.getContainer().getBoundingClientRect();
    const c = map.latLngToContainerPoint([p.lat, p.lon]);
    const x = mr.left + c.x, y = mr.top + c.y;
    const W = window.innerWidth, H = window.innerHeight;
    // punto fuori dalla finestra: niente riquadro appeso al nulla
    if (x < 0 || x > W || y < 0 || y > H) { pop.style.visibility = "hidden"; return; }
    pop.style.visibility = "";
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const below = y - POP_GAP - h < POP_MARGIN && y + POP_GAP + h <= H - POP_MARGIN;
    let top = below ? y + POP_GAP : y - POP_GAP - h;
    top = Math.min(Math.max(top, POP_MARGIN), H - POP_MARGIN - h);
    const left = Math.min(Math.max(x - w / 2, POP_MARGIN), Math.max(POP_MARGIN, W - POP_MARGIN - w));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.classList.toggle("below", below);
    // la freccia resta sul punto anche quando il riquadro è spostato di lato
    pop.querySelector(".pt-pop-arrow").style.left = `${Math.min(Math.max(x - left, 12), w - 12)}px`;
  }
  map.on("move zoom", placePlacePop);
  map.on("click", closePlacePop);
  window.addEventListener("resize", placePlacePop);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePlacePop(); });

  // ---------- posizione delle etichette delle località: a destra se c'è posto, se no a sinistra, sopra o sotto;
  // se nessun lato è libero il valore si nasconde (resta il numero; il valore è nell'elenco e nel tooltip).
  // Si sceglie in ordine di classifica: i primi hanno la precedenza.
  let pointOrder = [];
  const PT_SIDES = ["right", "left", "above", "below"];
  const PT_R = 12; // raggio del cerchio (con il bordo)
  const PT_GAP = 18; // distanza dell'etichetta dal centro (come nel CSS: 29px dal bordo del marcatore di 22px)
  function placePointLabels() {
    const overlaps = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    const items = pointMarkers.map((m) => {
      const el = m.getElement();
      if (!el) return null;
      el.classList.remove("pt-noval"); // per misurare l'etichetta deve essere visibile
      const c = map.latLngToContainerPoint(m.getLatLng());
      const val = el.querySelector(".pt-val");
      return { el, c, w: val.offsetWidth, h: val.offsetHeight };
    });
    // ostacoli: tutti i cerchi, poi via via le etichette già sistemate
    const taken = items.filter(Boolean).map(({ c }) => ({ x1: c.x - PT_R, x2: c.x + PT_R, y1: c.y - PT_R, y2: c.y + PT_R }));
    const order = pointOrder.length === items.length ? pointOrder : items.map((_, i) => i);
    for (const i of order) {
      const it = items[i];
      if (!it) continue;
      const { c, w, h } = it;
      const box = {
        right: { x1: c.x + PT_GAP, x2: c.x + PT_GAP + w, y1: c.y - h / 2, y2: c.y + h / 2 },
        left: { x1: c.x - PT_GAP - w, x2: c.x - PT_GAP, y1: c.y - h / 2, y2: c.y + h / 2 },
        above: { x1: c.x - w / 2, x2: c.x + w / 2, y1: c.y - PT_GAP - h, y2: c.y - PT_GAP },
        below: { x1: c.x - w / 2, x2: c.x + w / 2, y1: c.y + PT_GAP, y2: c.y + PT_GAP + h },
      };
      const side = PT_SIDES.find((k) => !taken.some((t) => overlaps(box[k], t)));
      for (const k of PT_SIDES) it.el.classList.toggle(`pt-${k}`, k === (side || "right"));
      it.el.classList.toggle("pt-noval", !side);
      if (side) taken.push(box[side]);
    }
  }
  map.on("zoomend", placePointLabels);

  // ---------- condivisione: immagine della mappa che si sta guardando
  const shareUi = {
    btn: $("share"), toast: $("share-toast"), dialog: $("share-dialog"), canvas: $("share-canvas"),
    send: $("share-send"), download: $("share-download"), close: $("share-close"),
    zoomIn: $("share-zoom-in"), zoomOut: $("share-zoom-out"), ratio: $("share-ratio"),
    points: $("share-points"), pointsRow: $("share-points-row"),
  };
  // località nell'immagine: si decide nella finestra di condivisione (la scelta resta per le aperture successive)
  shareUi.points.addEventListener("change", () => scheduleRender());
  let shareFile = null;

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

  // Immagine condivisa: la mappa visibile viene fotografata e nella modale si sceglie il ritaglio, un riquadro
  // con proporzioni fisse sopra l'intera area (fuori velata). Intestazione, punti, legenda e crediti si
  // disegnano sopra il ritaglio a grandezza fissa e si vedono già dentro il riquadro.
  const RATIOS = { "4:3": [1600, 1200], "1:1": [1200, 1200], "16:9": [1600, 900] };
  const MIN_FRACTION = 0.25; // riquadro più piccolo: un quarto della larghezza massima (oltre si sgrana)
  const PT_SCALE = 1.5; // grandezza di marcatori e valori nell'immagine rispetto allo schermo
  const FRAME_PAD = 16; // margine attorno al riquadro fisso nella modale
  const outCanvas = document.createElement("canvas"); // immagine finale

  /** Mappa visibile in un canvas (a 2–3× per poter zoomare) e punti in coordinate dello schermo. */
  function snapshotMap() {
    const cr = map.getContainer().getBoundingClientRect();
    const W = cr.width;
    const H = cr.height;
    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    const drawImg = (img, alpha = 1) => {
      if (!img.complete || !img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      if (r.right < cr.left || r.left > cr.right || r.bottom < cr.top || r.top > cr.bottom) return;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, r.left - cr.left, r.top - cr.top, r.width, r.height);
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
    // isoterme: il canvas delle linee e le etichette (testo con alone bianco, come sullo schermo)
    const bordersCanvas = map.getPane("borders").querySelector("canvas");
    if (bordersCanvas && bordersOn()) {
      const r = bordersCanvas.getBoundingClientRect();
      ctx.drawImage(bordersCanvas, r.left - cr.left, r.top - cr.top, r.width, r.height);
    }
    const arrowsCanvas = map.getPane("arrows").querySelector("canvas");
    if (arrowsCanvas && current?.u) {
      const r = arrowsCanvas.getBoundingClientRect();
      ctx.drawImage(arrowsCanvas, r.left - cr.left, r.top - cr.top, r.width, r.height);
    }
    const isoCanvas = map.getPane("contours").querySelector("canvas");
    if (isoCanvas && isoData.length) {
      const r = isoCanvas.getBoundingClientRect();
      ctx.drawImage(isoCanvas, r.left - cr.left, r.top - cr.top, r.width, r.height);
    }
    for (const el of map.getPane("contourLabels").querySelectorAll(".iso-lbl span")) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const x = r.left - cr.left + r.width / 2, y = r.top - cr.top + r.height / 2;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineJoin = "round";
      ctx.strokeText(el.textContent, x, y);
      ctx.fillStyle = cs.color;
      ctx.fillText(el.textContent, x, y);
    }
    // punti: centro del cerchio e posizione del valore rispetto al centro (come sullo schermo)
    const points = [];
    for (const m of pointMarkers) {
      const el = m.getElement();
      if (!el) continue;
      const num = el.querySelector(".pt-num");
      const val = el.querySelector(".pt-val");
      const nr = num.getBoundingClientRect();
      const vr = val.getBoundingClientRect();
      const hidden = el.classList.contains("pt-noval") || el.classList.contains("pt-popped");
      const x = nr.left - cr.left + nr.width / 2;
      const y = nr.top - cr.top + nr.height / 2;
      const cs = getComputedStyle(num);
      points.push({
        side: PT_SIDES.find((k) => el.classList.contains(`pt-${k}`)) || "right",
        x, y, num: num.textContent, val: hidden ? "" : val.textContent, bg: cs.backgroundColor || "#fff", fg: cs.color,
        dx: vr.left - cr.left - x, dy: vr.top - cr.top - y, w: vr.width, h: vr.height,
      });
    }
    return { canvas, W, H, scale, points };
  }

  /** Testi dell'immagine e nome del file, calcolati una volta all'apertura. */
  function shareTexts() {
    const v = variable();
    const s = state.step;
    const valid = new Date(runDate(state.run).getTime() + s * 3600e3);
    const modeText = state.mode === "interval" ? ` in ${intervalHours(s)}h (+${s - intervalHours(s)}h → +${s}h)` : state.mode === "total" ? " totale" : "";
    const runText = state.model === "mean" ? `dalle ${cycle(state.run)} ${fmtRunDay(state.run)}` : `corsa ${cycle(state.run)} ${fmtRunDay(state.run)}`;
    const baseAttr = map.hasLayer(bases.topo) ? "Mappa © OpenTopoMap (CC-BY-SA), dati © OpenStreetMap"
      : state.base === "plain" ? "Confini: Natural Earth" : "Mappa © OpenStreetMap contributors";
    return {
      v,
      title: `${modelLabel()} · ${runText}`,
      sub: `${baseLabel()}${modeText} (${v.units})${isoNote()} · +${s}h · ${fmtLocal(valid)}`,
      // l'attribuzione di OpenStreetMap è obbligatoria anche sulle immagini
      attr: `${baseAttr} · Dati: NOAA, ECMWF, ItaliaMeteo, CIMA, LaMMA, DWD, Météo-France, MeteoSvizzera · ${location.host}${location.pathname}`,
      name: `weathermaps-${state.model}-${state.var}-${state.run}-${String(s).padStart(3, "0")}.jpg`,
    };
  }

  // ritaglio in coordinate della mappa fotografata (px dello schermo); l'altezza segue le proporzioni
  // touched = l'utente ha già spostato o ridimensionato il riquadro (la posizione GPS non lo sposta più)
  const crop = { snap: null, texts: null, ratio: "4:3", x: 0, y: 0, w: 0, touched: false };
  const ratioOf = () => RATIOS[crop.ratio][0] / RATIOS[crop.ratio][1];
  const cropH = () => crop.w / ratioOf();
  const maxCropW = () => Math.min(crop.snap.W, crop.snap.H * ratioOf());
  const clampW = (w) => Math.min(maxCropW(), Math.max(maxCropW() * MIN_FRACTION, w));

  function clampCrop() {
    crop.w = clampW(crop.w);
    crop.x = Math.min(Math.max(crop.x, 0), crop.snap.W - crop.w);
    crop.y = Math.min(Math.max(crop.y, 0), crop.snap.H - cropH());
  }

  /** Ridimensiona il riquadro di `factor` tenendo fermo il punto (mx, my) della mappa. */
  function scaleCropAt(factor, mx = crop.x + crop.w / 2, my = crop.y + cropH() / 2) {
    const rx = (mx - crop.x) / crop.w;
    const ry = (my - crop.y) / cropH();
    crop.w = clampW(crop.w * factor);
    crop.x = mx - rx * crop.w;
    crop.y = my - ry * cropH();
    clampCrop();
    scheduleRender();
  }

  function setRatio(r) {
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + cropH() / 2;
    crop.ratio = r;
    [outCanvas.width, outCanvas.height] = RATIOS[r];
    if (shareUi.dialog.open) layoutView();
    crop.w = clampW(crop.w);
    crop.x = cx - crop.w / 2;
    crop.y = cy - cropH() / 2;
    clampCrop();
    shareUi.ratio.replaceChildren(
      ...Object.keys(RATIOS).map((k) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = k;
        b.setAttribute("aria-pressed", String(k === crop.ratio));
        b.addEventListener("click", () => setRatio(k));
        return b;
      }),
    );
    scheduleRender();
  }

  /** Immagine finale: ritaglio della mappa + punti + intestazione + legenda e crediti. */
  function renderOut() {
    const [OW, OH] = RATIOS[crop.ratio];
    const ctx = outCanvas.getContext("2d");
    const { snap, texts } = crop;
    const s = OW / crop.w; // px dell'immagine per px della mappa
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(snap.canvas, crop.x * snap.scale, crop.y * snap.scale, crop.w * snap.scale, cropH() * snap.scale, 0, 0, OW, OH);

    // punti a grandezza fissa
    const k = PT_SCALE;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of shareUi.points.checked ? snap.points : []) {
      const px = (p.x - crop.x) * s;
      const py = (p.y - crop.y) * s;
      if (px < -40 || px > OW + 40 || py < -40 || py > OH + 40) continue;
      const vx = px + p.dx * k;
      const vy = py + p.dy * k;
      if (p.val) {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        roundRect(ctx, vx, vy + 1.5, p.w * k, p.h * k, 5);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        roundRect(ctx, vx, vy, p.w * k, p.h * k, 5);
        ctx.fill();
        // triangolino verso il cerchio (come sullo schermo)
        const t = 5 * k, w = p.w * k, h = p.h * k;
        const tri = {
          right: [[vx, vy + h / 2 - t], [vx - t, vy + h / 2], [vx, vy + h / 2 + t]],
          left: [[vx + w, vy + h / 2 - t], [vx + w + t, vy + h / 2], [vx + w, vy + h / 2 + t]],
          above: [[vx + w / 2 - t, vy + h], [vx + w / 2, vy + h + t], [vx + w / 2 + t, vy + h]],
          below: [[vx + w / 2 - t, vy], [vx + w / 2, vy - t], [vx + w / 2 + t, vy]],
        }[p.side];
        ctx.beginPath();
        ctx.moveTo(...tri[0]); ctx.lineTo(...tri[1]); ctx.lineTo(...tri[2]);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#1d2330";
        ctx.font = `600 ${11 * k}px ${FONT}`;
        ctx.fillText(p.val, vx + (p.w * k) / 2, vy + (p.h * k) / 2 + 1);
      }
      ctx.beginPath();
      ctx.arc(px, py, 11 * k, 0, Math.PI * 2);
      ctx.fillStyle = p.bg;
      ctx.fill();
      ctx.lineWidth = 2 * k;
      ctx.strokeStyle = "#1d2330";
      ctx.stroke();
      ctx.fillStyle = p.fg;
      ctx.font = `700 ${12 * k}px ${FONT}`;
      ctx.fillText(p.num, px, py + 1);
    }

    // intestazione in alto a sinistra: modello e corsa, grandezza e istante
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = `700 30px ${FONT}`;
    const tw = ctx.measureText(texts.title).width;
    ctx.font = `500 22px ${FONT}`;
    const sw = ctx.measureText(texts.sub).width;
    const hw = Math.min(OW - 48, Math.max(tw, sw) + 40);
    ctx.fillStyle = "rgba(255,255,255,0.93)";
    roundRect(ctx, 24, 24, hw, 94, 14);
    ctx.fill();
    ctx.fillStyle = "#1d2330";
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText(texts.title, 44, 66, hw - 40);
    ctx.fillStyle = "#3d4656";
    ctx.font = `500 22px ${FONT}`;
    ctx.fillText(texts.sub, 44, 100, hw - 40);

    // fascia in basso: legenda e crediti
    const BAND = 86;
    ctx.fillStyle = "rgba(255,255,255,0.93)";
    ctx.fillRect(0, OH - BAND, OW, BAND);
    const { thresholds, colors } = texts.v.scale;
    ctx.fillStyle = "#3d4656";
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText(texts.v.units, 24, OH - BAND + 30);
    const lx = 24 + ctx.measureText(texts.v.units).width + 14;
    const cont = !!texts.v.scale.continuous;
    const nseg = cont ? thresholds.length - 1 : thresholds.length;
    const cw = Math.min(64, (OW - lx - 24) / nseg);
    const ly = OH - BAND + 16;
    const every = thresholds.length > 14 ? 2 : 1; // come nella legenda della pagina
    ctx.font = `500 15px ${FONT}`;
    thresholds.forEach((t, i) => {
      if (i < nseg) {
        if (cont) {
          const g = ctx.createLinearGradient(lx + i * cw, 0, lx + (i + 1) * cw, 0);
          g.addColorStop(0, colors[i]);
          g.addColorStop(1, colors[i + 1]);
          ctx.fillStyle = g;
        } else ctx.fillStyle = colors[i];
        ctx.fillRect(lx + i * cw, ly, cw + (cont ? 0.5 : 0), 16);
      }
      ctx.fillStyle = "#3d4656";
      ctx.textAlign = i === 0 ? "left" : i === thresholds.length - 1 && cont ? "right" : "center";
      const skip = (i === 0 && !cont && texts.v.scale.transparent_below == null) || i % every;
      if (!skip) ctx.fillText(String(t).replace("-", "−"), lx + i * cw, ly + 36);
    });
    // autore in basso a destra, sulla riga della legenda (la barra arriva al massimo a ~900 px)
    ctx.textAlign = "right";
    ctx.font = `700 15px ${FONT}`;
    ctx.fillStyle = "#1d2330";
    const site = "signalkuppe.com";
    ctx.fillText(site, OW - 24, ly + 13);
    const siteW = ctx.measureText(site).width;
    ctx.font = `400 15px ${FONT}`;
    ctx.fillStyle = "#5d6677";
    ctx.fillText("Realizzato da ", OW - 24 - siteW, ly + 13);
    ctx.textAlign = "left";
    ctx.font = `400 13px ${FONT}`;
    ctx.fillStyle = "#5d6677";
    ctx.fillText(texts.attr, 24, OH - 12, OW - 48);
  }

  // vista nella modale: riquadro fisso al centro (il più grande che sta nello spazio), sotto la mappa fotografata
  // che si sposta e si ingrandisce; fuori dal riquadro la mappa resta visibile ma velata.
  const view = { dpr: 1, cw: 0, ch: 0, fx: 0, fy: 0, fw: 0, fh: 0 };
  function layoutView() {
    const r = shareUi.canvas.getBoundingClientRect();
    view.dpr = window.devicePixelRatio || 1;
    view.cw = r.width;
    view.ch = r.height;
    shareUi.canvas.width = Math.round(r.width * view.dpr);
    shareUi.canvas.height = Math.round(r.height * view.dpr);
    const ratio = ratioOf();
    view.fw = Math.max(1, Math.min(r.width - 2 * FRAME_PAD, (r.height - 2 * FRAME_PAD) * ratio));
    view.fh = view.fw / ratio;
    view.fx = (r.width - view.fw) / 2;
    view.fy = (r.height - view.fh) / 2;
  }
  const viewScale = () => view.fw / crop.w; // px della vista per px della mappa
  function renderView() {
    renderOut();
    const ctx = shareUi.canvas.getContext("2d");
    const { snap } = crop;
    const fs = viewScale();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.cw, view.ch);
    ctx.imageSmoothingQuality = "high";
    // mappa intera nella stessa scala del riquadro, così fuori si vede il contesto
    ctx.drawImage(snap.canvas, view.fx - crop.x * fs, view.fy - crop.y * fs, snap.W * fs, snap.H * fs);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, view.cw, view.ch);
    ctx.rect(view.fx, view.fy, view.fw, view.fh);
    ctx.fill("evenodd");
    ctx.drawImage(outCanvas, view.fx, view.fy, view.fw, view.fh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(view.fx, view.fy, view.fw, view.fh);
  }

  let renderPending = false;
  let fileTimer = null;
  function scheduleRender() {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => { renderPending = false; renderView(); });
    }
    // il file si rigenera a gesto concluso, così "Condividi" ha già l'immagine pronta
    shareFile = null;
    clearTimeout(fileTimer);
    fileTimer = setTimeout(makeShareFile, 250);
  }
  function makeShareFile() {
    return new Promise((res) => {
      requestAnimationFrame(() => {
        renderOut();
        outCanvas.toBlob((blob) => {
          shareFile = new File([blob], crop.texts.name, { type: "image/jpeg" });
          res(shareFile);
        }, "image/jpeg", 0.9);
      });
    });
  }
  async function readyShareFile() {
    if (shareFile) return shareFile;
    clearTimeout(fileTimer);
    return makeShareFile();
  }

  // vista della mappa prima della condivisione: la mappa si centra per un attimo sulla posizione e poi ci torna
  let shareRestore = null;

  async function openShare() {
    // la mappa si centra sulla posizione del dispositivo (stesso zoom), così il riquadro più grande parte da lì
    const pos = await knownPosition();
    shareRestore = null;
    if (pos && inBox(pos.lat, pos.lon)) {
      shareRestore = { center: map.getCenter(), zoom: map.getZoom() };
      map.setView([pos.lat, pos.lon], map.getZoom(), { animate: false });
      await tilesReady();
    }
    crop.snap = snapshotMap();
    crop.texts = shareTexts();
    // all'apertura il riquadro più grande che sta nella mappa (zoom minimo), centrato sulla posizione se c'è,
    // altrimenti sulla mappa (la proporzione resta l'ultima scelta)
    [outCanvas.width, outCanvas.height] = RATIOS[crop.ratio];
    crop.w = maxCropW();
    const c = shareRestore ? map.latLngToContainerPoint([pos.lat, pos.lon]) : { x: crop.snap.W / 2, y: crop.snap.H / 2 };
    crop.x = c.x - crop.w / 2;
    crop.y = c.y - cropH() / 2;
    clampCrop();
    crop.touched = false;
    shareUi.pointsRow.hidden = !crop.snap.points.length;
    shareUi.dialog.showModal();
    layoutView();
    setRatio(crop.ratio);
  }
  // alla chiusura (X, Esc, dopo la condivisione) la mappa torna dov'era
  shareUi.dialog.addEventListener("close", () => {
    if (shareRestore) map.setView(shareRestore.center, shareRestore.zoom, { animate: false });
    shareRestore = null;
  });

  /** Aspetta le tessere dello sfondo dopo lo spostamento (al massimo 2 s) e un paio di frame per le linee. */
  function tilesReady() {
    return new Promise((resolve) => {
      const layer = bases[state.base];
      const done = () => { layer.off("load", done); clearTimeout(t); requestAnimationFrame(() => requestAnimationFrame(resolve)); };
      const t = setTimeout(done, 2000);
      if (!layer.isLoading?.()) done(); else layer.once("load", done);
    });
  }

  // ---------- posizione del dispositivo: salvata nel browser (localStorage, arrotondata a ~100 m) e mai inviata a
  // nessuno. Si usa subito quella salvata e intanto la si aggiorna per la volta dopo; la prima volta si aspetta il
  // browser (che chiede il permesso), al massimo 8 secondi.
  const POS_KEY = "weathermaps.pos.v1";
  function savedPosition() {
    try {
      const d = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      return d && Number.isFinite(d.lat) && Number.isFinite(d.lon) ? d : null;
    } catch { return null; }
  }
  function refreshPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition((p) => {
        const pos = { lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) };
        try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* storage non disponibile */ }
        resolve(pos);
      }, () => resolve(null), { enableHighAccuracy: false, maximumAge: 10 * 60e3, timeout: 8000 });
    });
  }
  async function knownPosition() {
    const saved = savedPosition();
    const fresh = refreshPosition();
    return saved || (await fresh);
  }
  new ResizeObserver(() => {
    if (shareUi.dialog.open && crop.snap) { layoutView(); scheduleRender(); }
  }).observe(shareUi.canvas);

  function closeShare() {
    if (shareUi.dialog.open) shareUi.dialog.close(); // chiusura immediata, senza animazione
  }

  // gesti sulla mappa sotto il riquadro: trascinare la sposta, pizzico e rotella la ingrandiscono
  // (= riquadro più piccolo sulla mappa, più dettaglio)
  const pointers = new Map();
  let pinch = null;
  const toView = (e) => {
    const r = shareUi.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** Punto della mappa fotografata sotto un punto della vista. */
  const viewToMap = ([vx, vy]) => [crop.x + (vx - view.fx) / viewScale(), crop.y + (vy - view.fy) / viewScale()];
  shareUi.canvas.addEventListener("pointerdown", (e) => {
    crop.touched = true;
    shareUi.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, toView(e));
    pinch = null;
  });
  shareUi.canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const now = toView(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 1) {
      const fs = viewScale();
      crop.x -= (now[0] - prev[0]) / fs;
      crop.y -= (now[1] - prev[1]) / fs;
      clampCrop();
      scheduleRender();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch && dist) scaleCropAt(pinch / dist, ...viewToMap([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
      pinch = dist;
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
  };
  shareUi.canvas.addEventListener("pointerup", endPointer);
  shareUi.canvas.addEventListener("pointercancel", endPointer);
  shareUi.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    crop.touched = true;
    // rotella in avanti = mappa più grande (più dettaglio)
    scaleCropAt(Math.exp(e.deltaY * 0.0015), ...viewToMap(toView(e)));
  }, { passive: false });
  shareUi.zoomIn.addEventListener("click", () => { crop.touched = true; scaleCropAt(1 / 1.25); });
  shareUi.zoomOut.addEventListener("click", () => { crop.touched = true; scaleCropAt(1.25); });

  function toast(text) {
    shareUi.toast.textContent = text;
    shareUi.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { shareUi.toast.hidden = true; }, 4500);
  }

  async function downloadShareFile() {
    await readyShareFile();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(shareFile);
    a.download = shareFile.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Condivisione nativa del solo file (telefono: menu con WhatsApp e altre app); altrimenti lo scarica. */
  async function sendShare() {
    await readyShareFile();
    // solo l'immagine, senza testo né link: modello, corsa e istante sono già scritti sopra
    const data = { files: [shareFile] };
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
    // browser senza condivisione di file (soprattutto desktop): si scarica l'immagine
    await downloadShareFile();
    toast("Immagine scaricata: allegala dove vuoi condividerla.");
    return true;
  }

  shareUi.btn.addEventListener("click", async () => {
    if (!current) { toast("Niente da condividere: scegli un istante con dati."); return; }
    shareUi.btn.disabled = true;
    setLoading(true);
    try {
      // modale con ritaglio: il clic su "Condividi" è un gesto nuovo, valido per la condivisione nativa
      await openShare();
    } catch (e) {
      toast(`Impossibile creare l'immagine: ${e.message}`);
    } finally {
      setLoading(false);
      shareUi.btn.disabled = false;
    }
  });
  shareUi.send.addEventListener("click", async () => {
    try {
      if (await sendShare()) closeShare();
    } catch (e) {
      toast(`Condivisione non riuscita: ${e.message}`);
    }
  });
  shareUi.download.addEventListener("click", () => { downloadShareFile(); });
  shareUi.close.addEventListener("click", closeShare);


  // ---------- tooltip puntuale (griglia nativa, nearest neighbour)
  map.on("mousemove", (e) => {
    // sopra una località (o col suo riquadro aperto lì) basta il riquadro nero: un solo tooltip alla volta
    if (!current || popIdx != null || e.originalEvent?.target?.closest?.(".pt, .pt-pop")) { ui.probe.hidden = true; return; }
    const { lat0, lon0, dlat, dlon, nx, ny } = current.grid;
    const ix = Math.round((e.latlng.lng - lon0) / dlon);
    const iy = Math.round((e.latlng.lat - lat0) / dlat);
    let text;
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) text = "—";
    else {
      const v = current.values[iy * nx + ix];
      text = v == null ? "—" : `<b>${v.toFixed(variable().decimals)}</b> ${current.units}`;
      const d = current.u ? windDirAt(current, e.latlng.lat, e.latlng.lng) : null;
      if (d) text += ` da ${d.name}`;
    }
    if (currentContour) {
      const z = valueAt(currentContour, e.latlng.lat, e.latlng.lng);
      if (z != null) text += ` · ${contourName().toLowerCase()} <b>${Math.round(z)}</b> ${currentContour.units}`;
    }
    // seconda riga: le grandezze in più (sulla mappa della T850 la quota della superficie di 850 hPa)
    const more = extras()
      .map((d) => [d, extraValue(d, e.latlng.lat, e.latlng.lng)])
      .filter(([, x]) => x)
      .map(([d, x]) => `${SHORT[d.var] || d.label} <b>${x.replace(/ (\S+)$/, "</b> $1")}`);
    if (more.length) text += `<div class="probe-more">${more.join(" · ")}</div>`;
    ui.probe.innerHTML = text;
    // a destra del mouse, a sinistra se non ci sta; sempre dentro la finestra (8px dai bordi)
    ui.probe.hidden = false;
    const W = map.getContainer().clientWidth, H = map.getContainer().clientHeight;
    const w = ui.probe.offsetWidth, h = ui.probe.offsetHeight, { x, y } = e.containerPoint;
    let left = x + 14;
    if (left + w > W - 8) left = x - 14 - w;
    left = Math.min(Math.max(left, 8), Math.max(8, W - 8 - w));
    const top = Math.min(Math.max(y - h / 2, 8), Math.max(8, H - 8 - h));
    ui.probe.style.left = `${left}px`;
    ui.probe.style.top = `${top}px`;
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

  // icone Lucide "play" e "pause" del pulsante nella barra mobile
  const M_PLAY = ui.mPlay.innerHTML;
  const M_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="2.25" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/>' +
    '<rect x="6" y="4" width="4" height="16" rx="1"/></svg>';
  function togglePlay(force) {
    const on = force ?? !playTimer;
    if (on && !playTimer) {
      ui.play.textContent = "❚❚";
      ui.mPlay.innerHTML = M_PAUSE;
      ui.mPlay.setAttribute("aria-label", "Ferma animazione");
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
      ui.mPlay.innerHTML = M_PLAY;
      ui.mPlay.setAttribute("aria-label", "Avvia animazione");
    }
  }

  ui.step.addEventListener("input", () => { state.step = steps()[+ui.step.value]; update(); });
  ui.prev.addEventListener("click", () => goStep(-1));
  ui.next.addEventListener("click", () => goStep(1));
  // frecce del riquadro in basso su mobile: come quelle del pannello, ma fermano il play
  $("m-prev").addEventListener("click", () => { togglePlay(false); goStep(-1); });
  $("m-next").addEventListener("click", () => { togglePlay(false); goStep(1); });
  ui.mPlay.addEventListener("click", () => togglePlay());
  // «: torna al primo passo disponibile della corsa
  $("m-first").addEventListener("click", () => {
    togglePlay(false);
    const s = steps();
    const avail = availableSteps();
    const i = Math.max(0, s.findIndex((x) => avail.has(x)));
    state.step = s[i];
    ui.step.value = i;
    update();
  });
  ui.play.addEventListener("click", () => togglePlay());
  ui.opacity.addEventListener("input", () => {
    state.opacity = +ui.opacity.value;
    overlay?.setOpacity(state.opacity);
    styleBorders();
    writeHash();
  });
  ui.crisp.addEventListener("change", () => { state.crisp = ui.crisp.checked; if (current) draw(current); writeHash(); });
  ui.iso.addEventListener("change", () => { state.iso = ui.iso.checked; drawContours(variable().contour_field ? currentContour : current); renderLegend(); writeHash(); });
  ui.model.addEventListener("change", () => { state.model = ui.model.value; renderModelInfo(); setupRuns(); setupSteps(); update(); });
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
      // versione dai tag git (vuota se non ci sono tag)
      if (meta.version) { $("app-version").textContent = meta.version; $("app-version").hidden = false; }
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
    setBase("osm"); // all'avvio sempre OpenStreetMap; gli altri sfondi si scelgono in "Impostazioni"

    ui.opacity.value = state.opacity;
    styleBorders(); // opacità al massimo dall'URL: contorni subito
    ui.crisp.checked = state.crisp;
    ui.iso.checked = state.iso;
    setupVars();
    // su schermi stretti l'elenco delle località parte chiuso per non coprire la mappa
    if (mobileMq.matches) ui.pointsBox.open = false;
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
        const changed = setupRuns(); // passa da sola alla nuova corsa quando è completa
        if (changed) setupSteps();
        if (changed || !current) update();
      } catch { /* offline: riprova al prossimo giro */ }
    }, 2 * 60e3);
  }

  init();
})();
