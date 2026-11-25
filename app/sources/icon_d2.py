"""DWD ICON-D2 (2.2 km) from the Deutscher Wetterdienst Open Data server.

One file per step, bz2-compressed, already on a regular 0.02° lat/lon grid.
Domain ~43.2–58.1°N, -3.9–20.3°E: it covers Northern Italy (not the southernmost strip of the box).
"""
from __future__ import annotations

import bz2
from datetime import datetime

import httpx

from ..config import BBox
from ..grid import Field, crop, decode_grib, select
from ..variables import Variable
from . import ModelInfo, NotAvailable

MODEL = ModelInfo(
    id="icon-d2", base="ICON",
    label="ICON-D2 2 km",
    resolution=0.02,
    cycles=(0, 3, 6, 9, 12, 15, 18, 21),
    delay_hours=1.5,
    max_step=48,
    country="de",
    description=(
        "Modello del servizio meteo tedesco (DWD) a 2,2 km sull'Europa centrale e le Alpi. "
        "Una corsa ogni 3 ore fino a +48h: il più aggiornato. Il suo dominio inizia a 43,2°N, "
        "quindi non copre la fascia più a sud della mappa."
    ),
)

ROOT = "https://opendata.dwd.de/weather/nwp/icon-d2/grib"


def url(run: datetime, step: int, variable: Variable) -> str:
    """E.g. .../12/tot_prec/icon-d2_germany_regular-lat-lon_single-level_2026110912_024_2d_tot_prec.grib2.bz2"""
    sel = variable.selectors["icon-d2"]
    level = "2d" if sel.levtype == "single-level" else sel.levelist
    name = f"icon-d2_germany_regular-lat-lon_{sel.levtype}_{run:%Y%m%d%H}_{step:03d}_{level}_{sel.param}.grib2.bz2"
    return f"{ROOT}/{run.hour:02d}/{sel.param}/{name}"


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    resp = client.get(url(run, step, variable))
    if resp.status_code == 404:
        raise NotAvailable(f"ICON-D2 {run:%Y%m%d%H} +{step}h non disponibile")
    resp.raise_for_status()
    fields = decode_grib(bz2.decompress(resp.content))
    return crop(select(fields, variable.selectors["icon-d2"]), bbox)
