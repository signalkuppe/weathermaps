"""Serie temporali di una località (meteogramma): i valori di ogni grandezza a ogni passo, in un punto.

Il sito statico non può leggere un punto da tutte le mappe di una corsa (decine di MB per i modelli fini), quindi
la build prepara le serie su una griglia regolare di 0,1° (~10 km), divise in riquadri di 2°×2°: il browser scarica
solo il riquadro della località. Sul server lo stesso risultato si ottiene con `point_series`, dai campi salvati.

Per contenere i file i valori sono interi scalati (vedi SCALE): es. la pioggia in decimi di mm. Le grandezze sono
quelle del meteogramma: pioggia, temperatura a 850 hPa, zero termico, vento a 10 m.
"""
from __future__ import annotations

import math

import numpy as np

from .config import BBox
from .mean import bilinear
from .store import Store

DSTEP = 0.1  # passo della griglia delle serie, gradi
TILE = 2.0  # lato dei riquadri, gradi
# grandezze del meteogramma e fattore per salvarle come interi (valore = intero / fattore)
SCALE = {"tp": 10, "t850": 10, "hzero": 0.1, "u10": 1, "v10": 1}


def grid(bbox: BBox) -> tuple[np.ndarray, np.ndarray]:
    lats = bbox.lat_min + np.arange(int(round((bbox.lat_max - bbox.lat_min) / DSTEP)) + 1) * DSTEP
    lons = bbox.lon_min + np.arange(int(round((bbox.lon_max - bbox.lon_min) / DSTEP)) + 1) * DSTEP
    return lats, lons


def tile_of(bbox: BBox, lat: float, lon: float) -> tuple[int, int]:
    return int(math.floor((lat - bbox.lat_min) / TILE)), int(math.floor((lon - bbox.lon_min) / TILE))


def _encode(var: str, values: np.ndarray) -> list:
    k = SCALE[var]
    out = np.round(values * k)
    return [None if v != v else int(v) for v in out.ravel().tolist()]


def build_tiles(store: Store, model: str, run: str) -> dict[tuple[int, int], dict]:
    """Riquadri delle serie di una corsa: {(riga, colonna): json}. Ogni grandezza ha i suoi passi; i valori sono
    disposti cella per cella (tutti i passi di una cella sono contigui), righe da sud, colonne da ovest."""
    lats, lons = grid(store.bbox)
    cube: dict[str, tuple[list[int], np.ndarray]] = {}
    for var in SCALE:
        steps = store.steps(model, run, var)
        if not steps:
            continue
        arr = np.full((len(steps), len(lats), len(lons)), np.nan, dtype=np.float32)
        for i, s in enumerate(steps):
            values, g = store.load(model, run, var, s)
            arr[i] = bilinear(values, g, lats, lons)
        cube[var] = (steps, arr)
    if not cube:
        return {}
    per = int(round(TILE / DSTEP))
    tiles = {}
    for ty in range(0, len(lats), per):
        for tx in range(0, len(lons), per):
            ys, xs = slice(ty, ty + per), slice(tx, tx + per)
            ny, nx = len(lats[ys]), len(lons[xs])
            body = {"lat0": round(float(lats[ty]), 4), "lon0": round(float(lons[tx]), 4), "dstep": DSTEP,
                    "ny": ny, "nx": nx, "vars": {}}
            empty = True
            for var, (steps, arr) in cube.items():
                block = arr[:, ys, xs]  # passi × righe × colonne
                if np.isfinite(block).any():
                    empty = False
                # cella per cella: (righe × colonne) × passi
                body["vars"][var] = {"scale": SCALE[var], "steps": steps,
                                     "values": _encode(var, np.moveaxis(block, 0, -1))}
            if not empty:
                tiles[(ty // per, tx // per)] = body
    return tiles


def point_series(store: Store, model: str, run: str, lat: float, lon: float) -> dict:
    """Serie in un punto (punto della griglia delle serie più vicino), stesso risultato dei riquadri."""
    lats, lons = grid(store.bbox)
    iy, ix = int(np.abs(lats - lat).argmin()), int(np.abs(lons - lon).argmin())
    out = {"lat": round(float(lats[iy]), 4), "lon": round(float(lons[ix]), 4), "vars": {}}
    for var in SCALE:
        steps = store.steps(model, run, var)
        if not steps:
            continue
        vals = []
        for s in steps:
            values, g = store.load(model, run, var, s)
            v = bilinear(values, g, lats[iy:iy + 1], lons[ix:ix + 1])[0, 0]
            k = SCALE[var]
            vals.append(None if v != v else round(float(v) * k) / k)
        out["vars"][var] = {"steps": steps, "values": vals}
    return out
