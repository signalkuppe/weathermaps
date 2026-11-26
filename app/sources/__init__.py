"""Model data sources. Each module exposes MODEL, a `ModelSource` and `fetch()`."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

from ..config import HTTP_TIMEOUT

USER_AGENT = "weathermaps/0.1"


class NotAvailable(Exception):
    """The step/run is not published (yet): not an error, retry later."""


@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    resolution: float
    cycles: tuple[int, ...]  # UTC hours of the runs used
    delay_hours: float  # typical delay before the first steps are available
    max_step: int
    description: str = ""  # text for the info icon next to the model selector
    country: str = ""  # code of the agency (us, eu, it, de, ch) for the flag in the selector
    short: str = ""  # short name (legends, lists of models); empty = the first word of the label
    steps: tuple[int, ...] | None = None  # steps of the model, if fewer than config.STEPS (e.g. every 6 hours)
    # last step of the published run, if beyond max_step: fields with their own steps (synoptic chart) go up to it
    run_end: int | None = None
    # model that drives it at the edges (limited-area models: "IFS", "GFS", "ICON", "ARPEGE"), "globale" for the
    # global ones; empty when not documented. Shown in the model menu next to the latest run
    base: str = ""

    def candidate_runs(self, now: datetime | None = None, count: int = 3) -> list[datetime]:
        """Latest `count` runs plausibly published, newest first."""
        now = now or datetime.now(timezone.utc)
        t = (now - timedelta(hours=self.delay_hours)).replace(minute=0, second=0, microsecond=0)
        runs: list[datetime] = []
        while len(runs) < count:
            if t.hour in self.cycles:
                runs.append(t)
            t -= timedelta(hours=1)
        return runs

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "resolution": self.resolution,
            "cycles": list(self.cycles),
            "delay_hours": self.delay_hours,
            "max_step": self.max_step,
            "description": self.description,
            "country": self.country,
            **({"short": self.short} if self.short else {}),
            **({"steps": list(self.steps)} if self.steps else {}),
            **({"base": self.base} if self.base else {}),
        }


def make_client() -> httpx.Client:
    return httpx.Client(
        timeout=HTTP_TIMEOUT,
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    )


def run_id(run: datetime) -> str:
    return run.strftime("%Y%m%d%H")


def parse_run_id(text: str) -> datetime:
    return datetime.strptime(text, "%Y%m%d%H").replace(tzinfo=timezone.utc)
