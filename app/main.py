"""Applicazione FastAPI: API + frontend statico + scheduler."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import scheduler
from .api import router
from .config import scheduler_enabled
from .store import Store

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logging.getLogger("httpx").setLevel(logging.WARNING)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def create_app(store: Store | None = None, start_scheduler: bool | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = store or Store()
        sched = None
        if start_scheduler if start_scheduler is not None else scheduler_enabled():
            sched = scheduler.start(app.state.store)
        yield
        if sched:
            sched.shutdown(wait=False)

    app = FastAPI(title="Weathermaps", lifespan=lifespan)

    @app.middleware("http")
    async def revalidate_static(request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    app.include_router(router)
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app()
