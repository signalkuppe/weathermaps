"""Time series of a place (meteogram): the values of each field at each step, at one point.

Two grids, each split into tiles of cells (`layers`):

- "native": precipitation and snow in the nearest model cell, on the same grid as the map. Chart and map tooltip
  read the same cell and give the same number (in the mountains precipitation and snow change a lot within a few
  km, and a point of another grid 2-3 km away easily ended up on another slope).
- "smooth": temperature at 850 hPa, freezing level and wind, which change smoothly, on a regular grid of 0.1°
  (interpolated, global models) or 0.05° (nearest cell, high resolution): on the model grid they would weigh twice
  as much as precipitation without changing the chart, and the static site must stay under 1 GB.

The static site cannot read a point from all the maps of a run, so the build prepares the tiles in the compact
format of app/packed.py: the browser downloads only those of the place. The grids of each run go into runs.json
(`series`), so the browser knows which tile and which cell to read. On the server the same result comes from
`point_series`, from the stored fields.

Values are scaled integers (see SCALE): e.g. precipitation in tenths of mm. The fields are those of the
meteogram: precipitation, snow, temperature at 850 hPa, freezing level, wind at 10 m.
"""
from __future__ import annotations

import math

import numpy as np

from .mean import bilinear
from .store import Store

# meteogram fields and the factor to store them as integers (value = integer / factor)
SCALE = {"tp": 10, "sf": 10, "t850": 10, "hzero": 0.1, "u10": 1, "v10": 1}  # sf: snow (cm), colours the precipitation bars
GRID_KEYS = ("lat0", "lon0", "dlat", "dlon", "ny", "nx")
NATIVE = ("tp", "sf")  # in the map cell; the others on the regular grid
DSTEP = 0.1  # regular grid of the global models (GFS, ECMWF at 0.25°): interpolated
FINE_DSTEP = 0.05  # high resolution: nearest cell (mountain peaks are kept)
COARSE = {"gfs", "ecmwf"}
TILE = 2.0  # side of the regular-grid tiles, degrees


def block_for(grid: dict) -> int:
    """Cells per tile side: 32 on fine grids (~0.6°, a few hundred kB), 8 on 0.25° grids."""
    return 32 if max(grid["dlat"], grid["dlon"]) < 0.1 else 8


def cell_of(grid: dict, lat: float, lon: float) -> tuple[int, int] | None:
    """Nearest cell (row, column), with the same rounding as the map tooltip (valueAt in app.js)."""
    iy = math.floor((lat - grid["lat0"]) / grid["dlat"] + 0.5)
    ix = math.floor((lon - grid["lon0"]) / grid["dlon"] + 0.5)
    if not (0 <= iy < grid["ny"] and 0 <= ix < grid["nx"]):
        return None
    return iy, ix


def _same_grid(a: dict, b: dict) -> bool:
    return all(abs(a[k] - b[k]) < 1e-9 for k in GRID_KEYS)


def _on_grid(values: np.ndarray, g: dict, grid: dict) -> np.ndarray:
    """Field brought onto the series grid (nearest cell): only needed if a field has a grid of its own."""
    if _same_grid(g, grid):
        return values
    lats = grid["lat0"] + np.arange(grid["ny"]) * grid["dlat"]
    lons = grid["lon0"] + np.arange(grid["nx"]) * grid["dlon"]
    iy = np.floor((lats - g["lat0"]) / g["dlat"] + 0.5).astype(int)
    ix = np.floor((lons - g["lon0"]) / g["dlon"] + 0.5).astype(int)
    out = values[np.ix_(np.clip(iy, 0, g["ny"] - 1), np.clip(ix, 0, g["nx"] - 1))].astype(np.float32)
    out[(iy < 0) | (iy >= g["ny"]), :] = np.nan
    out[:, (ix < 0) | (ix >= g["nx"])] = np.nan
    return out


def native_grid(store: Store, model: str, run: str) -> dict | None:
    """The model grid in this run (the precipitation one, the main map field)."""
    for var in NATIVE:
        steps = store.steps(model, run, var)
        if steps:
            _, g = store.load(model, run, var, steps[0])
            grid = {k: g[k] for k in GRID_KEYS}
            return {**grid, "block": block_for(grid)}
    return None


def smooth_grid(store: Store, model: str) -> dict:
    d = DSTEP if model in COARSE else FINE_DSTEP
    b = store.bbox
    ny = int(round((b.lat_max - b.lat_min) / d)) + 1
    nx = int(round((b.lon_max - b.lon_min) / d)) + 1
    return {"lat0": b.lat_min, "lon0": b.lon_min, "dlat": d, "dlon": d, "ny": ny, "nx": nx,
            "block": int(round(TILE / d))}


def _sample(model: str, values: np.ndarray, g: dict, grid: dict) -> np.ndarray:
    """Field on a series grid: nearest cell, or bilinear for the global models on the regular grid."""
    if model in COARSE and not _same_grid(g, grid):
        lats = grid["lat0"] + np.arange(grid["ny"]) * grid["dlat"]
        lons = grid["lon0"] + np.arange(grid["nx"]) * grid["dlon"]
        return bilinear(values, g, lats, lons)
    return _on_grid(values, g, grid)


def layers(store: Store, model: str, run: str) -> dict[str, tuple[dict, tuple[str, ...]]]:
    """The series grids of a run and the fields of each: {name: (grid, fields)}."""
    out = {}
    g = native_grid(store, model, run)
    if g:
        out["native"] = (g, NATIVE)
    out["smooth"] = (smooth_grid(store, model), tuple(v for v in SCALE if v not in NATIVE))
    return out


def _encode(var: str, values: np.ndarray) -> list:
    k = SCALE[var]
    out = np.round(values * k)
    return [None if v != v else int(v) for v in out.ravel().tolist()]


def build_tiles(store: Store, model: str, run: str) -> tuple[dict, dict[tuple[str, int, int], dict]]:
    """Series grids and tiles of a run: ({name: grid}, {(name, row, column): tile}). Each
    field has its own steps; values are laid out cell by cell (all steps of a cell are contiguous),
    rows from the south, columns from the west. Tiles without any value (outside the model domain) are not written."""
    grids, tiles = {}, {}
    for name, (grid, names) in layers(store, model, run).items():
        cube: dict[str, tuple[list[int], np.ndarray]] = {}
        for var in names:
            steps = store.steps(model, run, var)
            if not steps:
                continue
            arr = np.full((len(steps), grid["ny"], grid["nx"]), np.nan, dtype=np.float32)
            for i, s in enumerate(steps):
                values, g = store.load(model, run, var, s)
                arr[i] = _sample(model, values, g, grid)
            cube[var] = (steps, arr)
        if not cube:
            continue
        grids[name] = grid
        b = grid["block"]
        for ty in range(0, grid["ny"], b):
            for tx in range(0, grid["nx"], b):
                ys, xs = slice(ty, ty + b), slice(tx, tx + b)
                body = {"ny": len(range(grid["ny"])[ys]), "nx": len(range(grid["nx"])[xs]), "vars": {}}
                empty = True
                for var, (steps, arr) in cube.items():
                    blk = arr[:, ys, xs]  # steps × rows × columns
                    if np.isfinite(blk).any():
                        empty = False
                    # cell by cell: (rows × columns) × steps
                    body["vars"][var] = {"scale": SCALE[var], "steps": steps,
                                         "values": _encode(var, np.moveaxis(blk, 0, -1))}
                if not empty:
                    tiles[(name, ty // b, tx // b)] = body
    return grids, tiles


def point_series(store: Store, model: str, run: str, lat: float, lon: float) -> dict:
    """Series at the point, same result as the tiles. Position: the precipitation cell (the map's)."""
    out = {"lat": lat, "lon": lon, "vars": {}}
    for name, (grid, names) in layers(store, model, run).items():
        cell = cell_of(grid, lat, lon)
        if cell is None:
            continue
        iy, ix = cell
        if name == "native":
            out["lat"] = round(grid["lat0"] + iy * grid["dlat"], 4)
            out["lon"] = round(grid["lon0"] + ix * grid["dlon"], 4)
        one = {**grid, "lat0": grid["lat0"] + iy * grid["dlat"], "lon0": grid["lon0"] + ix * grid["dlon"],
               "ny": 1, "nx": 1}
        for var in names:
            steps = store.steps(model, run, var)
            if not steps:
                continue
            vals = []
            for s in steps:
                values, g = store.load(model, run, var, s)
                v = values[iy, ix] if _same_grid(g, grid) else _sample(model, values, g, one)[0, 0]
                k = SCALE[var]
                vals.append(None if v != v else round(float(v) * k) / k)
            out["vars"][var] = {"steps": steps, "values": vals}
    return out
