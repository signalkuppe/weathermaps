"""Modelli ItaliaMeteo su MeteoHub ("singola variabile"): WRF (CIMA/LaMMA) e MOLOCH (CNR-ISAC).

Per ogni corsa e variabile c'è un file con tutti i passi orari, anche centinaia di MB.
Si leggono solo le intestazioni dei messaggi GRIB2 (parametro, livello, passo) con piccole
richieste a intervalli di byte, poi si scaricano solo i messaggi dei passi necessari.
Le griglie (Lambert per WRF, ruotata per MOLOCH) vengono riportate su una griglia regolare
con il punto del modello più vicino; le coordinate si ricavano dal messaggio stesso.
"""
from __future__ import annotations

import hashlib
import logging
import struct
from dataclasses import dataclass
from datetime import datetime

import eccodes
import httpx
import numpy as np

from ..config import BBox, get_data_dir
from ..grid import Field
from ..variables import Variable
from . import ModelInfo, NotAvailable
from .meteoswiss import Regridder

log = logging.getLogger("weathermaps.meteohub")

ROOT = "https://meteohub.agenziaitaliameteo.it/nwp"
HEADER_BYTES = 4096  # sezioni 0–4 di un messaggio stanno quasi sempre in pochi KB
UNIT_HOURS = {0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 1 / 3600}


@dataclass
class MessageInfo:
    offset: int
    length: int
    code: tuple[int, int, int]  # disciplina, categoria, numero
    level_type: int
    level: float
    step: float  # fine dell'intervallo (accumulate) o istante, in ore
    accum_from: float | None  # inizio dell'intervallo per le grandezze accumulate


def parse_header(buf: bytes, offset: int) -> MessageInfo:
    """Legge disciplina, parametro, livello e passo dalle sezioni 0–4 di un messaggio GRIB2."""
    if buf[:4] != b"GRIB" or buf[7] != 2:
        raise ValueError(f"Intestazione GRIB2 inattesa all'offset {offset}")
    discipline = buf[6]
    length = int.from_bytes(buf[8:16], "big")
    pos = 16
    while pos + 5 <= len(buf):
        sec_len = int.from_bytes(buf[pos:pos + 4], "big")
        sec_num = buf[pos + 4]
        if sec_num == 4:
            if pos + sec_len > len(buf):
                raise BufferError("sezione 4 oltre i byte letti")
            s4 = buf[pos:pos + sec_len]
            template = int.from_bytes(s4[7:9], "big")
            cat, num = s4[9], s4[10]
            unit = UNIT_HOURS.get(s4[17], 1)
            ftime = int.from_bytes(s4[18:22], "big") * unit
            level_type = s4[22]
            scale = struct.unpack(">b", s4[23:24])[0]
            level = int.from_bytes(s4[24:28], "big") / (10 ** scale if scale else 1)
            accum_from, step = None, ftime
            if template == 8:  # statistica su un intervallo (es. pioggia accumulata)
                n_ranges = s4[41]
                if n_ranges >= 1:
                    r_unit = UNIT_HOURS.get(s4[48], 1)
                    r_len = int.from_bytes(s4[49:53], "big") * r_unit
                    accum_from, step = ftime, ftime + r_len
            return MessageInfo(offset, length, (discipline, cat, num), level_type, level, step, accum_from)
        if sec_len <= 0:
            break
        pos += sec_len
    raise BufferError("sezione 4 non trovata nei byte letti")


class MeteoHubSource:
    def __init__(self, model: ModelInfo, dataset: str, prefix: str, dlat: float, dlon: float):
        self.MODEL = model
        self.dataset = dataset
        self.prefix = prefix
        self.dlat = dlat
        self.dlon = dlon
        self._index: dict[str, list[MessageInfo]] = {}
        self._regridders: dict[str, Regridder] = {}
        # somme progressive per le piogge a intervalli orari: url -> (ultima ora sommata, somma, regridder, unità)
        self._sums: dict[str, tuple[int, np.ndarray, Regridder, str]] = {}

    def url(self, run: datetime, variable: Variable) -> str:
        sel = variable.selectors[self.MODEL.id]
        return f"{ROOT}/{self.dataset}/{run:%Y%m%d%H}/{sel.param}/{self.prefix}_{run:%Y%m%d%H}_{sel.levtype}-{sel.levelist}.grib"

    def _range(self, client: httpx.Client, url: str, start: int, end: int) -> bytes:
        resp = client.get(url, headers={"Range": f"bytes={start}-{end}"})
        if resp.status_code == 404:
            raise NotAvailable(f"{self.MODEL.id}: file non disponibile {url}")
        resp.raise_for_status()
        if resp.status_code != 206:
            raise ValueError(f"Il server non rispetta le richieste parziali ({resp.status_code})")
        return resp.content

    def index(self, client: httpx.Client, url: str) -> list[MessageInfo]:
        if url in self._index:
            return self._index[url]
        head = client.head(url)
        if head.status_code == 404:
            raise NotAvailable(f"{self.MODEL.id}: file non disponibile {url}")
        head.raise_for_status()
        total = int(head.headers["content-length"])
        out: list[MessageInfo] = []
        off = 0
        while off < total:
            size = HEADER_BYTES
            while True:
                buf = self._range(client, url, off, min(off + size, total) - 1)
                try:
                    info = parse_header(buf, off)
                    break
                except BufferError:
                    if size >= 1 << 20:
                        raise
                    size *= 4
            out.append(info)
            off += info.length
        self._index[url] = out
        log.info("%s: %d messaggi indicizzati in %s", self.MODEL.id, len(out), url.rsplit("/", 1)[-1])
        return out

    def _regridder(self, gid, bbox: BBox) -> Regridder:
        ni, nj = eccodes.codes_get(gid, "Ni"), eccodes.codes_get(gid, "Nj")
        lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        gkey = hashlib.sha1(f"{eccodes.codes_get(gid, 'gridType')}:{ni}x{nj}:{lat1}:{lon1}".encode()).hexdigest()[:10]
        key = f"{gkey}-{bbox.key}"
        if key in self._regridders:
            return self._regridders[key]
        path = get_data_dir() / bbox.key / f"{self.MODEL.id}-regrid-{gkey}.npz"
        if path.exists():
            rg = Regridder.load(path)
        else:
            lat = eccodes.codes_get_array(gid, "latitudes")
            lon = eccodes.codes_get_array(gid, "longitudes")
            lon = (lon + 180) % 360 - 180
            rg = Regridder.build(lat, lon, bbox, self.dlat, self.dlon)
            rg.save(path)
            log.info("%s: griglia regolare %dx%d, %.0f%% dentro il dominio",
                     self.MODEL.id, rg.index.shape[1], rg.index.shape[0], 100 * rg.valid.mean())
        self._regridders[key] = rg
        return rg

    def _decode(self, data: bytes, bbox: BBox) -> tuple[np.ndarray, Regridder, str, str]:
        gid = eccodes.codes_new_from_message(data)
        try:
            values = eccodes.codes_get_values(gid).astype(np.float64)
            if eccodes.codes_get(gid, "bitmapPresent"):
                values[values == eccodes.codes_get(gid, "missingValue")] = np.nan
            return values, self._regridder(gid, bbox), str(eccodes.codes_get(gid, "stepRange")), eccodes.codes_get(gid, "units")
        finally:
            eccodes.codes_release(gid)

    def _fetch_bucket_sum(self, client: httpx.Client, url: str, sel, step: int, bbox: BBox) -> Field:
        """Totale da inizio corsa sommando le piogge orarie (k-1, k] per k = 1..step, in modo incrementale."""
        buckets = {int(round(m.step)): m for m in self.index(client, url)
                   if m.code == sel.code and m.accum_from is not None and abs(m.step - m.accum_from - 1) < 1e-6}
        last, total, rg, units = self._sums.get(url, (0, None, None, ""))
        if last > step:  # richiesta di un passo precedente: si ricomincia
            last, total, rg = 0, None, None
        for k in range(last + 1, step + 1):
            m = buckets.get(k)
            if m is None:
                raise NotAvailable(f"{self.MODEL.id}: pioggia oraria {k - 1}-{k}h mancante")
            values, rg, _, units = self._decode(self._range(client, url, m.offset, m.offset + m.length - 1), bbox)
            total = values if total is None else total + values
        if total is None:
            raise NotAvailable(f"{self.MODEL.id}: nessuna pioggia oraria fino a +{step}h")
        self._sums[url] = (step, total, rg, units)
        return Field(values=rg.apply(total), lat0=rg.lat0, lon0=rg.lon0, dlat=rg.dlat, dlon=rg.dlon,
                     short_name=sel.param or "", step_range=f"0-{step}", units=units)

    def fetch(self, client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
        sel = variable.selectors[self.MODEL.id]
        url = self.url(run, variable)
        if sel.hourly_buckets:
            return self._fetch_bucket_sum(client, url, sel, step, bbox)
        accum = sel.step_range_prefix == "0-"
        for m in self.index(client, url):
            if sel.code and m.code != sel.code:
                continue
            if abs(m.step - step) > 1e-6:
                continue
            if accum and (m.accum_from is None or abs(m.accum_from) > 1e-6):
                continue
            values, rg, step_range, units = self._decode(self._range(client, url, m.offset, m.offset + m.length - 1), bbox)
            return Field(values=rg.apply(values), lat0=rg.lat0, lon0=rg.lon0, dlat=rg.dlat, dlon=rg.dlon,
                         short_name=sel.param or "", step_range=step_range, units=units)
        raise NotAvailable(f"{self.MODEL.id} {run:%Y%m%d%H} +{step}h non presente nel file")


wrf = MeteoHubSource(
    ModelInfo(
        id="wrf", label="WRF 1,5 km", resolution=0.015, cycles=(0, 12), delay_hours=8.0, max_step=72, country="it",
        description=(
            "Modello WRF della catena operativa nazionale (ItaliaMeteo con Fondazione CIMA e LaMMA), "
            "a 1,5 km sull'Italia. Corse delle 00 e 12 UTC fino a +72h, disponibili circa 8 ore dopo."
        ),
    ),
    dataset="WRF", prefix="WRF", dlat=0.015, dlon=0.02,  # ~1.6 km a 45°N
)

# MOLOCH: escluso per ora (pioggia ora per ora, ~430 MB per corsa da un server lento).
# Per riattivarlo: aggiungerlo a SOURCES in fetcher.py e aggiungere in variables.py i selettori
#   tp:   GribSelector(param="unknown", levtype="surface", levelist="0", code=(0, 1, 8), step_range_prefix="0-", hourly_buckets=True)
#   t850: GribSelector(param="t", levtype="isobaricInhPa", levelist="850", code=(0, 0, 0))
moloch = MeteoHubSource(
    ModelInfo(
        id="moloch", label="MOLOCH 1,5 km", resolution=0.015, cycles=(0, 12), delay_hours=6.0, max_step=72, country="it",
        description=(
            "Modello MOLOCH del CNR-ISAC (catena ItaliaMeteo e Consorzio Moloch), a 1,5 km, "
            "pensato per orografia e fenomeni convettivi. Di norma una corsa al giorno (00 UTC) fino a +72h; "
            "dati CC-BY-SA."
        ),
    ),
    dataset="MOLOCH_AIM", prefix="MOLOCH_AIM", dlat=0.015, dlon=0.02,
)
