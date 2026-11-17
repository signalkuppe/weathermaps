"""GRIB2 decoding and cropping onto regular lat/lon grids."""
from __future__ import annotations

from dataclasses import dataclass, replace

import eccodes
import numpy as np

from .config import BBox
from .variables import GribSelector

EPS = 1e-6


@dataclass
class Field:
    """Regular grid with rows south→north and columns west→east.

    `lon0` is in the -180..180 range after `normalize_lon`/`crop`.
    """

    values: np.ndarray  # shape (ny, nx), float32, NaN = missing
    lat0: float  # latitude of the first row (the southernmost)
    lon0: float  # longitude of the first column (the westernmost)
    dlat: float
    dlon: float
    short_name: str = ""
    step_range: str = ""
    units: str = ""
    level_type: str = ""
    level: float = 0

    @property
    def ny(self) -> int:
        return int(self.values.shape[0])

    @property
    def nx(self) -> int:
        return int(self.values.shape[1])

    def lats(self) -> np.ndarray:
        return self.lat0 + np.arange(self.ny) * self.dlat

    def lons(self) -> np.ndarray:
        return self.lon0 + np.arange(self.nx) * self.dlon

    def grid_dict(self) -> dict:
        return {
            "lat0": round(self.lat0, 6),
            "lon0": round(self.lon0, 6),
            "dlat": round(self.dlat, 6),
            "dlon": round(self.dlon, 6),
            "nx": self.nx,
            "ny": self.ny,
        }


def decode_grib(data: bytes) -> list[Field]:
    """Decodes all messages of a GRIB buffer (regular_ll)."""
    fields: list[Field] = []
    offset = 0
    view = memoryview(data)
    while True:
        start = data.find(b"GRIB", offset)
        if start < 0:
            break
        # total length of the GRIB2 message: 8 big-endian bytes at offset 8
        edition = data[start + 7]
        if edition == 2:
            length = int.from_bytes(data[start + 8 : start + 16], "big")
        else:  # GRIB1: 3 bytes at offset 4
            length = int.from_bytes(data[start + 4 : start + 7], "big")
        msg = bytes(view[start : start + length])
        offset = start + length
        gid = eccodes.codes_new_from_message(msg)
        try:
            fields.append(_field_from_handle(gid))
        finally:
            eccodes.codes_release(gid)
    return fields


def _field_from_handle(gid) -> Field:
    grid_type = eccodes.codes_get(gid, "gridType")
    if grid_type != "regular_ll":
        raise ValueError(f"gridType non supportato: {grid_type}")
    ni = eccodes.codes_get(gid, "Ni")
    nj = eccodes.codes_get(gid, "Nj")
    lat_first = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
    lat_last = eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")
    lon_first = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
    di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
    dj = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
    i_neg = eccodes.codes_get(gid, "iScansNegatively")
    j_pos = eccodes.codes_get(gid, "jScansPositively")
    if eccodes.codes_get(gid, "jPointsAreConsecutive"):
        raise ValueError("jPointsAreConsecutive non supportato")

    values = eccodes.codes_get_values(gid).astype(np.float32).reshape(nj, ni)
    if eccodes.codes_get(gid, "bitmapPresent"):
        missing = eccodes.codes_get(gid, "missingValue")
        values[values == missing] = np.nan

    if not j_pos:  # rows north→south: flip
        values = values[::-1, :]
    lat0 = min(lat_first, lat_last)
    if i_neg:
        values = values[:, ::-1]
        lon_first = lon_first - (ni - 1) * di

    return Field(
        values=np.ascontiguousarray(values),
        lat0=float(lat0),
        lon0=float(lon_first),
        dlat=float(dj),
        dlon=float(di),
        short_name=eccodes.codes_get(gid, "shortName"),
        step_range=str(eccodes.codes_get(gid, "stepRange")),
        units=eccodes.codes_get(gid, "units"),
        level_type=eccodes.codes_get(gid, "typeOfLevel"),
        level=float(eccodes.codes_get(gid, "level")),
    )


HALF_RES_BELOW = 0.05  # degrees: only the finest grids are halved


def halve(field: Field) -> Field:
    """One cell out of two per side (a quarter of the data) if the grid is finer than 0.05°; otherwise unchanged."""
    if field.dlat >= HALF_RES_BELOW and field.dlon >= HALF_RES_BELOW:
        return field
    return Field(values=np.ascontiguousarray(field.values[::2, ::2]), lat0=field.lat0, lon0=field.lon0,
                 dlat=field.dlat * 2, dlon=field.dlon * 2, short_name=field.short_name,
                 step_range=field.step_range, units=field.units)


def lambert_to_earth(u: np.ndarray, v: np.ndarray, lons: np.ndarray, lov: float, lat1: float, lat2: float):
    """Rotates the wind from the Lambert conformal grid (secant at lat1 and lat2, central meridian lov) to geographic
    north: angle n·(lon − lov), with n the cone factor (like wrf-python's `uvmet`)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    if abs(lat1 - lat2) < 1e-6:
        n = np.sin(p1)
    else:
        n = np.log(np.cos(p1) / np.cos(p2)) / np.log(np.tan(np.pi / 4 + p2 / 2) / np.tan(np.pi / 4 + p1 / 2))
    a = np.radians(n * (np.asarray(lons) - lov))
    ca, sa = np.cos(a), np.sin(a)
    return u * ca + v * sa, v * ca - u * sa


def select(fields: list[Field], selector: GribSelector) -> Field:
    """Picks the message matching the selector (e.g. total `0-N`)."""
    candidates = fields
    if selector.short_name:
        candidates = [f for f in candidates if f.short_name == selector.short_name]
    if selector.step_range_prefix:
        candidates = [f for f in candidates if f.step_range.startswith(selector.step_range_prefix)]
    if not candidates:
        found = [(f.short_name, f.step_range) for f in fields]
        raise LookupError(f"Nessun messaggio per {selector}, trovati {found}")
    return candidates[0]


def _norm180(lon: np.ndarray | float):
    return (np.asarray(lon) + 180.0) % 360.0 - 180.0


def crop(field: Field, bbox: BBox) -> Field:
    """Crops the field to the box, handling longitudes 0..360 and the 0 meridian."""
    lons = _norm180(field.lons())
    values = field.values
    is_global = abs(field.nx * field.dlon - 360.0) < field.dlon / 2
    if is_global:
        # roll so the first column is the westernmost (-180)
        shift = int(np.argmin(lons))
        lons = np.roll(lons, -shift)
        values = np.roll(values, -shift, axis=1)
    elif np.any(np.diff(lons) <= 0):
        raise ValueError("Longitudini non monotone: griglia regionale incompatibile con il box")

    tol_lon = field.dlon * 0.01
    tol_lat = field.dlat * 0.01
    ix = np.where((lons >= bbox.lon_min - tol_lon) & (lons <= bbox.lon_max + tol_lon))[0]
    lats = field.lats()
    iy = np.where((lats >= bbox.lat_min - tol_lat) & (lats <= bbox.lat_max + tol_lat))[0]
    if ix.size == 0 or iy.size == 0:
        raise ValueError(f"Il box {bbox} non interseca la griglia")
    sub = values[iy[0] : iy[-1] + 1, ix[0] : ix[-1] + 1]
    return replace(
        field,
        values=np.ascontiguousarray(sub),
        lat0=float(lats[iy[0]]),
        lon0=float(lons[ix[0]]),
    )
