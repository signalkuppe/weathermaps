"""GFS 0.25° via filtro GRIB di NOMADS, già ritagliato sul box."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from urllib.parse import urlencode

import httpx
import numpy as np

from ..config import BBox
from ..grid import Field, crop, decode_grib, select
from ..variables import Variable, dewpoint_from_rh_k, wet_bulb_zero_m
from . import ModelInfo, NotAvailable

MODEL = ModelInfo(
    id="gfs",
    label="GFS 0.25°",
    resolution=0.25,
    cycles=(0, 6, 12, 18),
    delay_hours=3.5,
    max_step=384,
    country="us",
    description=(
        "Modello globale del servizio meteo statunitense (NOAA/NCEP). Griglia di 0,25° (circa 25 km), "
        "4 corse al giorno (00, 06, 12, 18 UTC), qui fino a +192h. Utile per la tendenza a medio termine; "
        "per la griglia larga smussa molto i rilievi e le precipitazioni locali."
    ),
)

FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
WET_ZERO_LEVELS = (1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500)


def url(run: datetime, step: int, variable: Variable, bbox: BBox) -> str:
    sel = variable.selectors["gfs"]
    hh = f"{run.hour:02d}"
    params = {
        "dir": f"/gfs.{run:%Y%m%d}/{hh}/atmos",
        "file": f"gfs.t{hh}z.pgrb2.0p25.f{step:03d}",
        f"var_{sel.var}": "on",
        f"lev_{sel.level}": "on",
        "subregion": "",
        "toplat": f"{bbox.lat_max:g}",
        "leftlon": f"{bbox.lon_min:g}",
        "rightlon": f"{bbox.lon_max:g}",
        "bottomlat": f"{bbox.lat_min:g}",
    }
    if variable.id == "hwzero":
        params.pop(f"var_{sel.var}")
        params.pop(f"lev_{sel.level}")
        params.update({f"var_{name}": "on" for name in ("TMP", "RH", "HGT", "DPT", "PRES")})
        params.update({f"lev_{level}_mb": "on" for level in WET_ZERO_LEVELS})
        params.update({"lev_2_m_above_ground": "on", "lev_surface": "on"})
    return f"{FILTER_URL}?{urlencode(params)}"


def _wet_zero(fields: list[Field], bbox: BBox) -> Field:
    def field(name: str, level_type: str, level: float, units: str) -> Field:
        matches = [item for item in fields if item.short_name == name
                   and item.level_type == level_type and item.level == level]
        if len(matches) != 1:
            raise ValueError(f"GFS wet-zero: expected one {name} {level_type} {level}")
        result = crop(matches[0], bbox)
        if result.units != units:
            raise ValueError(f"GFS wet-zero: unexpected {name} units {result.units}")
        return result

    surface = field("sp", "surface", 0, "Pa")
    terrain = field("orog", "surface", 0, "m")
    temperature = field("2t", "heightAboveGround", 2, "K")
    dewpoint = field("2d", "heightAboveGround", 2, "K")

    def values(item: Field) -> np.ndarray:
        if item.values.shape != surface.values.shape or item.grid_dict() != surface.grid_dict():
            raise ValueError("GFS wet-zero: incompatible grids")
        return item.values

    temperatures = [values(temperature)]
    dewpoints = [values(dewpoint)]
    pressures = [surface.values / 100]
    heights = [values(terrain) + 2]
    for level in WET_ZERO_LEVELS:
        level_t = values(field("t", "isobaricInhPa", level, "K"))
        humidity = values(field("r", "isobaricInhPa", level, "%"))
        temperatures.append(level_t)
        dewpoints.append(dewpoint_from_rh_k(level_t, humidity))
        pressures.append(np.full_like(surface.values, level))
        heights.append(values(field("gh", "isobaricInhPa", level, "gpm")))
    height = wet_bulb_zero_m(
        np.stack(temperatures), np.stack(dewpoints), np.stack(pressures),
        np.stack(heights), surface.values / 100, terrain.values,
    )
    return replace(surface, values=height, units="m", short_name="hwzero")


def fetch(client: httpx.Client, run: datetime, step: int, variable: Variable, bbox: BBox) -> Field:
    resp = client.get(url(run, step, variable, bbox))
    if resp.status_code == 404 or (resp.status_code == 200 and not resp.content.startswith(b"GRIB")):
        # NOMADS risponde con HTML/testo se il file non esiste ancora
        raise NotAvailable(f"GFS {run:%Y%m%d%H} f{step:03d} non disponibile")
    resp.raise_for_status()
    fields = decode_grib(resp.content)
    if variable.id == "hwzero":
        return _wet_zero(fields, bbox)
    field = select(fields, variable.selectors["gfs"])
    return crop(field, bbox)
