"""Serie temporali di una località (meteogramma): i valori di ogni grandezza a ogni passo, in un punto.

Il sito statico non può leggere un punto da tutte le mappe di una corsa (decine di MB per i modelli fini), quindi
la build prepara le serie su una griglia regolare, divise in riquadri di 2°×2°: il browser scarica solo il riquadro
della località. Sul server lo stesso risultato si ottiene con `point_series`, dai campi salvati.

Griglia: 0,1° (~10 km, interpolata) per i modelli globali (GFS, ECMWF a 0,25°); 0,05° (~5 km) con il valore della
cella più vicina per i modelli ad alta risoluzione (1–2,5 km): in montagna la neve e la pioggia cambiano molto in
pochi km e il grafico deve dare lo stesso valore del tooltip della mappa, che legge la cella più vicina.

Per contenere i file i valori sono interi scalati (vedi SCALE): es. la pioggia in decimi di mm. Le grandezze sono
quelle del meteogramma: pioggia, temperatura a 850 hPa, zero termico, vento a 10 m.
"""
from __future__ import annotations

import math

import numpy as np

from .config import BBox
from .mean import bilinear
from .store import Store

DSTEP = 0.1  # passo della griglia delle serie dei modelli globali, gradi
FINE_DSTEP = 0.05  # modelli ad alta risoluzione
COARSE = {"gfs", "ecmwf"}  # griglia nativa a 0,25°: basta lo 0,1° interpolato
TILE = 2.0  # lato dei riquadri, gradi
# grandezze del meteogramma e fattore per salvarle come interi (valore = intero / fattore)
SCALE = {"tp": 10, "sf": 10, "t850": 10, "hzero": 0.1, "u10": 1, "v10": 1}  # sf: neve (cm), colora le barre della pioggia


def dstep_for(model: str) -> float:
    return DSTEP if model in COARSE else FINE_DSTEP


def grid(bbox: BBox, dstep: float = DSTEP) -> tuple[np.ndarray, np.ndarray]:
    lats = bbox.lat_min + np.arange(int(round((bbox.lat_max - bbox.lat_min) / dstep)) + 1) * dstep
    lons = bbox.lon_min + np.arange(int(round((bbox.lon_max - bbox.lon_min) / dstep)) + 1) * dstep
    return lats, lons


def nearest(values: np.ndarray, grid: dict, tlats: np.ndarray, tlons: np.ndarray) -> np.ndarray:
    """Valore della cella più vicina (come il tooltip della mappa); NaN fuori dalla griglia."""
    ny, nx = values.shape
    iy = np.rint((tlats - grid["lat0"]) / grid["dlat"]).astype(int)
    ix = np.rint((tlons - grid["lon0"]) / grid["dlon"]).astype(int)
    vy, vx = (iy >= 0) & (iy < ny), (ix >= 0) & (ix < nx)
    out = values[np.ix_(np.clip(iy, 0, ny - 1), np.clip(ix, 0, nx - 1))].astype(np.float32)
    out[~vy, :] = np.nan
    out[:, ~vx] = np.nan
    return out


def sample(model: str, values: np.ndarray, grid: dict, tlats: np.ndarray, tlons: np.ndarray) -> np.ndarray:
    return (bilinear if model in COARSE else nearest)(values, grid, tlats, tlons)


def tile_of(bbox: BBox, lat: float, lon: float) -> tuple[int, int]:
    return int(math.floor((lat - bbox.lat_min) / TILE)), int(math.floor((lon - bbox.lon_min) / TILE))


def _encode(var: str, values: np.ndarray) -> list:
    k = SCALE[var]
    out = np.round(values * k)
    return [None if v != v else int(v) for v in out.ravel().tolist()]


def build_tiles(store: Store, model: str, run: str) -> dict[tuple[int, int], dict]:
    """Riquadri delle serie di una corsa: {(riga, colonna): json}. Ogni grandezza ha i suoi passi; i valori sono
    disposti cella per cella (tutti i passi di una cella sono contigui), righe da sud, colonne da ovest."""
    dstep = dstep_for(model)
    lats, lons = grid(store.bbox, dstep)
    cube: dict[str, tuple[list[int], np.ndarray]] = {}
    for var in SCALE:
        steps = store.steps(model, run, var)
        if not steps:
            continue
        arr = np.full((len(steps), len(lats), len(lons)), np.nan, dtype=np.float32)
        for i, s in enumerate(steps):
            values, g = store.load(model, run, var, s)
            arr[i] = sample(model, values, g, lats, lons)
        cube[var] = (steps, arr)
    if not cube:
        return {}
    per = int(round(TILE / dstep))
    tiles = {}
    for ty in range(0, len(lats), per):
        for tx in range(0, len(lons), per):
            ys, xs = slice(ty, ty + per), slice(tx, tx + per)
            ny, nx = len(lats[ys]), len(lons[xs])
            body = {"lat0": round(float(lats[ty]), 4), "lon0": round(float(lons[tx]), 4), "dstep": dstep,
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
    lats, lons = grid(store.bbox, dstep_for(model))
    iy, ix = int(np.abs(lats - lat).argmin()), int(np.abs(lons - lon).argmin())
    out = {"lat": round(float(lats[iy]), 4), "lon": round(float(lons[ix]), 4), "vars": {}}
    for var in SCALE:
        steps = store.steps(model, run, var)
        if not steps:
            continue
        vals = []
        for s in steps:
            values, g = store.load(model, run, var, s)
            v = sample(model, values, g, lats[iy:iy + 1], lons[ix:ix + 1])[0, 0]
            k = SCALE[var]
            vals.append(None if v != v else round(float(v) * k) / k)
        out["vars"][var] = {"steps": steps, "values": vals}
    return out
