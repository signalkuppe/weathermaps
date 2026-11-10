"""Endpoint JSON."""
from __future__ import annotations

from datetime import timedelta

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from . import variables
from .config import STEPS, get_initial_view, get_version, prev_step
from . import fetcher
from . import mean as mean_mod
from .fetcher import MODELS, steps_for
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
    """Controlla subito se sono usciti nuovi passi (invece di aspettare lo scheduler)."""
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
            "models": [m.as_dict() for m in MODELS.values()],
            "variables": variables.menu(),
        },
        headers={"Cache-Control": "max-age=300"},
    )


@router.get("/runs")
def runs(request: Request):
    """Per modello: la corsa da mostrare (l'ultima completa) e, se c'è, quella più nuova ancora in arrivo
    (marcata `incoming`: serve solo per l'avviso, i suoi campi non si mostrano né si pubblicano)."""
    store = _store(request)
    out: dict[str, list] = {}
    for model_id in MODELS:
        all_runs = store.runs(model_id)
        current = all_runs[0] if model_id == "mean" and all_runs else fetcher.latest_complete(store, model_id)
        items = []
        if current:
            item = _run_item(store, model_id, current)
            if item:
                items.append(item)
            newer = [rid for rid in all_runs if rid > current]
            if newer and model_id != "mean":
                item = _run_item(store, model_id, newer[0])
                if item:
                    items.append({**item, "incoming": True})
        out[model_id] = items
    return JSONResponse(out, headers={"Cache-Control": "max-age=120"})


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
            # la mediana è calcolata da corse complete: non è mai "in arrivo"
            info["complete"] = True
            m = mean_mod.members_info(store, rid, var_id)
            info["members"] = (m or {}).get("members", {})
        vars_out[var_id] = info
    return {"run": rid, "variables": vars_out} if vars_out else None


def _round_list(values: np.ndarray, decimals: int) -> list:
    rounded = np.round(values.astype(np.float64), decimals)
    flat = rounded.ravel().tolist()
    return [None if v != v else v for v in flat]  # NaN -> null


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

    p = prev_step(step)
    if mode == "interval" and prev is not None:
        # cumulate di 6, 12, 24 ore: differenza con un passo più indietro (0 = dall'inizio della corsa)
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
        cache = "public, max-age=300"  # la mediana si ricalcola quando arrivano nuovi dati
    return JSONResponse(body, headers={"Cache-Control": cache})
