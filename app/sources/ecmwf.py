"""ECMWF IFS 0.1° Open Data: indice + download a byte-range del solo campo richiesto."""
from __future__ import annotations

import json
from datetime import datetime

import httpx

from ..config import BBox
from ..grid import Field, crop, decode_grib, select
from ..variables import Variable
from . import ModelInfo, NotAvailable

MODEL = ModelInfo(
    id="ecmwf",
    label="ECMWF IFS 0.1°",
    resolution=0.1,
    cycles=(0, 12),  # le 06/18 si fermano a 144h
    delay_hours=7.5,
    max_step=360,
)

ROOT = "https://data.ecmwf.int/forecasts"


def base_url(run: datetime, step: int, levtype: str = "sfc") -> str:
    """A 0.1° superficie e livelli di pressione sono in file separati (-sfc / -pl)."""
    return (
        f"{ROOT}/{run:%Y%m%d}/{run.hour:02d}z/ifs/0p1/oper/"
        f"{run:%Y%m%d%H}0000-{step}h-oper-fc-{levtype}"
    )


def find_in_index(index_text: str, variable: Variable, step: int) -> tuple[int, int]:
    sel = variable.selectors["ecmwf"]
    for line in index_text.splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec.get("param") != sel.param:
            continue
        if sel.levtype and rec.get("levtype") != sel.levtype:
            continue
        if sel.levelist and str(rec.get("levelist")) != sel.levelist:
            continue
        if str(rec.get("step")) not in (str(step), f"0-{step}"):
            continue
        return int(rec["_offset"]), int(rec["_length"])
    raise LookupError(f"{sel.param} non trovato nell'indice per step {step}")


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    base = base_url(run, step, variable.selectors["ecmwf"].levtype or "sfc")
    idx = client.get(base + ".index")
    if idx.status_code == 404:
        raise NotAvailable(f"ECMWF {run:%Y%m%d%H} +{step}h non disponibile")
    idx.raise_for_status()
    offset, length = find_in_index(idx.text, variable, step)
    resp = client.get(base + ".grib2", headers={"Range": f"bytes={offset}-{offset + length - 1}"})
    if resp.status_code == 404:
        raise NotAvailable(f"ECMWF {run:%Y%m%d%H} +{step}h grib non disponibile")
    resp.raise_for_status()
    if resp.status_code != 206 or not resp.content.startswith(b"GRIB"):
        raise ValueError(f"Risposta inattesa dal server ECMWF: {resp.status_code}")
    fields = decode_grib(resp.content)
    field = select(fields, variable.selectors["ecmwf"])
    return crop(field, bbox)
