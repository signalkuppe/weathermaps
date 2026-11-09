"""ItaliaMeteo ICON-2I (2.2 km) da MeteoHub, servizio "singola variabile" (nessuna autenticazione).

Per ogni corsa e variabile c'è un unico file con tutti i passi orari (0..72h), ~85 MB.
Invece di scaricarlo tutto si legge la lunghezza di ogni messaggio GRIB con piccole
richieste a intervalli di byte, poi si scaricano solo i messaggi dei passi che servono.
"""
from __future__ import annotations

import logging
from datetime import datetime

import httpx

from ..config import BBox
from ..grid import Field, crop, decode_grib, select
from ..variables import Variable
from . import ModelInfo, NotAvailable

log = logging.getLogger("weathermaps.icon_2i")

MODEL = ModelInfo(
    id="icon-2i",
    label="ICON-2I 2 km",
    resolution=0.025,
    cycles=(0, 12),
    delay_hours=2.5,
    max_step=72,
)

ROOT = "https://meteohub.agenziaitaliameteo.it/nwp/ICON-2I_SURFACE_PRESSURE_LEVELS"

# offset e lunghezza dei messaggi per file (riempito alla prima richiesta di ogni file)
_offsets: dict[str, list[tuple[int, int]]] = {}


def url(run: datetime, variable: Variable) -> str:
    sel = variable.selectors["icon-2i"]
    return f"{ROOT}/{run:%Y%m%d%H}/{sel.param}/ICON_2I_SURFACE_PRESSURE_LEVELS_{run:%Y%m%d%H}_{sel.levtype}-{sel.levelist}.grib"


def _range(client: httpx.Client, file_url: str, start: int, end: int) -> bytes:
    resp = client.get(file_url, headers={"Range": f"bytes={start}-{end}"})
    if resp.status_code == 404:
        raise NotAvailable(f"ICON-2I file non disponibile: {file_url}")
    resp.raise_for_status()
    if resp.status_code != 206:
        raise ValueError(f"Il server non rispetta le richieste parziali ({resp.status_code})")
    return resp.content


def message_offsets(client: httpx.Client, file_url: str) -> list[tuple[int, int]]:
    """Elenco (offset, lunghezza) dei messaggi GRIB2, leggendo solo le intestazioni."""
    if file_url in _offsets:
        return _offsets[file_url]
    head = client.head(file_url)
    if head.status_code == 404:
        raise NotAvailable(f"ICON-2I file non disponibile: {file_url}")
    head.raise_for_status()
    total = int(head.headers["content-length"])
    out: list[tuple[int, int]] = []
    off = 0
    while off < total:
        sec0 = _range(client, file_url, off, off + 15)
        if sec0[:4] != b"GRIB" or sec0[7] != 2:
            raise ValueError(f"Intestazione GRIB2 inattesa all'offset {off}")
        length = int.from_bytes(sec0[8:16], "big")
        out.append((off, length))
        off += length
    _offsets[file_url] = out
    log.info("ICON-2I: %d messaggi indicizzati in %s", len(out), file_url.rsplit("/", 1)[-1])
    return out


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    sel = variable.selectors["icon-2i"]
    file_url = url(run, variable)
    offsets = message_offsets(client, file_url)
    wanted = f"0-{step}" if sel.step_range_prefix == "0-" else str(step)
    # i passi sono orari a partire da 0: di norma il messaggio giusto è all'indice `step`
    candidates = [step] + [i for i in range(len(offsets)) if i != step]
    for i in candidates:
        if i >= len(offsets):
            continue
        off, length = offsets[i]
        fields = decode_grib(_range(client, file_url, off, off + length - 1))
        if fields and fields[0].step_range == wanted:
            return crop(select(fields, sel), bbox)
    raise NotAvailable(f"ICON-2I {run:%Y%m%d%H} +{step}h non trovato nel file")
