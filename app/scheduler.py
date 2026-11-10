"""Job periodico che aggiorna i dati dei modelli."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler

from .config import SCHEDULER_INTERVAL_MIN
from .fetcher import SOURCES, update_model
from .mean import build_mean
from .store import Store

log = logging.getLogger("weathermaps.scheduler")


def start(store: Store) -> BackgroundScheduler:
    sched = BackgroundScheduler(timezone="UTC")
    first = datetime.now(timezone.utc) + timedelta(seconds=2)
    # pulizia aree vecchie una volta all'avvio
    removed = store.purge_other_bboxes()
    if removed:
        log.info("Rimossi dati di aree precedenti: %s", removed)
    for model_id in SOURCES:
        sched.add_job(
            update_model,
            "interval",
            minutes=SCHEDULER_INTERVAL_MIN,
            args=[model_id, store],
            id=f"update-{model_id}",
            next_run_time=first,
            max_instances=1,
            coalesce=True,
        )
    # la mediana si ricontrolla a ogni giro (se gli ingressi non cambiano non ricalcola nulla)
    sched.add_job(
        build_mean,
        "interval",
        minutes=SCHEDULER_INTERVAL_MIN,
        args=[store],
        id="update-mean",
        next_run_time=first + timedelta(minutes=3),
        max_instances=1,
        coalesce=True,
    )
    sched.start()
    log.info("Scheduler avviato: ogni %d minuti per %s", SCHEDULER_INTERVAL_MIN, list(SOURCES))
    return sched
