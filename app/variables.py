"""Registro delle grandezze meteo.

Per aggiungere una grandezza basta aggiungere una `Variable` a `REGISTRY`:
fetch, storage, API e frontend la trattano in modo generico.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal

import numpy as np

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
    # altri campi da scaricare e sommare a questo (es. neve ICON: di griglia + convettiva)
    plus: tuple["GribSelector", ...] = ()


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
    # linee di livello disegnate sopra i colori: {"label": nome nelle impostazioni, "step": distanza fra le linee,
    # "bold": [livelli in evidenza], "signed": etichette col segno "+"}
    contours: dict | None = None

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
            "contours": self.contours,
            # "mean" = mediana dei modelli, disponibile se la grandezza ha almeno due modelli
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
        contours={"label": "Isoterme", "step": 2, "bold": [0], "signed": True},  # ogni 2 °C, lo zero più marcato
    )
)


# Neve fresca in cm: i modelli danno l'acqua equivalente (kg/m² = mm), convertita col rapporto standard 10:1
# (1 mm d'acqua = 1 cm di neve). È una stima: la neve umida si accumula meno, quella farinosa di più.
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
    return x  # 1 mm d'acqua = 1 cm di neve (10:1)


def _m_to_snow_cm(x):
    return x * 1000.0  # ECMWF: metri d'acqua -> mm -> cm


register(
    Variable(
        id="sf",
        label="Neve",
        units="cm",
        kind="accum",
        selectors={
            "ecmwf": GribSelector(param="sf", levtype="sfc", step_range_prefix="0-"),
            # ICON: neve di griglia + convettiva (ICON-CH ha la convezione risolta: solo quella di griglia)
            "icon-d2": GribSelector(param="snow_gsp", levtype="single-level", step_range_prefix="0-",
                                    plus=(GribSelector(param="snow_con", levtype="single-level", step_range_prefix="0-"),)),
            "icon-2i": GribSelector(param="SNOW_GSP", levtype="surface", levelist="0", step_range_prefix="0-",
                                    plus=(GribSelector(param="SNOW_CON", levtype="surface", levelist="0", step_range_prefix="0-"),)),
            "icon-ch2": GribSelector(param="SNOW_GSP", step_range_prefix="0-"),
            "icon-ch1": GribSelector(param="SNOW_GSP", step_range_prefix="0-"),
            # Météo-France: neve accumulata nel paquet SP1
            "arome": GribSelector(param="SP1", code=(0, 1, 66), step_range_prefix="0-"),
        },
        convert={"ecmwf": _m_to_snow_cm, "icon-d2": _mm_to_snow_cm, "icon-2i": _mm_to_snow_cm,
                 "icon-ch2": _mm_to_snow_cm, "icon-ch1": _mm_to_snow_cm, "arome": _mm_to_snow_cm},
        scale=SNOW_SCALE,
        decimals=1,
        nonnegative=True,
    )
)


# Zero termico: quota (m sul livello del mare) dell'isoterma 0 °C, dal viola (basso) al rosso (alto)
HZERO_SCALE = ColorScale(
    thresholds=[0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500],
    colors=[
        "#5b2a9a",  # < 500
        "#3f4fc9",  # 500-1000
        "#2f80ed",  # 1000-1500
        "#5fb3f5",  # 1500-2000
        "#a6dcf7",  # 2000-2500
        "#d9ef8b",  # 2500-3000
        "#fee08b",  # 3000-3500
        "#fdae61",  # 3500-4000
        "#f46d43",  # 4000-4500
        "#d73027",  # > 4500
    ],
    transparent_below=None,
)


def _hzero_m(x):
    # valori fittizi dove l'isoterma non è definita (ICON usa numeri negativi): mancanti
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
        rank="asc",  # classifica: prima lo zero termico più basso
        contours={"label": "Isolinee", "step": 250, "bold": [1000, 2000, 3000, 4000]},  # ogni 250 m, marcate le migliaia
    )
)


# Voci combinate del menu "Grandezza": i colori di una grandezza e le linee di livello di un'altra, alla stessa ora.
# Non hanno dati propri (la pagina chiede i campi delle due grandezze), quindi niente download né spazio in più.
COMBOS = [
    {
        "id": "tp_hzero",
        "label": "Precip. e zero termico",
        "after": "tp",  # posizione nel menu
        "field": "tp",  # colori, legenda, località e modalità
        "contour_field": "hzero",  # linee
        "contours": {"label": "Zero termico", "units": "m", "step": 250, "bold": [1000, 2000, 3000, 4000]},
    },
]


def menu() -> list[dict]:
    """Grandezze per /api/meta: quelle scaricate più le combinate, ognuna dopo la sua `after`."""
    out = []
    for var in REGISTRY.values():
        out.append(var.as_dict())
        for c in COMBOS:
            if c["after"] != var.id:
                continue
            base, lines = REGISTRY[c["field"]].as_dict(), REGISTRY[c["contour_field"]].as_dict()
            models = [m for m in base["models"] if m in lines["models"]]
            if models:
                out.append({**base, "id": c["id"], "label": c["label"], "base_label": base["label"],
                            "field": c["field"], "contour_field": c["contour_field"],
                            "contours": c["contours"], "models": models})
    return out


def get(var_id: str) -> Variable:
    try:
        return REGISTRY[var_id]
    except KeyError:
        raise KeyError(f"Grandezza sconosciuta: {var_id}") from None
