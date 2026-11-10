"""Registro delle grandezze meteo.

Per aggiungere una grandezza basta aggiungere una `Variable` a `REGISTRY`:
fetch, storage, API e frontend la trattano in modo generico.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal

Kind = Literal["accum", "instant", "vector"]


@dataclass(frozen=True)
class GribSelector:
    """Come trovare il campo in un modello.

    GFS (filtro NOMADS): `var` e `level` diventano `var_<var>=on` e `lev_<level>=on`.
    ECMWF (file .index): `param` e `levtype` filtrano le righe dell'indice.
    `short_name` e `step_range_prefix` scelgono il messaggio giusto nel GRIB decodificato.
    """

    var: str | None = None
    level: str | None = None
    param: str | None = None
    levtype: str | None = None  # "sfc" (superficie) o "pl" (livelli di pressione, file separato a 0.1°)
    levelist: str | None = None  # livello di pressione per levtype "pl", es. "850"
    short_name: str | None = None
    step_range_prefix: str | None = None
    # codice WMO del parametro (disciplina, categoria, numero): per i file dove ecCodes non conosce il nome
    code: tuple[int, int, int] | None = None
    # pioggia distribuita a intervalli consecutivi (0-1h, 1-2h, ...) da sommare per avere il totale
    hourly_buckets: bool = False


@dataclass(frozen=True)
class ColorScale:
    thresholds: list[float]  # limiti inferiori delle classi, crescenti
    colors: list[str]  # stesso numero di thresholds, colore della classe [t_i, t_i+1)
    transparent_below: float | None = None

    def as_dict(self) -> dict:
        return {
            "thresholds": self.thresholds,
            "colors": self.colors,
            "transparent_below": self.transparent_below,
        }


@dataclass(frozen=True)
class Variable:
    id: str
    label: str
    units: str
    kind: Kind
    selectors: dict[str, GribSelector]  # per modello: "gfs", "ecmwf"
    convert: dict[str, Callable[[float], float]]  # per modello, unità GRIB -> presentazione
    scale: ColorScale
    decimals: int = 1
    steps: list[int] | None = None  # None = config.STEPS
    nonnegative: bool = False
    rank: Literal["desc", "asc"] = "desc"  # classifica dei punti: desc = valore più alto primo
    extra: dict = field(default_factory=dict)

    @property
    def modes(self) -> list[str]:
        return ["total", "interval"] if self.kind == "accum" else ["value"]

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "units": self.units,
            "kind": self.kind,
            "modes": self.modes,
            "decimals": self.decimals,
            "rank": self.rank,
            "scale": self.scale.as_dict(),
            # "mean" = media dei modelli, disponibile se la grandezza ha almeno due modelli
            "models": sorted(self.selectors) + (["mean"] if len(self.selectors) > 1 else []),
        }


def _identity(x):
    return x


def _m_to_mm(x):
    return x * 1000.0


def _k_to_c(x):
    return x - 273.15


PRECIP_SCALE = ColorScale(
    thresholds=[0.1, 1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200],
    colors=[
        "#a6f0ff",  # 0.1-1
        "#5fd0ff",  # 1-2
        "#1e9bff",  # 2-5
        "#1560e0",  # 5-10
        "#16a34a",  # 10-20
        "#7ed321",  # 20-30
        "#ffe600",  # 30-50
        "#ffa200",  # 50-75
        "#ff5a00",  # 75-100
        "#e0001b",  # 100-150
        "#b0007a",  # 150-200
        "#7a00c8",  # >200
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
            # MeteoSvizzera: param = "forecast:variable" della STAC API
            "icon-ch2": GribSelector(param="TOT_PREC", short_name="tp", step_range_prefix="0-"),
            "icon-ch1": GribSelector(param="TOT_PREC", short_name="tp", step_range_prefix="0-"),
            # DWD: cartella/nome file (param), tipo di livello nel nome file
            "icon-d2": GribSelector(param="tot_prec", levtype="single-level", short_name="tp", step_range_prefix="0-"),
            # ItaliaMeteo MeteoHub: cartella (param) e suffisso del file "{levtype}-{levelist}"
            "icon-2i": GribSelector(param="TOT_PREC", levtype="surface", levelist="0", short_name="tp", step_range_prefix="0-"),
            # MeteoHub, cartelle per nome ecCodes; si seleziona con il codice WMO della precipitazione totale (0,1,8)
            "wrf": GribSelector(param="tp", levtype="surface", levelist="0", code=(0, 1, 8), step_range_prefix="0-"),
            # Météo-France: paquet (param) e codice WMO; (0,1,52) accumulato è la precipitazione totale (pioggia+neve+graupel)
            "arome": GribSelector(param="SP1", code=(0, 1, 52), step_range_prefix="0-"),
        },
        # GFS APCP e ICON TOT_PREC sono in kg m-2 (= mm); ECMWF tp è in metri.
        convert={"gfs": _identity, "ecmwf": _m_to_mm, "icon-ch2": _identity, "icon-ch1": _identity,
                 "icon-d2": _identity, "icon-2i": _identity, "wrf": _identity, "arome": _identity},
        scale=PRECIP_SCALE,
        decimals=1,
        nonnegative=True,
    )
)


# Scala divergente per la temperatura: freddo viola/blu, 0 °C chiaro, caldo giallo/rosso.
# La prima classe raccoglie anche i valori sotto la prima soglia.
T850_SCALE = ColorScale(
    thresholds=[-20, -16, -12, -8, -4, -2, 0, 2, 4, 8, 12, 16, 20],
    colors=[
        "#3b0f70",  # < -16
        "#5b2a9a",  # -16..-12
        "#3f4fc9",  # -12..-8
        "#2f80ed",  # -8..-4
        "#5fb3f5",  # -4..-2
        "#a6dcf7",  # -2..0
        "#e8f6e0",  # 0..2
        "#d9ef8b",  # 2..4
        "#fee08b",  # 4..8
        "#fdae61",  # 8..12
        "#f46d43",  # 12..16
        "#d73027",  # 16..20
        "#a50026",  # > 20
    ],
    transparent_below=None,
)

register(
    Variable(
        id="t850",
        label="Temperatura 850 hPa",
        units="°C",
        kind="instant",
        selectors={
            "gfs": GribSelector(var="TMP", level="850_mb", short_name="t"),
            "ecmwf": GribSelector(param="t", levtype="pl", levelist="850", short_name="t"),
            "icon-d2": GribSelector(param="t", levtype="pressure-level", levelist="850", short_name="t"),
            "icon-2i": GribSelector(param="T", levtype="isobaricInhPa", levelist="850", short_name="t"),
            "wrf": GribSelector(param="t", levtype="isobaricInhPa", levelist="850", code=(0, 0, 0)),
        },
        convert={"gfs": _k_to_c, "ecmwf": _k_to_c, "icon-d2": _k_to_c, "icon-2i": _k_to_c, "wrf": _k_to_c},
        scale=T850_SCALE,
        decimals=1,
        rank="asc",  # classifica: prima la temperatura più bassa
    )
)


def get(var_id: str) -> Variable:
    try:
        return REGISTRY[var_id]
    except KeyError:
        raise KeyError(f"Grandezza sconosciuta: {var_id}") from None
