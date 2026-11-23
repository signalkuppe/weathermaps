# Weathermaps

**App: <https://signalkuppe.github.io/weathermaps/>** (updated once an hour)

Forecast maps of precipitation, temperature at 850 hPa and at 2 m, wet-bulb temperature at 2 m, snow, freezing level
and wind from the global and local models over Northern Italy. The [Mapbox](https://www.mapbox.com) basemap can be chosen in the
settings: **Outdoors** (with pronounced relief, the default) or **Base** (Streets recoloured like a weather chart); the
data colours sit inside the map, below borders and place names, which stay readable at any opacity. Without a Mapbox
token the page falls back to Thunderforest / OpenStreetMap tiles. Basemap, borders, opacity, sharp cells and contour
lines are saved in the browser.

The app's interface is in Italian; the code, comments and documentation are in English.

| Model                  | Source                              | Resolution       | Range       | Runs          |
| ---------------------- | ----------------------------------- | ---------------- | ----------- | ------------- |
| GFS                    | NOAA/NCEP                           | 0.25°            | +192h       | 00/06/12/18   |
| ECMWF IFS 0.25°        | ECMWF Open Data                     | 0.25°            | +192h       | 00/12         |
| ECMWF IFS 0.1°         | ECMWF Open Data                     | 0.1° (~9 km)     | +192h       | 00/12         |
| ECMWF AIFS             | ECMWF Open Data (machine learning)  | 0.25°            | +192h, 6h   | 00/06/12/18   |
| ICON-2I                | ItaliaMeteo (MeteoHub)              | 2.2 km           | +72h        | 00/12         |
| WRF                    | ItaliaMeteo, CIMA, LaMMA (MeteoHub) | 1.5 km           | +72h        | 00/12         |
| MOLOCH                 | CNR-ISAC, ItaliaMeteo (MeteoHub)    | ~1 km            | +72h        | 00/12         |
| ICON-D2                | DWD Open Data                       | 2.2 km           | +48h        | every 3 hours |
| AROME                  | Météo-France Open Data              | 0.025° (~2.5 km) | +51h        | every 3 hours |
| ICON-CH2-EPS (control) | MeteoSwiss                          | ~2 km            | +120h       | every 6 hours |
| ICON-CH1-EPS (control) | MeteoSwiss                          | ~1 km            | +33h        | every 3 hours |
| **Model median**       | computed                            | ~2 km            | up to +192h | —             |

Fields available per model:

| Model          | Precipitation | T 850 hPa | RH and wind 850 hPa | T and wet bulb 2 m | Snow                          | Freezing level           |
| -------------- | ------------- | --------- | ------------------- | ------------------ | ----------------------------- | ------------------------ |
| GFS            | ✓             | ✓         | ✓                   | ✓                  | — (snowfall is not published) | ✓                        |
| ECMWF (all 3)  | ✓             | ✓         | ✓                   | ✓                  | ✓                             | — (not in the open data) |
| ICON-2I        | ✓             | ✓         | ✓                   | ✓                  | ✓                             | ✓                        |
| WRF            | ✓             | ✓         | ✓                   | T only             | —                             | —                        |
| MOLOCH         | ✓             | ✓         | ✓                   | T only             | ✓                             | —                        |
| ICON-D2        | ✓             | ✓         | ✓                   | ✓                  | ✓                             | ✓                        |
| AROME          | ✓             | —         | —                   | —                  | ✓                             | —                        |
| ICON-CH2 / CH1 | ✓             | —         | —                   | ✓                  | ✓                             | ✓                        |

**Relative humidity and wind at 850 hPa** (about 1500 m) are a combined entry, "UR e vento 850": humidity in colour
(from brown when dry to dark blue when saturated, a stop every 10% plus 95%) with the wind arrows on top. The AIFS and MOLOCH publish only the specific
humidity: the relative one is computed from it, the temperature and the level's pressure (vapour pressure
e = q·p / (0.622 + 0.378·q), saturation over water with Bolton's formula). ICON-CH (model levels only) and AROME
(pressure levels in packages not downloaded) do not have it.

The three ECMWF entries are separate models and all three enter the median. The IFS 0.1° is the same run as the
0.25°, published about two hours later; it has no synoptic chart (that stays at 0.25°). The AIFS has a step every 6
hours: in the median its accumulated total is interpolated at the 3-hour steps, so it enters every interval. The
AIFS gives precipitation and snow already in mm (kg m⁻²), the IFS in metres of water. In legends and lists the three
are shortened to "ECMWF (0.25)", "ECMWF (0.1)" and "ECMWF (AIFS)".

**Snow** is in cm of fresh snow: the models give the water equivalent (mm), converted with the standard 10:1 ratio
(1 mm of water = 1 cm of snow). It is an estimate: wet snow accumulates less, powder snow more. In the ICON models it
is the sum of grid-scale and convective snow. The **freezing level** is the height (m above sea level) of the 0 °C
isotherm.
The **wet bulb at 2 m** is computed from temperature and dew point at 2 m with the psychrometric equation, constant
coefficient A = 6.46 × 10⁻⁴ °C⁻¹ and the model's local surface pressure (not reduced to sea level). Pressures are
converted to hPa, like the vapour pressure; below 0 °C snow easily reaches the ground.
WRF and MOLOCH are available for the 2 m temperature but not for the wet bulb: the MeteoHub catalogue does not expose the
required surface pressure, and no standard or sea-level pressure is used instead.
`tw2m` fields already in the cache are not recomputed: the correction applies to new downloads. To regenerate
existing runs too, remove only the `tw2m` fields (including the median) from the cache and run the download again.

The **wet-bulb zero height**, for now GFS only, is a separate field (`hwzero`), in metres above sea level. It uses
the same equation as the 2 m wet bulb: on the 13 levels from 1000 to 500 hPa the pressure is the level's own and the
dew point comes from temperature and relative humidity, using Magnus over water. The 2 m point is added to the
profile, with the model's surface pressure and terrain height. The data arrive in a single NOMADS request cropped to
the box; only the final height is stored. The first positive-to-negative crossing going up is interpolated linearly,
excluding levels below the 2 m point. There is no interpolation across missing data and no extrapolation outside the
profile: without a crossing, even with the whole column below zero, the value stays missing. The 500 hPa upper limit
is about 5.5 km and varies in time; heights aloft are GFS geopotential heights. It is not a snow level and is not
part of the model median.

For each model **only the latest complete run** is shown. While the next run is coming out, the page shows
its progress ("12Z in arrivo · 20/56 passi", i.e. "12Z incoming · 20/56 steps"); once complete it replaces the
previous one, which is deleted.

The **model median** is built per valid time from a common time T0 (start of the most recent complete run, rounded to
6 hours): each model uses its latest complete run, and a model that started after T0 joins from its first steps. For
precipitation and snow the total is the sum of the medians of each interval (so Total and Interval stay consistent
when a short-range model drops out); for temperature and freezing level it is the median of the values. Unlike the
mean, the median is not dragged by a single model far from the others; with only two models the two coincide. At each
step the page shows which models are in the median.

## What the page does

- **Navigation:** with Mapbox, pinch, drag and zoom buttons use the native camera, without canvas copies or blurred
  edges. The weather colours stay georeferenced while moving; contours and tooltip hide during the gesture and come
  back at the end. Leaflet annotations realign once at the end of the movement. Without a Mapbox token or WebGL the
  page keeps Leaflet navigation with the fallback basemaps.
- **Fields:** Precipitation and Snow (places ranked from the highest), Temperature at 850 hPa and Freezing level (from
  the lowest), plus the combined entry **Precip. e zero termico** (precipitation and freezing level): precipitation in
  colour with freezing-level contours on top, for the models that have both fields (GFS, ICON-2I, ICON-D2,
  ICON-CH1/CH2 and the median). Combined entries (`COMBOS` in `app/variables.py`) have no data of their own: the page
  requests the two fields.
  With accumulations (3–24h) the contours show the **freezing level during precipitation** (in the page "Zero termico
  in 24h"): for each point, the mean of the 3-hour (or 6-hour) sub-intervals of the period, each weighted by the
  precipitation that fell in it and using the mean freezing level between its ends; where less than 0.1 mm falls in
  the period, the plain mean is used. With Total they are the freezing level at the time shown. The computation runs
  in the browser with the already published fields (for "24h" about 9 totals and 9 freezing-level fields, reused by
  nearby steps during the animation).
- **Modes:** Total (accumulation since the start of the run) and accumulations over **3, 6, 12 or 24 hours** ending
  at the time shown (`ore` parameter in the URL), with the duration always written: "Precipitazione in 24h" in the
  legend, in the places panel and in the shared image. They are differences between two totals, so they do not add to
  the published data; beyond +144h steps are every 6 hours and "3h" becomes 6h; at the start of the run the
  accumulation starts from +0h.
- **Colours:** smooth gradients for continuous fields (temperature at 850 hPa, freezing level, wind), where lines and
  labels give the exact values; sharp bands for precipitation and snow, where thresholds matter (1, 5, 10 mm…).
- **Contour lines** above the colours, with labels: isotherms every 2 °C at 850 hPa (0 °C highlighted) and
  freezing-level contours every 250 m (thousands highlighted). They are computed in the browser from the field
  (smoothed on fine grids), can be turned off in the settings and also appear in the shared image.
- **Borders** above the colours, selectable in the settings: countries (with coastlines), regions or provinces, each
  level with the previous ones. With Mapbox they are Mapbox's own (the same as the basemap, redrawn dark and
  continuous; provinces are an extra layer on its data); coastlines come from OpenStreetMap (`static/borders.json`,
  `scripts/make_borders.py --water`). Without Mapbox the Natural Earth 1:10m outlines in the same file are used,
  regenerated with `scripts/make_borders.py` if `BBOX` changes.
- **Controls:** model, time (slider, ←/→ arrows, space = play), adjustable opacity, sharp cells without
  interpolation. On mobile there is a bottom bar with time, ‹ › ▶ and compact legend; model and run are in the panel
  head, next to the name.
- **Legend:** horizontal (title with units, colour bar with thresholds), bottom right on desktop and in the bar on
  mobile.
- **Value under the cursor** (desktop), with the freezing level in the combined entry and, on the T850 map, the
  height of the 850 hPa surface on a second line; it always stays inside the window.
- **Sharing:** crop frame with fixed proportions (4:3, 1:1, 16:9) over which the map can be moved and zoomed; when
  opened it is as large as possible in the centre of the map as you are viewing it (same area, same zoom; no location
  request); header with model, run and time, legend, credits and "Realizzato da signalkuppe.com"; a switch to include
  the places or not. Only the image is shared, without text.
- **State in the URL:** model, field, time, mode and opacity, so the view can be shared as a link. Opening a chart
  adds the place, chart model, run and range: the link reopens it directly, even without the place among the
  favourites. Back returns to the map and Forward reopens the chart; changing the model updates the same history
  entry. If the shared run is no longer available, the latest complete one is used.
- **Version** at the end of the last row of the panel, after the update time, from the git tags.

## Running locally

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env              # optional
python scripts/fetch_once.py      # first download (~5 min, then incremental)
uvicorn app.main:app --reload     # http://localhost:8000
```

Alternatively, without activating the environment: `./dev.sh` (same server, http://localhost:8000).

The server updates the data by itself every 10 minutes (`SCHEDULER_ENABLED=0` to disable it).
Tests: `pytest` (Python, including the parts that run the page's code in node) and `node --test tests/*.mjs`.

## Configuration (environment variables)

| Variable                 | Default                  | Meaning                                                                                                                                                                                                              |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BBOX`                   | `42,49,4,17`             | Area: `lat_min,lat_max,lon_min,lon_max` (lon -180..180)                                                                                                                                                              |
| `INITIAL_VIEW`           | `44.68,46.64,8.50,11.43` | View on opening (Lombardy), same format, inside `BBOX`                                                                                                                                                               |
| `DATA_DIR`               | `./data`                 | Data folder                                                                                                                                                                                                          |
| `SCHEDULER_ENABLED`      | `1`                      | Automatic updates                                                                                                                                                                                                    |
| `SCHEDULER_INTERVAL_MIN` | `10`                     | Update frequency                                                                                                                                                                                                     |
| `MAPBOX_TOKEN`           | —                        | Public [Mapbox](https://account.mapbox.com) token (`pk.…`) for the Outdoors and Base basemaps: it ends up in the page, so restrict it to the site's domains in the Mapbox dashboard (static site: repository secret) |
| `THUNDERFOREST_KEY`      | —                        | [Thunderforest](https://manage.thunderforest.com) key for the fallback basemap without Mapbox (static site: repository secret)                                                                                       |
| `APP_VERSION`            | from git tags            | Version shown in the last row of the panel: normally `git describe` (`v1.2.0` on the tag, `v1.2.0+3` three commits later); set it where there is no `.git`, for example in the Docker image. Without tags nothing is shown       |

## Favourite places

The places on the map are chosen by the user: in the **Località preferite** (favourite places) section of the panel
they are searched by name and added, then renamed or deleted with **Modifica** (edit), up to 20. There are none at
the start. On the map each one has a circle with its rank (1 = most precipitation or coldest) and a label with value
and unit (e.g. `2575m`); the value is the one of the nearest grid cell, computed in the browser, so it also works on
the static site.

- **Labels:** to the right of the circle if there is room, otherwise left, above or below, with a small triangle
  pointing at the circle; if no side is free only the circle remains. The position is recomputed at every zoom and
  data change.
- **Popup on click** (on the circle or on the list row): name, value (plus the freezing level in the combined entry,
  wind direction, height of the 850 hPa surface on the T850 map) and time, with an X to close it; always inside the
  window, below panel and bar.
- **Storage:** in the browser (`localStorage`, key `weathermaps.places.v1`), so they stay on that browser and that
  device; a new deploy does not touch them. They are lost when the site data is cleared; Safari clears the data of
  sites not opened for 7 days of use (not for pages added to the Home Screen). Places saved locally (`localhost`) do
  not appear on the published site and vice versa. In private browsing or with site data blocked, changes last while
  you stay on the page.
- **Search:** first [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) (GeoNames data: cities,
  villages, peaks and passes; answers in under a second), limited to the map area. If it finds nothing or does not
  answer within 3.5 seconds, [Photon](https://photon.komoot.io) is used (OpenStreetMap, inhabited places, peaks and
  passes: `osm_tag=place`, `natural:peak`, `mountain_pass`), more complete but often very slow. The search text is
  sent to the service used. The search ends within 10 seconds even if neither answers.

## Changing the area

Set `BBOX` and restart. The old area's data is deleted and the new one is downloaded on the first round. The
frontend reads the area from `/api/meta`, so it does not need changes.

## Adding a field

Add a `Variable` in `app/variables.py` with:

- the GRIB selectors per model: for GFS the NOMADS `var`/`level` name (e.g. `TMP`, `2_m_above_ground`), for ECMWF
  `param`/`levtype` of the `.index` lines (e.g. `2t`, `sfc`), plus the `short_name` of the decoded message;
- the unit conversion and the colour scale;
- the kind: `accum` (total/interval) or `instant` (value only);
- if the data is the sum of several fields (e.g. ICON grid-scale + convective snow), the selectors to add in `plus`;
- optionally, `contours` for the contour lines above the colours (`step`, highlighted levels in `bold`, `signed` for
  the "+" sign).

To overlay the lines of one field on the colours of another, one line in `COMBOS` is enough.

Fetcher, API and frontend handle it without other changes; the "Grandezza" (field) selector appears when there is
more than one. Wind (`vector`) will need a dedicated arrow renderer.

## Free publishing on GitHub Pages

The `.github/workflows/pages.yml` workflow runs once an hour on GitHub Actions: it restores the already downloaded
data from cache, downloads missing steps (`scripts/fetch_once.py`), generates the static site
(`scripts/build_static.py`) and publishes it on GitHub Pages. Only complete runs are published as maps.

Fields are published in a compact format (`.bin`, values as 16-bit integers, `app/packed.py`): about a third of the
JSON. The data files (fields, meteogram tiles and ensemble points) are also stored gzip-compressed: GitHub Pages
compresses on the wire but counts the stored size against its 1 GB limit, and compressed the site weighs about a
quarter (about 205 MB instead of 920 MB with all models). The page recognises the gzip header and decompresses them
with `DecompressionStream` (Safari/iOS 16.4+, Chrome 80+, Firefox 113+); plain files are still read. `meta.json` and
`runs.json` stay plain.
On the static site Interval mode is computed in the browser. The incoming-run notice is informational: there is
no manual download button. New data become available after the hourly publication.

### Why once an hour, with an external trigger

- **Only complete runs are shown.** The most frequent models have a new run every three hours; hourly publication
  makes completed runs available without rebuilding the site every time another forecast step arrives.
- **GitHub's cron is not reliable.** GitHub treats scheduled runs as "best effort": under load it delays or drops
  them without a trace. In the repository's first 15 hours, with a cron every 30 minutes, only one run out of about
  thirty started.
- **So the real trigger comes from outside.** An external service ([cron-job.org](https://cron-job.org), free) calls
  the GitHub API once an hour to start the workflow (`workflow_dispatch`). The workflow also has a native schedule
  at minute `17`: this is an additional trigger, not a conditional fallback. A running publication is not canceled
  by a newer request. Provider availability, Actions queueing and Pages deployment can add delays.

Setting up the external trigger:

1. On GitHub create a _fine-grained_ token (Settings → Developer settings → Personal access tokens → Fine-grained
   tokens) with access to the `weathermaps` repository only and only the **Actions: Read and write** permission.
   Note the expiry date: when it expires the external trigger stops.
2. On cron-job.org create one job:
   - URL: `https://api.github.com/repos/signalkuppe/weathermaps/actions/workflows/pages.yml/dispatches`

- Method: `POST`, timezone: `Europe/Rome`, schedule: every hour at minute `0` (`0 * * * *`)
- Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
- Body: `{"ref":"main"}`

3. Expected response: `204 No Content`. A `401` or `403` means an expired token or one without the Actions
   permission.

Test from a terminal, with the same token:

```bash
curl -i -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/signalkuppe/weathermaps/actions/workflows/pages.yml/dispatches \
  -H "Content-Type: application/json" -H "X-GitHub-Api-Version: 2022-11-28" \
  -d '{"ref":"main"}'
```

Local test:

```bash
python scripts/build_static.py public
cd public && python -m http.server 8090   # http://localhost:8090
```

Keep the external token valid and check the cron service's execution history.

## API

- `GET /api/meta`: version, area, steps, models, fields (including combined ones) with colour scales and contour
  lines
- `GET /api/runs`: per model the latest complete run and, if any, the incoming one (`incoming`), with the
  downloaded steps
- `GET /api/field?model=gfs&var=tp&run=2026110906&step=24&mode=total|interval[&prev=12]`: JSON grid (rows
  south→north); with `interval` the difference from step `prev` (default the previous one, `0` = since the start of
  the run)

## Data sources

- GFS: NOAA/NCEP via [NOMADS](https://nomads.ncep.noaa.gov/) (public domain)
- ECMWF: [Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data), CC-BY-4.0 licence
- ItaliaMeteo: [ICON-2I on MeteoHub](https://dati.agenziaitaliameteo.it/dataset/previsioni-meteorologiche-modello-icon-2i),
  CC-BY licence, "single variable" service (only the messages of the needed steps are downloaded).
- WRF: [MeteoHub](https://meteohub.agenziaitaliameteo.it/nwp/), "single variable" service; only the GRIB2 message
  headers are read and the needed steps downloaded. Lambert grid remapped to ~1.6 km with the nearest point.
- MOLOCH (CNR-ISAC): [MeteoHub](https://meteohub.agenziaitaliameteo.it/nwp/), same service as WRF, CC-BY-SA
  licence. Rotated grid of 0.0091° (~1 km) remapped to ~1.6 km with the nearest point; wind components are already
  east/north. Precipitation and snow come hour by hour and are summed since the start of the run (small messages);
  snow is in metres of water. The 00 UTC run comes out about 8h30 after, the 12 UTC one about 9h after.
- DWD: [ICON-D2 Open Data](https://opendata.dwd.de/weather/nwp/icon-d2/), regular 0.02° grid.
- Météo-France: [AROME 0.025° packages](https://www.data.gouv.fr/datasets/paquets-arome-resolution-0-025/), Licence
  Ouverte Etalab 2.0. Precipitation and snow (SP1 package, in 6-hour blocks): the GRIB2 headers are read and only the
  needed messages downloaded. Valid data end between 13°E (at 42°N) and 14.5°E (at 49°N).
- MeteoSwiss: [ICON-CH1/CH2-EPS Open Data](https://opendatadocs.meteoswiss.ch/e-forecast-data/e2-e3-numerical-weather-forecasting-model),
  CC-BY licence. Fields are on an unstructured ICON grid and are remapped to a regular ~2.2 km grid (nearest model
  point); the grid coordinates are downloaded once into `DATA_DIR/static`.
- Maps: © [Mapbox](https://www.mapbox.com/about/maps/), © OpenStreetMap contributors (fallback: Thunderforest)
- Coastlines: [OpenStreetMap Data](https://osmdata.openstreetmap.de/) (ODbL)
- Geographic outlines: [Natural Earth](https://www.naturalearthdata.com/) 1:10m (public domain)
- Place search: [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) on
  [GeoNames](https://www.geonames.org/) data; fallback [Photon](https://photon.komoot.io) on OpenStreetMap data
