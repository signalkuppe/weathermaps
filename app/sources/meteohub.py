"""ItaliaMeteo models on MeteoHub ("single variable"): WRF (CIMA/LaMMA) and MOLOCH (CNR-ISAC); plus the CNR-ISAC
BOLAM and MOLOCH "open data" bundles (one file per run with all the surface fields, see OpenDataSource).

For each run and variable there is a file with all hourly steps, even hundreds of MB.
Only the GRIB2 message headers (parameter, level, step) are read with small
byte-range requests, then only the messages of the needed steps are downloaded.
The grids (Lambert for WRF, rotated for MOLOCH) are remapped to a regular grid
with the nearest model point; the coordinates come from the message itself.
"""
from __future__ import annotations

import hashlib
import logging
import struct
import time
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
API = "https://meteohub.agenziaitaliameteo.it/api"
LEVEL_TYPES = {"surface": 1, "heightAboveGround": 103, "isobaricInhPa": 100}
LISTING_TTL = 600  # seconds between two reads of the list of open data bundles
HEADER_BYTES = 4096  # sections 0–4 of a message almost always fit in a few KB
UNIT_HOURS = {0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 1 / 3600}


@dataclass
class MessageInfo:
    offset: int
    length: int
    code: tuple[int, int, int]  # discipline, category, number
    level_type: int
    level: float
    step: float  # end of the interval (accumulated) or instant, in hours
    accum_from: float | None  # start of the interval for accumulated fields


def parse_header(buf: bytes, offset: int) -> MessageInfo:
    """Reads discipline, parameter, level and step from sections 0–4 of a GRIB2 message."""
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
            if template == 8:  # statistics over an interval (e.g. accumulated precipitation)
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
    def __init__(self, model: ModelInfo, dataset: str, prefix: str, dlat: float, dlon: float,
                 max_dist_km: float | None = None):
        self.MODEL = model
        self.max_dist_km = max_dist_km  # None = the Regridder default (fine grids)
        self.dataset = dataset
        self.prefix = prefix
        self.dlat = dlat
        self.dlon = dlon
        self._index: dict[str, list[MessageInfo]] = {}
        self._regridders: dict[str, Regridder] = {}
        # running sums for hourly-interval precipitation: url -> (last hour summed, sum, regridder, unit)
        self._sums: dict[str, tuple[int, np.ndarray, Regridder, str]] = {}

    def _matches(self, m: MessageInfo, sel) -> bool:
        """Extra filter on the messages of a file (the single-variable files need none)."""
        return True

    def _url(self, client: httpx.Client, run: datetime, variable: Variable) -> str:
        return self.url(run, variable)

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
        log.info("%s: %d messages indexed in %s", self.MODEL.id, len(out), url.rsplit("/", 1)[-1])
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
            extra = {"max_dist_km": self.max_dist_km} if self.max_dist_km else {}
            rg = Regridder.build(lat, lon, bbox, self.dlat, self.dlon, **extra)
            rg.save(path)
            log.info("%s: regular grid %dx%d, %.0f%% inside the domain",
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
        """Total since the start of the run by summing the hourly precipitation (k-1, k] for k = 1..step, incrementally."""
        buckets = {int(round(m.step)): m for m in self.index(client, url)
                   if m.code == sel.code and self._matches(m, sel) and m.accum_from is not None and abs(m.step - m.accum_from - 1) < 1e-6}
        last, total, rg, units = self._sums.get(url, (0, None, None, ""))
        if last > step:  # request for an earlier step: start over
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
        url = self._url(client, run, variable)
        if sel.hourly_buckets:
            return self._fetch_bucket_sum(client, url, sel, step, bbox)
        accum = sel.step_range_prefix == "0-"
        for m in self.index(client, url):
            if sel.code and m.code != sel.code:
                continue
            if not self._matches(m, sel):
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
    dataset="WRF", prefix="WRF", dlat=0.015, dlon=0.02,  # ~1.6 km at 45°N
)

# MOLOCH: rotated grid of 0.0091° (~1 km) over Italy, one file per variable with the 73 hourly steps (~6 MB per
# instant field and step; the hourly precipitation and snow messages are small, mostly zero). The 00 UTC run comes out
# about 8h30 after, the 12 UTC one about 9h after. Remapped like WRF (~1.6 km) so as not to weigh more on the site.
moloch = MeteoHubSource(
    ModelInfo(
        id="moloch", base="IFS", label="MOLOCH 1 km", resolution=0.0091, cycles=(0, 12), delay_hours=8.5, max_step=72, country="it",
        description=(
            "Modello MOLOCH del CNR-ISAC (catena ItaliaMeteo e Consorzio Moloch), a circa 1 km sull'Italia, "
            "pensato per orografia e fenomeni convettivi. Corse delle 00 e 12 UTC fino a +72h, disponibili circa "
            "8-9 ore dopo; dati CC-BY-SA."
        ),
    ),
    dataset="MOLOCH_AIM", prefix="MOLOCH_AIM", dlat=0.015, dlon=0.02,
)


class OpenDataSource(MeteoHubSource):
    """CNR-ISAC BOLAM and MOLOCH "open data" bundles: one GRIB file per run with all the hourly steps of a few
    surface fields (2 m temperature and dew point, 10 m wind, hourly precipitation, cloud cover, snow on the ground).
    The file name is not predictable: it comes from the dataset's list of bundles (date and hour of the run).
    The messages are told apart by WMO code and level (e.g. 2 m and ground temperature share the code); MOLOCH
    also repeats some fields every 3 hours on a coarser grid, after the full one: the first match is the full one.
    """

    def __init__(self, model: ModelInfo, dataset: str, dlat: float, dlon: float, max_dist_km: float | None = None):
        super().__init__(model, dataset=dataset, prefix=dataset, dlat=dlat, dlon=dlon, max_dist_km=max_dist_km)
        self._listing: tuple[float, list[dict]] = (0.0, [])

    def _matches(self, m: MessageInfo, sel) -> bool:
        if sel.levtype is None:
            return True
        level = float(sel.levelist or 0)
        return m.level_type == LEVEL_TYPES[sel.levtype] and abs(m.level - level) < 1e-6

    def bundles(self, client: httpx.Client) -> list[dict]:
        at, items = self._listing
        if time.monotonic() - at > LISTING_TTL or not items:
            resp = client.get(f"{API}/datasets/{self.dataset}/opendata")
            resp.raise_for_status()
            items = resp.json()
            self._listing = (time.monotonic(), items)
        return items

    def _url(self, client: httpx.Client, run: datetime, variable: Variable) -> str:
        for item in self.bundles(client):
            if item.get("date") == f"{run:%Y-%m-%d}" and item.get("run") == f"{run:%H}:00":
                return f"{API}/opendata/{item['filename']}"
        raise NotAvailable(f"{self.MODEL.id} {run:%Y%m%d%H}: corsa non ancora pubblicata")


ISAC_CHAIN = (
    "Catena GLOBO-BOLAM-MOLOCH del CNR-ISAC: il modello globale GLOBO parte dalle analisi del GFS (NOAA), "
    "BOLAM prende i bordi da GLOBO e MOLOCH da BOLAM. Pubblica solo grandezze al suolo: niente quota "
    "né sondaggi. Dati open data ItaliaMeteo (MeteoHub), CC-BY-SA."
)

bolam = OpenDataSource(
    ModelInfo(
        id="bolam", base="GFS", label="BOLAM 8 km", resolution=0.075, cycles=(0,), delay_hours=5.5, max_step=72, country="it",
        description=(
            "Modello BOLAM del CNR-ISAC, a circa 8 km su Europa e Mediterraneo. Corsa delle 00 UTC fino a +72h, "
            "disponibile circa 5 ore dopo. " + ISAC_CHAIN
        ),
    ),
    # 8 km cells: a point of the regular grid can be ~6 km from the nearest model point
    dataset="BOLAM", dlat=0.075, dlon=0.1, max_dist_km=12,
)

# 0.0113° rotated grid (1154x1154 points, ~2.7 MB per field and step): remapped like the other MOLOCH (~1.6 km)
moloch_isac = OpenDataSource(
    ModelInfo(
        id="moloch-isac", base="GFS", label="MOLOCH ISAC 1,2 km", resolution=0.0113, cycles=(3,), delay_hours=5.0, max_step=45,
        country="it", short="ISAC",
        description=(
            "Modello MOLOCH nella catena del CNR-ISAC, a circa 1,2 km sull'Italia, annidato in BOLAM. Corsa delle "
            "03 UTC fino a +45h, disponibile circa 5 ore dopo. " + ISAC_CHAIN
        ),
    ),
    dataset="MOLOCH", dlat=0.015, dlon=0.02,
)
