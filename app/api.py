"""JSON endpoints."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from . import soundings, variables
from .config import STEPS, get_initial_view, get_version, prev_step
from . import fetcher
from . import mean as mean_mod
from . import ensemble
from . import series as series_mod
from .fetcher import MODELS, model_steps, steps_for
from .sources import parse_run_id
from .store import Store

router = APIRouter(prefix="/api")


def _store(request: Request) -> Store:
    return request.app.state.store


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/refresh")
def refresh_status(model: str):
    if model not in fetcher.SOURCES:
        raise HTTPException(400, f"Modello sconosciuto: {model}")
    return JSONResponse(fetcher.status(model), headers={"Cache-Control": "no-store"})


@router.post("/refresh")
def refresh(request: Request, model: str):
    """Checks right away whether new steps are out (instead of waiting for the scheduler)."""
    if model not in fetcher.SOURCES:
        raise HTTPException(400, f"Modello sconosciuto o non scaricabile: {model}")
    started, reason = fetcher.request_refresh(model, _store(request))
    return JSONResponse({**fetcher.status(model), "accepted": started, "reason": reason, "cooldown_s": fetcher.REFRESH_COOLDOWN_S}, headers={"Cache-Control": "no-store"})


@router.get("/meta")
def meta(request: Request):
    store = _store(request)
    return JSONResponse(
        {
            "bbox": store.bbox.as_dict(),
            "initial_view": get_initial_view(store.bbox).as_dict(),
            "steps": STEPS,
            "version": get_version(),
            # public key of the Thunderforest tiles ("Rilievo" basemap): it ends up in the page anyway
            "thunderforest_key": os.environ.get("THUNDERFOREST_KEY", "").strip(),
            # public Mapbox token (Streets/Outdoors basemaps, if any): restrict it to the site's domains in the Mapbox dashboard
            "mapbox_token": os.environ.get("MAPBOX_TOKEN", "").strip(),
            # browser error reporting (Sentry): empty = disabled. The DSN is public by nature
            "sentry_dsn": os.environ.get("SENTRY_DSN", "").strip(),
            # meteograms available (Grafico and Multimodel buttons); the series grids are in runs.json
            "series": {"layers": ["native", "smooth"]},
            # GFS and ECMWF ensembles for the place spaghetti plots on the synoptic chart ({model: ...})
            "ensemble": ensemble.info(store),
            "models": [m.as_dict() for m in MODELS.values()],
            "variables": variables.menu(),
        },
        headers={"Cache-Control": "max-age=300"},
    )


@router.get("/runs")
def runs(request: Request):
    """Per model: the run to show (the latest complete one) and, if any, the newer one still incoming
    (marked `incoming`: used only for the notice, its fields are neither shown nor published)."""
    store = _store(request)
    out: dict[str, list] = {}
    updated = 0.0  # last step written among the runs shown (the field folder changes at every step)
    for model_id in MODELS:
        all_runs = store.runs(model_id)
        current = all_runs[0] if model_id == "mean" and all_runs else fetcher.latest_complete(store, model_id)
        items = []
        if current:
            item = _run_item(store, model_id, current)
            if item:
                items.append(item)
                for var_id in item["variables"]:
                    try:
                        updated = max(updated, store.var_dir(model_id, current, var_id).stat().st_mtime)
                    except OSError:
                        pass
            newer = [rid for rid in all_runs if rid > current]
            if newer and model_id != "mean":
                item = _run_item(store, model_id, newer[0])
                if item:
                    items.append({**item, "incoming": True})
        out[model_id] = items
    headers = {"Cache-Control": "max-age=120"}
    if updated:  # like `generated_at` in the static site's runs.json: the time shown at the bottom of the panel
        headers["X-Updated-At"] = datetime.fromtimestamp(updated, timezone.utc).isoformat(timespec="seconds")
    return JSONResponse(out, headers=headers)


def _run_item(store: Store, model_id: str, rid: str) -> dict | None:
    vars_out = {}
    for var_id in store.variables(model_id, rid):
        if var_id not in variables.REGISTRY:
            continue
        expected = steps_for(variables.REGISTRY[var_id], model_id)
        have = store.steps(model_id, rid, var_id)
        if not have:
            continue
        info = {"steps": have, "complete": set(expected) <= set(have), "expected": len(expected)}
        if model_id == "mean":
            # the median is computed from complete runs: it is never "incoming"
            info["complete"] = True
            m = mean_mod.members_info(store, rid, var_id)
            info["members"] = (m or {}).get("members", {})
        vars_out[var_id] = info
    return {"run": rid, "variables": vars_out} if vars_out else None


def _round_list(values: np.ndarray, decimals: int) -> list:
    rounded = np.round(values.astype(np.float64), decimals)
    flat = rounded.ravel().tolist()
    return [None if v != v else v for v in flat]  # NaN -> null


@router.get("/series")
def series_point(request: Request, model: str, run: str, lat: float, lon: float):
    """Meteogram of a point: for each field the steps and the values (see app/series.py)."""
    if model not in MODELS:
        raise HTTPException(400, f"Modello sconosciuto: {model}")
    store = _store(request)
    if run not in store.runs(model):
        raise HTTPException(404, "Corsa non disponibile")
    return JSONResponse(series_mod.point_series(store, model, run, lat, lon), headers={"Cache-Control": "public, max-age=300"})


@router.get("/ensemble")
def ensemble_point(request: Request, model: str, lat: float, lon: float):
    """Ensemble spaghetti of `model` (gfs, ecmwf) at the nearest point: temperature at 850 hPa and precipitation."""
    data = ensemble.point_series(_store(request), model, lat, lon)
    if data is None:
        raise HTTPException(404, "Ensemble non disponibile")
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=300"})


@router.get("/soundings")
def soundings_index(request: Request):
    """Observed soundings: stations and available launches (app/soundings.py)."""
    return JSONResponse(soundings.index(_store(request)), headers={"Cache-Control": "public, max-age=300"})


@router.get("/sounding")
def sounding(request: Request, station: str, time: str):
    """One launch: levels [pressure, height, temperature, dew point, direction, speed km/h]."""
    data = soundings.load(_store(request), station, time)
    if data is None:
        raise HTTPException(404, "Radiosondaggio non disponibile")
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=3600"})


@router.get("/field")
def field(
    request: Request,
    model: str,
    run: str,
    step: int,
    var: str = "tp",
    mode: str | None = Query(None),
    prev: int | None = Query(None, description="intervallo: passo di partenza (default: il passo precedente)"),
):
    store = _store(request)
    if model not in MODELS:
        raise HTTPException(400, f"Modello sconosciuto: {model}")
    if var not in variables.REGISTRY:
        raise HTTPException(400, f"Grandezza sconosciuta: {var}")
    v = variables.REGISTRY[var]
    if mode is None:
        mode = v.modes[0]
    if mode not in v.modes:
        raise HTTPException(400, f"Modalità {mode!r} non valida per {var}; ammesse {v.modes}")
    if step not in STEPS:
        raise HTTPException(400, f"Passo non valido: {step}")
    try:
        run_dt = parse_run_id(run)
    except ValueError:
        raise HTTPException(400, f"Corsa non valida: {run}") from None

    try:
        values, grid = store.load(model, run, var, step)
    except FileNotFoundError:
        raise HTTPException(404, "Dato non (ancora) disponibile") from None

    # previous step of the model: for the AIFS (every 6 hours) the one 6 hours earlier
    own = model_steps(model)
    p = ([0] + own)[own.index(step)] if step in own else prev_step(step)
    if mode == "interval" and prev is not None:
        # 6, 12, 24-hour accumulations: difference with an earlier step (0 = since the start of the run)
        if prev != 0 and prev not in STEPS or prev >= step:
            raise HTTPException(400, f"Passo di partenza non valido: {prev}")
        p = prev
    if mode == "interval":
        if p > 0:
            try:
                prev_values, _ = store.load(model, run, var, p)
            except FileNotFoundError:
                raise HTTPException(404, "Passo precedente non disponibile") from None
            values = values - prev_values
        if v.nonnegative:
            values = np.where(np.isnan(values), values, np.maximum(values, 0))

    body = {
        "model": model,
        "var": var,
        "run": run,
        "step": step,
        "prev_step": p if mode == "interval" else 0,
        "run_time": run_dt.isoformat(),
        "valid_time": (run_dt + timedelta(hours=step)).isoformat(),
        "mode": mode,
        "units": v.units,
        "grid": grid,
        "max": None if np.all(np.isnan(values)) else round(float(np.nanmax(values)), v.decimals),
        "min": None if np.all(np.isnan(values)) else round(float(np.nanmin(values)), v.decimals),
        "values": _round_list(values, v.decimals),
    }
    cache = "public, max-age=86400, immutable"
    if model == "mean":
        info = mean_mod.members_info(store, run, var) or {}
        body["members"] = info.get("steps", {}).get(str(step), [])
        body["member_runs"] = info.get("members", {})
        cache = "public, max-age=300"  # the median is recomputed when new data arrive
    return JSONResponse(body, headers={"Cache-Control": cache})
