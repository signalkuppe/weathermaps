"""Météo-France AROME 0.025° (~2.5 km) and 0.01° (~1.3 km, "HD") from the Open Data published on data.gouv.fr.

The data come in "paquets": one GRIB2 file per group of parameters and 6-hour block
(SP1 = surface, with precipitation, ~55 MB). Precipitation only: T 850 hPa is in the IP1 package
(~500 MB, ~840 messages), which would take ~10 minutes of header reading per run.
As for MeteoHub, only the message headers are read with small byte-range
requests and only the messages of the needed steps are downloaded (~0.5 MB each).
The EURW1S40 grid is a regular lat/lon grid (37.5–55.4°N, 12°W–16°E): cropping is enough.
Valid data end earlier though, on a slanted edge (~13°E at 42°N, ~14.5°E at 49°N): beyond it is NaN.
"""
from __future__ import annotations

from datetime import datetime

import httpx

from ..config import BBox
from ..grid import Field, crop, decode_grib
from ..variables import Variable
from . import ModelInfo, NotAvailable
from .meteohub import MeteoHubSource

ROOT = "https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net/pnt"
# step blocks of the packages: (first hour, last hour)
BLOCKS = ((0, 6), (7, 12), (13, 18), (19, 24), (25, 30), (31, 36), (37, 42), (43, 48), (49, 51))
INDEX_CACHE = 40  # indexed files kept in memory (enough for two runs)


def block(step: int) -> str:
    for start, end in BLOCKS:
        if start <= step <= end:
            return f"{start:02d}H{end:02d}H"
    raise ValueError(f"AROME: passo +{step}h oltre l'orizzonte")


class AromeSource(MeteoHubSource):
    grid = "0025"

    def url(self, run: datetime, variable: Variable, step: int = 0) -> str:  # type: ignore[override]
        """E.g. .../2026-11-10T03:00:00Z/arome/0025/SP1/arome__0025__SP1__07H12H__2026-11-10T03:00:00Z.grib2"""
        pkg = variable.selectors[self.MODEL.id].param
        ts = f"{run:%Y-%m-%dT%H}:00:00Z"
        return f"{ROOT}/{ts}/arome/{self.grid}/{pkg}/arome__{self.grid}__{pkg}__{self.block(step)}__{ts}.grib2"

    def block(self, step: int) -> str:
        return block(step)

    def fetch(self, client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
        sel = variable.selectors[self.MODEL.id]
        url = self.url(run, variable, step)
        while len(self._index) > INDEX_CACHE:  # oldest first
            self._index.pop(next(iter(self._index)))
        accum = sel.step_range_prefix == "0-"
        level = float(sel.levelist) if sel.levelist else None
        for m in self.index(client, url):
            if m.code != sel.code or abs(m.step - step) > 1e-6:
                continue
            if level is not None and abs(m.level - level) > 1e-6:
                continue
            if accum and (m.accum_from is None or abs(m.accum_from) > 1e-6):
                continue
            fields = decode_grib(self._range(client, url, m.offset, m.offset + m.length - 1))
            return crop(fields[0], bbox)
        raise NotAvailable(f"AROME {run:%Y%m%d%H} +{step}h non presente nel file")


arome = AromeSource(
    ModelInfo(
        id="arome", base="ARPEGE", label="AROME 2,5 km", resolution=0.025, cycles=(0, 3, 6, 9, 12, 15, 18, 21),
        delay_hours=3.5, max_step=51, country="fr",
        description=(
            "Modello ad alta risoluzione di Météo-France, a 0,025° (circa 2,5 km) su Francia e Alpi. "
            "Una corsa ogni 3 ore fino a +51h, disponibile 2–4 ore dopo. Il dominio finisce fra "
            "13 e 14,5°E: Friuli e Alto Adriatico al bordo, la costa croata e la Slovenia restano fuori."
        ),
    ),
    dataset="", prefix="", dlat=0.025, dlon=0.025,
)


class AromeHDSource(AromeSource):
    """AROME 0.01°: one file per hour and package. SP1 = 2 m temperature and humidity, 10 m wind (geographic
    components, regular grid); SP2 = accumulated rain, snow and graupel since the start (total = their sum)."""

    grid = "001"

    def block(self, step: int) -> str:
        if not 0 <= step <= 51:
            raise ValueError(f"AROME HD: passo +{step}h oltre l'orizzonte")
        return f"{step:02d}H"


arome_hd = AromeHDSource(
    ModelInfo(
        id="arome-hd", base="ARPEGE", label="AROME 1,3 km", resolution=0.01, cycles=(0, 3, 6, 9, 12, 15, 18, 21),
        delay_hours=4.0, max_step=51, country="fr", short="AROME HD",
        description=(
            "AROME di Météo-France sulla griglia fine a 0,01° (circa 1,3 km, la risoluzione nativa del modello) "
            "su Francia e Alpi. Una corsa ogni 3 ore fino a +51h, disponibile 3–4 ore dopo. Come l'AROME a "
            "2,5 km il dominio finisce fra 13 e 14,5°E: Friuli e Alto Adriatico al bordo."
        ),
    ),
    dataset="", prefix="", dlat=0.01, dlon=0.01,
)
