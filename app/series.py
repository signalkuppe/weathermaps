"""Serie temporali di una località (meteogramma): i valori di ogni grandezza a ogni passo, in un punto.

Due griglie, ciascuna in riquadri di celle (`layers`):

- "native": pioggia e neve nella cella del modello più vicina, sulla stessa griglia della mappa. Grafico e tooltip
  della mappa leggono la stessa cella e danno lo stesso numero (in montagna pioggia e neve cambiano molto in pochi
  km, e un punto di un'altra griglia a 2-3 km di distanza finiva facilmente su un altro versante).
- "smooth": temperatura a 850 hPa, zero termico e vento, che cambiano dolcemente, su una griglia regolare di 0,1°
  (interpolata, modelli globali) o 0,05° (cella più vicina, alta risoluzione): sulla griglia del modello
  peserebbero il doppio della pioggia senza cambiare il grafico, e il sito statico deve stare sotto 1 GB.

Il sito statico non può leggere un punto da tutte le mappe di una corsa, quindi la build prepara i riquadri nel
formato compatto di app/packed.py: il browser scarica solo quelli della località. Le griglie di ogni corsa vanno in
runs.json (`series`), così il browser sa quale riquadro e quale cella leggere. Sul server lo stesso risultato si
ottiene con `point_series`, dai campi salvati.

I valori sono interi scalati (vedi SCALE): es. la pioggia in decimi di mm. Le grandezze sono quelle del
meteogramma: pioggia, neve, temperatura a 850 hPa, zero termico, vento a 10 m.
"""
from __future__ import annotations

import math

import numpy as np

from .mean import bilinear
from .store import Store

# grandezze del meteogramma e fattore per salvarle come interi (valore = intero / fattore)
SCALE = {"tp": 10, "sf": 10, "t850": 10, "hzero": 0.1, "u10": 1, "v10": 1}  # sf: neve (cm), colora le barre della pioggia
GRID_KEYS = ("lat0", "lon0", "dlat", "dlon", "ny", "nx")
NATIVE = ("tp", "sf")  # nella cella della mappa; le altre sulla griglia regolare
DSTEP = 0.1  # griglia regolare dei modelli globali (GFS, ECMWF a 0,25°): interpolata
FINE_DSTEP = 0.05  # alta risoluzione: cella più vicina (i picchi in montagna restano)
COARSE = {"gfs", "ecmwf"}
TILE = 2.0  # lato dei riquadri della griglia regolare, gradi


def block_for(grid: dict) -> int:
    """Celle per lato di un riquadro: 32 sulle griglie fini (~0,6°, qualche centinaio di kB), 8 su quelle a 0,25°."""
    return 32 if max(grid["dlat"], grid["dlon"]) < 0.1 else 8


def cell_of(grid: dict, lat: float, lon: float) -> tuple[int, int] | None:
    """Cella più vicina (riga, colonna), con lo stesso arrotondamento del tooltip della mappa (valueAt in app.js)."""
    iy = math.floor((lat - grid["lat0"]) / grid["dlat"] + 0.5)
    ix = math.floor((lon - grid["lon0"]) / grid["dlon"] + 0.5)
    if not (0 <= iy < grid["ny"] and 0 <= ix < grid["nx"]):
        return None
    return iy, ix


def _same_grid(a: dict, b: dict) -> bool:
    return all(abs(a[k] - b[k]) < 1e-9 for k in GRID_KEYS)


def _on_grid(values: np.ndarray, g: dict, grid: dict) -> np.ndarray:
    """Campo portato sulla griglia della serie (cella più vicina): serve solo se una grandezza ha una griglia sua."""
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
    """Griglia del modello in questa corsa (quella della pioggia, la grandezza della mappa principale)."""
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
    """Campo sulla griglia di una serie: cella più vicina, o bilineare per i globali sulla griglia regolare."""
    if model in COARSE and not _same_grid(g, grid):
        lats = grid["lat0"] + np.arange(grid["ny"]) * grid["dlat"]
        lons = grid["lon0"] + np.arange(grid["nx"]) * grid["dlon"]
        return bilinear(values, g, lats, lons)
    return _on_grid(values, g, grid)


def layers(store: Store, model: str, run: str) -> dict[str, tuple[dict, tuple[str, ...]]]:
    """Le griglie delle serie di una corsa e le grandezze di ciascuna: {nome: (griglia, grandezze)}."""
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
    """Griglie e riquadri delle serie di una corsa: ({nome: griglia}, {(nome, riga, colonna): riquadro}). Ogni
    grandezza ha i suoi passi; i valori sono disposti cella per cella (tutti i passi di una cella sono contigui),
    righe da sud, colonne da ovest. I riquadri senza nessun valore (fuori dal dominio del modello) non si scrivono."""
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
                    blk = arr[:, ys, xs]  # passi × righe × colonne
                    if np.isfinite(blk).any():
                        empty = False
                    # cella per cella: (righe × colonne) × passi
                    body["vars"][var] = {"scale": SCALE[var], "steps": steps,
                                         "values": _encode(var, np.moveaxis(blk, 0, -1))}
                if not empty:
                    tiles[(name, ty // b, tx // b)] = body
    return grids, tiles


def point_series(store: Store, model: str, run: str, lat: float, lon: float) -> dict:
    """Serie nel punto, stesso risultato dei riquadri. Posizione: la cella della pioggia (quella della mappa)."""
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
