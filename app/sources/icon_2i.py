"""ItaliaMeteo ICON-2I (2.2 km) from MeteoHub, "single variable" service (no authentication).

For each run and variable there is a single file with all hourly steps (0..72h), ~85 MB.
Instead of downloading all of it, the length of each GRIB message is read with small
byte-range requests, then only the messages of the needed steps are downloaded.
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
    country="it",
    description=(
        "Modello nazionale italiano di ItaliaMeteo e ARPAE-SIMC, a 2,2 km sull'Italia. "
        "Corse delle 00 e 12 UTC fino a +72h. Assimila le osservazioni italiane e risolve "
        "bene rilievi, laghi e temporali: il più adatto al Nord Italia a breve termine."
    ),
)

ROOT = "https://meteohub.agenziaitaliameteo.it/nwp/ICON-2I_SURFACE_PRESSURE_LEVELS"

# offset and length of the messages per file (filled on the first request for each file)
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
    """List of (offset, length) of the GRIB2 messages, reading only the headers."""
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
    log.info("ICON-2I: %d messages indexed in %s", len(out), file_url.rsplit("/", 1)[-1])
    return out


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    sel = variable.selectors["icon-2i"]
    file_url = url(run, variable)
    offsets = message_offsets(client, file_url)
    wanted = f"0-{step}" if sel.step_range_prefix == "0-" else str(step)
    # steps are hourly from 0: normally the right message is at index `step`
    candidates = [step] + [i for i in range(len(offsets)) if i != step]
    for i in candidates:
        if i >= len(offsets):
            continue
        off, length = offsets[i]
        fields = decode_grib(_range(client, file_url, off, off + length - 1))
        if fields and fields[0].step_range == wanted:
            return crop(select(fields, sel), bbox)
    raise NotAvailable(f"ICON-2I {run:%Y%m%d%H} +{step}h non trovato nel file")
