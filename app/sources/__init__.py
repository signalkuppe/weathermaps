"""Sorgenti dati dei modelli. Ogni modulo espone MODEL, una `ModelSource` e `fetch()`."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

from ..config import HTTP_TIMEOUT

USER_AGENT = "weathermaps/0.1"


class NotAvailable(Exception):
    """Il passo/corsa non è (ancora) pubblicato: non è un errore, si riprova più tardi."""


@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    resolution: float
    cycles: tuple[int, ...]  # ore UTC delle corse usate
    delay_hours: float  # ritardo tipico prima che i primi passi siano disponibili
    max_step: int
    description: str = ""  # testo per l'icona informazioni accanto al selettore del modello
    country: str = ""  # codice dell'ente (us, eu, it, de, ch) per la bandiera nel selettore

    def candidate_runs(self, now: datetime | None = None, count: int = 3) -> list[datetime]:
        """Ultime `count` corse plausibilmente pubblicate, dalla più recente."""
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
            "max_step": self.max_step,
            "description": self.description,
            "country": self.country,
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
