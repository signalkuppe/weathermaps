"""GFS 0.25° via filtro GRIB di NOMADS, già ritagliato sul box."""
from __future__ import annotations

from datetime import datetime
from urllib.parse import urlencode

import httpx

from ..config import BBox
from ..grid import Field, crop, decode_grib, select
from ..variables import Variable
from . import ModelInfo, NotAvailable

MODEL = ModelInfo(
    id="gfs",
    label="GFS 0.25°",
    resolution=0.25,
    cycles=(0, 6, 12, 18),
    delay_hours=3.5,
    max_step=384,
)

FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"


def url(run: datetime, step: int, variable: Variable, bbox: BBox) -> str:
    sel = variable.selectors["gfs"]
    hh = f"{run.hour:02d}"
    params = {
        "dir": f"/gfs.{run:%Y%m%d}/{hh}/atmos",
        "file": f"gfs.t{hh}z.pgrb2.0p25.f{step:03d}",
        f"var_{sel.var}": "on",
        f"lev_{sel.level}": "on",
        "subregion": "",
        "toplat": f"{bbox.lat_max:g}",
        "leftlon": f"{bbox.lon_min:g}",
        "rightlon": f"{bbox.lon_max:g}",
        "bottomlat": f"{bbox.lat_min:g}",
    }
    return f"{FILTER_URL}?{urlencode(params)}"


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    resp = client.get(url(run, step, variable, bbox))
    if resp.status_code == 404 or (resp.status_code == 200 and not resp.content.startswith(b"GRIB")):
        # NOMADS risponde con HTML/testo se il file non esiste ancora
        raise NotAvailable(f"GFS {run:%Y%m%d%H} f{step:03d} non disponibile")
    resp.raise_for_status()
    fields = decode_grib(resp.content)
    field = select(fields, variable.selectors["gfs"])
    return crop(field, bbox)
