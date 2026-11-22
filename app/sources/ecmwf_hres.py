"""ECMWF IFS 0.1° (about 9 km) Open Data: the same run as the 0.25°, on the finer grid.

Published about two hours after the 0.25°, all steps at once, as two files per step: surface ("-sfc") and pressure
levels ("-pl"). Only the map fields: the synoptic chart (Europe and the Atlantic) stays with the 0.25°.
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
    id="ecmwf-hres",
    label="ECMWF IFS 0.1°",
    resolution=0.1,
    cycles=(0, 12),
    delay_hours=8,
    max_step=360,
    country="eu",
    short="ECMWF (0.1)",
    description=(
        "Modello globale del Centro Europeo (ECMWF) alla risoluzione piena dei dati aperti: 0,1° (circa 9 km), "
        "corse delle 00 e 12 UTC, qui fino a +192h. È la stessa corsa dell'IFS 0,25°, con più dettaglio su "
        "rilievi e precipitazioni, ma esce circa due ore dopo."
    ),
)


def base_url(run: datetime, step: int, levtype: str | None = None) -> str:
    root = f"{ROOT}/{run:%Y%m%d}/{run.hour:02d}z/ifs/0p1/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc"
    return root + ("-pl" if levtype == "pl" else "-sfc")


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    sel = variable.selectors["ecmwf-hres"]
    return fetch_record(client, base_url(run, step, sel.levtype), f"ECMWF 0.1° {run:%Y%m%d%H}", variable, step,
                        sel, bbox)
