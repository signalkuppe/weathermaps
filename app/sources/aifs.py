"""ECMWF AIFS (machine-learning model) Open Data, 0.25°: same index + byte-range layout as the IFS.

Four runs a day, every 6 hours up to +360h (here up to +192h). The first steps come out about 5h45 after the run,
the whole run up to +192h about an hour later.
"""
from __future__ import annotations

from datetime import datetime

import httpx

from ..config import BBox
from ..grid import Field
from ..variables import Variable
from . import ModelInfo
from .ecmwf import ROOT, fetch_record

MODEL = ModelInfo(
    id="aifs",
    label="ECMWF AIFS",
    resolution=0.25,
    cycles=(0, 6, 12, 18),
    delay_hours=5.5,
    max_step=192,
    country="eu",
    short="ECMWF (AIFS)",
    steps=tuple(range(6, 193, 6)),
    description=(
        "Modello del Centro Europeo (ECMWF) basato sull'intelligenza artificiale, addestrato sulle analisi "
        "del modello fisico IFS. Griglia di 0,25° (circa 25 km), 4 corse al giorno, un passo ogni 6 ore, "
        "qui fino a +192h. Buono sulla circolazione a grande scala; precipitazioni e fenomeni locali "
        "tendono a essere più lisci."
    ),
)


def base_url(run: datetime, step: int) -> str:
    return f"{ROOT}/{run:%Y%m%d}/{run.hour:02d}z/aifs-single/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc"


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    return fetch_record(client, base_url(run, step), f"AIFS {run:%Y%m%d%H}", variable, step,
                        variable.selectors["aifs"], bbox)
