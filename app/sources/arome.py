"""Météo-France AROME 0.025° (~2.5 km) dagli Open Data pubblicati su data.gouv.fr.

I dati sono a "paquets": un file GRIB2 per gruppo di parametri e blocco di 6 ore
(SP1 = superficie, con la pioggia, ~55 MB). Solo la pioggia: T 850 hPa è nel paquet IP1
(~500 MB, ~840 messaggi), che richiederebbe ~10 minuti di lettura intestazioni per corsa.
Come per MeteoHub si leggono solo le intestazioni dei messaggi con piccole richieste a
intervalli di byte e si scaricano solo i messaggi dei passi necessari (~0,5 MB l'uno).
La griglia EURW1S40 è regolare lat/lon (37.5–55.4°N, 12°W–16°E): basta ritagliarla.
I dati validi però finiscono prima, su un bordo obliquo (~13°E a 42°N, ~14.5°E a 49°N): oltre è NaN.
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
# blocchi di passi dei paquets: (prima ora, ultima ora)
BLOCKS = ((0, 6), (7, 12), (13, 18), (19, 24), (25, 30), (31, 36), (37, 42), (43, 48), (49, 51))
INDEX_CACHE = 40  # file indicizzati tenuti in memoria (bastano per due corse)


def block(step: int) -> str:
    for start, end in BLOCKS:
        if start <= step <= end:
            return f"{start:02d}H{end:02d}H"
    raise ValueError(f"AROME: passo +{step}h oltre l'orizzonte")


class AromeSource(MeteoHubSource):
    def url(self, run: datetime, variable: Variable, step: int = 0) -> str:  # type: ignore[override]
        """Es. .../2026-11-10T03:00:00Z/arome/0025/SP1/arome__0025__SP1__07H12H__2026-11-10T03:00:00Z.grib2"""
        pkg = variable.selectors[self.MODEL.id].param
        ts = f"{run:%Y-%m-%dT%H}:00:00Z"
        return f"{ROOT}/{ts}/arome/0025/{pkg}/arome__0025__{pkg}__{block(step)}__{ts}.grib2"

    def fetch(self, client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
        sel = variable.selectors[self.MODEL.id]
        url = self.url(run, variable, step)
        while len(self._index) > INDEX_CACHE:  # i più vecchi per primi
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
        id="arome", label="AROME 2,5 km", resolution=0.025, cycles=(0, 3, 6, 9, 12, 15, 18, 21),
        delay_hours=3.5, max_step=51, country="fr",
        description=(
            "Modello ad alta risoluzione di Météo-France, a 0,025° (circa 2,5 km) su Francia e Alpi. "
            "Una corsa ogni 3 ore fino a +51h, disponibile 2–4 ore dopo. Il dominio finisce fra "
            "13 e 14,5°E: Friuli e Alto Adriatico al bordo, la costa croata e la Slovenia restano fuori."
        ),
    ),
    dataset="", prefix="", dlat=0.025, dlon=0.025,
)
