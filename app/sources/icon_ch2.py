"""MeteoSvizzera ICON-CH2-EPS (corsa di controllo) via Open Data STAC API.

I campi sono su griglia ICON non strutturata (triangoli, ~2.1 km): vengono riportati
su una griglia regolare lat/lon con il punto del modello più vicino. Le coordinate
delle celle arrivano dal file "horizontal_constants" della collezione e si scaricano una volta.
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

log = logging.getLogger("weathermaps.icon_ch2")

MODEL = ModelInfo(
    id="icon-ch2",
    label="ICON-CH2 2 km",
    resolution=0.02,
    cycles=(0, 6, 12, 18),
    delay_hours=2.0,
    max_step=120,
)

STAC = "https://data.geo.admin.ch/api/stac/v1"
COLLECTION = "ch.meteoschweiz.ogd-forecasting-icon-ch2"
HCONST_ASSET = "horizontal_constants_icon-ch2-eps.grib2"

# griglia regolare di destinazione: ~2.2 km in entrambe le direzioni a 45°N
TARGET_DLAT = 0.02
TARGET_DLON = 0.028
# oltre questa distanza dal punto del modello più vicino il punto è fuori dominio
MAX_DIST_KM = 3.5
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
    def build(cls, src_lat: np.ndarray, src_lon: np.ndarray, bbox: BBox) -> "Regridder":
        ny = int(round((bbox.lat_max - bbox.lat_min) / TARGET_DLAT)) + 1
        nx = int(np.floor((bbox.lon_max - bbox.lon_min) / TARGET_DLON + 1e-9)) + 1
        lats = bbox.lat_min + np.arange(ny) * TARGET_DLAT
        lons = bbox.lon_min + np.arange(nx) * TARGET_DLON
        glon, glat = np.meshgrid(lons, lats)
        tree = cKDTree(_xyz(src_lat, src_lon))
        dist, idx = tree.query(_xyz(glat.ravel(), glon.ravel()))
        valid = dist * EARTH_R_KM < MAX_DIST_KM  # corda ≈ arco per distanze piccole
        return cls(
            index=idx.reshape(ny, nx).astype(np.int32),
            valid=valid.reshape(ny, nx),
            lat0=float(bbox.lat_min),
            lon0=float(bbox.lon_min),
            dlat=TARGET_DLAT,
            dlon=TARGET_DLON,
        )

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
        return cls(index=d["index"], valid=d["valid"], lat0=lat0, lon0=lon0, dlat=dlat, dlon=dlon)


_regridders: dict[tuple[str, str], Regridder] = {}


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
            out.append(
                {
                    "short_name": eccodes.codes_get(gid, "shortName"),
                    "step_range": str(eccodes.codes_get(gid, "stepRange")),
                    "units": eccodes.codes_get(gid, "units"),
                    "uuid": eccodes.codes_get(gid, "uuidOfHGrid"),
                    "grid_type": eccodes.codes_get(gid, "gridType"),
                    "values": values,
                }
            )
        finally:
            eccodes.codes_release(gid)
    return out


def _constants_path(uuid: str) -> Path:
    return get_data_dir() / "static" / f"icon-ch2-hgrid-{uuid}.npz"


def _load_coordinates(client: httpx.Client, uuid: str) -> tuple[np.ndarray, np.ndarray]:
    path = _constants_path(uuid)
    if path.exists():
        d = np.load(path)
        return d["lat"], d["lon"]
    log.info("Scarico le coordinate della griglia ICON-CH2 (una tantum)")
    coll = client.get(f"{STAC}/collections/{COLLECTION}")
    coll.raise_for_status()
    href = coll.json()["assets"][HCONST_ASSET]["href"]
    resp = client.get(href, timeout=120)
    resp.raise_for_status()
    msgs = {m["short_name"]: m for m in decode_unstructured(resp.content) if m["short_name"] in ("tlat", "tlon")}
    if set(msgs) != {"tlat", "tlon"}:
        raise LookupError("Coordinate tlat/tlon non trovate nelle costanti ICON-CH2")
    if msgs["tlat"]["uuid"] != uuid:
        raise ValueError(f"Griglia ICON-CH2 cambiata: costanti {msgs['tlat']['uuid']} vs dati {uuid}")
    lat, lon = msgs["tlat"]["values"], msgs["tlon"]["values"]
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, lat=lat, lon=lon)
    return lat, lon


def regridder_for(client: httpx.Client, uuid: str, bbox: BBox) -> Regridder:
    key = (uuid, bbox.key)
    if key in _regridders:
        return _regridders[key]
    path = get_data_dir() / bbox.key / f"icon-ch2-regrid-{uuid}.npz"
    if path.exists():
        rg = Regridder.load(path)
    else:
        lat, lon = _load_coordinates(client, uuid)
        rg = Regridder.build(lat, lon, bbox)
        rg.save(path)
        log.info("Griglia regolare ICON-CH2: %dx%d punti, %.0f%% dentro il dominio", rg.index.shape[1], rg.index.shape[0], 100 * rg.valid.mean())
    _regridders[key] = rg
    return rg


def find_asset(client: httpx.Client, run: datetime, step: int, variable: Variable) -> str:
    sel = variable.selectors["icon-ch2"]
    body = {
        "collections": [COLLECTION],
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
        raise NotAvailable(f"ICON-CH2 {run:%Y%m%d%H} +{step}h non disponibile")
    assets = features[0]["assets"]
    return next(iter(assets.values()))["href"]


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    sel = variable.selectors["icon-ch2"]
    href = find_asset(client, run, step, variable)  # URL firmato: va usato subito
    resp = client.get(href)
    if resp.status_code == 404:
        raise NotAvailable(f"ICON-CH2 {run:%Y%m%d%H} +{step}h file non disponibile")
    resp.raise_for_status()
    msgs = decode_unstructured(resp.content)
    if sel.short_name:
        msgs = [m for m in msgs if m["short_name"] == sel.short_name]
    if sel.step_range_prefix:
        msgs = [m for m in msgs if m["step_range"].startswith(sel.step_range_prefix)]
    if not msgs:
        raise LookupError(f"Nessun messaggio {sel} nel file ICON-CH2")
    m = msgs[0]
    if m["grid_type"] != "unstructured_grid":
        raise ValueError(f"gridType inatteso per ICON-CH2: {m['grid_type']}")
    rg = regridder_for(client, m["uuid"], bbox)
    return Field(
        values=rg.apply(m["values"]),
        lat0=rg.lat0,
        lon0=rg.lon0,
        dlat=rg.dlat,
        dlon=rg.dlon,
        short_name=m["short_name"],
        step_range=m["step_range"],
        units=m["units"],
    )
