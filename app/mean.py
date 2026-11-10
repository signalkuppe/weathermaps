"""Mediana dei modelli (id "mean"), salvata come un modello in più.

I modelli partono a ore diverse e la pioggia è accumulata dall'inizio di ciascuna corsa,
quindi la mediana si costruisce per istante di validità a partire da un orario comune T0:

- per ogni modello si usa l'ultima corsa completa che parte non dopo T0;
- T0 è l'inizio della corsa completa più recente, arrotondato alle 6 ore
  (così GFS ed ECMWF hanno i passi giusti anche oltre le 144h, dove sono ogni 6 ore);
- grandezze accumulate (pioggia, neve): per ogni intervallo si fa la mediana di quanto è caduto nell'intervallo fra i modelli
  disponibili, poi si sommano gli intervalli. Totale e Intervallo restano coerenti anche quando
  un modello a breve scadenza (ICON-CH1, ICON-D2...) esce dalla mediana;
- grandezze istantanee (temperatura, zero termico): mediana dei valori all'istante.

La mediana non si lascia trascinare da un modello isolato molto diverso dagli altri; con due soli
modelli coincide con la media.

Tutti i campi vengono interpolati (bilineare) su una griglia comune di ~2 km.
"""
from __future__ import annotations

import json
import logging
import threading
import warnings
from datetime import timedelta

import numpy as np

from . import variables
from .config import STEPS
from .grid import Field
from .sources import ModelInfo, parse_run_id, run_id
from .store import Store

log = logging.getLogger("weathermaps.mean")

MODEL = ModelInfo(
    id="mean", label="Mediana modelli", resolution=0.02, cycles=tuple(range(24)), delay_hours=0, max_step=192,
    description=(
        "Mediana dei modelli disponibili per lo stesso istante, su una griglia comune di circa 2 km. "
        "Ogni modello usa la sua ultima corsa completa. Oltre l'orizzonte dei modelli ad alta "
        "risoluzione restano solo GFS ed ECMWF: in ogni passo, sotto, sono indicati i modelli usati."
    ),
)
TARGET_DLAT = 0.02
TARGET_DLON = 0.028
ALIGN_HOURS = 6

_lock = threading.Lock()


def bilinear(values: np.ndarray, grid: dict, tlats: np.ndarray, tlons: np.ndarray) -> np.ndarray:
    """Interpola un campo su griglia regolare verso una griglia regolare (righe tlats, colonne tlons)."""
    ny, nx = values.shape
    fy = (tlats - grid["lat0"]) / grid["dlat"]
    fx = (tlons - grid["lon0"]) / grid["dlon"]
    vy = (fy >= -1e-6) & (fy <= ny - 1 + 1e-6)
    vx = (fx >= -1e-6) & (fx <= nx - 1 + 1e-6)
    y0 = np.clip(np.floor(fy).astype(int), 0, max(ny - 2, 0))
    x0 = np.clip(np.floor(fx).astype(int), 0, max(nx - 2, 0))
    ty = np.clip(fy - y0, 0, 1)[:, None]
    tx = np.clip(fx - x0, 0, 1)[None, :]
    y1, x1 = np.minimum(y0 + 1, ny - 1), np.minimum(x0 + 1, nx - 1)
    a = values[np.ix_(y0, x0)]
    b = values[np.ix_(y0, x1)]
    c = values[np.ix_(y1, x0)]
    d = values[np.ix_(y1, x1)]
    out = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    out[~vy, :] = np.nan
    out[:, ~vx] = np.nan
    return out.astype(np.float32)


def build_mean(store: Store | None = None) -> dict:
    """Ricalcola la mediana per ogni grandezza con almeno due modelli. Salta se gli ingressi non sono cambiati."""
    if not _lock.acquire(blocking=False):
        return {"skipped": True}
    try:
        return _build(store or Store())
    finally:
        _lock.release()


def _build(store: Store) -> dict:
    from .fetcher import latest_complete  # import locale: evita il ciclo fetcher -> mean -> fetcher

    summary = {}
    bbox = store.bbox
    ny = int(round((bbox.lat_max - bbox.lat_min) / TARGET_DLAT)) + 1
    nx = int(np.floor((bbox.lon_max - bbox.lon_min) / TARGET_DLON + 1e-9)) + 1
    tlats = bbox.lat_min + np.arange(ny) * TARGET_DLAT
    tlons = bbox.lon_min + np.arange(nx) * TARGET_DLON

    # di ogni modello si tiene solo l'ultima corsa completa: è quella che entra nella mediana.
    # Un solo istante di partenza T0 per tutte le grandezze (la più recente arrotondata alle 6 ore), così la mediana
    # ha una sola corsa; i modelli partiti dopo T0 entrano dai loro primi passi (offset negativo).
    all_models = {m for var in variables.REGISTRY.values() for m in var.selectors}
    latest = {m: r for m in all_models if (r := latest_complete(store, m))}
    if not latest:
        return summary
    newest = max(parse_run_id(r) for r in latest.values())
    t0 = newest - timedelta(hours=newest.hour % ALIGN_HOURS)
    rid0 = run_id(t0)
    for var in variables.REGISTRY.values():
        chosen = {m: latest[m] for m in var.selectors if m in latest}
        # griglia comune: per le grandezze a metà risoluzione (vento) una cella su due per lato
        k = 2 if var.half_res else 1
        vlats, vlons = tlats[::k], tlons[::k]
        if len(chosen) < 2:
            continue
        have = {m: set(store.steps(m, r, var.id)) for m, r in chosen.items()}
        signature = {"method": "median", "members": chosen, "counts": {m: len(h) for m, h in have.items()}}

        mean_dir = store.var_dir("mean", rid0, var.id)
        info_path = mean_dir / "members.json"
        if info_path.exists() and json.loads(info_path.read_text()).get("signature") == signature:
            summary[var.id] = "invariata"
            continue

        offset = {m: int((t0 - parse_run_id(r)).total_seconds() // 3600) for m, r in chosen.items()}
        cache: dict[tuple[str, int], np.ndarray] = {}

        def member(m: str, step: int) -> np.ndarray:
            if step == 0:
                return np.zeros((len(vlats), len(vlons)), dtype=np.float32)
            key = (m, step)
            if key not in cache:
                vals, grid = store.load(m, chosen[m], var.id, step)
                cache[key] = bilinear(vals, grid, vlats, vlons)
            return cache[key]

        cum = np.zeros((len(vlats), len(vlons)), dtype=np.float32)
        ever = np.zeros((len(vlats), len(vlons)), dtype=bool)
        last = 0  # ultimo passo incluso nella somma (pioggia)
        written: dict[int, list[str]] = {}
        for s in [x for x in STEPS if x <= MODEL.max_step]:
            vals, used = [], []
            for m in chosen:
                if var.kind == "accum":
                    a, b = offset[m] + last, offset[m] + s
                    if b in have[m] and (a == 0 or a in have[m]):
                        vals.append(np.maximum(member(m, b) - member(m, a), 0))
                        used.append(m)
                else:
                    if offset[m] + s in have[m]:
                        vals.append(member(m, offset[m] + s))
                        used.append(m)
            if not vals:
                continue  # nessun modello per questo passo: confluisce nel successivo
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # pixel fuori da tutti i domini
                m_val = np.nanmedian(np.stack(vals), axis=0)
            if var.kind == "accum":
                ok = np.isfinite(m_val)
                cum = np.where(ok, cum + np.nan_to_num(m_val), cum)
                ever |= ok
                out = np.where(ever, cum, np.nan).astype(np.float32)
                last = s
            else:
                out = m_val.astype(np.float32)
            store.save("mean", rid0, var.id, s, Field(values=out, lat0=float(vlats[0]), lon0=float(vlons[0]),
                                                      dlat=TARGET_DLAT * k, dlon=TARGET_DLON * k))
            written[s] = used

        # passi di una versione precedente non più calcolabili
        for s in store.steps("mean", rid0, var.id):
            if s not in written:
                store.step_path("mean", rid0, var.id, s).unlink(missing_ok=True)
        mean_dir.mkdir(parents=True, exist_ok=True)
        info_path.write_text(json.dumps({
            "signature": signature,
            "members": chosen,
            "steps": {str(s): u for s, u in written.items()},
        }))
        summary[var.id] = f"{rid0}: {len(written)} passi da {len(chosen)} modelli"
        log.info("Mediana %s %s: %d passi, modelli %s", var.id, rid0, len(written), chosen)

    store.purge_superseded("mean", {rid0})
    return summary


def members_info(store: Store, run: str, var: str) -> dict | None:
    path = store.var_dir("mean", run, var) / "members.json"
    return json.loads(path.read_text()) if path.exists() else None
