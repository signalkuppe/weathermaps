# GFS / ECMWF precipitation maps web app over Northern Italy

> Original project plan (November 2026), kept for history. The README describes the current state of the app.

## Context

The goal is a web app that shows, on an OpenStreetMap basemap, the precipitation forecast by the GFS (NOAA) and ECMWF IFS models over Northern Italy and the neighbouring sectors (Switzerland, western Austria, SE France, Slovenia, northern Croatia), up to +192h, with a model / run / time selector, a semi-transparent overlay above the terrain and the places, and the value in mm on mouse hover. Two modes: **total since the start of the run** up to the chosen time and **precipitation of the interval** (3h or 6h). It must run locally and then on Railway.

The folder `/Users/signalkuppe/projects/weathermaps` is empty: a greenfield project, no existing code to reuse.

### Facts verified today (2026-11-09) with real downloads

- **GFS 0.25°** via the NOMADS filter with a subdomain, no key:
  `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.YYYYMMDD%2FHH%2Fatmos&file=gfs.tHHz.pgrb2.0p25.fFFF&var_APCP=on&lev_surface=on&subregion=&toplat=49&leftlon=4&rightlon=17&bottomlat=42`
  3–4 KB response, 53×29 grid (lat 42→49, lon 4→17), units kg m⁻² (= mm). Each file contains **two messages**: the bucket (e.g. `18-24`) and the **total since the start of the run** (`0-24`); at f003/f006 the two coincide. The message with stepRange `0-N` is always used. Runs 00/06/12/18, 3h steps up to 240h.
- **ECMWF Open Data IFS 0.1°** (new since October 2026), no key, CC-BY-4.0 licence:
  `https://data.ecmwf.int/forecasts/YYYYMMDD/HHz/ifs/0p1/oper/YYYYMMDDHH0000-{step}h-oper-fc-sfc.grib2` with an `.index` alongside (one JSON line per field with `_offset`/`_length`). The `tp` field is downloaded with a `Range:` request (HTTP 206, ~1.8 MB), global 3600×1801 regular_ll grid at 0.1°, lat 90→-90, lon 0→359.9, **units m**, stepRange `0-N` (accumulated since the start of the run). 00z/12z steps: 0–144 every 3h, 150–360 every 6h; 06z/18z stop at 144h. Retention on the server ~3–4 days. It comes out about 2h after the 0.25° (00z available around 08–09 UTC).
- On the Mac: Python 3.15 (Homebrew), ecCodes 2.45 CLI (`grib_ls`), Node 24. No Python packages installed: a venv is used.
- Sample files already downloaded (`gfs_f024.grb`, `ec_tp24.grb` 0.25°, `ec01_tp24.grb` 0.1°): to be copied into `tests/fixtures/` as fixtures.

## Extensibility requirements

Two evolutions are planned from the start and drive the design:

1. **More fields later** (e.g. snow, 2 m temperature, wind, pressure, CAPE). No code must be "hard-wired" to precipitation: the field is a configuration object and everything else (fetch, storage, API, frontend) handles it generically.
2. **Changeable map area** (wider, moved, a different region). The geographic box lives in a single configuration point and is propagated to download URLs, crop, API metadata and frontend bounds; changing the area must not require code changes, only a data refetch.

### Field registry (`app/variables.py`)

Each field is a `dataclass Variable` with:
- `id` (e.g. `tp`), `label`, display `units` (e.g. `mm`)
- `kind`: `accum` (accumulated since the start of the run: allows total/interval modes), `instant` (e.g. T2m, wind: value at the time only), `vector` (u/v: two components, for the future wind)
- per model, how to select the field in the GRIB: `gfs=GribSelector(var="APCP", level="surface", step_range_prefix="0-")`, `ecmwf=GribSelector(param="tp", levtype="sfc")`
- `convert`: function GRIB unit → display unit (ECMWF tp: m → mm; T2m: K → °C)
- `scale`: legend thresholds and colours, plus `transparent_below`
- `steps`: optional, if the field has a different time availability

The initial registry contains only `tp`. Adding a field = adding an entry to the registry (plus possibly a test with a fixture). The GRIB selectors feed directly the `var_*`/`lev_*` parameters of the NOMADS filter and the match on the ECMWF `.index` lines, so fetching does not change.

### Configurable area (`app/config.py`)

- `BBOX` read from the env `BBOX="lat_min,lat_max,lon_min,lon_max"` (default `42,49,4,17`), validated at startup.
- From `BBOX` derive: the `toplat/bottomlat/leftlon/rightlon` parameters of the NOMADS filter, the ECMWF crop indices (handling the case where the box crosses the 0 meridian, with the GRIB's 0–360 longitudes: the west and east slices are concatenated), the overlay bounds and the map's `maxBounds`/initial centre.
- The frontend **contains no coordinates**: it reads grid and bounds from `/api/meta` and from `grid` in each `/api/field` response.
- Stored data include the box in `meta.json`; if at startup the configured `BBOX` differs from that of the data on disk, the run is discarded and downloaded again (the storage namespace includes a hash of the box, see `store.py`).

## Decisions

- **Stack**: Python backend (FastAPI + uvicorn, `eccodes` from pip with the binary library included, numpy, httpx, APScheduler). Static vanilla JS frontend + Leaflet 1.9 from a CDN, no build step. A single process serves API and frontend: on Railway it becomes a single service.
- **Initial domain**: lat 42–49 N, lon 4–17 E, configurable via `BBOX` (see above).
- **Models**: `gfs` (0.25°) and `ecmwf` (0.1°). Runs: GFS 00/06/12/18, ECMWF only 00/12 (the 06/18 do not reach 192h). Local retention: last 3 runs per model.
- **Steps shared** by both models to have a consistent slider when comparing: 3,6,…,144 then 150,156,…,192 (56 steps). GFS would also have 3h between 144 and 192: they are discarded.
- **The server stores only the totals since the start of the run**; the interval is the difference between the total at the step and the one at the previous step, computed by the server on request (`mode=interval`).
- **Client-side rendering** on canvas: the grids are small (GFS 53×29, ECMWF 131×71 ≈ 9,300 values ≈ 40 KB of gzipped JSON), so no server-side PNG tiles. This allows a point tooltip, colour scale and adjustable opacity without regenerating images.

## Project structure

```
weathermaps/
  app/
    __init__.py
    config.py        BBOX (from env), STEPS, DATA_DIR (env, default ./data), RETENTION=3, URL template
    variables.py     Variable registry (see above); initially only `tp`
    grid.py          decode_grib(bytes) -> list[Field] ; crop(field, bbox) ; select(fields, selector)
    sources/gfs.py   url(run, step, selector), fetch(run, step, variable) -> Field
    sources/ecmwf.py index + byte-range fetch per selector, global crop ; fetch(run, step, variable)
    store.py         save/load per (model, run, variable, step) in
                     DATA_DIR/{bbox_hash}/{model}/{run}/{var}/{step}.npy + meta.json ;
                     list_runs() ; purge(retention)
    fetcher.py       update_model(model): for each candidate run and each registry variable
                     downloads the missing steps idempotently, with retry/backoff, sequentially
    scheduler.py     APScheduler: job every 10 min per model, run at startup
    api.py           /api/* routes
    main.py          creates FastAPI, GZipMiddleware, mounts static, starts the scheduler
  static/
    index.html  app.js  style.css
  tests/
    fixtures/ (gfs_f024.grb, ec_tp24.grb, ec01_tp24.grb)
    test_grid.py  test_api.py
  scripts/fetch_once.py    fills DATA_DIR for the latest available run, then exits
  requirements.txt  Dockerfile  railway.json  .env.example  .gitignore  README.md
```

## Backend: details

### `grid.py`
- `decode_grib(data: bytes) -> list[Field]`: iterates the messages with `eccodes.codes_new_from_message`, reads `shortName`, `stepRange`, `units`, `Ni`, `Nj`, lat/lon of the first point and increments, scanning flags; rebuilds `values.reshape(Nj, Ni)` and always normalises to **increasing lat (south→north), increasing lon**. Converts `m` → mm (×1000). Also returns `step_range`.
- `crop(field, bbox)`: index slicing, handling the ECMWF 0–360 lon (the 4–17 E box does not cross the 0 meridian, so `lon_idx = round(lon/0.1)` is enough).
- `select_total(fields)`: picks the message whose `stepRange` starts with `0-` (GFS has two).

### `sources/gfs.py`
- Builds the NOMADS URL verified above; `fFFF` with three digits.
- `run_available(run)`: HEAD/GET on the step-192 file (if present, the run is complete up to 192h). A more responsive alternative: download the steps as they appear; this one is adopted (fetch of the missing steps, the run becomes "complete" when all 56 steps are there; the API also exposes partial runs with the list of steps present).
- No field in the file = NOMADS returns an HTML error: check that the first 4 bytes are `GRIB`.

### `sources/ecmwf.py`
- Downloads `.index`, finds the line with `"param": "tp"`, does a GET with the header `Range: bytes=off-(off+len-1)`, checks 206 and the first bytes `GRIB`.
- Global 0.1° crop to the box: columns 40–170, rows matching lat 42–49 after the south→north normalisation.
- 404 on the index = step not published yet: not an error, retried at the next round.

### `store.py`
- `DATA_DIR/{model}/{YYYYMMDDHH}/{step:03d}.npy` (float32 mm) + `DATA_DIR/{model}/{YYYYMMDDHH}/meta.json` with grid (lat0, lon0, dlat, dlon, nx, ny), steps present, timestamp.
- `purge()`: keeps the last 3 runs per model.

### `fetcher.py` / `scheduler.py`
- Candidate runs = last 3 model cycles computed from `now UTC` (GFS every 6h, ECMWF every 12h) starting from ~4h (GFS) and ~8h (ECMWF 0.1°) after the run time.
- For each candidate run it downloads the missing steps in sequence (gentle with NOMADS), at most 2–3 attempts with backoff, 30 s timeout. A lock prevents overlapping jobs.
- Job at server startup (in the background, the server answers right away) and then every 10 minutes. Can be disabled with `SCHEDULER_ENABLED=0` (useful in tests).

### `api.py`
- `GET /api/health` → `{ok: true}` (Railway healthcheck).
- `GET /api/meta` → `{ bbox, steps, models:[{id,label,resolution}], variables:[{id,label,units,kind,scale,modes}] }`: the frontend builds selectors, legend and bounds from here, without hard-wired constants.
- `GET /api/runs` → `{ gfs: [{run, variables:{tp:{steps:[...], complete}}}], ecmwf: [...] }`, newest first.
- `GET /api/field?model=gfs|ecmwf&var=tp&run=YYYYMMDDHH&step=24&mode=total|interval` → `{model, var, run, step, prev_step, valid_time, mode, units, grid:{lat0,lon0,dlat,dlon,nx,ny}, values:[...]}` row-major south→north, values rounded to the variable's precision, `null` where missing. `mode` allowed only for `accum` variables; `interval` = total(step) − total(previous step in the shared list), clamped to ≥0. 404 if the step is not there yet, 400 if var/mode are invalid.
- Cache-Control: `max-age=600` on `/api/runs`, long `immutable` on `/api/field` (the data of a run do not change).

### `main.py`
- `GZipMiddleware`, `StaticFiles` on `/` with `index.html`, port from the `PORT` env (Railway), default 8000.

## Frontend: details (`static/`)

- **Bootstrap**: on load it reads `/api/meta` and `/api/runs`; from there it fills the model selector, the field selector (hidden while there is a single entry), the legend (thresholds/colours of the variable's `scale`), the allowed modes (`modes`), bounds and centre of the map. No coordinates, thresholds or variable names written in the JS.
- **Leaflet map** centred on the box received from `/api/meta`, `maxBounds` slightly wider than the box. Two basemaps selectable with `L.control.layers`: standard OSM (places, roads) and OpenTopoMap (relief + places), both with correct attribution.
- **Overlay**: canvas rendered client-side and shown as an `L.imageOverlay` with bounds taken from the response's `grid` (today `[[42,4],[49,17]]`). To avoid Mercator distortion over the 7° of latitude, the image is generated with a pixel height proportional to the projection: for each canvas row the lat is computed with the inverse Mercator between 42 and 49 and the matching grid row is sampled. ×4 upscale with manual bilinear interpolation for a smooth but faithful look ("sharp cells" option in the menu). Opacity slider (default 0.55). Pixels with a value below 0.1 mm fully transparent so the terrain stays visible where it does not rain.
- **Colour scale** defined by the variable (`scale` in `/api/meta`), discrete, with a legend. For `tp`: 0.1–1, 1–2, 2–5, 5–10, 10–20, 20–30, 30–50, 50–75, 75–100, 100–150, 150–200, >200 mm. The renderer is generic: it receives thresholds, colours and `transparent_below`, so a future field (e.g. T2m with a diverging scale) does not require changes to the drawing code.
- **Controls** (panel top left): model selector (GFS 0.25° / ECMWF 0.1°), run selector (from `/api/runs`, default the most recent complete one), step slider with ◀ ▶ buttons, keyboard arrows and Play/Pause (~600 ms per frame), Total / Interval toggle, opacity slider. Text with the valid time in local time (Europe/Rome) and UTC, and the interval width (3h or 6h).
- **Tooltip** on `mousemove`: value in mm of the grid point nearest to the cursor (nearest neighbour on the native grid, not on the interpolated image), with lat/lon. Shows "—" outside the box.
- **Client cache** `Map` per (model, run, step, mode) and prefetch of the next and previous step, so scrolling is instantaneous.
- State (model, field, run, step, mode, opacity, basemap) in the URL hash to be able to share a view.

## How to extend it later (operational reminder)

- **New field**: add a `Variable` in `app/variables.py` with GFS/ECMWF selectors, unit conversion and colour scale; add a GRIB fixture and a test in `tests/test_grid.py`. The fetcher downloads it at the next round, the API exposes it, the frontend shows the field selector. Note for the future: `instant` variables have no interval mode; `vector` ones (wind) will need a dedicated renderer (arrows or barbs), planned as a second layer type next to the coloured-cells one.
- **New area**: change `BBOX` in the env (local: `.env`; Railway: service variable) and restart; old data stay in a separate folder per hash and are removed by the purge. The frontend adapts by itself. Constraints: the box must lie inside the model grid (global, so always) and the size of the ECMWF 0.1° grid grows with the area (10,000 points per 10°×10°: up to about 30°×30° the JSON per step stays below 1 MB gzipped; beyond that, consider binary float16 or tiles).

## Deploy

- **Local**: `python -m venv .venv && pip install -r requirements.txt`, `python scripts/fetch_once.py` to fill the data, `uvicorn app.main:app --reload`, open `http://localhost:8000`.
- **Docker/Railway**: `Dockerfile` from `python:3.12-slim`, `pip install -r requirements.txt` (the `eccodes` wheel includes the library), `CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT`. `railway.json` with `healthcheckPath: /api/health`. Variables: `DATA_DIR=/data` with a Railway volume mounted on `/data` (otherwise the data are regenerated on restart in ~10–15 minutes, acceptable even without a volume). `git init` of the project for deploying from the repo.

## Verification

1. **Unit tests** (`pytest`): `test_grid.py` decodes the fixtures and checks shape (GFS 53×29; ECMWF 0.1° cropped 131×71), orientation (increasing lat), units (ECMWF converted to mm, plausible max values), choice of the `0-N` message on GFS; a crop test with a different `BBOX` (e.g. `44,47,6,12`) and one with a box crossing the 0 meridian (e.g. `40,50,-5,10`) on the global ECMWF GRIB. `test_api.py` with `TestClient` and a temporary `DATA_DIR` filled from the fixtures: `/api/meta`, `/api/runs`, `/api/field` total and interval, 404 on a missing step, 400 on an unknown `var`; a test that registers a second fake `Variable` and checks that it appears in `/api/meta` without other changes.
2. **Real fetch**: `python scripts/fetch_once.py` on the latest available run of both models, checking that `DATA_DIR` contains 56 files per run and that the log shows no errors.
3. **Point comparison**: for one step, compare the value returned by `/api/field` at a point (e.g. Milan 45.46N 9.19E) with `grib_get -l 45.46,9.19,1` on the original GRIB, tolerance 0.1 mm.
4. **Browser** (claude-in-chrome): open `http://localhost:8000`, check the overlay is aligned with the borders (Lake Garda, Ligurian coast as visual references), change model/run/step/mode, tooltip, opacity, basemap, play; console without errors.
5. **Docker**: `docker build` + `docker run -p 8000:8000 -e PORT=8000` and repeat point 4 against the container, before deploying to Railway.
