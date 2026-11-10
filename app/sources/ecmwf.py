"""ECMWF IFS 0.25° Open Data: indice + download a byte-range del solo campo richiesto."""
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
    label="ECMWF IFS 0.25°",
    resolution=0.25,
    cycles=(0, 12),  # le 06/18 si fermano a 144h
    delay_hours=6,  # la 0,25° esce un paio d'ore prima della 0,1° (e più regolarmente)
    max_step=360,
    country="eu",
    description=(
        "Modello globale del Centro Europeo (ECMWF), il riferimento per il medio termine. "
        "Dati aperti a 0,25° (circa 25 km), corse delle 00 e 12 UTC, qui fino a +192h. "
        "Stessa risoluzione di GFS: i rilievi alpini sono molto semplificati."
    ),
)

ROOT = "https://data.ecmwf.int/forecasts"


def base_url(run: datetime, step: int) -> str:
    """A 0.25° superficie e livelli di pressione stanno nello stesso file (il levtype distingue le righe dell'indice).

    Si usa la 0.25° e non la 0.1° perché esce prima e con più regolarità (a volte la 0.1° di una corsa manca del tutto).
    """
    return f"{ROOT}/{run:%Y%m%d}/{run.hour:02d}z/ifs/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc"


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
    base = base_url(run, step)
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
