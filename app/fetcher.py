"""Downloads the missing steps of the latest runs, for each model and registered field."""
from __future__ import annotations

import dataclasses
import logging
import threading
import time
from datetime import datetime

import httpx
import numpy as np

from . import variables
from .config import STEPS, BBox
from .grid import Field, halve, lambert_to_earth
from . import mean
from .sources import NotAvailable, aifs, ecmwf, ecmwf_hres, gfs, icon_2i, icon_d2, make_client, run_id
from .sources.meteohub import bolam, moloch, moloch_isac, wrf
from .sources.arome import arome, arome_hd
from .sources.meteoswiss import icon_ch1, icon_ch2
from .store import Store

log = logging.getLogger("weathermaps.fetcher")

SOURCES = {src.MODEL.id: src for src in (gfs, ecmwf, ecmwf_hres, aifs, icon_2i, icon_2i.ruc, wrf, moloch, bolam, moloch_isac, icon_d2, arome, arome_hd, icon_ch2, icon_ch1)}
# models shown: the sources plus the median (computed, not downloaded)
MODELS = {**{m.MODEL.id: m.MODEL for m in SOURCES.values()}, mean.MODEL.id: mean.MODEL}

# pause between requests so as not to stress the public servers
REQUEST_PAUSE = {"gfs": 0.4, "ecmwf": 0.1, "ecmwf-hres": 0.1, "aifs": 0.1, "icon-ch2": 0.1, "icon-ch1": 0.1, "icon-d2": 0.1, "icon-2i": 0.1, "icon-2i-ruc": 0.1, "wrf": 0.1, "moloch": 0.1, "bolam": 0.1, "moloch-isac": 0.1, "arome": 0.1, "arome-hd": 0.1}
RETRIES = 3

_locks = {m: threading.Lock() for m in SOURCES}

# status of the last update per model (read by the API for the "Aggiorna" refresh button)
STATUS: dict[str, dict] = {
    m: {"running": False, "started": None, "finished": None, "downloaded": 0, "errors": 0} for m in SOURCES
}
REFRESH_COOLDOWN_S = 20  # minimum pause since the end of the last check


def status(model_id: str) -> dict:
    return dict(STATUS[model_id])


def request_refresh(model_id: str, store: Store) -> tuple[bool, str]:
    """Starts a background update unless one is running or has just finished."""
    st = STATUS[model_id]
    if st["running"]:
        return False, "running"
    if st["finished"] and time.time() - st["finished"] < REFRESH_COOLDOWN_S:
        return False, "cooldown"
    threading.Thread(target=update_model, args=(model_id, store), daemon=True, name=f"refresh-{model_id}").start()
    return True, "started"


def model_steps(model_id: str) -> list[int]:
    """Steps of the model: the shared ones up to its range, or its own (e.g. AIFS every 6 hours)."""
    model = MODELS[model_id]
    return [s for s in (model.steps or STEPS) if s <= model.max_step]


def steps_for(var: variables.Variable, model_id: str) -> list[int]:
    own = model_steps(model_id)
    return [s for s in var.steps if s in own] if var.steps else own


def _convert(var: variables.Variable, model_id: str, field: Field) -> Field:
    values = np.asarray(var.convert[model_id](field.values), dtype=np.float32)
    if var.nonnegative:
        values = np.where(np.isnan(values), values, np.maximum(values, 0)).astype(np.float32)
    field.values = values
    return field


def _fetch_with_retry(source, client, run: datetime, step: int, var, bbox) -> Field:
    delay = 2.0
    for attempt in range(1, RETRIES + 1):
        try:
            return source.fetch(client, run, step, var, bbox)
        except NotAvailable:
            raise
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and 400 <= status < 500 and status != 429:
                raise
            if attempt == RETRIES:
                raise
            log.warning("%s: attempt %d failed (%s), retrying in %.0fs", source.MODEL.id, attempt, exc, delay)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def _fetch_field(source, client, run: datetime, step: int, var, bbox) -> Field:
    """Downloads the field; with `plus` selectors it also downloads the other fields and sums them (e.g. ICON snow)."""
    sel = var.selectors[source.MODEL.id]
    field = _fetch_with_retry(source, client, run, step, var, bbox)
    for extra in sel.plus:
        alt = dataclasses.replace(var, selectors={**var.selectors, source.MODEL.id: extra})
        other = _fetch_with_retry(source, client, run, step, alt, bbox)
        if other.values.shape != field.values.shape:
            raise ValueError(f"{source.MODEL.id}: griglie diverse fra {sel.param} e {extra.param}")
        field.values = (field.values + other.values).astype(np.float32)
    if sel.dew is not None:
        # computed field (wet bulb): the second field is needed too, on the same grid
        alt = dataclasses.replace(var, selectors={**var.selectors, source.MODEL.id: sel.dew})
        other = _fetch_with_retry(source, client, run, step, alt, bbox)
        if other.values.shape != field.values.shape:
            raise ValueError(f"{source.MODEL.id}: griglie diverse fra {sel.param or sel.var} e {sel.dew.param or sel.dew.var}")
        if sel.pressure is None and "pressure_hpa" in var.extra:
            pressure_hpa = var.extra["pressure_hpa"]  # field on a pressure level (e.g. humidity at 850 hPa)
        elif sel.pressure is None:
            raise ValueError(f"{source.MODEL.id}: pressione al suolo mancante per {var.id}")
        else:
            alt = dataclasses.replace(var, selectors={**var.selectors, source.MODEL.id: sel.pressure})
            pressure = _fetch_with_retry(source, client, run, step, alt, bbox)
            if (pressure.values.shape != field.values.shape
                    or (pressure.lat0, pressure.lon0, pressure.dlat, pressure.dlon)
                    != (field.lat0, field.lon0, field.dlat, field.dlon)):
                raise ValueError(f"{source.MODEL.id}: griglie diverse fra temperatura e pressione")
            pressure_factors = {"Pa": 0.01, "hPa": 1.0, "kPa": 10.0}
            if pressure.units not in pressure_factors:
                raise ValueError(f"{source.MODEL.id}: unità della pressione inattesa: {pressure.units}")
            pressure_hpa = pressure.values * pressure_factors[pressure.units]
        field.values = np.asarray(var.combine(field.values, other.values, pressure_hpa), dtype=np.float32)
    if sel.pair is not None and sel.lambert:
        # wind relative to the Lambert grid (WRF): the other component is needed too to rotate it to north
        alt = dataclasses.replace(var, selectors={**var.selectors, source.MODEL.id: sel.pair})
        other = _fetch_with_retry(source, client, run, step, alt, bbox)
        if other.values.shape != field.values.shape:
            raise ValueError(f"{source.MODEL.id}: griglie diverse fra le componenti del vento")
        u, v = (field.values, other.values) if sel.component == "u" else (other.values, field.values)
        ue, ve = lambert_to_earth(u, v, field.lons()[None, :], *sel.lambert)
        field.values = (ue if sel.component == "u" else ve).astype(np.float32)
    return field


def complete_vars(store: Store, model_id: str, rid: str) -> list[str]:
    """Fields of the model that have all expected steps in the run."""
    return [var.id for var in variables.REGISTRY.values()
            if model_id in var.selectors and set(steps_for(var, model_id)) <= set(store.steps(model_id, rid, var.id))]


def is_complete(store: Store, model_id: str, rid: str) -> bool:
    """All fields of the model have all expected steps in the run."""
    n_vars = sum(model_id in v.selectors for v in variables.REGISTRY.values())
    return len(complete_vars(store, model_id, rid)) == n_vars


def area_of(var, store: Store) -> BBox:
    """Area to download: the field's own (synoptic chart) or the map's."""
    return BBox.parse(var.area) if var.area else store.bbox


def latest_complete(store: Store, model_id: str) -> str | None:
    """Run to show: the latest with all fields complete. If none is (for example a field the source no longer
    provides), the latest with at least one complete field, so the model does not disappear."""
    runs = store.runs(model_id)
    full = next((rid for rid in runs if is_complete(store, model_id, rid)), None)
    return full or next((rid for rid in runs if complete_vars(store, model_id, rid)), None)


def runs_to_keep(store: Store, model_id: str, candidates: list[str]) -> set[str]:
    """Keeps the run to show plus the candidates newer than it (still incoming). If there is no run to show nothing
    is deleted: better old data than no data if downloads fail."""
    current = latest_complete(store, model_id)
    if current is None:
        return set(store.runs(model_id))
    return {current} | {rid for rid in candidates if rid > current}


def update_model(model_id: str, store: Store | None = None, now: datetime | None = None) -> dict:
    """Updates the latest runs of a model. Idempotent; returns a summary."""
    lock = _locks[model_id]
    if not lock.acquire(blocking=False):
        log.info("%s: update already running, skipping", model_id)
        return {"model": model_id, "skipped": True}
    st = STATUS[model_id]
    st.update(running=True, started=time.time(), finished=None, downloaded=0, errors=0)
    store = store or Store()
    try:
        summary = _update(model_id, store, now)
        st.update(errors=summary["errors"])
        if summary["downloaded"]:
            summary["mean"] = mean.build_mean(store)
        return summary
    except Exception:
        st["errors"] += 1
        raise
    finally:
        st.update(running=False, finished=time.time())
        lock.release()


def _update(model_id: str, store: Store, now: datetime | None) -> dict:
    source = SOURCES[model_id]
    model = MODELS[model_id]
    summary = {"model": model_id, "downloaded": 0, "errors": 0, "runs": {}}
    with make_client() as client:
        candidates = model.candidate_runs(now, count=2)  # the new one and, if still needed, the previous one
        for run in candidates:
            rid = run_id(run)
            # a newer complete run already exists: this one (already deleted or to be deleted) is no longer needed.
            # Without this check the previous run would be downloaded again in full at every round.
            if any(r > rid and is_complete(store, model_id, r) for r in store.runs(model_id)):
                continue
            for var in variables.REGISTRY.values():
                if model_id not in var.selectors:
                    continue
                todo = [s for s in steps_for(var, model_id) if not store.has(model_id, rid, var.id, s)]
                got = 0
                for step in todo:
                    try:
                        field = _fetch_field(source, client, run, step, var, area_of(var, store))
                    except NotAvailable:
                        # steps come out in order: the following ones are not there yet
                        break
                    except Exception as exc:  # noqa: BLE001
                        summary["errors"] += 1
                        log.error("%s %s %s +%dh: %s", model_id, rid, var.id, step, exc)
                        break
                    field = _convert(var, model_id, field)
                    if var.half_res:
                        field = halve(field)
                    store.save(model_id, rid, var.id, step, field)
                    got += 1
                    STATUS[model_id]["downloaded"] += 1  # progress visible during the update
                    time.sleep(REQUEST_PAUSE.get(model_id, 0))
                if got:
                    log.info("%s %s %s: downloaded %d steps", model_id, rid, var.id, got)
                summary["downloaded"] += got
                summary["runs"][f"{rid}/{var.id}"] = len(store.steps(model_id, rid, var.id))
    removed = store.purge_superseded(model_id, runs_to_keep(store, model_id, [run_id(r) for r in candidates]))
    if removed:
        log.info("%s: removed old runs %s", model_id, removed)
    return summary


def update_all(store: Store | None = None) -> list[dict]:
    store = store or Store()
    removed = store.purge_other_bboxes()
    if removed:
        log.info("Removed data of previous areas: %s", removed)
    return [update_model(m, store) for m in SOURCES]
