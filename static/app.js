/* Weathermaps: frontend. Everything that depends on area, models and fields
   comes from /api/meta and /api/runs: there are no fixed coordinates or thresholds here. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Home Screen app in portrait (iOS 26): the page starts below the clock but iOS still shortens it
  // by the height of the status bar (e.g. 812 px out of 874), leaving an empty strip at the bottom. Here the page takes
  // the full screen height (--app-h, see html/body in style.css). Not needed in landscape or in the browser.
  // iOS only: on Android the screen also includes the status bar and the navigation bar, which stay visible, and
  // a page taller than the window ended up with its bottom (the controls panel) under the navigation bar.
  // Registered before Leaflet and Mapbox: on resize the new size is ready when they recompute.
  const IOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function fixAppHeight() {
    const app =
      IOS && (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true);
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
    folders: $("folders"),
    folderNew: $("folder-new"),
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

  // run: always the model's latest complete run (no longer chosen by hand)
  const state = {
    model: "gfs",
    var: "t850",
    run: null,
    step: null, // time shown (with accumulations: inside the range)
    // accumulations: slider range (fixed until you move it, the whole run on opening) and accumulation kind
    // ("total" = since the start of the range, "hours" = the last `hours` hours). `mode` follows from it (see syncMode)
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
  }; // defaults: Outdoors, colours at 70%, borders down to regions at full contrast, smooth cells
  // "static": site published on GitHub Pages (pre-generated JSON files, no server)
  const STATIC = document.documentElement.dataset.mode === "static";
  let publishedAt = null; // static only: when the data were published
  let meta = null;
  let runs = null;
  let current = null; // /api/field response shown
  let currentContour = null; // field of the lines in combined entries (e.g. freezing level over precipitation)
  let currentArrows = null; // wind components in combined entries with arrows (e.g. 700 hPa wind over precipitation)
  let overlay = null;
  let menuLL = null; // point of the open map menu (right click or long press), see openMapMenu
  let probeLL = null; // point tapped on mobile: the value tooltip stays there (see "point tooltip")
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
        state.step = state.rangeTo; // the end of the range is shown
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

  // ---------- map
  const map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    // fractional zoom: the minimum zoom can fit the covered area exactly
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    maxBoundsViscosity: 1.0, // prevents dragging outside the area
  });
  map.zoomControl.setPosition("topright");
  const bases = {
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      crossOrigin: "anonymous",
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    // Thunderforest Outdoors: the key comes from /api/meta (see init); until then the tile stays empty
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
  /** Italian names where available (name_it), otherwise the local name: no "Genova / Genoa". */
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
  /** "Base": Mapbox Streets recoloured like a weather chart (palette similar to meteoblue): light beige background,
   *  pale green woods, light blue water, thin white roads. Under the data colours it must not compete with them. */
  const LAND = "hsl(47, 26%, 88%)",
    GREEN = "hsla(82, 46%, 72%, 0.55)",
    WATER = "hsl(205, 56%, 73%)";
  /** Outdoors: stronger relief, hillshading computed from the Mapbox terrain model (on top of the faint one
   *  already in the style). Below roads, data colours and borders. */
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
      // roads: white, edge just darker than the background
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
  /* Colours inside Mapbox: the data images (model, radar, satellite) become style layers, inserted
   * below borders and names (and above terrain, water and roads). This way Mapbox borders and cities stay readable
   * above the colours at any opacity, and match those of the basemap. A registry recreates them when the style changes. */
  const glImgs = new Map(); // id -> { url, bounds, opacity, crisp, visible }
  let glStyleReady = false;
  const glMap = () => (glBase && glStyleReady ? glBase : null);
  const glCoords = (b) => [
    [b.getWest(), b.getNorth()],
    [b.getEast(), b.getNorth()],
    [b.getEast(), b.getSouth()],
    [b.getWest(), b.getSouth()],
  ];
  /** First layer to keep above the colours: the borders (after roads and bridges, which stay below), or the place
   *  labels if borders are missing. */
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
      // already at the right opacity and without transitions: otherwise Mapbox starts from 1 and fades over 300 ms (radar
      // images being loaded showed for a moment, and the animation's cross-fade arrived late)
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
      // one image at a time: if Mapbox is still loading or decoding the previous one, the new one waits
      // (changing it midway, the old one can arrive after the new one and stay on the map: moving the slider quickly
      // the colours stopped on a wrong step)
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
  /** "Confini" (borders, Settings) on the Mapbox borders, above the colours: None hides them, Countries / Regions /
   *  Provinces show them dark down to that level, with the chosen opacity. Provinces (admin_level 2) are in the
   *  Mapbox data but not in the style: a layer of ours adds them. */
  let glWater = null; // coastline GeoJSON, from borders.json
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
    // coastlines (under the colours the sea is no longer visible): from borders.json, from OpenStreetMap like the basemap.
    // The Mapbox water outline would also include rivers, as scattered dashes.
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
        // light halo under the line: white as in Streets (Outdoors has it pinkish)
        m.setPaintProperty(id, "line-color", "#ffffff");
        continue;
      }
      m.setPaintProperty(id, "line-opacity", op);
      if (id.startsWith("wm-")) continue;
      // countries and regions as solid dark lines (in the Mapbox styles they are dashed and light: above the colours they vanished)
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
  /** Copy of the Mapbox drawing for the shared image: without preserveDrawingBuffer (slower) the WebGL canvas can
   *  only be read right after a draw, in the "render" event. */
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
  let glShot = null; // latest glCapture copy, used by snapshotMap
  /** Synoptic chart: of the Mapbox basemap only the background and our layers (data colours) remain; coastlines and
   *  countries are our own low-resolution lines (styleSynBorders). Back on the normal map everything reappears. */
  function glSynopticBase() {
    const m = glMap();
    if (!m) return;
    if (synoptic()) {
      m.__synHidden ??= new Set();
      for (const l of m.getStyle().layers) {
        if (l.type === "background" || glImgs.has(l.id)) continue; // the background and the data images remain
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
      fadeDuration: 0, // no label fade: fewer frames to draw after each move
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
      m.__synHidden = null; // new style: no layer hidden by the synoptic chart
      glSynopticBase();
      for (const [id, c] of glImgs) if (c.url) glApply(m, id, c); // the new style does not have our layers
    });
    for (const layer of Object.values(bases)) map.removeLayer(layer);
  }
  // basemap: from the "Impostazioni" (settings) section of the panel (no Leaflet layer switcher)
  const BASE_NAMES = { osm: "Base", topo: "Outdoors" }; // "weather chart" effect: maximum opacity and borders
  // borders above the colours (Settings), by level: each choice includes the previous ones
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
    state.base = bases[name] ? name : "topo"; // also the old "Essenziale" saved in the browser
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
    if (save) saveSettings(); // not at startup: a link with the opacity in the URL does not change the saved ones
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
  // map attribution always in the panel, in the "Info & crediti" section (where the model data sources are too,
  // in index.html); Leaflet keeps updating it by itself.
  ui.attrib.appendChild(map.attributionControl.getContainer());

  // on mobile badge and legend become a single box at the bottom: the legend goes into the badge
  // mobile version: phones and tablets in portrait (same rule in the @media of style.css)
  const mobileMq = window.matchMedia(
    "(max-width: 600px), (orientation: portrait) and (pointer: coarse) and (max-width: 1100px)",
  );
  const hoverMq = window.matchMedia("(hover: hover)"); // devices with a mouse: there is the hover tooltip
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
  /** Interval between two times, with the day written once if it is the same:
   *  "ven 13 nov, 06:00 → 18:00" or "gio 12, 18:00 → ven 13 nov, 06:00" (the month at the start only if it changes). */
  function fmtSpan(a, b, { month = true } = {}) {
    if (fmtDay(a) === fmtDay(b))
      return `${fmtDay(b, month)}, ${fmtHour(a)} → ${fmtHour(b)}`;
    const startMonth = month && fmtDay(a).split(" ").pop() !== fmtDay(b).split(" ").pop();
    return `${fmtDay(a, startMonth)}, ${fmtHour(a)} → ${fmtDay(b, month)}, ${fmtHour(b)}`;
  }
  const stepDate = (step) => new Date(runDate(state.run).getTime() + step * 3600e3);
  // start of the accumulation shown, only for chosen intervals (not for the total since the run)
  // start of the accumulation (also the total since the start of the run): so start and end can always be read
  const intervalStartDate = (s = state.step) =>
    state.run && rangeMode() && intervalPrev(s) < s ? stepDate(intervalPrev(s)) : null;
  // time shown, or the interval if one is chosen: for panel, popup and shared image
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
  // data field (colours, places, steps): for combined entries it is the colours' one (e.g. "tp")
  const dataVar = () => variable()?.field || variable()?.vector?.u || state.var;
  // synoptic chart (geopotential and pressure): own area, no places, charts, radar or satellite
  const synoptic = () => !!(meta && variable()?.area);
  const areaNow = () => variable()?.area || meta.bbox;
  // name for legend and texts: for combined entries the colour field's ("Precipitazione")
  const baseLabel = () => variable().base_label || variable().label;
  // accumulations: difference between the total at the two chosen ends. Old links with `ore` still set the presets.
  const INTERVALS = [3, 6, 12, 24];
  const intervalSteps = () => {
    const values = steps();
    return values[0] === 0 ? values : [0, ...values];
  };
  /** Step nearest to `s - hours`; beyond +144h steps are every 6 hours, so a 3h preset becomes 6h. */
  function presetPrev(s = state.step, hours = state.hours) {
    const target = s - hours;
    if (target <= 0) return 0;
    let best = 0;
    for (const x of meta.steps) if (x <= target && x > best) best = x;
    return best;
  }
  /** Start of the accumulation shown at hour `s`: the start of the range (Total) or the last chosen hours, never before
   *  the range. Everything else (data, legend, charts) reads from here. */
  function intervalPrev(s = state.step, hours = state.hours) {
    if (state.cum === "hours") return presetPrev(s, hours); // the last hours, anywhere in the run
    return state.rangeFrom ?? 0;
  }
  // accumulations: with Total the two-thumb slider picks the period; with fixed hours a single thumb that jumps
  // by `hours` hours along the whole run (the period is remembered for when you go back to Total)
  const presetMode = () => rangeMode() && state.cum === "hours";
  const dualMode = () => rangeMode() && state.cum !== "hours";
  /** Hours that one-thumb sliders, arrows and play move on: with fixed hours one every `hours` hours of the run. */
  function slideSteps() {
    if (!presetMode()) return steps();
    const avail = [...availableSteps()];
    return rangeFrames(0, avail.length ? Math.max(...avail) : steps().at(-1));
  }
  /** Data mode from the choice: "total" if the accumulation starts at the start of the run, otherwise "interval". */
  function syncMode() {
    if (!rangeMode()) return;
    state.mode = intervalPrev() === 0 ? "total" : "interval";
  }
  /** Hours between `from` and `to`: every step with Total (play inside the period); with fixed hours one every `hours`
   *  hours (each the last `hours` hours). */
  function rangeFrames(from = state.rangeFrom ?? 0, to = state.rangeTo ?? state.step) {
    const avail = availableSteps();
    const inside = steps().filter((x) => x > from && x <= to && avail.has(x));
    if (state.cum !== "hours") return inside;
    const frames = [];
    for (let target = from + state.hours; target <= to; target += state.hours) {
      const x = [...inside].reverse().find((y) => y <= target); // nearest step (beyond +144h every 6 hours)
      if (x != null && x !== frames.at(-1)) frames.push(x);
    }
    return frames.length ? frames : inside.slice(-1);
  }
  // actual duration of the accumulation at the step shown: always written, never just "interval"
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
    // the slider shows the (fixed) range, not the accumulation of the time shown
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
  // "in 3h" / "totale" / "" (instantaneous fields), after the field name
  const modePhrase = () =>
    state.mode === "interval"
      ? `in ${intervalHours()}h`
      : state.mode === "total"
        ? "totale"
        : "";
  // combined entries: what the lines are ("· linee zero termico ogni 250 m"), in the legend and in the shared image
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
  // with accumulations the lines are not those of the final time but the period mean weighted by precipitation
  const weightedContour = () =>
    !!variable()?.contour_field && state.mode === "interval";
  // name of the line value for legend, popup and tooltip: with accumulations "Zero termico in 24h", like
  // "Precipitazione in 24h" (it is the period mean weighted by precipitation, see contourFieldAt)
  const contourName = () =>
    `${variable().contours.label}${weightedContour() ? ` in ${intervalHours()}h` : ""}`;
  // steps of the chosen model: the slider stops at the model's range (e.g. ICON-CH2 at +120h)
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

  /** Notice in the centre of the map (null = hidden). */
  function showNoData(title, text = "") {
    ui.nodata.hidden = !title;
    if (title) {
      ui.nodataTitle.textContent = title;
      ui.nodataText.textContent = text;
    }
    map.getContainer().classList.toggle("map-nodata", !!title); // without data the map stays grey
    document.body.classList.toggle("no-data", !!title); // and only the main menu is on top (see style.css)
    if (title) {
      ui.probe.hidden = true;
      probeLL = null;
    }
    // panel closed (often on mobile): it reopens, otherwise only a silent grey map would remain
    if (title && ui.panel.classList.contains("collapsed")) ui.collapse.click();
  }

  function setStatus(text, warn = false) {
    ui.status.textContent = text || "";
    ui.status.classList.toggle("warn", !!warn);
  }

  // ---------- settings (basemap, opacity, sharp cells, contours) saved in the browser; a link with parameters
  // in the URL wins over the saved ones (readHash comes after)
  const SETTINGS_KEY = "weathermaps.settings.v1";
  // version of the saved settings: with 2 (Mapbox basemaps) the colour and border defaults change, and whoever
  // had saved the old ones (borders off) restarts once from the new ones; the other choices stay
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
      else if (d.radar === true) state.extra = "radar"; // setting saved by the first version of the radar
      if (current && Number.isFinite(d.bordersOpacity))
        state.bordersOpacity = Math.min(1, Math.max(0.1, d.bordersOpacity));
    } catch {
      /* storage unavailable or corrupted data: default values */
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
      /* storage unavailable */
    }
  }

  // ---------- state in the URL
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const k of ["model", "var", "mode"]) if (p.get(k)) state[k] = p.get(k);
    // accumulations: range (from, to) and kind (ore = 3/6/12/24, without = Total). Old links (from + step, without to)
    // become a range with Total; "ore" alone (even older links) is the hours button over the whole run
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
    // the "corsa"/"run" parameters of old links are ignored: the latest complete run is always shown
    if (p.get("step")) state.step = +p.get("step");
    if (p.get("opacity"))
      state.opacity = Math.min(1, Math.max(0.1, +p.get("opacity")));
    if (p.get("crisp")) state.crisp = p.get("crisp") === "1";
    if (p.get("iso")) state.iso = p.get("iso") !== "0";
  }
  // Safari allows at most 100 replaceState calls every 30 seconds, then throws: dragging the slider back and forth
  // the map update stopped there (it looked frozen). So the address is written shortly after the last
  // change (once for a series of moves) and a possible error stops nothing.
  function replaceHash(hash) {
    try {
      history.replaceState(history.state, "", hash);
    } catch {
      /* browser limit: the address is updated at the next change */
    }
  }
  let hashTimer = null;
  // when leaving the page (reload, close) the pending address is written right away
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

  // ---------- filling the controls
  // flags: flag-icons library (all 4:3, same width); for the median a Lucide "layers" icon (ISC)
  const LAYERS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>';
  const modelIcon = (m) =>
    m.country
      ? `<span class="fi fi-${m.country}"></span>`
      : m.id === "mean"
        ? LAYERS_ICON
        : "";

  /** Model select: flag + name. The initial <button><selectedcontent> stays in place. */
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

  // all models, always: changing field does not change the model by itself; if it does not provide it the notice
  // in the centre of the map says so (see update)
  function setupModels() {
    const models = meta.models;
    if (!models.find((m) => m.id === state.model))
      state.model = (
        models.find((m) => variable().models.includes(m.id)) || models[0]
      ).id;
    fillModelSelect(models, state.model);
    renderModelInfo();
  }

  // ---------- info icon about the chosen model
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
      meta.variables.map((v) => [v.id, v.menu_label || v.label]), // short name, fits on one line
      state.var,
    );
    ui.varRow.hidden = meta.variables.length < 2;
  }

  function setupModes() {
    const v = variable();
    if (!v.modes.includes(state.mode)) state.mode = v.modes[0];
    // accumulated fields: Totale · 3h · 6h · 12h · 24h; the double slider allows any other interval.
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
            // the range stays the chosen one: only the accumulation kind changes; the end of the range is shown
            togglePlay(false);
            state.cum = h ? "hours" : "total";
            if (h) {
              // fixed hours: always restart from the first interval of the run (the Total period stays remembered)
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
    // two-thumb slider only with Total; with fixed hours the one-thumb one (see slideSteps)
    document.body.classList.toggle("range-mode", dualMode());
    updateModeSelection();
  }

  // lit button: with accumulations the chosen kind (Total or hours), otherwise the mode
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

  /** Run to show: the latest complete one (runs still incoming are not shown). */
  function runList() {
    return (runs[state.model] || []).filter(
      (r) => !r.incoming && r.variables[dataVar()],
    );
  }
  /** Newest run still incoming, only for the notice. */
  const incomingRun = () =>
    (runs[state.model] || []).find((r) => r.incoming && r.variables[dataVar()]);

  /** Returns true if the run shown has changed. */
  function setupRuns() {
    const before = state.run;
    const r = runList()[0];
    state.run = r ? r.run : null;
    if (!r) {
      // field the model does not have: the notice already says so, no run to show here
      ui.run.textContent = variable()?.models.includes(state.model) ? "nessuna corsa disponibile" : "—";
      ui.run.title = "";
      ui.runAge.textContent = "";
    } else {
      ui.run.innerHTML = `<strong>${cycle(r.run)}</strong> ${fmtRunDay(r.run)}`;
      ui.run.title = `Corsa delle ${cycle(r.run)} del ${fmtRunDay(r.run)}: l'ultima completa`;
      const sel = r.variables[dataVar()];
      // short text: the "Corsa" row fits on one line even in the narrow panel; the long one in the tooltip
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

  // ---------- incoming run: status + "Aggiorna" (refresh) button
  let refreshing = false;

  /** Notice of the incoming run: it is shown once complete, meanwhile its progress is visible. */
  function renderRunLive(incoming) {
    const info = incoming?.variables[dataVar()];
    ui.runLive.hidden = !info && !refreshing;
    if (info)
      ui.runLiveText.textContent = `${cycle(incoming.run)} in arrivo · ${info.steps.length}/${info.expected ?? steps().length} passi`;
    else if (state.run)
      ui.runLiveText.textContent = `Corsa ${cycle(state.run)} aggiornata`;
  }

  /** Run shown and downloaded steps (of the incoming run too), across all fields. */
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
      // follows the update on the server and shows the steps as they arrive
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
      // range: on opening (or if no longer valid, e.g. different range) the whole available run
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
        // fixed hours: the time shown must be one of the thumb's stops
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
      // satellite: greyscale of the clouds (infrared), from the thinnest to the highest
      ui.legend.innerHTML =
        `<h2><span class="lg-label">Nubi da satellite </span>(infrarosso)</h2><ol class="lg-continuous">` +
        `<li><i style="background:linear-gradient(to right, ${SAT_SHADES[0]}, ${SAT_SHADES[1]})"></i><span class="lg-tick">basse</span></li>` +
        `<li><i style="background:linear-gradient(to right, ${SAT_SHADES[1]}, ${SAT_SHADES[2]})"></i><span class="lg-tick"></span><span class="lg-tick lg-tick-end">alte</span></li></ol>`;
      return;
    }
    if (state.extra === "radar") {
      // radar on: its legend (the service's classes, mm/h) instead of the model's
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
    const openLow = v.scale.transparent_below == null; // the first class also includes the lowest values
    // with many thresholds (T850 every 2 °C) one out of two is written, so as not to crowd the bar; even fewer if the
    // labels are long (geopotential: 31 three-digit thresholds)
    let every = thresholds.length > 14 ? 2 : 1;
    const chars = (k) =>
      thresholds.reduce((a, t, i) => a + (i % k ? 0 : num(t).length + 1), 0);
    while (chars(every) > 50) every *= 2;
    if (v.scale.continuous) {
      // smooth bar: one segment per pair of colour stops, thresholds on the edges (the last on the right)
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
      // tick: lower threshold of the class, shown only in the compact bar on mobile
      // the first precipitation class (from 0.1 mm) reads "from 0": the first number sits on the left edge of the bar
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

  // ---------- data
  const ctxNow = () => ({ model: state.model, var: dataVar(), run: state.run });

  function fieldUrl(step, mode, ctx, prev) {
    if (STATIC)
      return `data/field/${ctx.model}/${ctx.var}/${ctx.run}/${step}.bin`;
    const p = new URLSearchParams({ ...ctx, step, mode });
    if (mode === "interval") p.set("prev", prev);
    return `api/field?${p}`;
  }

  // field requests in progress: moving the slider quickly piles up dozens (the browser makes 6 at a time
  // per site) and the needed step stays queued behind those already passed: the old ones are cancelled
  const inflight = new Map(); // url -> { ctrl, gen }
  let fetchGen = 0;
  function dropStaleFetches() {
    fetchGen++;
    if (inflight.size <= 5) return; // only a few: let them finish (they are the nearby steps, they will be needed)
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
    // static: there is only the total; the accumulation is the difference between two totals (as the server does)
    if (STATIC && mode === "interval")
      return getIntervalStatic(step, ctx, prev);
    // static: the detail fields (e.g. z850) are in the file of the field they belong to (t850)
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

  /** Static site: field in compact format (see app/packed.py). JSON header with the value lists replaced
   *  by {"$q": [start, count, scale]}, then the values as 16-bit integers (-32768 = missing). Returns the same object
   *  as /api/field. */
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
          // differences between neighbouring cells, zig-zag, low and high bytes separate (compresses better on the wire)
          const lo = new Uint8Array(buf, base + 2 * start, len),
            hi = new Uint8Array(buf, base + 2 * start + len, len);
          src = new Int16Array(len);
          off = 0;
          let acc = 0;
          for (let k = 0; k < len; k++) {
            const zz = lo[k] | (hi[k] << 8);
            acc = ((acc + ((zz >>> 1) ^ -(zz & 1))) << 16) >> 16; // 16-bit sum, as in the writing
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
        F32.set(out, f32); // for drawing, without converting again
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
          // the colour image too, if the map has not changed in the meantime
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

  /** Combined entries with arrows: the two wind components at the same time (same files as the "Vento" entries). */
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

  // ---------- wind: the "Vento" entries request the two components (eastward `u`, northward `v`, in km/h) and derive
  // the speed (colours, places, ranking) and the direction (arrows)
  function mainField(step) {
    const vec = variable()?.vector;
    if (!vec) return getField(step);
    const ctx = ctxNow();
    const key = `vec|${ctx.model}|${ctx.run}|${vec.u}|${step}`;
    if (!cache.has(key)) {
      // static: the two components are in a single file per step (fewer files to publish)
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
  /** Where the wind blows from (meteorological convention): degrees from north clockwise and compass point. */
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

  // ---------- Extra layers: radar or satellite (one at a time), animated over the latest images. Public WMS services
  // requested by the browser (open CORS, also on the static site); each tile is cleaned up in a canvas (clean) so that
  // only the phenomenon remains above the map. With an extra layer on, the model layers disappear.
  /* radar: our own classes (lower bound in mm/h and colour), the classic scale of Italian radar maps. The service
   * colours the image with these thresholds on the real values: it receives them as a style (SLD) with the request. */
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
    // "intervals": each colour applies up to the declared threshold; below the first, transparent
    `<ColorMapEntry color="#000000" quantity="${RADAR_CLASSES[0][0]}" opacity="0"/>` +
    RADAR_CLASSES.map(
      ([, c], i) =>
        `<ColorMapEntry color="${c}" quantity="${RADAR_CLASSES[i + 1]?.[0] ?? 1e6}"/>`,
    ).join("") +
    `</ColorMap></RasterSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>`;
  const SAT_SHADES = ["#969ea6", "#cbcfd4", "#ffffff"]; // satellite legend: thin/low clouds → thick/high
  const wmsUrl = (base, params) =>
    `${base}?${new URLSearchParams({ service: "WMS", version: "1.3.0", styles: "", ...params })}`;
  const EXTRAS = {
    // national radar mosaic (Protezione Civile) published by ItaliaMeteo on MeteoHub: intensity in mm/h every 5 minutes
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
      // colours from our classes (RADAR_CLASSES), not the service's; values are interpolated (bilinearly) before
      // being coloured: soft outlines instead of the data's 1 km squares
      sld: true,
      clean(d) {
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) d[i] = 0;
      }, // blurred edges: removed
      /** Latest image: tried backwards in 5-minute steps with a 1-pixel image (for a time that does not exist
       *  yet the service answers with an XML error instead of a PNG). */
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
    // third-generation Meteosat (EUMETSAT): 10.5 µm infrared every 10 minutes, day and night. The lighter, the colder
    // the cloud (high or thick): brightness becomes transparency, white clouds and clear ground invisible
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
        // infrared grey: clear land and sea ~50-100, clouds ~110-200 (lighter = colder = higher). Below
        // 100 transparent; above, increasingly opaque and white cloud (low ones grey, high ones white: readable even
        // on the light map)
        for (let i = 0; i < d.length; i += 4) {
          const v = d[i],
            a = Math.max(0, Math.min(1, (v - 100) / 70)),
            w = Math.max(0, Math.min(1, (v - 110) / 80));
          d[i] = d[i + 1] = Math.round(150 + 105 * w);
          d[i + 2] = Math.round(158 + 97 * w); // slightly bluish grey → white
          d[i + 3] = Math.round(255 * a);
        }
      },
      /** Latest image: from the capabilities of the single layer (8 kB), default attribute of the time dimension. */
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
  map.getPane("radar").style.zIndex = 405; // above the model colours, below borders, arrows and contours
  map.getPane("radar").style.pointerEvents = "none";
  /** One image per time over the whole data area (13 requests instead of hundreds of tiles: the satellite
   *  server answers in ~2 s per request), cleaned up in a canvas and shown as an image above the map: moving
   *  or zooming the map reloads nothing. 1800 px over the area ≈ 1 km per pixel, finer than the data. */
  const EXTRA_W = 1800;
  function extraImage(cfg, time) {
    const b = meta.bbox,
      W = cfg.width || EXTRA_W;
    const sw = L.CRS.EPSG3857.project(L.latLng(b.lat_min, b.lon_min)),
      ne = L.CRS.EPSG3857.project(L.latLng(b.lat_max, b.lon_max));
    const h = Math.round((W * (ne.y - sw.y)) / (ne.x - sw.x));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // to clean up the pixels and for the shared image
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
      img.onerror = () => resolve(null); // missing image: that time stays empty
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
  // animation: the last `frames` images, one layer per image loaded right away; switching from one to the next changes
  // only the opacity, so the animation does not flicker while the tiles arrive
  const extraCfg = () => EXTRAS[state.extra];
  const fmtRadarTime = (t) =>
    new Date(t).toLocaleTimeString("it-IT", {
      timeZone: "Europe/Rome",
      hour: "2-digit",
      minute: "2-digit",
    });
  let radarFrames = []; // [{ time, layer, ready }] from the oldest to the most recent
  let radarIdx = -1,
    radarTimer = null,
    radarPlay = null;
  let radarAutoplay = false; // turned on with the layer: the animation starts by itself as soon as all images are loaded
  /** Loading state: while some image is missing, a box in the centre of the page ("Caricamento radar 5/13") and
   *  hidden controls; when all are ready it goes away and, the first time, the animation starts right away. After
   *  a map move the new tiles arrive while the animation continues: no box. */
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
      // images ready: bar and legend enter with the animation (see .badge-enter in style.css)
      const enter = (el, cls) => {
        el.classList.remove(cls);
        void el.offsetWidth; // restarts even if it was just used
        el.classList.add(cls);
        const end = (e) => {
          if (e.target !== el) return;
          el.classList.remove(cls);
          el.removeEventListener("animationend", end);
        };
        el.addEventListener("animationend", end);
      };
      enter(ui.badge, "badge-enter");
      if (!ui.badge.contains(ui.legend)) enter(ui.legend, "legend-enter"); // on mobile the legend is inside the bar
    }
    $("radar-loader-name").textContent = extraCfg()?.name.toLowerCase() || "";
    $("radar-loader-count").textContent = radarFrames.length
      ? `${ready} di ${radarFrames.length} immagini`
      : "in attesa…";
    if (!all) return;
    showRadarFrame(radarIdx); // image time instead of the count
    if (radarAutoplay) {
      radarAutoplay = false;
      startRadarPlay();
    }
  }
  /** Cross-fade between image `i` and the next (`t` from 0 to 1, cyclic): the next appears on top in the first half
   *  while the other stays full, then the other fades. So in the shared areas the rain does not dim halfway. */
  function paintRadar(i, t) {
    // until all images have arrived none is shown (no pieces while loading)
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
    if (radarFrames.length) showRadarFrame(radarIdx); // no cross-fade left halfway
    $("radar-play").innerHTML = M_PLAY;
    $("radar-play").setAttribute("aria-label", "Anima");
  }
  const RADAR_HOLD = 150,
    RADAR_HOLD_LAST = 1500,
    RADAR_FADE = 350; // ms: each image stays still then fades into the next
  function startRadarPlay() {
    if (radarFrames.length < 2) return;
    $("radar-play").innerHTML = M_PAUSE;
    $("radar-play").setAttribute("aria-label", "Ferma l'animazione");
    if (radarIdx >= radarFrames.length - 1) showRadarFrame(0); // from the last one, start again from the first
    let t0 = performance.now();
    const step = (now) => {
      const n = radarFrames.length,
        last = radarIdx >= n - 1;
      const hold = last ? RADAR_HOLD_LAST : RADAR_HOLD,
        el = now - t0; // longer pause on the last image
      if (el >= hold + RADAR_FADE) {
        showRadarFrame(last ? 0 : radarIdx + 1);
        t0 = now;
      } else if (el > hold) paintRadar(radarIdx, (el - hold) / RADAR_FADE);
      radarPlay = requestAnimationFrame(step);
    };
    radarPlay = requestAnimationFrame(step);
  }
  /** Aligns the layers to the latest available image: keeps those already loaded, adds the new ones, removes the old. */
  async function refreshRadar() {
    const cfg = extraCfg();
    if (!cfg) return;
    let latest = null;
    try {
      latest = await cfg.latest();
    } catch {
      /* no network: retried at the next round */
    }
    if (extraCfg() !== cfg) return; // the layer changed in the meantime
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
    ); // placeholder
    // requests from the most recent (the most useful, and the animation stops there): the server handles few at a time
    for (const f of [...radarFrames].reverse()) {
      if (keep.has(f.time)) continue;
      extraImage(cfg, f.time).then((url) => {
        if (!radarFrames.includes(f)) {
          if (url) URL.revokeObjectURL(url);
          return;
        } // layer already changed
        f.url = url;
        if (url && glBase)
          f.layer = glFrameLayer(`wm-x-${f.time}`, url, bounds); // inside Mapbox, below borders and names
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
    if (wasLast && !radarPlay) showRadarFrame(radarFrames.length - 1); // without animation stay on the latest image
    updateRadarLoading();
  }
  /** Radar/satellite image as a Mapbox layer, with the same methods used by the animation. */
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
    // radar, satellite and soundings only on the normal map
    state.extra = (EXTRAS[name] || name === "snd") && !synoptic() ? name : "none";
    const cfg = extraCfg();
    // soundings: the model colours go away as with the radar, map and stations remain (see renderSoundings)
    const snd = state.extra === "snd";
    document.body.classList.toggle("snd-mode", snd);
    renderSoundings();
    // with an extra layer: the model's colours, contours and arrows disappear (it would be unreadable), legend and top
    // bar switch to the layer; the model stays selected and comes back when it is removed
    document.body.classList.toggle("radar-mode", !!cfg);
    if (glImgs.has("wm-model")) glPut("wm-model", { visible: !cfg && !snd }); // the model colours disappear in Mapbox too
    $("extra-name").textContent = cfg?.name || "";
    if (cfg) togglePlay(false);
    if (meta && state.var) {
      renderLegend();
      renderPoints();
    } // at startup setupVars and setupPoints draw them
    ui.probe.hidden = true;
    radarAutoplay = !!cfg;
    radarReadyOnce = false;
    updateRadarLoading();
    if (cfg) {
      refreshRadar();
      radarTimer = setInterval(refreshRadar, cfg.stepMin * 60e3); // new image every 5 (radar) or 10 minutes (satellite)
    }
    $("extra-seg").replaceChildren(
      ...Object.entries(EXTRA_NAMES).map(([k, text]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.setAttribute("aria-pressed", String(k === state.extra));
        b.addEventListener("click", () => {
          setExtra(k);
          // on mobile the panel covers the map: turning on radar or satellite closes it, so the loading is visible
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
  }); // when coming back to the page

  map.createPane("arrows");
  map.getPane("arrows").style.zIndex = 425;
  map.getPane("arrows").style.pointerEvents = "none";
  const arrowsRenderer = L.canvas({ pane: "arrows", padding: 0.1 });
  const arrowsLayer = L.layerGroup().addTo(map);
  const ARROW_STEP = 46; // px between arrows
  /** Direction arrows (where the wind goes) on a regular pixel grid, recomputed at every move:
   *  always the same density at every zoom. Length grows with speed. */
  function drawArrows() {
    arrowsLayer.clearLayers();
    const f = current?.u ? current : currentArrows; // "Vento" entry or combined with arrows
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
        if (sp < 2) continue; // calm: no arrow
        const len = 9 + (Math.min(sp, 80) / 80) * 13; // 9–22 px
        const dx = u / sp,
          dy = -v / sp; // screen: y pointing down
        const x0 = x - (dx * len) / 2,
          y0 = y - (dy * len) / 2,
          x1 = x + (dx * len) / 2,
          y1 = y + (dy * len) / 2;
        const h = 5,
          wx = -dy,
          wy = dx; // tip: two strokes at about 30°
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

  /** Field of the lines in combined entries at step `step`. With accumulations (e.g. precipitation in 24h) it is the
   *  period's mean freezing level weighted by precipitation: for each point, each sub-interval between two steps counts as
   *  much as the precipitation that fell in it, with the mean freezing level between its two ends. Where no rain falls in
   *  the period (less than 0.1 mm) the plain mean is used. With Total it is the value at the time shown. */
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
        // different grids between precipitation and lines (should not happen): only the final time
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
            const z = a != null && b != null ? (a + b) / 2 : (b ?? a); // at step 0 there is no freezing level
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
      // smooth: linear interpolation between the two nearby colour stops, constant beyond the ends
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

  // ---------- colour image: computed in a worker (static/render.js), so the millions of pixels of the 1-2 km
  // models do not block slider, pinch and animations; the images of steps already seen (and of nearby ones, prepared
  // in advance) stay in memory, so going back to a step or animating recomputes nothing.
  const F32 = new WeakMap(); // list of values (with null) -> Float32Array (NaN = missing), for the worker
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
    /* no worker: computed in the page */
  }
  const renderJobs = new Map(); // id -> { job, resolve, low }
  let renderBusy = null,
    renderSeq = 0;
  function pumpRender() {
    if (renderBusy != null || !renderJobs.size) return;
    // first the image to show (the last requested), then those prepared in advance
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
      // worker unusable: the queued jobs move to the page
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
  const IMG_KEEP = 40; // images kept (the most recent): ~10 MB at most with the finest models
  const imgCache = new Map(); // key -> Promise<url>
  const fieldImageIds = new WeakMap();
  let fieldIds = 0;
  /** Colour image of a field for the current field and settings; `low` = prepared in advance. */
  function fieldImage(f, low = false) {
    const v = variable(),
      { nx, ny, lat0, lon0, dlat, dlon } = f.grid;
    if (!fieldImageIds.has(f)) fieldImageIds.set(f, ++fieldIds);
    const key = `${fieldImageIds.get(f)}|${state.var}|${state.crisp ? 1 : 0}`;
    const hit = imgCache.get(key);
    if (hit) {
      imgCache.delete(key);
      imgCache.set(key, hit); // recently used: to the end
      if (!low && hit.id != null && renderJobs.has(hit.id)) {
        // needed right now
        for (const j of renderJobs.values()) j.low = true;
        renderJobs.get(hit.id).low = false;
        pumpRender();
      }
      return hit;
    }
    // fields with their lines (T850, freezing level): colours from the same smoothed field as the lines, so each
    // line falls exactly on a colour change; "sharp cells" shows the raw data instead
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
      // 2 pixels per cell (at least 1100 wide); the finest grids (ICON-CH1, 1 km) already have enough.
      // Synoptic chart: the 0.25° cells are large on screen, with the narrow 4 dam bands more pixels are needed
      // (otherwise the band edges come out stepped); 7 keeps the width below the 4096-pixel texture limit
      // of phones
      upscale: synoptic()
        ? Math.max(2, Math.min(7, Math.floor(4096 / nx)))
        : Math.max(nx >= 800 && !state.crisp ? 1 : 2, Math.ceil(1100 / nx)),
      // synoptic chart: GFS at 0.25° has small irregularities between neighbouring cells that, with 4 dam bands, make
      // chequered edges; two averaging passes give the soft bands of the classic charts (the tooltip stays raw)
      smooth: synoptic() ? 2 : own ? Math.min(4, Math.round(0.1 / dlon)) : 0,
    };
    const pr = renderWorker
      ? new Promise((resolve) => {
          if (!low) for (const j of renderJobs.values()) j.low = true; // steps already passed no longer have priority
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
      // drop the oldest (never the one shown: it has just been used)
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
    // cell edges
    const south = lat0 - dlat / 2,
      north = lat0 + (ny - 1) * dlat + dlat / 2;
    const west = lon0 - dlon / 2,
      east = lon0 + (nx - 1) * dlon + dlon / 2;
    const bounds = L.latLngBounds([south, west], [north, east]);
    const my = ++drawSeq,
      crisp = state.crisp;
    const painted = fieldImage(f).then((url) => {
      if (my !== drawSeq || !url) return; // meanwhile we moved to another field
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
    drawSeq++; // an image still being computed must no longer appear
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

  // ---------- contour lines (isotherms at 850 hPa): computed here from the field, drawn above the colours
  map.createPane("contours");
  map.getPane("contours").style.zIndex = 420;
  map.getPane("contours").style.pointerEvents = "none";
  map.createPane("contourLabels");
  map.getPane("contourLabels").style.zIndex = 430;
  map.getPane("contourLabels").style.pointerEvents = "none";
  const isoRenderer = L.canvas({ pane: "contours", padding: 0.5 });

  // ---------- geographic outlines (coastlines, lakes, country and province borders, Natural Earth) above the colours:
  // only with maximum opacity, when the basemap is no longer visible (before, they would be double lines).
  // The file is downloaded the first time they are needed.
  map.createPane("borders");
  map.getPane("borders").style.zIndex = 410;
  map.getPane("borders").style.pointerEvents = "none";
  const bordersRenderer = L.canvas({ pane: "borders", padding: 0.5 });
  const bordersLayer = L.layerGroup();
  const BORDER_STYLE = {
    coast: { weight: 1.5, opacity: 0.85 },
    countries: { weight: 2, opacity: 0.9 },
    regions: { weight: 1.4, opacity: 0.8 },
    provinces: { weight: 1.1, opacity: 0.75, dashArray: "4 3" }, // dashed: tells them apart from regions
  };
  // which lines, from the "Confini" choice: Countries = coastlines and country borders (with maximum opacity the map
  // becomes a classic weather chart), Regions and Provinces add the internal borders
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
  const borderLines = {}; // key -> polyline, created when borders.json is first loaded
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
    } // with Mapbox the borders are its own
    const keys = visibleBorders();
    if (!keys.size) {
      bordersLayer.remove();
      return;
    }
    bordersLayer.addTo(map);
    const apply = () => {
      // state read at the time: if it changed in the meantime, the latest wins
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
      }); // the map works without outlines anyway: it will be retried
    bordersLoad?.then(apply);
  }
  // coastlines and countries of the synoptic chart (Natural Earth 1:50m, scripts/make_borders.py --synoptic): above the
  // colours, with Mapbox too (of its basemap only the background remains there). "Confini: Nessuno" turns them off.
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

  /** Marching squares: for each level the segments in the cells, then joined into lines (open or closed). */
  function contourLines(f, levels) {
    const { lat0, lon0, dlat, dlon, nx, ny } = f.grid;
    const v = f.values; // already smoothed (smoothField)
    const out = [];
    for (const lvl of levels) {
      // values arrive rounded (0.1 °C): one exactly equal to the level would make stepped lines along
      // the cells; the level is shifted by a hair so no value touches it
      const L0 = lvl + 1e-4;
      const pos = new Map(); // side id -> [lat, lon] of the crossing
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
          // sides: 0 = a-b (bottom), 1 = b-c (right), 2 = d-c (top), 3 = a-d (left)
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
          // saddle: the value at the cell centre decides
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
      // joining the segments that share a side
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
        if (ids.length < (closed ? 12 : 4)) continue; // tiny fragments and rings: just noise
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

  /** Smoothed field for contour lines and their colours (computed once per field). On fine grids
   *  (ICON 2 km) more passes, so the lines do not become many little rings; GFS (0.25°) stays as it is. */
  function smoothField(f) {
    if (!f._smooth) {
      const { nx, ny, dlon } = f.grid;
      f._smooth = {
        ...f,
        // synoptic chart: soft isobars like in the classic charts (at 0.25° otherwise no pass)
        values: blurred(f.values, nx, ny, synoptic() ? 3 : Math.min(4, Math.round(0.1 / dlon))),
      };
    }
    return f._smooth;
  }

  /** 3×3 moving average repeated `passes` times (only for the lines, the colours stay those of the field): on fine
   *  grids (ICON 2 km) the isotherms follow every valley and become many little rings; this way they look like the classic charts. */
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

  /** Rounds the corners (Chaikin, two passes): coarse grids (GFS 0.25°) do not make stepped lines. */
  function smooth(pts, closed) {
    let p = pts;
    for (let it = 0; it < 1 && p.length > 2; it++) {
      // one pass: the lines stay on the colour edges
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
            // synoptic chart: white, thicker isobars above the solid colours, like on Meteociel
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

  /** Labels along the lines, at a fixed distance in pixels (recomputed on zoom), without overlapping. */
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
    // highlighted lines first, then the longest
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
    // panel and desktop bar: with an interval only the dates, without the month to fit on one row; otherwise
    // time and step ("ven 13 nov, 18:00 · +18h")
    const span = state.run && intervalStartDate(s);
    // without a run (field the model does not have) no dates: fmtShown needs the run
    const panelTime = !state.run ? "" : span ? fmtShown(s, { month: false }) : `${fmtShown(s)} · +${s}h`;
    ui.valid.classList.toggle("valid-span", !!span);
    ui.valid.textContent = panelTime;
    if (!state.run) {
      ui.range.textContent = "";
      // in the bar too (on mobile the panel is usually closed): field not provided or data not arrived yet
      const what = variable().models.includes(state.model)
        ? "nessun dato"
        : "non disponibile";
      // same structure as the normal bar: on mobile "non disponibile" instead of the time, the model on the right
      ui.badgeText.innerHTML =
        `<b class="badge-d">${modelLabel()}</b><span class="badge-run badge-d">${what === "nessun dato" ? "nessun dato" : "grandezza non disponibile"}</span>` +
        `<span class="badge-m badge-m-time"><b>${what}</b></span>` +
        `<span class="badge-m badge-m-model">${shortLabel(state.model)}</span>`;
      return;
    }
    const runText = `<strong>${state.run.slice(8, 10)}z</strong> ${state.run.slice(6, 8)}/${state.run.slice(4, 6)}`;
    syncIntervalSliders();
    // the accumulation of the image shown (during play too: with the chosen hours the last hours, not the whole range)
    const rangeStart = intervalPrev(s);
    const rangeEnd = s;
    const rangeLabel = rangeStart === 0
      ? `+${rangeEnd} ore`
      : `Da +${rangeStart}h a +${rangeEnd}h · ${rangeEnd - rangeStart}h`;
    // with an interval the start time too; on mobile without the month to fit on one row
    const mobileTime = fmtShown(s, { month: false });
    // with the start already written in the dates the duration is enough, so the row stays single
    const mobileRangeLabel = intervalStartDate(s)
      ? `${rangeEnd - rangeStart}h`
      : rangeStart === 0
        ? rangeLabel
        : `+${rangeStart}&ndash;${rangeEnd}h · ${rangeEnd - rangeStart}h`;
    const mobileRange = rangeMode()
      ? `<span class="badge-m-range">${mobileRangeLabel}</span>`
      : "";
    // desktop: model, run and time; mobile (badge-m): first the time, then short model and run
    ui.badgeText.innerHTML =
      `<b class="badge-d">${modelLabel()}</b><span class="badge-run badge-d">${runText}</span>` +
      `<span class="badge-valid badge-d">${panelTime}</span>` +
      `<span class="badge-m badge-m-time"><b>${mobileTime}</b>${mobileRange}</span>` +
      `<span class="badge-m badge-m-model">${shortLabel(state.model)} ${cycle(state.run)}</span>`;
    const mStep = $("m-step"); // bar slider on mobile, aligned with the panel's
    mStep.max = slideSteps().length - 1;
    mStep.value = slideSteps().indexOf(s);
    for (const r of [mStep, ui.step])
      r.style.setProperty("--pct", `${(100 * +r.value) / (+r.max || 1)}%`); // covered part
    // accumulations (interval or total): dates in the row above, steps and duration in the bottom bar and in the legend;
    // the UTC time remains only for instantaneous fields
    ui.range.textContent = state.mode === "interval" || state.mode === "total" ? "" : `${fmtUTC(valid)} UTC`;
    if (typeof renderLandscapeNav === "function") renderLandscapeNav(); // mini bar of the phone in landscape
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
    setLoading(true); // spinner in the time row: no text appearing and disappearing that shifts the panel
    dropStaleFetches();
    try {
      // combined entries: also the field of the lines, at the same time (if missing, only the colours)
      const cv = variable().contour_field;
      const load = () =>
        Promise.all([
          mainField(state.step),
          cv ? contourFieldAt(state.step).catch(() => null) : null,
          arrowsFieldAt(state.step).catch(() => null), // arrows of the combined entries (if missing, only the colours)
        ]);
      let got;
      for (let attempt = 0; ; attempt++) {
        try {
          got = await load();
          break;
        } catch (e) {
          // a request cancelled by dropStaleFetches right when it became useful again: redo it
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
      setStatus(""); // the median's models are already in the run row ("8 modelli")
      prefetch();
      if (hoverMq.matches && extras().length) loadExtras(); // for the tooltip (on touch only when opening a popup)
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

  // loading spinner: appears only if the wait exceeds 150 ms (with cached data it does not flash)
  let loadingTimer = null;
  // map loading: spinner in the panel and animated line on the time bar (on mobile the panel is
  // usually closed), only if the wait exceeds 150 ms (images already in memory make nothing flash)
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

  // ---------- favourite places: chosen by the user via search, saved in the browser (localStorage).
  // Each one has a numbered marker + value on the map and a row in the panel list.
  // Folders, like a file system with one level: at the top of the list the folders, then the places outside them;
  // a folder is entered (only its places, on the map too) and left with "‹". A place belongs to one folder (or to
  // none) from when it is added, with no moving (delete and add again); additions go into the open folder.
  // `allPlaces` is everything saved, `places` what is shown (markers, rows and ranking).
  const PLACES_KEY = "weathermaps.places.v1";
  // folders in their own key: an older page (still open in another tab, or the app not reloaded) saves only the
  // places, and keeps the "folder" of each one (it rewrites the objects as they are), so nothing is lost
  const FOLDERS_KEY = "weathermaps.folders.v1";
  const pointMarkers = [];
  const pointRows = [];
  let { places: allPlaces, folders, open: openFolder } = loadPlaces();
  let places = [];
  let editing = false;
  let naming = null; // id of the folder just created: its row shows the name field
  let confirmDelete = null; // id of the folder whose ✕ was pressed once: the second press deletes it

  /** Value of the nearest grid point (like the tooltip), null if outside the grid or missing. */
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
        // folders: added later (the places saved before have none and stay outside). In the places key in the
        // first version of the folders: read from there if their own key is not there yet
        let fd = null;
        try {
          fd = JSON.parse(localStorage.getItem(FOLDERS_KEY) || "null");
        } catch {
          /* corrupted: as if missing */
        }
        if (!Array.isArray(fd?.folders)) fd = d;
        const folders = (Array.isArray(fd.folders) ? fd.folders : []).filter(
          (f) => f && typeof f.id === "string" && typeof f.name === "string",
        );
        const ids = new Set(folders.map((f) => f.id));
        const places = d.places
          .filter(
            (p) =>
              p &&
              typeof p.name === "string" &&
              Number.isFinite(p.lat) &&
              Number.isFinite(p.lon),
          )
          .map((p) => (p.folder && !ids.has(p.folder) ? { ...p, folder: undefined } : p));
        return { places, folders, open: ids.has(fd.open) ? fd.open : null };
      }
    } catch {
      /* storage unavailable or corrupted data: start empty */
    }
    return { places: [], folders: [], open: null };
  }
  function savePlaces() {
    try {
      // still v1: the places stay readable by an older page (it ignores folders and shows them all)
      localStorage.setItem(PLACES_KEY, JSON.stringify({ v: 1, places: allPlaces }));
      localStorage.setItem(FOLDERS_KEY, JSON.stringify({ v: 1, folders, open: openFolder }));
    } catch {
      /* private browsing or full storage: changes last while you stay on the page */
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

  /** Rebuilds markers and list from `places` (after each addition, edit or deletion). */
  function setupPoints() {
    closePlacePop(); // indexes may change (deletion)
    places = allPlaces.filter((p) => (p.folder || null) === openFolder);
    renderFolders();
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
        // edit: renamable name instead of the text, delete button instead of the value
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
          allPlaces.splice(allPlaces.indexOf(p), 1);
          savePlaces();
          if (!openFolder && !allPlaces.some((q) => !q.folder)) editing = false;
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
    ui.placesEdit.hidden = !places.length && !openFolder && !folders.length; // folders, even empty: rename, delete
    // icon only (pencil, check when editing): more room for the search field
    ui.placesEdit.innerHTML = editing ? CHECK_ICON : PENCIL_ICON;
    ui.placesEdit.title = editing ? "Fine" : "Modifica";
    ui.placesEdit.setAttribute("aria-label", editing ? "Fine modifica" : "Modifica località e cartelle");
    ui.placesEdit.setAttribute("aria-pressed", String(editing));
    if (meta && variable()) renderPoints();
  }

  ui.placesEdit.addEventListener("click", () => {
    editing = !editing;
    confirmDelete = null;
    setupPoints();
  });

  const PENCIL_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
  const CHECK_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const FOLDER_ICON =
    // viewBox cropped around the drawing (x 2-22): the folder is about as wide as the 18px circle of the places
    '<svg width="18" height="18" viewBox="2 2.5 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';

  /** Above the list: the folders (outside them) or the open folder's header with "‹" (inside). */
  function renderFolders() {
    const box = ui.folders;
    box.replaceChildren();
    ui.folderNew.hidden = !!openFolder; // one level: folders only outside folders
    const row = (cls) => {
      const r = document.createElement("div");
      r.className = cls;
      box.append(r);
      return r;
    };
    if (openFolder) {
      const f = folders.find((x) => x.id === openFolder);
      // "..": back to the places outside folders, as in a file system
      const up = row("folder-row folder-up");
      up.innerHTML = '<span class="folder-dots">..</span>';
      up.title = "Torna alle località";
      up.setAttribute("role", "button");
      up.setAttribute("aria-label", "Torna alle località");
      up.tabIndex = 0;
      const back = () => {
        openFolder = null;
        editing = false;
        savePlaces();
        setupPoints();
      };
      up.addEventListener("click", back);
      up.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          back();
        }
      });
      // the open folder, then its places: same columns (icon/number, name)
      const r = row("folder-row folder-head");
      r.innerHTML = FOLDER_ICON;
      if (editing) r.append(nameInput(f), folderDelButton(f));
      else {
        const n = document.createElement("span");
        n.className = "folder-name";
        n.textContent = f.name;
        r.append(n);
      }
      if (!places.length) {
        // inside the folder like its places: text in the names' column
        const h = row("folder-row folders-hint");
        h.innerHTML = "<span></span><span></span>";
        h.lastChild.textContent = "La cartella è vuota";
      }
      return;
    }
    for (const f of folders) {
      const n = allPlaces.filter((p) => p.folder === f.id).length;
      const r = row("folder-row");
      r.innerHTML = FOLDER_ICON;
      if (editing || naming === f.id) {
        r.append(nameInput(f));
        if (editing) r.append(folderDelButton(f));
        continue;
      }
      r.insertAdjacentHTML("beforeend", `<span class="folder-name"></span><span class="folder-n">${n}</span><span class="folder-go" aria-hidden="true">›</span>`);
      r.querySelector(".folder-name").textContent = f.name;
      r.title = `Apri ${f.name}`;
      r.setAttribute("role", "button");
      r.tabIndex = 0;
      const enter = () => {
        openFolder = f.id;
        savePlaces();
        setupPoints();
      };
      r.addEventListener("click", enter);
      r.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          enter();
        }
      });
    }
  }

  /** ✕ of a folder (in the list or in its header when open): the second press deletes it with its places. */
  function folderDelButton(f) {
    const n = allPlaces.filter((p) => p.folder === f.id).length;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "folder-del" + (confirmDelete === f.id ? " confirm" : "");
    del.textContent =
      confirmDelete === f.id ? (n ? `Elimina con ${n === 1 ? "1 località" : `${n} località`}` : "Elimina") : "✕";
    del.setAttribute("aria-label", `Elimina la cartella ${f.name}`);
    del.addEventListener("click", () => {
      if (confirmDelete !== f.id) {
        confirmDelete = f.id;
        renderFolders();
        return;
      }
      allPlaces = allPlaces.filter((p) => p.folder !== f.id);
      folders = folders.filter((x) => x.id !== f.id);
      if (openFolder === f.id) openFolder = null; // deleted from inside: back outside folders
      confirmDelete = null;
      if (!folders.length && !allPlaces.length) editing = false;
      savePlaces();
      setupPoints();
    });
    return del;
  }

  /** Field with the folder's name: saved on change; the new folder's field closes with Enter or on leaving it. */
  function nameInput(f) {
    const input = document.createElement("input");
    input.className = "pt-name pt-rename";
    input.value = f.name;
    input.maxLength = 40;
    input.setAttribute("aria-label", `Nome della cartella ${f.name}`);
    const commit = () => {
      const name = input.value.trim();
      if (name) f.name = name;
      else input.value = f.name;
      savePlaces();
    };
    input.addEventListener("change", commit);
    if (naming === f.id) {
      const done = () => {
        if (naming !== f.id) return;
        commit();
        naming = null;
        setupPoints();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") done();
      });
      input.addEventListener("blur", done);
    }
    return input;
  }

  ui.folderNew.addEventListener("click", () => {
    // new empty folder at the top of the list, with its name to write
    const id = Date.now().toString(36);
    folders.unshift({ id, name: "Nuova cartella" });
    naming = id;
    savePlaces();
    setupPoints();
    // focus right away, inside the tap: iOS opens the keyboard only then (not in a later frame)
    const input = ui.folders.querySelector(".pt-rename");
    input?.focus();
    input?.select();
  });

  /** false if there is already a place there (from search). custom: point chosen on the map, always added. */
  function addPlace(name, lat, lon, custom = false, folder = openFolder) {
    // into another folder than the open one: that folder opens, so the new marker is seen
    if (folder !== openFolder) {
      openFolder = folder;
      editing = false;
      setupPoints();
    }
    // the same place can be in more than one folder (and outside), not twice in the same one
    if (
      !custom &&
      places.some(
        (p) => Math.abs(p.lat - lat) < 0.005 && Math.abs(p.lon - lon) < 0.005,
      )
    ) {
      toast(`${name} è già fra le località.`);
      return false;
    }
    allPlaces.push({
      id: Date.now().toString(36),
      name,
      lat: +lat.toFixed(4),
      lon: +lon.toFixed(4),
      ...(folder ? { folder } : {}), // into the chosen folder (the open one by default)
    });
    savePlaces();
    setupPoints();
    return true;
  }

  // search: Open-Meteo (GeoNames) and, as a fallback, Photon (OpenStreetMap), limited to the map area and to inhabited
  // places (cities, villages, hamlets), peaks and passes: without a filter "Sondrio" would also return streets, stations and the province.
  let searchTimer = null;
  let searchCtl = null;
  // the result list lives outside the panel (which scrolls and would clip it): in body, fixed position below the
  // search field (above if there is no room below), at most as tall as the free space in the window
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
    el.style.maxHeight = `${Math.max(80, Math.min(down ? below : above, 236))}px`; // about 5 results, then it scrolls
    el.style.top = down ? `${r.bottom + GAP}px` : "";
    el.style.bottom = down ? "" : `${window.innerHeight - r.top + GAP}px`;
  }
  window.addEventListener("resize", placeResults);
  ui.placeQ.closest(".panel-body")?.addEventListener("scroll", placeResults);
  window.visualViewport?.addEventListener("resize", placeResults); // phone keyboard

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
    // first Open-Meteo (GeoNames: cities, villages, peaks and passes; answers in under a second), then Photon if it
    // finds nothing or does not answer (OpenStreetMap, more complete but often very slow: even 40-50 seconds)
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
    // a waiting state right away: spinner in the field and "Ricerca…" in the list (Open-Meteo answers in a few tenths)
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
    if (pointMarkers.length !== pts.length) return; // at startup before setupPoints: it draws them
    if (state.extra !== "none" || synoptic()) {
      // radar or satellite: places only help with orientation, no model values (on the 500 hPa chart
      // they are hidden, see body.synoptic-mode .pt in style.css)
      pts.forEach((p, i) => {
        const el = pointMarkers[i].getElement();
        if (el) {
          el.querySelector(".pt-val").textContent = p.name; // on the map the name instead of the value
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
      ui.points.append(...pointRows); // in the order they were added, without ranking
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
      const text = v == null ? "" : v.toFixed(dec); // without a value no dashes: the label is hidden
      const c = v == null ? null : color(v);
      const el = pointMarkers[i].getElement();
      if (el) {
        // on the map with the symbol attached (2575m, 8.2°C): compact but unambiguous
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
      const pv = pointRows[i].querySelector(".pt-v"); // when editing, the delete button is in its place
      if (pv) pv.textContent = v == null ? "" : `${text} ${current.units}`;
      const n = pointRows[i].querySelector(".pt-num");
      n.style.background = c ? `rgb(${c.join(",")})` : "";
      n.classList.toggle(
        "pt-dark",
        !!c && c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 140,
      );
      values[i] = v;
    });
    // ranking: from the highest value; ties get the same position (1, 2, 2, 4), the "—" at the end without a number.
    // The rounded values as shown are compared, so two "2.4" have the same position.
    const shown = values.map((v) =>
      v == null ? null : Number(v.toFixed(dec)),
    );
    // direction from the field: "desc" = highest first (precipitation), "asc" = lowest first (temperature)
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
      // the top-ranked above the others if the markers touch
      pointMarkers[i].setZIndexOffset((order.length - pos) * 10);
    });
    ui.points.append(...order.map((i) => pointRows[i]));
    pointOrder = order;
    placePointLabels();
    renderPlacePop();
  }

  // ---------- place popup (click on the circle or on the list row): name, values, ranking, time.
  // Only one at a time; above the circle, below if there is no room above, always inside the window.
  const pop = document.createElement("div");
  pop.className = "pt-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  document.body.append(pop);
  let popIdx = null;
  const detailFields = new Map(); // detail fields already downloaded (null = not available)
  const POP_MARGIN = 8; // minimum distance from the window edges
  const POP_GAP = 16; // distance from the circle centre to the arrow tip

  // clicking a place always opens the same popup with the values (on the 500 hPa chart too); from there the time chart
  // and, if the chosen model has the ensemble (GFS, ECMWF), the spaghetti
  // phone in landscape: places and point menu are tapped as in portrait (to open the charts; if they
  // look bad you rotate the phone); no value tooltip on tap
  const landscapeView = () => document.body.classList.contains("landscape-view");
  function openPlacePop(idx) {
    if (synoptic()) return; // on the 500 hPa chart places are not shown
    if (state.extra !== "none") return; // with radar or satellite the model values popup is not needed
    popIdx = idx;
    ui.probe.hidden = true;
    probeLL = null; // with the popup open no value tooltip
    renderPlacePop();
  }
  function closePlacePop() {
    popIdx = null;
    pop.hidden = true;
    markPoppedPoint();
  }
  // the place's white label is hidden while the popup is open (same value, it would be a duplicate)
  function markPoppedPoint() {
    pointMarkers.forEach((m, i) =>
      m.getElement()?.classList.toggle("pt-popped", i === popIdx),
    );
  }

  // short name for the second tooltip line
  const SHORT = { z850: "quota 850" };
  /** Extra fields of the field shown (`details`, e.g. the height of 850 hPa on the T850 map): in the
   *  place popup and in the second tooltip line; downloaded with the time shown and kept in detailFields. */
  const extras = () => variable()?.details || [];
  const extraKey = (d) => `${state.model}|${state.run}|${d.var}|${state.step}`;
  function loadExtras() {
    for (const d of extras()) {
      const key = extraKey(d);
      if (detailFields.has(key)) continue;
      detailFields.set(key, undefined); // arriving
      const step = state.step;
      getField(step, "value", { ...ctxNow(), var: d.var })
        .catch(() => null)
        .then((f) => {
          detailFields.set(key, f);
          if (popIdx != null && state.step === step) renderPlacePop();
        });
    }
  }
  /** Formatted value of an extra field at the point: undefined = still arriving, null = not available. */
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
    // extra fields (on the T850 map the height of the 850 hPa surface)
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
        .join("") + // without a value the row is not there
      (foot ? `<div class="pt-pop-foot">${esc(foot)}</div>` : "") +
      // side-by-side buttons: time chart and, if the model has the ensemble, the spaghetti
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

  /** Position: centred on the point, above (or below), shifted sideways as much as needed to stay in the window. */
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
    // point outside the window: no popup hanging in mid-air
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
    // the arrow stays on the point even when the popup is shifted sideways
    pop.querySelector(".pt-pop-arrow").style.left =
      `${Math.min(Math.max(x - left, 12), w - 12)}px`;
  }
  map.on("move zoom", placePlacePop);
  map.on("click", closePlacePop);
  window.addEventListener("resize", placePlacePop);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePlacePop();
  });

  // ---------- position of the place labels: on the right if there is room, otherwise left, above or below;
  // if no side is free the value is hidden (the number stays; the value is in the list and the tooltip).
  // Chosen in ranking order: the first ones have precedence.
  let pointOrder = [];
  const PT_SIDES = ["right", "left", "above", "below"];
  const PT_R = 12; // circle radius (with the border)
  const PT_GAP = 18; // label distance from the centre (as in the CSS: 29px from the edge of the 22px marker)
  function placePointLabels() {
    const overlaps = (a, b) =>
      a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    const items = pointMarkers.map((m) => {
      const el = m.getElement();
      if (!el) return null;
      el.classList.remove("pt-noval"); // to be measured the label must be visible
      const c = map.latLngToContainerPoint(m.getLatLng());
      const val = el.querySelector(".pt-val");
      return { el, c, w: val.offsetWidth, h: val.offsetHeight };
    });
    // obstacles: all circles, then one by one the labels already placed
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

  // ---------- sharing: image of the map being viewed
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
  // places in the image: decided in the share dialog (the choice stays for the next openings)
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

  /** Splits a text into lines that fit in `maxWidth` (with the font already set on ctx). */
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

  // Shared image: the visible map is captured and in the modal the crop is chosen, a frame
  // with fixed proportions over the whole area (veiled outside). Header, points, legend and credits are
  // drawn over the crop at a fixed size and are already visible inside the frame.
  const RATIOS = {
    "4:3": [1600, 1200],
    "1:1": [1200, 1200],
    "16:9": [1600, 900],
  };
  const MIN_FRACTION = 0.25; // smallest frame: a quarter of the maximum width (beyond that it gets grainy)
  const PT_SCALE = 1.5; // size of markers and values in the image relative to the screen
  const FRAME_PAD = 16; // margin around the fixed frame in the modal
  const outCanvas = document.createElement("canvas"); // final image

  /** Visible map in a canvas (at 2–3× to allow zooming) and points in screen coordinates. */
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
      // Mapbox basemap with colours, borders and names: the copy made by glCapture
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
      // radar or satellite above the map, as in the page
      ctx.globalAlpha = extraCfg().opacity;
      const shown = radarFrames[radarIdx]?.layer.getElement?.();
      if (shown) drawImg(shown, extraCfg().opacity);
      ctx.globalAlpha = 1;
    }
    // isotherms: the lines canvas and the labels (text with a white halo, as on screen)
    const bordersCanvas = map.getPane("borders").querySelector("canvas");
    if (bordersCanvas && bordersOn() && !glBase) {
      // with Mapbox the borders are already in its canvas
      const r = bordersCanvas.getBoundingClientRect();
      ctx.globalAlpha = state.bordersOpacity; // as in the page
      ctx.drawImage(
        bordersCanvas,
        r.left - cr.left,
        r.top - cr.top,
        r.width,
        r.height,
      );
      ctx.globalAlpha = 1;
    }
    // synoptic chart: coastlines and countries are our own lines with Mapbox too (see styleSynBorders)
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
      // black shadow under the white labels of the synoptic chart, light halo under the dark ones
      ctx.strokeStyle = synoptic() ? "rgba(0,0,0,0.9)" : "rgba(255,255,255,0.9)";
      ctx.lineJoin = "round";
      ctx.strokeText(el.textContent, x, y);
      ctx.fillStyle = cs.color;
      ctx.fillText(el.textContent, x, y);
    }
    // points: circle centre and position of the value relative to the centre (as on screen)
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

  /** Image texts and file name, computed once on opening. */
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
      // radar or satellite: the image is of the extra layer (time of the image shown), with its legend
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
      // OpenStreetMap attribution is mandatory on images too
      attr: `${baseAttr} · Dati: NOAA, ECMWF, ItaliaMeteo, CIMA, LaMMA, DWD, Météo-France, MeteoSvizzera · ${location.host}${location.pathname}`,
      name: `weathermaps-${state.model}-${state.var}-${state.run}-${String(s).padStart(3, "0")}.jpg`,
    };
  }

  // crop in coordinates of the captured map (screen px); the height follows the proportions
  // touched = the user has already moved or resized the frame (the GPS position no longer moves it)
  const crop = {
    snap: null,
    texts: null,
    ratio: "4:3",
    x: 0,
    y: 0,
    w: 0,
    touched: false,
    fixed: false, // 500 hPa chart: fixed framing (like Meteociel), no proportions, zoom or dragging
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

  /** Resizes the frame by `factor` keeping the map point (mx, my) still. */
  function scaleCropAt(
    factor,
    mx = crop.x + crop.w / 2,
    my = crop.y + cropH() / 2,
  ) {
    // already at maximum and still zooming out: the map under the frame is widened (zoom out and new capture)
    if (factor > 1 && crop.w >= maxCropW() - 0.5) {
      widenShare(factor);
      return;
    }
    // zooming out beyond the maximum: the frame reaches the maximum and the rest becomes a zoom-out of the map
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

  /** Final image: map crop + points + header + legend and credits. */
  function renderOut() {
    const [OW, OH] = RATIOS[crop.ratio];
    const ctx = outCanvas.getContext("2d");
    const { snap, texts } = crop;
    const s = OW / crop.w; // image px per map px
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

    // points at a fixed size
    const k = PT_SCALE;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // with radar and satellite places have the name instead of the value (as on the map)
    // sharing a point from the map menu shows only that one, never the places
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
        // small triangle pointing at the circle (as on screen)
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

    // point chosen from the map menu: marker and, above it, the value (outside the frame it is not drawn)
    if (snap.pin) {
      const k = PT_SCALE,
        px = (snap.pin.x - crop.x) * s,
        py = (snap.pin.y - crop.y) * s;
      if (px >= 0 && px <= OW && py >= 0 && py <= OH) {
        if (crop.pinText) {
          // as large as the header subtitle (22px): the image is 1600px wide and is viewed scaled down
          ctx.font = `650 ${15 * k}px ${FONT}`;
          const bw = ctx.measureText(crop.pinText).width + 22 * k,
            bh = 30 * k,
            t = 7 * k;
          const bx = Math.min(Math.max(px - bw / 2, 6), OW - bw - 6);
          const below = py - 14 * k - t - bh < 6; // too high: the label goes below
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
        // as on the map: white centre, dark ring and white halo (visible on any colour)
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

    // header top left: flag, model and run, field and time
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    // model flag (already loaded, see loadFlag); with radar or satellite the image is not the model's: none
    const flag = state.extra === "none" ? crop.flag : null;
    const fh = 26,
      fw = flag
        ? Math.round(fh * (flag.naturalWidth / flag.naturalHeight || 4 / 3))
        : 0;
    const fx = flag ? fw + 12 : 0; // space taken by the flag before the title
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
        // flags: thin grey border as in the select (white does not get lost in the background)
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

    // bottom band: legend and credits
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
    // the bar stops before "Realizzato da signalkuppe.com" (on the right on the same row)
    ctx.font = `700 15px ${FONT}`;
    let creditW = ctx.measureText("signalkuppe.com").width;
    ctx.font = `400 15px ${FONT}`;
    creditW += ctx.measureText("Realizzato da ").width;
    const cw = Math.min(64, (OW - lx - 24 - creditW - 32) / nseg);
    const ly = OH - BAND + 16;
    const every = thresholds.length > 14 ? 2 : 1; // as in the page legend
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
      // precipitation and radar start from 0, as in the page legend
      const zero = i === 0 && (t === 0.1 || texts.v.units === "mm/h");
      if (!skip)
        ctx.fillText(
          zero ? "0" : String(t).replace("-", "−"),
          lx + i * cw,
          ly + 36,
        );
    });
    // author bottom right, on the legend row (the bar reaches ~900 px at most)
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

  // view in the modal: fixed frame in the centre (the largest that fits in the space), below it the captured map
  // that moves and zooms; outside the frame the map stays visible but veiled.
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
  const viewScale = () => view.fw / crop.w; // view px per map px
  function renderView() {
    if (shareUi.dialog.classList.contains("share-preparing")) return; // capture not ready yet
    renderOut();
    const ctx = shareUi.canvas.getContext("2d");
    const { snap } = crop;
    const fs = viewScale();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.cw, view.ch);
    ctx.imageSmoothingQuality = "high";
    if (crop.fixed) {
      // fixed framing: only the final image, without the map around it or the crop frame
      ctx.drawImage(outCanvas, view.fx, view.fy, view.fw, view.fh);
      return;
    }
    // whole map at the same scale as the frame, so the context is visible outside
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
    // the file is regenerated once the gesture is over, so "Condividi" already has the image ready
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

  // model flag for the image header: the same flag-icons SVG used in the page (read from the
  // CSS), for the median the "layers" icon; loaded once per model
  const flagCache = new Map();
  function loadFlag(modelId, ink = "#1d2330") {
    // ink: colour of the median icon
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
              img.crossOrigin = "anonymous"; // without it the canvas would become "tainted" and could not be exported
              if (border) img.dataset.border = "1";
              img.onload = () => resolve(img);
              img.onerror = () => resolve(null);
              img.src = url;
            }),
      );
    }
    return flagCache.get(key);
  }

  // map view when sharing opens: if from the dialog you zoom out beyond the map you were
  // viewing, the map widens underneath (zoom out) and on closing it goes back to where it was
  let shareRestore = null,
    widening = false,
    widenMore = 1; // widenMore: zoom-outs requested during a capture
  /** Waits until Mapbox (or the tiles) has drawn the new view, at most 2 s, plus a couple of frames for
   *  Leaflet's lines and places. */
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
    // point chosen from the map menu: position in the capture (changes if the capture widens, see widenShare)
    crop.snap.pin = crop.pinLL ? map.latLngToContainerPoint(crop.pinLL) : null;
  }
  /** Zoom out under the frame: the map moves out one level around the frame centre, the capture is redone
   *  and the frame covers the same area as before (then `factor` wider). */
  async function widenShare(factor) {
    if (widening) {
      widenMore *= factor;
      return;
    } // applied as soon as the current capture is done
    if (map.getZoom() <= map.getMinZoom() + 0.01) return;
    widening = true;
    try {
      const center = map.containerPointToLatLng([
        crop.x + crop.w / 2,
        crop.y + cropH() / 2,
      ]);
      const zoom = Math.max(map.getMinZoom(), map.getZoom() - 1);
      const shrink = map.getZoomScale(zoom, map.getZoom()); // < 1: how much the same area shrinks
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

  /** pin: { latlng, text } from the map menu: marker and value label in the image */
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
    // start from the map as you are viewing it (same area and zoom): no device location
    shareRestore = null;
    widenMore = 1;
    crop.fixed = synoptic();
    shareUi.dialog.classList.toggle("share-fixed", crop.fixed);
    if (crop.fixed) {
      // 500 hPa chart: the map below is resized and moved for the fixed framing; the dialog opens
      // right away (with "Preparazione…") so the map is not seen moving
      shareUi.dialog.classList.add("share-preparing");
      if (!shareUi.dialog.open) shareUi.dialog.showModal();
    }
    await shareWideStart();
    if (crop.fixed && !shareWide) {
      // 500 hPa chart: the map shows the whole fixed framing; on closing it goes back to where it was
      shareRestore = { center: map.getCenter(), zoom: map.getZoom() };
      map.fitBounds(SYN_FRAME, { animate: false });
      await mapReady();
    }
    await takeSnap();
    crop.texts = shareTexts();
    // on opening the largest frame that fits in the map, centred (the proportion stays the last one chosen)
    if (crop.fixed && crop.ratio !== "16:9") {
      crop.savedRatio = crop.ratio; // found again at the next sharing of the other maps
      crop.ratio = "16:9";
    }
    [outCanvas.width, outCanvas.height] = RATIOS[crop.ratio];
    crop.w = maxCropW();
    const c = crop.snap.pin || { x: crop.snap.W / 2, y: crop.snap.H / 2 };
    crop.x = c.x - crop.w / 2;
    crop.y = c.y - cropH() / 2;
    if (crop.fixed) {
      // 16:9 frame as wide as the fixed framing, vertically centred on it
      const nw = map.latLngToContainerPoint(SYN_FRAME.getNorthWest()),
        se = map.latLngToContainerPoint(SYN_FRAME.getSouthEast());
      crop.w = se.x - nw.x;
      crop.x = nw.x;
      crop.y = (nw.y + se.y) / 2 - cropH() / 2;
    }
    clampCrop();
    crop.touched = false;
    shareUi.pointsRow.hidden = !crop.snap.points.length || !!crop.pinLL;
    // places: with the model maps on (values), off with radar and satellite (they can be turned on with the switch)
    shareUi.points.checked = state.extra === "none" && !synoptic();
    if (crop.fixed && !shareUi.dialog.open) return; // closed while getting ready (the map is already back where it was)
    shareUi.dialog.classList.remove("share-preparing");
    if (!shareUi.dialog.open) shareUi.dialog.showModal();
    layoutView();
    setRatio(crop.ratio);
  }

  // on closing (X, Esc, after sharing) the map goes back to where it was, if you zoomed out in the dialog
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

  // Synoptic chart: with the share dialog open the map, hidden below, becomes 1600×900 and is framed
  // on SYN_FRAME, on any screen; on closing it goes back as it was.
  let shareWide = null;
  // framing of the 500 hPa chart image, like Meteociel: from Newfoundland to the Black Sea, from North Africa
  // to Iceland (Italy on the right), 16:9
  // further south than the "geographic" centre: at the bottom the image has the colour bar and credits over the map
  // (~12% of the height), which would cover the Mediterranean; the 16:9 takes ~25–66 N
  const SYN_FRAME = L.latLngBounds([26, -60], [66, 40]);
  async function shareWideStart() {
    if (!synoptic()) return;
    // always the same 1600×900 map under the dialog (any screen): the fixed framing fits entirely and
    // the image comes out the same on phone and desktop
    shareWide = { center: map.getCenter(), zoom: map.getZoom() };
    const root = document.documentElement.style;
    root.setProperty("--share-w", "1600px");
    root.setProperty("--share-h", "900px");
    document.body.classList.add("share-wide");
    map.invalidateSize({ pan: false });
    glBase?.resize();
    updateMinZoom();
    // two passes: the first fit can be shifted by the sync with Mapbox after the size change
    // (it happened starting from a narrow screen: Italy ended up out at the bottom)
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

  // device location: no longer used (it used to centre the shared image); remove the one saved by
  // earlier versions
  try {
    localStorage.removeItem("weathermaps.pos.v1");
  } catch {
    /* storage unavailable */
  }
  new ResizeObserver(() => {
    if (shareUi.dialog.open && crop.snap) {
      layoutView();
      scheduleRender();
    }
  }).observe(shareUi.canvas);

  function closeShare() {
    if (shareUi.dialog.open) shareUi.dialog.close(); // immediate close, without animation
  }

  // gestures on the map under the frame: dragging moves it, pinch and wheel zoom it
  // (= smaller frame on the map, more detail)
  const pointers = new Map();
  let pinch = null;
  const toView = (e) => {
    const r = shareUi.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** Point of the captured map under a point of the view. */
  const viewToMap = ([vx, vy]) => [
    crop.x + (vx - view.fx) / viewScale(),
    crop.y + (vy - view.fy) / viewScale(),
  ];
  shareUi.canvas.addEventListener("pointerdown", (e) => {
    if (crop.fixed) return; // fixed framing
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
      // wheel forward = bigger map (more detail)
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
    shareUi.toast.classList.toggle("warn", warn); // notice: warning colours
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

  /** Native sharing of the file only (phone: menu with WhatsApp and other apps); otherwise it downloads it. */
  async function sendShare() {
    await readyShareFile();
    // only the image, without text or link: model, run and time are already written on it
    const data = { files: [shareFile] };
    if (navigator.canShare?.(data)) {
      try {
        await navigator.share(data);
        return true;
      } catch (e) {
        if (e.name === "AbortError") return true; // cancelled by the user
        if (e.name !== "NotAllowedError") throw e;
        return false; // gesture expired: retry from the preview button
      }
    }
    // browser without file sharing (mostly desktop): the image is downloaded
    await downloadShareFile();
    toast("Immagine scaricata: allegala dove vuoi condividerla.");
    return true;
  }

  shareUi.btn.addEventListener("click", async () => {
    const pin = shareUi.btn.pin; // point from the map menu (see openMapMenu), for this click only
    shareUi.btn.pin = null;
    if (!current) {
      toast("Niente da condividere: scegli un istante con dati.");
      return;
    }
    shareUi.btn.disabled = true;
    setLoading(true);
    try {
      // modal with crop: the click on "Condividi" is a new gesture, valid for native sharing
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

  // ---------- meteogram of a place: the chosen model's fields over time. Always the same
  // four (precipitation, T850, freezing level, 10 m wind), those the model does not have are skipped. One panel per
  // field (never two scales on the same chart), same time axis; precipitation as bars per interval,
  // the others as lines; local time on the axis, the time shown on the map dashed, values read on hover.
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
  let chartPin = null; // time (step) pinned with a click or a tap: it stays visible and goes into the shared image
  let clearChartPin = () => {}; // set by drawChart: removes the pinned time (line, box and tooltip)
  // Esc with a pinned time removes only that; without, it closes the chart as usual
  chartUi.dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && chartPin != null) {
      e.preventDefault();
      clearChartPin();
    }
  });
  // same margin on all sides (like --cm in style.css): on the left it matches the space of the axis numbers,
  // so the dialog title and the chart titles start at the same distance from the edge that the charts have on the right
  const CHART_AXIS = 40; // space for the axis numbers inside the SVG, left of the chart
  const CLIM_RED = "#ef4444"; // climatology in the spaghetti
  const SNOW_BAR = "#a78bfa"; // snow part of the precipitation bars in the meteograms
  const OFFICIAL = "#22c55e"; // green of the official (operational) run in the spaghetti
  const CHART_MAX_PH = 280; // maximum height of a panel on screen: beyond that the curves stretch without saying more
  const CHART_R = 30; // inside the SVG, on the right: the precipitation accumulation scale and the last time on the axis
  chartUi.close.addEventListener("click", () => chartUi.dialog.close());

  /** Series at the point: from the server (api/series) or, on the static site, from the tiles that contain it (app/series.py):
   *  precipitation and snow from the nearest model cell, the same one the map tooltip reads (valueAt), the
   *  rest from a regular grid. */
  async function getSeries(model, run, lat, lon) {
    if (!STATIC) {
      const r = await fetch(
        `api/series?${new URLSearchParams({ model, run, lat, lon })}`,
      );
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    }
    const grids = (runs[model] || []).find((e) => e.run === run)?.series; // grids of the run, from runs.json
    if (!grids) throw new Error("serie non disponibile per questa corsa");
    const out = { lat, lon, vars: {} };
    await Promise.all(
      Object.entries(grids).map(async ([name, g]) => {
        const iy = Math.round((lat - g.lat0) / g.dlat),
          ix = Math.round((lon - g.lon0) / g.dlon);
        if (iy < 0 || ix < 0 || iy >= g.ny || ix >= g.nx) return; // outside the model domain
        const ty = Math.floor(iy / g.block),
          tx = Math.floor(ix / g.block);
        const r = await fetch(`data/series/${model}/${run}/${name}/${ty}_${tx}.bin`);
        if (r.status === 404) return; // tile entirely outside the domain: it does not exist
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

  /** T850 climatology (scripts/make_climate.py): for each chart time the 1991-2020 mean of that day
   *  of the year and that hour (00/06/12/18 UTC) at the point (interpolated between the 2.5° nodes). Null if the file is missing: the chart is drawn anyway. */
  let climFile = null;
  async function climT850(lat, lon, t0, steps) {
    climFile ??= fetch("clim-t850.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const c = await climFile;
    if (!c?.hours) return null; // file missing or in a different format: chart without climatology
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
    // day of the year (0..364) and synoptic hour (0..3 = 00/06/12/18 UTC) of a time
    const slotOf = (ms) => {
      const d = new Date(ms);
      const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
      let day = Math.floor((ms - jan1) / 864e5);
      const leap = new Date(Date.UTC(d.getUTCFullYear(), 1, 29)).getUTCMonth() === 1;
      if (leap && day >= 59) day -= 1; // 29 February counts as the 28th (the climatology has 365 days)
      return [Math.min(day, 364), Math.floor(d.getUTCHours() / 6)];
    };
    // between two synoptic hours it is interpolated (the spaghetti steps are already every 6 hours, so it is usually exact)
    return steps.map((s) => {
      const ms = t0 + s * 3600e3,
        base = Math.floor(ms / 216e5) * 216e5,
        w = (ms - base) / 216e5;
      const a = at(...slotOf(base));
      return w ? a * (1 - w) + at(...slotOf(base + 216e5)) * w : a;
    });
  }

  /** Ensemble spaghetti of a model at the nearest point: from the server or, on the static site, from the point's file. */
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
      // sounding: station and launch
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
      ensemble = false, // GFS ensemble spaghetti (synoptic chart) instead of the meteogram
      multi = null, // "tp" (accumulated) or "t850": all models and the median compared
    } = {},
  ) {
    chartUi.title.textContent = p.name;
    // model comparison: no model choice, in its place Precipitazione / T 850 hPa
    chartUi.model.hidden = !!multi;
    chartUi.multi.hidden = !multi;
    chartUi.sounding.hidden = true;
    chartUi.dialog.classList.remove("side-panel"); // the model charts full screen
    if (multi) {
      chartContext = { place: p, model: "mean", run: null, from: 0, until: 384, multi };
      writeChartHash(pushHistory && !chartUi.dialog.open);
      if (!chartUi.dialog.open) chartUi.dialog.showModal();
      chartUi.dialog.focus();
      await loadChart("mean");
      return;
    }
    if (ensemble)
      // spaghetti: only the models with the ensemble (GFS, ECMWF)
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
  /** Safety net: if the chart's total differs a lot from the map's for the same thing (same model and run, precipitation
   *  or snow since the start of the run), a notice says so, with the point the chart used. Precipitation and snow now
   *  come from the same model cell as the map (app/series.py), so it should not appear any more. */
  function chartPointWarning(series, request, model, run) {
    const v = dataVar();
    const sv = series.vars?.[v];
    if (!current || !sv || !["tp", "sf"].includes(v) || state.model !== model || state.run !== run) return;
    if (!rangeMode() || intervalPrev() !== 0) return; // only the total since the start of the run is comparable
    const i = sv.steps.indexOf(state.step);
    const onChart = i >= 0 ? sv.values[i] : null;
    const onMap = valueAt(current, request.place.lat, request.place.lon);
    if (onChart == null || onMap == null) return;
    const diff = Math.abs(onMap - onChart);
    if (diff < 2 || diff < 0.1 * Math.max(onMap, onChart)) return; // beyond 10% (and at least 2 mm or 2 cm)
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
    // short line always visible; the explanation opens when tapped (closed on desktop too)
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
      ? meta.ensemble?.[model]?.run // spaghetti: the latest complete run of the model's ensemble
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
        // operational run of the same cycle, downloaded with the ensemble over its whole range (app/ensemble.py)
        const op = ens.op && { t850: ens.op.t850, tp: ens.op.tp };
        chartData = { ensemble: ens, clim, op, model, run, from: 0, until: 384 };
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
    // period as dates, as in the map bar (the steps refer to the run chosen here)
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
      // no value at the point (e.g. while the model is updating): notice instead of an empty chart
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
      // with a new run incoming the reason is almost always the update: say so clearly
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

  // ---------- meteogram sharing: 1080 px wide image (from a phone too) with place, model and run
  // at the top, credits at the bottom; then like the map image (phone menu, otherwise download)
  /** Colours of the page's current theme (light or dark), for an image identical to the one in the browser. */
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
    }; // precipitation accumulation
  }
  const WARN_AMBER = "#f59f00"; // notice next to a panel title: same amber as .chart-warn
  const chartCss = (c) =>
    [
      // the page classes do not apply inside an image: same styles and colours
      `.ch-title{font:650 12.5px system-ui,sans-serif;fill:${c.fg}}.ch-note{font-weight:400;font-size:11.5px;fill:${c.muted}}.ch-leg{font:400 11.5px system-ui,sans-serif;fill:${c.muted}}.ch-leg tspan{font-weight:650;fill:${c.fg}}`,
      `.ch-tick{font:11px system-ui,sans-serif;fill:${c.muted}}.ch-grid{stroke:${c.line};stroke-width:1}`,
      `.ch-info-bg{fill:${c.bg}}.ch-info{fill:${WARN_AMBER};fill-opacity:.12;stroke:${WARN_AMBER};stroke-opacity:.55;stroke-width:1}`,
      `.ch-info-text{font:11.5px system-ui,sans-serif;fill:${c.fg}}`,
      `.ch-day{stroke:${c.line};stroke-width:1;stroke-dasharray:3 3}`,
      `.ch-zero{stroke:${c.muted};stroke-width:1}text{font-variant-numeric:tabular-nums}`,
      `.ch-pin{stroke:${c.fg};stroke-width:1.5;opacity:.75}.ch-pin-dot{stroke:${c.bg};stroke-width:2}`,
      `.ch-pin-bar{stroke:${c.fg};stroke-width:1.5}`,
      `.ch-acc{stroke:${c.acc}}.ch-acc-area{fill:${c.acc};fill-opacity:.1}.ch-acc-tick{fill:${c.acc}}`,
      `.ch-ens-mean{stroke:${c.fg}}.ch-ens-op{stroke:${OFFICIAL}}.ch-ens-ctl{stroke:${c.fg}}.ch-ens-halo{stroke:${c.bg}}`,
    ].join("");
  async function makeChartFile() {
    const { model, run } = chartData;
    const title = chartUi.title.textContent;
    const subtitle = chartData.ensemble || chartData.multi || chartData.sounding
      ? chartUi.details.textContent // already says "Ensemble GFS/ECMWF" or "Modelli a confronto"
      : `${meta.models.find((entry) => entry.id === model)?.label || model} · ${chartUi.details.textContent}`;
    // 4:5 portrait image (2160 × 2700 px): full format on Instagram, whole in chats; the panels stretch.
    // Drawn on 600 × 750 points scaled up 3.6 times: texts and lines in proportion as in the page on the phone
    // (on 1080 points, shrunk on screen, everything looked tiny)
    const OW = 600,
      OH = 750,
      M = 28,
      K = 3.6,
      FOOT = 30; // sizes, margin, scale, space for "Realizzato da" at the bottom
    const EW = OW - 2 * M + CHART_R; // SVG width (on the right its inner margin replaces M)
    const TOP = M + 78; // title, subtitle and space before the charts
    const PB = { pad: 10, line: 19, font: 13 }; // pinned time box
    // value rows of the box: one per chart
    const pbLines = (pb) => (pb.table ? pb.table.rows.length : pb.rows.length);
    // the chart takes the whole height: the pinned time box sits over the chart, at the top next to its
    // line (like the card in the page), and never touches "Realizzato da" at the bottom
    const g = drawChart(EW, OH - TOP - FOOT - M);
    if (!g) throw new Error("niente da condividere");
    const c = chartColors();
    // width and height already at the final resolution: the browser rasterizes the SVG at that size (sharp)
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
      chh = Math.max(OH, TOP + g.H + FOOT + M); // taller only if the panels do not fit
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
    ctx.fillText(title, M, M + 22, cw - 2 * M); // aligned with the chart titles
    let sx = M;
    if (flag) {
      // model flag (layers icon for the median) before the subtitle
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
      // as in the page: the line goes down to the box with time and values, towards the side with more room
      const pb = g.pinBox,
        lx = M + pb.x;
      const widthOf = (parts) =>
        parts.reduce((w, [t, b]) => {
          ctx.font = `${b ? 650 : 400} ${PB.font}px ${FONT}`;
          return w + ctx.measureText(t).width;
        }, 0);
      ctx.font = `400 ${PB.font}px ${FONT}`;
      // table (spaghetti), smaller: a row per line ("Ufficiale  3.7 °C  0.4 mm"), each column as wide as its widest
      // value, so the values of the same field are under each other
      const tb = pb.table,
        TF = 11.5, // table font
        TL = 16, // table line height
        COLGAP = 12; // between columns
      let labW = 0,
        colW = [];
      if (tb) {
        ctx.font = `400 ${TF}px ${FONT}`;
        labW = Math.max(...tb.rows.map((r) => Math.ceil(ctx.measureText(r.t).width)));
        colW = tb.cols.map(() => 0);
        ctx.font = `650 ${TF}px ${FONT}`;
        for (const r of tb.rows) r.vals.forEach((v, k) => (colW[k] = Math.max(colW[k], Math.ceil(ctx.measureText(v).width))));
      }
      const tableW = tb ? labW + colW.reduce((a, w) => a + COLGAP + w, 0) : 0;
      const HF = tb ? TF : PB.font, // box font and line height (smaller for the spaghetti)
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
      // at the top, below the title of the first chart, on the side of the line with more room
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
          ctx.font = `400 ${TF}px ${FONT}`;
          ctx.fillStyle = r.col || c.muted;
          ctx.fillText(r.t, tx, ty);
          tx += labW;
          ctx.font = `650 ${TF}px ${FONT}`;
          ctx.fillStyle = c.fg;
          r.vals.forEach((v, k) => {
            tx += COLGAP;
            ctx.fillText(v, tx + colW[k] - ctx.measureText(v).width, ty); // right-aligned, like the tooltip
            tx += colW[k];
          });
        }
      }
      for (const parts of pb.rows) {
        ty += PB.line;
        let tx = bx + PB.pad;
        for (const [t, b, col] of parts) {
          ctx.font = `${b ? 650 : 400} ${PB.font}px ${FONT}`;
          ctx.fillStyle = col || c.fg; // "Ufficiale" in the green of its line
          ctx.fillText(t, tx, ty);
          tx += ctx.measureText(t).width;
        }
      }
    }
    // bottom right only "Realizzato da signalkuppe.com", small (no data credits row)
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
  /** Share (phone menu; where missing, download) or Download: the same image. */
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
      else chartImage(btn, btn.dataset.act === "share"); // same image as the buttons at the top, with the pinned time
    });
  $("chart-download").addEventListener("click", (e) =>
    chartImage(e.currentTarget, false),
  );

  /** 3–5 "round" values between lo and hi for the axis. */
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

  /** Draws the meteogram in the dialog; with `exportW` it returns instead the SVG exportW wide (for the image). */
  /** Ensemble spaghetti: one line per member (thin, coloured), the operational run of the same cycle ("ufficiale") in green,
   *  the control (GFS) dashed and the thick mean;
   *  temperature at 850 hPa on top, 6-hourly precipitation below. Tooltip with mean and spread of the members. */
  function drawEnsemble(exportW, exportH) {
    const { ensemble: E, run } = chartData;
    const t0 = runDate(run).getTime();
    const W = exportW || Math.max(280, chartUi.body.clientWidth);
    const R = exportW ? CHART_R : 14; // in the dialog the last day label is enough on the right (no precipitation scale); in the image it acts as a margin
    let L = CHART_AXIS, // tightened onto the axis numbers (see below)
      pw = W - L - R;
    const HEAD = 36,
      GAP = 32,
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
    const ctl = E.control ? E.members.indexOf(E.control) : -1; // the ECMWF open-data ensemble has no control
    const op = chartData.op; // operational run of the same cycle, if downloaded
    const panels = [
      { title: "Temperatura 850 hPa", short: "T 850 hPa", unit: "°C", rows: E.t850, op: op?.t850, dec: 1, zero: true, ph: 170, clim: chartData.clim },
      { title: "Pioggia", short: "Pioggia 6h", rain: true, unit: "mm in 6 ore", rows: E.tp, op: op?.tp, dec: 1, min: 2, floor0: true, ph: 110 },
    ];
    // legend below the axis: what the lines are, in several columns
    const legend = [
      ...(op ? [{ label: "Ufficiale", attrs: `stroke="${OFFICIAL}" stroke-width="3"` }] : []),
      ...(ctl >= 0 ? [{ label: "Controllo", attrs: 'class="ch-ens-ctl" stroke-width="1.6" stroke-dasharray="4 3"' }] : []),
      { label: "Media", attrs: 'class="ch-ens-mean" stroke-width="3"' },
      ...(chartData.clim ? [{ label: "1991–2020", attrs: `stroke="${CLIM_RED}" stroke-width="2.5"` }] : []),
    ];
    const legPer = Math.max(2, Math.floor(W / 170)),
      LEG = 8 + Math.ceil(legend.length / legPer) * 18;
    // height: the image's or, in the dialog, all the available one (the panels stretch)
    const fitH = exportH || (chartUi.body.clientHeight > 320 ? chartUi.body.clientHeight - 12 : null);
    const avail = fitH ? fitH - AXIS - LEG - panels.length * (HEAD + GAP) + GAP : null;
    if (avail) {
      const tot = panels.reduce((a, p) => a + p.ph, 0);
      for (const p of panels) p.ph = Math.max(60, (p.ph / tot) * avail);
    }
    const svg = [];
    let top = HEAD;
    const tickText = (t) => fmt(t, Math.abs(t) < 10 && t % 1 ? 1 : 0);
    for (const p of panels) {
      p.mean = mean(p.rows);
      const vals = [...p.rows.flat(), ...(p.clim || []), ...(p.op || [])].filter((x) => x != null);
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
      // the chart starts right after the widest axis number (11-11.5 px, ~6.6 px per digit)
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
        `<text class="ch-title" x="0" y="${top - 20}">${p.title} <tspan class="ch-note">(${p.unit})</tspan></text>`,
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
      // perturbed members: rainbow like the classic charts, thin and slightly transparent
      p.rows.forEach((row, k) => {
        if (k === ctl) return;
        const hue = Math.round((k * 300) / p.rows.length);
        svg.push(
          `<path d="${path(row)}" fill="none" stroke="hsl(${hue} 70% 50%)" stroke-width="0.8" stroke-opacity="0.6" stroke-linejoin="round"/>`,
        );
      });
      // 1991-2020 climatology of the day and hour: solid red, thicker than the members
      if (p.clim)
        svg.push(
          `<path d="${path(p.clim)}" fill="none" stroke="${CLIM_RED}" stroke-width="${exportW ? 1.6 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      svg.push(
        `<path class="ch-ens-mean" d="${path(p.mean)}" fill="none" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
      // control (the unperturbed member, lower resolution than the operational run): dashed, in the text colour
      if (ctl >= 0)
        svg.push(
          `<path class="ch-ens-ctl" d="${path(p.rows[ctl])}" fill="none" stroke-width="${exportW ? 1 : 1.2}" stroke-dasharray="4 3" stroke-linejoin="round"/>`,
        );
      // operational run above everything, in green, with an edge in the background colour that separates it from the
      // spaghetti
      if (p.op) {
        const d = path(p.op);
        svg.push(
          `<path class="ch-ens-halo" d="${d}" fill="none" stroke-width="${exportW ? 2.4 : 3}" stroke-linejoin="round" stroke-linecap="round"/>`,
          `<path class="ch-ens-op" d="${d}" fill="none" stroke-width="${exportW ? 1.4 : 1.8}" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      }
      top = bot + GAP + HEAD;
    }
    const yBot = panels[panels.length - 1].bot;
    const H = yBot + AXIS + LEG;
    legend.forEach((e, i) => {
      const x = (i % legPer) * (W / legPer),
        y = yBot + AXIS + 4 + Math.floor(i / legPer) * 18;
      svg.push(
        `<line ${e.attrs} x1="${x}" x2="${x + 18}" y1="${y}" y2="${y}" stroke-linecap="round"/>`,
        `<text class="ch-leg" x="${x + 23}" y="${y + 4}"><tspan>${e.label}</tspan></text>`,
      );
    });
    // days at midnight (Rome time), labels only if there is room
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
    // values at a step in a table: Ufficiale (the operational run, if any) and Media, one row per chart; for tooltip,
    // pinned time card and image
    // a column per chart (the same field under each other, easy to compare), a row per line
    const valueTable = (i) => {
      const series = [
        ...(op ? [{ t: "Ufficiale", col: OFFICIAL, at: (p) => p.op?.[i] }] : []),
        { t: "Media", at: (p) => p.mean[i] },
        // 1991-2020 climatology: temperature only, a dash under precipitation
        ...(chartData.clim ? [{ t: "Cli.No.", col: CLIM_RED, at: (p) => p.clim?.[i] }] : [])]; // climate normal 1991-2020
      const rows = series.map(({ t, col, at }) => ({
        t,
        col,
        vals: panels.map((p) => (at(p) == null ? "—" : `${fmt(at(p), p.dec)} ${unitOf(p)}`)),
      }));
      if (rows.every((r) => r.vals.every((x) => x === "—"))) return null;
      return { cols: panels.map((p) => p.short), rows };
    };
    const unitOf = (p) => (p.rain ? "mm" : "°C");
    const pin = chartPin != null && steps.includes(chartPin) ? chartPin : null;
    if (exportW) {
      // pinned time: line on the chart and box with time and values next to it, at the top (like the other charts)
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
      // a row per line, the fields in columns (the units tell them apart): "Ufficiale  3.7 °C  0.4 mm"
      return (
        `<div class="ens-vals" style="grid-template-columns:auto${" auto".repeat(tb.cols.length)}">` +
        tb.rows
          .map((r) => `<span class="h"${r.col ? ` style="color:${r.col}"` : ""}>${r.t}</span>` + r.vals.map((v) => `<b>${v}</b>`).join(""))
          .join("") +
        "</div>"
      );
    };
    const headOf = (st) => `${fmtLocal(new Date(t0 + st * 3600e3))} · +${st}h`;
    mountTimeChart({ svg, W, H, L, pw, x0, x1, steps, X, HEAD, yBot, rowsHtml, headOf, pin,
      label: "Spaghetti dell'ensemble" });
  }

  /** Shared interactions of the single-panel "over time" charts (spaghetti, model comparison): hover tooltip,
   *  time pinned with right click or long press (card with Condividi · Scarica · ✕). */
  /** Vertical position of a chart tooltip inside the visible part of the dialog: near the bottom it must not
   *  overflow, otherwise the dialog grows and the scrollbar appears. */
  function tipTop(tip, top) {
    const b = chartUi.body;
    return `${Math.max(b.scrollTop + 4, Math.min(top, b.scrollTop + b.clientHeight - tip.offsetHeight - 4))}px`;
  }
  /** By touch: a tap outside the chart (titles, legend) closes the reading tooltip (not the pinned time card,
   *  which has its own ✕). A property, not a listener: at every redraw the previous handler is replaced. */
  function closeTipOutside(tip, hide, canClose = () => !tip.classList.contains("pinned")) {
    chartUi.body.onpointerdown = (ev) => {
      if (ev.pointerType === "mouse" || tip.hidden || !canClose()) return;
      if (ev.target.closest?.("[id$='-hit'], .chart-tip")) return;
      hide();
    };
  }

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
    // reading tooltip (dark) or pinned time card (light, with Condividi · Scarica · ✕)
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
      tip.style.top = tipTop(tip, clientY - br.top + chartUi.body.scrollTop - 20);
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
    // pinned time card at the top, next to its line
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
      else chartImage(btn, btn.dataset.act === "share"); // same image as the buttons at the top, with the pinned time
    });
    // mouse: hovering reads the values, right click pins the time. Touch: sliding reads the values,
    // a long press pins the time (then dragging moves it); sliding again removes it
    const PRESS_MS = 450,
      SLOP = 8;
    let touch = null;
    hit.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (ev.pointerType === "touch" || touch) return; // with touch the long press takes care of it
      pinAt(stepAt(ev.clientX));
    });
    hit.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;
      const st = stepAt(ev.clientX);
      if (touch) clearTimeout(touch.timer); // second finger: the first one's timer must not fire later
      // the timer uses its own object: when it fires `touch` may already have been reset or replaced
      const t = (touch = { x0: ev.clientX, moved: false, pinning: false });
      t.timer = setTimeout(() => {
        if (touch !== t) return;
        t.pinning = true;
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
      if (ev.pointerType !== "mouse" || chartPin != null) return; // with the time pinned its card stays
      showAt(st, ev.clientX, ev.clientY);
    });
    const endTouch = (ev) => {
      if (!touch) return;
      clearTimeout(touch.timer);
      const tap = ev.type === "pointerup" && !touch.moved && !touch.pinning;
      if (tap && chartPin != null) unpin(); // short tap with a pinned time: removes it
      else if (tap && !tip.hidden) hide(); // short tap with the tooltip open: closes it
      else if (tap) showAt(stepAt(ev.clientX), ev.clientX, ev.clientY);
      else if (ev.type === "pointercancel" && chartPin == null) hide();
      touch = null;
    };
    hit.addEventListener("pointerup", endTouch);
    hit.addEventListener("pointercancel", endTouch);
    hit.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType === "mouse" && chartPin == null) hide();
    });
    closeTipOutside(tip, hide);
    clearChartPin = unpin;
    renderPin(); // redraw (dialog resized): the pinned time stays
    if (pin != null) showPinTip();
    }

  // ---------- model comparison: accumulated precipitation or temperature at 850 hPa of all models and the
  // median at the place, from the meteogram series. Runs start at different hours: the chart starts at the start of the
  // most recent run and precipitation is summed from there, so the lines start together from 0 (like on Wetterzentrale).
  const MULTI_COLORS = {
    gfs: "#51cf66",
    ecmwf: "#20c997",
    "icon-d2": "#fab005",
    "icon-2i": "#fd7e14",
    "icon-ch1": "#f06595",
    "icon-ch2": "#cc5de8",
    arome: "#4dabf7",
    wrf: "#ff6b6b",
    // the median: thick, in the text colour (like the spaghetti mean)
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
    const models = meta.models; // the median too
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
    // each model: accumulated since its start (0 at the start of the run), brought back to 0 at the common time T0
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
          const base = at(0) ?? 0; // precipitation: sum from the common time
          out = [[0, 0], ...pts.filter(([h]) => h > 0).map(([h, x]) => [h, Math.max(0, x - base)])];
        } else {
          // temperature: the real values from the common time on (the 0 point at the start of the run only applies to
          // precipitation); at the common time the value interpolated between the two nearby outputs, if any
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
      HEAD = 36,
      AXIS = 34;
    const steps = [...new Set(lines.flatMap((l) => l.pts.map(([h]) => h)))].sort((a, b) => a - b);
    const x0 = 0,
      x1 = steps[steps.length - 1];
    const valueAt = (l, h) => {
      const p = l.pts;
      if (h > p[p.length - 1][0] + 1e-6) return null; // beyond the end of the model
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
    // legend below the axis: colour and name, in several columns
    const per = Math.max(2, Math.floor((pw + L) / 150)), // ~150 px per entry ("ICON-CH2 12.5 mm")
      legRows = Math.ceil(lines.length / per),
      LEG = 14 + legRows * 18;
    const fitH = exportH || (chartUi.body.clientHeight > 320 ? chartUi.body.clientHeight - 12 : null);
    const PH = Math.max(140, (fitH || 380) - HEAD - AXIS - LEG);
    const bot = top + PH,
      hiT = Math.max(hi, ticks[ticks.length - 1]);
    const X = (h) => L + ((h - x0) / (x1 - x0 || 1)) * pw;
    const Y = (y) => bot - ((y - lo) / (hiT - lo || 1)) * PH;
    const svg = [
      `<text class="ch-title" x="0" y="${top - 20}">${temp ? "Temperatura 850 hPa" : "Precipitazione"} <tspan class="ch-note">(${temp ? unit : `${unit}, cumulata`})</tspan></text>`,
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
    // the median last, above the others, thick in the text colour
    for (const l of [...lines.filter((x) => !x.mean), ...lines.filter((x) => x.mean)])
      svg.push(
        `<path ${l.mean ? 'class="ch-ens-mean" ' : ""}d="${l.pts.map(([h, x], i) => `${i ? "L" : "M"}${X(h).toFixed(1)},${Y(x).toFixed(1)}`).join("")}" fill="none"${l.mean ? "" : ` stroke="${l.color}"`} stroke-width="${l.mean ? (exportW ? 2.4 : 3) * (temp ? 0.8 : 1) : (exportW ? 1.6 : 2) * (temp ? 0.6 : 1)}" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    // legend: with precipitation from the highest total to the lowest (with the total at the end of the run), with temperature the names
    const sorted = temp ? lines : [...lines].sort((a, b) => b.pts.at(-1)[1] - a.pts.at(-1)[1]);
    const colW = (pw + L) / per;
    sorted.forEach((l, i) => {
      const x = (i % per) * colW,
        y = yBot + AXIS + 4 + Math.floor(i / per) * 18;
      svg.push(
        `<line ${l.mean ? 'class="ch-ens-mean" ' : `stroke="${l.color}" `}x1="${x}" x2="${x + 14}" y1="${y}" y2="${y}" stroke-width="3" stroke-linecap="round"/>`,
        // ch-leg: own font (in the image a text without the title class would keep the serif system font)
        `<text class="ch-leg" x="${x + 19}" y="${y + 4}"><tspan>${l.label}</tspan>${temp ? "" : ` ${fmt(l.pts.at(-1)[1])} ${unit}`}</text>`,
      );
    });
    const H = yBot + AXIS + LEG;
    // values at one time: each model, from the highest, for tooltip, pinned time card and image
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

  // ---------- observed soundings (University of Wyoming, see app/soundings.py): the stations on the map
  // (Extra layers, as an alternative to radar and satellite) and, when tapped, the Skew-T diagram of the latest launch
  // list of stations with their launches: requested again after 15 minutes (page left open, new launches) or if it failed
  let soundingIndex = null,
    soundingIndexAt = 0;
  async function getSoundingIndex() {
    if (!soundingIndex || Date.now() - soundingIndexAt > 15 * 60e3) {
      soundingIndexAt = Date.now();
      soundingIndex = fetch(STATIC ? "data/soundings/index.json" : "api/soundings")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .catch(() => {
          soundingIndexAt = 0; // requested again at the next attempt
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
  map.getPane("soundings").style.zIndex = 640; // above the places
  const soundingLayer = L.layerGroup();
  const BALLOON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2a6 6 0 0 0-6 6c0 3.6 3.1 6.6 5 7.6V17h2v-1.4c1.9-1 5-4 5-7.6a6 6 0 0 0-6-6z"/>' +
    '<path d="M11 18h2l-.5 4h-1z"/></svg>';
  async function renderSoundings() {
    const on = state.extra === "snd" && !synoptic();
    const index = on ? await getSoundingIndex() : [];
    soundingLayer.clearLayers(); // after the wait: two close calls do not double the stations
    if (!on || state.extra !== "snd" || synoptic()) {
      soundingLayer.remove();
      return;
    }
    soundingLayer.addTo(map);
    for (const st of index) {
      if (state.extra !== "snd") continue;
      const short = st.name.replace(/ \(.*\)$/, "");
      const ok = st.times.length > 0; // launch not downloaded yet: error icon and notice on tap
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
      // without data: a notice that disappears by itself (a popup would move the map near the edges)
      m.on("click", () =>
        ok ? openSounding(st.id) : toast(`${short}: radiosondaggio non ancora disponibile, riprova più tardi`, true),
      );
    }
  }

  async function openSounding(station, time = null, pushHistory = true) {
    const st = (await getSoundingIndex()).find((x) => x.id === station);
    if (!st || !st.times.length) return;
    const t = st.times[0]; // always the latest available launch
    chartUi.dialog.classList.add("side-panel"); // on desktop a narrow panel sliding in from the right
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
  // side panel: a click outside (on the veiled map) closes it
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
    chartUi.details.textContent = "Radiosondaggio"; // then launch time, freezing level and cloud base (drawSkewT)
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

  // ---------- Skew-T diagram: pressure on a logarithmic vertical scale, isotherms slanted at 45°; temperature
  // (red) and dew point (green), dry adiabats, zero degrees highlighted, wind on the right with barbs
  const DEW_GREEN = "#40c057";
  const TEMP_RED = "#ff6b6b";
  /** Indices from the profile: freezing level (first time the temperature drops below 0 going up) and cloud base by
   *  lifting (LCL) of the surface parcel (Espy's formula, ~125 m per degree of T - Td spread). */
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
    if (zero == null && lv[0]?.[2] < 0) zero = lv[0][1]; // already below zero at the surface
    const g = levels[0];
    const lcl = g && g[2] != null && g[3] != null ? g[1] + 125 * (g[2] - g[3]) : null;
    return { zero, lcl, ground: g?.[1] };
  }
  function drawSkewT(exportW, exportH) {
    const snd = chartData.sounding;
    const levels = snd.levels.filter((l) => l[0] >= 100);
    const avail = exportW || Math.max(280, chartUi.body.clientWidth);
    const HEAD = 12, // time and indices are in the subtitle below the place
      L = 34,
      R = 46; // wind barbs on the right
    const fitH = exportH || (chartUi.body.clientHeight > 320 ? chartUi.body.clientHeight - 12 : null);
    const PH = Math.max(260, Math.min((fitH || 560) - HEAD - 40, (avail - L - R) * 2.2)); // below: degrees and legend (40)
    // a roughly square diagram: on wide screens it does not grow further (200 °C of scale would remain)
    const pw = Math.min(avail - L - R, Math.round(PH * 0.85)),
      W = exportW || L + pw + R;
    const top = HEAD,
      bot = top + PH;
    const P0 = Math.max(1000, Math.ceil(levels[0][0] / 10) * 10 + 10),
      P1 = 100;
    const Y = (p) => bot - ((Math.log(P0) - Math.log(p)) / (Math.log(P0) - Math.log(P1))) * PH; // 1000 hPa at the bottom
    // temperatures: 80 °C across the width; from the surface to 100 hPa the isotherms shift 70 °C to the right, so
    // the profile stays inside on narrow, tall screens as on wide ones. At the surface the temperature falls at ~60%
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
    // subtitle below the place (in the shared image too): launch time, freezing level and cloud base
    chartUi.details.innerHTML = `${when} · <b class="snd-ix">Zero termico ${km(ix.zero)}</b> · <b class="snd-ix">base nubi ${km(ix.lcl)}</b>`;
    // grid: pressure levels
    for (const p of [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100]) {
      if (p > P0) continue;
      svg.push(`<line class="ch-grid" x1="${L}" x2="${L + pw}" y1="${Y(p)}" y2="${Y(p)}"/>`);
      svg.push(`<text class="ch-tick" x="${L - 4}" y="${Y(p) + 3.5}" text-anchor="end">${p}</text>`);
    }
    const g = [`<g clip-path="url(#skc)">`];
    // isotherms every 10 °C (zero highlighted) and dry adiabats every 10 K
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
    // no degrees on the isotherms (too busy): temperatures are read in the tooltip, zero is in the legend
    // wind: barbs on the right at the main levels (where it comes from; half barb 5 knots, full 10, triangle 50)
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
        uy = -Math.cos(a); // direction it comes from
      const len = 20;
      const ex = bx + ux * len,
        ey = y + uy * len;
      let path = `M${bx},${y}L${ex.toFixed(1)},${ey.toFixed(1)}`;
      let rest = Math.round(kt / 5) * 5,
        pos = 0;
      const px = -uy,
        py = ux; // perpendicular
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
    // legend at the bottom
    const H = bot + 40;
    svg.push(
      `<line x1="${L}" x2="${L + 14}" y1="${H - 8}" y2="${H - 8}" stroke="${TEMP_RED}" stroke-width="3" stroke-linecap="round"/>`,
      `<text class="ch-leg" x="${L + 19}" y="${H - 4}"><tspan>Temperatura</tspan></text>`,
      `<line x1="${L + 120}" x2="${L + 134}" y1="${H - 8}" y2="${H - 8}" stroke="${DEW_GREEN}" stroke-width="3" stroke-linecap="round"/>`,
      `<text class="ch-leg" x="${L + 139}" y="${H - 4}"><tspan>Punto di rugiada</tspan></text>`,
      // the zero-degree isotherm (blue, slanted like all isotherms): where the red line crosses it is the freezing level
      `<line x1="${L + 252}" x2="${L + 266}" y1="${H - 8}" y2="${H - 8}" stroke="#4dabf7" stroke-width="2" stroke-linecap="round"/>`,
      `<text class="ch-leg" x="${L + 271}" y="${H - 4}"><tspan>0 °C</tspan></text>`,
    );
    if (exportW) return { markup: svg.join("").replace(/currentColor/g, "#c9ced6"), W, H, pinBox: null };
    // tooltip: the level nearest to the pointer height
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
      tip.style.top = tipTop(tip, ev.clientY - br.top + chartUi.body.scrollTop - 20);
    };
    // by touch: tapping reads the level, a short tap with the tooltip already open closes it
    let press = null;
    hit.addEventListener("pointermove", (ev) => {
      if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 8) press.moved = true;
      show(ev);
    });
    hit.addEventListener("pointerdown", (ev) => {
      press = ev.pointerType === "mouse" ? null : { x: ev.clientX, y: ev.clientY, open: !tip.hidden, moved: false };
      show(ev);
    });
    hit.addEventListener("pointerup", () => {
      if (press?.open && !press.moved) {
        tip.hidden = true;
        cur.setAttribute("visibility", "hidden");
      }
      press = null;
    });
    closeTipOutside(tip, () => {
      tip.hidden = true;
      cur.setAttribute("visibility", "hidden");
    });
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
    // The chart uses the same interval as the map. Outside interval mode `from` is 0, as before.
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
    let L = CHART_AXIS, // tightened onto the axis numbers, see below
      pw = W - L - R;
    let PH = 78;
    const HEAD = 36,
      GAP = 32,
      AXIS = 34; // chart height, title, space between panels, time axis
    const steps = [...new Set(Object.values(V).flatMap((v) => v.steps))].sort(
      (a, b) => a - b,
    );
    if (!steps.length) {
      if (exportW) return null;
      chartUi.body.innerHTML =
        '<div class="chart-empty">Nessun dato in questo punto.</div>';
      return;
    }
    // the axis starts at the first value (+3h: the models' time 0 is not downloaded), so the lines start at the edge;
    // the precipitation of the first hours (0-3h column) stays in the total and the accumulation
    const x0 = from > 0 ? from : steps[0],
      x1 = steps[steps.length - 1];
    const X = (h) => L + ((h - x0) / (x1 - x0 || 1)) * pw;
    const fmt = (x, d) => (x == null ? "—" : x.toFixed(d).replace("-", "−"));
    // bars per interval from the accumulations (precipitation, snow)
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
    /** Precipitation: bars always at the model step (3 hours, 6 after +144h), to see when it rains; on top, the curve
     *  of the accumulation since the start of the period shown (scale on the right). The tooltip also says, at each hour,
     *  the value of a window of the same duration chosen on the map. */
    const rainHours =
      variable()?.modes?.includes("interval") && state.mode === "interval"
        ? intervalHours()
        : null;
    const panels = [];
    if (V.tp) {
      const at = new Map(rawRain.steps.map((x, i) => [x, rawRain.values[i]]));
      // snow (cm, 10:1 = mm of water) of the models that provide it: for each bar the part that fell as snow
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
        const a = V.tp.steps.filter((x) => x <= d.b - rainHours).pop() ?? 0; // like intervalPrev on the map
        const prev = a ? at.get(a) : 0;
        return {
          ...d,
          win: prev == null ? null : Math.max(0, d.cum - prev),
          winH: d.b - a,
        };
      });
      // with snow forecast the panel becomes "Precipitazione" and the snow part of the bars is violet
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
        snowCum: snowy ? data.map((d) => ({ x: d.b, y: d.snowCum })) : null, // violet area inside the accumulation
        cumLabel: from > 0 ? "periodo" : "tot",
        // "tot. 15.2 mm (12.3 cm)": the snow in brackets, if any
        note:
          `${from > 0 ? "periodo" : "tot."} ${fmt([...data].reverse().find((d) => d.cum != null)?.cum, 1)} mm` +
          (snowy ? ` (${fmt(snowTot, 1)} cm)` : ""),
        tip: (d) => `+${d.b - d.a}h`, // only the column duration: the field is clear from the mm
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
    // freezing level: the model gives no value where it is below the ground (the whole column below 0 °C, e.g. on high
    // peaks); if it is below the ground for the whole series there is nothing to draw
    if (V.hzero?.values.some((x) => x != null)) {
      const data = points(V.hzero);
      // mostly missing: say why, otherwise a few dots look like broken data
      const missing = data.filter((d) => d.y == null).length;
      const lastValue = data.findLastIndex((d) => d.y != null);
      // [long, short]: the short one if the long one does not fit next to the title (phones)
      const info =
        missing * 2 < data.length
          ? undefined
          : data.slice(0, lastValue).every((d) => d.y != null)
            ? ["sotto il suolo per il resto del periodo", "poi sotto il suolo"]
            : ["dove manca è sotto il suolo", "a tratti sotto il suolo"];
      panels.push({
        title: "Zero termico",
        unit: "m",
        kind: "line",
        color: "#0b7285",
        data,
        info,
        dec: 0,
        span: 1000, // at least 1000 m on the axis: a few values (freezing level mostly below the ground) do not look broken
        tip: () => "Zero termico",
      });
    }
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
    // values of a panel at a step: for the tooltip (with <b>) and for the image titles (plain text)
    // bars: the one containing the step (with long accumulations one bar covers several steps)
    const valueAt = (p, st) =>
      p.data.find((e) =>
        p.kind === "bar" ? st > e.a && st <= e.b : e.x === st,
      );
    const valueText = (p, d, b = (x) => x, span = true) => {
      // span: "in 3h" for the bars (the tooltip already says it)
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
            : ""; // map accumulation (if chosen) and total since the start
      const snow = p.kind === "bar" && d.snow >= 0.05 ? ` (${b(fmt(d.snow, 1))} cm)` : ""; // snow, as in the title
      return `${b(fmt(d.y, p.dec))} ${p.unit}${span && p.kind === "bar" ? ` in ${d.b - d.a}h` : ""}${snow}${extra}`;
    };
    const pin =
      exportW && chartPin != null && steps.includes(chartPin) ? chartPin : null;
    // portrait image: the panels stretch to fill the available height
    if (exportH && panels.length)
      PH = Math.max(
        48,
        Math.floor((exportH - AXIS) / panels.length - HEAD - GAP),
      );
    for (const p of panels) p.h = PH;
    // on screen: the panels fill the dialog, precipitation (dense bars) a bit taller than the curves;
    // never below PH (on short screens the dialog scrolls as before) nor above CHART_MAX_PH
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
    // days (local midnight) and hours every 6 hours, Rome time as in the rest of the page
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
    // scale of each panel (ends and axis numbers), before drawing: the width of the numbers is needed
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
        if (p.span && hi - lo < p.span) {
          const mid = (hi + lo) / 2; // minimum width of the scale, around the values
          lo = mid - p.span / 2;
          hi = mid + p.span / 2;
        }
      }
      if (p.min != null && p.kind === "line") lo = Math.max(0, lo);
      const ticks = niceTicks(lo, hi);
      p.scale = { ticks, lo: Math.min(lo, ticks[0]), hi: Math.max(hi, ticks[ticks.length - 1]) };
    }
    // the chart starts right after the widest axis number on the left (11-11.5 px, ~6.6 px per digit): wider
    // especially on phones
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
        `<text class="ch-title" x="0" y="${top - 20}">${p.title} <tspan class="ch-note">(${p.unit})${p.note ? " · " + p.note : ""}</tspan></text>`,
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
          // accumulation since the start of the run: light blue area behind the bars, blue line on top, scale on the right
          const cvals = p.cum.map((d) => d.y).filter((y) => y != null);
          const cmax = Math.max(1, ...cvals),
            cticks = niceTicks(0, cmax);
          const cstep = cticks[1] - cticks[0] || 1;
          while (cticks[cticks.length - 1] < cmax)
            cticks.push(cticks[cticks.length - 1] + cstep); // the line stays in the panel
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
            // accumulated snow (cm, 10:1 = mm of water: same scale) as a violet area below the precipitation one
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
        const flakes = []; // columns with snow: snowflake on top
        for (const d of p.data) {
          if (d.y == null || d.y < 0.05 || d.b <= x0) continue; // column before the start of the axis
          const xa = X(Math.max(d.a, x0)) + 1,
            xb = X(d.b) - 1,
            y = Y(d.y);
          svg.push(
            `<rect x="${xa}" y="${y}" width="${Math.max(1, xb - xa)}" height="${Math.max(0, bot - y)}" rx="1.5" fill="${p.color}"${pin != null && pin > d.a && pin <= d.b ? ' class="ch-pin-bar"' : ""}/>`,
          );
          // snow: the upper part of the bar, in violet (how much of the precipitation falls as snow)
          if (d.snow >= 0.05) {
            const ys = y + (bot - y) * (d.snow / d.y);
            svg.push(
              `<rect x="${xa}" y="${y}" width="${Math.max(1, xb - xa)}" height="${Math.max(0, ys - y)}" rx="1.5" fill="${SNOW_BAR}"/>`,
            );
            flakes.push({ x: (xa + xb) / 2, y: y - 3, cm: d.snow });
          }
        }
        // snowflake above each column with snow (︎: text symbol, not the coloured emoji)
        for (const f of flakes)
          svg.push(
            `<text x="${f.x.toFixed(1)}" y="${f.y.toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="${SNOW_BAR}">\u2744\uFE0E</text>`,
          );
        if (accLine) svg.push(accLine);
      } else {
        let path = "",
          pen = false;
        p.data.forEach((d, j) => {
          if (d.y == null) {
            pen = false;
            return;
          }
          path += `${pen ? "L" : "M"}${X(d.x).toFixed(1)},${Y(d.y).toFixed(1)}`;
          pen = true;
          // isolated value (missing before and after, e.g. the freezing level above the ground for one step only):
          // a line of a single point is invisible, so a dot
          if (p.data[j - 1]?.y == null && p.data[j + 1]?.y == null)
            svg.push(`<circle cx="${X(d.x).toFixed(1)}" cy="${Y(d.y).toFixed(1)}" r="3" fill="${p.color}"/>`);
        });
        svg.push(
          `<path d="${path}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
        if (pd && pd.y != null)
          p.pinDot = `<circle class="ch-pin-dot" cx="${X(pin).toFixed(1)}" cy="${Y(pd.y).toFixed(1)}" r="4" fill="${p.color}"/>`;
      }
      if (p.arrows) {
        // arrows pointing where the wind goes, one every ~22 px
        const k = Math.max(1, Math.ceil(22 / (pw / p.data.length)));
        p.data.forEach((d, j) => {
          if (j % k || d.u == null || d.y < 2) return;
          const ang = (Math.atan2(-d.v, d.u) * 180) / Math.PI; // screen: y pointing down
          svg.push(
            `<g transform="translate(${X(d.x).toFixed(1)},${top + 7}) rotate(${ang.toFixed(0)})" stroke="${p.color}" stroke-width="1.4" fill="none" stroke-linecap="round"><path d="M-6,0H6M2.5,-3.5L6,0L2.5,3.5"/></g>`,
          );
        });
      }
      if (p.info) {
        // notice next to the title, like the chart notices (amber). Widths estimated from the characters: title
        // 12.5 px bold ~7.3 px, unit 11.5 px ~6.3 px, box text 11.5 px ~6.2 px
        const bx = Math.ceil(p.title.length * 7.3 + (p.unit.length + 3) * 6.3) + 8,
          room = W - R - bx,
          text = p.info.find((t) => t.length * 6.2 + 16 <= room) ?? p.info[p.info.length - 1],
          bw = Math.ceil(text.length * 6.2) + 16,
          bh = 19,
          by = top - 20 - 13.5;
        svg.push(
          `<rect class="ch-info-bg" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5"/>`,
          `<rect class="ch-info" x="${bx + 0.5}" y="${by + 0.5}" width="${bw - 1}" height="${bh - 1}" rx="5"/>`,
          `<text class="ch-info-text" x="${bx + 8}" y="${top - 20}">${text}</text>`,
        );
      }
    });
    const yTop = 0,
      yBot = H - AXIS;
    // day names ("mer 11") if there is room, otherwise just the number
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
      // pinned time line above everything, then the dots
      svg.push(
        `<line class="ch-pin" x1="${X(pin)}" x2="${X(pin)}" y1="${HEAD + 2}" y2="${yBot}"/>`,
      ); // the box with the values sits next to it, at the top
      for (const p of panels) if (p.pinDot) svg.push(p.pinDot);
    }
    if (exportW) {
      // pinned time box, as in the page but without the links: rows of pieces [text, bold?]
      const B = "\u0001",
        E = "\u0002"; // bold placeholder, then split into pieces
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
    // pinned time: line and dots on the curves; the values are in the bar at the bottom of the dialog (#chart-readout)
    svg.push(
      `<line class="ch-cursor pinned" id="ch-pinline" x1="0" x2="0" y1="${HEAD + 2}" y2="${yBot}" visibility="hidden"/><g id="ch-pindots"></g>`,
    );
    svg.push(
      `<rect id="ch-hit" x="${L}" y="${yTop}" width="${pw}" height="${yBot}" fill="transparent"/>`,
    );
    chartUi.body.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Andamento nel tempo">${svg.join("")}</svg>` +
      '<div class="chart-tip" hidden></div>';

    // reading the values: the step nearest to the pointer, on all panels
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
    // time and values of all panels at a step: tooltip and pinned time bar
    const timeHtml = (st) =>
      `<div class="t">${fmtLocal(new Date(t0 + st * 3600e3))} · +${st}h</div>`;
    const rowsHtml = (st) =>
      panels
        .map((p) => {
          const d = valueAt(p, st);
          if (!d) return "";
          // same rows as the pinned time box in the image (precipitation too: column and total)
          return `<div>${p.tip(d)} ${valueText(p, d, (x) => `<b>${x}</b>`, false)}</div>`;
        })
        .join("");
    const touchUi = !hoverMq.matches; // phone and tablet: no bar at the bottom, values in the tooltip
    // above: by touch the tooltip sits above the touched point, otherwise the finger covers it
    // pinned: pinned time card (light, with the actions) instead of the dark reading tooltip
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
      tip.style.top = tipTop(tip, above ? y - h - 48 : y - 20);
    };
    const hide = () => {
      tip.hidden = true;
      cursor.setAttribute("visibility", "hidden");
    };
    // time pinned by touch: the tooltip stays on its line, at the top of the visible part
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
    // card actions: same image as the buttons at the top, with the pinned time
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
    // mouse: hovering reads the values. A click pins the time (another on the same one removes it); dragging with
    // the button pressed the pinned time follows the pointer.
    // touch: sliding horizontally reads the values (vertically the page scrolls); a long press pins
    // the time for the image to share; a short tap removes the pinned time or shows the values there
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
          // after the long press the finger moves the pinned time
          if (st !== chartPin) {
            chartPin = st;
            renderPin();
            showPinTip();
          }
        } else {
          // dragging again removes the pinned time: back to reading the values
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
        hide(); // on the pinned time the values are already in the bar at the bottom
      else showAt(st, ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerdown", (ev) => {
      const st = stepAt(ev.clientX);
      if (ev.pointerType !== "mouse" && touchUi) {
        if (drag?.timer) clearTimeout(drag.timer); // second finger (see the meteogram)
        const d = (drag = { touch: true, x0: ev.clientX, moved: false, pinning: false });
        d.timer = setTimeout(() => {
          if (drag !== d) return;
          d.pinning = true;
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
        if (tap && chartPin != null) unpin(); // short tap with a pinned time: removes it
        else if (tap && !tip.hidden) hide(); // short tap with the tooltip open: closes it
        else if (tap) showAt(stepAt(ev.clientX), ev.clientX, ev.clientY, true);
        else if (chartPin != null) showPinTip();
        else if (ev.type === "pointercancel") hide(); // the browser took the vertical scroll
        drag = null;
        return;
      }
      if (ev.type === "pointerup" && drag.wasPinned && !drag.moved) {
        chartPin = null;
        renderPin();
      } // tap on the already pinned time
      drag = null;
    };
    hit.addEventListener("pointerup", endDrag);
    hit.addEventListener("pointercancel", endDrag); // the browser took the gesture (vertical scroll)
    hit.addEventListener("pointerleave", (ev) => {
      if (!drag && ev.pointerType === "mouse") hide(); // by touch it arrives after every tap: the tooltip stays
    });
    // no browser menu or selection on long press
    hit.addEventListener("contextmenu", (ev) => {
      if (touchUi) ev.preventDefault();
    });
    closeTipOutside(tip, hide, () => chartPin == null); // the short tap opens the card, but the time is not pinned
    clearChartPin = () => {
      chartPin = null;
      renderPin();
      hide();
    };
    renderPin(); // redraw (dialog resized): the pinned time stays
    if (touchUi && chartPin != null && steps.includes(chartPin)) showPinTip();
  }

  // ---------- point tooltip (native grid, nearest neighbour)
  // With the mouse it follows the pointer. On touch devices it appears where you tap and stays anchored to that point
  // of the map: moving or zooming the map it moves with it, and changing step shows the new value.
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
  /** Tooltip of the tapped point, recomputed (new step, other field); nothing if there is none. */
  function refreshProbe() {
    if (probeLL && !hoverMq.matches)
      showProbe({
        latlng: probeLL,
        containerPoint: map.latLngToContainerPoint(probeLL),
      });
  }
  function showProbe(e) {
    // over a place (or with its popup open there) the black popup is enough: one tooltip at a time
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
    } // outside the data: no tooltip
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
      // combined with arrows: wind speed and direction at the point
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
    // second line: the extra fields (on the T850 map the height of the 850 hPa surface)
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
    // right of the mouse, left if it does not fit; always inside the window (8px from the edges)
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
    // anchored point off screen: the tooltip does not stay stuck to the edge
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

  // ---------- menu of a map point: right click (desktop) or long press (touch).
  // Header with the value at the point and the coordinates; Condividi (image with marker and value),
  // Aggiungi alle località (name prefilled with the coordinates, editable right away), Grafico nel tempo.
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
  /** All map values at the point, like the tooltip, as plain text: colours, lines, wind arrows and
   *  extra fields ("12.4 mm · vento 10 m 25 km/h da SO"); "" without data. */
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
  /** Menu dot fixed on a point (with the menu closed too, while adding). */
  function showPinAt(ll) {
    const cr = map.getContainer().getBoundingClientRect();
    const p = map.latLngToContainerPoint(ll);
    mapMenuPin.style.left = `${cr.left + p.x}px`;
    mapMenuPin.style.top = `${cr.top + p.y}px`;
    mapMenuPin.hidden = false;
  }
  /** keep: the visible part changed (keyboard, iOS moving the page): the menu stays where it is while it is
   *  still entirely visible, and moves only if it would end up hidden (no jumps when opening the folder list). */
  function placeMapMenu(keep = false) {
    if (!menuLL) return;
    const cr = map.getContainer().getBoundingClientRect();
    const p = map.latLngToContainerPoint(menuLL);
    const x = cr.left + p.x,
      y = cr.top + p.y;
    mapMenuPin.style.left = `${x}px`;
    mapMenuPin.style.top = `${y}px`;
    const w = mapMenu.offsetWidth,
      h = mapMenu.offsetHeight;
    // visible part of the page: on mobile, with the keyboard open (name field), it is shorter than the window
    const vv = window.visualViewport;
    const vx = vv?.offsetLeft ?? 0,
      vy = vv?.offsetTop ?? 0,
      vw = vv?.width ?? innerWidth,
      vh = vv?.height ?? innerHeight;
    if (keep && !mapMenu.hidden) {
      const r = mapMenu.getBoundingClientRect();
      if (r.top >= vy + 4 && r.bottom <= vy + vh - 4 && r.left >= vx + 4 && r.right <= vx + vw - 4) return;
    }
    // below right of the point; if it does not fit, left or above, always inside the visible part
    let left = x + 12,
      top = y + 12;
    if (left + w > vx + vw - 8) left = x - 12 - w;
    if (top + h > vy + vh - 8) top = y - 12 - h;
    mapMenu.style.left = `${Math.min(Math.max(left, vx + 8), Math.max(vx + 8, vx + vw - 8 - w))}px`;
    mapMenu.style.top = `${Math.min(Math.max(top, vy + 8), Math.max(vy + 8, vy + vh - 8 - h))}px`;
  }
  // the keyboard opens or closes (or iOS moves the page): the menu stays above the keyboard
  window.visualViewport?.addEventListener("resize", () => placeMapMenu(true));
  window.visualViewport?.addEventListener("scroll", () => placeMapMenu(true));
  function openMapMenu(ll) {
    if (synoptic()) return; // synoptic chart: no point menu
    closePlacePop();
    probeLL = null;
    ui.probe.hidden = true;
    menuLL = ll;
    menuOpenedAt = Date.now();
    const value = pointValueText(ll);
    // title: the coordinates (with the X to close); below, small, the map values at the point
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
    document.body.classList.add("map-menu-open"); // normal cursor on the map while the menu is open
    placeMapMenu();
    mapMenu.querySelector("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
  }
  /** Place just added from the menu: its marker appears with a bounce and a wave (see .pt-num.pt-new). */
  function popNewPlace() {
    const num = pointMarkers.at(-1)?.getElement()?.querySelector(".pt-num");
    if (!num) return;
    num.classList.remove("pt-new");
    void num.offsetWidth; // restarts the animation
    num.classList.add("pt-new");
    num.addEventListener("animationend", function done(e) {
      if (e.pseudoElement !== "::after") return; // the wave ends, it lasts longer than the bounce
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
  /** Add to places: the menu becomes a field with the name (the coordinates, already selected), the folder (if
   *  there is at least one; the open one is preselected) and Aggiungi. */
  function askPlaceName(ll) {
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    // folder: compact select of our own (looks like the model one). Not a <select>: on phones tapping it closes the
    // keyboard and opens the system picker, and the menu jumps; here the name field keeps the focus
    const opts = [{ id: "", name: "Nessuna" }, ...folders];
    const folderField = folders.length
      ? `<span class="map-menu-label" id="map-menu-folder-l">Cartella</span>` +
        `<div class="fsel">` +
        `<button type="button" class="fsel-btn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="map-menu-folder-l"></button>` +
        `<div class="fsel-list" role="listbox" aria-labelledby="map-menu-folder-l" hidden>` +
        opts
          .map((f) => `<div role="option" data-folder="${f.id}" aria-selected="false">${f.id ? FOLDER_ICON : '<span class="fsel-none"></span>'}<span>${esc(f.name)}</span></div>`)
          .join("") +
        `</div></div>`
      : "";
    mapMenu.innerHTML =
      `<form class="map-menu-form"><label for="map-menu-name">Nome della località</label>` +
      `<input id="map-menu-name" type="text" maxlength="60" autocomplete="off" required>` +
      folderField +
      `<div class="map-menu-row"><button type="button" data-act="cancel">Annulla</button>` +
      `<button type="submit" class="primary">Aggiungi</button></div></form>`;
    const input = mapMenu.querySelector("input");
    input.value = coordText(ll);
    // preselected: the folder you are in, "Nessuna" outside folders
    let folder = openFolder;
    const fsel = mapMenu.querySelector(".fsel");
    if (fsel) {
      const btn = fsel.querySelector(".fsel-btn"),
        list = fsel.querySelector(".fsel-list");
      const show = () => {
        const f = opts.find((o) => o.id === (folder || ""));
        btn.innerHTML = `${f.id ? FOLDER_ICON : ""}<span class="fsel-text"></span>`;
        btn.querySelector(".fsel-text").textContent = f.name;
        list.querySelectorAll("[data-folder]").forEach((o) => o.setAttribute("aria-selected", String(o.dataset.folder === f.id)));
      };
      const toggle = (open) => {
        list.hidden = !open;
        btn.setAttribute("aria-expanded", String(open));
        if (!open) return;
        // below the button; above if it does not fit in the visible part (keyboard open)
        const vv = window.visualViewport;
        const bottom = (vv ? vv.offsetTop + vv.height : innerHeight) - 8;
        list.classList.toggle("up", btn.getBoundingClientRect().bottom + 4 + list.offsetHeight > bottom);
      };
      // pointerdown without default: the focus stays in the name field (keyboard open, menu still)
      for (const el of [btn, list]) el.addEventListener("pointerdown", (e) => e.preventDefault());
      btn.addEventListener("click", () => toggle(list.hidden));
      // closes with a tap elsewhere in the menu (name field, buttons) and with Esc
      // on the form, rebuilt at each opening: no listeners piling up on the menu
      const form = mapMenu.querySelector("form");
      form.addEventListener("pointerdown", (e) => {
        if (!list.hidden && !fsel.contains(e.target)) toggle(false);
      });
      form.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !list.hidden) {
          e.stopPropagation(); // only the list, not the whole menu
          toggle(false);
        }
      });
      list.addEventListener("click", (e) => {
        const o = e.target.closest("[data-folder]");
        if (!o) return;
        folder = o.dataset.folder || null;
        show();
        toggle(false);
      });
      show();
    }
    placeMapMenu();
    input.focus();
    input.select();
    // the dialog closes right away; the dot stays on the point while loading, then gives way to the new
    // marker (bounce and wave, see popNewPlace). Point chosen on the map: added even near a place.
    mapMenu.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim() || coordText(ll);
      input.blur(); // on mobile it closes the keyboard
      closeMapMenu();
      showPinAt(ll);
      mapMenuPin.classList.add("loading");
      setTimeout(() => {
        mapMenuPin.classList.remove("loading");
        if (!menuLL) mapMenuPin.hidden = true; // another menu may have opened in the meantime
        if (addPlace(name, ll.lat, ll.lng, true, folder)) popNewPlace();
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
  // desktop: right click (with Mapbox it is forwarded by connectMapbox); with touch the long press here
  // below is used, so Android (which also sends contextmenu) and iOS (which does not) behave the same
  map.on("contextmenu", (e) => {
    e.originalEvent?.preventDefault?.();
    if (!hoverMq.matches) return;
    openMapMenu(e.latlng);
  });
  const LONG_PRESS_MS = 500,
    LONG_PRESS_SLOP = 8; // px: beyond that it is a map drag
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
  // menu open: a click outside just closes it (no point value); the click that follows the long
  // press must neither close it nor show the value
  document.addEventListener(
    "click",
    (e) => {
      if (!menuLL || mapMenu.contains(e.target)) return;
      // on the place markers too: with the menu open no other popup
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
  // the map moves: the menu closes, but not when the page resize moves it. On iPhone
  // (Chrome) the name field opens the keyboard and changes the window height: closing there made the field disappear
  let resizedAt = 0;
  const markResize = () => (resizedAt = Date.now());
  window.addEventListener("resize", markResize, true); // in capture: before Leaflet and Mapbox
  window.visualViewport?.addEventListener("resize", markResize);
  function closeMapMenuOnMove() {
    if (Date.now() - resizedAt < 1000) placeMapMenu(true); // still if it stays visible
    else closeMapMenu();
  }
  map.on("movestart zoomstart", closeMapMenuOnMove); // with Mapbox also from connectMapbox, at the start of the gesture
  map.on("resize moveend", placeMapMenu);
  // no browser menu on the map (long press on Android, right click without Mapbox)
  document.addEventListener("contextmenu", (e) => {
    if (onMapSurface(e.target)) e.preventDefault();
  });

  // ---------- events
  function setStepKeepingInterval(step) {
    state.step = step;
    syncMode(); // with accumulations the range stays fixed, only the time shown changes
  }

  function goStep(delta) {
    const s = slideSteps();
    if (dualMode()) {
      // inside the range, like play: one step with Total, the chosen hours with the buttons
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

  // Lucide "play" and "pause" icons of the button in the mobile bar
  const M_PLAY = ui.mPlay.innerHTML;
  const M_PAUSE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="2.25" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/>' +
    '<rect x="6" y="4" width="4" height="16" rx="1"/></svg>';
  // panel play / pause (smaller, white on the blue circle)
  const P_PLAY = ui.play.innerHTML;
  const P_PAUSE =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
    '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  function togglePlay(force) {
    const on = force ?? !playTimer;
    if (on && !playTimer) {
      stopProgressAnimation();
      // accumulations: inside the fixed range; with Total the accumulation grows, with the chosen hours one image every so many hours
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
        const s = slideSteps(); // with fixed hours one jump every `hours` hours
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
          // skips unavailable steps, restarts from the first
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
  // arrows of the bottom box on mobile: like the panel's, but they stop play
  $("m-prev").addEventListener("click", () => {
    togglePlay(false);
    goStep(-1);
  });
  $("m-next").addEventListener("click", () => {
    togglePlay(false);
    goStep(1);
  });
  ui.mPlay.addEventListener("click", () => togglePlay());
  // slider of the bar on mobile: like the panel's, but it stops play
  $("m-step").addEventListener("input", (e) => {
    togglePlay(false);
    ui.step.value = e.target.value;
    state.step = slideSteps()[+e.target.value];
    syncMode();
    update();
  });
  // «: back to the first available step of the run
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
  // border opacity (Settings), separate from the colours': applies to the whole lines layer
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
  // ---------- panel sections (places, settings, credits): one open at a time, opening and closing
  // animated. In JS and not with <details name>: that way the browser would close the other abruptly, without animation.
  const SECTIONS = [
    ...document.querySelectorAll(".panel-body > details.points-box"),
  ];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const wantsOpen = (d) => d._want ?? d.open; // state it is heading to (during the closing animation it is still open)
  /** Opens/closes sections together: [[details, open], ...]. The final heights are measured with all of them
   *  already in their final state (on phones the open section gets the space the other one leaves), then the
   *  state goes back and the heights are animated: no jump when the animation ends. */
  function animateSections(changes) {
    const items = changes.map(([d, open]) => {
      d._want = open;
      d.classList.toggle("is-open", open); // the arrow rotates right away, even while the section closes
      d._anim?.cancel();
      d.style.overflow = "";
      return { d, open, was: d.open, from: d.getBoundingClientRect().height };
    });
    for (const it of items) it.d.open = it.open;
    for (const it of items) it.to = it.d.getBoundingClientRect().height;
    for (const it of items) it.d.open = it.open || it.was; // while closing it stays open until the end
    for (const { d, open, from, to } of items) {
      if (reduceMotion.matches || Math.abs(to - from) < 1) {
        if (!open) d.open = false;
        continue;
      }
      d.style.overflow = "hidden";
      const a = d.animate(
        { height: [`${from}px`, `${to}px`] },
        { duration: 260, easing: "cubic-bezier(0.25, 0.1, 0.25, 1)" }, // "ease": no long slow tail
      );
      d._anim = a;
      updateSectionFade(d);
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
  }
  // on phones the open section scrolls: fade at the bottom if there is more below, shadow under the title if it has scrolled
  function updateSectionFade(d) {
    // during the open/close animation the section is cut on purpose: no fade (it would vanish at the end, a jump)
    if (d._anim) {
      d.classList.remove("more-below", "more-above");
      return;
    }
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
    d.classList.toggle("is-open", d.open); // initial state (index.html)
    d.addEventListener("scroll", () => updateSectionFade(d), { passive: true });
    d.addEventListener("toggle", () => updateSectionFade(d));
    fadeRo.observe(d);
    for (const child of d.children) fadeRo.observe(child); // growing content (new places) without changing the section
  }
  for (const d of SECTIONS) {
    d.querySelector("summary").addEventListener("click", (e) => {
      e.preventDefault();
      const open = !wantsOpen(d);
      const others = open ? SECTIONS.filter((o) => o !== d && wantsOpen(o)) : [];
      animateSections([...others.map((o) => [o, false]), [d, open]]);
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
    if (!collapsed) togglePlay(false); // reopening the menu stops the animation
  }
  ui.collapse.addEventListener("click", () =>
    setPanelCollapsed(!ui.panel.classList.contains("collapsed")),
  );
  // on mobile, with the panel open, a tap on the map only closes the panel: no point value,
  // no place popup. In capture on the document, before the click reaches Leaflet (markers) or
  // the Mapbox map: with the vector basemap taps go to .wm-native-map, not to the Leaflet container
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
  /** Last row of the panel: when the data were updated ("Aggiornamento 13/11 17:12"). */
  function renderUpdated() {
    const el = $("updated-at");
    const d = publishedAt ? new Date(publishedAt) : null;
    if (!d || Number.isNaN(d.getTime())) {
      $("updated-row").hidden = true;
      return;
    }
    // short format: "Aggiornamento 13/11 17:12"
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

  // ---------- map area: the data's (BBOX) or the synoptic chart's, which changes with the field
  const toBounds = (b) =>
    L.latLngBounds([b.lat_min, b.lon_min], [b.lat_max, b.lon_max]);
  let areaBox = null, // area the map can move in right now
    areaKey = null,
    startView = null, // initial view (Lombardy)
    localView = null; // normal map view left when switching to the synoptic chart, to find it again when coming back
  // The minimum zoom is the one at which the view lies entirely inside the area covered by the data:
  // you can never see map without data. Recomputed if the window changes size.
  function updateMinZoom() {
    map.setMinZoom(0);
    map.setMinZoom(map.getBoundsZoom(areaBox, true));
  }
  /** Synoptic chart: always at minimum zoom (the whole area that fits on screen), centred a bit south of Northern
   *  Italy; applies to the view, the phone in landscape and the shared image. */
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
    // area change (500 hPa chart and back): the other area's colours and lines go away right now, otherwise in the new
    // view they would appear for a moment before the right map (on first opening there is nothing yet)
    if (areaKey) clearOverlay();
    if (areaKey && typeof renderSoundings === "function") queueMicrotask(renderSoundings); // no stations at 500 hPa
    areaKey = key;
    const syn = synoptic();
    document.body.classList.toggle("synoptic-mode", syn);
    closeMapMenu(); // the menu entries change between the two areas
    closePlacePop(); // the area changes: the map moves and the popup would be left hanging in mid-air
    ui.probe.hidden = true;
    probeLL = null;
    areaBox = toBounds(a);
    // first remove the Mapbox bounds: with the minimum zoom change it would bring Leaflet back to the old area
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

  // the page must not scroll (see html, body in style.css): if the browser moves it anyway (keyboard, map wider
  // during sharing), it is put back at the top
  // during sharing), it is put back at the top. Not while typing: iOS moves the page to show the
  // field above the keyboard
  window.addEventListener("scroll", () => {
    if (document.activeElement?.matches?.("input, textarea")) return;
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  });

  // ---------- phone in landscape: only the full-screen map (no places or taps) and at the bottom « ‹ on the
  // left, › » on the right and the date in the middle to move in time (like the arrows: one step, one interval with
  // 3/6/12/24h, one step in the period with Total).
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
  /** First or last stop (in the period with Total, over the run otherwise), like the arrows. */
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
    // no double-tap zoom: tapping the buttons quickly zoomed the map and the area was lost
    const dbl = glBase ? glBase.doubleClickZoom : map.doubleClickZoom;
    if (dbl) on ? dbl.disable() : dbl.enable();
    if (on) {
      closeMapMenu();
      closePlacePop();
      probeLL = null; // the tapped point's tooltip goes away too
      ui.probe.hidden = true;
      renderLandscapeNav();
      // always start from the whole view (minimum zoom), after the map has taken the new size
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

  // ---------- Home Screen app: there is no browser bar, so no reload and no "pull down to
  // refresh". A button next to the panel's one reloads the page (new runs and steps).
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) {
    ui.appReload.hidden = false;
    ui.appReload.addEventListener("click", () => location.reload());
    // when reopening the app iOS shows the page kept in memory, with the runs of that time: every time it comes back to the
    // foreground it reloads (the view stays: model, field and time are in the address). Not if a dialog is open
    // (sharing, chart): coming back from the app the image was shared to, what you were doing would be lost.
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

  // ---------- error reporting (Sentry): only if there is a DSN (meta.sentry_dsn, SENTRY_DSN variable). No
  // personal data: neither the IP address (sendDefaultPii: false) nor the part of the address after #, which contains
  // coordinates and place names; no performance tracing or session recording.
  const SENTRY_SRC = "https://browser.sentry-cdn.com/11.12.0/bundle.min.js"; // errors only (no tracing or replay)
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
        // no IP: Sentry does not derive it from the connection and so not the location either (country, city)
        initialScope: { user: { ip_address: null } },
        tracesSampleRate: 0,
        // browser noise, not app errors
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

  // ---------- startup
  /** Mapbox GL: loaded without blocking page startup, while meta and runs
   *  are downloaded. If it does not arrive within 8 s the page starts with the fallback basemaps. */
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
      // version from the git tags (empty if there are no tags)
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
    applyArea(); // map area or, if the chosen field is the synoptic chart, its own
    await mapboxLib; // downloaded and executed while meta and runs were arriving
    setupSentry(meta.sentry_dsn);
    setupMapbox(meta.mapbox_token); // after the first view: Leaflet adds layers only once the map is positioned
    applyLandscape(); // phone already in landscape on opening
    renderSoundings(); // sounding stations, if on
    map.on("resize", () => {
      updateMinZoom();
      if (map.getZoom() < map.getMinZoom())
        map.setZoom(map.getMinZoom(), { animate: false });
      map.panInsideBounds(areaBox, { animate: false });
    });
    setBorders(state.borders, false);
    setExtra(state.extra, false);
    setBase(state.base, false); // the last one chosen in "Impostazioni" (saved in the browser), otherwise Rilievo

    ui.opacity.value = state.opacity;
    ui.bordersOpacity.value = state.bordersOpacity;
    applyBordersOpacity();
    ui.crisp.checked = state.crisp;
    ui.iso.checked = state.iso;
    setupVars();
    // initial state (index.html): "Modelli e parametri" open, the other sections closed, on every screen
    setupPoints();
    setupModels();
    setupModes();
    setupRuns();
    setupSteps();
    await update();

    // new runs/steps arrive while the page is open
    setInterval(async () => {
      try {
        await refreshRuns();
        const changed = setupRuns(); // switches by itself to the new run when it is complete
        if (changed) setupSteps();
        if (changed || !current) update();
      } catch {
        /* offline: retried at the next round */
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
