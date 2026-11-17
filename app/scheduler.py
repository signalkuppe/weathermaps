"""Periodic job that updates the model data."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler

from . import ensemble, soundings
from .config import SCHEDULER_INTERVAL_MIN
from .fetcher import SOURCES, update_model
from .mean import build_mean
from .store import Store

log = logging.getLogger("weathermaps.scheduler")


def start(store: Store) -> BackgroundScheduler:
    sched = BackgroundScheduler(timezone="UTC")
    first = datetime.now(timezone.utc) + timedelta(seconds=2)
    # clean up old areas once at startup
    removed = store.purge_other_bboxes()
    if removed:
        log.info("Removed data of previous areas: %s", removed)
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
    # the median is rechecked at every round (if the inputs do not change nothing is recomputed)
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
    # GFS and ECMWF ensembles (place spaghetti plots on the synoptic chart)
    for model, src in ensemble.SOURCES.items():
        sched.add_job(
            ensemble.update,
            "interval",
            minutes=SCHEDULER_INTERVAL_MIN,
            args=[model, store],
            id=f"update-{src.store_id}",
            next_run_time=first + timedelta(minutes=1),
            max_instances=1,
            coalesce=True,
        )
    # observed soundings (00 and 12 UTC, University of Wyoming)
    sched.add_job(
        soundings.update,
        "interval",
        minutes=SCHEDULER_INTERVAL_MIN,
        args=[store],
        id="update-soundings",
        next_run_time=first + timedelta(minutes=2),
        max_instances=1,
        coalesce=True,
    )
    sched.start()
    log.info("Scheduler started: every %d minutes for %s", SCHEDULER_INTERVAL_MIN, list(SOURCES))
    return sched
