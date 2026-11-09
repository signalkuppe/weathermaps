"""MeteoSvizzera ICON-CH1-EPS e ICON-CH2-EPS (corsa di controllo) via Open Data STAC API.

I campi sono su griglia ICON non strutturata (triangoli): vengono riportati su una griglia
regolare lat/lon con il punto del modello più vicino. Le coordinate delle celle arrivano dal
file "horizontal_constants" della collezione e si scaricano una volta sola.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import eccodes
import httpx
import numpy as np
from scipy.spatial import cKDTree

from ..config import BBox, get_data_dir
from ..grid import Field
from ..variables import Variable
from . import ModelInfo, NotAvailable

log = logging.getLogger("weathermaps.meteoswiss")

STAC = "https://data.geo.admin.ch/api/stac/v1"
MAX_DIST_KM = 3.5  # oltre questa distanza dalla cella più vicina il punto è fuori dominio
EARTH_R_KM = 6371.0


def horizon(step: int) -> str:
    """Formato ISO 8601 usato dalla STAC API, es. 27 -> 'P1DT03H00M00S'."""
    return f"P{step // 24}DT{step % 24:02d}H00M00S"


def _xyz(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    la, lo = np.radians(lat), np.radians(lon)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


@dataclass
class Regridder:
    """Mappa fissa: per ogni punto della griglia regolare, l'indice della cella ICON più vicina."""

    index: np.ndarray  # (ny, nx) int32
    valid: np.ndarray  # (ny, nx) bool
    lat0: float
    lon0: float
    dlat: float
    dlon: float

    @classmethod
    def build(cls, src_lat: np.ndarray, src_lon: np.ndarray, bbox: BBox, dlat: float, dlon: float,
              max_dist_km: float = MAX_DIST_KM) -> "Regridder":
        ny = int(round((bbox.lat_max - bbox.lat_min) / dlat)) + 1
        nx = int(np.floor((bbox.lon_max - bbox.lon_min) / dlon + 1e-9)) + 1
        lats = bbox.lat_min + np.arange(ny) * dlat
        lons = bbox.lon_min + np.arange(nx) * dlon
        glon, glat = np.meshgrid(lons, lats)
        tree = cKDTree(_xyz(src_lat, src_lon))
        dist, idx = tree.query(_xyz(glat.ravel(), glon.ravel()))
        valid = dist * EARTH_R_KM < max_dist_km  # corda ≈ arco per distanze piccole
        return cls(idx.reshape(ny, nx).astype(np.int32), valid.reshape(ny, nx),
                   float(bbox.lat_min), float(bbox.lon_min), dlat, dlon)

    def apply(self, values: np.ndarray) -> np.ndarray:
        out = values[self.index].astype(np.float32)
        out[~self.valid] = np.nan
        return out

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(path, index=self.index, valid=self.valid, meta=np.array([self.lat0, self.lon0, self.dlat, self.dlon]))

    @classmethod
    def load(cls, path: Path) -> "Regridder":
        d = np.load(path)
        lat0, lon0, dlat, dlon = (float(x) for x in d["meta"])
        return cls(d["index"], d["valid"], lat0, lon0, dlat, dlon)


def decode_unstructured(data: bytes) -> list[dict]:
    """Decodifica messaggi GRIB su griglia non strutturata (valori + metadati utili)."""
    out = []
    offset = 0
    while True:
        start = data.find(b"GRIB", offset)
        if start < 0:
            break
        length = int.from_bytes(data[start + 8 : start + 16], "big")
        gid = eccodes.codes_new_from_message(bytes(data[start : start + length]))
        offset = start + length
        try:
            values = eccodes.codes_get_values(gid).astype(np.float64)
            if eccodes.codes_get(gid, "bitmapPresent"):
                values[values == eccodes.codes_get(gid, "missingValue")] = np.nan
            out.append({
                "short_name": eccodes.codes_get(gid, "shortName"),
                "step_range": str(eccodes.codes_get(gid, "stepRange")),
                "units": eccodes.codes_get(gid, "units"),
                "uuid": eccodes.codes_get(gid, "uuidOfHGrid"),
                "grid_type": eccodes.codes_get(gid, "gridType"),
                "values": values,
            })
        finally:
            eccodes.codes_release(gid)
    return out


class MeteoSwissSource:
    """Una sorgente ICON-CH: stessa API e riproiezione, cambiano collezione e griglia di arrivo."""

    def __init__(self, model: ModelInfo, collection: str, hconst_asset: str, dlat: float, dlon: float):
        self.MODEL = model
        self.collection = collection
        self.hconst_asset = hconst_asset
        self.dlat = dlat
        self.dlon = dlon
        self._regridders: dict[tuple[str, str], Regridder] = {}

    # --- coordinate della griglia ICON e riproiezione
    def _constants_path(self, uuid: str) -> Path:
        return get_data_dir() / "static" / f"{self.MODEL.id}-hgrid-{uuid}.npz"

    def _load_coordinates(self, client: httpx.Client, uuid: str) -> tuple[np.ndarray, np.ndarray]:
        path = self._constants_path(uuid)
        if path.exists():
            d = np.load(path)
            return d["lat"], d["lon"]
        log.info("%s: scarico le coordinate della griglia (una tantum)", self.MODEL.id)
        coll = client.get(f"{STAC}/collections/{self.collection}")
        coll.raise_for_status()
        href = coll.json()["assets"][self.hconst_asset]["href"]
        resp = client.get(href, timeout=300)
        resp.raise_for_status()
        msgs = {m["short_name"]: m for m in decode_unstructured(resp.content) if m["short_name"] in ("tlat", "tlon")}
        if set(msgs) != {"tlat", "tlon"}:
            raise LookupError(f"Coordinate tlat/tlon non trovate nelle costanti {self.MODEL.id}")
        if msgs["tlat"]["uuid"] != uuid:
            raise ValueError(f"Griglia {self.MODEL.id} cambiata: costanti {msgs['tlat']['uuid']} vs dati {uuid}")
        lat, lon = msgs["tlat"]["values"], msgs["tlon"]["values"]
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(path, lat=lat, lon=lon)
        return lat, lon

    def regridder_for(self, client: httpx.Client, uuid: str, bbox: BBox) -> Regridder:
        key = (uuid, bbox.key)
        if key in self._regridders:
            return self._regridders[key]
        path = get_data_dir() / bbox.key / f"{self.MODEL.id}-regrid-{uuid}.npz"
        if path.exists():
            rg = Regridder.load(path)
        else:
            lat, lon = self._load_coordinates(client, uuid)
            rg = Regridder.build(lat, lon, bbox, self.dlat, self.dlon)
            rg.save(path)
            log.info("%s: griglia regolare %dx%d, %.0f%% dentro il dominio",
                     self.MODEL.id, rg.index.shape[1], rg.index.shape[0], 100 * rg.valid.mean())
        self._regridders[key] = rg
        return rg

    # --- dati
    def find_asset(self, client: httpx.Client, run: datetime, step: int, variable: Variable) -> str:
        sel = variable.selectors[self.MODEL.id]
        body = {
            "collections": [self.collection],
            "forecast:reference_datetime": run.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "forecast:variable": sel.param,
            "forecast:perturbed": False,  # corsa di controllo
            "forecast:horizon": horizon(step),
            "limit": 1,
        }
        resp = client.post(f"{STAC}/search", json=body)
        resp.raise_for_status()
        features = resp.json().get("features", [])
        if not features:
            raise NotAvailable(f"{self.MODEL.id} {run:%Y%m%d%H} +{step}h non disponibile")
        return next(iter(features[0]["assets"].values()))["href"]

    def fetch(self, client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
        sel = variable.selectors[self.MODEL.id]
        href = self.find_asset(client, run, step, variable)  # URL firmato: va usato subito
        resp = client.get(href)
        if resp.status_code == 404:
            raise NotAvailable(f"{self.MODEL.id} {run:%Y%m%d%H} +{step}h file non disponibile")
        resp.raise_for_status()
        msgs = decode_unstructured(resp.content)
        if sel.short_name:
            msgs = [m for m in msgs if m["short_name"] == sel.short_name]
        if sel.step_range_prefix:
            msgs = [m for m in msgs if m["step_range"].startswith(sel.step_range_prefix)]
        if not msgs:
            raise LookupError(f"Nessun messaggio {sel} nel file {self.MODEL.id}")
        m = msgs[0]
        if m["grid_type"] != "unstructured_grid":
            raise ValueError(f"gridType inatteso per {self.MODEL.id}: {m['grid_type']}")
        rg = self.regridder_for(client, m["uuid"], bbox)
        return Field(values=rg.apply(m["values"]), lat0=rg.lat0, lon0=rg.lon0, dlat=rg.dlat, dlon=rg.dlon,
                     short_name=m["short_name"], step_range=m["step_range"], units=m["units"])


icon_ch2 = MeteoSwissSource(
    ModelInfo(id="icon-ch2", label="ICON-CH2 2 km", resolution=0.02, cycles=(0, 6, 12, 18), delay_hours=2.0, max_step=120),
    collection="ch.meteoschweiz.ogd-forecasting-icon-ch2",
    hconst_asset="horizontal_constants_icon-ch2-eps.grib2",
    dlat=0.02, dlon=0.028,  # ~2.2 km a 45°N
)

icon_ch1 = MeteoSwissSource(
    ModelInfo(id="icon-ch1", label="ICON-CH1 1 km", resolution=0.01, cycles=(0, 3, 6, 9, 12, 15, 18, 21), delay_hours=1.5, max_step=33),
    collection="ch.meteoschweiz.ogd-forecasting-icon-ch1",
    hconst_asset="horizontal_constants_icon-ch1-eps.grib2",
    dlat=0.01, dlon=0.014,  # ~1.1 km a 45°N
)
