"""Central configuration: geographic area, time steps, paths.

Everything that depends on the map area derives from `BBOX`, read from the environment.
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
    lon_min: float  # degrees -180..180
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
        """Short, stable identifier, used as the storage namespace."""
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
    """Loads a local .env if present, without overwriting variables already set."""
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

# Area of the synoptic chart (500 hPa geopotential and pressure): Atlantic and Europe, like the classic charts.
# Only for fields with `area` (see variables.Variable): it does not depend on BBOX.
# As wide as a 16:9 screen, so the chart fills it without margins; south down to 25° so it can be centred on Northern
# Italy (see applyArea in static/app.js) with about 90° of longitude on screen, like the Meteociel charts
SYNOPTIC_BBOX = "25,72,-70,64"

# Steps shared by GFS and ECMWF: 3h up to 144h, then 6h up to 192h.
STEPS: list[int] = list(range(3, 145, 3)) + list(range(150, 193, 6))
# Steps of the fields that go to the end of the run (synoptic chart): the shared ones, then every 6 hours up to
# +384h (GFS; ECMWF and AIFS stop at +360h, see ModelInfo.run_end)
LONG_STEPS: list[int] = STEPS + list(range(198, 385, 6))

HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT", "30"))
SCHEDULER_INTERVAL_MIN = int(os.environ.get("SCHEDULER_INTERVAL_MIN", "10"))


def get_bbox() -> BBox:
    return BBox.parse(os.environ.get("BBOX", DEFAULT_BBOX))


# Initial map view (default: Lombardy). Must lie inside BBOX.
DEFAULT_INITIAL_VIEW = "44.68,46.64,8.50,11.43"


def get_initial_view(bbox: BBox) -> BBox:
    """Initial view cropped inside the box; if it does not intersect it, the whole box is used."""
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
    """From `git describe --tags --long` ("v1.2.0-3-gabc1234") to the version shown: "v1.2.0" on the tag,
    "v1.2.0+3" with 3 commits after the tag."""
    tag, ahead, _sha = text.strip().rsplit("-", 2)
    return tag if ahead == "0" else f"{tag}+{ahead}"


@lru_cache(maxsize=1)
def get_version() -> str:
    """App version from the git tags; `APP_VERSION` overrides it (e.g. in the Docker image, which has no .git).
    Empty string if there are no tags: the page then does not show the version."""
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
    if out.returncode != 0:  # no tag (or no git)
        return ""
    return parse_describe(out.stdout)


def get_data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR", "./data")).resolve()


def scheduler_enabled() -> bool:
    return os.environ.get("SCHEDULER_ENABLED", "1") not in ("0", "false", "no")


def prev_step(step: int) -> int:
    """Previous step in the shared list (0 for the first); the long steps continue it."""
    i = LONG_STEPS.index(step)
    return LONG_STEPS[i - 1] if i > 0 else 0
