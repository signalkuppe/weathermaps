"""Scarica i passi mancanti delle ultime corse, per ogni modello e grandezza registrata."""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime

import httpx
import numpy as np

from . import variables
from .config import RETENTION, STEPS
from .grid import Field
from . import mean
from .sources import NotAvailable, ecmwf, gfs, icon_2i, icon_d2, make_client, run_id
from .sources.meteoswiss import icon_ch1, icon_ch2
from .store import Store

log = logging.getLogger("weathermaps.fetcher")

SOURCES = {src.MODEL.id: src for src in (gfs, ecmwf, icon_2i, icon_d2, icon_ch2, icon_ch1)}
# modelli mostrati: le sorgenti più la media (calcolata, non scaricata)
MODELS = {**{m.MODEL.id: m.MODEL for m in SOURCES.values()}, mean.MODEL.id: mean.MODEL}

# pausa fra richieste per non stressare i server pubblici
REQUEST_PAUSE = {"gfs": 0.4, "ecmwf": 0.1, "icon-ch2": 0.1, "icon-ch1": 0.1, "icon-d2": 0.1, "icon-2i": 0.1}
RETRIES = 3

_locks = {m: threading.Lock() for m in SOURCES}

# stato dell'ultimo aggiornamento per modello (letto dall'API per il pulsante "Aggiorna")
STATUS: dict[str, dict] = {
    m: {"running": False, "started": None, "finished": None, "downloaded": 0, "errors": 0} for m in SOURCES
}
REFRESH_COOLDOWN_S = 20  # pausa minima dalla fine dell'ultimo controllo


def status(model_id: str) -> dict:
    return dict(STATUS[model_id])


def request_refresh(model_id: str, store: Store) -> tuple[bool, str]:
    """Avvia un aggiornamento in background se non ce n'è uno in corso o appena concluso."""
    st = STATUS[model_id]
    if st["running"]:
        return False, "running"
    if st["finished"] and time.time() - st["finished"] < REFRESH_COOLDOWN_S:
        return False, "cooldown"
    threading.Thread(target=update_model, args=(model_id, store), daemon=True, name=f"refresh-{model_id}").start()
    return True, "started"


def steps_for(var: variables.Variable, model_id: str) -> list[int]:
    max_step = MODELS[model_id].max_step
    return [s for s in (var.steps or STEPS) if s <= max_step]


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
            log.warning("%s: tentativo %d fallito (%s), riprovo fra %.0fs", source.MODEL.id, attempt, exc, delay)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def update_model(model_id: str, store: Store | None = None, now: datetime | None = None) -> dict:
    """Aggiorna le ultime corse di un modello. Idempotente; ritorna un riepilogo."""
    lock = _locks[model_id]
    if not lock.acquire(blocking=False):
        log.info("%s: aggiornamento già in corso, salto", model_id)
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
        for run in model.candidate_runs(now, count=RETENTION):
            rid = run_id(run)
            for var in variables.REGISTRY.values():
                if model_id not in var.selectors:
                    continue
                todo = [s for s in steps_for(var, model_id) if not store.has(model_id, rid, var.id, s)]
                got = 0
                for step in todo:
                    try:
                        field = _fetch_with_retry(source, client, run, step, var, store.bbox)
                    except NotAvailable:
                        # i passi escono in ordine: i successivi non ci sono ancora
                        break
                    except Exception as exc:  # noqa: BLE001
                        summary["errors"] += 1
                        log.error("%s %s %s +%dh: %s", model_id, rid, var.id, step, exc)
                        break
                    store.save(model_id, rid, var.id, step, _convert(var, model_id, field))
                    got += 1
                    STATUS[model_id]["downloaded"] += 1  # avanzamento visibile durante l'aggiornamento
                    time.sleep(REQUEST_PAUSE.get(model_id, 0))
                if got:
                    log.info("%s %s %s: scaricati %d passi", model_id, rid, var.id, got)
                summary["downloaded"] += got
                summary["runs"][f"{rid}/{var.id}"] = len(store.steps(model_id, rid, var.id))
    removed = store.purge(model_id, RETENTION)
    if removed:
        log.info("%s: rimosse corse vecchie %s", model_id, removed)
    return summary


def update_all(store: Store | None = None) -> list[dict]:
    store = store or Store()
    removed = store.purge_other_bboxes()
    if removed:
        log.info("Rimossi dati di aree precedenti: %s", removed)
    return [update_model(m, store) for m in SOURCES]
