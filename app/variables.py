"""Registry of the weather fields.

To add a field, just add a `Variable` to `REGISTRY`:
fetching, storage, API and frontend handle it generically.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Callable, Literal

import numpy as np

from .config import SYNOPTIC_BBOX

Kind = Literal["accum", "instant", "vector"]


@dataclass(frozen=True)
class GribSelector:
    """How to find the field in a model.

    GFS (NOMADS filter): `var` and `level` become `var_<var>=on` and `lev_<level>=on`.
    ECMWF (.index file): `param` and `levtype` filter the index lines.
    `short_name` and `step_range_prefix` pick the right message in the decoded GRIB.
    """

    var: str | None = None
    level: str | None = None
    param: str | None = None
    levtype: str | None = None  # "sfc" (surface) or "pl" (pressure levels)
    levelist: str | None = None  # pressure level for levtype "pl", e.g. "850"
    short_name: str | None = None
    step_range_prefix: str | None = None
    # WMO code of the parameter (discipline, category, number): for files where ecCodes does not know the name
    code: tuple[int, int, int] | None = None
    # precipitation split into consecutive intervals (0-1h, 1-2h, ...) to be summed to get the total
    hourly_buckets: bool = False
    # other fields to download and add to this one (e.g. ICON snow: grid-scale + convective)
    plus: tuple["GribSelector", ...] = ()
    # wind relative to the model's Lambert grid (WRF): the other component (`pair`) and the projection
    # (LoV, Latin1, Latin2 in degrees) to rotate it to geographic north; `component` is "u" or "v"
    pair: "GribSelector | None" = None
    lambert: tuple[float, float, float] | None = None
    component: str | None = None
    # second ingredient to download together with this field (e.g. the dew point for the wet bulb): the two
    # raw fields go to Variable.combine, which derives the one to store
    dew: "GribSelector | None" = None
    pressure: "GribSelector | None" = None


@dataclass(frozen=True)
class ColorScale:
    thresholds: list[float]  # lower bounds of the classes, increasing
    colors: list[str]  # same number as thresholds, colour of class [t_i, t_i+1)
    transparent_below: float | None = None
    # smooth: the colours are stops at the `thresholds` values and are interpolated in between (continuous fields,
    # the lines give the exact values); otherwise sharp bands, one per class (precipitation, snow)
    continuous: bool = False

    def as_dict(self) -> dict:
        return {
            "thresholds": self.thresholds,
            "colors": self.colors,
            "transparent_below": self.transparent_below,
            "continuous": self.continuous,
        }


@dataclass(frozen=True)
class Variable:
    id: str
    label: str
    units: str
    kind: Kind
    selectors: dict[str, GribSelector]  # per model: "gfs", "ecmwf"
    convert: dict[str, Callable[[float], float]]  # per model, GRIB unit -> display
    scale: ColorScale
    decimals: int = 1
    menu_label: str | None = None  # short name in the "Grandezza" (field) dropdown (fits on one line); legend and charts use label
    steps: list[int] | None = None  # None = config.STEPS
    nonnegative: bool = False
    rank: Literal["desc", "asc"] = "desc"  # ranking of the points: desc = highest value first
    extra: dict = field(default_factory=dict)
    # contour lines drawn above the colours: {"label": name in the settings, "step": distance between lines,
    # "bold": [highlighted levels], "signed": labels with the "+" sign}
    contours: dict | None = None
    # component of a vector (wind): not in the menu, the page uses it through an entry of VECTORS
    hidden: bool = False
    # grids finer than 0.05°: one cell out of two per side is stored (a quarter of the data), e.g. the wind
    half_res: bool = False
    # other (hidden) fields shown in the place popup: [{"var": id, "label": name}]
    details: list | None = None
    # fields computed from two fields (selector with `dew`): (field, second field) raw -> raw field
    combine: Callable | None = None
    # own area, instead of the map's (BBOX): "lat_min,lat_max,lon_min,lon_max". Synoptic chart: no
    # places or charts (median at 0.25°, see mean.py); the page switches to this area when the field is chosen
    area: str | None = None

    @property
    def modes(self) -> list[str]:
        return ["total", "interval"] if self.kind == "accum" else ["value"]

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "menu_label": self.menu_label,
            "units": self.units,
            "kind": self.kind,
            "modes": self.modes,
            "decimals": self.decimals,
            "rank": self.rank,
            "scale": self.scale.as_dict(),
            "contours": self.contours,
            "details": self.details,
            # "mean" = model median, available if the field has at least two models
            "models": sorted(self.selectors) + (["mean"] if len(self.selectors) > 1 else []),
            "area": _area_dict(self.area),
        }


def _area_dict(area: str | None) -> dict | None:
    if not area:
        return None
    s, n, w, e = (float(x) for x in area.split(","))
    return {"lat_min": s, "lat_max": n, "lon_min": w, "lon_max": e}


def _identity(x):
    return x


def _m_to_mm(x):
    return x * 1000.0


def _k_to_c(x):
    return x - 273.15


# Scale of the LaMMA precipitation charts (MOLOCH): above 20 mm thresholds and colours from their legend, below
# reconstructed from the colours of their maps (light blues and blues, then greens); it goes beyond 350 mm, useful
# for multi-day totals on the Alps during orographic blocking
PRECIP_SCALE = ColorScale(
    thresholds=[0.1, 1, 2, 4, 6, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100, 125, 150, 175, 200, 250, 300, 350],
    colors=[
        "#a5fcfb",  # 0.1-1
        "#68fafd",  # 1-2
        "#46c2fc",  # 2-4
        "#4597fa",  # 4-6
        "#424ff5",  # 6-10
        "#41ba3c",  # 10-15
        "#a6d621",  # 15-20
        "#f4e015",  # 20-25
        "#ffc301",  # 25-30
        "#fe7e03",  # 30-40
        "#fd0100",  # 40-50
        "#c70100",  # 50-60
        "#d364c3",  # 60-70
        "#b41a9c",  # 70-80
        "#820094",  # 80-100
        "#b4b4b4",  # 100-125
        "#8c8c8c",  # 125-150
        "#5a5a5a",  # 150-175
        "#323232",  # 175-200
        "#a37a22",  # 200-250
        "#815202",  # 250-300
        "#623201",  # 300-350
        "#4d2200",  # >350
    ],
    transparent_below=0.1,
)

REGISTRY: dict[str, Variable] = {}


def register(var: Variable) -> Variable:
    REGISTRY[var.id] = var
    return var


register(
    Variable(
        id="tp",
        label="Precipitazione",
        units="mm",
        kind="accum",
        selectors={
            "gfs": GribSelector(var="APCP", level="surface", short_name="tp", step_range_prefix="0-"),
            "ecmwf": GribSelector(param="tp", levtype="sfc", short_name="tp", step_range_prefix="0-"),
            # MeteoSwiss: param = "forecast:variable" of the STAC API
            "icon-ch2": GribSelector(param="TOT_PREC", short_name="tp", step_range_prefix="0-"),
            "icon-ch1": GribSelector(param="TOT_PREC", short_name="tp", step_range_prefix="0-"),
            # DWD: folder/file name (param), level type in the file name
            "icon-d2": GribSelector(param="tot_prec", levtype="single-level", short_name="tp", step_range_prefix="0-"),
            # ItaliaMeteo MeteoHub: folder (param) and file suffix "{levtype}-{levelist}"
            "icon-2i": GribSelector(param="TOT_PREC", levtype="surface", levelist="0", short_name="tp", step_range_prefix="0-"),
            # MeteoHub, folders named after ecCodes; selected by the WMO code of total precipitation (0,1,8)
            "wrf": GribSelector(param="tp", levtype="surface", levelist="0", code=(0, 1, 8), step_range_prefix="0-"),
            # MOLOCH: hourly amounts (k-1, k], summed since the start (small messages: mostly zero)
            "moloch": GribSelector(param="unknown", levtype="surface", levelist="0", code=(0, 1, 8),
                                   hourly_buckets=True),
            # Météo-France: package (param) and WMO code; (0,1,52) accumulated is total precipitation (rain+snow+graupel)
            "arome": GribSelector(param="SP1", code=(0, 1, 52), step_range_prefix="0-"),
        },
        # GFS APCP and ICON TOT_PREC are in kg m-2 (= mm); ECMWF tp is in metres.
        convert={"gfs": _identity, "ecmwf": _m_to_mm, "icon-ch2": _identity, "icon-ch1": _identity,
                 "icon-d2": _identity, "icon-2i": _identity, "wrf": _identity, "arome": _identity,
                 "moloch": _identity},
        scale=PRECIP_SCALE,
        decimals=1,
        nonnegative=True,
    )
)


# Diverging temperature scale: cold violet/blue, 0 °C light, warm yellow/red.
# The first class also collects values below the first threshold.
T850_SCALE = ColorScale(
    # colour stops every 2 °C (the isotherms), blended in between
    thresholds=[-20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
    colors=[
        "#3b0f70",  # < -18
        "#43167a",  # -18..-16
        "#532390",  # -16..-14
        "#5433a6",  # -14..-12
        "#4646bd",  # -12..-10
        "#3b5bd2",  # -10..-8
        "#3374e4",  # -8..-6
        "#3f91f0",  # -6..-4
        "#5fb3f5",  # -4..-2
        "#a6dcf7",  # -2..0
        "#e8f6e0",  # 0..2
        "#d9ef8b",  # 2..4
        "#f2e58b",  # 4..6
        "#fed480",  # 6..8
        "#fdba6c",  # 8..10
        "#fb9e5a",  # 10..12
        "#f67d4a",  # 12..14
        "#ed5e3c",  # 14..16
        "#de3f2e",  # 16..18
        "#ca2427",  # 18..20
        "#b20c26",  # > 20
    ],
    transparent_below=None,
    continuous=True,
)

register(
    Variable(
        id="t850",
        label="Temperatura 850 hPa",
        menu_label="Temp. 850 hPa",
        units="°C",
        kind="instant",
        selectors={
            "gfs": GribSelector(var="TMP", level="850_mb", short_name="t"),
            "ecmwf": GribSelector(param="t", levtype="pl", levelist="850", short_name="t"),
            "icon-d2": GribSelector(param="t", levtype="pressure-level", levelist="850", short_name="t"),
            "icon-2i": GribSelector(param="T", levtype="isobaricInhPa", levelist="850", short_name="t"),
            "wrf": GribSelector(param="t", levtype="isobaricInhPa", levelist="850", code=(0, 0, 0)),
            "moloch": GribSelector(param="t", levtype="isobaricInhPa", levelist="850", code=(0, 0, 0)),
        },
        convert={"gfs": _k_to_c, "ecmwf": _k_to_c, "icon-d2": _k_to_c, "icon-2i": _k_to_c, "wrf": _k_to_c,
                 "moloch": _k_to_c},
        scale=T850_SCALE,
        decimals=1,
        rank="asc",  # ranking: lowest temperature first
        contours={"label": "Isoterme", "step": 2, "bold": [0], "signed": True},  # every 2 °C, zero highlighted
        details=[{"var": "z850", "label": "Altezza 850 hPa"}],
    )
)


# Temperature and wet bulb at 2 m: same scale, wider than the 850 hPa one (up to 40 °C).
T2M_SCALE = ColorScale(
    thresholds=list(range(-20, 42, 2)),
    colors=T850_SCALE.colors + [
        "#9e0a2c",  # 20..22
        "#8a0b33",  # 22..24
        "#760c3c",  # 24..26
        "#630d45",  # 26..28
        "#520e4d",  # 28..30
        "#6a2a6a",  # 30..32
        "#834888",  # 32..34
        "#9d68a5",  # 34..36
        "#b88bc2",  # 36..38
        "#d3b0dc",  # > 38
    ],
    transparent_below=None,
    continuous=True,
)
# AROME excluded: 2 m temperature and humidity are in the SP1 packages, to be indexed message by message (like the wind)
T2M_SEL = {
    "gfs": GribSelector(var="TMP", level="2_m_above_ground", short_name="2t"),
    "ecmwf": GribSelector(param="2t", levtype="sfc", short_name="2t"),
    "icon-d2": GribSelector(param="t_2m", levtype="single-level"),
    "icon-2i": GribSelector(param="T_2M", levtype="heightAboveGround", levelist="2"),
    "wrf": GribSelector(param="2t", levtype="heightAboveGround", levelist="2", code=(0, 0, 0)),
    "moloch": GribSelector(param="2t", levtype="heightAboveGround", levelist="2", code=(0, 0, 0)),
    "icon-ch2": GribSelector(param="T_2M"),
    "icon-ch1": GribSelector(param="T_2M"),
}
TD2M_SEL = {
    "gfs": GribSelector(var="DPT", level="2_m_above_ground", short_name="2d"),
    "ecmwf": GribSelector(param="2d", levtype="sfc", short_name="2d"),
    "icon-d2": GribSelector(param="td_2m", levtype="single-level"),
    "icon-2i": GribSelector(param="TD_2M", levtype="heightAboveGround", levelist="2"),
    "wrf": GribSelector(param="2d", levtype="heightAboveGround", levelist="2", code=(0, 0, 6)),
    "icon-ch2": GribSelector(param="TD_2M"),
    "icon-ch1": GribSelector(param="TD_2M"),
}


SURFACE_PRESSURE_SEL = {
    "gfs": GribSelector(var="PRES", level="surface", short_name="sp"),
    "ecmwf": GribSelector(param="sp", levtype="sfc", short_name="sp"),
    "icon-d2": GribSelector(param="ps", levtype="single-level"),
    "icon-2i": GribSelector(param="PS", levtype="surface", levelist="0"),
    "icon-ch2": GribSelector(param="PS"),
    "icon-ch1": GribSelector(param="PS"),
}


def wet_bulb_k(t_k, td_k, p_hpa):
    """Wet-bulb temperature (K) from temperature and dew point (K): psychrometric equation solved by
    bisection, e(Td) = es(Tw) - A·p·(T - Tw), with A = 6.46·10⁻⁴ /K and Magnus vapour pressure.

    p_hpa holds the local surface pressure in hPa, scalar or on the same grid as the temperatures.
    """
    t = np.asarray(t_k, dtype=np.float64) - 273.15
    td = np.minimum(np.asarray(td_k, dtype=np.float64) - 273.15, t)
    pressure = np.asarray(p_hpa, dtype=np.float64)
    pressure = np.where(np.isfinite(pressure) & (pressure > 0), pressure, np.nan)
    es = lambda x: 6.112 * np.exp(17.62 * x / (243.12 + x))  # noqa: E731 (hPa, over water)
    e = es(td)
    lo, hi = td.copy(), t.copy()  # the wet bulb lies between dew point and temperature
    for _ in range(30):  # 30 halvings: precision well below a hundredth of a degree
        mid = (lo + hi) / 2
        f = es(mid) - 6.46e-4 * pressure * (t - mid) - e
        hi = np.where(f > 0, mid, hi)
        lo = np.where(f > 0, lo, mid)
    return np.where(np.isfinite(pressure), (lo + hi) / 2 + 273.15, np.nan)


def dewpoint_from_rh_k(t_k, rh_percent):
    temperature = np.asarray(t_k, dtype=np.float64) - 273.15
    humidity = np.asarray(rh_percent, dtype=np.float64)
    humidity = np.where(np.isfinite(humidity) & (humidity > 0), np.minimum(humidity, 100), np.nan)
    gamma = np.log(humidity / 100) + 17.62 * temperature / (243.12 + temperature)
    return 243.12 * gamma / (17.62 - gamma) + 273.15


def wet_bulb_zero_m(t_k, td_k, p_hpa, heights_m, surface_p_hpa, terrain_m):
    """First positive→negative crossing going up, interpolated in metres above sea level.

    The first axis holds levels from bottom to top, including the 2 m point.
    Underground levels are excluded; missing data interrupt the profile without extrapolation.
    """
    temperature, dewpoint, pressure, heights = np.broadcast_arrays(
        np.asarray(t_k, dtype=np.float64), np.asarray(td_k, dtype=np.float64),
        np.asarray(p_hpa, dtype=np.float64), np.asarray(heights_m, dtype=np.float64),
    )
    wet_bulb = wet_bulb_k(temperature, dewpoint, pressure) - 273.15
    result = np.full(temperature.shape[1:], np.nan)
    previous_tw = np.full_like(result, np.nan)
    previous_height = np.full_like(result, np.nan)
    for level in range(temperature.shape[0]):
        height = heights[level]
        current_tw = wet_bulb[level]
        underground = (pressure[level] > surface_p_hpa) | (height < terrain_m + 2)
        valid = (np.isfinite(current_tw) & np.isfinite(height)
                 & np.isfinite(surface_p_hpa) & np.isfinite(terrain_m) & ~underground)
        ascending = height > previous_height
        crossing = (valid & ascending & (previous_tw > 0) & (current_tw < 0))
        fraction = np.zeros_like(result)
        np.divide(previous_tw, previous_tw - current_tw, out=fraction, where=crossing)
        candidate = previous_height + fraction * (height - previous_height)
        result = np.where(np.isnan(result) & crossing, candidate, result)
        exact = valid & (current_tw == 0) & (~np.isfinite(previous_height) | ascending)
        result = np.where(np.isnan(result) & exact, height, result)
        valid &= ~np.isfinite(previous_height) | ascending
        previous_tw = np.where(underground, previous_tw, np.where(valid, current_tw, np.nan))
        previous_height = np.where(underground, previous_height, np.where(valid, height, np.nan))
    return np.asarray(result, dtype=np.float32)


register(
    Variable(
        id="t2m",
        label="Temperatura 2 m",
        menu_label="Temp. 2 m",
        units="°C",
        kind="instant",
        selectors=T2M_SEL,
        convert={m: _k_to_c for m in T2M_SEL},
        scale=T2M_SCALE,
        decimals=1,
        rank="asc",
        contours={"label": "Isoterme", "step": 2, "bold": [0], "signed": True},
    )
)
register(
    Variable(
        id="tw2m",
        label="WB 2m",
        units="°C",
        kind="instant",
        # the temperature is downloaded together with the dew point; the wet bulb is computed right away
        selectors={m: dataclasses.replace(sel, dew=TD2M_SEL[m], pressure=SURFACE_PRESSURE_SEL[m])
             for m, sel in T2M_SEL.items() if m in SURFACE_PRESSURE_SEL},
         convert={m: _k_to_c for m in SURFACE_PRESSURE_SEL},
        combine=wet_bulb_k,
        scale=T2M_SCALE,
        decimals=1,
        rank="asc",
        # below 0 °C wet bulb snow easily reaches the ground: zero highlighted
        contours={"label": "Isolinee", "step": 1, "bold": [0], "signed": True},
    )
)

# Fresh snow in cm: the models give the water equivalent (kg/m² = mm), converted with the standard 10:1 ratio
# (1 mm of water = 1 cm of snow). It is an estimate: wet snow accumulates less, powder snow more.
SNOW_SCALE = ColorScale(
    thresholds=[0.5, 1, 2, 5, 10, 20, 30, 50, 75, 100, 150],
    colors=[
        "#dff3ff",  # 0.5-1
        "#b3e0ff",  # 1-2
        "#7cc4ff",  # 2-5
        "#3f9cf5",  # 5-10
        "#1f6fd6",  # 10-20
        "#2346a8",  # 20-30
        "#5b2fb0",  # 30-50
        "#8a2fc0",  # 50-75
        "#b93fc4",  # 75-100
        "#e06fd0",  # 100-150
        "#ffb3ec",  # >150
    ],
    transparent_below=0.5,
)


def _mm_to_snow_cm(x):
    return x  # 1 mm of water = 1 cm of snow (10:1)


def _m_to_snow_cm(x):
    return x * 1000.0  # ECMWF: metres of water -> mm -> cm


register(
    Variable(
        id="sf",
        label="Neve",
        units="cm",
        kind="accum",
        selectors={
            "ecmwf": GribSelector(param="sf", levtype="sfc", step_range_prefix="0-"),
            # ICON: grid-scale + convective snow (ICON-CH resolves convection: grid-scale only)
            "icon-d2": GribSelector(param="snow_gsp", levtype="single-level", step_range_prefix="0-",
                                    plus=(GribSelector(param="snow_con", levtype="single-level", step_range_prefix="0-"),)),
            "icon-2i": GribSelector(param="SNOW_GSP", levtype="surface", levelist="0", step_range_prefix="0-",
                                    plus=(GribSelector(param="SNOW_CON", levtype="surface", levelist="0", step_range_prefix="0-"),)),
            "icon-ch2": GribSelector(param="SNOW_GSP", step_range_prefix="0-"),
            "icon-ch1": GribSelector(param="SNOW_GSP", step_range_prefix="0-"),
            # Météo-France: accumulated snow in the SP1 package
            "arome": GribSelector(param="SP1", code=(0, 1, 66), step_range_prefix="0-"),
            # MOLOCH: hourly snowfall in metres of water, summed since the start
            "moloch": GribSelector(param="asnow", levtype="surface", levelist="0", code=(0, 1, 29),
                                   hourly_buckets=True),
        },
        convert={"ecmwf": _m_to_snow_cm, "icon-d2": _mm_to_snow_cm, "icon-2i": _mm_to_snow_cm,
                 "icon-ch2": _mm_to_snow_cm, "icon-ch1": _mm_to_snow_cm, "arome": _mm_to_snow_cm,
                 "moloch": _m_to_snow_cm},
        scale=SNOW_SCALE,
        decimals=1,
        nonnegative=True,
    )
)


# Freezing level: height (m above sea level) of the 0 °C isotherm, from violet (low) to dark red (high). Cold hues up
# to 1500 m (violet, indigo, blue, green), yellow from 2000 m where the freezing level is already high for the cold
# season, then orange and reds for the summer values: a different hue every 500 m (with three similar light blues
# between 1000 and 2500 m, 1500 and 2000 m looked the same)
HZERO_SCALE = ColorScale(
    thresholds=[0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500],
    colors=[
        "#45148a",  # 0
        "#3232b8",  # 500
        "#1462d6",  # 1000
        "#2db34a",  # 1500
        "#fdd649",  # 2000
        "#fb9a3c",  # 2500
        "#ef5a2f",  # 3000
        "#c81e1e",  # 3500
        "#8f1239",  # 4000
        "#5c0a3a",  # 4500
    ],
    transparent_below=None,
    continuous=True,
)


def _hzero_m(x):
    # dummy values where the isotherm is undefined (ICON uses negative numbers): missing
    x = np.asarray(x, dtype=np.float64)
    return np.where(x < -100, np.nan, np.maximum(x, 0))


register(
    Variable(
        id="hzero",
        label="Zero termico",
        units="m",
        kind="instant",
        selectors={
            "gfs": GribSelector(var="HGT", level="0C_isotherm"),
            "icon-d2": GribSelector(param="hzerocl", levtype="single-level"),
            "icon-2i": GribSelector(param="HZEROCL", levtype="isothermZero", levelist="0"),
            "icon-ch2": GribSelector(param="HZEROCL"),
            "icon-ch1": GribSelector(param="HZEROCL"),
        },
        convert={m: _hzero_m for m in ("gfs", "icon-d2", "icon-2i", "icon-ch2", "icon-ch1")},
        scale=HZERO_SCALE,
        decimals=0,
        rank="asc",  # ranking: lowest freezing level first
        contours={"label": "Isolinee", "step": 250, "bold": [1000, 2000, 3000, 4000]},  # every 250 m, thousands highlighted
    )
)


register(
    Variable(
        id="hwzero",
        label="Quota WB = 0°",
        units="m",
        kind="instant",
        selectors={"gfs": GribSelector(var="TMP", level="500_mb")},
        convert={"gfs": _identity},
        scale=HZERO_SCALE,
        decimals=0,
        rank="asc",
        contours={"label": "Isolinee", "step": 250, "bold": [1000, 2000, 3000, 4000]},
    )
)


# Snowfall limit (ICON-2I RUC only, which has no freezing level): height where precipitation turns from rain to snow,
# from the wet-bulb temperature; missing where there is no transition (all above or below)
register(
    Variable(
        id="snowlmt",
        label="Quota neve",
        units="m",
        kind="instant",
        selectors={"icon-2i-ruc": GribSelector(param="SNOWLMT", levtype="isothermZero", levelist="0")},
        convert={"icon-2i-ruc": _hzero_m},
        scale=HZERO_SCALE,
        decimals=0,
        rank="asc",  # ranking: lowest snowfall limit first
        contours={"label": "Isolinee", "step": 250, "bold": [1000, 2000, 3000, 4000]},
    )
)


# Wind: the two components (eastward `u` and northward `v`, in km/h) are downloaded as hidden fields; the page
# derives speed (colours) and direction (arrows) from them. At half resolution to stay within the GitHub Pages limit.
# The model median is taken component by component, so opposite directions cancel out.
# AROME excluded: the wind is in the SP1/IP1 packages, to be indexed message by message (~9 minutes per run at 700 hPa).
WIND_SCALE = ColorScale(
    thresholds=[0, 5, 10, 20, 30, 40, 50, 60, 80, 100, 120, 150],
    colors=[
        "#eef6fb",  # < 5 km/h
        "#cfe8f3",  # 5-10
        "#a6dcf7",  # 10-20
        "#5fb3f5",  # 20-30
        "#7fd38b",  # 30-40
        "#d9ef8b",  # 40-50
        "#fee08b",  # 50-60
        "#fdae61",  # 60-80
        "#f46d43",  # 80-100
        "#d73027",  # 100-120
        "#a50026",  # 120-150
        "#6a1b9a",  # > 150
    ],
    transparent_below=None,
    continuous=True,
)
WRF_LAMBERT = (11.0, 43.421665, 37.21344)  # LoV, Latin1, Latin2 of the ItaliaMeteo WRF grid


def _ms_to_kmh(x):
    return np.asarray(x, dtype=np.float64) * 3.6


def _wind_component(comp: str, level: str) -> Variable:
    """Wind component `comp` ("u" or "v") at `level` ("10" = 10 m above ground, "700" = 700 hPa)."""
    u = comp == "u"
    if level == "10":
        sel = {
            "gfs": GribSelector(var="UGRD" if u else "VGRD", level="10_m_above_ground"),
            "ecmwf": GribSelector(param="10u" if u else "10v", levtype="sfc"),
            "icon-d2": GribSelector(param="u_10m" if u else "v_10m", levtype="single-level"),
            "icon-2i": GribSelector(param="U_10M" if u else "V_10M", levtype="heightAboveGround", levelist="10"),
            "icon-ch2": GribSelector(param="U_10M" if u else "V_10M"),
            "icon-ch1": GribSelector(param="U_10M" if u else "V_10M"),
        }
        wrf = ("10u", "10v", "heightAboveGround", "10")
    else:
        sel = {
            "gfs": GribSelector(var="UGRD" if u else "VGRD", level=f"{level}_mb"),
            "ecmwf": GribSelector(param="u" if u else "v", levtype="pl", levelist=level),
            "icon-d2": GribSelector(param="u" if u else "v", levtype="pressure-level", levelist=level),
            "icon-2i": GribSelector(param="U" if u else "V", levtype="isobaricInhPa", levelist=level),
        }
        wrf = ("u", "v", "isobaricInhPa", level)
    pu, pv, lt, lv = wrf
    mine = GribSelector(param=pu if u else pv, levtype=lt, levelist=lv, code=(0, 2, 2 if u else 3))
    other = GribSelector(param=pv if u else pu, levtype=lt, levelist=lv, code=(0, 2, 3 if u else 2))
    sel["wrf"] = dataclasses.replace(mine, pair=other, lambert=WRF_LAMBERT, component=comp)
    # MOLOCH: rotated grid, but the components are already east/north (uvRelativeToGrid = 0)
    sel["moloch"] = GribSelector(param=pu if u else pv, levtype=lt, levelist=lv, code=(0, 2, 2 if u else 3))
    name = "10 m" if level == "10" else f"{level} hPa"
    return Variable(
        id=f"{comp}{level}", label=f"Vento {name} ({'verso est' if u else 'verso nord'})", units="km/h", kind="instant",
        selectors=sel, convert={m: _ms_to_kmh for m in sel}, scale=WIND_SCALE, decimals=0,
        hidden=True, half_res=True,
    )


# Height of the 850 hPa surface (m), only for the place popup on the T850 map.
# ICON gives the geopotential (m²/s²): divided by g; the others the geopotential height (m).
G = 9.80665


def _geopot_to_m(x):
    return np.asarray(x, dtype=np.float64) / G


register(
    Variable(
        id="z850", label="Altezza 850 hPa", units="m", kind="instant",
        selectors={
            "gfs": GribSelector(var="HGT", level="850_mb"),
            "ecmwf": GribSelector(param="gh", levtype="pl", levelist="850"),
            "icon-d2": GribSelector(param="fi", levtype="pressure-level", levelist="850"),
            "icon-2i": GribSelector(param="FI", levtype="isobaricInhPa", levelist="850"),
            "wrf": GribSelector(param="gh", levtype="isobaricInhPa", levelist="850"),
            "moloch": GribSelector(param="gh", levtype="isobaricInhPa", levelist="850", code=(0, 3, 5)),
        },
        convert={"gfs": _identity, "ecmwf": _identity, "icon-d2": _geopot_to_m, "icon-2i": _geopot_to_m, "wrf": _identity,
                 "moloch": _identity},
        scale=HZERO_SCALE, decimals=0, hidden=True, half_res=True,
    )
)


# Synoptic chart (Atlantic and Europe, 0.25°): 500 hPa geopotential in colour and sea-level pressure as
# lines, like the classic "Z500 and surface pressure" charts. Hidden fields: the menu has the combined entry.
SYNOPTIC_AREA = SYNOPTIC_BBOX

# geopotential decametres, 4 dam bands: the scale of Meteociel's "Géop. Z500" charts, from the violet of cold
# troughs to the black of the warmest anticyclones
Z500_SCALE = ColorScale(
    thresholds=list(range(492, 613, 4)),
    colors=[
        "#400040",  # < 496
        "#600060",  # 496-500
        "#aa00aa",  # 500-504
        "#801080",  # 504-508
        "#600040",  # 508-512
        "#303366",  # 512-516
        "#003399",  # 516-520
        "#0000cc",  # 520-524
        "#0000ff",  # 524-528
        "#0055ff",  # 528-532
        "#0099ff",  # 532-536
        "#33ccff",  # 536-540
        "#66ffff",  # 540-544
        "#66ff99",  # 544-548
        "#66ff66",  # 548-552
        "#66ff00",  # 552-556
        "#bffa0e",  # 556-560
        "#ffff09",  # 560-564
        "#ffff86",  # 564-568
        "#fde851",  # 568-572
        "#ffcc00",  # 572-576
        "#ff9900",  # 576-580
        "#ff6900",  # 580-584
        "#ff4d33",  # 584-588
        "#ff3000",  # 588-592
        "#ff0000",  # 592-596
        "#cc0000",  # 596-600
        "#990000",  # 600-604
        "#6c0000",  # 604-608
        "#4f0000",  # 608-612
        "#000000",  # > 612
    ],
)


def _gpm_to_dam(x):
    return np.asarray(x, dtype=np.float64) / 10.0


def _pa_to_hpa(x):
    return np.asarray(x, dtype=np.float64) / 100.0


register(
    Variable(
        id="z500", label="Geopotenziale 500 hPa", units="dam", kind="instant",
        selectors={
            "gfs": GribSelector(var="HGT", level="500_mb", short_name="gh"),
            "ecmwf": GribSelector(param="gh", levtype="pl", levelist="500", short_name="gh"),
        },
        convert={"gfs": _gpm_to_dam, "ecmwf": _gpm_to_dam},
        # one decimal (1 m): with whole decametres the 4 dam bands would have their edges on the cell edges, stepped
        scale=Z500_SCALE, decimals=1, rank="asc", hidden=True, area=SYNOPTIC_AREA,
    )
)
register(
    Variable(
        id="msl", label="Pressione al livello del mare", units="hPa", kind="instant",
        selectors={
            "gfs": GribSelector(var="PRMSL", level="mean_sea_level"),
            "ecmwf": GribSelector(param="msl", levtype="sfc"),
        },
        convert={"gfs": _pa_to_hpa, "ecmwf": _pa_to_hpa},
        scale=HZERO_SCALE, decimals=1, rank="asc", hidden=True, area=SYNOPTIC_AREA,
    )
)


for _lvl in ("10", "700", "850"):
    for _c in ("u", "v"):
        register(_wind_component(_c, _lvl))


def rh_from_q(t_k, q, p_hpa):
    """Relative humidity (%) from temperature (K), specific humidity (kg/kg) and pressure (hPa): vapour pressure
    e = q p / (0.622 + 0.378 q), saturation over water with Bolton's formula. For models that publish only the
    specific humidity (AIFS, MOLOCH)."""
    t_k, q = np.asarray(t_k, dtype=np.float64), np.asarray(q, dtype=np.float64)
    e = q * p_hpa / (0.622 + 0.378 * q)
    es = 6.112 * np.exp(17.67 * (t_k - 273.15) / (t_k - 29.65))
    return np.clip(100.0 * e / es, 0.0, 100.0)


def _rh_percent(x):
    return np.clip(np.asarray(x, dtype=np.float64), 0.0, 100.0)  # the IFS gives up to ~103% (supersaturation)


# Relative humidity: dry in brown, about half in a light neutral, moist in blue, saturated (clouds) dark blue; a stop
# every 10% plus 95% (nearly saturated air), smooth gradient.
RH_SCALE = ColorScale(
    thresholds=[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
    colors=["#4a2a06", "#6e4210", "#8c5a1c", "#b07d3a", "#d2aa6c", "#ece0c0",
            "#d6ecf5", "#a6d0ea", "#6fa9d8", "#3f7fc0", "#245ea6", "#13306e"],
    transparent_below=None,
    continuous=True,
)
# 850 hPa (about 1500 m): moist air, clouds and dry intrusions at the height of the Prealps. Hidden: the menu has the
# combined entry with the 850 hPa wind. ICON-CH (model levels only) and AROME (IP packages) are not there.
register(
    Variable(
        id="r850", label="Umidità relativa 850 hPa", units="%", kind="instant",
        selectors={
            "gfs": GribSelector(var="RH", level="850_mb"),
            "ecmwf": GribSelector(param="r", levtype="pl", levelist="850"),
            "icon-d2": GribSelector(param="relhum", levtype="pressure-level", levelist="850"),
            "icon-2i": GribSelector(param="RELHUM", levtype="isobaricInhPa", levelist="850"),
            "wrf": GribSelector(param="r", levtype="isobaricInhPa", levelist="850", code=(0, 1, 1)),
            # MOLOCH: from temperature and specific humidity (see rh_from_q); the pressure is the level's
            "moloch": GribSelector(param="t", levtype="isobaricInhPa", levelist="850", code=(0, 0, 0),
                                   dew=GribSelector(param="qv", levtype="isobaricInhPa", levelist="850",
                                                    code=(0, 1, 0))),
        },
        convert={m: _rh_percent for m in ("gfs", "ecmwf", "icon-d2", "icon-2i", "wrf", "moloch")},
        combine=rh_from_q,
        extra={"pressure_hpa": 850.0},  # combined models: constant pressure, no surface field to download
        scale=RH_SCALE, decimals=0, hidden=True,
    )
)

# menu entries for the wind: speed in colour from the two components, arrows for the direction
# ECMWF IFS 0.1° and AIFS: same files and parameter names as the IFS 0.25°, and they have all of its fields. The
# 0.1° without the synoptic chart: on Europe and the Atlantic the finer grid would only make the files heavier.
for _var in REGISTRY.values():
    if "ecmwf" in _var.selectors:
        for _model in ("aifs",) if _var.area else ("ecmwf-hres", "aifs"):
            _var.selectors[_model] = _var.selectors["ecmwf"]
            _var.convert[_model] = _var.convert["ecmwf"]
# ICON-2I RUC: same files and names as ICON-2I, without the freezing level (not published)
for _var in REGISTRY.values():
    if "icon-2i" in _var.selectors and _var.id != "hzero":
        _var.selectors["icon-2i-ruc"] = _var.selectors["icon-2i"]
        _var.convert["icon-2i-ruc"] = _var.convert["icon-2i"]
# ...but the AIFS gives precipitation and snow already in kg m-2 (mm), the IFS in metres
REGISTRY["tp"].convert["aifs"] = _identity
REGISTRY["sf"].convert["aifs"] = _mm_to_snow_cm
# ...and has no relative humidity: computed from temperature and specific humidity, like MOLOCH
REGISTRY["r850"].selectors["aifs"] = GribSelector(
    param="t", levtype="pl", levelist="850", short_name="t",
    dew=GribSelector(param="q", levtype="pl", levelist="850", short_name="q"))


VECTORS = [
    {"id": "wind10", "label": "Vento 10 m", "u": "u10", "v": "v10"},
    {"id": "wind700", "label": "Vento 700 hPa", "u": "u700", "v": "v700"},
    {"id": "wind850", "label": "Vento 850 hPa", "u": "u850", "v": "v850"},
]


# Combined entries of the "Grandezza" (field) menu: the colours of one field and, at the same time, the contour lines
# of another (contour_field) or the arrows of a wind (arrows, an entry of VECTORS). They have no data of their own (the
# page requests the fields they combine), so no extra downloads or space.
COMBOS = [
    {
        "id": "tp_hzero",
        "label": "Precip. e zero termico",
        "menu_label": "Precip. e zero term.",  # in the dropdown
        "after": "tp",  # position in the menu
        "field": "tp",  # colours, legend, places and modes
        "contour_field": "hzero",  # lines
        "contours": {"label": "Zero termico", "units": "m", "step": 250, "bold": [1000, 2000, 3000, 4000]},
    },
    {
        "id": "z500_msl",
        "label": "Pressione - Geop. 500 hPa",
        "menu_label": "Press. - Geop. 500",  # in the dropdown
        "after": "t850",
        "field": "z500",
        "contour_field": "msl",
        "contours": {"label": "Isobare", "units": "hPa", "step": 5, "bold": [1015]},
    },
    {
        "id": "tp_wind700",
        "label": "Precip. e vento 700 hPa",
        "menu_label": "Precip. e vento 700",  # in the dropdown
        "after": "tp_hzero",  # position in the menu: after the other precipitation combination
        "field": "tp",
        "arrows": "wind700",  # 700 hPa wind arrows (direction and, with their length, strength)
    },
    {
        "id": "r850_wind850",
        "label": "Umidità relativa e vento 850 hPa",
        "menu_label": "UR e vento 850",  # in the dropdown
        "after": "t850",
        "field": "r850",
        "arrows": "wind850",
    },
]


def menu() -> list[dict]:
    """Fields for /api/meta: the downloaded ones plus the combined ones, each after its `after`."""
    out = []
    for var in REGISTRY.values():
        if var.hidden:
            continue
        out.append(var.as_dict())
        after = [var.id]
        while True:  # combinations after this field, and those after the combinations just added
            added = [c for c in COMBOS if c["after"] in after and c["id"] not in {o["id"] for o in out}]
            if not added:
                break
            for c in added:
                item = _combo_item(c)
                if item:
                    out.append(item)
            after = [c["id"] for c in added]
    for vec in VECTORS:
        u, v = REGISTRY[vec["u"]].as_dict(), REGISTRY[vec["v"]].as_dict()
        models = [m for m in u["models"] if m in v["models"]]
        out.append({**u, "id": vec["id"], "label": vec["label"], "menu_label": vec.get("menu_label"), "kind": "vector", "rank": "desc",
                    "vector": {"u": vec["u"], "v": vec["v"]}, "models": models})
    return out


def _combo_item(c: dict) -> dict | None:
    base = REGISTRY[c["field"]].as_dict()
    extra: dict = {}
    if "contour_field" in c:
        lines = REGISTRY[c["contour_field"]].as_dict()
        needs = [lines["models"]]
        extra = {"contour_field": c["contour_field"], "contours": c["contours"]}
    else:
        vec = next(v for v in VECTORS if v["id"] == c["arrows"])
        needs = [REGISTRY[vec["u"]].as_dict()["models"], REGISTRY[vec["v"]].as_dict()["models"]]
        extra = {"arrows": {"id": vec["id"], "label": vec["label"], "u": vec["u"], "v": vec["v"]}}
    models = [m for m in base["models"] if all(m in n for n in needs)]
    if not models:
        return None
    return {**base, "id": c["id"], "label": c["label"], "menu_label": c.get("menu_label"), "base_label": base["label"], "field": c["field"], **extra,
            "models": models}


def get(var_id: str) -> Variable:
    try:
        return REGISTRY[var_id]
    except KeyError:
        raise KeyError(f"Grandezza sconosciuta: {var_id}") from None
