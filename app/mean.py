"""Model median (id "mean"), stored as one more model.

Models start at different hours and precipitation is accumulated from the start of each run,
so the median is built per valid time from a common time T0:

- each model uses its latest complete run starting no later than T0;
- T0 is the start of the most recent complete run, rounded to 6 hours
  (so GFS and ECMWF have the right steps beyond 144h too, where they are every 6 hours);
- accumulated fields (precipitation, snow): for each interval, the median of what fell in the interval among the
  available models, then the intervals are summed. Total and Interval stay consistent even when
  a short-range model (ICON-CH1, ICON-D2...) drops out of the median;
- instantaneous fields (temperature, freezing level): median of the values at that time.
- models with fewer steps (AIFS, every 6 hours): the accumulated total in a missing step is interpolated between
  the two around it (half of the 6 hours to the 3-hour step), so they enter every interval; instantaneous fields only
  at their own steps.

The median is not dragged by a single model far from the others; with only two
models it equals the mean.

All fields are interpolated (bilinearly) onto a common ~2 km grid.
"""
from __future__ import annotations

import json
import logging
import threading
import warnings
from datetime import timedelta

import numpy as np

from . import variables
from .config import STEPS, BBox
from .grid import Field
from .sources import ModelInfo, parse_run_id, run_id
from .store import Store

log = logging.getLogger("weathermaps.mean")

MODEL = ModelInfo(
    id="mean", base="mediana", label="Mediana modelli", resolution=0.02, cycles=tuple(range(24)), delay_hours=0, max_step=192,
    description=(
        "Mediana dei modelli disponibili per lo stesso istante, su una griglia comune di circa 2 km. "
        "Ogni modello usa la sua ultima corsa completa. Oltre l'orizzonte dei modelli ad alta "
        "risoluzione restano solo GFS ed ECMWF: in ogni passo, sotto, sono indicati i modelli usati."
    ),
)
TARGET_DLAT = 0.02
TARGET_DLON = 0.028
ALIGN_HOURS = 6
AREA_DSTEP = 0.25  # fields with their own area (synoptic chart): GFS and ECMWF grid

_lock = threading.Lock()


def bilinear(values: np.ndarray, grid: dict, tlats: np.ndarray, tlons: np.ndarray) -> np.ndarray:
    """Interpolates a field on a regular grid onto a regular grid (rows tlats, columns tlons)."""
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
    """Recomputes the median for each field with at least two models. Skips if the inputs have not changed."""
    if not _lock.acquire(blocking=False):
        return {"skipped": True}
    try:
        return _build(store or Store())
    finally:
        _lock.release()


# ICON-2I RUC is a newer run of ICON-2I: in the median it would count the same model twice
EXCLUDED = {"icon-2i-ruc"}


def _build(store: Store) -> dict:
    from .fetcher import latest_complete  # local import: avoids the cycle fetcher -> mean -> fetcher

    summary = {}
    bbox = store.bbox
    ny = int(round((bbox.lat_max - bbox.lat_min) / TARGET_DLAT)) + 1
    nx = int(np.floor((bbox.lon_max - bbox.lon_min) / TARGET_DLON + 1e-9)) + 1
    tlats = bbox.lat_min + np.arange(ny) * TARGET_DLAT
    tlons = bbox.lon_min + np.arange(nx) * TARGET_DLON

    # only the latest complete run of each model is kept: that is the one entering the median.
    # A single start time T0 for all fields (the most recent, rounded to 6 hours), so the median has a single
    # run; models started after T0 join from their first steps (negative offset).
    all_models = {m for var in variables.REGISTRY.values() for m in var.selectors} - EXCLUDED
    latest = {m: r for m in all_models if (r := latest_complete(store, m))}
    if not latest:
        return summary
    newest = max(parse_run_id(r) for r in latest.values())
    t0 = newest - timedelta(hours=newest.hour % ALIGN_HOURS)
    rid0 = run_id(t0)
    for var in variables.REGISTRY.values():
        chosen = {m: latest[m] for m in var.selectors if m in latest}
        if var.area:
            # synoptic chart (GFS and ECMWF only, same grid): on its own area, at 0.25° like the two models
            a = BBox.parse(var.area)
            vdlat = vdlon = AREA_DSTEP
            vlats = a.lat_min + np.arange(int(round((a.lat_max - a.lat_min) / vdlat)) + 1) * vdlat
            vlons = a.lon_min + np.arange(int(round((a.lon_max - a.lon_min) / vdlon)) + 1) * vdlon
        else:
            # common grid: for half-resolution fields (wind) one cell out of two per side
            k = 2 if var.half_res else 1
            vlats, vlons = tlats[::k], tlons[::k]
            vdlat, vdlon = TARGET_DLAT * k, TARGET_DLON * k
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

        def around(m: str, step: int) -> tuple[int, int] | None:
            """Steps of the member around a missing accumulated step (gap of at most 6 hours), or None."""
            before = max((x for x in have[m] if x < step), default=0)
            after = min((x for x in have[m] if x > step), default=None)
            if step <= 0 or after is None or after - before > 6:
                return None
            return before, after

        def has(m: str, step: int) -> bool:
            if step in have[m]:
                return True
            return var.kind == "accum" and around(m, step) is not None

        def member(m: str, step: int) -> np.ndarray:
            if step == 0:
                return np.zeros((len(vlats), len(vlons)), dtype=np.float32)
            key = (m, step)
            if key not in cache:
                if step in have[m]:
                    vals, grid = store.load(m, chosen[m], var.id, step)
                    cache[key] = bilinear(vals, grid, vlats, vlons)
                else:  # accumulated total between the two steps around it (see has)
                    a, b = around(m, step)
                    w = (step - a) / (b - a)
                    cache[key] = (member(m, a) * (1 - w) + member(m, b) * w).astype(np.float32)
            return cache[key]

        cum = np.zeros((len(vlats), len(vlons)), dtype=np.float32)
        ever = np.zeros((len(vlats), len(vlons)), dtype=bool)
        last = 0  # last step included in the sum (precipitation)
        written: dict[int, list[str]] = {}
        for s in [x for x in STEPS if x <= MODEL.max_step]:
            vals, used = [], []
            for m in chosen:
                if var.kind == "accum":
                    a, b = offset[m] + last, offset[m] + s
                    if has(m, b) and (a == 0 or has(m, a)):
                        vals.append(np.maximum(member(m, b) - member(m, a), 0))
                        used.append(m)
                else:
                    if offset[m] + s in have[m]:
                        vals.append(member(m, offset[m] + s))
                        used.append(m)
            if not vals:
                continue  # no model for this step: it flows into the next one
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # pixels outside all domains
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
                                                      dlat=vdlat, dlon=vdlon))
            written[s] = used

        # steps of a previous version that can no longer be computed
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
        log.info("Median %s %s: %d steps, models %s", var.id, rid0, len(written), chosen)

    store.purge_superseded("mean", {rid0})
    return summary


def members_info(store: Store, run: str, var: str) -> dict | None:
    path = store.var_dir("mean", run, var) / "members.json"
    return json.loads(path.read_text()) if path.exists() else None
