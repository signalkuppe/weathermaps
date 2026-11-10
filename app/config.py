"""Configurazione centrale: area geografica, passi temporali, percorsi.

Tutto ciò che dipende dall'area della mappa deriva da `BBOX`, letto dall'ambiente.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class BBox:
    lat_min: float
    lat_max: float
    lon_min: float  # gradi -180..180
    lon_max: float

    @classmethod
    def parse(cls, text: str) -> "BBox":
        parts = [p.strip() for p in text.split(",")]
        if len(parts) != 4:
            raise ValueError(f"BBOX deve essere 'lat_min,lat_max,lon_min,lon_max', ricevuto {text!r}")
        lat_min, lat_max, lon_min, lon_max = (float(p) for p in parts)
        box = cls(lat_min, lat_max, lon_min, lon_max)
        box.validate()
        return box

    def validate(self) -> None:
        if not (-90 <= self.lat_min < self.lat_max <= 90):
            raise ValueError(f"Latitudini BBOX non valide: {self}")
        if not (-180 <= self.lon_min < self.lon_max <= 180):
            raise ValueError(f"Longitudini BBOX non valide (usa -180..180): {self}")

    @property
    def key(self) -> str:
        """Identificativo breve e stabile, usato come namespace dello storage."""
        raw = f"{self.lat_min:g},{self.lat_max:g},{self.lon_min:g},{self.lon_max:g}"
        return hashlib.sha1(raw.encode()).hexdigest()[:10]

    def as_dict(self) -> dict:
        return {
            "lat_min": self.lat_min,
            "lat_max": self.lat_max,
            "lon_min": self.lon_min,
            "lon_max": self.lon_max,
        }


def _load_dotenv(path: Path = Path(__file__).resolve().parent.parent / ".env") -> None:
    """Carica un eventuale .env locale senza sovrascrivere variabili già impostate."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

DEFAULT_BBOX = "42,49,4,17"

# Passi comuni a GFS e ECMWF: 3h fino a 144h, poi 6h fino a 192h.
STEPS: list[int] = list(range(3, 145, 3)) + list(range(150, 193, 6))

HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT", "30"))
SCHEDULER_INTERVAL_MIN = int(os.environ.get("SCHEDULER_INTERVAL_MIN", "10"))


def get_bbox() -> BBox:
    return BBox.parse(os.environ.get("BBOX", DEFAULT_BBOX))


# Vista iniziale della mappa (default: Lombardia). Deve stare dentro BBOX.
DEFAULT_INITIAL_VIEW = "44.68,46.64,8.50,11.43"


def get_initial_view(bbox: BBox) -> BBox:
    """Vista iniziale ritagliata dentro il box; se non lo interseca, usa il box intero."""
    try:
        view = BBox.parse(os.environ.get("INITIAL_VIEW", DEFAULT_INITIAL_VIEW))
    except ValueError:
        return bbox
    clipped = BBox(
        max(view.lat_min, bbox.lat_min),
        min(view.lat_max, bbox.lat_max),
        max(view.lon_min, bbox.lon_min),
        min(view.lon_max, bbox.lon_max),
    )
    if clipped.lat_min >= clipped.lat_max or clipped.lon_min >= clipped.lon_max:
        return bbox
    return clipped


def parse_describe(text: str) -> str:
    """Da `git describe --tags --long` ("v1.2.0-3-gabc1234") alla versione mostrata: "v1.2.0" sul tag,
    "v1.2.0+3" con 3 commit dopo il tag."""
    tag, ahead, _sha = text.strip().rsplit("-", 2)
    return tag if ahead == "0" else f"{tag}+{ahead}"


@lru_cache(maxsize=1)
def get_version() -> str:
    """Versione dell'app dai tag git; `APP_VERSION` la sostituisce (es. nell'immagine Docker, che non ha .git).
    Stringa vuota se non ci sono tag: la pagina allora non mostra la versione."""
    env = os.environ.get("APP_VERSION", "").strip()
    if env:
        return env
    try:
        out = subprocess.run(
            ["git", "describe", "--tags", "--long"],
            cwd=Path(__file__).resolve().parent.parent, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if out.returncode != 0:  # nessun tag (o niente git)
        return ""
    return parse_describe(out.stdout)


def get_data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR", "./data")).resolve()


def scheduler_enabled() -> bool:
    return os.environ.get("SCHEDULER_ENABLED", "1") not in ("0", "false", "no")


def prev_step(step: int) -> int:
    """Passo precedente nella lista comune (0 per il primo)."""
    i = STEPS.index(step)
    return STEPS[i - 1] if i > 0 else 0
