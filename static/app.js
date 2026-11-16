/* Weathermaps: frontend. Tutto ciò che dipende da area, modelli e grandezze
   arriva da /api/meta e /api/runs: qui non ci sono coordinate né soglie fisse. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // App dalla schermata Home in verticale (iOS 26): la pagina parte sotto l'orologio ma iOS la accorcia lo stesso
  // dell'altezza della barra di stato (es. 812 px su 874), e in fondo resta una fascia vuota. Qui la pagina prende
  // tutta l'altezza dello schermo (--app-h, vedi html/body in style.css). In orizzontale e nel browser non serve.
  // Registrato prima di Leaflet e Mapbox: al ridimensionamento la misura nuova è già pronta quando ricalcolano.
  function fixAppHeight() {
    const app =
      window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
    const full = Math.max(screen.width, screen.height);
    const portrait = innerHeight > innerWidth;
    const root = document.documentElement.style;
    if (app && portrait && innerHeight < full) root.setProperty("--app-h", `${full}px`);
    else root.removeProperty("--app-h");
  }
  fixAppHeight();
  window.addEventListener("resize", fixAppHeight);

  const ui = {
    model: $("model"),
    varSel: $("var"),
    varRow: $("var-row"),
    run: $("run"),
    mode: $("mode"),
    modeRow: $("mode-row"),
    step: $("step"),
    prev: $("prev"),
    next: $("next"),
    play: $("play"),
    opacity: $("opacity"),
    crisp: $("crisp"),
    valid: $("valid"),
    range: $("range"),
    status: $("status"),
    attrib: $("attrib"),
    base: $("base"),
    borders: $("borders"),
    bordersOpacity: $("borders-opacity"),
    iso: $("iso"),
    isoRow: $("iso-row"),
    isoText: $("iso-text"),
    legend: $("legend"),
    probe: $("probe"),
    panel: $("panel"),
    collapse: $("collapse"),
    appReload: $("app-reload"),
    badge: $("badge"),
    badgeText: $("badge-text"),
    mPlay: $("m-play"),
    runAge: $("run-age"),
    runLive: $("run-live"),
    runLiveText: $("run-live-text"),
    refresh: $("refresh"),
    runLiveNote: $("run-live-note"),
    pointsBox: $("points-box"),
    points: $("points"),
    loading: $("loading"),
    nodata: $("nodata"),
    nodataTitle: $("nodata-title"),
    nodataText: $("nodata-text"),
    placeQ: $("place-q"),
    placeResults: $("place-results"),
    placesEdit: $("places-edit"),
    modelInfo: $("model-info"),
    modelInfoBtn: $("model-info-btn"),
    privacyOpen: $("privacy-open"),
    privacyDialog: $("privacy-dialog"),
    privacyClose: $("privacy-close"),
  };

  ui.privacyOpen.addEventListener("click", () => {
    ui.privacyDialog.showModal();
    ui.privacyClose.focus();
  });
  ui.privacyClose.addEventListener("click", () => ui.privacyDialog.close());
  ui.privacyDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    ui.privacyDialog.close();
  });

  // run: sempre l'ultima corsa completa del modello (non si sceglie più a mano)
  const state = {
    model: "gfs",
    var: "t850",
    run: null,
    step: null, // ora mostrata (con le cumulate: dentro il range)
    // cumulate: range dello slider (fisso finché non lo sposti, all'apertura tutta la corsa) e tipo di cumulata
    // ("total" = dall'inizio del range, "hours" = le ultime `hours` ore). `mode` ne discende (vedi syncMode)
    rangeFrom: null,
    rangeTo: null,
    cum: "total",
    mode: null,
    opacity: 0.7,
    crisp: false,
    iso: true,
    hours: 3,
    base: "topo",
    borders: "regions",
    bordersOpacity: 1,
    extra: "none",
  }; // predefiniti: Outdoors, colori al 70%, confini fino alle regioni a pieno contrasto, celle sfumate
  // "static": sito pubblicato su GitHub Pages (file JSON pre-generati, nessun server)
  const STATIC = document.documentElement.dataset.mode === "static";
  let publishedAt = null; // solo statico: quando sono stati pubblicati i dati
  let meta = null;
  let runs = null;
  let current = null; // risposta /api/field mostrata
  let currentContour = null; // campo delle linee nelle voci combinate (es. zero termico sopra la pioggia)
  let currentArrows = null; // componenti del vento nelle voci combinate con le frecce (es. vento 700 hPa sopra la pioggia)
  let overlay = null;
  let menuLL = null; // punto del menu della mappa aperto (clic destro o pressione prolungata), vedi openMapMenu
  let probeLL = null; // punto toccato su mobile: il tooltip del valore resta lì (vedi "tooltip puntuale")
  let playTimer = null;
  let playbackSelection = null;
  const cache = new Map();

  const intervalSliders = ["interval-step", "m-interval-step"].map((id) => {
    const element = $(id);
    let slider;
    slider = rangeSlider(element, {
      min: 0,
      max: 1,
      value: [0, 1],
      rangeSlideDisabled: false,
      onInput: (value, userInteraction) => {
        if (!userInteraction || !meta) return;
        playbackSelection = null;
        const values = intervalSteps();
        let [from, to] = value.map(Math.round);
        if (from >= to) {
          if (slider.currentValueIndex() === 0) from = Math.max(0, to - 1);
          else to = Math.min(values.length - 1, from + 1);
          slider.value([from, to]);
        }
        state.rangeFrom = values[from];
        state.rangeTo = values[to];
        state.step = state.rangeTo; // si mostra la fine del range
        syncMode();
        ui.step.value = steps().indexOf(state.step);
        togglePlay(false);
        updateModeSelection();
        update();
        queueMicrotask(syncIntervalSliders);
      },
    });
    const inputs = element.querySelectorAll('input[type="range"]');
    for (const input of inputs) input.setAttribute("aria-hidden", "true");
    const thumbs = element.querySelectorAll('[role="slider"]');
    thumbs[0].setAttribute("aria-label", "Inizio dell'intervallo");
    thumbs[1].setAttribute("aria-label", "Fine dell'intervallo");
    const progress = document.createElement("div");
    progress.className = "interval-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "Avanzamento animazione");
    progress.hidden = true;
    element.append(progress);
    slider.progress = progress;
    slider.element = element;
    return slider;
  });

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
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    // Thunderforest Outdoors: la chiave arriva da /api/meta (vedi init), finché non c'è la tessera resta vuota
    topo: L.tileLayer(
      "https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}{r}.png?apikey={apikey}",
      {
        crossOrigin: "anonymous",
        maxZoom: 22,
        apikey: "",
        attribution:
          'Mappa &copy; <a href="https://www.thunderforest.com">Thunderforest</a>, dati &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    ),
  };
  const MAPBOX_STYLES = {
    osm: "mapbox://styles/mapbox/streets-v12",
    topo: "mapbox://styles/mapbox/outdoors-v12",
  };
  const MAPBOX_ATTR =
    '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  let glBase = null;
  /** Nomi in italiano dove ci sono (name_it), altrimenti il nome locale: niente "Genova / Genoa". */
  function italianLabels(m) {
    for (const layer of m.getStyle().layers) {
      const tf =
        layer.type === "symbol" && m.getLayoutProperty(layer.id, "text-field");
      if (!tf) continue;
      const s = JSON.stringify(tf);
      if (s.includes('"name'))
        m.setLayoutProperty(
          layer.id,
          "text-field",
          JSON.parse(s.replace(/"name_en"/g, '"name_it"')),
        );
    }
  }
  function hideTransportLabels(m) {
    for (const id of ["road-label"]) {
      if (!m.getLayer(id)) continue;
      const filter = m.getFilter(id);
      m.setFilter(id, [
        "all",
        ...(filter ? [filter] : []),
        [
          "!",
          [
            "match",
            ["get", "class"],
            ["motorway", "motorway_link"],
            true,
            false,
          ],
        ],
      ]);
    }
    for (const id of [
      "road-number-shield",
      "road-exit-shield",
      "airport-label",
    ])
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none");
  }
  /** "Base": Streets di Mapbox ricolorato come una carta meteo (tavolozza simile a meteoblue): fondo beige chiaro, boschi
   *  verde tenue, acqua azzurra, strade bianche sottili. Sotto i colori dei dati non deve competere con loro. */
  const LAND = "hsl(47, 26%, 88%)",
    GREEN = "hsla(82, 46%, 72%, 0.55)",
    WATER = "hsl(205, 56%, 73%)";
  /** Outdoors: rilievo più marcato, ombreggiatura calcolata dal modello del terreno di Mapbox (oltre a quella, tenue,
   *  già nello stile). Sotto strade, colori dei dati e confini. */
  function strongRelief(m) {
    if (m.__style !== MAPBOX_STYLES.topo || m.getLayer("wm-relief")) return;
    m.addSource("wm-dem", {
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 512,
      maxzoom: 14,
    });
    const before = m.getLayer("hillshade") ? "hillshade" : glBefore(m);
    m.addLayer(
      {
        id: "wm-relief",
        type: "hillshade",
        source: "wm-dem",
        paint: {
          "hillshade-exaggeration": 0.75,
          "hillshade-shadow-color": "hsl(30, 20%, 22%)",
          "hillshade-highlight-color": "hsla(45, 60%, 97%, 0.9)",
          "hillshade-accent-color": "hsl(30, 15%, 35%)",
          "hillshade-illumination-direction": 315,
        },
      },
      before,
    );
  }
  function meteoPalette(m) {
    if (m.__style !== MAPBOX_STYLES.osm) return;
    const set = (id, prop, v) => {
      if (m.getLayer(id)) m.setPaintProperty(id, prop, v);
    };
    set("land", "background-color", LAND);
    set("land-structure-polygon", "fill-color", LAND);
    set("land-structure-line", "line-color", LAND);
    set("landcover", "fill-color", [
      "match",
      ["get", "class"],
      "snow",
      "hsl(47, 22%, 96%)",
      GREEN,
    ]);
    set("national-park", "fill-color", "hsla(82, 46%, 72%, 0.25)");
    set("landuse", "fill-color", [
      "match",
      ["get", "class"],
      ["park", "wood", "grass", "scrub", "agriculture", "cemetery", "pitch"],
      GREEN,
      "hsl(39, 30%, 84%)",
    ]);
    for (const id of ["water", "water-shadow"]) set(id, "fill-color", WATER);
    for (const id of ["waterway", "waterway-shadow"])
      set(id, "line-color", WATER);
    if (m.getLayer("water-depth"))
      m.setLayoutProperty("water-depth", "visibility", "none");
    for (const l of m.getStyle().layers) {
      // strade: bianche, bordo appena più scuro del fondo
      if (
        l.type !== "line" ||
        !/^(road|bridge|tunnel)-/.test(l.id) ||
        /rail|path|steps|pedestrian|construction|oneway/.test(l.id)
      )
        continue;
      m.setPaintProperty(
        l.id,
        "line-color",
        /case/.test(l.id) ? "hsl(39, 20%, 76%)" : "#ffffff",
      );
    }
  }
  /* Colori dentro Mapbox: le immagini dei dati (modello, radar, satellite) diventano strati dello stile, inseriti
   * sotto confini e nomi (e sopra terreno, acqua e strade). Così confini e città di Mapbox restano leggibili sopra i
   * colori a qualunque opacità, e coincidono con quelli dello sfondo. Un registro le ricrea quando cambia lo stile. */
  const glImgs = new Map(); // id -> { url, bounds, opacity, crisp, visible }
  let glStyleReady = false;
  const glMap = () => (glBase && glStyleReady ? glBase : null);
  const glCoords = (b) => [
    [b.getWest(), b.getNorth()],
    [b.getEast(), b.getNorth()],
    [b.getEast(), b.getSouth()],
    [b.getWest(), b.getSouth()],
  ];
  /** Primo strato da tenere sopra i colori: i confini (dopo strade e ponti, che restano sotto), se mancano le scritte
   *  dei luoghi. */
  const glBefore = (m) => {
    const ls = m.getStyle().layers;
    return (
      ls.find((l) => /^(wm-)?admin-/.test(l.id)) ||
      ls.find((l) => /label/.test(l.id))
    )?.id;
  };
  function glApply(m, id, c) {
    const coordinates = glCoords(c.bounds);
    const src = m.getSource(id);
    if (!src) {
      m.addSource(id, { type: "image", url: c.url, coordinates });
      // già con l'opacità giusta e senza transizioni: Mapbox altrimenti parte da 1 e sfuma in 300 ms (le immagini del radar
      // in caricamento si vedevano per un attimo, e la dissolvenza dell'animazione arrivava in ritardo)
      m.addLayer(
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-fade-duration": 0,
            "raster-opacity": c.visible ? c.opacity : 0,
            "raster-opacity-transition": { duration: 0, delay: 0 },
          },
        },
        glBefore(m),
      );
    } else if (
      src.__url !== c.url ||
      JSON.stringify(src.__coords) !== JSON.stringify(coordinates)
    ) {
      // un'immagine alla volta: se Mapbox sta ancora caricando o decodificando la precedente, quella nuova aspetta
      // (cambiandola a metà, la vecchia può arrivare dopo la nuova e restare sulla mappa: muovendo in fretta lo slider
      // i colori si fermavano su un passo sbagliato)
      if (src._imageRequest) {
        if (!src.__wait) {
          src.__wait = true;
          const retry = () => {
            const s2 = m.getSource(id),
              c2 = glImgs.get(id);
            if (s2 !== src || !c2) {
              src.__wait = false;
              return;
            }
            if (src._imageRequest) {
              requestAnimationFrame(retry);
              return;
            }
            src.__wait = false;
            if (c2.url) glApply(m, id, c2);
          };
          requestAnimationFrame(retry);
        }
        m.setPaintProperty(id, "raster-opacity", c.visible ? c.opacity : 0);
        return;
      }
      src.updateImage({ url: c.url, coordinates });
    }
    Object.assign(m.getSource(id), { __url: c.url, __coords: coordinates });
    m.setPaintProperty(id, "raster-opacity", c.visible ? c.opacity : 0);
    m.setPaintProperty(id, "raster-resampling", c.crisp ? "nearest" : "linear");
  }
  function glPut(id, o) {
    const c = Object.assign(
      glImgs.get(id) || { opacity: 1, crisp: false, visible: true },
      o,
    );
    glImgs.set(id, c);
    const m = glMap();
    if (m && c.url) glApply(m, id, c);
  }
  function glRemove(id) {
    glImgs.delete(id);
    const m = glMap();
    if (m?.getLayer(id)) m.removeLayer(id);
    if (m?.getSource(id)) m.removeSource(id);
  }
  /** "Confini" (Impostazioni) sui confini di Mapbox, sopra i colori: Nessuno li nasconde, Stati / Regioni /
   *  Province li mostrano scuri fino a quel livello, con l'opacità scelta. Le province (admin_level 2) ci sono nei
   *  dati di Mapbox ma non nello stile: le aggiunge uno strato nostro. */
  let glWater = null; // GeoJSON delle coste, da borders.json
  let glWaterLoad = null;
  function glBorders() {
    glWaterLoad ??= fetch("borders.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((b) => {
        const lonlat = (line) => line.map(([la, lo]) => [lo, la]);
        glWater = {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiLineString",
            coordinates: (b.coast || []).map(lonlat),
          },
        };
        glBorders();
      })
      .catch(() => {
        glWaterLoad = null;
      });
    const m = glMap();
    if (!m) return;
    const n = Object.keys(BORDER_NAMES).indexOf(state.borders),
      op = state.bordersOpacity;
    if (!m.getLayer("wm-admin-2") && m.getLayer("admin-1-boundary-bg")) {
      m.addLayer(
        {
          id: "wm-admin-2",
          type: "line",
          source: "composite",
          "source-layer": "admin",
          filter: [
            "all",
            ["==", ["get", "admin_level"], 2],
            ["!=", ["to-string", ["get", "maritime"]], "true"],
            ["match", ["get", "worldview"], ["all", "US"], true, false],
          ],
          layout: { "line-join": "round" },
          paint: {
            "line-color": "#1f2328",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              5,
              0.9,
              10,
              1.6,
            ],
            "line-dasharray": [3, 2],
          },
        },
        "admin-1-boundary-bg",
      );
    }
    // coste (sotto i colori il mare non si vede più): da borders.json, da OpenStreetMap come lo sfondo.
    // Il contorno dell'acqua di Mapbox comprenderebbe anche i fiumi, a trattini sparsi.
    if (
      !m.getLayer("wm-coast") &&
      m.getLayer("admin-1-boundary-bg") &&
      glWater
    ) {
      m.addSource("wm-coast", { type: "geojson", data: glWater });
      m.addLayer(
        {
          id: "wm-coast",
          type: "line",
          source: "wm-coast",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#1f2328",
            "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 1.8],
          },
        },
        "admin-1-boundary-bg",
      );
    }
    const levels = {
      "wm-coast": 1,
      "admin-0-boundary": 1,
      "admin-0-boundary-bg": 1,
      "admin-0-boundary-disputed": 1,
      "admin-1-boundary": 2,
      "admin-1-boundary-bg": 2,
      "wm-admin-2": 3,
    };
    for (const [id, lvl] of Object.entries(levels)) {
      if (!m.getLayer(id)) continue;
      m.setLayoutProperty(id, "visibility", n >= lvl && !synoptic() ? "visible" : "none");
      if (id.endsWith("-bg")) {
        // alone chiaro sotto la linea: bianco come in Streets (Outdoors lo ha rosato)
        m.setPaintProperty(id, "line-color", "#ffffff");
        continue;
      }
      m.setPaintProperty(id, "line-opacity", op);
      if (id.startsWith("wm-")) continue;
      // stati e regioni a linea continua e scura (negli stili Mapbox sono tratteggiati e chiari: sopra i colori sparivano)
      m.setPaintProperty(id, "line-color", "#1f2328");
      if (id !== "admin-0-boundary-disputed")
        m.setPaintProperty(id, "line-dasharray", [10, 0]);
      m.setPaintProperty(id, "line-width", [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        lvl === 1 ? 1.8 : 1.2,
        10,
        lvl === 1 ? 3 : 2,
      ]);
    }
  }
  function connectMapbox(m) {
    const pane = map.getPane("mapPane");
    let syncing = false,
      view = null;
    map.options.zoomSnap = 0;
    map.options.zoomAnimation = false;
    map.setMaxZoom(22);
    for (const handler of [
      "dragging",
      "touchZoom",
      "doubleClickZoom",
      "scrollWheelZoom",
      "boxZoom",
      "keyboard",
      "tapHold",
    ])
      map[handler]?.disable();
    m.touchZoomRotate.disableRotation();
    m.touchPitch.disable();
    m.keyboard.disableRotation();
    m.on("movestart", () => {
      if (syncing) return;
      closeMapMenuOnMove();
      view = {
        center: map.getCenter(),
        zoom: map.getZoom(),
        position: L.DomUtil.getPosition(pane).clone(),
      };
      document.body.classList.add("wm-native-moving");
    });
    m.on("move", () => {
      if (syncing || !view) return;
      const scale = 2 ** (m.getZoom() + 1 - view.zoom);
      const center = m.project([view.center.lng, view.center.lat]);
      const origin = map.getSize().divideBy(2).subtract(view.position);
      L.DomUtil.setTransform(
        pane,
        L.point(center.x, center.y).subtract(origin.multiplyBy(scale)),
        scale,
      );
    });
    m.on("moveend", () => {
      if (syncing || !view) return;
      syncing = true;
      L.DomUtil.setTransform(pane, view.position);
      view = null;
      const center = m.getCenter();
      map.setView([center.lat, center.lng], m.getZoom() + 1, {
        animate: false,
      });
      syncing = false;
      document.body.classList.remove("wm-native-moving");
    });
    map.on("move", () => {
      if (syncing || view) return;
      const center = map.getCenter();
      syncing = true;
      m.jumpTo({ center: [center.lng, center.lat], zoom: map.getZoom() - 1 });
      syncing = false;
    });
    map.on("resize zoomlevelschange", () => {
      if (syncing) return;
      syncing = true;
      m.setMinZoom(Math.max(0, map.getMinZoom() - 1));
      m.resize();
      const center = m.getCenter();
      map.setView([center.lat, center.lng], m.getZoom() + 1, {
        animate: false,
      });
      syncing = false;
    });
    for (const type of ["click", "mousemove", "mouseout", "contextmenu"]) {
      m.on(type, (event) => {
        if (view) return;
        const latlng = L.latLng(event.lngLat.lat, event.lngLat.lng);
        map.fire(type, {
          latlng,
          containerPoint: L.point(event.point.x, event.point.y),
          layerPoint: map.latLngToLayerPoint(latlng),
          originalEvent: event.originalEvent,
        });
      });
    }
  }
  /** Copia del disegno di Mapbox per l'immagine condivisa: senza preserveDrawingBuffer (più lento) il canvas WebGL si
   *  può leggere solo subito dopo un disegno, nell'evento "render". */
  function glCapture() {
    return new Promise((resolve) => {
      const m = glBase;
      m.once("render", () => {
        const src = m.getCanvas(),
          copy = document.createElement("canvas");
        copy.width = src.width;
        copy.height = src.height;
        copy.getContext("2d").drawImage(src, 0, 0);
        resolve(copy);
      });
      m.triggerRepaint();
    });
  }
  let glShot = null; // ultima copia di glCapture, usata da snapshotMap
  /** Carta sinottica: dello sfondo Mapbox restano solo il fondo e i nostri strati (colori dei dati); coste e stati
   *  sono linee nostre a bassa risoluzione (styleSynBorders). Tornando alla mappa normale riappare tutto com'era. */
  function glSynopticBase() {
    const m = glMap();
    if (!m) return;
    if (synoptic()) {
      m.__synHidden ??= new Set();
      for (const l of m.getStyle().layers) {
        if (l.type === "background" || glImgs.has(l.id)) continue; // restano il fondo e le immagini dei dati
        if (m.getLayoutProperty(l.id, "visibility") === "none") continue;
        m.__synHidden.add(l.id);
        m.setLayoutProperty(l.id, "visibility", "none");
      }
    } else if (m.__synHidden) {
      for (const id of m.__synHidden)
        if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      m.__synHidden = null;
    }
    glBorders();
  }
  const glBounds = (a) => [
    [a.lon_min, a.lat_min],
    [a.lon_max, a.lat_max],
  ];
  function setupMapbox(token) {
    if (!token || !window.mapboxgl || !mapboxgl.supported()) return;
    const container = document.createElement("div");
    container.className = "wm-native-map";
    map.getContainer().before(container);
    const center = map.getCenter();
    const options = {
      container,
      accessToken: token,
      style: MAPBOX_STYLES[state.base] || MAPBOX_STYLES.topo,
      center: [center.lng, center.lat],
      zoom: map.getZoom() - 1,
      minZoom: Math.max(0, map.getMinZoom() - 1),
      maxZoom: 21,
      maxBounds: glBounds(areaNow()),
      projection: "mercator",
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0, // niente dissolvenza delle scritte: meno fotogrammi da disegnare dopo ogni spostamento
      language: "it",
    };
    try {
      glBase = new mapboxgl.Map(options);
    } catch {
      container.remove();
      return;
    }
    map.getContainer().classList.add("wm-native");
    map.attributionControl.addAttribution(MAPBOX_ATTR);
    connectMapbox(glBase);
    map.zoomControl.remove();
    glBase.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    container
      .querySelector(".mapboxgl-ctrl-bottom-left")
      .classList.add("wm-mapbox-logo");
    const controls = container.querySelector(".mapboxgl-control-container");
    controls.classList.add("wm-mapbox-controls");
    map.getContainer().after(controls);
    glBase.__style = MAPBOX_STYLES[state.base] || MAPBOX_STYLES.topo;
    glBase.on("style.load", () => {
      const m = glBase;
      glStyleReady = true;
      italianLabels(m);
      hideTransportLabels(m);
      meteoPalette(m);
      strongRelief(m);
      m.__synHidden = null; // stile nuovo: nessuno strato nascosto dalla carta sinottica
      glSynopticBase();
      for (const [id, c] of glImgs) if (c.url) glApply(m, id, c); // lo stile nuovo non ha i nostri strati
    });
    for (const layer of Object.values(bases)) map.removeLayer(layer);
  }
  // sfondo: dalla sezione "Impostazioni" del pannello (niente selettore livelli di Leaflet)
  const BASE_NAMES = { osm: "Base", topo: "Outdoors" }; // effetto "carta meteo": opacità al massimo e confini
  // confini sopra i colori (Impostazioni), a livelli: ogni scelta comprende le precedenti
  const BORDER_NAMES = {
    none: "Nessuno",
    countries: "Stati",
    regions: "Regioni",
    provinces: "Province",
  };
  function setBorders(name, save = true) {
    state.borders = BORDER_NAMES[name] ? name : "none";
    if (typeof styleBorders === "function") styleBorders();
    if (save) saveSettings();
    ui.borders.replaceChildren(
      ...Object.entries(BORDER_NAMES).map(([k, text]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.setAttribute("aria-pressed", String(k === state.borders));
        b.addEventListener("click", () => setBorders(k));
        return b;
      }),
    );
  }
  function setBase(name, save = true) {
    state.base = bases[name] ? name : "topo"; // anche il vecchio "Essenziale" salvato nel browser
    if (glBase) {
      const m = glBase,
        style = MAPBOX_STYLES[state.base];
      if (m && m.__style !== style) {
        if (m.__style) {
          glStyleReady = false;
          m.setStyle(style, { diff: false });
        }
        m.__style = style;
      }
    } else
      for (const [k, layer] of Object.entries(bases)) {
        if (k === state.base) layer.addTo(map);
        else map.removeLayer(layer);
      }
    if (save) saveSettings(); // all'avvio no: un link con l'opacità nell'URL non cambia quelle salvate
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
  // dei dati dei modelli, in index.html); Leaflet continua ad aggiornarla da solo.
  ui.attrib.appendChild(map.attributionControl.getContainer());

  // su mobile badge e legenda diventano un solo riquadro in basso: la legenda entra nel badge
  // versione mobile: telefoni e tablet in verticale (stessa regola nei @media di style.css)
  const mobileMq = window.matchMedia(
    "(max-width: 600px), (orientation: portrait) and (pointer: coarse) and (max-width: 1100px)",
  );
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
    const day = d.toLocaleDateString("it-IT", {
      timeZone: "UTC",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });
    return `${day} ${rid.slice(8, 10)}Z`;
  };
  const cycle = (rid) => `${rid.slice(8, 10)}Z`;
  const fmtRunDay = (rid) =>
    runDate(rid).toLocaleDateString("it-IT", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  const fmtAge = (rid) => {
    const h = Math.max(
      0,
      Math.round((Date.now() - runDate(rid).getTime()) / 3600e3),
    );
    return h < 48 ? `${h}h fa` : `${Math.round(h / 24)} giorni fa`;
  };
  const shortLabel = (id) =>
    (meta.models.find((m) => m.id === id)?.label || id).split(" ")[0];
  const modelLabel = () =>
    meta.models.find((m) => m.id === state.model)?.label || state.model;
  const runDate = (rid) =>
    new Date(
      Date.UTC(
        +rid.slice(0, 4),
        +rid.slice(4, 6) - 1,
        +rid.slice(6, 8),
        +rid.slice(8, 10),
      ),
    );
  const fmtLocal = (d) =>
    d.toLocaleString("it-IT", {
      timeZone: "Europe/Rome",
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const fmtUTC = (d) =>
    d.toLocaleString("it-IT", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
    });
  const fmtDay = (d, month = true) =>
    d.toLocaleDateString("it-IT", {
      timeZone: "Europe/Rome",
      weekday: "short",
      day: "2-digit",
      ...(month ? { month: "short" } : {}),
    });
  const fmtHour = (d) =>
    d.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
  /** Intervallo fra due istanti, con il giorno scritto una volta sola se è lo stesso:
   *  "ven 13 nov, 06:00 → 18:00" oppure "gio 12, 18:00 → ven 13 nov, 06:00" (il mese all'inizio solo se cambia). */
  function fmtSpan(a, b, { month = true } = {}) {
    if (fmtDay(a) === fmtDay(b))
      return `${fmtDay(b, month)}, ${fmtHour(a)} → ${fmtHour(b)}`;
    const startMonth = month && fmtDay(a).split(" ").pop() !== fmtDay(b).split(" ").pop();
    return `${fmtDay(a, startMonth)}, ${fmtHour(a)} → ${fmtDay(b, month)}, ${fmtHour(b)}`;
  }
  const stepDate = (step) => new Date(runDate(state.run).getTime() + step * 3600e3);
  // inizio dell'accumulo mostrato, solo per gli intervalli scelti (non per il totale dalla corsa)
  // inizio della cumulata (anche il totale dall'inizio della corsa): così si leggono sempre inizio e fine
  const intervalStartDate = (s = state.step) =>
    state.run && rangeMode() && intervalPrev(s) < s ? stepDate(intervalPrev(s)) : null;
  // istante mostrato, o l'intervallo se ne è scelto uno: per pannello, popup e immagine condivisa
  const fmtShown = (s = state.step, opts) => {
    const start = intervalStartDate(s);
    return start ? fmtSpan(start, stepDate(s), opts) : fmtLocal(stepDate(s));
  };
  const hexToRgb = (h) =>[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const variable = () => meta.variables.find((v) => v.id === state.var);
  const rangeMode = () =>
    variable()?.modes.includes("total") &&
    variable()?.modes.includes("interval") &&
    (state.mode === "total" || state.mode === "interval");
  // grandezza dei dati (colori, località, passi): per le voci combinate è quella dei colori (es. "tp")
  const dataVar = () => variable()?.field || variable()?.vector?.u || state.var;
  // carta sinottica (geopotenziale e pressione): area propria, niente località, grafici, radar e satellite
  const synoptic = () => !!(meta && variable()?.area);
  const areaNow = () => variable()?.area || meta.bbox;
  // nome per legenda e testi: per le combinate quello della grandezza dei colori ("Precipitazione")
  const baseLabel = () => variable().base_label || variable().label;
  // cumulate: differenza fra il totale ai due estremi scelti. I vecchi link con `ore` inizializzano ancora i preset.
  const INTERVALS = [3, 6, 12, 24];
  const intervalSteps = () => {
    const values = steps();
    return values[0] === 0 ? values : [0, ...values];
  };
  /** Passo più vicino a `s - hours`; oltre +144h i passi sono ogni 6 ore, quindi un preset 3h diventa 6h. */
  function presetPrev(s = state.step, hours = state.hours) {
    const target = s - hours;
    if (target <= 0) return 0;
    let best = 0;
    for (const x of meta.steps) if (x <= target && x > best) best = x;
    return best;
  }
  /** Inizio della cumulata mostrata all'ora `s`: l'inizio del range (Totale) o le ultime ore scelte, mai prima del
   *  range. Tutto il resto (dati, legenda, grafici) legge da qui. */
  function intervalPrev(s = state.step, hours = state.hours) {
    if (state.cum === "hours") return presetPrev(s, hours); // le ultime ore, ovunque nella corsa
    return state.rangeFrom ?? 0;
  }
  // cumulate: con Totale lo slider a due maniglie sceglie il periodo; con le ore fisse una maniglia sola che scatta
  // di `hours` ore lungo tutta la corsa (il periodo resta memorizzato per quando si torna al Totale)
  const presetMode = () => rangeMode() && state.cum === "hours";
  const dualMode = () => rangeMode() && state.cum !== "hours";
  /** Ore su cui si muovono slider a una maniglia, frecce e play: con le ore fisse una ogni `hours` ore della corsa. */
  function slideSteps() {
    if (!presetMode()) return steps();
    const avail = [...availableSteps()];
    return rangeFrames(0, avail.length ? Math.max(...avail) : steps().at(-1));
  }
  /** Modo dei dati dalla scelta: "total" se la cumulata parte dall'inizio della corsa, altrimenti "interval". */
  function syncMode() {
    if (!rangeMode()) return;
    state.mode = intervalPrev() === 0 ? "total" : "interval";
  }
  /** Ore fra `from` e `to`: ogni passo con Totale (il play dentro il periodo); con le ore fisse una ogni `hours` ore
   *  (le ultime `hours` ore ciascuna). */
  function rangeFrames(from = state.rangeFrom ?? 0, to = state.rangeTo ?? state.step) {
    const avail = availableSteps();
    const inside = steps().filter((x) => x > from && x <= to && avail.has(x));
    if (state.cum !== "hours") return inside;
    const frames = [];
    for (let target = from + state.hours; target <= to; target += state.hours) {
      const x = [...inside].reverse().find((y) => y <= target); // passo più vicino (oltre +144h ogni 6 ore)
      if (x != null && x !== frames.at(-1)) frames.push(x);
    }
    return frames.length ? frames : inside.slice(-1);
  }
  // durata effettiva della cumulata al passo mostrato: sempre scritta, mai "intervallo" e basta
  const intervalHours = (s = state.step) => s - intervalPrev(s);

  function stopProgressAnimation() {
    for (const slider of intervalSliders) {
      const animation = slider.progressAnimation;
      if (!animation) continue;
      if (playbackSelection) {
        const duration = animation.effect.getTiming().duration;
        playbackSelection.progress = Math.min(1, animation.currentTime / duration);
      }
      if (slider.element.clientWidth > 0 && !slider.progress.hidden) animation.commitStyles();
      animation.cancel();
      slider.progressAnimation = null;
    }
  }

  function syncIntervalSliders() {
    if (!meta || state.step == null) return;
    if (
      playbackSelection &&
      (!rangeMode() ||
        playbackSelection.step !== state.step ||
        playbackSelection.from !== state.rangeFrom ||
        playbackSelection.model !== state.model ||
        playbackSelection.variable !== state.var ||
        playbackSelection.run !== state.run)
    ) {
      stopProgressAnimation();
      playbackSelection = null;
    }
    const values = intervalSteps();
    // lo slider mostra il range (fisso), non la cumulata dell'ora mostrata
    const from = Math.max(0, values.indexOf(playbackSelection?.from ?? state.rangeFrom ?? intervalPrev()));
    const to = Math.max(from + 1, values.indexOf(playbackSelection?.to ?? state.rangeTo ?? state.step));
    const position = (step) => {
      const fraction = values.indexOf(step) / (values.length - 1);
      return `calc(${fraction * 100}% + var(--interval-thumb-size) * ${0.5 - fraction})`;
    };
    for (const slider of intervalSliders) {
      slider.max(values.length - 1);
      slider.value([from, to]);
      const thumbs = slider.element.querySelectorAll('[role="slider"]');
      slider.element.classList.toggle(
        "playback-complete",
        !!playbackSelection && state.step === playbackSelection.to,
      );
      slider.progress.hidden = !playbackSelection;
      if (playbackSelection) {
        const thumbSize = thumbs[0].offsetWidth;
        const span = (to - from) / (values.length - 1) * (slider.element.clientWidth - thumbSize);
        const crowded = span < thumbSize + 8;
        const start = crowded
          ? position(values[from])
          : `calc(${position(values[from])} + var(--interval-thumb-size) / 2 + 3px)`;
        const end = crowded
          ? position(values[to])
          : `calc(${position(values[to])} - var(--interval-thumb-size) / 2 - 3px)`;
        slider.progressBounds = [start, end];
        if (!slider.progressAnimation) {
          const progress = playbackSelection.progress ?? 0;
          slider.progress.style.left = `calc(${start} * ${1 - progress} + ${end} * ${progress})`;
        }
        slider.progress.style.top = crowded
          ? "calc(50% - var(--interval-thumb-size) / 2 - 12px)"
          : "50%";
        slider.progress.setAttribute("aria-valuemin", playbackSelection.from);
        slider.progress.setAttribute("aria-valuemax", playbackSelection.to);
        slider.progress.setAttribute("aria-valuenow", state.step);
        slider.progress.setAttribute("aria-valuetext", `+${state.step}h`);
      }
      for (const [thumb, step] of [
        [thumbs[0], values[from]],
        [thumbs[1], values[to]],
      ]) {
        const date = state.run
          ? `, ${fmtLocal(new Date(runDate(state.run).getTime() + step * 3600e3))}`
          : "";
        thumb.setAttribute("aria-valuetext", `+${step}h${date}`);
      }
    }
  }
  // "in 3h" / "totale" / "" (grandezze istantanee), dopo il nome della grandezza
  const modePhrase = () =>
    state.mode === "interval"
      ? `in ${intervalHours()}h`
      : state.mode === "total"
        ? "totale"
        : "";
  // voci combinate: cosa sono le linee ("· linee zero termico ogni 250 m"), in legenda e nell'immagine condivisa
  const lcFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1); // "Vento 700 hPa" → "vento 700 hPa"
  const isoNote = () => {
    if (variable().arrows)
      return ` · frecce ${lcFirst(variable().arrows.label)}`;
    const c = variable().contour_field && variable().contours;
    if (!c || !state.iso) return "";
    return weightedContour()
      ? ` · linee ${contourName().toLowerCase()}`
      : ` · linee ${c.label.toLowerCase()} ogni ${c.step} ${c.units}`;
  };
  // con le cumulate le linee non sono dell'istante finale ma la media del periodo pesata con la precipitazione
  const weightedContour = () =>
    !!variable()?.contour_field && state.mode === "interval";
  // nome del valore delle linee per legenda, riquadro e tooltip: con le cumulate "Zero termico in 24h", come
  // "Precipitazione in 24h" (è la media del periodo pesata con la pioggia, vedi contourFieldAt)
  const contourName = () =>
    `${variable().contours.label}${weightedContour() ? ` in ${intervalHours()}h` : ""}`;
  // passi del modello scelto: lo slider si ferma all'orizzonte del modello (es. ICON-CH2 a +120h)
  const steps = () => {
    const max =
      meta.models.find((m) => m.id === state.model)?.max_step ?? Infinity;
    return meta.steps.filter((s) => s <= max);
  };
  function rangePlaybackSteps(allSteps, available, from, to) {
    return allSteps.filter(
      (step) => step > from && step <= to && available.has(step),
    );
  }
  const runInfo = () =>
    (runs[state.model] || []).find((r) => r.run === state.run);
  const availableSteps = () =>
    new Set(runInfo()?.variables[dataVar()]?.steps || []);

  /** Avviso al centro della mappa (null = nascosto). */
  function showNoData(title, text = "") {
    ui.nodata.hidden = !title;
    if (title) {
      ui.nodataTitle.textContent = title;
      ui.nodataText.textContent = text;
    }
    map.getContainer().classList.toggle("map-nodata", !!title); // senza dati la mappa resta in grigio
    document.body.classList.toggle("no-data", !!title); // e sopra c'è solo il menu principale (vedi style.css)
    if (title) {
      ui.probe.hidden = true;
      probeLL = null;
    }
    // pannello chiuso (su mobile succede spesso): si riapre, altrimenti resterebbe solo una mappa grigia muta
    if (title && ui.panel.classList.contains("collapsed")) ui.collapse.click();
  }

  function setStatus(text, warn = false) {
    ui.status.textContent = text || "";
    ui.status.classList.toggle("warn", !!warn);
  }

  // ---------- impostazioni (sfondo, opacità, celle nette, isolinee) salvate nel browser; un link con i parametri
  // nell'URL vince su quelle salvate (readHash viene dopo)
  const SETTINGS_KEY = "weathermaps.settings.v1";
  // versione delle impostazioni salvate: con la 2 (sfondi Mapbox) cambiano i predefiniti di colori e confini, e chi
  // aveva salvato quelli vecchi (confini spenti) riparte una volta dai nuovi; il resto delle scelte resta
  const SETTINGS_VERSION = 2;
  function loadSettings() {
    try {
      const d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (!d || typeof d !== "object") return;
      const current = d.v >= SETTINGS_VERSION;
      if (typeof d.model === "string") state.model = d.model;
      if (typeof d.var === "string") state.var = d.var;
      if (Number.isFinite(d.step)) state.step = d.step;
      if (typeof d.mode === "string") state.mode = d.mode;
      if (INTERVALS.includes(d.hours)) state.hours = d.hours;
      if (typeof d.base === "string") state.base = d.base;
      if (current && Number.isFinite(d.opacity))
        state.opacity = Math.min(1, Math.max(0.1, d.opacity));
      if (typeof d.crisp === "boolean") state.crisp = d.crisp;
      if (typeof d.iso === "boolean") state.iso = d.iso;
      if (current && BORDER_NAMES[d.borders]) state.borders = d.borders;
      if (d.extra === "radar" || d.extra === "sat" || d.extra === "snd") state.extra = d.extra;
      else if (d.radar === true) state.extra = "radar"; // impostazione salvata dalla prima versione del radar
      if (current && Number.isFinite(d.bordersOpacity))
        state.bordersOpacity = Math.min(1, Math.max(0.1, d.bordersOpacity));
    } catch {
      /* storage non disponibile o dato rovinato: valori predefiniti */
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          v: SETTINGS_VERSION,
          model: state.model,
          var: state.var,
          step: state.step,
          mode: state.mode,
          hours: state.hours,
          base: state.base,
          opacity: state.opacity,
          crisp: state.crisp,
          iso: state.iso,
          borders: state.borders,
          bordersOpacity: state.bordersOpacity,
          extra: state.extra,
        }),
      );
    } catch {
      /* storage non disponibile */
    }
  }

  // ---------- stato nell'URL
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const k of ["model", "var", "mode"]) if (p.get(k)) state[k] = p.get(k);
    // cumulate: range (from, to) e tipo (ore = 3/6/12/24, senza = Totale). I link vecchi (from + step, senza to)
    // diventano un range col Totale; "ore" da solo (link ancora più vecchi) è il pulsante delle ore su tutta la corsa
    const ore = +p.get("ore");
    state.cum = INTERVALS.includes(ore) ? "hours" : "total";
    if (state.cum === "hours") state.hours = ore;
    if (p.has("to") && Number.isFinite(+p.get("to"))) {
      state.rangeFrom = Number.isFinite(+p.get("from")) ? +p.get("from") : 0;
      state.rangeTo = +p.get("to");
    } else if (p.has("from") && Number.isFinite(+p.get("from")) && p.get("step")) {
      state.rangeFrom = +p.get("from");
      state.rangeTo = +p.get("step");
      state.cum = "total";
    }
    // i parametri "corsa"/"run" dei link vecchi si ignorano: si mostra sempre l'ultima corsa completa
    if (p.get("step")) state.step = +p.get("step");
    if (p.get("opacity"))
      state.opacity = Math.min(1, Math.max(0.1, +p.get("opacity")));
    if (p.get("crisp")) state.crisp = p.get("crisp") === "1";
    if (p.get("iso")) state.iso = p.get("iso") !== "0";
  }
  // Safari permette al massimo 100 replaceState ogni 30 secondi, poi dà errore: scorrendo lo slider avanti e indietro
  // l'aggiornamento della mappa si fermava lì (sembrava bloccata). L'indirizzo si scrive quindi poco dopo l'ultima
  // modifica (una volta sola per una serie di spostamenti) e un eventuale errore non ferma nulla.
  function replaceHash(hash) {
    try {
      history.replaceState(history.state, "", hash);
    } catch {
      /* limite del browser: l'indirizzo si aggiorna alla prossima modifica */
    }
  }
  let hashTimer = null;
  // uscendo dalla pagina (ricarica, chiusura) l'indirizzo in attesa si scrive subito
  window.addEventListener("pagehide", () => {
    if (hashTimer) writeHashNow();
  });
  function writeHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHashNow, 300);
  }
  function writeHashNow() {
    hashTimer = null;
    const p = new URLSearchParams();
    const previous = new URLSearchParams(location.hash.slice(1));
    for (const key of [
      "chart",
      "place",
      "chartModel",
      "chartRun",
      "chartStep",
      "chartFrom",
      "chartEns",
      "chartMulti",
      "chartSnd",
    ])
      if (previous.has(key)) p.set(key, previous.get(key));
    for (const k of ["model", "var", "step", "mode", "opacity"])
      if (state[k] != null) p.set(k, state[k]);
    if (rangeMode() && state.rangeTo != null) {
      p.set("from", state.rangeFrom ?? 0);
      p.set("to", state.rangeTo);
      if (state.cum === "hours") p.set("ore", state.hours);
    }
    if (state.crisp) p.set("crisp", "1");
    if (!state.iso) p.set("iso", "0");
    replaceHash("#" + p.toString());
  }

  // ---------- popolamento controlli
  // bandiere: libreria flag-icons (tutte in formato 4:3, stessa larghezza); per la mediana un'icona Lucide "layers" (ISC)
  const LAYERS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>';
  const modelIcon = (m) =>
    m.country
      ? `<span class="fi fi-${m.country}"></span>`
      : m.id === "mean"
        ? LAYERS_ICON
        : "";

  /** Select dei modelli: bandiera + nome. Il <button><selectedcontent> iniziale resta al suo posto. */
  function fillModelSelect(models, value, select = ui.model) {
    for (const o of [...select.querySelectorAll("option")]) o.remove();
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m.id;
      const kind = m.country ? "flag" : "glyph";
      o.innerHTML = `<span class="opt-icon ${kind}" aria-hidden="true">${modelIcon(m)}</span><span class="opt-label"></span>`;
      o.querySelector(".opt-label").textContent = m.label;
      o.selected = m.id === value;
      select.append(o);
    }
    select.value = value;
  }

  function fillSelect(sel, items, value) {
    sel.replaceChildren(
      ...items.map(([v, label]) => new Option(label, v, false, v === value)),
    );
  }

  // tutti i modelli, sempre: cambiando grandezza il modello non cambia da solo; se non la fornisce lo dice l'avviso
  // al centro della mappa (vedi update)
  function setupModels() {
    const models = meta.models;
    if (!models.find((m) => m.id === state.model))
      state.model = (
        models.find((m) => variable().models.includes(m.id)) || models[0]
      ).id;
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
    if (
      !ui.modelInfo.hidden &&
      !e.target.closest("#model-info, #model-info-btn")
    )
      setModelInfoOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setModelInfoOpen(false);
  });

  function setupVars() {
    if (!meta.variables.find((v) => v.id === state.var))
      state.var = meta.variables[0].id;
    fillSelect(
      ui.varSel,
      meta.variables.map((v) => [v.id, v.menu_label || v.label]), // nome breve, sta su una riga
      state.var,
    );
    ui.varRow.hidden = meta.variables.length < 2;
  }

  function setupModes() {
    const v = variable();
    if (!v.modes.includes(state.mode)) state.mode = v.modes[0];
    // grandezze accumulate: Totale · 3h · 6h · 12h · 24h; il doppio slider consente ogni altro intervallo.
    const opts = v.modes.flatMap((m) =>
      m === "interval"
        ? INTERVALS.map((h) => [m, h, `${h}h`])
        : [[m, null, { total: "Totale", value: "Valore" }[m] || m]],
    );
    ui.mode.replaceChildren(
      ...opts.map(([m, h, text]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.dataset.mode = m;
        if (h) b.dataset.hours = h;
        if (h)
          b.title = `Le ${h} ore che finiscono all'ora mostrata (il play va avanti di ${h} ore)`;
        else if (m === "total") b.title = "Cumulata dall'inizio dell'intervallo";
        b.setAttribute("aria-pressed", String(modePressed(m, h)));
        b.addEventListener("click", () => {
          if (rangeMode()) {
            // il range resta quello scelto: cambia solo il tipo di cumulata; si mostra la fine del range
            togglePlay(false);
            state.cum = h ? "hours" : "total";
            if (h) {
              // ore fisse: si riparte sempre dal primo intervallo della corsa (il periodo del Totale resta memorizzato)
              state.hours = h;
              state.step = slideSteps()[0] ?? state.step;
            } else state.step = state.rangeTo ?? state.step;
          } else state.mode = m;
          setupModes();
          setupSteps();
          update();
        });
        return b;
      }),
    );
    ui.modeRow.hidden = v.modes.length < 2;
    // slider a due maniglie solo col Totale; con le ore fisse quello a una maniglia (vedi slideSteps)
    document.body.classList.toggle("range-mode", dualMode());
    updateModeSelection();
  }

  // pulsante acceso: con le cumulate il tipo scelto (Totale o le ore), altrimenti il modo
  function modePressed(m, h) {
    if (!rangeMode()) return m === state.mode;
    return h ? state.cum === "hours" && h === state.hours : state.cum !== "hours";
  }
  function updateModeSelection() {
    for (const button of ui.mode.querySelectorAll("button")) {
      const hours = button.dataset.hours ? +button.dataset.hours : null;
      button.setAttribute("aria-pressed", String(modePressed(button.dataset.mode, hours)));
    }
  }

  /** Corsa da mostrare: l'ultima completa (le corse ancora in arrivo non si mostrano). */
  function runList() {
    return (runs[state.model] || []).filter(
      (r) => !r.incoming && r.variables[dataVar()],
    );
  }
  /** Corsa più nuova ancora in arrivo, solo per l'avviso. */
  const incomingRun = () =>
    (runs[state.model] || []).find((r) => r.incoming && r.variables[dataVar()]);

  /** Ritorna true se la corsa mostrata è cambiata. */
  function setupRuns() {
    const before = state.run;
    const r = runList()[0];
    state.run = r ? r.run : null;
    if (!r) {
      // grandezza che il modello non ha: lo dice già l'avviso, qui nessuna corsa da indicare
      ui.run.textContent = variable()?.models.includes(state.model) ? "nessuna corsa disponibile" : "—";
      ui.run.title = "";
      ui.runAge.textContent = "";
    } else {
      ui.run.innerHTML = `<strong>${cycle(r.run)}</strong> ${fmtRunDay(r.run)}`;
      ui.run.title = `Corsa delle ${cycle(r.run)} del ${fmtRunDay(r.run)}: l'ultima completa`;
      const sel = r.variables[dataVar()];
      // testo corto: la riga "Corsa" sta su una sola riga anche nel pannello stretto; quello lungo nel tooltip
      const n = sel?.members ? Object.keys(sel.members).length : 0;
      ui.runAge.textContent =
        state.model === "mean" && n ? `${n} modelli` : fmtAge(r.run);
      ui.runAge.title =
        state.model === "mean" && n
          ? `Mediana di ${n} modelli`
          : `Emessa ${fmtAge(r.run)}`;
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
    if (info)
      ui.runLiveText.textContent = `${cycle(incoming.run)} in arrivo · ${info.steps.length}/${info.expected ?? steps().length} passi`;
    else if (state.run)
      ui.runLiveText.textContent = `Corsa ${cycle(state.run)} aggiornata`;
  }

  /** Corsa mostrata e passi scaricati (anche della corsa in arrivo), su tutte le grandezze. */
  function latestSnapshot(model) {
    const list = runs[model] || [];
    const n = list.reduce(
      (a, r) =>
        a + Object.values(r.variables).reduce((b, v) => b + v.steps.length, 0),
      0,
    );
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
        const at = publishedAt
          ? new Date(publishedAt).toLocaleTimeString("it-IT", {
              timeZone: "Europe/Rome",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "?";
        if (after.run && after.run !== before.run)
          note = `Nuova corsa ${cycle(after.run)} disponibile`;
        else if (after.n > before.n) note = `${after.n - before.n} nuovi passi`;
        else
          note = `Nessun passo nuovo · dati pubblicati alle ${at}, aggiornati ogni ora`;
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
      const res = await fetch(
        `api/refresh?model=${encodeURIComponent(model)}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(res.statusText);
      const started = await res.json();
      const t0 = Date.now();
      // segue l'aggiornamento sul server e mostra i passi man mano che arrivano
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const st = await fetch(
          `api/refresh?model=${encodeURIComponent(model)}`,
          { cache: "no-store" },
        ).then((r) => r.json());
        await refreshRuns();
        if (state.model === model) {
          const changed = setupRuns();
          if (changed) setupSteps();
          if (changed || !current) update();
        }
        const now = latestSnapshot(model);
        const added = now.run === before.run ? now.n - before.n : now.n;
        if (st.running)
          ui.refresh.textContent =
            added > 0 ? `Scarico… +${added}` : "Controllo…";
        if (!st.running || Date.now() - t0 > 5 * 60e3) break;
      }
      const after = latestSnapshot(model);
      if (after.run && after.run !== before.run)
        note = `Nuova corsa ${cycle(after.run)} disponibile`;
      else if (after.n > before.n)
        note = `${after.n - before.n} nuovi passi scaricati`;
      else if (started.reason === "cooldown" && started.finished) {
        const ago = Math.round(Date.now() / 1000 - started.finished);
        note = `Nessun passo nuovo (ultimo controllo ${ago}s fa, riprova fra ${Math.max(1, started.cooldown_s - ago)}s)`;
      } else note = "Nessun passo nuovo per ora";
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
      state.step = avail.includes(24) ? 24 : (avail[0] ?? s[0]);
    }
    if (rangeMode()) {
      // range: all'apertura (o se non vale più, es. orizzonte diverso) tutta la corsa disponibile
      const interval = intervalSteps();
      const avail = [...availableSteps()];
      const last = avail.length ? Math.max(...avail) : s[s.length - 1];
      let fresh = false;
      if (!s.includes(state.rangeTo) || state.rangeTo > last) {
        state.rangeTo = last;
        fresh = true;
      }
      if (!interval.includes(state.rangeFrom) || state.rangeFrom >= state.rangeTo) state.rangeFrom = 0;
      if (presetMode()) {
        // ore fisse: l'ora mostrata deve essere uno degli scatti della maniglia
        const frames = slideSteps();
        if (!frames.includes(state.step))
          state.step = [...frames].reverse().find((x) => x <= state.step) ?? frames[0] ?? state.step;
      } else if (fresh || !(state.step > state.rangeFrom && state.step <= state.rangeTo)) state.step = state.rangeTo;
      syncMode();
    }
    ui.step.max = slideSteps().length - 1;
    ui.step.value = slideSteps().indexOf(state.step);
    syncIntervalSliders();
    updateModeSelection();
  }

  function renderLegend() {
    if (state.extra === "sat") {
      // satellite: scala di grigi delle nubi (infrarosso), dalle più sottili alle più alte
      ui.legend.innerHTML =
        `<h2><span class="lg-label">Nubi da satellite </span>(infrarosso)</h2><ol class="lg-continuous">` +
        `<li><i style="background:linear-gradient(to right, ${SAT_SHADES[0]}, ${SAT_SHADES[1]})"></i><span class="lg-tick">basse</span></li>` +
        `<li><i style="background:linear-gradient(to right, ${SAT_SHADES[1]}, ${SAT_SHADES[2]})"></i><span class="lg-tick"></span><span class="lg-tick lg-tick-end">alte</span></li></ol>`;
      return;
    }
    if (state.extra === "radar") {
      // radar acceso: la sua legenda (classi del servizio, mm/h) al posto di quella del modello
      ui.legend.innerHTML =
        `<h2><span class="lg-label">Radar, intensità </span>(mm/h)</h2><ol>` +
        RADAR_CLASSES.map(([t, c], i) => {
          const next = RADAR_CLASSES[i + 1]?.[0];
          return `<li><i style="background:${c}"></i><span class="lg-text">${next == null ? `> ${t}` : `${t} … ${next}`}</span><span class="lg-tick">${i === 0 ? 0 : t}</span></li>`;
        }).join("") +
        "</ol>";
      return;
    }
    const v = variable();
    const { thresholds, colors } = v.scale;
    const modeLabel = modePhrase();
    const num = (x) => String(x).replace("-", "−");
    const openLow = v.scale.transparent_below == null; // la prima classe include anche i valori più bassi
    // con molte soglie (T850 ogni 2 °C) se ne scrive una su due, per non affollare la barra; meno ancora se le
    // etichette sono lunghe (geopotenziale: 31 soglie di tre cifre)
    let every = thresholds.length > 14 ? 2 : 1;
    const chars = (k) =>
      thresholds.reduce((a, t, i) => a + (i % k ? 0 : num(t).length + 1), 0);
    while (chars(every) > 50) every *= 2;
    if (v.scale.continuous) {
      // barra sfumata: un tratto per ogni coppia di punti di colore, soglie sui bordi (l'ultima a destra)
      const n = thresholds.length;
      const segs = thresholds.slice(0, -1).map((t, i) => {
        const tick = i % every ? "" : num(t);
        const end =
          i === n - 2
            ? `<span class="lg-tick lg-tick-end">${(n - 1) % every ? "" : num(thresholds[n - 1])}</span>`
            : "";
        return `<li><i style="background:linear-gradient(to right, ${colors[i]}, ${colors[i + 1]})"></i><span class="lg-tick">${tick}</span>${end}</li>`;
      });
      ui.legend.innerHTML = `<h2><span class="lg-label">${baseLabel()} ${modeLabel} </span>(${v.units})${isoNote()}</h2><ol class="lg-continuous">${segs.join("")}</ol>`;
      return;
    }
    const items = thresholds.map((t, i) => {
      const next = thresholds[i + 1];
      const text =
        next == null
          ? `> ${num(t)}`
          : i === 0 && openLow
            ? `< ${num(next)}`
            : `${num(t)} … ${num(next)}`;
      // tick: soglia inferiore della classe, mostrata solo nella barra compatta su mobile
      // la prima classe della pioggia (da 0.1 mm) si legge "da 0": il primo numero sta sul bordo sinistro della barra
      const tick =
        (i === 0 && openLow) || i % every
          ? ""
          : i === 0 && t === 0.1
            ? "0"
            : num(t);
      return `<li><i style="background:${colors[i]}"></i><span class="lg-text">${text}</span><span class="lg-tick">${tick}</span></li>`;
    });
    ui.legend.innerHTML = `<h2><span class="lg-label">${baseLabel()} ${modeLabel} </span>(${v.units})${isoNote()}</h2><ol>${items.join("")}</ol>`;
  }

  // ---------- dati
  const ctxNow = () => ({ model: state.model, var: dataVar(), run: state.run });

  function fieldUrl(step, mode, ctx, prev) {
    if (STATIC)
      return `data/field/${ctx.model}/${ctx.var}/${ctx.run}/${step}.bin`;
    const p = new URLSearchParams({ ...ctx, step, mode });
    if (mode === "interval") p.set("prev", prev);
    return `api/field?${p}`;
  }

  // richieste dei campi in corso: muovendo in fretta lo slider se ne accumulano decine (il browser ne fa 6 alla volta
  // per sito) e il passo che serve resta in coda dietro a quelli già superati: quelle vecchie si annullano
  const inflight = new Map(); // url -> { ctrl, gen }
  let fetchGen = 0;
  function dropStaleFetches() {
    fetchGen++;
    if (inflight.size <= 5) return; // poche: lasciarle finire (sono i passi vicini, serviranno)
    for (const [url, x] of inflight)
      if (x.gen < fetchGen - 1) {
        x.ctrl.abort();
        cache.delete(url);
      }
  }

  async function getField(
    step,
    mode = state.mode,
    ctx = ctxNow(),
    prev = mode === "interval" ? intervalPrev(step) : null,
  ) {
    // statico: c'è solo il totale; la cumulata è la differenza fra due totali (come fa il server)
    if (STATIC && mode === "interval")
      return getIntervalStatic(step, ctx, prev);
    // statico: i campi dei dettagli (es. z850) stanno nel file della grandezza a cui appartengono (t850)
    if (STATIC) {
      const owner = meta.variables.find((x) =>
        x.details?.some((d) => d.var === ctx.var),
      );
      if (owner) {
        return getField(step, "value", { ...ctx, var: owner.id }).then(
          (f) =>
            f.extra?.[ctx.var] ??
            Promise.reject(new Error(`${ctx.var} non disponibile`)),
        );
      }
    }
    const url = fieldUrl(step, mode, ctx, prev);
    if (!cache.has(url)) {
      const ctrl = new AbortController();
      const mine = { ctrl, gen: fetchGen };
      inflight.set(url, mine);
      const pr = fetch(url, { signal: ctrl.signal })
        .finally(() => {
          if (inflight.get(url) === mine) inflight.delete(url);
        })
        .then(async (r) => {
          if (!r.ok)
            throw Object.assign(
              new Error(
                (await r.json().catch(() => ({}))).detail || r.statusText,
              ),
              { status: r.status },
            );
          return STATIC ? unpackField(await r.arrayBuffer()) : r.json();
        });
      cache.set(url, pr);
      pr.catch(() => cache.delete(url));
    }
    return cache.get(url);
  }

  /** Sito statico: campo in formato compatto (vedi app/packed.py). Intestazione JSON con le liste di valori sostituite
   *  da {"$q": [inizio, quanti, scala]}, poi i valori in interi a 16 bit (-32768 = mancante). Torna lo stesso oggetto
   *  di /api/field. */
  function unpackField(buf) {
    const n = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buf, 4, n)),
    );
    const base = 4 + n + ((4 + n) % 2);
    const ints = new Int16Array(buf, base, (buf.byteLength - base) >> 1);
    const walk = (x) => {
      if (Array.isArray(x)) return x.map(walk);
      if (!x || typeof x !== "object") return x;
      const q = x.$q || x.$z;
      if (q) {
        const [start, len, scale] = q,
          out = new Array(len),
          f32 = new Float32Array(len);
        let src = ints,
          off = start;
        if (x.$z) {
          // differenze fra celle vicine, a zig-zag, byte bassi e alti separati (si comprime meglio in rete)
          const lo = new Uint8Array(buf, base + 2 * start, len),
            hi = new Uint8Array(buf, base + 2 * start + len, len);
          src = new Int16Array(len);
          off = 0;
          let acc = 0;
          for (let k = 0; k < len; k++) {
            const zz = lo[k] | (hi[k] << 8);
            acc = ((acc + ((zz >>> 1) ^ -(zz & 1))) << 16) >> 16; // somma su 16 bit, come nella scrittura
            src[k] = acc;
          }
        }
        for (let k = 0; k < len; k++) {
          const v = src[off + k];
          if (v === -32768) {
            out[k] = null;
            f32[k] = NaN;
          } else {
            out[k] = f32[k] = v / scale;
          }
        }
        F32.set(out, f32); // per il disegno, senza riconvertire
        return out;
      }
      return Object.fromEntries(
        Object.entries(x).map(([k, v]) => [k, walk(v)]),
      );
    };
    return walk(header);
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
        return {
          ...cur,
          mode: "interval",
          prev_step: prevStep,
          values,
          max,
          min,
        };
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
      const ctx = `${state.model}|${state.var}|${state.run}|${state.mode}|${intervalPrev()}`;
      mainField(s[j])
        .then((f) => {
          // anche l'immagine dei colori, se nel frattempo non è cambiata la mappa
          if (
            ctx ===
            `${state.model}|${state.var}|${state.run}|${state.mode}|${intervalPrev()}`
          )
            fieldImage(f, true);
        })
        .catch(() => {});
      if (cv) contourFieldAt(s[j]).catch(() => {});
      if (variable().arrows) arrowsFieldAt(s[j]).catch(() => {});
    }
  }

  /** Voci combinate con le frecce: le due componenti del vento alla stessa ora (stessi file delle voci "Vento"). */
  function arrowsFieldAt(step) {
    const a = variable()?.arrows;
    if (!a) return Promise.resolve(null);
    const ctx = ctxNow();
    const key = `arr|${ctx.model}|${ctx.run}|${a.id}|${step}`;
    if (!cache.has(key)) {
      const parts = STATIC
        ? getField(step, "value", { ...ctx, var: a.id }).then((b) => [
            { ...b, values: b.u },
            { ...b, values: b.v },
          ])
        : Promise.all([
            getField(step, "value", { ...ctx, var: a.u }),
            getField(step, "value", { ...ctx, var: a.v }),
          ]);
      const pr = parts.then(([fu, fv]) => ({
        grid: fu.grid,
        u: fu.values,
        v: fv.values,
      }));
      cache.set(key, pr);
      pr.catch(() => cache.delete(key));
    }
    return cache.get(key);
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
        ? getField(step, "value", { ...ctx, var: state.var }).then((b) => [
            { ...b, values: b.u },
            { ...b, values: b.v },
          ])
        : Promise.all([
            getField(step, "value", { ...ctx, var: vec.u }),
            getField(step, "value", { ...ctx, var: vec.v }),
          ]);
      const pr = parts.then(([fu, fv]) => {
        let max = null,
          min = null;
        const values = fu.values.map((u, k) => {
          const v = fv.values[k];
          if (u == null || v == null) return null;
          const s = Math.round(Math.hypot(u, v));
          if (max == null || s > max) max = s;
          if (min == null || s < min) min = s;
          return s;
        });
        return {
          ...fu,
          var: state.var,
          values,
          u: fu.values,
          v: fv.values,
          max,
          min,
        };
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
    const ix = Math.round((lon - lon0) / dlon),
      iy = Math.round((lat - lat0) / dlat);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return null;
    const u = f.u[iy * nx + ix],
      v = f.v[iy * nx + ix];
    if (u == null || v == null || Math.hypot(u, v) < 1) return null;
    const deg = Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360);
    return { deg, name: DIRS[Math.round(deg / 45) % 8] };
  }

  // ---------- Livelli extra: radar o satellite (uno alla volta), animati sulle ultime immagini. Servizi WMS pubblici
  // chiesti dal browser (CORS aperto, anche nel sito statico); ogni tessera si ripulisce in un canvas (clean) così resta
  // solo il fenomeno sopra la mappa. Con un livello extra acceso spariscono i livelli del modello.
  /* radar: classi nostre (limite inferiore in mm/h e colore), scala classica delle mappe radar italiane. Il servizio
   * colora l'immagine con queste soglie sui valori veri: le riceve come stile (SLD) insieme alla richiesta. */
  const RADAR_CLASSES = [
    [0.2, "#9a8a9b"],
    [1, "#2400ff"],
    [2, "#47904a"],
    [4, "#80ff5a"],
    [6, "#ffff55"],
    [10, "#f2c84c"],
    [20, "#ec8a35"],
    [40, "#e5382b"],
    [60, "#9a25d6"],
  ];
  const radarSld = (layer) =>
    `<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld"><NamedLayer><Name>${layer}</Name>` +
    `<UserStyle><FeatureTypeStyle><Rule><RasterSymbolizer><ColorMap type="intervals">` +
    // "intervals": ogni colore vale fino alla soglia dichiarata; sotto la prima trasparente
    `<ColorMapEntry color="#000000" quantity="${RADAR_CLASSES[0][0]}" opacity="0"/>` +
    RADAR_CLASSES.map(
      ([, c], i) =>
        `<ColorMapEntry color="${c}" quantity="${RADAR_CLASSES[i + 1]?.[0] ?? 1e6}"/>`,
    ).join("") +
    `</ColorMap></RasterSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>`;
  const SAT_SHADES = ["#969ea6", "#cbcfd4", "#ffffff"]; // legenda del satellite: nubi sottili/basse → spesse/alte
  const wmsUrl = (base, params) =>
    `${base}?${new URLSearchParams({ service: "WMS", version: "1.3.0", styles: "", ...params })}`;
  const EXTRAS = {
    // mosaico radar nazionale (Protezione Civile) pubblicato da ItaliaMeteo su MeteoHub: intensità in mm/h ogni 5 minuti
    radar: {
      name: "Radar",
      wms: "https://maps.mistralportal.it/wms",
      layer: "meteohub:radar-sri",
      stepMin: 5,
      frames: 13,
      opacity: 0.9,
      credit: "Radar: Protezione Civile, ItaliaMeteo (MeteoHub)",
      shareTitle: "Radar precipitazioni · Protezione Civile / ItaliaMeteo",
      shareSub: "Intensità (mm/h)",
      // colori dalle nostre classi (RADAR_CLASSES), non quelli del servizio; i valori vengono interpolati (bilineare) prima
      // di essere colorati: contorni morbidi invece dei quadratini da 1 km del dato
      sld: true,
      clean(d) {
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) d[i] = 0;
      }, // bordi sfumati: via
      /** Ultima immagine: si prova all'indietro di 5 in 5 minuti con un'immagine di 1 pixel (per un'ora che non c'è
       *  ancora il servizio risponde con un errore XML invece che con un PNG). */
      async latest() {
        const slot = 5 * 60e3,
          t0 = Math.floor(Date.now() / slot) * slot;
        for (let k = 0; k < 12; k++) {
          const t = new Date(t0 - k * slot).toISOString();
          const r = await fetch(
            wmsUrl(this.wms, {
              request: "GetMap",
              layers: this.layer,
              crs: "EPSG:4326",
              bbox: "45,9,45.01,9.01",
              width: 1,
              height: 1,
              format: "image/png",
              time: t,
            }),
          );
          if (
            r.ok &&
            (r.headers.get("content-type") || "").startsWith("image/")
          )
            return t;
        }
        return null;
      },
    },
    // Meteosat di terza generazione (EUMETSAT): infrarosso 10,5 µm ogni 10 minuti, giorno e notte. Più è chiaro più la
    // nube è fredda (alta o spessa): la luminosità diventa trasparenza, nubi bianche e suolo sereno invisibile
    sat: {
      name: "Satellite",
      wms: "https://view.eumetsat.int/geoserver/wms",
      layer: "mtg_fd:ir105_hrfi",
      stepMin: 10,
      frames: 13,
      opacity: 0.95,
      credit: "Satellite: EUMETSAT (Meteosat)",
      shareTitle: "Nubi da satellite · EUMETSAT Meteosat",
      shareSub: "Infrarosso 10,5 µm",
      clean(d) {
        // grigio dell'infrarosso: suolo e mare sereni ~50-100, nubi ~110-200 (più chiaro = più freddo = più alto). Sotto i
        // 100 trasparente; sopra, nube sempre più opaca e più bianca (le basse grigie, le alte bianche: si leggono anche
        // sulla mappa chiara)
        for (let i = 0; i < d.length; i += 4) {
          const v = d[i],
            a = Math.max(0, Math.min(1, (v - 100) / 70)),
            w = Math.max(0, Math.min(1, (v - 110) / 80));
          d[i] = d[i + 1] = Math.round(150 + 105 * w);
          d[i + 2] = Math.round(158 + 97 * w); // grigio appena azzurrato → bianco
          d[i + 3] = Math.round(255 * a);
        }
      },
      /** Ultima immagine: dalle capabilities del solo livello (8 kB), attributo default della dimensione time. */
      async latest() {
        const r = await fetch(
          "https://view.eumetsat.int/geoserver/mtg_fd/ir105_hrfi/ows?service=WMS&request=GetCapabilities&version=1.3.0",
        );
        const m = r.ok
          ? (await r.text()).match(
              /<Dimension name="time"[^>]*default="([^"]+)"/,
            )
          : null;
        return m ? new Date(m[1]).toISOString() : null;
      },
    },
  };
  map.createPane("radar");
  map.getPane("radar").style.zIndex = 405; // sopra i colori del modello, sotto confini, frecce e isolinee
  map.getPane("radar").style.pointerEvents = "none";
  /** Un'immagine per istante su tutta l'area dei dati (13 richieste invece di centinaia di tessere: il server del
   *  satellite risponde in ~2 s a richiesta), ripulita in un canvas e mostrata come immagine sopra la mappa: spostando
   *  o ingrandendo la mappa non si ricarica nulla. 1800 px sull'area ≈ 1 km per pixel, più fine dei dati. */
  const EXTRA_W = 1800;
  function extraImage(cfg, time) {
    const b = meta.bbox,
      W = cfg.width || EXTRA_W;
    const sw = L.CRS.EPSG3857.project(L.latLng(b.lat_min, b.lon_min)),
      ne = L.CRS.EPSG3857.project(L.latLng(b.lat_max, b.lon_max));
    const h = Math.round((W * (ne.y - sw.y)) / (ne.x - sw.x));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // per ripulire i pixel e per l'immagine condivisa
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = W;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height);
        cfg.clean(px.data);
        ctx.putImageData(px, 0, 0);
        c.toBlob(
          (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
          "image/png",
        );
      };
      img.onerror = () => resolve(null); // immagine mancante: quell'istante resta vuoto
      img.src = wmsUrl(cfg.wms, {
        request: "GetMap",
        layers: cfg.layer,
        crs: "EPSG:3857",
        bbox: [sw.x, sw.y, ne.x, ne.y].join(","),
        width: W,
        height: h,
        format: "image/png",
        transparent: "true",
        time,
        ...(cfg.sld
          ? { sld_body: radarSld(cfg.layer), interpolations: "bilinear" }
          : {}),
      });
    });
  }
  // animazione: le ultime `frames` immagini, un livello per immagine caricato subito; si passa da una all'altra cambiando
  // solo l'opacità, così l'animazione non lampeggia mentre arrivano le tessere
  const extraCfg = () => EXTRAS[state.extra];
  const fmtRadarTime = (t) =>
    new Date(t).toLocaleTimeString("it-IT", {
      timeZone: "Europe/Rome",
      hour: "2-digit",
      minute: "2-digit",
    });
  let radarFrames = []; // [{ time, layer, ready }] dalla più vecchia alla più recente
  let radarIdx = -1,
    radarTimer = null,
    radarPlay = null;
  let radarAutoplay = false; // si accende col livello: l'animazione parte da sola appena tutte le immagini sono caricate
  /** Stato di caricamento: finché manca qualche immagine, riquadro al centro della pagina ("Caricamento radar 5/13") e
   *  controlli nascosti; quando sono tutte pronte si toglie e, la prima volta, parte subito l'animazione. Dopo uno
   *  spostamento della mappa le tessere nuove arrivano mentre l'animazione continua: niente riquadro. */
  let radarReadyOnce = false;
  function updateRadarLoading() {
    const ready = radarFrames.filter((f) => f.ready).length,
      all = !!radarFrames.length && ready === radarFrames.length;
    if (all) radarReadyOnce = true;
    const loading = !!extraCfg() && !radarReadyOnce;
    $("radar-loader").hidden = !loading;
    const was = document.body.classList.contains("radar-loading");
    document.body.classList.toggle("radar-loading", loading);
    if (was && !loading) {
      // immagini pronte: barra e legenda entrano con l'animazione (vedi .badge-enter in style.css)
      const enter = (el, cls) => {
        el.classList.remove(cls);
        void el.offsetWidth; // riparte anche se era appena stata usata
        el.classList.add(cls);
        const end = (e) => {
          if (e.target !== el) return;
          el.classList.remove(cls);
          el.removeEventListener("animationend", end);
        };
        el.addEventListener("animationend", end);
      };
      enter(ui.badge, "badge-enter");
      if (!ui.badge.contains(ui.legend)) enter(ui.legend, "legend-enter"); // su mobile la legenda è dentro la barra
    }
    $("radar-loader-name").textContent = extraCfg()?.name.toLowerCase() || "";
    $("radar-loader-count").textContent = radarFrames.length
      ? `${ready} di ${radarFrames.length} immagini`
      : "in attesa…";
    if (!all) return;
    showRadarFrame(radarIdx); // ora dell'immagine al posto del conteggio
    if (radarAutoplay) {
      radarAutoplay = false;
      startRadarPlay();
    }
  }
  /** Dissolvenza fra l'immagine `i` e la seguente (`t` da 0 a 1, ciclica): la seguente compare sopra nella prima metà
   *  mentre l'altra resta piena, poi l'altra sfuma. Così nelle zone in comune la pioggia non si affievolisce a metà. */
  function paintRadar(i, t) {
    // finché non sono arrivate tutte le immagini non se ne mostra nessuna (niente pezzi mentre si carica)
    const n = radarFrames.length,
      op = radarReadyOnce ? (extraCfg()?.opacity ?? 0) : 0,
      j = (i + 1) % n;
    radarFrames.forEach((f, k) => {
      const o =
        k === i
          ? op * Math.min(1, 2 * (1 - t))
          : k === j && t > 0
            ? op * Math.min(1, 2 * t)
            : 0;
      if (f.op === o) return;
      f.op = o;
      f.layer.setOpacity?.(o);
      f.layer.setZIndex?.(k === j ? 2 : 1);
    });
  }
  function showRadarFrame(i) {
    radarIdx = Math.max(0, Math.min(i, radarFrames.length - 1));
    paintRadar(radarIdx, 0);
    const f = radarFrames[radarIdx];
    $("radar-slider").value = radarIdx;
    $("radar-slider").style.setProperty(
      "--pct",
      `${(100 * radarIdx) / (+$("radar-slider").max || 1)}%`,
    );
    $("radar-badge-time").textContent = f ? fmtRadarTime(f.time) : "—";
  }
  function stopRadarPlay() {
    cancelAnimationFrame(radarPlay);
    radarPlay = null;
    if (radarFrames.length) showRadarFrame(radarIdx); // niente dissolvenza lasciata a metà
    $("radar-play").innerHTML = M_PLAY;
    $("radar-play").setAttribute("aria-label", "Anima");
  }
  const RADAR_HOLD = 150,
    RADAR_HOLD_LAST = 1500,
    RADAR_FADE = 350; // ms: ogni immagine resta ferma poi sfuma nella seguente
  function startRadarPlay() {
    if (radarFrames.length < 2) return;
    $("radar-play").innerHTML = M_PAUSE;
    $("radar-play").setAttribute("aria-label", "Ferma l'animazione");
    if (radarIdx >= radarFrames.length - 1) showRadarFrame(0); // dall'ultima si riparte dalla prima
    let t0 = performance.now();
    const step = (now) => {
      const n = radarFrames.length,
        last = radarIdx >= n - 1;
      const hold = last ? RADAR_HOLD_LAST : RADAR_HOLD,
        el = now - t0; // pausa più lunga sull'ultima immagine
      if (el >= hold + RADAR_FADE) {
        showRadarFrame(last ? 0 : radarIdx + 1);
        t0 = now;
      } else if (el > hold) paintRadar(radarIdx, (el - hold) / RADAR_FADE);
      radarPlay = requestAnimationFrame(step);
    };
    radarPlay = requestAnimationFrame(step);
  }
  /** Allinea i livelli all'ultima immagine disponibile: tiene quelli già caricati, aggiunge i nuovi, toglie i vecchi. */
  async function refreshRadar() {
    const cfg = extraCfg();
    if (!cfg) return;
    let latest = null;
    try {
      latest = await cfg.latest();
    } catch {
      /* rete assente: si riprova al prossimo giro */
    }
    if (extraCfg() !== cfg) return; // nel frattempo è cambiato livello
    if (!latest) {
      if (!radarFrames.length)
        $("radar-loader-count").textContent =
          "non disponibile, riprovo tra poco";
      return;
    }
    if (radarFrames.at(-1)?.time === latest) return;
    const times = Array.from({ length: cfg.frames }, (_, k) =>
      new Date(
        Date.parse(latest) - (cfg.frames - 1 - k) * cfg.stepMin * 60e3,
      ).toISOString(),
    );
    const keep = new Map(radarFrames.map((f) => [f.time, f]));
    for (const f of radarFrames)
      if (!times.includes(f.time)) {
        f.layer.remove();
        if (f.url) URL.revokeObjectURL(f.url);
      }
    const wasLast = radarIdx === -1 || radarIdx >= radarFrames.length - 1;
    const bounds = L.latLngBounds(
      [meta.bbox.lat_min, meta.bbox.lon_min],
      [meta.bbox.lat_max, meta.bbox.lon_max],
    );
    radarFrames = times.map(
      (time) => keep.get(time) || { time, ready: false, layer: L.layerGroup() },
    ); // segnaposto
    // richieste dalla più recente (la più utile, e l'animazione si ferma lì): il server ne serve poche alla volta
    for (const f of [...radarFrames].reverse()) {
      if (keep.has(f.time)) continue;
      extraImage(cfg, f.time).then((url) => {
        if (!radarFrames.includes(f)) {
          if (url) URL.revokeObjectURL(url);
          return;
        } // livello già cambiato
        f.url = url;
        if (url && glBase)
          f.layer = glFrameLayer(`wm-x-${f.time}`, url, bounds); // dentro Mapbox, sotto confini e nomi
        else if (url)
          f.layer = L.imageOverlay(url, bounds, {
            pane: "radar",
            opacity: 0,
            interactive: false,
          }).addTo(map);
        f.op = 0;
        f.ready = true;
        updateRadarLoading();
      });
    }
    $("radar-slider").max = radarFrames.length - 1;
    if (wasLast && !radarPlay) showRadarFrame(radarFrames.length - 1); // senza animazione si resta sull'ultima immagine
    updateRadarLoading();
  }
  /** Immagine del radar/satellite come strato Mapbox, con gli stessi metodi usati dall'animazione. */
  function glFrameLayer(id, url, bounds) {
    glPut(id, { url, bounds, opacity: 0 });
    return {
      setOpacity: (o) => glPut(id, { opacity: o }),
      setZIndex() {},
      remove: () => glRemove(id),
      getElement: () => null,
    };
  }
  const EXTRA_NAMES = { none: "Off", radar: "Radar", sat: "Sat", snd: "Radiosondaggi" };
  function setExtra(name, save = true) {
    clearInterval(radarTimer);
    stopRadarPlay();
    for (const f of radarFrames) {
      f.layer.remove();
      if (f.url) URL.revokeObjectURL(f.url);
    }
    radarFrames = [];
    radarIdx = -1;
    // radar, satellite e radiosondaggi solo sulla mappa normale
    state.extra = (EXTRAS[name] || name === "snd") && !synoptic() ? name : "none";
    const cfg = extraCfg();
    // radiosondaggi: via i colori del modello come col radar, restano la mappa e le stazioni (vedi renderSoundings)
    const snd = state.extra === "snd";
    document.body.classList.toggle("snd-mode", snd);
    renderSoundings();
    // con un livello extra: spariscono colori, isolinee e frecce del modello (sarebbe illeggibile), legenda e barra in
    // alto passano al livello; il modello resta scelto e torna togliendolo
    document.body.classList.toggle("radar-mode", !!cfg);
    if (glImgs.has("wm-model")) glPut("wm-model", { visible: !cfg && !snd }); // i colori del modello spariscono anche in Mapbox
    $("extra-name").textContent = cfg?.name || "";
    if (cfg) togglePlay(false);
    if (meta && state.var) {
      renderLegend();
      renderPoints();
    } // all'avvio le disegnano setupVars e setupPoints
    ui.probe.hidden = true;
    radarAutoplay = !!cfg;
    radarReadyOnce = false;
    updateRadarLoading();
    if (cfg) {
      refreshRadar();
      radarTimer = setInterval(refreshRadar, cfg.stepMin * 60e3); // nuova immagine ogni 5 (radar) o 10 minuti (satellite)
    }
    $("extra-seg").replaceChildren(
      ...Object.entries(EXTRA_NAMES).map(([k, text]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.setAttribute("aria-pressed", String(k === state.extra));
        b.addEventListener("click", () => {
          setExtra(k);
          // su mobile il pannello copre la mappa: accendendo radar o satellite si chiude, così si vede il caricamento
          if (
            k !== "none" &&
            mobileMq.matches &&
            !ui.panel.classList.contains("collapsed")
          )
            ui.collapse.click();
        });
        return b;
      }),
    );
    if (save) saveSettings();
  }
  $("extra-close").addEventListener("click", () => setExtra("none"));
  $("radar-play").addEventListener("click", () =>
    radarPlay ? stopRadarPlay() : startRadarPlay(),
  );
  $("radar-slider").addEventListener("input", (e) => {
    const index = +e.target.value;
    stopRadarPlay();
    showRadarFrame(index);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRadar();
  }); // tornando sulla pagina

  map.createPane("arrows");
  map.getPane("arrows").style.zIndex = 425;
  map.getPane("arrows").style.pointerEvents = "none";
  const arrowsRenderer = L.canvas({ pane: "arrows", padding: 0.1 });
  const arrowsLayer = L.layerGroup().addTo(map);
  const ARROW_STEP = 46; // px fra le frecce
  /** Frecce della direzione (verso dove va il vento) su una griglia regolare di pixel, ricalcolate a ogni spostamento:
   *  sempre la stessa densità a ogni zoom. Lunghezza crescente con la velocità. */
  function drawArrows() {
    arrowsLayer.clearLayers();
    const f = current?.u ? current : currentArrows; // voce "Vento" o combinata con le frecce
    if (!f?.u) return;
    const su = sampler({ grid: f.grid, values: f.u }, false),
      sv = sampler({ grid: f.grid, values: f.v }, false);
    const size = map.getSize();
    const segs = [];
    const toLL = (x, y) => map.containerPointToLatLng([x, y]);
    for (let y = ARROW_STEP / 2; y < size.y; y += ARROW_STEP) {
      for (let x = ARROW_STEP / 2; x < size.x; x += ARROW_STEP) {
        const ll = toLL(x, y);
        const u = su(ll.lat, ll.lng),
          v = sv(ll.lat, ll.lng);
        if (u == null || v == null) continue;
        const sp = Math.hypot(u, v);
        if (sp < 2) continue; // calma: niente freccia
        const len = 9 + (Math.min(sp, 80) / 80) * 13; // 9–22 px
        const dx = u / sp,
          dy = -v / sp; // schermo: y verso il basso
        const x0 = x - (dx * len) / 2,
          y0 = y - (dy * len) / 2,
          x1 = x + (dx * len) / 2,
          y1 = y + (dy * len) / 2;
        const h = 5,
          wx = -dy,
          wy = dx; // punta: due tratti a 30° circa
        segs.push([toLL(x0, y0), toLL(x1, y1)]);
        segs.push([
          toLL(x1 - dx * h + wx * h * 0.6, y1 - dy * h + wy * h * 0.6),
          toLL(x1, y1),
          toLL(x1 - dx * h - wx * h * 0.6, y1 - dy * h - wy * h * 0.6),
        ]);
      }
    }
    if (segs.length) {
      L.polyline(segs, {
        renderer: arrowsRenderer,
        interactive: false,
        color: "#1f2328",
        weight: 1.3,
        opacity: 0.8,
        lineCap: "round",
        lineJoin: "round",
        smoothFactor: 0,
      }).addTo(arrowsLayer);
    }
  }
  map.on("moveend", () => {
    if (current?.u || currentArrows) drawArrows();
  });

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
        const chain = [
          prev,
          ...meta.steps.filter((x) => x > prev && x <= step && avail.has(x)),
        ];
        if (chain.length < 2) return lines(step);
        const [tot, hz] = await Promise.all([
          Promise.all(
            chain.map((x) => (x === 0 ? null : getField(x, "total", ctx))),
          ),
          Promise.all(
            chain.map((x) => (x === 0 ? null : lines(x).catch(() => null))),
          ),
        ]);
        const end = hz[hz.length - 1];
        const n = end?.values.length;
        // griglie diverse fra pioggia e linee (non dovrebbe capitare): solo l'istante finale
        if (
          !end ||
          tot.some((t) => t && t.values.length !== n) ||
          hz.some((h) => h && h.values.length !== n)
        )
          return end;
        const values = new Array(n);
        for (let k = 0; k < n; k++) {
          let num = 0,
            den = 0,
            sum = 0,
            cnt = 0;
          for (let i = 1; i < chain.length; i++) {
            const a = hz[i - 1]?.values[k],
              b = hz[i]?.values[k];
            const z = a != null && b != null ? (a + b) / 2 : (b ?? a); // al passo 0 lo zero termico non c'è
            if (z == null) continue;
            const t1 = tot[i].values[k],
              t0 = tot[i - 1] ? tot[i - 1].values[k] : 0;
            const p = t1 != null && t0 != null ? Math.max(0, t1 - t0) : 0;
            num += z * p;
            den += p;
            sum += z;
            cnt++;
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
        const a = rgb[k],
          b = rgb[k + 1];
        return [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];
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
      const x0 = Math.floor(fx),
        y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, nx - 1),
        y1 = Math.min(y0 + 1, ny - 1);
      const tx = fx - x0,
        ty = fy - y0;
      const a = at(y0, x0),
        b = at(y0, x1),
        c = at(y1, x0),
        d = at(y1, x1);
      if (a == null || b == null || c == null || d == null)
        return at(Math.round(fy), Math.round(fx));
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };
  }

  // ---------- immagine dei colori: calcolata in un worker (static/render.js), così i milioni di pixel dei modelli a
  // 1-2 km non bloccano slider, pinch e animazioni; le immagini dei passi già visti (e dei vicini, preparate in
  // anticipo) restano in memoria, quindi tornare su un passo o animare non ricalcola niente.
  const F32 = new WeakMap(); // lista di valori (con null) -> Float32Array (NaN = mancante), per il worker
  function f32Of(values) {
    let a = F32.get(values);
    if (!a) {
      a = new Float32Array(values.length);
      for (let i = 0; i < a.length; i++) {
        const v = values[i];
        a[i] = v == null ? NaN : v;
      }
      F32.set(values, a);
    }
    return a;
  }
  const renderSrc = document.querySelector('script[src^="render.js"]')?.src;
  let renderWorker = null;
  try {
    if (renderSrc && window.Worker && window.OffscreenCanvas)
      renderWorker = new Worker(renderSrc);
  } catch {
    /* niente worker: si calcola nella pagina */
  }
  const renderJobs = new Map(); // id -> { job, resolve, low }
  let renderBusy = null,
    renderSeq = 0;
  function pumpRender() {
    if (renderBusy != null || !renderJobs.size) return;
    // prima l'immagine da mostrare (l'ultima chiesta), poi quelle preparate in anticipo
    let pick = null,
      pickLow = true;
    for (const [id, j] of renderJobs) {
      if (
        pick == null ||
        (pickLow && !j.low) ||
        (j.low === pickLow && id > pick)
      ) {
        pick = id;
        pickLow = j.low;
      }
    }
    renderBusy = pick;
    renderWorker.postMessage(renderJobs.get(pick).job);
  }
  if (renderWorker) {
    renderWorker.onmessage = (e) => {
      const j = renderJobs.get(e.data.id);
      renderJobs.delete(e.data.id);
      renderBusy = null;
      j?.resolve(e.data.blob ? URL.createObjectURL(e.data.blob) : null);
      pumpRender();
    };
    renderWorker.onerror = () => {
      // worker inutilizzabile: i lavori in coda passano alla pagina
      const jobs = [...renderJobs.values()];
      renderJobs.clear();
      renderBusy = null;
      renderWorker = null;
      for (const j of jobs) renderInPage(j.job).then(j.resolve);
    };
  }
  function renderInPage(job) {
    const { W, H, pixels } = wmRenderPixels(job);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas
      .getContext("2d")
      .putImageData(
        new ImageData(new Uint8ClampedArray(pixels.buffer), W, H),
        0,
        0,
      );
    return new Promise((resolve) =>
      canvas.toBlob(
        (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
        "image/png",
      ),
    );
  }
  const IMG_KEEP = 40; // immagini tenute (le più recenti): ~10 MB al massimo con i modelli più fini
  const imgCache = new Map(); // chiave -> Promise<url>
  const fieldImageIds = new WeakMap();
  let fieldIds = 0;
  /** Immagine dei colori di un campo per la grandezza e le impostazioni attuali; `low` = preparata in anticipo. */
  function fieldImage(f, low = false) {
    const v = variable(),
      { nx, ny, lat0, lon0, dlat, dlon } = f.grid;
    if (!fieldImageIds.has(f)) fieldImageIds.set(f, ++fieldIds);
    const key = `${fieldImageIds.get(f)}|${state.var}|${state.crisp ? 1 : 0}`;
    const hit = imgCache.get(key);
    if (hit) {
      imgCache.delete(key);
      imgCache.set(key, hit); // usata di recente: in fondo
      if (!low && hit.id != null && renderJobs.has(hit.id)) {
        // ora serve subito
        for (const j of renderJobs.values()) j.low = true;
        renderJobs.get(hit.id).low = false;
        pumpRender();
      }
      return hit;
    }
    // grandezze con le loro linee (T850, zero termico): colori dallo stesso campo ammorbidito delle linee, così ogni
    // linea cade esattamente su un cambio di colore; "celle nette" mostra invece il dato grezzo
    const own = v.contours && !v.contour_field && !state.crisp;
    const job = {
      id: ++renderSeq,
      values: f32Of(f.values),
      nx,
      ny,
      lat0,
      lon0,
      dlat,
      dlon,
      scale: v.scale,
      crisp: state.crisp,
      // 2 pixel per cella (almeno 1100 in larghezza); le griglie più fini (ICON-CH1, 1 km) ne hanno già abbastanza.
      // Carta sinottica: le celle di 0,25° sullo schermo sono grandi, con le fasce strette di 4 dam servono più pixel
      // (altrimenti i bordi delle fasce vengono a scalini); 7 tiene la larghezza sotto i 4096 pixel delle texture
      // dei telefoni
      upscale: synoptic()
        ? Math.max(2, Math.min(7, Math.floor(4096 / nx)))
        : Math.max(nx >= 800 && !state.crisp ? 1 : 2, Math.ceil(1100 / nx)),
      // carta sinottica: GFS a 0,25° ha piccole irregolarità fra celle vicine che, con fasce di 4 dam, fanno i bordi
      // a quadretti; due passate di media danno le fasce morbide delle carte classiche (il tooltip resta grezzo)
      smooth: synoptic() ? 2 : own ? Math.min(4, Math.round(0.1 / dlon)) : 0,
    };
    const pr = renderWorker
      ? new Promise((resolve) => {
          if (!low) for (const j of renderJobs.values()) j.low = true; // i passi già superati non hanno più la precedenza
          renderJobs.set(job.id, { job, resolve, low });
          pumpRender();
        })
      : renderInPage(job);
    pr.id = job.id;
    imgCache.set(key, pr);
    pr.then((url) => {
      if (!url && imgCache.get(key) === pr) imgCache.delete(key);
    });
    while (imgCache.size > IMG_KEEP) {
      // via le più vecchie (mai quella mostrata: è appena stata usata)
      const [k, old] = imgCache.entries().next().value;
      imgCache.delete(k);
      if (renderJobs.has(old.id) && renderBusy !== old.id) {
        renderJobs.get(old.id).resolve(null);
        renderJobs.delete(old.id);
      }
      old.then((url) => {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
    }
    return pr;
  }

  let drawSeq = 0;
  function draw(f) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    // bordi delle celle
    const south = lat0 - dlat / 2,
      north = lat0 + (ny - 1) * dlat + dlat / 2;
    const west = lon0 - dlon / 2,
      east = lon0 + (nx - 1) * dlon + dlon / 2;
    const bounds = L.latLngBounds([south, west], [north, east]);
    const my = ++drawSeq,
      crisp = state.crisp;
    const painted = fieldImage(f).then((url) => {
      if (my !== drawSeq || !url) return; // nel frattempo si è passati a un altro campo
      if (glBase) {
        glPut("wm-model", {
          url,
          bounds,
          opacity: state.opacity,
          crisp,
          visible: state.extra === "none",
        });
      } else if (!overlay) {
        overlay = L.imageOverlay(url, bounds, {
          opacity: state.opacity,
          className: "wm-overlay",
          interactive: false,
        }).addTo(map);
      } else {
        overlay.setUrl(url);
        overlay.setBounds(bounds);
      }
      overlay?.getElement()?.classList.toggle("crisp", crisp);
    });
    drawContours(variable().contour_field ? currentContour : f);
    drawArrows();
    return painted;
  }

  function clearOverlay() {
    drawSeq++; // un'immagine ancora in calcolo non deve più comparire
    if (overlay) {
      map.removeLayer(overlay);
      overlay = null;
    }
    glRemove("wm-model");
    currentContour = null;
    currentArrows = null;
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
    countries: { weight: 2, opacity: 0.9 },
    regions: { weight: 1.4, opacity: 0.8 },
    provinces: { weight: 1.1, opacity: 0.75, dashArray: "4 3" }, // tratteggio: si distinguono dalle regioni
  };
  // quali linee, dalla scelta "Confini": Stati = coste e confini di stato (con l'opacità al massimo la mappa diventa
  // una carta meteo classica), Regioni e Province aggiungono i confini interni
  const BORDER_LEVELS = [
    [],
    ["coast", "countries"],
    ["regions"],
    ["provinces"],
  ];
  function visibleBorders() {
    const n = Object.keys(BORDER_NAMES).indexOf(state.borders);
    return new Set(BORDER_LEVELS.slice(0, n + 1).flat());
  }
  const bordersOn = () => visibleBorders().size > 0;
  const borderLines = {}; // chiave -> polyline, create al primo caricamento di borders.json
  let bordersLoad = null;
  function styleBorders() {
    styleSynBorders();
    if (synoptic()) {
      bordersLayer.remove();
      glBorders();
      return;
    }
    if (glBase) {
      bordersLayer.remove();
      glBorders();
      return;
    } // con Mapbox i confini sono i suoi
    const keys = visibleBorders();
    if (!keys.size) {
      bordersLayer.remove();
      return;
    }
    bordersLayer.addTo(map);
    const apply = () => {
      // stato letto al momento: se nel frattempo è cambiato, vale l'ultimo
      const k = visibleBorders();
      for (const [key, line] of Object.entries(borderLines)) {
        if (k.has(key)) bordersLayer.addLayer(line);
        else bordersLayer.removeLayer(line);
      }
    };
    bordersLoad ??= fetch("borders.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((b) => {
        for (const [key, st] of Object.entries(BORDER_STYLE)) {
          if (b[key]?.length)
            borderLines[key] = L.polyline(b[key], {
              renderer: bordersRenderer,
              interactive: false,
              smoothFactor: 1,
              color: "#1f2328",
              ...st,
            });
        }
      })
      .catch(() => {
        bordersLoad = null;
      }); // senza contorni la mappa funziona lo stesso: si riproverà
    bordersLoad?.then(apply);
  }
  // coste e stati della carta sinottica (Natural Earth 1:50m, scripts/make_borders.py --synoptic): sopra i colori,
  // anche con Mapbox (del suo sfondo lì resta solo il fondo). "Confini: Nessuno" li spegne.
  map.createPane("synBorders");
  map.getPane("synBorders").style.zIndex = 410;
  map.getPane("synBorders").style.pointerEvents = "none";
  const synRenderer = L.canvas({ pane: "synBorders", padding: 0.5 });
  const synLayer = L.layerGroup();
  let synLoad = null;
  function styleSynBorders() {
    if (!synoptic() || state.borders === "none") {
      synLayer.remove();
      return;
    }
    synLayer.addTo(map);
    synLoad ??= fetch("borders-synoptic.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((b) => {
        const st = { renderer: synRenderer, interactive: false, color: "#1f2328" };
        synLayer.addLayer(L.polyline(b.coast, { ...st, weight: 1.2, opacity: 0.85 }));
        synLayer.addLayer(L.polyline(b.countries, { ...st, weight: 0.9, opacity: 0.7 }));
      })
      .catch(() => {
        synLoad = null;
      });
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
      const segA = [],
        segB = [];
      const cross = (id, ya, xa, va, yb, xb, vb) => {
        if (!pos.has(id)) {
          const t = (L0 - va) / (vb - va);
          pos.set(id, [
            lat0 + (ya + (yb - ya) * t) * dlat,
            lon0 + (xa + (xb - xa) * t) * dlon,
          ]);
        }
        return id;
      };
      for (let y = 0; y < ny - 1; y++) {
        for (let x = 0; x < nx - 1; x++) {
          const a = v[y * nx + x],
            b = v[y * nx + x + 1],
            c = v[(y + 1) * nx + x + 1],
            d = v[(y + 1) * nx + x];
          if (a == null || b == null || c == null || d == null) continue;
          const sa = a >= L0,
            sb = b >= L0,
            sc = c >= L0,
            sd = d >= L0;
          if (sa === sb && sb === sc && sc === sd) continue;
          // lati: 0 = a-b (basso), 1 = b-c (destra), 2 = d-c (alto), 3 = a-d (sinistra)
          const e = [];
          if (sa !== sb) e[0] = cross((y * nx + x) * 2, y, x, a, y, x + 1, b);
          if (sb !== sc)
            e[1] = cross(
              (y * nx + x + 1) * 2 + 1,
              y,
              x + 1,
              b,
              y + 1,
              x + 1,
              c,
            );
          if (sd !== sc)
            e[2] = cross(((y + 1) * nx + x) * 2, y + 1, x, d, y + 1, x + 1, c);
          if (sa !== sd)
            e[3] = cross((y * nx + x) * 2 + 1, y, x, a, y + 1, x, d);
          const ids = e
            .map((id, i) => [i, id])
            .filter((z) => z[1] !== undefined);
          if (ids.length === 2) {
            segA.push(ids[0][1]);
            segB.push(ids[1][1]);
            continue;
          }
          // sella: decide il valore al centro della cella
          const center = (a + b + c + d) / 4 >= L0;
          if (center === sa) {
            segA.push(e[0], e[2]);
            segB.push(e[1], e[3]);
          } else {
            segA.push(e[0], e[1]);
            segB.push(e[3], e[2]);
          }
        }
      }
      // unione dei segmenti che condividono un lato
      const at = new Map();
      const link = (id, k) => {
        const l = at.get(id);
        if (l) l.push(k);
        else at.set(id, [k]);
      };
      for (let k = 0; k < segA.length; k++) {
        link(segA[k], k);
        link(segB[k], k);
      }
      const used = new Uint8Array(segA.length);
      const walk = (start, k0) => {
        const ids = [];
        let id = start,
          k = k0;
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
        const fwd = (() => {
          const n = (at.get(segB[k]) || []).find((j) => !used[j]);
          return n === undefined ? [] : walk(segB[k], n);
        })();
        const back = (() => {
          const n = (at.get(segA[k]) || []).find((j) => !used[j]);
          return n === undefined ? [] : walk(segA[k], n);
        })();
        const ids = [...back.reverse(), segA[k], segB[k], ...fwd];
        const closed = ids[0] === ids[ids.length - 1];
        if (ids.length < (closed ? 12 : 4)) continue; // frammenti e anelli minuscoli: solo rumore
        out.push({
          level: lvl,
          pts: smooth(
            ids.map((id) => pos.get(id)),
            closed,
          ),
        });
      }
    }
    return out;
  }

  /** Campo ammorbidito per linee di livello e relativi colori (calcolato una volta per campo). Sulle griglie fini
   *  (ICON 2 km) più passate, così le linee non diventano tanti anellini; GFS (0,25°) resta com'è. */
  function smoothField(f) {
    if (!f._smooth) {
      const { nx, ny, dlon } = f.grid;
      f._smooth = {
        ...f,
        // carta sinottica: isobare morbide come nelle carte classiche (a 0,25° altrimenti nessuna passata)
        values: blurred(f.values, nx, ny, synoptic() ? 3 : Math.min(4, Math.round(0.1 / dlon))),
      };
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
          if (a[y * nx + x] == null) {
            b[y * nx + x] = null;
            continue;
          }
          let sum = 0,
            n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx) continue;
              const w = a[yy * nx + xx];
              if (w != null) {
                sum += w;
                n++;
              }
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
    for (let it = 0; it < 1 && p.length > 2; it++) {
      // una passata: le linee restano sul bordo dei colori
      const q = closed ? [] : [p[0]];
      const n = p.length - 1;
      for (let i = 0; i < n; i++) {
        const [a, b] = [p[i], p[i + 1]];
        q.push(
          [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
          [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]],
        );
      }
      if (closed) q.push(q[0]);
      else q.push(p[n]);
      p = q;
    }
    return p;
  }

  const contourCache = new Map();
  let drawnContourField = null,
    drawnContourConfig = null;
  function drawContours(f) {
    const cfg = variable()?.contours;
    ui.isoRow.hidden = !cfg;
    if (cfg)
      ui.isoText.textContent = `${cfg.label} (ogni ${cfg.step} ${cfg.units || variable().units})`;
    if (
      f &&
      cfg &&
      state.iso &&
      f === drawnContourField &&
      cfg === drawnContourConfig
    )
      return;
    drawnContourField = state.iso ? f : null;
    drawnContourConfig = cfg;
    isoLines.clearLayers();
    isoLabels.clearLayers();
    isoData = [];
    if (!f || !cfg || !state.iso) return;
    let cached = contourCache.get(f);
    if (!cached) {
      cached = new Map();
    }
    contourCache.delete(f);
    contourCache.set(f, cached);
    if (contourCache.size > 3)
      contourCache.delete(contourCache.keys().next().value);
    let drawing = cached.get(cfg);
    if (!drawing) {
      let lo = Infinity,
        hi = -Infinity;
      for (const x of f.values)
        if (x != null) {
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      if (!(hi > lo)) return;
      const levels = [];
      for (let l = Math.ceil(lo / cfg.step) * cfg.step; l <= hi; l += cfg.step)
        levels.push(+l.toFixed(6));
      const bold = new Set(cfg.bold || []);
      const data = contourLines(smoothField(f), levels).map((line) => ({
        ...line,
        bold: bold.has(line.level),
        bounds: L.latLngBounds(line.pts),
      }));
      const layers = [];
      for (const isBold of [false, true]) {
        const paths = data
          .filter((line) => line.bold === isBold)
          .map((line) => line.pts);
        if (!paths.length) continue;
        layers.push(
          L.polyline(paths, {
            renderer: isoRenderer,
            interactive: false,
            smoothFactor: 0.5,
            // carta sinottica: isobare bianche e più spesse sopra i colori pieni, come su Meteociel
            ...(synoptic()
              ? { color: "#ffffff", weight: isBold ? 4 : 3, opacity: 0.95 }
              : { color: "#1f2328", weight: isBold ? 2 : 0.9, opacity: isBold ? 0.85 : 0.55 }),
          }),
        );
      }
      drawing = { data, layers };
      cached.set(cfg, drawing);
    }
    isoData = drawing.data;
    for (const layer of drawing.layers) layer.addTo(isoLines);
    placeContourLabels();
  }

  /** Etichette lungo le linee, a distanza fissa in pixel (si ricalcolano allo zoom), senza sovrapporsi. */
  function placeContourLabels() {
    isoLabels.clearLayers();
    if (!isoData.length) return;
    const bounds = map.getBounds().pad(0.05);
    const zoom = map.getZoom();
    const FIRST = 90,
      EVERY = 320,
      CELL = 46;
    const taken = new Set();
    const free = (p) => {
      const cx = Math.floor(p.x / CELL),
        cy = Math.floor(p.y / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          if (taken.has(`${cx + dx},${cy + dy}`)) return false;
      taken.add(`${cx},${cy}`);
      return true;
    };
    const signed = !!variable()?.contours?.signed;
    const fmt = (l) => (signed && l > 0 ? `+${l}` : `${l}`).replace("-", "−");
    // prima le linee in evidenza, poi le più lunghe
    const order = [...isoData].sort(
      (a, b) => b.bold - a.bold || b.pts.length - a.pts.length,
    );
    for (const c of order) {
      if (!bounds.intersects(c.bounds)) continue;
      if (c.labelZoom !== zoom) {
        c.labelPoints = [];
        let dist = 0,
          next = FIRST,
          prev = null;
        for (const ll of c.pts) {
          const point = map.project(ll, zoom).round();
          if (prev) dist += point.distanceTo(prev);
          prev = point;
          if (dist < next) continue;
          next = dist + EVERY;
          c.labelPoints.push(ll);
        }
        c.labelZoom = zoom;
      }
      for (const ll of c.labelPoints) {
        if (!bounds.contains(ll)) continue;
        const p = map.latLngToLayerPoint(ll);
        if (!free(p)) continue;
        L.marker(ll, {
          pane: "contourLabels",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: `iso-lbl${c.bold ? " iso-bold" : ""}`,
            html: `<span>${fmt(c.level)}</span>`,
            iconSize: null,
          }),
        }).addTo(isoLabels);
      }
    }
  }
  map.on("moveend", placeContourLabels);

  function renderTime() {
    const s = state.step;
    const run = runDate(state.run || "1970010100");
    const valid = new Date(run.getTime() + s * 3600e3);
    // pannello e barra desktop: con un intervallo solo le date, senza mese per stare in una riga; altrimenti
    // istante e passo ("ven 13 nov, 18:00 · +18h")
    const span = state.run && intervalStartDate(s);
    // senza corsa (grandezza che il modello non ha) niente date: fmtShown ha bisogno della corsa
    const panelTime = !state.run ? "" : span ? fmtShown(s, { month: false }) : `${fmtShown(s)} · +${s}h`;
    ui.valid.classList.toggle("valid-span", !!span);
    ui.valid.textContent = panelTime;
    if (!state.run) {
      ui.range.textContent = "";
      // anche nella barra (su mobile il pannello di solito è chiuso): grandezza non fornita o dati non ancora arrivati
      const what = variable().models.includes(state.model)
        ? "nessun dato"
        : "non disponibile";
      // stessa struttura della barra normale: su mobile "non disponibile" al posto dell'ora, il modello a destra
      ui.badgeText.innerHTML =
        `<b class="badge-d">${modelLabel()}</b><span class="badge-run badge-d">${what === "nessun dato" ? "nessun dato" : "grandezza non disponibile"}</span>` +
        `<span class="badge-m badge-m-time"><b>${what}</b></span>` +
        `<span class="badge-m badge-m-model">${shortLabel(state.model)}</span>`;
      return;
    }
    const runText = `<strong>${state.run.slice(8, 10)}z</strong> ${state.run.slice(6, 8)}/${state.run.slice(4, 6)}`;
    syncIntervalSliders();
    // la cumulata dell'immagine mostrata (anche durante il play: con le ore scelte le ultime ore, non tutto il range)
    const rangeStart = intervalPrev(s);
    const rangeEnd = s;
    const rangeLabel = rangeStart === 0
      ? `+${rangeEnd} ore`
      : `Da +${rangeStart}h a +${rangeEnd}h · ${rangeEnd - rangeStart}h`;
    // con un intervallo anche l'ora d'inizio; su mobile senza mese per stare in una riga
    const mobileTime = fmtShown(s, { month: false });
    // con l'inizio già scritto nelle date basta la durata, così la riga resta una sola
    const mobileRangeLabel = intervalStartDate(s)
      ? `${rangeEnd - rangeStart}h`
      : rangeStart === 0
        ? rangeLabel
        : `+${rangeStart}&ndash;${rangeEnd}h · ${rangeEnd - rangeStart}h`;
    const mobileRange = rangeMode()
      ? `<span class="badge-m-range">${mobileRangeLabel}</span>`
      : "";
    // desktop: modello, corsa e istante; mobile (badge-m): prima l'istante, poi modello breve e corsa
    ui.badgeText.innerHTML =
      `<b class="badge-d">${modelLabel()}</b><span class="badge-run badge-d">${runText}</span>` +
      `<span class="badge-valid badge-d">${panelTime}</span>` +
      `<span class="badge-m badge-m-time"><b>${mobileTime}</b>${mobileRange}</span>` +
      `<span class="badge-m badge-m-model">${shortLabel(state.model)} ${cycle(state.run)}</span>`;
    const mStep = $("m-step"); // slider della barra su mobile, allineato a quello del pannello
    mStep.max = slideSteps().length - 1;
    mStep.value = slideSteps().indexOf(s);
    for (const r of [mStep, ui.step])
      r.style.setProperty("--pct", `${(100 * +r.value) / (+r.max || 1)}%`); // parte percorsa
    // cumulate (intervallo o totale): date nella riga sopra, passi e durata nella barra in basso e in legenda;
    // l'ora UTC resta solo per le grandezze istantanee
    ui.range.textContent = state.mode === "interval" || state.mode === "total" ? "" : `${fmtUTC(valid)} UTC`;
    if (typeof renderLandscapeNav === "function") renderLandscapeNav(); // mini barra del telefono in orizzontale
  }

  let seq = 0;
  async function update() {
    writeHash();
    saveSettings();
    renderLegend();
    renderTime();
    if (!variable().models.includes(state.model)) {
      setLoading(false);
      clearOverlay();
      current = null;
      renderPoints();
      setStatus("");
      const names = meta.models
        .filter((m) => variable().models.includes(m.id))
        .map((m) => shortLabel(m.id));
      showNoData("Grandezza non disponibile", `Disponibile con: ${names.join(", ")}.`);
      return;
    }
    if (!state.run) {
      setLoading(false);
      clearOverlay();
      current = null;
      renderPoints();
      setStatus("");
      showNoData(
        `${modelLabel()}: nessun dato per ${baseLabel()}`,
        "I dati di questa combinazione non sono ancora disponibili: arriveranno con uno dei prossimi aggiornamenti. Intanto puoi scegliere un altro modello.",
      );
      return;
    }
    if (!availableSteps().has(state.step)) {
      setLoading(false);
      clearOverlay();
      current = null;
      renderPoints();
      setStatus("");
      showNoData(
        `Nessun dato per ${fmtLocal(new Date(runDate(state.run).getTime() + state.step * 3600e3))}`,
        `${modelLabel()} non ha dati di ${baseLabel()} per quest'ora: scegline un'altra con lo slider o le frecce.`,
      );
      return;
    }
    showNoData(null);
    const my = ++seq;
    setLoading(true); // spinner nella riga dell'ora: niente testo che compare e sparisce spostando il pannello
    dropStaleFetches();
    try {
      // voci combinate: anche il campo delle linee, alla stessa ora (se manca, solo i colori)
      const cv = variable().contour_field;
      const load = () =>
        Promise.all([
          mainField(state.step),
          cv ? contourFieldAt(state.step).catch(() => null) : null,
          arrowsFieldAt(state.step).catch(() => null), // frecce delle combinate (se mancano, solo i colori)
        ]);
      let got;
      for (let attempt = 0; ; attempt++) {
        try {
          got = await load();
          break;
        } catch (e) {
          // una richiesta annullata da dropStaleFetches proprio mentre tornava utile: si rifà
          if (e.name !== "AbortError" || attempt >= 3 || my !== seq) throw e;
        }
      }
      const [f, cf, af] = got;
      if (my !== seq) return;
      current = f;
      currentContour = cf;
      currentArrows = af;
      await draw(f);
      if (my !== seq) return;
      renderPoints();
      refreshProbe();
      setStatus(""); // i modelli della mediana sono già nella riga della corsa ("8 modelli")
      prefetch();
      if (hoverMq.matches && extras().length) loadExtras(); // per il tooltip (sui touch solo aprendo un riquadro)
    } catch (e) {
      if (my !== seq) return;
      clearOverlay();
      current = null;
      renderPoints();
      setStatus(`Errore: ${e.message}`, true);
    } finally {
      if (my === seq) setLoading(false);
    }
  }

  // spinner del caricamento: compare solo se l'attesa supera 150 ms (con i dati in cache non lampeggia)
  let loadingTimer = null;
  // caricamento della mappa: rotellina nel pannello e linea animata sulla barra dell'ora (su mobile il pannello è
  // di solito chiuso), solo se l'attesa supera 150 ms (le immagini già in memoria non fanno lampeggiare nulla)
  function setLoading(on) {
    clearTimeout(loadingTimer);
    if (on)
      loadingTimer = setTimeout(() => {
        ui.loading.hidden = false;
        document.body.classList.add("field-loading");
      }, 150);
    else {
      ui.loading.hidden = true;
      document.body.classList.remove("field-loading");
    }
  }

  // ---------- località preferite: scelte dall'utente con la ricerca, salvate nel browser (localStorage).
  // Ognuna ha marcatore numerato + valore sulla mappa e una riga nell'elenco del pannello.
  const PLACES_KEY = "weathermaps.places.v1";
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
          .filter(
            (p) =>
              p &&
              typeof p.name === "string" &&
              Number.isFinite(p.lat) &&
              Number.isFinite(p.lon),
          );
      }
    } catch {
      /* storage non disponibile o dato rovinato: si parte vuoti */
    }
    return [];
  }
  function savePlaces() {
    try {
      localStorage.setItem(PLACES_KEY, JSON.stringify({ v: 1, places }));
    } catch {
      /* navigazione privata o storage pieno: le modifiche valgono finché resti sulla pagina */
    }
  }

  function inBox(lat, lon) {
    const b = meta.bbox;
    return (
      lat >= b.lat_min &&
      lat <= b.lat_max &&
      lon >= b.lon_min &&
      lon <= b.lon_max
    );
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
        html: `<span class="pt-num"></span><span class="pt-val"></span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const m = L.marker([p.lat, p.lon], {
        icon,
        keyboard: false,
        riseOnHover: true,
      })
        .on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          openPlacePop(idx);
        })
        .addTo(map);
      pointMarkers.push(m);

      const li = document.createElement("li");
      li.innerHTML = `<span class="pt-num"></span><span class="pt-name"></span><span class="pt-v"></span>`;
      if (editing) {
        // modifica: nome rinominabile al posto del testo, pulsante per eliminare al posto del valore
        const input = document.createElement("input");
        input.className = "pt-name pt-rename";
        input.value = p.name;
        input.maxLength = 60;
        input.setAttribute("aria-label", `Nome di ${p.name}`);
        input.addEventListener("change", () => {
          const name = input.value.trim();
          if (name) {
            p.name = name;
            savePlaces();
          } else input.value = p.name;
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
        li.addEventListener("click", () => {
          map.panTo([p.lat, p.lon]);
          openPlacePop(idx);
        });
      }
      ui.points.append(li);
      pointRows.push(li);
    });
    ui.placesEdit.hidden = !places.length;
    ui.placesEdit.textContent = editing ? "Fine" : "Modifica";
    ui.placesEdit.setAttribute("aria-pressed", String(editing));
    if (meta && variable()) renderPoints();
  }

  ui.placesEdit.addEventListener("click", () => {
    editing = !editing;
    setupPoints();
  });

  /** false se c'è già una località lì (dalla ricerca). custom: punto scelto sulla mappa, sempre aggiunto. */
  function addPlace(name, lat, lon, custom = false) {
    if (
      !custom &&
      places.some(
        (p) => Math.abs(p.lat - lat) < 0.005 && Math.abs(p.lon - lon) < 0.005,
      )
    ) {
      toast(`${name} è già fra le località.`);
      return false;
    }
    places.push({
      id: Date.now().toString(36),
      name,
      lat: +lat.toFixed(4),
      lon: +lon.toFixed(4),
    });
    savePlaces();
    setupPoints();
    return true;
  }

  // ricerca: Open-Meteo (GeoNames) e, di riserva, Photon (OpenStreetMap), limitata all'area della mappa e a località
  // abitate (città, paesi, frazioni), cime e passi: senza filtro "Sondrio" restituirebbe anche vie, stazioni e provincia.
  let searchTimer = null;
  let searchCtl = null;
  // la lista dei risultati sta fuori dal pannello (che scorre e la taglierebbe): in body, posizione fissa sotto il
  // campo di ricerca (sopra se sotto non c'è posto), alta al massimo quanto lo spazio libero nella finestra
  document.body.append(ui.placeResults);
  function placeResults() {
    if (ui.placeResults.hidden) return;
    const r = ui.placeQ.getBoundingClientRect();
    const M = 8,
      GAP = 4;
    const below = window.innerHeight - r.bottom - GAP - M;
    const above = r.top - GAP - M;
    const down = below >= 160 || below >= above;
    const el = ui.placeResults;
    el.style.left = `${Math.max(M, r.left)}px`;
    el.style.width = `${Math.min(r.width, window.innerWidth - 2 * M)}px`;
    el.style.maxHeight = `${Math.max(80, Math.min(down ? below : above, 236))}px`; // circa 5 risultati, poi scorre
    el.style.top = down ? `${r.bottom + GAP}px` : "";
    el.style.bottom = down ? "" : `${window.innerHeight - r.top + GAP}px`;
  }
  window.addEventListener("resize", placeResults);
  ui.placeQ.closest(".panel-body")?.addEventListener("scroll", placeResults);
  window.visualViewport?.addEventListener("resize", placeResults); // tastiera del telefono

  function hideResults() {
    clearTimeout(searchTimer);
    searchCtl?.abort();
    ui.placeQ.parentElement.classList.remove("searching");
    ui.placeResults.hidden = true;
    ui.placeResults.replaceChildren();
  }
  const PLACE_KINDS = { "natural:peak": "cima", "mountain_pass:yes": "passo" };
  function placeContext(pr) {
    const kind = pr.kind || PLACE_KINDS[`${pr.osm_key}:${pr.osm_value}`];
    return [
      kind,
      pr.city !== pr.name ? pr.city : null,
      pr.county,
      pr.state,
      pr.country !== "Italia" ? pr.country : null,
    ]
      .filter(Boolean)
      .filter((x, i, a) => a.indexOf(x) === i)
      .join(", ");
  }
  const setSearching = (on) =>
    ui.placeQ.parentElement.classList.toggle("searching", on);
  async function searchPlaces(q) {
    searchCtl?.abort();
    const ctl = (searchCtl = new AbortController());
    const timeout = setTimeout(
      () => ctl.abort(new Error("Search timed out")),
      10000,
    );
    const b = meta.bbox;
    const url =
      `https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: "8" })}` +
      `&bbox=${b.lon_min},${b.lat_min},${b.lon_max},${b.lat_max}` +
      "&osm_tag=place&osm_tag=natural:peak&osm_tag=mountain_pass";
    // prima Open-Meteo (GeoNames: città, paesi, cime e passi; risponde in meno di un secondo), poi Photon se non
    // trova niente o non risponde (OpenStreetMap, più completo ma spesso lentissimo: anche 40-50 secondi)
    const openMeteo = async () => {
      const params = new URLSearchParams({
        name: q,
        count: "100",
        language: "it",
        format: "json",
      });
      const r = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?${params}`,
        {
          signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(3500)]),
        },
      );
      if (!r.ok) throw new Error(r.statusText);
      const data = await r.json();
      return (data.results || []).map((location) => ({
        properties: {
          name: location.name,
          kind: { PK: "cima", PASS: "passo" }[location.feature_code],
          county: location.admin2,
          state: location.admin1,
          country: location.country,
        },
        geometry: { coordinates: [location.longitude, location.latitude] },
      }));
    };
    const photon = async () => {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(r.statusText);
      return (await r.json()).features || [];
    };
    try {
      let features = [];
      try {
        features = (await openMeteo()).filter((f) =>
          inBox(f.geometry.coordinates[1], f.geometry.coordinates[0]),
        );
      } catch (error) {
        if (ctl.signal.aborted) throw error;
      }
      if (!features.length) features = await photon();
      if (ctl.signal.aborted || ctl !== searchCtl) return;
      const items = features
        .map((f) => ({
          pr: f.properties || {},
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
        }))
        .filter((x) => x.pr.name && inBox(x.lat, x.lon))
        .slice(0, 8);
      if (!items.length) {
        ui.placeResults.innerHTML = `<li class="place-none">Nessun risultato nell'area della mappa</li>`;
      } else {
        ui.placeResults.replaceChildren(
          ...items.map(({ pr, lat, lon }) => {
            const li = document.createElement("li");
            li.setAttribute("role", "option");
            li.tabIndex = 0;
            li.innerHTML = `<span class="place-name"></span><span class="place-ctx"></span>`;
            li.querySelector(".place-name").textContent = pr.name;
            li.querySelector(".place-ctx").textContent = placeContext(pr);
            const pick = () => {
              addPlace(pr.name, lat, lon);
              ui.placeQ.value = "";
              hideResults();
            };
            li.addEventListener("click", pick);
            li.addEventListener("keydown", (e) => {
              if (e.key === "Enter") pick();
            });
            return li;
          }),
        );
      }
      ui.placeResults.hidden = false;
      placeResults();
      setSearching(false);
    } catch (e) {
      if (e.name === "AbortError" || ctl !== searchCtl) return;
      setSearching(false);
      ui.placeResults.innerHTML = `<li class="place-none">Ricerca non riuscita, riprova più tardi</li>`;
      ui.placeResults.hidden = false;
      placeResults();
    } finally {
      clearTimeout(timeout);
    }
  }
  ui.placeQ.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchCtl?.abort();
    const q = ui.placeQ.value.trim();
    if (q.length < 2) {
      searchCtl?.abort();
      setSearching(false);
      hideResults();
      return;
    }
    // subito uno stato di attesa: spinner nel campo e "Ricerca…" nell'elenco (Open-Meteo risponde in qualche decimo)
    setSearching(true);
    ui.placeResults.innerHTML =
      '<li class="place-none place-wait">Ricerca…</li>';
    ui.placeResults.hidden = false;
    placeResults();
    searchTimer = setTimeout(() => searchPlaces(q), 300);
  });
  ui.placeQ.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ui.placeQ.value = "";
      hideResults();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      ui.placeResults.querySelector("li[role=option]")?.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".places-search, .place-results")) hideResults();
  });

  function renderPoints() {
    const pts = places;
    if (pointMarkers.length !== pts.length) return; // all'avvio prima di setupPoints: le disegna lui
    if (state.extra !== "none" || synoptic()) {
      // radar o satellite: le località servono solo a orientarsi, niente valori del modello (sulla carta a 500 hPa
      // sono nascoste, vedi body.synoptic-mode .pt in style.css)
      pts.forEach((p, i) => {
        const el = pointMarkers[i].getElement();
        if (el) {
          el.querySelector(".pt-val").textContent = p.name; // sulla mappa il nome al posto del valore
          const n = el.querySelector(".pt-num");
          n.textContent = "";
          n.style.background = "";
          el.classList.remove("pt-dark");
        }
        const pv = pointRows[i].querySelector(".pt-v");
        if (pv) pv.textContent = "";
        const n = pointRows[i].querySelector(".pt-num");
        n.textContent = String(i + 1);
        n.style.background = "";
        n.classList.remove("pt-dark");
        pointMarkers[i].setZIndexOffset(0);
      });
      ui.points.append(...pointRows); // nell'ordine in cui sono state aggiunte, senza classifica
      pointOrder = pts.map((_, i) => i);
      closePlacePop();
      placePointLabels();
      return;
    }
    const dec = variable().decimals;
    const color = colorizer(variable().scale);
    const values = [];
    pts.forEach((p, i) => {
      const v = current ? valueAt(current, p.lat, p.lon) : null;
      const text = v == null ? "" : v.toFixed(dec); // senza valore niente trattini: l'etichetta si nasconde
      const c = v == null ? null : color(v);
      const el = pointMarkers[i].getElement();
      if (el) {
        // sulla mappa col simbolo attaccato (2575m, 8.2°C): compatto ma senza ambiguità
        el.querySelector(".pt-val").textContent =
          v == null ? text : `${text}${current.units}`;
        el.querySelector(".pt-num").style.background = c
          ? `rgb(${c.join(",")})`
          : "";
        el.classList.toggle(
          "pt-dark",
          !!c && c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 140,
        );
      }
      const pv = pointRows[i].querySelector(".pt-v"); // in modifica al suo posto c'è il pulsante elimina
      if (pv) pv.textContent = v == null ? "" : `${text} ${current.units}`;
      const n = pointRows[i].querySelector(".pt-num");
      n.style.background = c ? `rgb(${c.join(",")})` : "";
      n.classList.toggle(
        "pt-dark",
        !!c && c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 140,
      );
      values[i] = v;
    });
    // classifica: dal valore più alto; a parità stessa posizione (1, 2, 2, 4), i "—" in fondo senza numero.
    // Si confrontano i valori arrotondati come mostrati, così due "2.4" hanno la stessa posizione.
    const shown = values.map((v) =>
      v == null ? null : Number(v.toFixed(dec)),
    );
    // direzione dalla grandezza: "desc" = più alto primo (pioggia), "asc" = più basso primo (temperatura)
    const sign = variable().rank === "asc" ? -1 : 1;
    const key = (i) => (shown[i] == null ? -Infinity : sign * shown[i]);
    const order = pts.map((_, i) => i).sort((a, b) => key(b) - key(a) || a - b);
    let rank = 0;
    order.forEach((i, pos) => {
      if (shown[i] == null) rank = null;
      else if (pos === 0 || shown[i] !== shown[order[pos - 1]]) rank = pos + 1;
      const label = rank == null ? "" : String(rank);
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

  // il clic su una località apre sempre lo stesso riquadro con i valori (anche sulla carta a 500 hPa); da lì il grafico
  // nel tempo e, se il modello scelto ha l'ensemble (GFS, ECMWF), gli spaghetti
  // telefono in orizzontale: località e menu del punto si toccano come in verticale (per aprire i grafici; se si
  // vedono male si ruota il telefono); niente tooltip del valore al tocco
  const landscapeView = () => document.body.classList.contains("landscape-view");
  function openPlacePop(idx) {
    if (synoptic()) return; // sulla carta a 500 hPa le località non si mostrano
    if (state.extra !== "none") return; // con radar o satellite il riquadro dei valori del modello non serve
    popIdx = idx;
    ui.probe.hidden = true;
    probeLL = null; // col riquadro aperto niente tooltip del valore
    renderPlacePop();
  }
  function closePlacePop() {
    popIdx = null;
    pop.hidden = true;
    markPoppedPoint();
  }
  // l'etichetta bianca della località col riquadro aperto si nasconde (stesso valore, sarebbe un doppione)
  function markPoppedPoint() {
    pointMarkers.forEach((m, i) =>
      m.getElement()?.classList.toggle("pt-popped", i === popIdx),
    );
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
      getField(step, "value", { ...ctxNow(), var: d.var })
        .catch(() => null)
        .then((f) => {
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
    if (popIdx == null || !p || !meta || !variable()) {
      closePlacePop();
      return;
    }
    const v = variable();
    const esc = (t) =>
      String(t).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
      );
    const val = current ? valueAt(current, p.lat, p.lon) : null;
    const modeLabel = modePhrase() ? ` ${modePhrase()}` : "";
    const rows = [
      [
        `${baseLabel()}${modeLabel}`,
        val == null ? "—" : `${val.toFixed(v.decimals)} ${current.units}`,
      ],
    ];
    if (v.contour_field && currentContour) {
      const z = valueAt(currentContour, p.lat, p.lon);
      rows.push([
        contourName(),
        z == null ? "—" : `${Math.round(z)} ${currentContour.units}`,
      ]);
    }
    if (current?.u) {
      const d = windDirAt(current, p.lat, p.lon);
      rows.push(["Direzione", d == null ? "—" : `da ${d.name} (${d.deg}°)`]);
    }
    // grandezze in più (sulla mappa della T850 l'altezza della superficie di 850 hPa)
    loadExtras();
    for (const d of extras()) {
      const x = extraValue(d, p.lat, p.lon);
      rows.push([d.label, x === undefined ? "…" : (x ?? "—")]);
    }
    const foot =
      state.run && state.step != null
        ? fmtShown()
        : "";
    pop.innerHTML =
      `<div class="pt-pop-head"><strong>${esc(p.name)}</strong>` +
      `<button type="button" class="pt-pop-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div>` +
      rows
        .filter(([, x]) => x !== "—")
        .map(
          ([k, x]) =>
            `<div class="pt-pop-row"><span>${esc(k)}</span><b>${esc(x)}</b></div>`,
        )
        .join("") + // senza valore la riga non c'è
      (foot ? `<div class="pt-pop-foot">${esc(foot)}</div>` : "") +
      // pulsanti affiancati: grafico nel tempo e, se il modello ha l'ensemble, gli spaghetti
      (meta.series && state.run || meta.ensemble?.[state.model]
        ? '<div class="pt-pop-btns">' +
          (meta.series && state.run
            ? '<button type="button" class="pt-pop-chart" title="Grafico nel tempo">Grafico</button>'
            : "") +
          (meta.ensemble?.[state.model]
            ? '<button type="button" class="pt-pop-chart pt-pop-ens" title="Spaghetti dell\'ensemble">Ens</button>'
            : "") +
          (meta.series
            ? '<button type="button" class="pt-pop-chart pt-pop-multi" title="Precipitazione e temperatura a 850 hPa di tutti i modelli">Multimodel</button>'
            : "") +
          "</div>"
        : "") +
      `<i class="pt-pop-arrow"></i>`;
    pop.querySelector(".pt-pop-close").addEventListener("click", closePlacePop);
    pop
      .querySelector(".pt-pop-multi")
      ?.addEventListener("click", () => openChart(p, { multi: "tp" }));
    pop
      .querySelector(".pt-pop-chart:not(.pt-pop-ens):not(.pt-pop-multi)")
      ?.addEventListener("click", () => openChart(p));
    pop
      .querySelector(".pt-pop-ens")
      ?.addEventListener("click", () => openChart(p, { ensemble: true, model: state.model }));
    pop.hidden = false;
    markPoppedPoint();
    placePlacePop();
  }

  /** Posizione: centrata sul punto, sopra (o sotto), spostata di lato quanto serve per restare nella finestra. */
  function placePlacePop() {
    if (popIdx == null || pop.hidden) return;
    const p = places[popIdx];
    if (!p) {
      closePlacePop();
      return;
    }
    const mr = map.getContainer().getBoundingClientRect();
    const c = map.latLngToContainerPoint([p.lat, p.lon]);
    const x = mr.left + c.x,
      y = mr.top + c.y;
    const W = window.innerWidth,
      H = window.innerHeight;
    // punto fuori dalla finestra: niente riquadro appeso al nulla
    if (x < 0 || x > W || y < 0 || y > H) {
      pop.style.visibility = "hidden";
      return;
    }
    pop.style.visibility = "";
    const w = pop.offsetWidth,
      h = pop.offsetHeight;
    const below =
      y - POP_GAP - h < POP_MARGIN && y + POP_GAP + h <= H - POP_MARGIN;
    let top = below ? y + POP_GAP : y - POP_GAP - h;
    top = Math.min(Math.max(top, POP_MARGIN), H - POP_MARGIN - h);
    const left = Math.min(
      Math.max(x - w / 2, POP_MARGIN),
      Math.max(POP_MARGIN, W - POP_MARGIN - w),
    );
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.classList.toggle("below", below);
    // la freccia resta sul punto anche quando il riquadro è spostato di lato
    pop.querySelector(".pt-pop-arrow").style.left =
      `${Math.min(Math.max(x - left, 12), w - 12)}px`;
  }
  map.on("move zoom", placePlacePop);
  map.on("click", closePlacePop);
  window.addEventListener("resize", placePlacePop);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePlacePop();
  });

  // ---------- posizione delle etichette delle località: a destra se c'è posto, se no a sinistra, sopra o sotto;
  // se nessun lato è libero il valore si nasconde (resta il numero; il valore è nell'elenco e nel tooltip).
  // Si sceglie in ordine di classifica: i primi hanno la precedenza.
  let pointOrder = [];
  const PT_SIDES = ["right", "left", "above", "below"];
  const PT_R = 12; // raggio del cerchio (con il bordo)
  const PT_GAP = 18; // distanza dell'etichetta dal centro (come nel CSS: 29px dal bordo del marcatore di 22px)
  function placePointLabels() {
    const overlaps = (a, b) =>
      a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    const items = pointMarkers.map((m) => {
      const el = m.getElement();
      if (!el) return null;
      el.classList.remove("pt-noval"); // per misurare l'etichetta deve essere visibile
      const c = map.latLngToContainerPoint(m.getLatLng());
      const val = el.querySelector(".pt-val");
      return { el, c, w: val.offsetWidth, h: val.offsetHeight };
    });
    // ostacoli: tutti i cerchi, poi via via le etichette già sistemate
    const taken = items.filter(Boolean).map(({ c }) => ({
      x1: c.x - PT_R,
      x2: c.x + PT_R,
      y1: c.y - PT_R,
      y2: c.y + PT_R,
    }));
    const order =
      pointOrder.length === items.length ? pointOrder : items.map((_, i) => i);
    for (const i of order) {
      const it = items[i];
      if (!it) continue;
      const { c, w, h } = it;
      const box = {
        right: {
          x1: c.x + PT_GAP,
          x2: c.x + PT_GAP + w,
          y1: c.y - h / 2,
          y2: c.y + h / 2,
        },
        left: {
          x1: c.x - PT_GAP - w,
          x2: c.x - PT_GAP,
          y1: c.y - h / 2,
          y2: c.y + h / 2,
        },
        above: {
          x1: c.x - w / 2,
          x2: c.x + w / 2,
          y1: c.y - PT_GAP - h,
          y2: c.y - PT_GAP,
        },
        below: {
          x1: c.x - w / 2,
          x2: c.x + w / 2,
          y1: c.y + PT_GAP,
          y2: c.y + PT_GAP + h,
        },
      };
      const side = PT_SIDES.find(
        (k) => !taken.some((t) => overlaps(box[k], t)),
      );
      for (const k of PT_SIDES)
        it.el.classList.toggle(`pt-${k}`, k === (side || "right"));
      it.el.classList.toggle("pt-noval", !side);
      if (side) taken.push(box[side]);
    }
  }
  map.on("zoomend", placePointLabels);

  // ---------- condivisione: immagine della mappa che si sta guardando
  const shareUi = {
    btn: $("share"),
    toast: $("share-toast"),
    dialog: $("share-dialog"),
    canvas: $("share-canvas"),
    send: $("share-send"),
    download: $("share-download"),
    close: $("share-close"),
    zoomIn: $("share-zoom-in"),
    zoomOut: $("share-zoom-out"),
    ratio: $("share-ratio"),
    points: $("share-points"),
    pointsRow: $("share-points-row"),
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
  const RATIOS = {
    "4:3": [1600, 1200],
    "1:1": [1200, 1200],
    "16:9": [1600, 900],
  };
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
      if (
        r.right < cr.left ||
        r.left > cr.right ||
        r.bottom < cr.top ||
        r.top > cr.bottom
      )
        return;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, r.left - cr.left, r.top - cr.top, r.width, r.height);
      ctx.globalAlpha = 1;
    };
    const drawTiles = (pane) => {
      const levels = [...pane.querySelectorAll(".leaflet-tile-container")].sort(
        (a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0),
      );
      for (const lvl of levels)
        for (const img of lvl.querySelectorAll("img.leaflet-tile-loaded"))
          drawImg(img);
    };
    drawTiles(map.getPane("tilePane"));
    if (glBase && glShot) {
      // sfondo Mapbox con colori, confini e nomi: la copia fatta da glCapture
      const r = glBase.getCanvas().getBoundingClientRect();
      ctx.drawImage(
        glShot,
        r.left - cr.left,
        r.top - cr.top,
        r.width,
        r.height,
      );
    }
    if (overlay?.getElement() && state.extra === "none") {
      ctx.imageSmoothingEnabled = !state.crisp;
      drawImg(overlay.getElement(), state.opacity);
      ctx.imageSmoothingEnabled = true;
    }
    if (extraCfg()) {
      // radar o satellite sopra la mappa, come nella pagina
      ctx.globalAlpha = extraCfg().opacity;
      const shown = radarFrames[radarIdx]?.layer.getElement?.();
      if (shown) drawImg(shown, extraCfg().opacity);
      ctx.globalAlpha = 1;
    }
    // isoterme: il canvas delle linee e le etichette (testo con alone bianco, come sullo schermo)
    const bordersCanvas = map.getPane("borders").querySelector("canvas");
    if (bordersCanvas && bordersOn() && !glBase) {
      // con Mapbox i confini sono già nel suo canvas
      const r = bordersCanvas.getBoundingClientRect();
      ctx.globalAlpha = state.bordersOpacity; // come nella pagina
      ctx.drawImage(
        bordersCanvas,
        r.left - cr.left,
        r.top - cr.top,
        r.width,
        r.height,
      );
      ctx.globalAlpha = 1;
    }
    // carta sinottica: coste e stati sono linee nostre anche con Mapbox (vedi styleSynBorders)
    const synCanvas = map.getPane("synBorders").querySelector("canvas");
    if (synCanvas && synoptic() && state.borders !== "none") {
      const r = synCanvas.getBoundingClientRect();
      ctx.globalAlpha = state.bordersOpacity;
      ctx.drawImage(synCanvas, r.left - cr.left, r.top - cr.top, r.width, r.height);
      ctx.globalAlpha = 1;
    }
    const arrowsCanvas = map.getPane("arrows").querySelector("canvas");
    if (
      arrowsCanvas &&
      (current?.u || currentArrows) &&
      state.extra === "none"
    ) {
      const r = arrowsCanvas.getBoundingClientRect();
      ctx.drawImage(
        arrowsCanvas,
        r.left - cr.left,
        r.top - cr.top,
        r.width,
        r.height,
      );
    }
    const isoCanvas = map.getPane("contours").querySelector("canvas");
    if (isoCanvas && isoData.length && state.extra === "none") {
      const r = isoCanvas.getBoundingClientRect();
      ctx.drawImage(
        isoCanvas,
        r.left - cr.left,
        r.top - cr.top,
        r.width,
        r.height,
      );
    }
    for (const el of map
      .getPane("contourLabels")
      .querySelectorAll(".iso-lbl span")) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const x = r.left - cr.left + r.width / 2,
        y = r.top - cr.top + r.height / 2;
      ctx.lineWidth = 3;
      // ombra nera sotto le etichette bianche della carta sinottica, alone chiaro sotto quelle scure
      ctx.strokeStyle = synoptic() ? "rgba(0,0,0,0.9)" : "rgba(255,255,255,0.9)";
      ctx.lineJoin = "round";
      ctx.strokeText(el.textContent, x, y);
      ctx.fillStyle = cs.color;
      ctx.fillText(el.textContent, x, y);
    }
    // punti: centro del cerchio e posizione del valore rispetto al centro (come sullo schermo)
    const points = [];
    for (const m of synoptic() ? [] : pointMarkers) {
      const el = m.getElement();
      if (!el) continue;
      const num = el.querySelector(".pt-num");
      const val = el.querySelector(".pt-val");
      const nr = num.getBoundingClientRect();
      const vr = val.getBoundingClientRect();
      const hidden =
        el.classList.contains("pt-noval") || el.classList.contains("pt-popped");
      const x = nr.left - cr.left + nr.width / 2;
      const y = nr.top - cr.top + nr.height / 2;
      const cs = getComputedStyle(num);
      points.push({
        side: PT_SIDES.find((k) => el.classList.contains(`pt-${k}`)) || "right",
        x,
        y,
        num: num.textContent,
        val: hidden ? "" : val.textContent,
        bg: cs.backgroundColor || "#fff",
        fg: cs.color,
        dx: vr.left - cr.left - x,
        dy: vr.top - cr.top - y,
        w: vr.width,
        h: vr.height,
      });
    }
    return { canvas, W, H, scale, points };
  }

  /** Testi dell'immagine e nome del file, calcolati una volta all'apertura. */
  function shareTexts() {
    const v = variable();
    const s = state.step;
    const valid = new Date(runDate(state.run).getTime() + s * 3600e3);
    const modeText =
      state.mode === "interval"
        ? ` in ${intervalHours(s)}h (+${s - intervalHours(s)}h → +${s}h)`
        : state.mode === "total"
          ? " totale"
          : "";
    const runText =
      state.model === "mean"
        ? `${cycle(state.run)} ${fmtRunDay(state.run)}`
        : `corsa ${cycle(state.run)} ${fmtRunDay(state.run)}`;
    const baseAttr = glBase
      ? "Mappa © Mapbox, dati © OpenStreetMap contributors"
      : map.hasLayer(bases.topo)
        ? "Mappa © Thunderforest, dati © OpenStreetMap contributors"
        : "Mappa © OpenStreetMap contributors";
    if (extraCfg()) {
      // radar o satellite: l'immagine è del livello extra (ora dell'immagine mostrata), con la sua legenda
      const cfg = extraCfg(),
        f = radarFrames[radarIdx];
      const t = f ? new Date(f.time) : new Date();
      const v =
        state.extra === "radar"
          ? {
              units: "mm/h",
              scale: {
                thresholds: RADAR_CLASSES.map(([x]) => x),
                colors: RADAR_CLASSES.map(([, c]) => c),
                transparent_below: RADAR_CLASSES[0][0],
              },
            }
          : {
              units: "Nubi",
              scale: {
                continuous: true,
                thresholds: ["basse", "", "alte"],
                colors: SAT_SHADES,
              },
            };
      return {
        v,
        title: cfg.shareTitle,
        sub: `${cfg.shareSub} · ${fmtLocal(t)}`,
        attr: `${baseAttr} · ${cfg.credit} · ${location.host}${location.pathname}`,
        name: `weathermaps-${state.extra}-${t.toISOString().slice(0, 16).replace(/[-:T]/g, "")}.jpg`,
      };
    }
    return {
      v,
      title: `${modelLabel()} · ${runText}`,
      sub: `${baseLabel()}${modeText} (${v.units})${isoNote()} · +${s}h · ${fmtShown(s)}`,
      // l'attribuzione di OpenStreetMap è obbligatoria anche sulle immagini
      attr: `${baseAttr} · Dati: NOAA, ECMWF, ItaliaMeteo, CIMA, LaMMA, DWD, Météo-France, MeteoSvizzera · ${location.host}${location.pathname}`,
      name: `weathermaps-${state.model}-${state.var}-${state.run}-${String(s).padStart(3, "0")}.jpg`,
    };
  }

  // ritaglio in coordinate della mappa fotografata (px dello schermo); l'altezza segue le proporzioni
  // touched = l'utente ha già spostato o ridimensionato il riquadro (la posizione GPS non lo sposta più)
  const crop = {
    snap: null,
    texts: null,
    ratio: "4:3",
    x: 0,
    y: 0,
    w: 0,
    touched: false,
    fixed: false, // carta a 500 hPa: inquadratura fissa (come Meteociel), niente proporzioni né zoom né trascinamento
    savedRatio: null,
  };
  const ratioOf = () => RATIOS[crop.ratio][0] / RATIOS[crop.ratio][1];
  const cropH = () => crop.w / ratioOf();
  const maxCropW = () => Math.min(crop.snap.W, crop.snap.H * ratioOf());
  const clampW = (w) =>
    Math.min(maxCropW(), Math.max(maxCropW() * MIN_FRACTION, w));

  function clampCrop() {
    crop.w = clampW(crop.w);
    crop.x = Math.min(Math.max(crop.x, 0), crop.snap.W - crop.w);
    crop.y = Math.min(Math.max(crop.y, 0), crop.snap.H - cropH());
  }

  /** Ridimensiona il riquadro di `factor` tenendo fermo il punto (mx, my) della mappa. */
  function scaleCropAt(
    factor,
    mx = crop.x + crop.w / 2,
    my = crop.y + cropH() / 2,
  ) {
    // già al massimo e si allontana ancora: si allarga la mappa sotto il riquadro (zoom indietro e nuova foto)
    if (factor > 1 && crop.w >= maxCropW() - 0.5) {
      widenShare(factor);
      return;
    }
    // si allontana oltre il massimo: il riquadro arriva al massimo e il resto diventa zoom indietro della mappa
    if (factor > 1 && crop.w * factor > maxCropW() * 1.05) {
      const rest = (crop.w * factor) / maxCropW();
      scaleCropAt(maxCropW() / crop.w, mx, my);
      widenShare(rest);
      return;
    }
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
    ctx.drawImage(
      snap.canvas,
      crop.x * snap.scale,
      crop.y * snap.scale,
      crop.w * snap.scale,
      cropH() * snap.scale,
      0,
      0,
      OW,
      OH,
    );

    // punti a grandezza fissa
    const k = PT_SCALE;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // con radar e satellite le località hanno il nome al posto del valore (come sulla mappa)
    // condividendo un punto dal menu della mappa si vede solo quello, mai le località
    for (const p of shareUi.points.checked && !snap.pin ? snap.points : []) {
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
        const t = 5 * k,
          w = p.w * k,
          h = p.h * k;
        const tri = {
          right: [
            [vx, vy + h / 2 - t],
            [vx - t, vy + h / 2],
            [vx, vy + h / 2 + t],
          ],
          left: [
            [vx + w, vy + h / 2 - t],
            [vx + w + t, vy + h / 2],
            [vx + w, vy + h / 2 + t],
          ],
          above: [
            [vx + w / 2 - t, vy + h],
            [vx + w / 2, vy + h + t],
            [vx + w / 2 + t, vy + h],
          ],
          below: [
            [vx + w / 2 - t, vy],
            [vx + w / 2, vy - t],
            [vx + w / 2 + t, vy],
          ],
        }[p.side];
        ctx.beginPath();
        ctx.moveTo(...tri[0]);
        ctx.lineTo(...tri[1]);
        ctx.lineTo(...tri[2]);
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

    // punto scelto dal menu della mappa: segnaposto e, sopra, il valore (fuori dal riquadro non si disegna)
    if (snap.pin) {
      const k = PT_SCALE,
        px = (snap.pin.x - crop.x) * s,
        py = (snap.pin.y - crop.y) * s;
      if (px >= 0 && px <= OW && py >= 0 && py <= OH) {
        if (crop.pinText) {
          // grande quanto il sottotitolo dell'intestazione (22px): l'immagine è larga 1600px e si guarda rimpicciolita
          ctx.font = `650 ${15 * k}px ${FONT}`;
          const bw = ctx.measureText(crop.pinText).width + 22 * k,
            bh = 30 * k,
            t = 7 * k;
          const bx = Math.min(Math.max(px - bw / 2, 6), OW - bw - 6);
          const below = py - 14 * k - t - bh < 6; // troppo in alto: l'etichetta va sotto
          const by = below ? py + 14 * k + t : py - 14 * k - t - bh;
          ctx.fillStyle = "rgba(0,0,0,0.25)";
          roundRect(ctx, bx, by + 3, bw, bh, 7 * k);
          ctx.fill();
          ctx.fillStyle = "#1d2330";
          roundRect(ctx, bx, by, bw, bh, 7 * k);
          ctx.fill();
          ctx.beginPath();
          const ty = below ? by : by + bh;
          ctx.moveTo(px - t, ty);
          ctx.lineTo(px, below ? ty - t : ty + t);
          ctx.lineTo(px + t, ty);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(crop.pinText, bx + bw / 2, by + bh / 2 + 1);
        }
        // come sulla mappa: centro bianco, anello scuro e alone bianco (si vede su qualunque colore)
        ctx.beginPath();
        ctx.arc(px, py, 11 * k, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 9 * k, 0, Math.PI * 2);
        ctx.fillStyle = "#1d2330";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 4.5 * k, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
      }
    }

    // intestazione in alto a sinistra: bandiera, modello e corsa, grandezza e istante
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    // bandiera del modello (già caricata, vedi loadFlag); con radar o satellite l'immagine non è del modello: niente
    const flag = state.extra === "none" ? crop.flag : null;
    const fh = 26,
      fw = flag
        ? Math.round(fh * (flag.naturalWidth / flag.naturalHeight || 4 / 3))
        : 0;
    const fx = flag ? fw + 12 : 0; // spazio occupato dalla bandiera prima del titolo
    ctx.font = `700 30px ${FONT}`;
    const tw = ctx.measureText(texts.title).width + fx;
    ctx.font = `500 22px ${FONT}`;
    const sw = ctx.measureText(texts.sub).width;
    const hw = Math.min(OW - 48, Math.max(tw, sw) + 40);
    ctx.fillStyle = "rgba(255,255,255,0.93)";
    roundRect(ctx, 24, 24, hw, 94, 14);
    ctx.fill();
    if (flag) {
      ctx.drawImage(flag, 44, 42, fw, fh);
      if (flag.dataset.border) {
        // bandiere: bordino grigio come nella select (il bianco non si perde nel fondo)
        ctx.strokeStyle = "rgba(29,35,48,0.25)";
        ctx.lineWidth = 1;
        ctx.strokeRect(44.5, 42.5, fw - 1, fh - 1);
      }
    }
    ctx.fillStyle = "#1d2330";
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText(texts.title, 44 + fx, 66, hw - 40 - fx);
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
    // la barra si ferma prima di "Realizzato da signalkuppe.com" (a destra sulla stessa riga)
    ctx.font = `700 15px ${FONT}`;
    let creditW = ctx.measureText("signalkuppe.com").width;
    ctx.font = `400 15px ${FONT}`;
    creditW += ctx.measureText("Realizzato da ").width;
    const cw = Math.min(64, (OW - lx - 24 - creditW - 32) / nseg);
    const ly = OH - BAND + 16;
    const every = thresholds.length > 14 ? 2 : 1; // come nella legenda della pagina
    ctx.font = `500 15px ${FONT}`;
    thresholds.forEach((t, i) => {
      if (i < nseg) {
        if (cont) {
          const g = ctx.createLinearGradient(
            lx + i * cw,
            0,
            lx + (i + 1) * cw,
            0,
          );
          g.addColorStop(0, colors[i]);
          g.addColorStop(1, colors[i + 1]);
          ctx.fillStyle = g;
        } else ctx.fillStyle = colors[i];
        ctx.fillRect(lx + i * cw, ly, cw + (cont ? 0.5 : 0), 16);
      }
      ctx.fillStyle = "#3d4656";
      ctx.textAlign =
        i === 0
          ? "left"
          : i === thresholds.length - 1 && cont
            ? "right"
            : "center";
      const skip =
        (i === 0 && !cont && texts.v.scale.transparent_below == null) ||
        i % every;
      // pioggia e radar partono da 0, come nella legenda della pagina
      const zero = i === 0 && (t === 0.1 || texts.v.units === "mm/h");
      if (!skip)
        ctx.fillText(
          zero ? "0" : String(t).replace("-", "−"),
          lx + i * cw,
          ly + 36,
        );
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
    view.fw = Math.max(
      1,
      Math.min(r.width - 2 * FRAME_PAD, (r.height - 2 * FRAME_PAD) * ratio),
    );
    view.fh = view.fw / ratio;
    view.fx = (r.width - view.fw) / 2;
    view.fy = (r.height - view.fh) / 2;
  }
  const viewScale = () => view.fw / crop.w; // px della vista per px della mappa
  function renderView() {
    if (shareUi.dialog.classList.contains("share-preparing")) return; // foto non ancora pronta
    renderOut();
    const ctx = shareUi.canvas.getContext("2d");
    const { snap } = crop;
    const fs = viewScale();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.cw, view.ch);
    ctx.imageSmoothingQuality = "high";
    if (crop.fixed) {
      // inquadratura fissa: solo l'immagine finale, senza la mappa intorno né la cornice del ritaglio
      ctx.drawImage(outCanvas, view.fx, view.fy, view.fw, view.fh);
      return;
    }
    // mappa intera nella stessa scala del riquadro, così fuori si vede il contesto
    ctx.drawImage(
      snap.canvas,
      view.fx - crop.x * fs,
      view.fy - crop.y * fs,
      snap.W * fs,
      snap.H * fs,
    );
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
      requestAnimationFrame(() => {
        renderPending = false;
        renderView();
      });
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
        outCanvas.toBlob(
          (blob) => {
            shareFile = new File([blob], crop.texts.name, {
              type: "image/jpeg",
            });
            res(shareFile);
          },
          "image/jpeg",
          0.9,
        );
      });
    });
  }
  async function readyShareFile() {
    if (shareFile) return shareFile;
    clearTimeout(fileTimer);
    return makeShareFile();
  }

  // bandiera del modello per l'intestazione dell'immagine: lo stesso SVG di flag-icons usato nella pagina (letto dal
  // CSS), per la mediana l'icona "layers"; caricata una volta per modello
  const flagCache = new Map();
  function loadFlag(modelId, ink = "#1d2330") {
    // ink: colore dell'icona della mediana
    const key = `${modelId}|${ink}`;
    if (!flagCache.has(key)) {
      const m = meta.models.find((x) => x.id === modelId);
      let url = null,
        border = false;
      if (m?.country) {
        const probe = document.createElement("span");
        probe.className = `fi fi-${m.country}`;
        probe.style.cssText = "position:absolute;visibility:hidden";
        document.body.append(probe);
        url =
          getComputedStyle(probe).backgroundImage.match(
            /url\(["']?([^"')]+)["']?\)/,
          )?.[1] || null;
        probe.remove();
        border = true;
      } else if (modelId === "mean") {
        url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LAYERS_ICON.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" ').replace(/currentColor/g, ink))}`;
      }
      flagCache.set(
        key,
        !url
          ? Promise.resolve(null)
          : new Promise((resolve) => {
              const img = new Image();
              img.crossOrigin = "anonymous"; // senza, il canvas diventerebbe "sporco" e non si potrebbe esportare
              if (border) img.dataset.border = "1";
              img.onload = () => resolve(img);
              img.onerror = () => resolve(null);
              img.src = url;
            }),
      );
    }
    return flagCache.get(key);
  }

  // vista della mappa all'apertura della condivisione: se dalla finestra si allontana oltre la mappa che stavi
  // guardando, la mappa si allarga sotto (zoom indietro) e alla chiusura torna dov'era
  let shareRestore = null,
    widening = false,
    widenMore = 1; // widenMore: zoom indietro chiesti durante una foto
  /** Aspetta che Mapbox (o le tessere) abbia disegnato la vista nuova, al massimo 2 s, più un paio di fotogrammi per
   *  le linee e le località di Leaflet. */
  function mapReady() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      };
      const t = setTimeout(done, 2000);
      if (glBase) {
        const m = glBase;
        if (m.loaded() && m.areTilesLoaded()) done();
        else m.once("idle", done);
        return;
      }
      const layer = bases[state.base];
      if (!layer.isLoading?.()) done();
      else layer.once("load", done);
    });
  }
  async function takeSnap() {
    glShot = glBase ? await glCapture() : null;
    crop.snap = snapshotMap();
    glShot = null;
    // punto scelto dal menu della mappa: posizione nella foto (cambia se la foto si allarga, vedi widenShare)
    crop.snap.pin = crop.pinLL ? map.latLngToContainerPoint(crop.pinLL) : null;
  }
  /** Zoom indietro sotto il riquadro: la mappa si allontana di un livello attorno al centro del riquadro, si rifà la
   *  foto e il riquadro copre la stessa zona di prima (poi `factor` più largo). */
  async function widenShare(factor) {
    if (widening) {
      widenMore *= factor;
      return;
    } // si applica appena finita la foto in corso
    if (map.getZoom() <= map.getMinZoom() + 0.01) return;
    widening = true;
    try {
      const center = map.containerPointToLatLng([
        crop.x + crop.w / 2,
        crop.y + cropH() / 2,
      ]);
      const zoom = Math.max(map.getMinZoom(), map.getZoom() - 1);
      const shrink = map.getZoomScale(zoom, map.getZoom()); // < 1: quanto si rimpicciolisce la stessa zona
      shareRestore ??= { center: map.getCenter(), zoom: map.getZoom() };
      map.setView(center, zoom, { animate: false });
      await mapReady();
      await takeSnap();
      const p = map.latLngToContainerPoint(center);
      crop.w = clampW(crop.w * shrink * factor);
      crop.x = p.x - crop.w / 2;
      crop.y = p.y - cropH() / 2;
      clampCrop();
      shareUi.pointsRow.hidden = !crop.snap.points.length || !!crop.pinLL;
      layoutView();
      scheduleRender();
    } finally {
      widening = false;
    }
    if (widenMore > 1) {
      const f = widenMore;
      widenMore = 1;
      scaleCropAt(f);
    }
  }

  /** pin: { latlng, text } dal menu della mappa: segnaposto ed etichetta del valore nell'immagine */
  async function openShare(pin = null) {
    crop.pinLL = pin?.latlng || null;
    crop.pinText = pin?.text || "";
    crop.flag = null;
    const model = state.model;
    loadFlag(model).then((img) => {
      if (state.model === model) {
        crop.flag = img;
        scheduleRender();
      }
    });
    // si parte dalla mappa così come la stai guardando (stessa zona e stesso zoom): niente posizione del dispositivo
    shareRestore = null;
    widenMore = 1;
    crop.fixed = synoptic();
    shareUi.dialog.classList.toggle("share-fixed", crop.fixed);
    if (crop.fixed) {
      // carta a 500 hPa: la mappa sotto si ridimensiona e si sposta per l'inquadratura fissa; la finestra si apre
      // subito (con "Preparazione…") così non si vede la mappa muoversi
      shareUi.dialog.classList.add("share-preparing");
      if (!shareUi.dialog.open) shareUi.dialog.showModal();
    }
    await shareWideStart();
    if (crop.fixed && !shareWide) {
      // carta a 500 hPa: la mappa mostra tutta l'inquadratura fissa; alla chiusura torna dov'era
      shareRestore = { center: map.getCenter(), zoom: map.getZoom() };
      map.fitBounds(SYN_FRAME, { animate: false });
      await mapReady();
    }
    await takeSnap();
    crop.texts = shareTexts();
    // all'apertura il riquadro più grande che sta nella mappa, al centro (la proporzione resta l'ultima scelta)
    if (crop.fixed && crop.ratio !== "16:9") {
      crop.savedRatio = crop.ratio; // si ritrova alla prossima condivisione delle altre mappe
      crop.ratio = "16:9";
    }
    [outCanvas.width, outCanvas.height] = RATIOS[crop.ratio];
    crop.w = maxCropW();
    const c = crop.snap.pin || { x: crop.snap.W / 2, y: crop.snap.H / 2 };
    crop.x = c.x - crop.w / 2;
    crop.y = c.y - cropH() / 2;
    if (crop.fixed) {
      // riquadro 16:9 largo quanto l'inquadratura fissa, centrato in altezza su di lei
      const nw = map.latLngToContainerPoint(SYN_FRAME.getNorthWest()),
        se = map.latLngToContainerPoint(SYN_FRAME.getSouthEast());
      crop.w = se.x - nw.x;
      crop.x = nw.x;
      crop.y = (nw.y + se.y) / 2 - cropH() / 2;
    }
    clampCrop();
    crop.touched = false;
    shareUi.pointsRow.hidden = !crop.snap.points.length || !!crop.pinLL;
    // località: con le mappe dei modelli accese (valori), con radar e satellite spente (si accendono dall'interruttore)
    shareUi.points.checked = state.extra === "none" && !synoptic();
    if (crop.fixed && !shareUi.dialog.open) return; // chiusa mentre si preparava (la mappa è già tornata dov'era)
    shareUi.dialog.classList.remove("share-preparing");
    if (!shareUi.dialog.open) shareUi.dialog.showModal();
    layoutView();
    setRatio(crop.ratio);
  }

  // alla chiusura (X, Esc, dopo la condivisione) la mappa torna dov'era, se nella finestra ci si è allontanati
  shareUi.dialog.addEventListener("close", () => {
    shareUi.dialog.classList.remove("share-preparing");
    if (shareRestore)
      map.setView(shareRestore.center, shareRestore.zoom, { animate: false });
    shareRestore = null;
    shareWideEnd();
    if (crop.savedRatio) {
      crop.ratio = crop.savedRatio;
      crop.savedRatio = null;
    }
  });

  // Carta sinottica: con la finestra di condivisione aperta la mappa, nascosta sotto, diventa 1600×900 e si inquadra
  // su SYN_FRAME, su qualunque schermo; alla chiusura torna com'era.
  let shareWide = null;
  // inquadratura dell'immagine della carta a 500 hPa, come Meteociel: da Terranova al Mar Nero, dal Nord Africa
  // all'Islanda (Italia a destra), 16:9
  // più a sud del centro "geografico": in basso l'immagine ha sopra la mappa la barra dei colori e i crediti (~12%
  // dell'altezza), che coprirebbero il Mediterraneo; il 16:9 ne prende ~25–66 N
  const SYN_FRAME = L.latLngBounds([26, -60], [66, 40]);
  async function shareWideStart() {
    if (!synoptic()) return;
    // sempre la stessa mappa 1600×900 sotto la finestra (qualunque schermo): l'inquadratura fissa ci sta tutta e
    // l'immagine viene uguale su telefono e desktop
    shareWide = { center: map.getCenter(), zoom: map.getZoom() };
    const root = document.documentElement.style;
    root.setProperty("--share-w", "1600px");
    root.setProperty("--share-h", "900px");
    document.body.classList.add("share-wide");
    map.invalidateSize({ pan: false });
    glBase?.resize();
    updateMinZoom();
    // due passate: il primo adattamento può essere spostato dalla sincronizzazione con Mapbox dopo il cambio di misura
    // (succedeva partendo da uno schermo stretto: l'Italia finiva fuori in basso)
    for (let k = 0; k < 2; k++) {
      map.fitBounds(SYN_FRAME, { animate: false });
      await mapReady();
    }
  }
  function shareWideEnd() {
    if (!shareWide) return;
    const { center, zoom } = shareWide;
    shareWide = null;
    document.body.classList.remove("share-wide");
    map.invalidateSize({ pan: false });
    glBase?.resize();
    updateMinZoom();
    map.setView(center, Math.max(zoom, map.getMinZoom()), { animate: false });
  }

  // posizione del dispositivo: non si usa più (prima centrava l'immagine condivisa); via quella salvata dalle versioni
  // precedenti
  try {
    localStorage.removeItem("weathermaps.pos.v1");
  } catch {
    /* storage non disponibile */
  }
  new ResizeObserver(() => {
    if (shareUi.dialog.open && crop.snap) {
      layoutView();
      scheduleRender();
    }
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
  const viewToMap = ([vx, vy]) => [
    crop.x + (vx - view.fx) / viewScale(),
    crop.y + (vy - view.fy) / viewScale(),
  ];
  shareUi.canvas.addEventListener("pointerdown", (e) => {
    if (crop.fixed) return; // inquadratura fissa
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
      if (pinch && dist)
        scaleCropAt(
          pinch / dist,
          ...viewToMap([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]),
        );
      pinch = dist;
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
  };
  shareUi.canvas.addEventListener("pointerup", endPointer);
  shareUi.canvas.addEventListener("pointercancel", endPointer);
  shareUi.canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (crop.fixed) return;
      crop.touched = true;
      // rotella in avanti = mappa più grande (più dettaglio)
      scaleCropAt(Math.exp(e.deltaY * 0.0015), ...viewToMap(toView(e)));
    },
    { passive: false },
  );
  shareUi.zoomIn.addEventListener("click", () => {
    crop.touched = true;
    scaleCropAt(1 / 1.25);
  });
  shareUi.zoomOut.addEventListener("click", () => {
    crop.touched = true;
    scaleCropAt(1.25);
  });

  function toast(text, warn = false) {
    shareUi.toast.textContent = text;
    shareUi.toast.classList.toggle("warn", warn); // avviso: colori di attenzione
    shareUi.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => {
      shareUi.toast.hidden = true;
    }, 4500);
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
    const pin = shareUi.btn.pin; // punto dal menu della mappa (vedi openMapMenu), solo per questo clic
    shareUi.btn.pin = null;
    if (!current) {
      toast("Niente da condividere: scegli un istante con dati.");
      return;
    }
    shareUi.btn.disabled = true;
    setLoading(true);
    try {
      // modale con ritaglio: il clic su "Condividi" è un gesto nuovo, valido per la condivisione nativa
      await openShare(pin);
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
  shareUi.download.addEventListener("click", () => {
    downloadShareFile();
  });
  shareUi.close.addEventListener("click", closeShare);

  // ---------- meteogramma di una località: andamento nel tempo delle grandezze del modello scelto. Sempre le stesse
  // quattro (pioggia, T850, zero termico, vento a 10 m), quelle che il modello non ha si saltano. Un pannello per
  // grandezza (mai due scale sullo stesso grafico), stesso asse dei tempi; pioggia a barre per intervallo,
  // le altre a linee; ora locale sull'asse, l'ora mostrata nella mappa tratteggiata, lettura dei valori al passaggio.
  const chartUi = {
    dialog: $("chart-dialog"),
    body: $("chart-body"),
    title: $("chart-title"),
    details: $("chart-details"),
    warn: $("chart-warn"),
    multi: $("chart-multi"),
    sounding: $("chart-sounding"),
    model: $("chart-model"),
    close: $("chart-close"),
  };
  let chartData = null;
  let chartContext = null;
  let chartPin = null; // ora (passo) fissata con un clic o un tocco: resta visibile e va nell'immagine condivisa
  let clearChartPin = () => {}; // impostata da drawChart: toglie l'ora fissata (linea, riquadro e tooltip)
  // Esc con un'ora fissata toglie solo quella; senza, chiude il grafico come al solito
  chartUi.dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && chartPin != null) {
      e.preventDefault();
      clearChartPin();
    }
  });
  // margine uguale su tutti i lati (come --cm in style.css): a sinistra coincide con lo spazio dei numeri dell'asse,
  // così titolo della finestra e titoli dei grafici partono alla stessa distanza dal bordo che i grafici hanno a destra
  const CHART_AXIS = 40; // spazio dei numeri dell'asse dentro l'SVG, a sinistra del grafico
  const CLIM_RED = "#ef4444"; // climatologia negli spaghetti
  const SNOW_BAR = "#a78bfa"; // parte di neve delle barre della precipitazione nei meteogrammi
  const OFFICIAL = "#22c55e"; // verde della corsa ufficiale (controllo) negli spaghetti
  const CHART_MAX_PH = 280; // altezza massima di un pannello a schermo: oltre, le curve si allungano senza dire di più
  const CHART_R = 30; // dentro l'SVG, a destra: la scala dell'accumulo della pioggia e l'ultima ora sull'asse
  chartUi.close.addEventListener("click", () => chartUi.dialog.close());

  /** Serie nel punto: dal server (api/series) o, nel sito statico, dai riquadri che lo contengono (app/series.py):
   *  pioggia e neve dalla cella del modello più vicina, la stessa che legge il tooltip della mappa (valueAt), il
   *  resto da una griglia regolare. */
  async function getSeries(model, run, lat, lon) {
    if (!STATIC) {
      const r = await fetch(
        `api/series?${new URLSearchParams({ model, run, lat, lon })}`,
      );
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    }
    const grids = (runs[model] || []).find((e) => e.run === run)?.series; // griglie della corsa, da runs.json
    if (!grids) throw new Error("serie non disponibile per questa corsa");
    const out = { lat, lon, vars: {} };
    await Promise.all(
      Object.entries(grids).map(async ([name, g]) => {
        const iy = Math.round((lat - g.lat0) / g.dlat),
          ix = Math.round((lon - g.lon0) / g.dlon);
        if (iy < 0 || ix < 0 || iy >= g.ny || ix >= g.nx) return; // fuori dal dominio del modello
        const ty = Math.floor(iy / g.block),
          tx = Math.floor(ix / g.block);
        const r = await fetch(`data/series/${model}/${run}/${name}/${ty}_${tx}.bin`);
        if (r.status === 404) return; // riquadro tutto fuori dal dominio: non c'è
        if (!r.ok) throw new Error("serie non disponibile per questo punto");
        const t = unpackField(await r.arrayBuffer());
        const cell = (iy - ty * g.block) * t.nx + (ix - tx * g.block);
        for (const [k, v] of Object.entries(t.vars)) {
          const n = v.steps.length;
          out.vars[k] = {
            steps: v.steps,
            values: v.values
              .slice(cell * n, (cell + 1) * n)
              .map((x) => (x == null ? null : x / v.scale)),
          };
        }
        if (name === "native") [out.lat, out.lon] = [g.lat0 + iy * g.dlat, g.lon0 + ix * g.dlon];
      }),
    );
    return out;
  }

  /** Climatologia della T850 (scripts/make_climate.py): per ogni ora del grafico la media 1991-2020 di quel giorno
   *  dell'anno e di quell'ora (00/06/12/18 UTC) nel punto (interpolata fra i nodi a 2.5°). Null se il file manca: il grafico si disegna lo stesso. */
  let climFile = null;
  async function climT850(lat, lon, t0, steps) {
    climFile ??= fetch("clim-t850.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const c = await climFile;
    if (!c?.hours) return null; // file mancante o di un formato diverso: grafico senza climatologia
    const fy = Math.min(Math.max((lat - c.lat0) / c.dlat, 0), c.ny - 1),
      fx = Math.min(Math.max((lon - c.lon0) / c.dlon, 0), c.nx - 1);
    const y0 = Math.min(Math.floor(fy), c.ny - 2),
      x0 = Math.min(Math.floor(fx), c.nx - 2),
      wy = fy - y0,
      wx = fx - x0;
    const at = (day, slot) => {
      const g = c.t850[day][slot];
      return (
        g[y0][x0] * (1 - wy) * (1 - wx) +
        g[y0][x0 + 1] * (1 - wy) * wx +
        g[y0 + 1][x0] * wy * (1 - wx) +
        g[y0 + 1][x0 + 1] * wy * wx
      );
    };
    // giorno dell'anno (0..364) e ora sinottica (0..3 = 00/06/12/18 UTC) di un istante
    const slotOf = (ms) => {
      const d = new Date(ms);
      const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
      let day = Math.floor((ms - jan1) / 864e5);
      const leap = new Date(Date.UTC(d.getUTCFullYear(), 1, 29)).getUTCMonth() === 1;
      if (leap && day >= 59) day -= 1; // il 29 febbraio vale come il 28 (la climatologia ha 365 giorni)
      return [Math.min(day, 364), Math.floor(d.getUTCHours() / 6)];
    };
    // fra due ore sinottiche si interpola (i passi degli spaghetti sono già ogni 6 ore, quindi di solito è esatto)
    return steps.map((s) => {
      const ms = t0 + s * 3600e3,
        base = Math.floor(ms / 216e5) * 216e5,
        w = (ms - base) / 216e5;
      const a = at(...slotOf(base));
      return w ? a * (1 - w) + at(...slotOf(base + 216e5)) * w : a;
    });
  }

  /** Spaghetti dell'ensemble di un modello nel punto più vicino: dal server o, nel sito statico, dal file del punto. */
  async function getEnsemble(model, lat, lon) {
    if (!STATIC) {
      const r = await fetch(`api/ensemble?${new URLSearchParams({ model, lat, lon })}`);
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    }
    const { run, grid: g } = meta.ensemble[model];
    const iy = Math.min(Math.max(Math.round((lat - g.lat0) / g.dlat), 0), g.ny - 1),
      ix = Math.min(Math.max(Math.round((lon - g.lon0) / g.dlon), 0), g.nx - 1);
    const r = await fetch(`data/ensemble/${model}/${run}/${iy}_${ix}.json`);
    if (!r.ok) throw new Error("ensemble non disponibile per questo punto");
    return r.json();
  }

  function writeChartHash(push = false) {
    if (!chartContext) return;
    const params = new URLSearchParams(location.hash.slice(1));
    params.set("chart", `${chartContext.place.lat},${chartContext.place.lon}`);
    params.set("place", chartContext.place.name);
    params.set("chartModel", chartContext.model);
    params.set("chartStep", chartContext.until);
    if (chartContext.from > 0) params.set("chartFrom", chartContext.from);
    else params.delete("chartFrom");
    if (chartContext.run) params.set("chartRun", chartContext.run);
    else params.delete("chartRun");
    if (chartContext.ensemble) params.set("chartEns", "1");
    else params.delete("chartEns");
    if (chartContext.multi) params.set("chartMulti", chartContext.multi);
    else params.delete("chartMulti");
    if (chartContext.sounding) params.set("chartSnd", `${chartContext.sounding.station}:${chartContext.sounding.time || ""}`);
    else params.delete("chartSnd");
    if (push)
      history.pushState(
        { ...history.state, weatherChart: true },
        "",
        "#" + params.toString(),
      );
    else replaceHash("#" + params.toString());
  }

  function restoreChartFromHash() {
    if (!meta) return;
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get("chartSnd")) {
      // radiosondaggio: stazione e lancio
      const [station, time] = params.get("chartSnd").split(":");
      openSounding(station, time || null, false);
      return;
    }
    const coordinates = params.get("chart")?.split(",");
    const [lat, lon] = coordinates?.map(Number) || [];
    if (
      coordinates?.length !== 2 ||
      coordinates.some((value) => !value.trim()) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      if (chartUi.dialog.open) chartUi.dialog.close();
      return;
    }
    const requestedModel = params.get("chartModel");
    const model = meta.models.some((entry) => entry.id === requestedModel)
      ? requestedModel
      : state.model;
    const run = (runs[model] || []).find(
      (entry) => !entry.incoming && entry.run === params.get("chartRun"),
    )?.run;
    const until = meta.steps.includes(+params.get("chartStep"))
      ? +params.get("chartStep")
      : state.step;
    const requestedFrom = +params.get("chartFrom");
    const from =
      (requestedFrom === 0 || meta.steps.includes(requestedFrom)) &&
      requestedFrom < until
        ? requestedFrom
        : 0;
    openChart(
      { lat, lon, name: params.get("place") || `${lat}, ${lon}` },
      {
        model,
        run,
        from,
        until,
        pushHistory: false,
        ensemble: params.get("chartEns") === "1" && !!meta.ensemble?.[model],
        multi: ["tp", "t850"].includes(params.get("chartMulti")) ? params.get("chartMulti") : null,
      },
    );
  }

  window.addEventListener("popstate", restoreChartFromHash);

  async function openChart(
    p,
    {
      model = state.model,
      run,
      from = state.mode === "interval" ? intervalPrev() : 0,
      until = state.step,
      pushHistory = true,
      ensemble = false, // spaghetti dell'ensemble GFS (carta sinottica) al posto del meteogramma
      multi = null, // "tp" (cumulata) o "t850": tutti i modelli e la media a confronto
    } = {},
  ) {
    chartUi.title.textContent = p.name;
    // modelli a confronto: niente scelta del modello, al suo posto Precipitazione / T 850 hPa
    chartUi.model.hidden = !!multi;
    chartUi.multi.hidden = !multi;
    chartUi.sounding.hidden = true;
    chartUi.dialog.classList.remove("side-panel"); // i grafici del modello a tutto schermo
    if (multi) {
      chartContext = { place: p, model: "mean", run: null, from: 0, until: 384, multi };
      writeChartHash(pushHistory && !chartUi.dialog.open);
      if (!chartUi.dialog.open) chartUi.dialog.showModal();
      chartUi.dialog.focus();
      await loadChart("mean");
      return;
    }
    if (ensemble)
      // spaghetti: solo i modelli con l'ensemble (GFS, ECMWF)
      fillModelSelect(meta.models.filter((m) => meta.ensemble?.[m.id]), model, chartUi.model);
    else {
      fillModelSelect(meta.models, model, chartUi.model);
      for (const option of chartUi.model.options)
        option.disabled = !(runs[option.value] || []).some(
          (run) => !run.incoming,
        );
    }
    chartContext = ensemble
      ? { place: p, model, run: meta.ensemble?.[model]?.run, from: 0, until: 384, ensemble: true }
      : {
          place: p,
          model,
          run: run || (model === state.model ? state.run : null),
          from,
          until,
        };
    writeChartHash(pushHistory && !chartUi.dialog.open);
    if (!chartUi.dialog.open) chartUi.dialog.showModal();
    chartUi.dialog.focus();
    await loadChart(model, chartContext.run);
  }
  /** Il grafico legge un punto della griglia delle serie (0,05° o 0,1°), la mappa la cella del modello: in montagna i
   *  totali possono essere molto diversi. Se la mappa mostra la stessa cosa (stesso modello e corsa, pioggia o neve
   *  dall'inizio della corsa) e la differenza è grande, un avviso lo dice, con il punto usato dal grafico. */
  function chartPointWarning(series, request, model, run) {
    const v = dataVar();
    const sv = series.vars?.[v];
    if (!current || !sv || !["tp", "sf"].includes(v) || state.model !== model || state.run !== run) return;
    if (!rangeMode() || intervalPrev() !== 0) return; // solo il totale dall'inizio della corsa è confrontabile
    const i = sv.steps.indexOf(state.step);
    const onChart = i >= 0 ? sv.values[i] : null;
    const onMap = valueAt(current, request.place.lat, request.place.lon);
    if (onChart == null || onMap == null) return;
    const diff = Math.abs(onMap - onChart);
    if (diff < 2 || diff < 0.1 * Math.max(onMap, onChart)) return; // oltre il 10% (e almeno 2 mm o 2 cm)
    const R = 6371,
      rad = Math.PI / 180;
    const km =
      R *
      Math.hypot(
        (series.lon - request.place.lon) * rad * Math.cos(request.place.lat * rad),
        (series.lat - request.place.lat) * rad,
      );
    const u = current.units;
    const dec = v === "sf" ? 0 : 1;
    // breve riga sempre visibile; la spiegazione si apre toccandola (chiusa anche su desktop)
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Perché leggo valori diversi dalla mappa?";
    const text = document.createElement("p");
    text.textContent =
      `Qui ${baseLabel().toLowerCase()} totale è ${onChart.toFixed(dec)} ${u}, sulla mappa ${onMap.toFixed(dec)} ${u}. ` +
      `Il grafico usa il punto di griglia più vicino (${series.lat.toFixed(2)} N, ${series.lon.toFixed(2)} E, a ` +
      `${km < 1 ? "meno di 1" : km.toFixed(1).replace(".", ",")} km), la mappa la cella del modello sotto la ` +
      `località: in montagna i valori cambiano molto in pochi km.`;
    details.append(summary, text);
    chartUi.warn.replaceChildren(details);
    chartUi.warn.hidden = false;
  }
  async function loadChart(model, selectedRun) {
    if (!chartContext) return;
    if (chartContext.multi) return loadMulti();
    if (chartContext.sounding) return loadSounding();
    const run = chartContext.ensemble
      ? meta.ensemble?.[model]?.run // spaghetti: l'ultima corsa completa dell'ensemble del modello
      : selectedRun || (runs[model] || []).find((entry) => !entry.incoming)?.run;
    const request = { ...chartContext, model, run };
    chartContext = request;
    writeChartHash();
    if (request.ensemble) {
      const info = meta.ensemble?.[model];
      chartUi.details.textContent = run
        ? `${info.label} · ${cycle(run)} ${fmtRunDay(run)}`
        : "Ensemble non disponibile";
      chartUi.warn.hidden = true;
      chartUi.body.innerHTML = '<div class="chart-empty">Caricamento…</div>';
      chartData = null;
      chartPin = null;
      $("chart-readout").hidden = true;
      try {
        if (!run) throw new Error("nessuna corsa disponibile");
        const ens = await getEnsemble(model, request.place.lat, request.place.lon);
        const clim = await climT850(ens.lat, ens.lon, runDate(run).getTime(), ens.steps);
        if (chartContext !== request || !chartUi.dialog.open) return;
        chartData = { ensemble: ens, clim, model, run, from: 0, until: 384 };
        drawChart();
      } catch (e) {
        if (chartContext !== request || !chartUi.dialog.open) return;
        const message = document.createElement("div");
        message.className = "chart-empty";
        message.textContent = `Grafico non disponibile: ${e.message}`;
        chartUi.body.replaceChildren(message);
      }
      return;
    }
    // periodo in date, come nella barra della mappa (i passi si riferiscono alla corsa scelta qui)
    const at = (step) => new Date(runDate(run).getTime() + step * 3600e3);
    const period = !run
      ? ""
      : request.from > 0
        ? fmtSpan(at(request.from), at(request.until), { month: false })
        : `fino a ${fmtLocal(at(request.until))}`;
    chartUi.details.textContent = run
      ? `${cycle(run)} · ${period}`
      : "Nessuna corsa disponibile";
    chartUi.warn.hidden = true;
    chartUi.body.innerHTML = '<div class="chart-empty">Caricamento…</div>';
    chartData = null;
    chartPin = null;
    $("chart-readout").hidden = true;
    try {
      if (!run) throw new Error("nessuna corsa disponibile");
      const { lat, lon } = request.place;
      const series = await getSeries(model, run, lat, lon);
      if (chartContext !== request || !chartUi.dialog.open) return;
      // nessun valore nel punto (es. mentre il modello si aggiorna): avviso invece di un grafico vuoto
      const hasData = Object.values(series.vars || {}).some((v) =>
        v.values.some((x, i) => x != null && v.steps[i] <= request.until),
      );
      if (!hasData) throw new Error("nessun dato in questo punto");
      chartUi.warn.hidden = true;
      chartPointWarning(series, request, model, run);
      chartData = {
        series,
        model,
        run,
        from: request.from,
        until: request.until,
      };
      drawChart();
    } catch (e) {
      if (chartContext !== request || !chartUi.dialog.open) return;
      const message = document.createElement("div");
      message.className = "chart-empty";
      // con una corsa nuova in arrivo il motivo è quasi sempre l'aggiornamento: lo si dice chiaramente
      message.textContent = (runs[model] || []).some((r) => r.incoming)
        ? "Il modello si sta aggiornando: il grafico sarà disponibile fra poco, appena la nuova corsa è completa."
        : `Grafico non disponibile: ${e.message}`;
      chartUi.body.replaceChildren(message);
    }
  }
  chartUi.multi.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b || !chartContext?.multi || b.dataset.v === chartContext.multi) return;
    chartContext.multi = b.dataset.v;
    loadMulti();
  });
  chartUi.model.addEventListener("change", () =>
    loadChart(chartUi.model.value),
  );
  chartUi.dialog.addEventListener("close", () => {
    chartContext = null;
    chartData = null;
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has("chart")) return;
    if (history.state?.weatherChart) history.back();
    else {
      for (const key of [
        "chart",
        "place",
        "chartModel",
        "chartRun",
        "chartStep",
        "chartFrom",
        "chartEns",
        "chartMulti",
        "chartSnd",
      ])
        params.delete(key);
      replaceHash("#" + params.toString());
    }
  });
  new ResizeObserver(() => {
    if (chartUi.dialog.open && chartData) drawChart();
  }).observe(chartUi.body);

  // ---------- condivisione del meteogramma: immagine larga 1080 px (anche da telefono) con località, modello e corsa
  // in alto, crediti in basso; poi come l'immagine della mappa (menu del telefono, altrimenti download)
  /** Colori del tema attuale della pagina (chiaro o scuro), per un'immagine uguale a quella nel browser. */
  function chartColors() {
    const cs = getComputedStyle(chartUi.dialog);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    return {
      bg: v("--bg", "#ffffff"),
      fg: v("--fg", "#1d2330"),
      muted: v("--muted", "#5d6677"),
      line: v("--line", "#d8dde6"),
      accent: v("--accent", "#1560e0"),
      acc:
        getComputedStyle(chartUi.body).getPropertyValue("--acc").trim() ||
        "#12357a",
    }; // accumulo della pioggia
  }
  const chartCss = (c) =>
    [
      // le classi della pagina non valgono dentro un'immagine: stessi stili e colori
      `.ch-title{font:650 12.5px system-ui,sans-serif;fill:${c.fg}}.ch-note{font-weight:400;font-size:11.5px;fill:${c.muted}}.ch-leg{font:400 11.5px system-ui,sans-serif;fill:${c.muted}}.ch-leg tspan{font-weight:650;fill:${c.fg}}`,
      `.ch-tick{font:11px system-ui,sans-serif;fill:${c.muted}}.ch-grid{stroke:${c.line};stroke-width:1}`,
      `.ch-day{stroke:${c.line};stroke-width:1;stroke-dasharray:3 3}`,
      `.ch-zero{stroke:${c.muted};stroke-width:1}text{font-variant-numeric:tabular-nums}`,
      `.ch-pin{stroke:${c.fg};stroke-width:1.5;opacity:.75}.ch-pin-dot{stroke:${c.bg};stroke-width:2}`,
      `.ch-pin-bar{stroke:${c.fg};stroke-width:1.5}`,
      `.ch-acc{stroke:${c.acc}}.ch-acc-area{fill:${c.acc};fill-opacity:.1}.ch-acc-tick{fill:${c.acc}}`,
      `.ch-ens-mean{stroke:${c.fg}}.ch-ens-ctl{stroke:${OFFICIAL}}.ch-ens-halo{stroke:${c.bg}}`,
    ].join("");
  async function makeChartFile() {
    const { model, run } = chartData;
    const title = chartUi.title.textContent;
    const subtitle = chartData.ensemble || chartData.multi || chartData.sounding
      ? chartUi.details.textContent // dice già "Ensemble GFS/ECMWF" o "Modelli a confronto"
      : `${meta.models.find((entry) => entry.id === model)?.label || model} · ${chartUi.details.textContent}`;
    // immagine verticale 4:5 (2160 × 2700 px): formato pieno su Instagram, intera nelle chat; i pannelli si allungano.
    // Si disegna su 600 × 750 punti ingranditi 3,6 volte: testi e linee in proporzione come nella pagina sul telefono
    // (su 1080 punti, rimpicciolita nello schermo, sembrava tutto minuscolo)
    const OW = 600,
      OH = 750,
      M = 28,
      K = 3.6,
      FOOT = 30; // dimensioni, margine, scala, spazio di "Realizzato da" in fondo
    const EW = OW - 2 * M + CHART_R; // larghezza dell'SVG (a destra il suo margine interno sostituisce M)
    const TOP = M + 78; // titolo, sottotitolo e spazio prima dei grafici
    const PB = { pad: 10, line: 19, font: 13 }; // riquadro dell'ora fissata
    // righe dei valori del riquadro: una per grafico
    const pbLines = (pb) => (pb.table ? pb.table.rows.length : pb.rows.length);
    // il grafico prende tutta l'altezza: il riquadro dell'ora fissata sta sopra il grafico, in alto accanto alla sua
    // linea (come la scheda nella pagina), e non tocca mai "Realizzato da" in fondo
    const g = drawChart(EW, OH - TOP - FOOT - M);
    if (!g) throw new Error("niente da condividere");
    const c = chartColors();
    // larghezza e altezza già alla risoluzione finale: il browser rasterizza l'SVG a quella misura (nitido)
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${g.W * K}" height="${g.H * K}" viewBox="0 0 ${g.W} ${g.H}"><style>${chartCss(c)}</style>${g.markup}</svg>`;
    const [img, flag] = await Promise.all([
      new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () =>
          reject(new Error("grafico non convertibile in immagine"));
        im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
      }),
      loadFlag(model, c.fg),
    ]);
    const cw = OW,
      chh = Math.max(OH, TOP + g.H + FOOT + M); // più alta solo se i pannelli non ci stanno
    const cv = document.createElement("canvas");
    cv.width = cw * K;
    cv.height = chh * K;
    const ctx = cv.getContext("2d");
    ctx.scale(K, K);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, cw, chh);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = c.fg;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(title, M, M + 22, cw - 2 * M); // allineati ai titoli dei grafici
    let sx = M;
    if (flag) {
      // bandiera del modello (icona a livelli per la mediana) prima del sottotitolo
      const fh = 15,
        fw = Math.round(fh * (flag.naturalWidth / flag.naturalHeight || 4 / 3));
      ctx.drawImage(flag, M, M + 37, fw, fh);
      if (flag.dataset.border) {
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.strokeRect(M + 0.5, M + 37.5, fw - 1, fh - 1);
      }
      sx += fw + 8;
    }
    ctx.fillStyle = c.muted;
    ctx.font = `500 15px ${FONT}`;
    ctx.fillText(subtitle, sx, M + 50, cw - M - sx);
    ctx.drawImage(img, M, TOP, g.W, g.H);
    if (g.pinBox) {
      // come nella pagina: la linea scende fino al riquadro con ora e valori, verso il lato con più spazio
      const pb = g.pinBox,
        lx = M + pb.x;
      const widthOf = (parts) =>
        parts.reduce((w, [t, b]) => {
          ctx.font = `${b ? 650 : 400} ${PB.font}px ${FONT}`;
          return w + ctx.measureText(t).width;
        }, 0);
      ctx.font = `400 ${PB.font}px ${FONT}`;
      // tabella (spaghetti), più piccola: per riga "Ufficiale 3.7 °C  Media 2.3 °C", le celle dei valori tutte larghe
      // quanto il valore più largo, così le colonne restano allineate
      const tb = pb.table,
        TF = 11.5, // font della tabella
        TL = 16, // interlinea della tabella
        LGAP = 5, // tra etichetta e valore
        COLGAP = 14; // tra una coppia e l'altra
      let labW = [],
        valW = 0;
      if (tb) {
        ctx.font = `400 ${TF}px ${FONT}`;
        labW = tb.head.map((h) => Math.ceil(ctx.measureText(h.t).width));
        ctx.font = `650 ${TF}px ${FONT}`;
        for (const r of tb.rows) for (const v of r) valW = Math.max(valW, Math.ceil(ctx.measureText(v).width));
      }
      const tableW = labW.reduce((a, w) => a + w + LGAP + valW, 0) + COLGAP * Math.max(0, labW.length - 1);
      const HF = tb ? TF : PB.font, // font e interlinea del riquadro (più piccoli per gli spaghetti)
        HL = tb ? TL : PB.line,
        HP = tb ? 8 : PB.pad;
      ctx.font = `400 ${HF}px ${FONT}`;
      const bw =
        Math.ceil(
          Math.max(ctx.measureText(pb.head).width, tableW, ...pb.rows.map(widthOf)),
        ) +
        HP * 2 +
        4;
      const bh = HP * 2 + HL * (1 + pbLines(pb)) - 4;
      // in alto, sotto il titolo del primo grafico, dal lato della linea con più spazio
      const by = TOP + 24,
        bx = Math.max(
          M,
          Math.min(pb.x < pb.right / 2 ? lx + 10 : lx - bw - 10, M + pb.right - bw),
        );
      ctx.beginPath();
      ctx.roundRect(bx + 0.5, by + 0.5, bw, bh, 7);
      ctx.fillStyle = c.bg;
      ctx.fill();
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.stroke();
      let ty = by + HP + HF;
      ctx.font = `400 ${HF}px ${FONT}`;
      ctx.fillStyle = c.muted;
      ctx.fillText(pb.head, bx + HP, ty);
      ctx.fillStyle = c.fg;
      if (tb) {
        for (const r of tb.rows) {
          ty += HL;
          let tx = bx + HP;
          r.forEach((v, k) => {
            ctx.font = `400 ${TF}px ${FONT}`;
            ctx.fillStyle = tb.head[k].col || c.muted;
            ctx.fillText(tb.head[k].t, tx, ty);
            tx += labW[k] + LGAP;
            ctx.font = `650 ${TF}px ${FONT}`;
            ctx.fillStyle = c.fg;
            ctx.fillText(v, tx, ty);
            tx += valW + COLGAP;
          });
        }
      }
      for (const parts of pb.rows) {
        ty += PB.line;
        let tx = bx + PB.pad;
        for (const [t, b, col] of parts) {
          ctx.font = `${b ? 650 : 400} ${PB.font}px ${FONT}`;
          ctx.fillStyle = col || c.fg; // "Ufficiale" nel verde della sua linea
          ctx.fillText(t, tx, ty);
          tx += ctx.measureText(t).width;
        }
      }
    }
    // in fondo a destra solo "Realizzato da signalkuppe.com", piccolo (niente riga dei crediti dei dati)
    ctx.textAlign = "right";
    ctx.font = `700 9.5px ${FONT}`;
    ctx.fillStyle = c.fg;
    const site = "signalkuppe.com";
    ctx.fillText(site, cw - M, chh - M);
    const sw = ctx.measureText(site).width;
    ctx.font = `400 9.5px ${FONT}`;
    ctx.fillStyle = c.muted;
    ctx.fillText("Realizzato da ", cw - M - sw, chh - M);
    const blob = await new Promise((resolve) =>
      cv.toBlob(resolve, "image/jpeg", 0.92),
    );
    const slug = title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return new File(
      [blob],
      `weathermaps-grafico-${slug || "localita"}-${model}-${run}.jpg`,
      { type: "image/jpeg" },
    );
  }
  function downloadFile(file) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  /** Condividi (menu del telefono; dove non c'è, scarica) o Scarica: la stessa immagine. */
  async function chartImage(btn, share) {
    if (!chartData) return;
    btn.disabled = true;
    try {
      const file = await makeChartFile();
      const data = { files: [file] };
      if (share && navigator.canShare?.(data)) {
        try {
          await navigator.share(data);
        } catch (e) {
          if (e.name !== "AbortError") throw e;
        }
      } else {
        downloadFile(file);
      }
    } catch (e) {
      chartUi.details.textContent += ` · ${share ? "condivisione non riuscita" : "download non riuscito"}: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }
  $("chart-share").addEventListener("click", (e) =>
    chartImage(e.currentTarget, true),
  );
  $("chart-readout")
    .querySelector(".chart-readout-links")
    .addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "remove") clearChartPin();
      else chartImage(btn, btn.dataset.act === "share"); // stessa immagine dei pulsanti in alto, con l'ora fissata
    });
  $("chart-download").addEventListener("click", (e) =>
    chartImage(e.currentTarget, false),
  );

  /** 3–5 valori "tondi" fra lo e hi per l'asse. */
  function niceTicks(lo, hi, n = 3) {
    const raw = (hi - lo) / n || 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step =
      [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step)
      out.push(+v.toFixed(6));
    return out;
  }
  const dirName = (u, v) => {
    if (u == null || v == null || Math.hypot(u, v) < 1) return "";
    return DIRS[
      Math.round((((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360) / 45) % 8
    ];
  };

  /** Disegna il meteogramma nella finestra; con `exportW` restituisce invece l'SVG largo exportW (per l'immagine). */
  /** Spaghetti di un ensemble: una linea per membro (sottili, colorate), il controllo ("ufficiale", GFS) in verde e la media spessa;
   *  sopra la temperatura a 850 hPa, sotto la pioggia di ogni 6 ore. Tooltip con media e forbice dei membri. */
  function drawEnsemble(exportW, exportH) {
    const { ensemble: E, run } = chartData;
    const t0 = runDate(run).getTime();
    const W = exportW || Math.max(280, chartUi.body.clientWidth);
    const R = exportW ? CHART_R : 14; // nella finestra a destra basta l'ultima etichetta dei giorni (niente scala della pioggia); nell'immagine fa da margine
    let L = CHART_AXIS, // si stringe sui numeri dell'asse (vedi sotto)
      pw = W - L - R;
    const HEAD = 30,
      GAP = 16,
      AXIS = 34;
    const steps = E.steps,
      x0 = 0,
      x1 = steps[steps.length - 1];
    const X = (h) => L + ((h - x0) / (x1 - x0 || 1)) * pw;
    const fmt = (x, d) => (x == null ? "—" : x.toFixed(d).replace("-", "−"));
    const mean = (rows) =>
      steps.map((_, i) => {
        const v = rows.map((r) => r[i]).filter((x) => x != null);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      });
    const ctl = E.control ? E.members.indexOf(E.control) : -1; // l'ensemble ECMWF dei dati aperti non ha il controllo
    const panels = [
      { title: "Temperatura 850 hPa", unit: "°C", rows: E.t850, dec: 1, zero: true, ph: 170, clim: chartData.clim },
      { title: "Pioggia", unit: "mm in 6 ore", rows: E.tp, dec: 1, min: 2, floor0: true, ph: 110 },
    ];
    // altezza: quella dell'immagine o, nella finestra, tutta quella disponibile (i pannelli si allungano)
    const fitH = exportH || (chartUi.body.clientHeight > 320 ? chartUi.body.clientHeight - 12 : null);
    const avail = fitH ? fitH - AXIS - panels.length * (HEAD + GAP) + GAP : null;
    if (avail) {
      const tot = panels.reduce((a, p) => a + p.ph, 0);
      for (const p of panels) p.ph = Math.max(60, (p.ph / tot) * avail);
    }
    const svg = [];
    let top = HEAD;
    const tickText = (t) => fmt(t, Math.abs(t) < 10 && t % 1 ? 1 : 0);
    for (const p of panels) {
      p.mean = mean(p.rows);
      const vals = [...p.rows.flat(), ...(p.clim || [])].filter((x) => x != null);
      let lo = p.floor0 ? 0 : Math.min(...vals),
        hi = Math.max(p.min ?? -Infinity, ...vals);
      if (p.zero) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      p.ticks = niceTicks(lo, hi, 4);
      p.lo = Math.min(lo, p.ticks[0]);
      p.hi = Math.max(hi, p.ticks[p.ticks.length - 1]);
    }
    {
      // il grafico parte subito dopo il numero più largo dell'asse (11-11.5 px, ~6.6 px per cifra)
      const chars = Math.max(...panels.flatMap((p) => p.ticks.map((t) => tickText(t).length)));
      L = Math.ceil(chars * 6.6) + 5;
      pw = W - L - R;
    }
    for (const p of panels) {
      const { ticks, lo, hi } = p;
      const bot = top + p.ph;
      const Y = (y) => bot - ((y - lo) / (hi - lo || 1)) * p.ph;
      Object.assign(p, { top, bot, Y });
      svg.push(
        `<text class="ch-title" x="0" y="${top - 14}">${p.title} <tspan class="ch-note">(${p.unit})</tspan></text>`,
      );
      for (const t of ticks) {
        svg.push(`<line class="ch-grid" x1="${L}" x2="${L + pw}" y1="${Y(t)}" y2="${Y(t)}"/>`);
        svg.push(
          `<text class="ch-tick" x="${L - 4}" y="${Y(t) + 3.5}" text-anchor="end">${tickText(t)}</text>`,
        );
      }
      if (p.zero && lo < 0 && hi > 0)
        svg.push(`<line class="ch-zero" x1="${L}" x2="${L + pw}" y1="${Y(0)}" y2="${Y(0)}"/>`);
      const path = (row) => {
        let d = "",
          pen = false;
        row.forEach((v, i) => {
          if (v == null) {
            pen = false;
            return;
          }
          d += `${pen ? "L" : "M"}${X(steps[i]).toFixed(1)},${Y(v).toFixed(1)}`;
          pen = true;
        });
        return d;
      };
      // membri perturbati: arcobaleno come le carte classiche, sottili e un po' trasparenti
      p.rows.forEach((row, k) => {
        if (k === ctl) return;
        const hue = Math.round((k * 300) / p.rows.length);
        svg.push(
          `<path d="${path(row)}" fill="none" stroke="hsl(${hue} 70% 50%)" stroke-width="0.8" stroke-opacity="0.6" stroke-linejoin="round"/>`,
        );
      });
      // climatologia 1991-2020 del giorno e dell'ora: rossa continua, più spessa dei membri
      if (p.clim)
        svg.push(
          `<path d="${path(p.clim)}" fill="none" stroke="${CLIM_RED}" stroke-width="${exportW ? 1.6 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      svg.push(
        `<path class="ch-ens-mean" d="${path(p.mean)}" fill="none" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
      // controllo sopra a tutto, più spesso e con un bordo del colore di fondo che lo stacca dagli spaghetti
      if (ctl >= 0) {
        const d = path(p.rows[ctl]);
        svg.push(
          `<path class="ch-ens-halo" d="${d}" fill="none" stroke-width="${exportW ? 2 : 2.6}" stroke-linejoin="round" stroke-linecap="round"/>`,
          `<path class="ch-ens-ctl" d="${d}" fill="none" stroke-width="${exportW ? 1.1 : 1.4}" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      }
      top = bot + GAP + HEAD;
    }
    const H = panels[panels.length - 1].bot + AXIS;
    const yBot = H - AXIS;
    // giorni a mezzanotte (ora di Roma), etichette solo se c'è spazio
    const hourOf = (h) =>
      +new Date(t0 + h * 3600e3).toLocaleString("it-IT", {
        timeZone: "Europe/Rome",
        hour: "2-digit",
        hour12: false,
      });
    const perDay = pw / ((x1 - x0) / 24);
    const labelEvery = perDay >= 34 ? 1 : perDay >= 17 ? 2 : 4;
    let nDay = 0;
    for (let h = 1; h <= x1; h++) {
      if (hourOf(h) % 24 !== 0) continue;
      svg.push(`<line class="ch-day" x1="${X(h)}" x2="${X(h)}" y1="${HEAD + 2}" y2="${yBot}"/>`);
      if (nDay++ % labelEvery) continue;
      const d = new Date(t0 + h * 3600e3).toLocaleDateString("it-IT", {
        timeZone: "Europe/Rome",
        ...(perDay >= 52 ? { weekday: "short", day: "numeric" } : { day: "numeric" }),
      });
      svg.push(
        `<text class="ch-tick" x="${X(h)}" y="${yBot + 16}" text-anchor="middle" font-weight="600">${d}</text>`,
      );
    }
    // valori a un passo in tabella: colonne Ufficiale (il controllo, se c'è) e Media, una riga per grafico; per
    // tooltip, scheda dell'ora fissata e immagine
    const valueTable = (i) => {
      const cols = [...(ctl >= 0 ? [{ t: "Ufficiale", col: OFFICIAL, row: (p) => p.rows[ctl][i] }] : []),
        { t: "Media", row: (p) => p.mean[i] }];
      const rows = panels
        .map((p) => cols.map((c) => c.row(p)).map((v) => (v == null ? "—" : `${fmt(v, p.dec)} ${unitOf(p)}`)))
        .filter((r) => r.some((x) => x !== "—"));
      return rows.length ? { head: cols.map(({ t, col }) => ({ t, col })), rows } : null;
    };
    const unitOf = (p) => (p.title === "Pioggia" ? "mm" : "°C");
    const pin = chartPin != null && steps.includes(chartPin) ? chartPin : null;
    if (exportW) {
      // ora fissata: linea sul grafico e riquadro con ora e valori accanto, in alto (come gli altri grafici)
      if (pin != null)
        svg.push(`<line class="ch-pin" x1="${X(pin)}" x2="${X(pin)}" y1="${HEAD + 2}" y2="${yBot}"/>`);
      const i = steps.indexOf(pin);
      const pinBox =
        pin == null
          ? null
          : {
              x: X(pin),
              right: X(x1),
              head: `${fmtLocal(new Date(t0 + pin * 3600e3))} · +${pin}h`,
              rows: [],
              table: valueTable(i),
            };
      return { markup: svg.join(""), W, H, pinBox };
    }
    const rowsHtml = (st) => {
      const tb = valueTable(steps.indexOf(st));
      if (!tb) return "";
      // una riga per grafico, "Ufficiale 3.7 °C  Media 2.3 °C": le celle dei valori hanno tutte la stessa larghezza
      const label = ({ t, col }) => `<span class="h"${col ? ` style="color:${col}"` : ""}>${t}</span>`;
      return (
        `<div class="ens-vals" style="grid-template-columns:${tb.head.map(() => "auto 1fr").join(" ")}">` +
        tb.rows.map((r) => r.map((v, k) => label(tb.head[k]) + `<b>${v}</b>`).join("")).join("") +
        "</div>"
      );
    };
    const headOf = (st) => `${fmtLocal(new Date(t0 + st * 3600e3))} · +${st}h`;
    mountTimeChart({ svg, W, H, L, pw, x0, x1, steps, X, HEAD, yBot, rowsHtml, headOf, pin,
      label: "Spaghetti dell'ensemble" });
  }

  /** Interazioni comuni dei grafici "nel tempo" a un pannello (spaghetti, modelli a confronto): tooltip al passaggio,
   *  ora fissata col clic destro o la pressione prolungata (scheda con Condividi · Scarica · ✕). */
  function mountTimeChart({ svg, W, H, L, pw, x0, x1, steps, X, HEAD, yBot, rowsHtml, headOf, label, pin }) {
    svg.push(
      `<line class="ch-cursor" id="ch-cursor" x1="0" x2="0" y1="${HEAD + 2}" y2="${yBot}" visibility="hidden"/>`,
      `<line class="ch-cursor pinned" id="ch-pinline" x1="0" x2="0" y1="${HEAD + 2}" y2="${yBot}" visibility="hidden"/>`,
    );
    svg.push(`<rect id="ch-hit" x="${L}" y="0" width="${pw}" height="${yBot}" fill="transparent"/>`);
    chartUi.body.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${label}">${svg.join("")}</svg>` +
      '<div class="chart-tip" hidden></div>';
    const svgEl = chartUi.body.querySelector("svg"),
      tip = chartUi.body.querySelector(".chart-tip"),
      cursor = svgEl.querySelector("#ch-cursor"),
      pinLine = svgEl.querySelector("#ch-pinline"),
      hit = svgEl.querySelector("#ch-hit");
    const stepAt = (clientX) => {
      const r = svgEl.getBoundingClientRect();
      const h = x0 + (((clientX - r.left) * (W / r.width) - L) / pw) * (x1 - x0);
      let i = 0;
      for (let k = 1; k < steps.length; k++) if (Math.abs(steps[k] - h) < Math.abs(steps[i] - h)) i = k;
      return steps[i];
    };
    // tooltip di lettura (scuro) o scheda dell'ora fissata (chiara, con Condividi · Scarica · ✕)
    const showAt = (st, clientX, clientY, pinned = false) => {
      cursor.setAttribute("x1", X(st));
      cursor.setAttribute("x2", X(st));
      cursor.setAttribute("visibility", pinned ? "hidden" : "visible");
      tip.classList.toggle("pinned", pinned);
      tip.innerHTML =
        `<div class="t">${headOf(st)}</div>` +
        rowsHtml(st) +
        (pinned
          ? `<div class="chart-tip-actions"><button type="button" data-act="share">Condividi</button>` +
            `<button type="button" data-act="download">Scarica</button>` +
            `<button type="button" data-act="remove" aria-label="Togli l'ora fissata">✕</button></div>`
          : "");
      tip.hidden = false;
      const br = chartUi.body.getBoundingClientRect();
      const cx = clientX - br.left,
        w = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(cx + 14 + w > br.width ? cx - 14 - w : cx + 14, 4), br.width - w - 4)}px`;
      tip.style.top = `${Math.max(chartUi.body.scrollTop + 4, clientY - br.top + chartUi.body.scrollTop - 20)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      cursor.setAttribute("visibility", "hidden");
    };
    const renderPin = () => {
      const on = chartPin != null && steps.includes(chartPin);
      pinLine.setAttribute("visibility", on ? "visible" : "hidden");
      if (!on) return;
      pinLine.setAttribute("x1", X(chartPin));
      pinLine.setAttribute("x2", X(chartPin));
    };
    // scheda dell'ora fissata in alto, accanto alla sua linea
    const showPinTip = () => {
      const r = svgEl.getBoundingClientRect();
      showAt(chartPin, r.left + (X(chartPin) / W) * r.width, chartUi.body.getBoundingClientRect().top + 4, true);
    };
    const pinAt = (st) => {
      chartPin = st;
      renderPin();
      showPinTip();
    };
    const unpin = () => {
      chartPin = null;
      renderPin();
      hide();
    };
    tip.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "remove") unpin();
      else chartImage(btn, btn.dataset.act === "share"); // stessa immagine dei pulsanti in alto, con l'ora fissata
    });
    // mouse: passandoci sopra si leggono i valori, il clic destro fissa l'ora. Dito: scorrendo si leggono i valori,
    // la pressione prolungata fissa l'ora (poi trascinando la si sposta); tornando a scorrere si toglie
    const PRESS_MS = 450,
      SLOP = 8;
    let touch = null;
    hit.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (ev.pointerType === "touch" || touch) return; // col dito ci pensa la pressione prolungata
      pinAt(stepAt(ev.clientX));
    });
    hit.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;
      const st = stepAt(ev.clientX);
      touch = { x0: ev.clientX, moved: false, pinning: false };
      touch.timer = setTimeout(() => {
        touch.pinning = true;
        navigator.vibrate?.(10);
        pinAt(st);
      }, PRESS_MS);
    });
    hit.addEventListener("pointermove", (ev) => {
      const st = stepAt(ev.clientX);
      if (touch) {
        if (!touch.moved && Math.abs(ev.clientX - touch.x0) <= SLOP) return;
        touch.moved = true;
        clearTimeout(touch.timer);
        if (touch.pinning) {
          if (st !== chartPin) pinAt(st);
        } else {
          if (chartPin != null) {
            chartPin = null;
            renderPin();
          }
          showAt(st, ev.clientX, ev.clientY);
        }
        return;
      }
      if (ev.pointerType !== "mouse" || chartPin != null) return; // con l'ora fissata resta la sua scheda
      showAt(st, ev.clientX, ev.clientY);
    });
    const endTouch = (ev) => {
      if (!touch) return;
      clearTimeout(touch.timer);
      const tap = ev.type === "pointerup" && !touch.moved && !touch.pinning;
      if (tap && chartPin != null) unpin(); // tocco breve con un'ora fissata: la toglie
      else if (tap) showAt(stepAt(ev.clientX), ev.clientX, ev.clientY);
      else if (ev.type === "pointercancel" && chartPin == null) hide();
      touch = null;
    };
    hit.addEventListener("pointerup", endTouch);
    hit.addEventListener("pointercancel", endTouch);
    hit.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType === "mouse" && chartPin == null) hide();
    });
    clearChartPin = unpin;
    renderPin(); // ridisegno (finestra ridimensionata): l'ora fissata resta
    if (pin != null) showPinTip();
    }

  // ---------- modelli a confronto: la precipitazione cumulata o la temperatura a 850 hPa di tutti i modelli e della
  // media nella località, dalle serie dei meteogrammi. Le corse partono a ore diverse: il grafico parte dall'inizio della
  // corsa più recente e la pioggia si somma da lì, così le linee partono insieme da 0 (come su Wetterzentrale).
  const MULTI_COLORS = {
    gfs: "#51cf66",
    ecmwf: "#20c997",
    "icon-d2": "#fab005",
    "icon-2i": "#fd7e14",
    "icon-ch1": "#f06595",
    "icon-ch2": "#cc5de8",
    arome: "#4dabf7",
    wrf: "#ff6b6b",
    // la media: spessa, nel colore del testo (come la media degli spaghetti)
  };
  async function loadMulti() {
    const request = chartContext;
    const v = request.multi;
    for (const b of chartUi.multi.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === v));
    chartUi.details.textContent = `Modelli a confronto · ${v === "t850" ? "temperatura a 850 hPa" : "precipitazione cumulata"}`;
    chartUi.warn.hidden = true;
    chartUi.body.innerHTML = '<div class="chart-empty">Caricamento…</div>';
    chartData = null;
    chartPin = null;
    $("chart-readout").hidden = true;
    writeChartHash();
    const { lat, lon } = request.place;
    const models = meta.models; // anche la media
    const got = await Promise.all(
      models.map(async (m) => {
        const r = (runs[m.id] || []).find((x) => !x.incoming && x.variables?.[v]);
        if (!r) return null;
        try {
          const sv = (await getSeries(m.id, r.run, lat, lon)).vars?.[v];
          return sv ? { id: m.id, run: r.run, sv } : null;
        } catch {
          return null;
        }
      }),
    );
    if (chartContext !== request || !chartUi.dialog.open) return;
    const ok = got.filter(Boolean);
    if (!ok.length) {
      chartUi.body.innerHTML = '<div class="chart-empty">Nessun modello ha dati in questo punto.</div>';
      return;
    }
    const T0 = Math.max(...ok.map((m) => runDate(m.run).getTime()));
    // ogni modello: cumulata dalla sua partenza (0 all'inizio della corsa), riportata a 0 all'istante comune T0
    const lines = ok
      .map((m) => {
        const start = runDate(m.run).getTime();
        const pts = [[(start - T0) / 3600e3, 0]];
        m.sv.steps.forEach((st, i) => {
          if (m.sv.values[i] != null) pts.push([(start + st * 3600e3 - T0) / 3600e3, m.sv.values[i]]);
        });
        const at = (h) => {
          for (let i = 1; i < pts.length; i++)
            if (pts[i][0] >= h) {
              const [ha, va] = pts[i - 1],
                [hb, vb] = pts[i];
              return va + ((vb - va) * (h - ha)) / (hb - ha || 1);
            }
          return null;
        };
        let out;
        if (v === "tp") {
          const base = at(0) ?? 0; // pioggia: somma dall'istante comune
          out = [[0, 0], ...pts.filter(([h]) => h > 0).map(([h, x]) => [h, Math.max(0, x - base)])];
        } else {
          // temperatura: i valori veri dall'istante comune in poi (il punto a 0 dell'inizio corsa vale solo per la
          // pioggia); all'istante comune il valore interpolato fra le due uscite vicine, se c'è
          const real = pts.slice(1);
          const k = real.findIndex(([h]) => h >= 0);
          const first =
            k > 0 ? real[k - 1][1] + ((real[k][1] - real[k - 1][1]) * (0 - real[k - 1][0])) / (real[k][0] - real[k - 1][0] || 1) : null;
          out = [...(first != null && real[k][0] > 0 ? [[0, first]] : []), ...real.filter(([h]) => h >= 0)];
        }
        const mean = m.id === "mean";
        return { id: m.id, label: mean ? "Mediana" : shortLabel(m.id), mean, color: mean ? null : MULTI_COLORS[m.id] || "#adb5bd", pts: out, run: m.run };
      })
      .filter((l) => l.pts.length > 1);
    chartData = { multi: v, lines, t0: T0, model: "mean", run: ok[0].run, from: 0, until: 384 };
    drawChart();
  }

  function drawMulti(exportW, exportH) {
    const { lines, t0, multi } = chartData;
    const temp = multi === "t850";
    const unit = temp ? "°C" : "mm";
    const W = exportW || Math.max(280, chartUi.body.clientWidth);
    const R = exportW ? CHART_R : 14,
      HEAD = 30,
      AXIS = 34;
    const steps = [...new Set(lines.flatMap((l) => l.pts.map(([h]) => h)))].sort((a, b) => a - b);
    const x0 = 0,
      x1 = steps[steps.length - 1];
    const valueAt = (l, h) => {
      const p = l.pts;
      if (h > p[p.length - 1][0] + 1e-6) return null; // oltre la fine del modello
      for (let i = 1; i < p.length; i++)
        if (p[i][0] >= h) return p[i - 1][1] + ((p[i][1] - p[i - 1][1]) * (h - p[i - 1][0])) / (p[i][0] - p[i - 1][0] || 1);
      return p[0][1];
    };
    const fmt = (x) => (x == null ? "—" : x.toFixed(1).replace("-", "−"));
    const vals = lines.flatMap((l) => l.pts.map(([, x]) => x));
    let lo = temp ? Math.min(0, ...vals) : 0;
    const hi = Math.max(temp ? 0 : 2, ...vals);
    const ticks = niceTicks(lo, hi, 4);
    lo = Math.min(lo, ticks[0]);
    const top = HEAD,
      tickText = (t) => (t % 1 ? t.toFixed(1) : String(t)).replace("-", "−");
    const L = Math.ceil(Math.max(...ticks.map((t) => tickText(t).length)) * 6.6) + 5,
      pw = W - L - R;
    // legenda sotto l'asse: colore e nome, a più colonne
    const per = Math.max(2, Math.floor((pw + L) / 150)), // ~150 px per voce ("ICON-CH2 12.5 mm")
      legRows = Math.ceil(lines.length / per),
      LEG = 14 + legRows * 18;
    const fitH = exportH || (chartUi.body.clientHeight > 320 ? chartUi.body.clientHeight - 12 : null);
    const PH = Math.max(140, (fitH || 380) - HEAD - AXIS - LEG);
    const bot = top + PH,
      hiT = Math.max(hi, ticks[ticks.length - 1]);
    const X = (h) => L + ((h - x0) / (x1 - x0 || 1)) * pw;
    const Y = (y) => bot - ((y - lo) / (hiT - lo || 1)) * PH;
    const svg = [
      `<text class="ch-title" x="0" y="${top - 14}">${temp ? "Temperatura 850 hPa" : "Precipitazione"} <tspan class="ch-note">(${temp ? unit : `${unit}, cumulata`})</tspan></text>`,
    ];
    if (temp && lo < 0) svg.push(`<line class="ch-zero" x1="${L}" x2="${L + pw}" y1="${Y(0)}" y2="${Y(0)}"/>`);
    for (const t of ticks) {
      svg.push(`<line class="ch-grid" x1="${L}" x2="${L + pw}" y1="${Y(t)}" y2="${Y(t)}"/>`);
      svg.push(`<text class="ch-tick" x="${L - 4}" y="${Y(t) + 3.5}" text-anchor="end">${tickText(t)}</text>`);
    }
    const yBot = bot;
    const hourOf = (h) =>
      +new Date(t0 + h * 3600e3).toLocaleString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", hour12: false });
    const perDay = pw / ((x1 - x0) / 24);
    const labelEvery = perDay >= 34 ? 1 : perDay >= 17 ? 2 : 4;
    let nDay = 0;
    for (let h = 1; h <= x1; h++) {
      if (hourOf(h) % 24 !== 0) continue;
      svg.push(`<line class="ch-day" x1="${X(h)}" x2="${X(h)}" y1="${HEAD + 2}" y2="${yBot}"/>`);
      if (nDay++ % labelEvery) continue;
      const d = new Date(t0 + h * 3600e3).toLocaleDateString("it-IT", {
        timeZone: "Europe/Rome",
        ...(perDay >= 52 ? { weekday: "short", day: "numeric" } : { day: "numeric" }),
      });
      svg.push(`<text class="ch-tick" x="${X(h)}" y="${yBot + 16}" text-anchor="middle" font-weight="600">${d}</text>`);
    }
    // la media per ultima, sopra le altre, spessa nel colore del testo
    for (const l of [...lines.filter((x) => !x.mean), ...lines.filter((x) => x.mean)])
      svg.push(
        `<path ${l.mean ? 'class="ch-ens-mean" ' : ""}d="${l.pts.map(([h, x], i) => `${i ? "L" : "M"}${X(h).toFixed(1)},${Y(x).toFixed(1)}`).join("")}" fill="none"${l.mean ? "" : ` stroke="${l.color}"`} stroke-width="${l.mean ? (exportW ? 2.4 : 3) * (temp ? 0.8 : 1) : (exportW ? 1.6 : 2) * (temp ? 0.6 : 1)}" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    // legenda: con la pioggia dal totale più alto al più basso (col totale a fine corsa), con la temperatura i nomi
    const sorted = temp ? lines : [...lines].sort((a, b) => b.pts.at(-1)[1] - a.pts.at(-1)[1]);
    const colW = (pw + L) / per;
    sorted.forEach((l, i) => {
      const x = (i % per) * colW,
        y = yBot + AXIS + 4 + Math.floor(i / per) * 18;
      svg.push(
        `<line ${l.mean ? 'class="ch-ens-mean" ' : `stroke="${l.color}" `}x1="${x}" x2="${x + 14}" y1="${y}" y2="${y}" stroke-width="3" stroke-linecap="round"/>`,
        // ch-leg: font proprio (nell'immagine un testo senza la classe del titolo resterebbe con il font di sistema serif)
        `<text class="ch-leg" x="${x + 19}" y="${y + 4}"><tspan>${l.label}</tspan>${temp ? "" : ` ${fmt(l.pts.at(-1)[1])} ${unit}`}</text>`,
      );
    });
    const H = yBot + AXIS + LEG;
    // valori a un'ora: ogni modello, dal più alto, per tooltip, scheda dell'ora fissata e immagine
    const rowsAt = (h) =>
      lines
        .map((l) => ({ l, v: valueAt(l, h) }))
        .filter((r) => r.v != null)
        .sort((a, b) => b.v - a.v);
    const rowsHtml = (h) =>
      `<div class="ens-vals" style="grid-template-columns:auto 1fr">` +
      rowsAt(h)
        .map(({ l, v }) => `<span class="h"${l.mean ? "" : ` style="color:${l.color}"`}>${l.label}</span><b>${fmt(v)} ${unit}</b>`)
        .join("") +
      "</div>";
    const headOf = (h) => fmtLocal(new Date(t0 + h * 3600e3));
    const pin = chartPin != null && steps.includes(chartPin) ? chartPin : null;
    if (exportW) {
      if (pin != null) svg.push(`<line class="ch-pin" x1="${X(pin)}" x2="${X(pin)}" y1="${HEAD + 2}" y2="${yBot}"/>`);
      const pinBox =
        pin == null
          ? null
          : {
              x: X(pin),
              right: X(x1),
              head: headOf(pin),
              rows: rowsAt(pin).map(({ l, v }) => [[`${l.label} `, false, l.color || undefined], [`${fmt(v)} ${unit}`, true]]),
            };
      return { markup: svg.join(""), W, H, pinBox };
    }
    mountTimeChart({ svg, W, H, L, pw, x0, x1, steps, X, HEAD, yBot, rowsHtml, headOf, pin, label: "Modelli a confronto" });
  }

  // ---------- radiosondaggi osservati (Università del Wyoming, vedi app/soundings.py): le stazioni sulla mappa
  // (Livelli extra, in alternativa a radar e satellite) e, toccandole, il diagramma Skew-T dell'ultimo lancio
  // elenco delle stazioni con i lanci: si richiede dopo 15 minuti (pagina lasciata aperta, nuovi lanci) o se era fallito
  let soundingIndex = null,
    soundingIndexAt = 0;
  async function getSoundingIndex() {
    if (!soundingIndex || Date.now() - soundingIndexAt > 15 * 60e3) {
      soundingIndexAt = Date.now();
      soundingIndex = fetch(STATIC ? "data/soundings/index.json" : "api/soundings")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .catch(() => {
          soundingIndexAt = 0; // al prossimo tentativo si richiede
          return [];
        });
    }
    return soundingIndex;
  }
  async function getSounding(station, time) {
    const r = await fetch(
      STATIC ? `data/soundings/${station}/${time}.json` : `api/sounding?${new URLSearchParams({ station, time })}`,
    );
    if (!r.ok) throw new Error("radiosondaggio non disponibile");
    return r.json();
  }
  map.createPane("soundings");
  map.getPane("soundings").style.zIndex = 640; // sopra le località
  const soundingLayer = L.layerGroup();
  const BALLOON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2a6 6 0 0 0-6 6c0 3.6 3.1 6.6 5 7.6V17h2v-1.4c1.9-1 5-4 5-7.6a6 6 0 0 0-6-6z"/>' +
    '<path d="M11 18h2l-.5 4h-1z"/></svg>';
  async function renderSoundings() {
    const on = state.extra === "snd" && !synoptic();
    const index = on ? await getSoundingIndex() : [];
    soundingLayer.clearLayers(); // dopo l'attesa: due chiamate ravvicinate non raddoppiano le stazioni
    if (!on || state.extra !== "snd" || synoptic()) {
      soundingLayer.remove();
      return;
    }
    soundingLayer.addTo(map);
    for (const st of index) {
      if (state.extra !== "snd") continue;
      const short = st.name.replace(/ \(.*\)$/, "");
      const ok = st.times.length > 0; // lancio non ancora scaricato: icona d'errore e avviso al tocco
      const m = L.marker([st.lat, st.lon], {
        pane: "soundings",
        keyboard: false,
        icon: L.divIcon({
          className: ok ? "snd-marker" : "snd-marker snd-missing",
          html: `<span class="snd-dot">${ok ? BALLOON : "!"}</span><span class="snd-name">${short}</span>`,
          iconSize: null,
        }),
        title: ok ? `Radiosondaggio ${st.name}` : `${st.name}: radiosondaggio non ancora disponibile`,
      }).addTo(soundingLayer);
      // senza dati: un avviso che sparisce da solo (un fumetto sposterebbe la mappa vicino ai bordi)
      m.on("click", () =>
        ok ? openSounding(st.id) : toast(`${short}: radiosondaggio non ancora disponibile, riprova più tardi`, true),
      );
    }
  }

  async function openSounding(station, time = null, pushHistory = true) {
    const st = (await getSoundingIndex()).find((x) => x.id === station);
    if (!st || !st.times.length) return;
    const t = st.times[0]; // sempre l'ultimo lancio disponibile
    chartUi.dialog.classList.add("side-panel"); // su desktop pannello stretto che entra da destra
    chartUi.title.textContent = st.name;
    chartUi.model.hidden = true;
    chartUi.multi.hidden = true;
    chartUi.sounding.hidden = true;
    chartContext = {
      place: { name: st.name, lat: st.lat, lon: st.lon },
      model: "sounding",
      run: null,
      from: 0,
      until: 0,
      sounding: { station, time: t },
    };
    writeChartHash(pushHistory && !chartUi.dialog.open);
    if (!chartUi.dialog.open) chartUi.dialog.showModal();
    chartUi.dialog.focus();
    await loadSounding();
  }
  // pannello laterale: un clic fuori (sulla mappa velata) lo chiude
  chartUi.dialog.addEventListener("click", (e) => {
    if (e.target !== chartUi.dialog || !chartUi.dialog.classList.contains("side-panel")) return;
    const r = chartUi.dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) chartUi.dialog.close();
  });
  chartUi.sounding.addEventListener("change", () => {
    if (!chartContext?.sounding) return;
    chartContext.sounding.time = chartUi.sounding.value;
    loadSounding();
  });

  async function loadSounding() {
    const request = chartContext;
    const { station, time } = request.sounding;
    chartUi.details.textContent = "Radiosondaggio"; // poi ora del lancio, zero termico e base nubi (drawSkewT)
    chartUi.warn.hidden = true;
    chartUi.body.innerHTML = '<div class="chart-empty">Caricamento…</div>';
    chartData = null;
    chartPin = null;
    $("chart-readout").hidden = true;
    writeChartHash();
    try {
      const snd = await getSounding(station, time);
      if (chartContext !== request || !chartUi.dialog.open) return;
      chartData = { sounding: snd, model: "sounding", run: time };
      drawChart();
    } catch (e) {
      if (chartContext !== request || !chartUi.dialog.open) return;
      chartUi.body.innerHTML = `<div class="chart-empty">Grafico non disponibile: ${e.message}</div>`;
    }
  }

  // ---------- diagramma Skew-T: pressione in scala logaritmica in verticale, isoterme inclinate di 45°; temperatura
  // (rossa) e punto di rugiada (verde), adiabatiche secche, zero gradi evidenziato, vento a destra con le barbe
  const DEW_GREEN = "#40c057";
  const TEMP_RED = "#ff6b6b";
  /** Indici dal profilo: zero termico (prima volta che la temperatura scende sotto 0 salendo) e base delle nubi da
   *  sollevamento (LCL) della particella al suolo (formula di Espy, ~125 m per grado di differenza T - Td). */
  function soundingIndices(levels) {
    const lv = levels.filter((l) => l[1] != null && l[2] != null);
    let zero = null;
    for (let i = 1; i < lv.length; i++) {
      const [, za, ta] = lv[i - 1],
        [, zb, tb] = lv[i];
      if (ta >= 0 && tb < 0) {
        zero = za + ((zb - za) * ta) / (ta - tb || 1);
        break;
      }
    }
    if (zero == null && lv[0]?.[2] < 0) zero = lv[0][1]; // già sotto zero al suolo
    const g = levels[0];
    const lcl = g && g[2] != null && g[3] != null ? g[1] + 125 * (g[2] - g[3]) : null;
    return { zero, lcl, ground: g?.[1] };
  }
  function drawSkewT(exportW, exportH) {
    const snd = chartData.sounding;
    const levels = snd.levels.filter((l) => l[0] >= 100);
    const avail = exportW || Math.max(280, chartUi.body.clientWidth);
    const HEAD = 12, // ora e indici sono nel sottotitolo sotto la località
      L = 34,
      R = 46; // a destra le barbe del vento
    const fitH = exportH || (chartUi.body.clientHeight > 320 ? chartUi.body.clientHeight - 12 : null);
    const PH = Math.max(260, Math.min((fitH || 560) - HEAD - 40, (avail - L - R) * 2.2)); // sotto: gradi e legenda (40)
    // diagramma più o meno quadrato: su schermi larghi non si allarga oltre (resterebbero 200 °C di scala)
    const pw = Math.min(avail - L - R, Math.round(PH * 0.85)),
      W = exportW || L + pw + R;
    const top = HEAD,
      bot = top + PH;
    const P0 = Math.max(1000, Math.ceil(levels[0][0] / 10) * 10 + 10),
      P1 = 100;
    const Y = (p) => bot - ((Math.log(P0) - Math.log(p)) / (Math.log(P0) - Math.log(P1))) * PH; // 1000 hPa in basso
    // temperature: 80 °C sulla larghezza; dal suolo a 100 hPa le isoterme si spostano di 70 °C verso destra, così
    // il profilo resta dentro su schermi stretti e alti come su quelli larghi. Al suolo la temperatura cade a ~60%
    const degPx = pw / 80,
      SKEW = 70;
    const tGround = levels.find((l) => l[2] != null)?.[2] ?? 10;
    const T0 = Math.floor((tGround - 48) / 10) * 10,
      T1 = T0 + 80;
    const X = (t, p) => L + (t - T0 + (SKEW * (bot - Y(p))) / PH) * degPx;
    const svg = [
      `<defs><clipPath id="skc"><rect x="${L}" y="${top}" width="${pw}" height="${PH}"/></clipPath></defs>`,
    ];
    const ix = soundingIndices(levels);
    const km = (m) => (m == null ? "—" : `${Math.round(m / 10) * 10} m`);
    const when = (() => {
      const k = snd.time;
      const d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(8, 10)));
      return `${k.slice(8, 10)} UTC ${d.toLocaleDateString("it-IT", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })}`;
    })();
    // sottotitolo sotto la località (anche nell'immagine condivisa): ora del lancio, zero termico e base nubi
    chartUi.details.innerHTML = `${when} · <b class="snd-ix">Zero termico ${km(ix.zero)}</b> · <b class="snd-ix">base nubi ${km(ix.lcl)}</b>`;
    // griglia: livelli di pressione
    for (const p of [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100]) {
      if (p > P0) continue;
      svg.push(`<line class="ch-grid" x1="${L}" x2="${L + pw}" y1="${Y(p)}" y2="${Y(p)}"/>`);
      svg.push(`<text class="ch-tick" x="${L - 4}" y="${Y(p) + 3.5}" text-anchor="end">${p}</text>`);
    }
    const g = [`<g clip-path="url(#skc)">`];
    // isoterme ogni 10 °C (lo zero più marcato) e adiabatiche secche ogni 10 K
    for (let t = Math.floor((T0 - 100) / 10) * 10; t <= T1; t += 10)
      g.push(
        `<line x1="${X(t, P0)}" y1="${bot}" x2="${X(t, P1)}" y2="${top}" stroke="${t === 0 ? "#4dabf7" : "currentColor"}" stroke-opacity="${t === 0 ? 0.9 : 0.12}" stroke-width="${t === 0 ? 1.4 : 1}"/>`,
      );
    for (let th = -30; th <= 120; th += 10) {
      let d = "";
      for (let p = P0; p >= P1; p -= 25) {
        const t = (th + 273.15) * (p / 1000) ** 0.2857 - 273.15;
        d += `${d ? "L" : "M"}${X(t, p).toFixed(1)},${Y(p).toFixed(1)}`;
      }
      g.push(`<path d="${d}" fill="none" stroke="#fab005" stroke-opacity="0.18" stroke-dasharray="4 4"/>`);
    }
    const line = (k, color, w) => {
      let d = "";
      for (const l of levels) if (l[k] != null) d += `${d ? "L" : "M"}${X(l[k], l[0]).toFixed(1)},${Y(l[0]).toFixed(1)}`;
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
    };
    g.push(line(3, DEW_GREEN, exportW ? 1.8 : 2.2), line(2, TEMP_RED, exportW ? 1.8 : 2.2));
    g.push("</g>");
    svg.push(...g);
    // niente gradi sulle isoterme (troppo carico): le temperature si leggono nel tooltip, lo zero è in legenda
    // vento: barbe a destra ai livelli principali (da dove viene; mezza barba 5 nodi, intera 10, triangolo 50)
    const bx = L + pw + 24;

    const near = (p) => levels.reduce((a, b) => (Math.abs(b[0] - p) < Math.abs(a[0] - p) ? b : a));
    for (const p of [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100]) {
      if (p > P0) continue;
      const l = near(p);
      if (Math.abs(l[0] - p) > p * 0.05 || l[4] == null || l[5] == null) continue;
      const y = Y(l[0]),
        kt = l[5] / 1.852,
        a = (l[4] * Math.PI) / 180;
      const ux = Math.sin(a),
        uy = -Math.cos(a); // verso da cui arriva
      const len = 20;
      const ex = bx + ux * len,
        ey = y + uy * len;
      let path = `M${bx},${y}L${ex.toFixed(1)},${ey.toFixed(1)}`;
      let rest = Math.round(kt / 5) * 5,
        pos = 0;
      const px = -uy,
        py = ux; // perpendicolare
      const at = (f) => [bx + ux * len * f, y + uy * len * f];
      while (rest >= 50) {
        const [x1, y1] = at(1 - pos),
          [x2, y2] = at(1 - pos - 0.2);
        path += `M${x1.toFixed(1)},${y1.toFixed(1)}L${(x1 + px * 8).toFixed(1)},${(y1 + py * 8).toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`;
        rest -= 50;
        pos += 0.25;
      }
      while (rest >= 10) {
        const [x1, y1] = at(1 - pos);
        path += `M${x1.toFixed(1)},${y1.toFixed(1)}l${(px * 8 + ux * 3).toFixed(1)},${(py * 8 + uy * 3).toFixed(1)}`;
        rest -= 10;
        pos += 0.15;
      }
      if (rest >= 5) {
        const [x1, y1] = at(1 - pos - (pos ? 0 : 0.12));
        path += `M${x1.toFixed(1)},${y1.toFixed(1)}l${(px * 4 + ux * 1.5).toFixed(1)},${(py * 4 + uy * 1.5).toFixed(1)}`;
      }
      if (kt < 2.5) svg.push(`<circle cx="${bx}" cy="${y}" r="3" fill="none" stroke="currentColor" stroke-opacity="0.7"/>`);
      else svg.push(`<path d="${path}" fill="none" stroke="currentColor" stroke-opacity="0.8" stroke-width="1.2" stroke-linejoin="round"/>`);
    }
    // legenda in fondo
    const H = bot + 40;
    svg.push(
      `<line x1="${L}" x2="${L + 14}" y1="${H - 8}" y2="${H - 8}" stroke="${TEMP_RED}" stroke-width="3" stroke-linecap="round"/>`,
      `<text class="ch-leg" x="${L + 19}" y="${H - 4}"><tspan>Temperatura</tspan></text>`,
      `<line x1="${L + 120}" x2="${L + 134}" y1="${H - 8}" y2="${H - 8}" stroke="${DEW_GREEN}" stroke-width="3" stroke-linecap="round"/>`,
      `<text class="ch-leg" x="${L + 139}" y="${H - 4}"><tspan>Punto di rugiada</tspan></text>`,
      // l'isoterma di zero gradi (blu, inclinata come tutte le isoterme): dove la incrocia la rossa c'è lo zero termico
      `<line x1="${L + 252}" x2="${L + 266}" y1="${H - 8}" y2="${H - 8}" stroke="#4dabf7" stroke-width="2" stroke-linecap="round"/>`,
      `<text class="ch-leg" x="${L + 271}" y="${H - 4}"><tspan>0 °C</tspan></text>`,
    );
    if (exportW) return { markup: svg.join("").replace(/currentColor/g, "#c9ced6"), W, H, pinBox: null };
    // tooltip: il livello più vicino alla quota del puntatore
    chartUi.body.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Radiosondaggio" style="color:var(--fg);max-width:${W}px;display:block">${svg.join("")}` +
      `<line id="snd-cursor" x1="${L}" x2="${L + pw}" y1="0" y2="0" stroke="var(--fg)" stroke-opacity="0.5" visibility="hidden"/>` +
      `<rect id="snd-hit" x="${L}" y="${top}" width="${pw + R}" height="${PH}" fill="transparent"/></svg>` +
      '<div class="chart-tip" hidden></div>';
    const svgEl = chartUi.body.querySelector("svg"),
      tip = chartUi.body.querySelector(".chart-tip"),
      cur = svgEl.querySelector("#snd-cursor"),
      hit = svgEl.querySelector("#snd-hit");
    const show = (ev) => {
      const r = svgEl.getBoundingClientRect();
      const y = (ev.clientY - r.top) * (H / r.height);
      const l = levels.reduce((a, b) => (Math.abs(Y(b[0]) - y) < Math.abs(Y(a[0]) - y) ? b : a));
      cur.setAttribute("y1", Y(l[0]));
      cur.setAttribute("y2", Y(l[0]));
      cur.setAttribute("visibility", "visible");
      const f = (x, u, d = 1) => (x == null ? "—" : `${x.toFixed(d).replace("-", "−")} ${u}`);
      const dir = l[4] == null ? "" : (dirName(-10 * Math.sin((l[4] * Math.PI) / 180), -10 * Math.cos((l[4] * Math.PI) / 180)) || "");
      tip.innerHTML =
        `<div class="t">${l[0]} hPa · ${f(l[1], "m", 0)}</div>` +
        `<div class="ens-vals" style="grid-template-columns:auto 1fr">` +
        `<span class="h" style="color:${TEMP_RED}">Temperatura</span><b>${f(l[2], "°C")}</b>` +
        `<span class="h" style="color:${DEW_GREEN}">Rugiada</span><b>${f(l[3], "°C")}</b>` +
        `<span class="h">Vento</span><b>${l[5] == null ? "—" : `${Math.round(l[5])} km/h${dir ? ` da ${dir}` : ""}`}</b></div>`;
      tip.hidden = false;
      const br = chartUi.body.getBoundingClientRect();
      const cx = ev.clientX - br.left,
        w = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(cx + 14 + w > br.width ? cx - 14 - w : cx + 14, 4), br.width - w - 4)}px`;
      tip.style.top = `${Math.max(4, ev.clientY - br.top + chartUi.body.scrollTop - 20)}px`;
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType === "mouse") {
        tip.hidden = true;
        cur.setAttribute("visibility", "hidden");
      }
    });
    clearChartPin = () => {};
  }

  function drawChart(exportW, exportH) {
    if (chartData.ensemble) return drawEnsemble(exportW, exportH);
    if (chartData.multi) return drawMulti(exportW, exportH);
    if (chartData.sounding) return drawSkewT(exportW, exportH);
    const { series, run, from, until } = chartData;
    // Il grafico usa lo stesso intervallo della mappa. Fuori dalla modalità intervallo `from` è 0, come prima.
    const V = Object.fromEntries(
      Object.entries(series.vars).map(([k, v]) => {
        const keep = v.steps
          .map((x, i) =>
            (from == null || x >= from) && (until == null || x <= until)
              ? i
              : -1,
          )
          .filter((i) => i >= 0);
        return [
          k,
          {
            ...v,
            steps: keep.map((i) => v.steps[i]),
            values: keep.map((i) => v.values[i]),
          },
        ];
      }),
    );
    const t0 = runDate(run).getTime();
    const W = exportW || Math.max(280, chartUi.body.clientWidth);
    const R = CHART_R;
    let L = CHART_AXIS, // si stringe sui numeri dell'asse, vedi sotto
      pw = W - L - R;
    let PH = 78;
    const HEAD = 30,
      GAP = 16,
      AXIS = 34; // altezza grafico, titolo, spazio fra pannelli, asse dei tempi
    const steps = [...new Set(Object.values(V).flatMap((v) => v.steps))].sort(
      (a, b) => a - b,
    );
    if (!steps.length) {
      if (exportW) return null;
      chartUi.body.innerHTML =
        '<div class="chart-empty">Nessun dato in questo punto.</div>';
      return;
    }
    // l'asse parte dal primo valore (+3h: l'istante 0 dei modelli non si scarica), così le linee partono dal bordo;
    // la pioggia delle prime ore (colonna 0-3h) resta nel totale e nell'accumulo
    const x0 = from > 0 ? from : steps[0],
      x1 = steps[steps.length - 1];
    const X = (h) => L + ((h - x0) / (x1 - x0 || 1)) * pw;
    const fmt = (x, d) => (x == null ? "—" : x.toFixed(d).replace("-", "−"));
    // barre per intervallo dalle cumulate (pioggia, neve)
    const rawRain = series.vars.tp;
    const rainBaseIndex = rawRain?.steps.indexOf(from) ?? -1;
    const rainBase = from > 0 ? rawRain?.values[rainBaseIndex] : 0;
    const intervals = (v) =>
      v.steps.map((b, i) => {
        const a = i ? v.steps[i - 1] : from > 0 ? from : 0;
        const cur = v.values[i],
          prev = i ? v.values[i - 1] : 0;
        return {
          a,
          b,
          y:
            (!i && from > 0) || cur == null || prev == null
              ? null
              : Math.max(0, cur - prev),
          cum:
            cur == null || rainBase == null
              ? null
              : Math.max(0, cur - rainBase),
        };
      });
    const points = (v) => v.steps.map((x, i) => ({ x, y: v.values[i] }));
    /** Pioggia: barre sempre al passo del modello (3 ore, 6 dopo +144h), per vedere quando piove; sopra, la curva
     *  dell'accumulo dall'inizio del periodo mostrato (scala a destra). Il tooltip dice anche quanto vale, a ogni ora,
     *  una finestra della stessa durata scelta sulla mappa. */
    const rainHours =
      variable()?.modes?.includes("interval") && state.mode === "interval"
        ? intervalHours()
        : null;
    const panels = [];
    if (V.tp) {
      const at = new Map(rawRain.steps.map((x, i) => [x, rawRain.values[i]]));
      // neve (cm, 10:1 = mm d'acqua) dei modelli che la danno: per ogni barra la parte caduta come neve
      const rawSnow = series.vars.sf;
      const snowAt = new Map((rawSnow?.steps || []).map((x, i) => [x, rawSnow.values[i]]));
      const snowBase = from > 0 ? (series.vars.sf?.values[series.vars.sf.steps.indexOf(from)] ?? null) : 0;
      const withSnow = (d) => {
        if (!V.sf) return d;
        const cur = snowAt.get(d.b),
          prev = d.a > 0 ? snowAt.get(d.a) : 0;
        const snow = cur == null || prev == null || d.y == null ? null : Math.min(d.y, Math.max(0, cur - prev));
        return { ...d, snow, snowCum: cur == null || snowBase == null ? null : Math.max(0, cur - snowBase) };
      };
      const data = intervals(V.tp).map(withSnow).map((d) => {
        if (!rainHours || d.b - d.a >= rainHours || d.cum == null) return d;
        const a = V.tp.steps.filter((x) => x <= d.b - rainHours).pop() ?? 0; // come intervalPrev nella mappa
        const prev = a ? at.get(a) : 0;
        return {
          ...d,
          win: prev == null ? null : Math.max(0, d.cum - prev),
          winH: d.b - a,
        };
      });
      // con neve prevista il pannello diventa "Precipitazione" e la parte di neve delle barre è viola
      const snowTot = [...data].reverse().find((d) => d.snowCum != null)?.snowCum;
      const snowy = data.some((d) => d.snow >= 0.05);
      panels.push({
        title: snowy ? "Precipitazione" : "Pioggia",
        unit: "mm",
        kind: "bar",
        color: "#2f7fd8",
        data,
        dec: 1,
        min: 1,
        cum: data.map((d) => ({ x: d.b, y: d.cum })),
        snowCum: snowy ? data.map((d) => ({ x: d.b, y: d.snowCum })) : null, // area viola dentro l'accumulo
        cumLabel: from > 0 ? "periodo" : "tot",
        // "tot. 15.2 mm (12.3 cm)": tra parentesi la neve, se c'è
        note:
          `${from > 0 ? "periodo" : "tot."} ${fmt([...data].reverse().find((d) => d.cum != null)?.cum, 1)} mm` +
          (snowy ? ` (${fmt(snowTot, 1)} cm)` : ""),
        tip: (d) => `+${d.b - d.a}h`, // solo la durata della colonna: la grandezza si capisce dai mm
      });
    }
    if (V.t850)
      panels.push({
        title: "Temperatura 850 hPa",
        unit: "°C",
        kind: "line",
        color: "#d9480f",
        data: points(V.t850),
        dec: 1,
        zero: true,
        tip: () => "T 850 hPa",
      });
    if (V.hzero)
      panels.push({
        title: "Zero termico",
        unit: "m",
        kind: "line",
        color: "#0b7285",
        data: points(V.hzero),
        dec: 0,
        tip: () => "Zero termico",
      });
    if (V.u10 && V.v10) {
      const data = V.u10.steps.map((x, i) => {
        const u = V.u10.values[i],
          v = V.v10.values[i];
        return { x, y: u == null || v == null ? null : Math.hypot(u, v), u, v };
      });
      panels.push({
        title: "Vento 10 m",
        unit: "km/h",
        kind: "line",
        color: "#495057",
        data,
        dec: 0,
        arrows: true,
        min: 10,
        tip: () => "Vento 10 m",
      });
    }
    // valori di un pannello a un passo: per il tooltip (con <b>) e per i titoli dell'immagine (testo semplice)
    // barre: quella che contiene il passo (con le cumulate lunghe una barra copre più passi)
    const valueAt = (p, st) =>
      p.data.find((e) =>
        p.kind === "bar" ? st > e.a && st <= e.b : e.x === st,
      );
    const valueText = (p, d, b = (x) => x, span = true) => {
      // span: "in 3h" per le barre (il tooltip lo dice già)
      const extra =
        p.arrows && d.y != null
          ? dirName(d.u, d.v)
            ? ` da ${dirName(d.u, d.v)}`
            : ""
          : p.kind === "bar" && d.cum != null
            ? (d.win != null
                ? ` · in ${d.winH}h ${b(fmt(d.win, p.dec))} ${p.unit}`
                : "") +
              ` · ${p.cumLabel || "tot"} ${b(fmt(d.cum, p.dec))} ${p.unit}` +
              (d.snowCum >= 0.05 ? ` (${b(fmt(d.snowCum, 1))} cm)` : "")
            : ""; // cumulata della mappa (se scelta) e totale dall'inizio
      const snow = p.kind === "bar" && d.snow >= 0.05 ? ` (${b(fmt(d.snow, 1))} cm)` : ""; // neve, come nel titolo
      return `${b(fmt(d.y, p.dec))} ${p.unit}${span && p.kind === "bar" ? ` in ${d.b - d.a}h` : ""}${snow}${extra}`;
    };
    const pin =
      exportW && chartPin != null && steps.includes(chartPin) ? chartPin : null;
    // immagine verticale: i pannelli si allungano fino a riempire l'altezza disponibile
    if (exportH && panels.length)
      PH = Math.max(
        48,
        Math.floor((exportH - AXIS) / panels.length - HEAD - GAP),
      );
    for (const p of panels) p.h = PH;
    // a schermo: i pannelli riempiono la finestra, la precipitazione (barre fitte) un po' più alta delle curve;
    // mai sotto PH (su schermi bassi la finestra scorre come prima) né sopra CHART_MAX_PH
    if (!exportW && panels.length) {
      const body = chartUi.body;
      const free =
        body.clientHeight -
        parseFloat(getComputedStyle(body).paddingTop) -
        AXIS -
        panels.length * (HEAD + GAP);
      const weight = (p) => (p.kind === "bar" ? 1.4 : 1);
      const total = panels.reduce((s, p) => s + weight(p), 0);
      for (const p of panels)
        p.h = Math.max(PH, Math.min(CHART_MAX_PH, Math.floor((free * weight(p)) / total)));
    }
    const H = panels.reduce((s, p) => s + HEAD + p.h + GAP, 0) + AXIS;
    const svg = [];
    // giorni (mezzanotte locale) e ore ogni 6 ore, ora di Roma come nel resto della pagina
    const hourOf = (h) =>
      +new Date(t0 + h * 3600e3).toLocaleString("it-IT", {
        timeZone: "Europe/Rome",
        hour: "2-digit",
        hour12: false,
      });
    const days = [],
      hours = [];
    const every =
      pw / ((x1 - x0) / 6) >= 30 ? 6 : pw / ((x1 - x0) / 12) >= 30 ? 12 : 24;
    for (let h = Math.ceil(x0); h <= x1; h++) {
      const hh = hourOf(h) % 24;
      if (hh === 0) days.push(h);
      else if (hh % every === 0) hours.push([h, hh]);
    }
    // scala di ogni pannello (estremi e numeri dell'asse), prima di disegnare: serve la larghezza dei numeri
    const tickText = (t) => fmt(t, Math.abs(t) < 10 && t % 1 ? 1 : 0);
    for (const p of panels) {
      const vals = p.data.map((d) => d.y).filter((y) => y != null);
      let lo = p.kind === "bar" ? 0 : Math.min(...vals),
        hi = Math.max(p.min ?? -Infinity, ...vals);
      if (p.zero) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      if (p.kind === "line") {
        const pad = (hi - lo) * 0.1 || 1;
        lo -= p.min != null && lo >= 0 ? 0 : pad;
        hi += pad;
      }
      if (p.min != null && p.kind === "line") lo = Math.max(0, lo);
      const ticks = niceTicks(lo, hi);
      p.scale = { ticks, lo: Math.min(lo, ticks[0]), hi: Math.max(hi, ticks[ticks.length - 1]) };
    }
    // il grafico parte subito dopo il numero più largo dell'asse a sinistra (11-11.5 px, ~6.6 px per cifra): più largo
    // soprattutto su telefono
    if (panels.length) {
      const chars = Math.max(...panels.flatMap((p) => p.scale.ticks.map((t) => tickText(t).length)));
      L = Math.ceil(chars * 6.6) + 5;
      pw = W - L - R;
    }
    let panelTop = 0;
    panels.forEach((p) => {
      const PH = p.h,
        top = panelTop + HEAD,
        bot = top + PH;
      panelTop = bot + GAP;
      const { ticks, lo, hi } = p.scale;
      const Y = (y) => bot - ((y - lo) / (hi - lo || 1)) * PH;
      p.Y = Y;
      p.top = top;
      p.bot = bot;
      const pd = pin != null ? valueAt(p, pin) : null;
      svg.push(
        `<text class="ch-title" x="0" y="${top - 14}">${p.title} <tspan class="ch-note">(${p.unit})${p.note ? " · " + p.note : ""}</tspan></text>`,
      );
      for (const t of ticks) {
        svg.push(
          `<line class="ch-grid" x1="${L}" x2="${L + pw}" y1="${Y(t)}" y2="${Y(t)}"/>`,
        );
        svg.push(
          `<text class="ch-tick" x="${L - 4}" y="${Y(t) + 3.5}" text-anchor="end">${tickText(t)}</text>`,
        );
      }
      if (p.zero && lo < 0 && hi > 0)
        svg.push(
          `<line class="ch-zero" x1="${L}" x2="${L + pw}" y1="${Y(0)}" y2="${Y(0)}"/>`,
        );
      if (p.kind === "bar") {
        let accLine = "";
        if (p.cum) {
          // accumulo dall'inizio della corsa: area azzurra dietro le barre, linea blu sopra, scala a destra
          const cvals = p.cum.map((d) => d.y).filter((y) => y != null);
          const cmax = Math.max(1, ...cvals),
            cticks = niceTicks(0, cmax);
          const cstep = cticks[1] - cticks[0] || 1;
          while (cticks[cticks.length - 1] < cmax)
            cticks.push(cticks[cticks.length - 1] + cstep); // la linea resta nel pannello
          const chi = cticks[cticks.length - 1] || 1;
          const Yc = (y) => bot - (y / chi) * PH;
          let path = `M${X(x0).toFixed(1)},${bot}`,
            lastX = X(x0);
          for (const d of p.cum)
            if (d.y != null) {
              lastX = X(d.x);
              path += `L${lastX.toFixed(1)},${Yc(d.y).toFixed(1)}`;
            }
          svg.push(
            `<path class="ch-acc-area" d="${path}L${lastX.toFixed(1)},${bot}Z" stroke="none"/>`,
          );
          if (p.snowCum) {
            // neve accumulata (cm, 10:1 = mm d'acqua: stessa scala) come area viola sotto quella della precipitazione
            let sp = `M${X(x0).toFixed(1)},${bot}`,
              sx = X(x0);
            for (const d of p.snowCum)
              if (d.y != null) {
                sx = X(d.x);
                sp += `L${sx.toFixed(1)},${Yc(d.y).toFixed(1)}`;
              }
            svg.push(
              `<path d="${sp}L${sx.toFixed(1)},${bot}Z" fill="${SNOW_BAR}" fill-opacity="0.22" stroke="none"/>`,
              `<path d="${sp.replace(/^M[^L]*L/, "M")}" fill="none" stroke="${SNOW_BAR}" stroke-opacity="0.8" stroke-width="1" stroke-linejoin="round"/>`,
            );
          }
          accLine = `<path class="ch-acc" d="${path}" fill="none" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>`;
          for (const t of cticks)
            svg.push(
              `<text class="ch-tick ch-acc-tick" x="${L + pw + 5}" y="${Yc(t) + 3.5}">${fmt(t, 0)}</text>`,
            );
        }
        const flakes = []; // colonne con neve: fiocco sopra
        for (const d of p.data) {
          if (d.y == null || d.y < 0.05 || d.b <= x0) continue; // colonna prima dell'inizio dell'asse
          const xa = X(Math.max(d.a, x0)) + 1,
            xb = X(d.b) - 1,
            y = Y(d.y);
          svg.push(
            `<rect x="${xa}" y="${y}" width="${Math.max(1, xb - xa)}" height="${Math.max(0, bot - y)}" rx="1.5" fill="${p.color}"${pin != null && pin > d.a && pin <= d.b ? ' class="ch-pin-bar"' : ""}/>`,
          );
          // neve: la parte alta della barra, in viola (quanta della precipitazione cade come neve)
          if (d.snow >= 0.05) {
            const ys = y + (bot - y) * (d.snow / d.y);
            svg.push(
              `<rect x="${xa}" y="${y}" width="${Math.max(1, xb - xa)}" height="${Math.max(0, ys - y)}" rx="1.5" fill="${SNOW_BAR}"/>`,
            );
            flakes.push({ x: (xa + xb) / 2, y: y - 3, cm: d.snow });
          }
        }
        // fiocco sopra ogni colonna con neve (\uFE0E: simbolo di testo, non l'emoji colorata)
        for (const f of flakes)
          svg.push(
            `<text x="${f.x.toFixed(1)}" y="${f.y.toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="${SNOW_BAR}">\u2744\uFE0E</text>`,
          );
        if (accLine) svg.push(accLine);
      } else {
        let path = "",
          pen = false;
        for (const d of p.data) {
          if (d.y == null) {
            pen = false;
            continue;
          }
          path += `${pen ? "L" : "M"}${X(d.x).toFixed(1)},${Y(d.y).toFixed(1)}`;
          pen = true;
        }
        svg.push(
          `<path d="${path}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
        if (pd && pd.y != null)
          p.pinDot = `<circle class="ch-pin-dot" cx="${X(pin).toFixed(1)}" cy="${Y(pd.y).toFixed(1)}" r="4" fill="${p.color}"/>`;
      }
      if (p.arrows) {
        // frecce verso dove va il vento, una ogni ~22 px
        const k = Math.max(1, Math.ceil(22 / (pw / p.data.length)));
        p.data.forEach((d, j) => {
          if (j % k || d.u == null || d.y < 2) return;
          const ang = (Math.atan2(-d.v, d.u) * 180) / Math.PI; // schermo: y verso il basso
          svg.push(
            `<g transform="translate(${X(d.x).toFixed(1)},${top + 7}) rotate(${ang.toFixed(0)})" stroke="${p.color}" stroke-width="1.4" fill="none" stroke-linecap="round"><path d="M-6,0H6M2.5,-3.5L6,0L2.5,3.5"/></g>`,
          );
        });
      }
    });
    const yTop = 0,
      yBot = H - AXIS;
    // nomi dei giorni ("mer 11") se c'è spazio, altrimenti solo il numero
    const dayFmt =
      pw / ((x1 - x0) / 24) >= 52
        ? { weekday: "short", day: "numeric" }
        : { day: "numeric" };
    for (const h of days) {
      svg.push(
        `<line class="ch-day" x1="${X(h)}" x2="${X(h)}" y1="${HEAD + 2}" y2="${yBot}"/>`,
      );
      const d = new Date(t0 + h * 3600e3).toLocaleDateString("it-IT", {
        timeZone: "Europe/Rome",
        ...dayFmt,
      });
      svg.push(
        `<text class="ch-tick" x="${X(h)}" y="${yBot + 26}" text-anchor="middle" font-weight="600">${d}</text>`,
      );
      svg.push(
        `<text class="ch-tick" x="${X(h)}" y="${yBot + 12}" text-anchor="middle">00</text>`,
      );
    }
    for (const [h, hh] of hours)
      svg.push(
        `<text class="ch-tick" x="${X(h)}" y="${yBot + 12}" text-anchor="middle">${String(hh).padStart(2, "0")}</text>`,
      );
    if (pin != null) {
      // linea dell'ora fissata sopra tutto, poi i pallini
      svg.push(
        `<line class="ch-pin" x1="${X(pin)}" x2="${X(pin)}" y1="${HEAD + 2}" y2="${yBot}"/>`,
      ); // il riquadro coi valori le sta accanto, in alto
      for (const p of panels) if (p.pinDot) svg.push(p.pinDot);
    }
    if (exportW) {
      // riquadro dell'ora fissata, come nella pagina ma senza i link: righe di pezzi [testo, grassetto?]
      const B = "\u0001",
        E = "\u0002"; // segnaposto del grassetto, poi divisi in pezzi
      const pinBox =
        pin == null
          ? null
          : {
              x: X(pin),
              right: X(x1),
              head: `${fmtLocal(new Date(t0 + pin * 3600e3))} · +${pin}h`,
              rows: panels
                .map((p) => {
                  const d = valueAt(p, pin);
                  if (!d) return null;
                  return `${p.tip(d)} ${valueText(p, d, (x) => B + x + E, false)}`
                    .split(/(?=\u0001)|\u0002/)
                    .filter(Boolean)
                    .map((t) => (t[0] === B ? [t.slice(1), true] : [t, false]));
                })
                .filter(Boolean),
            };
      return { markup: svg.join(""), W, H, pinBox };
    }
    svg.push(
      `<line class="ch-cursor" id="ch-cursor" x1="0" x2="0" y1="${HEAD + 2}" y2="${yBot}" visibility="hidden"/>`,
    );
    // ora fissata: linea e pallini sulle curve; i valori stanno nella barra in fondo alla finestra (#chart-readout)
    svg.push(
      `<line class="ch-cursor pinned" id="ch-pinline" x1="0" x2="0" y1="${HEAD + 2}" y2="${yBot}" visibility="hidden"/><g id="ch-pindots"></g>`,
    );
    svg.push(
      `<rect id="ch-hit" x="${L}" y="${yTop}" width="${pw}" height="${yBot}" fill="transparent"/>`,
    );
    chartUi.body.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Andamento nel tempo">${svg.join("")}</svg>` +
      '<div class="chart-tip" hidden></div>';

    // lettura dei valori: il passo più vicino al puntatore, su tutti i pannelli
    const svgEl = chartUi.body.querySelector("svg"),
      tip = chartUi.body.querySelector(".chart-tip");
    const cursor = svgEl.querySelector("#ch-cursor"),
      pinLine = svgEl.querySelector("#ch-pinline");
    const pinDots = svgEl.querySelector("#ch-pindots");
    const stepAt = (clientX) => {
      const r = svgEl.getBoundingClientRect();
      const h =
        x0 + ((((clientX - r.left) / r.width) * W - L) / pw) * (x1 - x0);
      return steps.reduce((a, b) =>
        Math.abs(b - h) < Math.abs(a - h) ? b : a,
      );
    };
    // ora e valori di tutti i pannelli a un passo: tooltip e barra dell'ora fissata
    const timeHtml = (st) =>
      `<div class="t">${fmtLocal(new Date(t0 + st * 3600e3))} · +${st}h</div>`;
    const rowsHtml = (st) =>
      panels
        .map((p) => {
          const d = valueAt(p, st);
          if (!d) return "";
          // stesse righe del riquadro dell'ora fissata nell'immagine (anche la pioggia: colonna e totale)
          return `<div>${p.tip(d)} ${valueText(p, d, (x) => `<b>${x}</b>`, false)}</div>`;
        })
        .join("");
    const touchUi = !hoverMq.matches; // telefono e tablet: niente barra in fondo, valori nel tooltip
    // above: col dito il tooltip sta sopra il punto toccato, altrimenti il dito lo copre
    // pinned: scheda dell'ora fissata (chiara, con le azioni) al posto del tooltip scuro di lettura
    const showAt = (st, clientX, clientY, above = false, pinned = false) => {
      cursor.setAttribute("x1", X(st));
      cursor.setAttribute("x2", X(st));
      cursor.setAttribute("visibility", pinned ? "hidden" : "visible");
      tip.classList.toggle("pinned", pinned);
      tip.innerHTML =
        timeHtml(st) +
        rowsHtml(st) +
        (pinned
          ? `<div class="chart-tip-actions"><button type="button" data-act="share">Condividi</button>` +
            `<button type="button" data-act="download">Scarica</button>` +
            `<button type="button" data-act="remove" aria-label="Togli l'ora fissata">✕</button></div>`
          : "");
      tip.hidden = false;
      const br = chartUi.body.getBoundingClientRect();
      const cx = clientX - br.left,
        w = tip.offsetWidth,
        h = tip.offsetHeight;
      tip.style.left = above
        ? `${Math.min(Math.max(cx - w / 2, 4), br.width - w - 4)}px`
        : `${Math.min(Math.max(cx + 14 + w > br.width ? cx - 14 - w : cx + 14, 4), br.width - w - 4)}px`;
      const y = clientY - br.top + chartUi.body.scrollTop;
      tip.style.top = above
        ? `${Math.max(chartUi.body.scrollTop + 4, y - h - 48)}px`
        : `${Math.max(4, y - 20)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      cursor.setAttribute("visibility", "hidden");
    };
    // ora fissata col dito: il tooltip resta sulla sua linea, in alto nella parte visibile
    const showPinTip = () => {
      const r = svgEl.getBoundingClientRect();
      showAt(
        chartPin,
        r.left + (X(chartPin) / W) * r.width,
        chartUi.body.getBoundingClientRect().top + 4,
        false,
        true,
      );
    };
    const unpin = () => {
      chartPin = null;
      renderPin();
      hide();
    };
    // azioni della scheda: stessa immagine dei pulsanti in alto, con l'ora fissata
    tip.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "remove") unpin();
      else chartImage(btn, btn.dataset.act === "share");
    });
    const readout = $("chart-readout");
    const renderPin = () => {
      const on = chartPin != null && steps.includes(chartPin);
      pinLine.setAttribute("visibility", on ? "visible" : "hidden");
      readout.hidden = !on || touchUi;
      pinDots.innerHTML = "";
      if (!on) return;
      pinLine.setAttribute("x1", X(chartPin));
      pinLine.setAttribute("x2", X(chartPin));
      pinDots.innerHTML = panels
        .map((p) => {
          const d = p.kind === "line" ? valueAt(p, chartPin) : null;
          return d && d.y != null
            ? `<circle class="ch-pin-dot" cx="${X(chartPin).toFixed(1)}" cy="${p.Y(d.y).toFixed(1)}" r="4" fill="${p.color}"/>`
            : "";
        })
        .join("");
      readout.querySelector(".chart-readout-values").innerHTML =
        timeHtml(chartPin) + rowsHtml(chartPin);
    };
    const hit = svgEl.querySelector("#ch-hit");
    // mouse: passandoci sopra si leggono i valori. Clic fissa l'ora (un altro sulla stessa la toglie); trascinando col
    // tasto premuto l'ora fissata segue il puntatore.
    // dito: scorrendo in orizzontale si leggono i valori (in verticale si scorre la pagina); pressione prolungata fissa
    // l'ora per l'immagine da condividere; un tocco breve toglie l'ora fissata o mostra i valori lì
    const PRESS_MS = 450,
      SLOP = 8;
    let drag = null;
    hit.addEventListener("pointermove", (ev) => {
      const st = stepAt(ev.clientX);
      if (drag?.touch) {
        if (!drag.moved && Math.abs(ev.clientX - drag.x0) <= SLOP) return;
        drag.moved = true;
        clearTimeout(drag.timer);
        if (drag.pinning) {
          // dopo la pressione prolungata il dito sposta l'ora fissata
          if (st !== chartPin) {
            chartPin = st;
            renderPin();
            showPinTip();
          }
        } else {
          // tornando a trascinare l'ora fissata si toglie: si torna a leggere i valori
          if (chartPin != null) {
            chartPin = null;
            renderPin();
          }
          showAt(st, ev.clientX, ev.clientY, true);
        }
        return;
      }
      if (drag) {
        if (st !== chartPin) {
          drag.moved = true;
          chartPin = st;
          renderPin();
        }
        return;
      }
      if (ev.pointerType !== "mouse") return;
      if (st === chartPin)
        hide(); // sull'ora fissata i valori sono già nella barra in fondo
      else showAt(st, ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerdown", (ev) => {
      const st = stepAt(ev.clientX);
      if (ev.pointerType !== "mouse" && touchUi) {
        drag = { touch: true, x0: ev.clientX, moved: false, pinning: false };
        drag.timer = setTimeout(() => {
          drag.pinning = true;
          chartPin = st;
          renderPin();
          showPinTip();
          navigator.vibrate?.(10);
        }, PRESS_MS);
        return;
      }
      drag = { wasPinned: chartPin === st, moved: false };
      hit.setPointerCapture?.(ev.pointerId);
      if (!drag.wasPinned) {
        chartPin = st;
        renderPin();
      }
      hide();
    });
    const endDrag = (ev) => {
      if (!drag) return;
      if (drag.touch) {
        clearTimeout(drag.timer);
        const tap = ev.type === "pointerup" && !drag.moved && !drag.pinning;
        if (tap && chartPin != null) unpin(); // tocco breve con un'ora fissata: la toglie
        else if (tap) showAt(stepAt(ev.clientX), ev.clientX, ev.clientY, true);
        else if (chartPin != null) showPinTip();
        else if (ev.type === "pointercancel") hide(); // il browser ha preso lo scorrimento verticale
        drag = null;
        return;
      }
      if (ev.type === "pointerup" && drag.wasPinned && !drag.moved) {
        chartPin = null;
        renderPin();
      } // tocco sull'ora già fissata
      drag = null;
    };
    hit.addEventListener("pointerup", endDrag);
    hit.addEventListener("pointercancel", endDrag); // il browser ha preso il gesto (scorrimento verticale)
    hit.addEventListener("pointerleave", (ev) => {
      if (!drag && ev.pointerType === "mouse") hide(); // col dito arriva dopo ogni tocco: il tooltip resta
    });
    // niente menu o selezione del browser alla pressione prolungata
    hit.addEventListener("contextmenu", (ev) => {
      if (touchUi) ev.preventDefault();
    });
    clearChartPin = () => {
      chartPin = null;
      renderPin();
      hide();
    };
    renderPin(); // ridisegno (finestra ridimensionata): l'ora fissata resta
    if (touchUi && chartPin != null && steps.includes(chartPin)) showPinTip();
  }

  // ---------- tooltip puntuale (griglia nativa, nearest neighbour)
  // Col mouse segue il puntatore. Sui dispositivi a tocco compare dove tocchi e resta ancorato a quel punto della
  // mappa: spostando o ingrandendo la mappa si muove con lei, e cambiando passo mostra il valore nuovo.
  map.on("mousemove", (e) => {
    if (hoverMq.matches) showProbe(e);
  });
  map.on("click", (e) => {
    if (hoverMq.matches || landscapeView()) return;
    probeLL = e.latlng;
    showProbe(e);
  });
  map.on("move zoom", () => {
    if (probeLL && !hoverMq.matches)
      showProbe({
        latlng: probeLL,
        containerPoint: map.latLngToContainerPoint(probeLL),
      });
  });
  /** Tooltip del punto toccato, ricalcolato (nuovo passo, altra grandezza); niente se non ce n'è uno. */
  function refreshProbe() {
    if (probeLL && !hoverMq.matches)
      showProbe({
        latlng: probeLL,
        containerPoint: map.latLngToContainerPoint(probeLL),
      });
  }
  function showProbe(e) {
    // sopra una località (o col suo riquadro aperto lì) basta il riquadro nero: un solo tooltip alla volta
    if (
      !current ||
      menuLL ||
      state.extra !== "none" ||
      popIdx != null ||
      e.originalEvent?.target?.closest?.(".pt, .pt-pop")
    ) {
      ui.probe.hidden = true;
      return;
    }
    const { lat0, lon0, dlat, dlon, nx, ny } = current.grid;
    const ix = Math.round((e.latlng.lng - lon0) / dlon);
    const iy = Math.round((e.latlng.lat - lat0) / dlat);
    let text;
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) {
      ui.probe.hidden = true;
      return;
    } // fuori dai dati: niente tooltip
    else {
      const v = current.values[iy * nx + ix];
      if (v == null) {
        ui.probe.hidden = true;
        return;
      }
      text = `<b>${v.toFixed(variable().decimals)}</b> ${current.units}`;
      const d = current.u
        ? windDirAt(current, e.latlng.lat, e.latlng.lng)
        : null;
      if (d) text += ` da ${d.name}`;
    }
    if (currentContour) {
      const z = valueAt(currentContour, e.latlng.lat, e.latlng.lng);
      if (z != null)
        text += ` · ${contourName().toLowerCase()} <b>${Math.round(z)}</b> ${currentContour.units}`;
    }
    if (currentArrows) {
      // combinata con le frecce: velocità e provenienza del vento nel punto
      const { lat0, lon0, dlat, dlon, nx, ny } = currentArrows.grid;
      const ix = Math.round((e.latlng.lng - lon0) / dlon),
        iy = Math.round((e.latlng.lat - lat0) / dlat);
      const u =
        ix >= 0 && iy >= 0 && ix < nx && iy < ny
          ? currentArrows.u[iy * nx + ix]
          : null;
      const v = u == null ? null : currentArrows.v[iy * nx + ix];
      if (u != null && v != null) {
        const d = windDirAt(currentArrows, e.latlng.lat, e.latlng.lng);
        text += ` · ${lcFirst(variable().arrows.label)} <b>${Math.round(Math.hypot(u, v))}</b> km/h${d ? ` da ${d.name}` : ""}`;
      }
    }
    // seconda riga: le grandezze in più (sulla mappa della T850 la quota della superficie di 850 hPa)
    const more = extras()
      .map((d) => [d, extraValue(d, e.latlng.lat, e.latlng.lng)])
      .filter(([, x]) => x)
      .map(
        ([d, x]) =>
          `${SHORT[d.var] || d.label} <b>${x.replace(/ (\S+)$/, "</b> $1")}`,
      );
    if (more.length)
      text += `<div class="probe-more">${more.join(" · ")}</div>`;
    ui.probe.innerHTML = text;
    // a destra del mouse, a sinistra se non ci sta; sempre dentro la finestra (8px dai bordi)
    ui.probe.hidden = false;
    const W = map.getContainer().clientWidth,
      H = map.getContainer().clientHeight;
    const w = ui.probe.offsetWidth,
      h = ui.probe.offsetHeight,
      { x, y } = e.containerPoint;
    let left = x + 14;
    if (left + w > W - 8) left = x - 14 - w;
    left = Math.min(Math.max(left, 8), Math.max(8, W - 8 - w));
    const top = Math.min(Math.max(y - h / 2, 8), Math.max(8, H - 8 - h));
    // punto ancorato uscito dallo schermo: il tooltip non resta appiccicato al bordo
    if (!e.originalEvent && (x < 0 || y < 0 || x > W || y > H)) {
      ui.probe.hidden = true;
      return;
    }
    ui.probe.style.left = `${left}px`;
    ui.probe.style.top = `${top}px`;
  }
  map.on("mouseout", () => {
    ui.probe.hidden = true;
  });

  // ---------- menu di un punto della mappa: clic destro (desktop) o pressione prolungata (tocco).
  // Intestazione col valore nel punto e le coordinate; Condividi (immagine col segnaposto e il valore),
  // Aggiungi alle località (nome precompilato con le coordinate, modificabile subito), Grafico nel tempo.
  const mapMenu = document.createElement("div");
  mapMenu.className = "map-menu";
  mapMenu.hidden = true;
  mapMenu.setAttribute("role", "menu");
  const mapMenuPin = document.createElement("div");
  mapMenuPin.className = "map-menu-pin";
  mapMenuPin.hidden = true;
  document.body.append(mapMenuPin, mapMenu);
  let menuOpenedAt = 0;
  const coordText = (ll) => `${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)}`;
  /** Tutti i valori della mappa nel punto, come il tooltip, in testo semplice: colori, linee, frecce del vento e
   *  grandezze in più ("12.4 mm · vento 10 m 25 km/h da SO"); "" senza dati. */
  function pointValueText(ll) {
    if (!current || state.extra !== "none") return "";
    const v = valueAt(current, ll.lat, ll.lng);
    if (v == null) return "";
    let t = `${v.toFixed(variable().decimals)} ${current.units}`;
    const d = current.u ? windDirAt(current, ll.lat, ll.lng) : null;
    if (d) t += ` da ${d.name}`;
    if (currentContour) {
      const z = valueAt(currentContour, ll.lat, ll.lng);
      if (z != null)
        t += ` · ${contourName().toLowerCase()} ${Math.round(z)} ${currentContour.units}`;
    }
    if (currentArrows) {
      const { lat0, lon0, dlat, dlon, nx, ny } = currentArrows.grid;
      const ix = Math.round((ll.lng - lon0) / dlon),
        iy = Math.round((ll.lat - lat0) / dlat);
      if (ix >= 0 && iy >= 0 && ix < nx && iy < ny) {
        const u = currentArrows.u[iy * nx + ix],
          w = currentArrows.v[iy * nx + ix];
        if (u != null && w != null) {
          const d = windDirAt(currentArrows, ll.lat, ll.lng);
          t += ` · ${lcFirst(variable().arrows.label)} ${Math.round(Math.hypot(u, w))} km/h${d ? ` da ${d.name}` : ""}`;
        }
      }
    }
    for (const x of extras()) {
      const val = extraValue(x, ll.lat, ll.lng);
      if (val) t += ` · ${SHORT[x.var] || x.label} ${val}`;
    }
    return t;
  }
  const escHtml = (t) =>
    String(t).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  /** Pallino del menu fermo su un punto (anche a menu chiuso, per il caricamento dell'aggiunta). */
  function showPinAt(ll) {
    const cr = map.getContainer().getBoundingClientRect();
    const p = map.latLngToContainerPoint(ll);
    mapMenuPin.style.left = `${cr.left + p.x}px`;
    mapMenuPin.style.top = `${cr.top + p.y}px`;
    mapMenuPin.hidden = false;
  }
  function placeMapMenu() {
    if (!menuLL) return;
    const cr = map.getContainer().getBoundingClientRect();
    const p = map.latLngToContainerPoint(menuLL);
    const x = cr.left + p.x,
      y = cr.top + p.y;
    mapMenuPin.style.left = `${x}px`;
    mapMenuPin.style.top = `${y}px`;
    const w = mapMenu.offsetWidth,
      h = mapMenu.offsetHeight;
    // parte visibile della pagina: su mobile, con la tastiera aperta (campo del nome), è più bassa della finestra
    const vv = window.visualViewport;
    const vx = vv?.offsetLeft ?? 0,
      vy = vv?.offsetTop ?? 0,
      vw = vv?.width ?? innerWidth,
      vh = vv?.height ?? innerHeight;
    // in basso a destra del punto; se non ci sta a sinistra o sopra, sempre dentro la parte visibile
    let left = x + 12,
      top = y + 12;
    if (left + w > vx + vw - 8) left = x - 12 - w;
    if (top + h > vy + vh - 8) top = y - 12 - h;
    mapMenu.style.left = `${Math.min(Math.max(left, vx + 8), Math.max(vx + 8, vx + vw - 8 - w))}px`;
    mapMenu.style.top = `${Math.min(Math.max(top, vy + 8), Math.max(vy + 8, vy + vh - 8 - h))}px`;
  }
  // la tastiera si apre o si chiude (o iOS sposta la pagina): il menu resta sopra la tastiera
  window.visualViewport?.addEventListener("resize", placeMapMenu);
  window.visualViewport?.addEventListener("scroll", placeMapMenu);
  function openMapMenu(ll) {
    if (synoptic()) return; // carta sinottica: niente menu del punto
    closePlacePop();
    probeLL = null;
    ui.probe.hidden = true;
    menuLL = ll;
    menuOpenedAt = Date.now();
    const value = pointValueText(ll);
    // titolo: le coordinate (con la X per chiudere); sotto, piccoli, i valori della mappa nel punto
    mapMenu.innerHTML =
      `<div class="map-menu-head">` +
      `<span class="map-menu-title">${coordText(ll)}</span>` +
      `<button type="button" class="map-menu-close" data-act="close" aria-label="Chiudi">✕</button>` +
      (value ? `<span class="map-menu-value">${escHtml(value)}</span>` : "") +
      `</div>` +
      `<button type="button" role="menuitem" data-act="share">Condividi questo punto</button>` +
      `<button type="button" role="menuitem" data-act="place">Aggiungi alle località</button>` +
      `<button type="button" role="menuitem" data-act="chart">Grafico nel tempo</button>`;
    mapMenu.hidden = false;
    mapMenuPin.classList.remove("loading");
    mapMenuPin.hidden = false;
    document.body.classList.add("map-menu-open"); // cursore normale sulla mappa finché il menu è aperto
    placeMapMenu();
    mapMenu.querySelector("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
  }
  /** Località appena aggiunta dal menu: il suo segnaposto compare con un rimbalzo e un'onda (vedi .pt-num.pt-new). */
  function popNewPlace() {
    const num = pointMarkers.at(-1)?.getElement()?.querySelector(".pt-num");
    if (!num) return;
    num.classList.remove("pt-new");
    void num.offsetWidth; // riparte l'animazione
    num.classList.add("pt-new");
    num.addEventListener("animationend", function done(e) {
      if (e.pseudoElement !== "::after") return; // finisce l'onda, che dura più del rimbalzo
      num.classList.remove("pt-new");
      num.removeEventListener("animationend", done);
    });
  }
  function closeMapMenu() {
    if (!menuLL) return;
    menuLL = null;
    mapMenu.hidden = true;
    mapMenuPin.hidden = true;
    document.body.classList.remove("map-menu-open");
  }
  /** Aggiungi alle località: il menu diventa un campo col nome (le coordinate, già selezionate) e Aggiungi. */
  function askPlaceName(ll) {
    mapMenu.innerHTML =
      `<form class="map-menu-form"><label for="map-menu-name">Nome della località</label>` +
      `<input id="map-menu-name" type="text" maxlength="60" autocomplete="off" required>` +
      `<div class="map-menu-row"><button type="button" data-act="cancel">Annulla</button>` +
      `<button type="submit" class="primary">Aggiungi</button></div></form>`;
    const input = mapMenu.querySelector("input");
    input.value = coordText(ll);
    placeMapMenu();
    input.focus();
    input.select();
    // la finestra si chiude subito; il pallino resta sul punto in caricamento, poi lascia il posto al segnaposto
    // nuovo (rimbalzo e onda, vedi popNewPlace). Punto scelto sulla mappa: aggiunto anche vicino a una località.
    mapMenu.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim() || coordText(ll);
      input.blur(); // su mobile chiude la tastiera
      closeMapMenu();
      showPinAt(ll);
      mapMenuPin.classList.add("loading");
      setTimeout(() => {
        mapMenuPin.classList.remove("loading");
        if (!menuLL) mapMenuPin.hidden = true; // nel frattempo può essersi aperto un altro menu
        if (addPlace(name, ll.lat, ll.lng, true)) popNewPlace();
      }, 450);
    });
  }
  mapMenu.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act || !menuLL) return;
    const ll = menuLL;
    if (act === "close") {
      closeMapMenu();
      return;
    }
    if (act === "place") {
      askPlaceName(ll);
      return;
    }
    const text = pointValueText(ll);
    closeMapMenu();
    if (act === "share") {
      shareUi.btn.pin = { latlng: ll, text };
      shareUi.btn.click();
    } else if (act === "chart")
      openChart({ name: coordText(ll), lat: +ll.lat.toFixed(4), lon: +ll.lng.toFixed(4) });
  });
  // desktop: clic destro (con Mapbox arriva inoltrato da connectMapbox); col tocco si usa la pressione prolungata qui
  // sotto, così Android (che manda anche contextmenu) e iOS (che non lo manda) si comportano uguale
  map.on("contextmenu", (e) => {
    e.originalEvent?.preventDefault?.();
    if (!hoverMq.matches) return;
    openMapMenu(e.latlng);
  });
  const LONG_PRESS_MS = 500,
    LONG_PRESS_SLOP = 8; // px: oltre è un trascinamento della mappa
  let press = null;
  const onMapSurface = (t) =>
    !!t.closest?.("#map, .wm-native-map") &&
    !t.closest(".leaflet-control, .mapboxgl-ctrl, .leaflet-marker-icon, .pt-pop");
  document.addEventListener(
    "touchstart",
    (e) => {
      clearTimeout(press?.timer);
      press = null;
      if (e.touches.length !== 1 || !onMapSurface(e.target)) return;
      if (mobileMq.matches && !ui.panel.classList.contains("collapsed")) return;
      const t = e.touches[0];
      press = {
        x: t.clientX,
        y: t.clientY,
        timer: setTimeout(() => {
          const cr = map.getContainer().getBoundingClientRect();
          navigator.vibrate?.(10);
          openMapMenu(map.containerPointToLatLng([press.x - cr.left, press.y - cr.top]));
          press = null;
        }, LONG_PRESS_MS),
      };
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!press) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - press.x, t.clientY - press.y) > LONG_PRESS_SLOP) {
        clearTimeout(press.timer);
        press = null;
      }
    },
    { capture: true, passive: true },
  );
  for (const type of ["touchend", "touchcancel"])
    document.addEventListener(
      type,
      () => {
        clearTimeout(press?.timer);
        press = null;
      },
      true,
    );
  // menu aperto: un clic fuori lo chiude e basta (niente valore del punto); il clic che segue la pressione
  // prolungata non deve né chiuderlo né mostrare il valore
  document.addEventListener(
    "click",
    (e) => {
      if (!menuLL || mapMenu.contains(e.target)) return;
      // anche sui segnaposto delle località: col menu aperto nessun altro riquadro
      if (e.target.closest?.("#map, .wm-native-map") && !e.target.closest(".leaflet-control, .mapboxgl-ctrl")) {
        e.stopPropagation();
        e.preventDefault();
      }
      if (Date.now() - menuOpenedAt > 600) closeMapMenu();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuLL) closeMapMenu();
  });
  // la mappa si sposta: il menu si chiude, ma non quando a muoverla è il ridimensionamento della pagina. Su iPhone
  // (Chrome) il campo del nome apre la tastiera e cambia l'altezza della finestra: chiudere lì faceva sparire il campo
  let resizedAt = 0;
  const markResize = () => (resizedAt = Date.now());
  window.addEventListener("resize", markResize, true); // in cattura: prima di Leaflet e Mapbox
  window.visualViewport?.addEventListener("resize", markResize);
  function closeMapMenuOnMove() {
    if (Date.now() - resizedAt < 1000) placeMapMenu();
    else closeMapMenu();
  }
  map.on("movestart zoomstart", closeMapMenuOnMove); // con Mapbox anche da connectMapbox, all'inizio del gesto
  map.on("resize moveend", placeMapMenu);
  // niente menu del browser sulla mappa (pressione prolungata su Android, clic destro senza Mapbox)
  document.addEventListener("contextmenu", (e) => {
    if (onMapSurface(e.target)) e.preventDefault();
  });

  // ---------- eventi
  function setStepKeepingInterval(step) {
    state.step = step;
    syncMode(); // con le cumulate il range resta fisso, cambia solo l'ora mostrata
  }

  function goStep(delta) {
    const s = slideSteps();
    if (dualMode()) {
      // dentro il range, come il play: un passo con Totale, le ore scelte con i pulsanti
      const frames = rangeFrames();
      if (!frames.length) return;
      const k = frames.indexOf(state.step);
      const next = k < 0 ? (delta > 0 ? 0 : frames.length - 1) : (k + delta + frames.length) % frames.length;
      setStepKeepingInterval(frames[next]);
      ui.step.value = s.indexOf(state.step);
      update();
      return;
    }
    let i = s.indexOf(state.step) + delta;
    if (i < 0) i = s.length - 1;
    if (i >= s.length) i = 0;
    setStepKeepingInterval(s[i]);
    ui.step.value = i;
    update();
  }

  // icone Lucide "play" e "pause" del pulsante nella barra mobile
  const M_PLAY = ui.mPlay.innerHTML;
  const M_PAUSE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="2.25" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/>' +
    '<rect x="6" y="4" width="4" height="16" rx="1"/></svg>';
  // play / pausa del pannello (più piccoli, bianchi sul tondo blu)
  const P_PLAY = ui.play.innerHTML;
  const P_PAUSE =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
    '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  function togglePlay(force) {
    const on = force ?? !playTimer;
    if (on && !playTimer) {
      stopProgressAnimation();
      // cumulate: dentro il range fisso; con Totale l'accumulo cresce, con le ore scelte un'immagine ogni tot ore
      const rangeStart = state.rangeFrom ?? 0;
      const rangeEnd = state.rangeTo ?? state.step;
      const playbackRange = dualMode() ? rangeFrames(rangeStart, rangeEnd) : null;
      if (playbackRange && playbackRange.length < 2) return;
      if (playbackRange) {
        playbackSelection = {
          from: rangeStart,
          to: rangeEnd,
          step: playbackRange[0],
          progress: 0,
          model: state.model,
          variable: state.var,
          run: state.run,
        };
        state.step = playbackRange[0];
        syncMode();
        ui.step.value = steps().indexOf(state.step);
        update();
        for (const slider of intervalSliders) {
          if (!slider.element.clientWidth) continue;
          slider.progressAnimation = slider.progress.animate(
            slider.progressBounds.map((left) => ({ left })),
            { duration: (playbackRange.length - 1) * 650, easing: "linear", fill: "forwards" },
          );
        }
      }
      ui.play.innerHTML = P_PAUSE;
      ui.play.setAttribute("aria-label", "Ferma animazione");
      ui.mPlay.innerHTML = M_PAUSE;
      ui.mPlay.setAttribute("aria-label", "Ferma animazione");
      playTimer = setInterval(() => {
        const s = slideSteps(); // con le ore fisse uno scatto ogni `hours` ore
        let i = s.indexOf(state.step);
        if (playbackRange) {
          const rangeIndex = playbackRange.indexOf(state.step);
          if (!playbackSelection || rangeIndex < 0 || rangeIndex === playbackRange.length - 1) {
            togglePlay(false);
            return;
          }
          state.step = playbackRange[rangeIndex + 1];
          playbackSelection.step = state.step;
          playbackSelection.progress = (rangeIndex + 1) / (playbackRange.length - 1);
          syncMode();
          i = s.indexOf(state.step);
        } else {
          const avail = availableSteps();
          // salta i passi non disponibili, ricomincia dal primo
          for (let k = 0; k < s.length; k++) {
            i = (i + 1) % s.length;
            if (avail.has(s[i])) break;
          }
          setStepKeepingInterval(s[i]);
        }
        ui.step.value = i;
        update();
        if (playbackRange && state.step === playbackRange.at(-1)) togglePlay(false);
      }, 650);
    } else if (!on && playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      stopProgressAnimation();
      ui.play.innerHTML = P_PLAY;
      ui.play.setAttribute("aria-label", "Avvia animazione");
      ui.mPlay.innerHTML = M_PLAY;
      ui.mPlay.setAttribute("aria-label", "Avvia animazione");
    }
  }

  ui.step.addEventListener("input", () => {
    state.step = slideSteps()[+ui.step.value];
    syncMode();
    update();
  });
  ui.prev?.addEventListener("click", () => goStep(-1));
  ui.next?.addEventListener("click", () => goStep(1));
  // frecce del riquadro in basso su mobile: come quelle del pannello, ma fermano il play
  $("m-prev").addEventListener("click", () => {
    togglePlay(false);
    goStep(-1);
  });
  $("m-next").addEventListener("click", () => {
    togglePlay(false);
    goStep(1);
  });
  ui.mPlay.addEventListener("click", () => togglePlay());
  // slider della barra su mobile: come quello del pannello, ma ferma il play
  $("m-step").addEventListener("input", (e) => {
    togglePlay(false);
    ui.step.value = e.target.value;
    state.step = slideSteps()[+e.target.value];
    syncMode();
    update();
  });
  // «: torna al primo passo disponibile della corsa
  $("m-first").addEventListener("click", () => {
    togglePlay(false);
    const s = slideSteps();
    if (dualMode()) {
      const frames = rangeFrames();
      if (frames.length) setStepKeepingInterval(frames[0]);
      ui.step.value = s.indexOf(state.step);
      update();
      return;
    }
    const avail = availableSteps();
    const i = Math.max(
      0,
      s.findIndex((x) => avail.has(x)),
    );
    setStepKeepingInterval(s[i]);
    ui.step.value = i;
    update();
  });
  ui.play.addEventListener("click", () => togglePlay());
  ui.opacity.addEventListener("input", () => {
    state.opacity = +ui.opacity.value;
    overlay?.setOpacity(state.opacity);
    if (glImgs.has("wm-model")) glPut("wm-model", { opacity: state.opacity });
    writeHash();
    saveSettings();
  });
  // opacità dei confini (Impostazioni), separata da quella dei colori: vale per tutto il livello delle linee
  const applyBordersOpacity = () => {
    map.getPane("borders").style.opacity = state.bordersOpacity;
    map.getPane("synBorders").style.opacity = state.bordersOpacity;
    glBorders();
  };
  ui.bordersOpacity.addEventListener("input", () => {
    state.bordersOpacity = +ui.bordersOpacity.value;
    applyBordersOpacity();
    saveSettings();
  });
  ui.crisp.addEventListener("change", () => {
    state.crisp = ui.crisp.checked;
    if (current) draw(current);
    writeHash();
    saveSettings();
  });
  ui.iso.addEventListener("change", () => {
    state.iso = ui.iso.checked;
    drawContours(variable().contour_field ? currentContour : current);
    renderLegend();
    writeHash();
    saveSettings();
  });
  ui.model.addEventListener("change", () => {
    togglePlay(false);
    if (state.extra !== "none") setExtra("none");
    state.model = ui.model.value;
    renderModelInfo();
    setupRuns();
    setupSteps();
    saveSettings();
    update();
  });
  ui.varSel.addEventListener("change", () => {
    togglePlay(false);
    if (state.extra !== "none") setExtra("none");
    state.var = ui.varSel.value;
    applyArea();
    setupModels();
    setupModes();
    setupRuns();
    setupSteps();
    saveSettings();
    update();
  });
  // ---------- sezioni del pannello (località, impostazioni, crediti): una aperta alla volta, apertura e chiusura
  // animate. In JS e non con <details name>: così il browser chiuderebbe l'altra di colpo, senza animazione.
  const SECTIONS = [
    ...document.querySelectorAll(".panel-body > details.points-box"),
  ];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const wantsOpen = (d) => d._want ?? d.open; // stato verso cui sta andando (durante l'animazione di chiusura è ancora open)
  function animateSection(d, open) {
    d._want = open;
    d.classList.toggle("is-open", open); // la freccia ruota subito, anche mentre la sezione si chiude
    d._anim?.cancel();
    const cs = getComputedStyle(d);
    const px = (k) => parseFloat(cs[k]) || 0;
    const closedH =
      d.querySelector("summary").getBoundingClientRect().height +
      px("paddingTop") +
      px("paddingBottom") +
      px("borderTopWidth") +
      px("borderBottomWidth");
    const from = d.getBoundingClientRect().height;
    if (open) d.open = true;
    const to = open ? d.getBoundingClientRect().height : closedH;
    if (reduceMotion.matches || Math.abs(to - from) < 1) {
      if (!open) d.open = false;
      return;
    }
    d.style.overflow = "hidden";
    const a = d.animate(
      { height: [`${from}px`, `${to}px`] },
      { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    d._anim = a;
    a.onfinish = () => {
      if (!open) d.open = false;
      d.style.overflow = "";
      d._anim = null;
      updateSectionFade(d);
    };
    a.oncancel = () => {
      d.style.overflow = "";
    };
  }
  // su telefono la sezione aperta scorre: sfumatura in fondo se sotto c'è altro, ombra sotto il titolo se è già scorsa
  function updateSectionFade(d) {
    const below = d.open && d.scrollHeight - d.scrollTop - d.clientHeight > 2;
    d.classList.toggle("more-below", below);
    d.classList.toggle("more-above", d.open && d.scrollTop > 2);
  }
  const fadeRo = new ResizeObserver((entries) => {
    for (const e of entries) {
      const d = e.target.closest("details");
      if (d) updateSectionFade(d);
    }
  });
  for (const d of SECTIONS) {
    d.classList.toggle("is-open", d.open); // stato iniziale (index.html)
    d.addEventListener("scroll", () => updateSectionFade(d), { passive: true });
    d.addEventListener("toggle", () => updateSectionFade(d));
    fadeRo.observe(d);
    for (const child of d.children) fadeRo.observe(child); // contenuto che cresce (nuove località) senza cambiare la sezione
  }
  for (const d of SECTIONS) {
    d.querySelector("summary").addEventListener("click", (e) => {
      e.preventDefault();
      const open = !wantsOpen(d);
      if (open)
        for (const o of SECTIONS)
          if (o !== d && wantsOpen(o)) animateSection(o, false);
      animateSection(d, open);
    });
  }

  function setPanelCollapsed(collapsed) {
    ui.panel.classList.toggle("collapsed", collapsed);
    ui.collapse.textContent = collapsed ? "+" : "−";
    ui.collapse.setAttribute(
      "aria-label",
      collapsed ? "Apri pannello" : "Riduci pannello",
    );
    ui.collapse.title = collapsed ? "Apri pannello" : "Riduci pannello";
    if (!collapsed) togglePlay(false); // riaprendo il menu l'animazione si ferma
  }
  ui.collapse.addEventListener("click", () =>
    setPanelCollapsed(!ui.panel.classList.contains("collapsed")),
  );
  // su mobile, col pannello aperto, un tocco sulla mappa chiude soltanto il pannello: niente valore del punto,
  // niente riquadro della località. In cattura sul documento, prima che il clic arrivi a Leaflet (segnaposto) o
  // alla mappa Mapbox: con lo sfondo vettoriale i tocchi vanno a .wm-native-map, non al contenitore di Leaflet
  document.addEventListener(
    "click",
    (e) => {
      if (!mobileMq.matches || ui.panel.classList.contains("collapsed")) return;
      if (!e.target.closest("#map, .wm-native-map")) return;
      if (e.target.closest(".leaflet-control, .mapboxgl-ctrl")) return;
      e.stopPropagation();
      e.preventDefault();
      setPanelCollapsed(true);
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("button, select, input, textarea, [role=slider]"))
      return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goStep(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goStep(1);
    } else if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    }
  });

  async function refreshRuns() {
    if (STATIC) {
      const data = await fetch(`data/runs.json?t=${Date.now()}`, {
        cache: "no-store",
      }).then((r) => r.json());
      publishedAt = data.generated_at;
      runs = data.models;
    } else {
      const r = await fetch("api/runs", { cache: "no-cache" });
      runs = await r.json();
      publishedAt = r.headers.get("X-Updated-At");
    }
    renderUpdated();
  }
  /** Ultima riga del pannello: quando sono stati aggiornati i dati ("Aggiornamento 13/11 17:12"). */
  function renderUpdated() {
    const el = $("updated-at");
    const d = publishedAt ? new Date(publishedAt) : null;
    if (!d || Number.isNaN(d.getTime())) {
      $("updated-row").hidden = true;
      return;
    }
    // formato corto: "Aggiornamento 13/11 17:12"
    const when = d
      .toLocaleString("it-IT", {
        timeZone: "Europe/Rome",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
      .replace(",", "");
    el.textContent = `Aggiornamento ${when}`;
    el.title = d.toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "full", timeStyle: "short" });
    el.dateTime = publishedAt;
    $("updated-row").hidden = false;
  }

  // ---------- area della mappa: quella dei dati (BBOX) o quella della carta sinottica, che cambia con la grandezza
  const toBounds = (b) =>
    L.latLngBounds([b.lat_min, b.lon_min], [b.lat_max, b.lon_max]);
  let areaBox = null, // area in cui si può muovere la mappa adesso
    areaKey = null,
    startView = null, // vista iniziale (Lombardia)
    localView = null; // vista della mappa normale lasciata passando alla carta sinottica, per ritrovarla tornando
  // Lo zoom minimo è quello per cui la vista sta tutta dentro l'area coperta dai dati:
  // non si può mai vedere mappa senza dati. Si ricalcola se la finestra cambia dimensione.
  function updateMinZoom() {
    map.setMinZoom(0);
    map.setMinZoom(map.getBoundsZoom(areaBox, true));
  }
  /** Carta sinottica: sempre allo zoom minimo (tutta l'area che sta nello schermo), centrata un po' a sud del Nord
   *  Italia; vale per la vista, per il telefono in orizzontale e per l'immagine condivisa. */
  function synopticView() {
    const c = L.latLng(startView.getCenter().lat - 3, startView.getCenter().lng);
    map.setView(c, map.getMinZoom(), { animate: false });
    map.panInsideBounds(areaBox, { animate: false });
  }
  function applyArea() {
    const a = areaNow(),
      key = JSON.stringify(a);
    if (key === areaKey) return;
    if (areaKey && !document.body.classList.contains("synoptic-mode"))
      localView = map.getBounds();
    // cambio d'area (carta a 500 hPa e ritorno): via subito i colori e le linee dell'altra area, che nella vista nuova
    // comparirebbero per un attimo prima della mappa giusta (alla prima apertura non c'è ancora nulla)
    if (areaKey) clearOverlay();
    if (areaKey && typeof renderSoundings === "function") queueMicrotask(renderSoundings); // niente stazioni a 500 hPa
    areaKey = key;
    const syn = synoptic();
    document.body.classList.toggle("synoptic-mode", syn);
    closeMapMenu(); // le voci del menu cambiano fra le due aree
    closePlacePop(); // cambia l'area: la mappa si sposta e il riquadro resterebbe appeso nel vuoto
    ui.probe.hidden = true;
    probeLL = null;
    areaBox = toBounds(a);
    // prima si tolgono i limiti di Mapbox: col cambio di zoom minimo riporterebbe Leaflet nella vecchia area
    glBase?.setMaxBounds(null);
    map.setMaxBounds(null);
    updateMinZoom();
    map.setMaxBounds(areaBox);
    if (syn) synopticView();
    else map.fitBounds(localView || startView, { animate: false });
    glBase?.setMaxBounds(glBounds(a));
    glSynopticBase();
    styleBorders();
  }

  // la pagina non deve scorrere (vedi html, body in style.css): se il browser la sposta comunque (tastiera, mappa più
  // larga durante la condivisione), si rimette in cima
  // larga durante la condivisione), si rimette in cima. Non mentre si scrive: iOS sposta la pagina per mostrare il
  // campo sopra la tastiera
  window.addEventListener("scroll", () => {
    if (document.activeElement?.matches?.("input, textarea")) return;
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  });

  // ---------- telefono in orizzontale: solo la mappa a tutto schermo (niente località né tocchi) e in fondo « ‹ a
  // sinistra, › » a destra e la data in mezzo per muoversi nel tempo (come le frecce: un passo, un intervallo con
  // 3/6/12/24h, un passo nel periodo col Totale).
  const landscapeMq = window.matchMedia("(orientation: landscape) and (pointer: coarse) and (max-height: 520px)");
  const lvNav = document.createElement("div");
  lvNav.className = "lv-nav";
  const icon = (paths) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
  lvNav.innerHTML =
    `<div class="lv-side">` +
    `<button type="button" data-go="first" aria-label="All'inizio">${icon(["m11 17-5-5 5-5", "m18 17-5-5 5-5"])}</button>` +
    `<button type="button" data-go="-1" aria-label="Indietro">${icon(["m15 18-6-6 6-6"])}</button></div>` +
    `<span class="lv-time" aria-live="polite"></span>` +
    `<div class="lv-side">` +
    `<button type="button" data-go="1" aria-label="Avanti">${icon(["m9 18 6-6-6-6"])}</button>` +
    `<button type="button" data-go="last" aria-label="Alla fine">${icon(["m6 17 5-5-5-5", "m13 17 5-5-5-5"])}</button></div>`;
  document.body.append(lvNav);
  /** Primo o ultimo scatto (nel periodo col Totale, sulla corsa altrimenti), come le frecce. */
  function goEdge(last) {
    const avail = availableSteps();
    const frames = dualMode() ? rangeFrames() : slideSteps().filter((x) => avail.has(x));
    const target = last ? frames.at(-1) : frames[0];
    if (target == null) return;
    setStepKeepingInterval(target);
    ui.step.value = slideSteps().indexOf(state.step);
    update();
  }
  lvNav.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !meta) return;
    togglePlay(false);
    const go = b.dataset.go;
    if (go === "first" || go === "last") goEdge(go === "last");
    else goStep(+go);
  });
  function renderLandscapeNav() {
    lvNav.querySelector(".lv-time").textContent =
      meta && state.run && variable() ? fmtShown(state.step, { month: false }) : "";
  }
  function applyLandscape() {
    const on = landscapeMq.matches;
    document.body.classList.toggle("landscape-view", on);
    // niente zoom col doppio tocco: toccando in fretta i pulsanti la mappa si ingrandiva e si perdeva la zona
    const dbl = glBase ? glBase.doubleClickZoom : map.doubleClickZoom;
    if (dbl) on ? dbl.disable() : dbl.enable();
    if (on) {
      closeMapMenu();
      closePlacePop();
      probeLL = null; // via anche il tooltip del punto toccato
      ui.probe.hidden = true;
      renderLandscapeNav();
      // si parte sempre dalla vista intera (zoom minimo), dopo che la mappa ha preso le misure nuove
      setTimeout(() => {
        if (!landscapeMq.matches) return;
        map.invalidateSize({ pan: false });
        updateMinZoom();
        if (synoptic()) synopticView();
        else map.setView(areaBox.getCenter(), map.getMinZoom(), { animate: false });
      }, 300);
    }
  }
  landscapeMq.addEventListener("change", applyLandscape);

  // ---------- app dalla schermata Home: non c'è la barra del browser, quindi niente ricarica e niente "tira giù per
  // aggiornare". Un tasto accanto a quello del pannello ricarica la pagina (corse e passi nuovi).
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) {
    ui.appReload.hidden = false;
    ui.appReload.addEventListener("click", () => location.reload());
    // riaprendo l'app iOS mostra la pagina rimasta in memoria, con le corse di allora: a ogni ritorno in primo piano
    // si ricarica (la vista resta: modello, grandezza e ora stanno nell'indirizzo). Non se è aperta una finestra
    // (condivisione, grafico): tornando dall'app in cui si è condiviso l'immagine si perderebbe quello che si faceva.
    let wasHidden = false;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        wasHidden = true;
        return;
      }
      if (wasHidden && !document.querySelector("dialog[open]")) location.reload();
      wasHidden = false;
    });
  }

  // ---------- segnalazione degli errori (Sentry): solo se c'è il DSN (meta.sentry_dsn, variabile SENTRY_DSN). Niente
  // dati personali: né indirizzo IP (sendDefaultPii: false) né la parte dopo # dell'indirizzo, che contiene
  // coordinate e nomi delle località; niente tracciamento delle prestazioni né registrazione delle sessioni.
  const SENTRY_SRC = "https://browser.sentry-cdn.com/11.12.0/bundle.min.js"; // solo errori (niente tracing né replay)
  const SENTRY_SRI = "sha384-fpjRzLWxkdRneAxDGo5pt5gKsjCWYV5ksPD+S1lx80QHBhs6Oe58hf8sKUKubCES";
  function setupSentry(dsn) {
    if (!dsn) return;
    const noHash = (u) => (typeof u === "string" ? u.split("#")[0] : u);
    const el = document.createElement("script");
    el.src = SENTRY_SRC;
    el.integrity = SENTRY_SRI;
    el.crossOrigin = "anonymous";
    el.onload = () => {
      window.Sentry?.init({
        dsn,
        release: meta.version || undefined,
        environment: STATIC ? "production" : "local",
        sendDefaultPii: false,
        // nessun IP: Sentry non lo ricava dalla connessione e quindi nemmeno la posizione (paese, città)
        initialScope: { user: { ip_address: null } },
        tracesSampleRate: 0,
        // rumore dei browser, non errori dell'app
        ignoreErrors: ["ResizeObserver loop", "AbortError", "The operation was aborted"],
        beforeSend(event) {
          if (event.request?.url) event.request.url = noHash(event.request.url);
          if (event.request?.headers?.Referer) delete event.request.headers.Referer;
          return event;
        },
        beforeBreadcrumb(b) {
          if (b.category === "navigation") {
            b.data = { from: noHash(b.data?.from), to: noHash(b.data?.to) };
          }
          if (b.data?.url) b.data.url = noHash(b.data.url);
          return b;
        },
      });
    };
    document.head.append(el);
  }

  // ---------- avvio
  /** Mapbox GL: caricato senza bloccare l'avvio della pagina, mentre si scaricano
   *  meta e corse. Se non arrivano entro 8 s si parte con gli sfondi di riserva. */
  const loadScript = (src) =>
    new Promise((resolve) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve(true);
      el.onerror = () => resolve(false);
      document.head.appendChild(el);
    });
  const mapboxLib = Promise.race([
    loadScript(
      "https://cdnjs.cloudflare.com/ajax/libs/mapbox-gl/3.9.4/mapbox-gl.js",
    ),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);

  async function init() {
    loadSettings();
    readHash();
    setPanelCollapsed(mobileMq.matches);
    try {
      const [m] = await Promise.all([
        fetch(STATIC ? "data/meta.json" : "api/meta").then((r) => r.json()),
        refreshRuns(),
      ]);
      meta = m;
      // versione dai tag git (vuota se non ci sono tag)
      if (meta.version) {
        $("app-version").textContent = meta.version;
        $("app-version").hidden = false;
      }
      bases.topo.options.apikey = meta.thunderforest_key || "";
      if (map.hasLayer(bases.topo)) bases.topo.redraw();
    } catch (e) {
      setStatus(`Impossibile contattare il server: ${e.message}`, true);
      return;
    }
    startView = toBounds(meta.initial_view || meta.bbox);
    applyArea(); // area della mappa o, se la grandezza scelta è la carta sinottica, la sua
    await mapboxLib; // scaricata ed eseguita mentre arrivavano meta e corse
    setupSentry(meta.sentry_dsn);
    setupMapbox(meta.mapbox_token); // dopo la prima vista: Leaflet aggiunge i livelli solo a mappa posizionata
    applyLandscape(); // telefono già in orizzontale all'apertura
    renderSoundings(); // stazioni dei radiosondaggi, se accese
    map.on("resize", () => {
      updateMinZoom();
      if (map.getZoom() < map.getMinZoom())
        map.setZoom(map.getMinZoom(), { animate: false });
      map.panInsideBounds(areaBox, { animate: false });
    });
    setBorders(state.borders, false);
    setExtra(state.extra, false);
    setBase(state.base, false); // l'ultimo scelto in "Impostazioni" (salvato nel browser), altrimenti Rilievo

    ui.opacity.value = state.opacity;
    ui.bordersOpacity.value = state.bordersOpacity;
    applyBordersOpacity();
    ui.crisp.checked = state.crisp;
    ui.iso.checked = state.iso;
    setupVars();
    // stato iniziale (index.html): "Modelli e parametri" aperta, le altre sezioni chiuse, su ogni schermo
    setupPoints();
    setupModels();
    setupModes();
    setupRuns();
    setupSteps();
    await update();

    // nuove corse/passi arrivano mentre la pagina è aperta
    setInterval(async () => {
      try {
        await refreshRuns();
        const changed = setupRuns(); // passa da sola alla nuova corsa quando è completa
        if (changed) setupSteps();
        if (changed || !current) update();
      } catch {
        /* offline: riprova al prossimo giro */
      }
    }, 2 * 60e3);
  }

  async function start() {
    try {
      await init();
      if (glBase && !glBase.loaded()) {
        await new Promise((resolve) => {
          const ready = () => {
            clearTimeout(timer);
            glBase.off("idle", ready);
            glBase.off("error", ready);
            resolve();
          };
          const timer = setTimeout(ready, 12000);
          glBase.on("idle", ready);
          glBase.on("error", ready);
        });
      }
      await new Promise(requestAnimationFrame);
    } catch (e) {
      setStatus(`Errore di avvio: ${e.message}`, true);
    } finally {
      document.body.classList.remove("is-starting");
      document.body.removeAttribute("aria-busy");
      $("startup-loader")?.remove();
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        document.body.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 350,
          easing: "ease-out",
        });
      }
    }
    restoreChartFromHash();
  }

  start();
})();
