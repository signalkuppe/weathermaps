"""ECMWF IFS 0.25° Open Data: index + byte-range download of the requested field only."""
from __future__ import annotations

import json
from datetime import datetime

import httpx

from ..config import BBox
from ..grid import Field, crop, decode_grib, select
from ..variables import GribSelector, Variable
from . import ModelInfo, NotAvailable

MODEL = ModelInfo(
    id="ecmwf", base="globale",
    label="ECMWF IFS 0.25°",
    resolution=0.25,
    cycles=(0, 12),  # the 06/18 runs stop at 144h
    delay_hours=6,  # the 0.25° comes out two hours before the 0.1° (see ecmwf_hres)
    max_step=360,
    country="eu",
    short="ECMWF (0.25)",
    description=(
        "Modello globale del Centro Europeo (ECMWF), il riferimento per il medio termine. "
        "Dati aperti a 0,25° (circa 25 km), corse delle 00 e 12 UTC, qui fino a +192h. "
        "Esce circa due ore prima della stessa corsa a 0,1°. I rilievi alpini sono molto semplificati."
    ),
)

ROOT = "https://data.ecmwf.int/forecasts"


def base_url(run: datetime, step: int) -> str:
    """At 0.25° surface and pressure levels are in the same file (levtype tells the index lines apart)."""
    return f"{ROOT}/{run:%Y%m%d}/{run.hour:02d}z/ifs/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc"


def find_in_index(index_text: str, variable: Variable, step: int, sel: GribSelector | None = None) -> tuple[int, int]:
    sel = sel or variable.selectors["ecmwf"]
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


def fetch_record(client: httpx.Client, base: str, label: str, variable: Variable, step: int, sel: GribSelector,
                 bbox: BBox) -> Field:
    """Downloads one message by its index line (shared by the ECMWF open data: IFS 0.25° and 0.1°, AIFS)."""
    idx = client.get(base + ".index")
    if idx.status_code == 404:
        raise NotAvailable(f"{label} +{step}h non disponibile")
    idx.raise_for_status()
    offset, length = find_in_index(idx.text, variable, step, sel)
    resp = client.get(base + ".grib2", headers={"Range": f"bytes={offset}-{offset + length - 1}"})
    if resp.status_code == 404:
        raise NotAvailable(f"{label} +{step}h grib non disponibile")
    resp.raise_for_status()
    if resp.status_code != 206 or not resp.content.startswith(b"GRIB"):
        raise ValueError(f"Risposta inattesa dal server ECMWF: {resp.status_code}")
    return crop(select(decode_grib(resp.content), sel), bbox)


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    return fetch_record(client, base_url(run, step), f"ECMWF {run:%Y%m%d%H}", variable, step,
                        variable.selectors["ecmwf"], bbox)
