"""Registro delle grandezze meteo.

Per aggiungere una grandezza basta aggiungere una `Variable` a `REGISTRY`:
fetch, storage, API e frontend la trattano in modo generico.
"""
from __future__ import annotations

import dataclasses
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
    levtype: str | None = None  # "sfc" (superficie) o "pl" (livelli di pressione)
    levelist: str | None = None  # livello di pressione per levtype "pl", es. "850"
    short_name: str | None = None
    step_range_prefix: str | None = None
    # codice WMO del parametro (disciplina, categoria, numero): per i file dove ecCodes non conosce il nome
    code: tuple[int, int, int] | None = None
    # pioggia distribuita a intervalli consecutivi (0-1h, 1-2h, ...) da sommare per avere il totale
    hourly_buckets: bool = False
    # altri campi da scaricare e sommare a questo (es. neve ICON: di griglia + convettiva)
    plus: tuple["GribSelector", ...] = ()
    # vento riferito alla griglia Lambert del modello (WRF): l'altra componente (`pair`) e la proiezione
    # (LoV, Latin1, Latin2 in gradi) per ruotarlo verso il nord geografico; `component` è "u" o "v"
    pair: "GribSelector | None" = None
    lambert: tuple[float, float, float] | None = None
    component: str | None = None


@dataclass(frozen=True)
class ColorScale:
    thresholds: list[float]  # limiti inferiori delle classi, crescenti
    colors: list[str]  # stesso numero di thresholds, colore della classe [t_i, t_i+1)
    transparent_below: float | None = None
    # sfumata: i colori sono punti di passaggio ai valori di `thresholds` e in mezzo si interpola (grandezze continue,
    # i valori esatti li danno le linee); altrimenti fasce nette, una per classe (pioggia, neve)
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
    # componente di un vettore (vento): non compare nel menu, la pagina la usa attraverso una voce di VECTORS
    hidden: bool = False
    # griglie più fini di 0,05°: si salva una cella su due per lato (un quarto dei dati), es. il vento
    half_res: bool = False
    # altre grandezze (nascoste) mostrate nel riquadro della località: [{"var": id, "label": nome}]
    details: list | None = None

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
            "details": self.details,
            # "mean" = mediana dei modelli, disponibile se la grandezza ha almeno due modelli
            "models": sorted(self.selectors) + (["mean"] if len(self.selectors) > 1 else []),
        }


def _identity(x):
    return x


def _m_to_mm(x):
    return x * 1000.0


def _k_to_c(x):
    return x - 273.15


# Scala delle carte di pioggia LaMMA (MOLOCH): sopra i 20 mm soglie e colori dalla loro legenda, sotto ricostruiti
# dai colori delle loro mappe (azzurri e blu, poi verdi); arriva oltre i 350 mm, utile per i totali di più giorni
# sulle Alpi in caso di sbarramento
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
    # punti di colore ogni 2 °C (le isoterme), sfumati in mezzo
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
        details=[{"var": "z850", "label": "Altezza 850 hPa"}],
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
    continuous=True,
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


# Vento: si scaricano le due componenti (verso est `u` e verso nord `v`, in km/h) come grandezze nascoste; la pagina
# ne ricava velocità (colori) e direzione (frecce). A metà risoluzione per stare nel limite di GitHub Pages.
# La mediana dei modelli è fatta componente per componente, così le direzioni opposte si compensano.
# AROME escluso: il vento è nei pacchetti SP1/IP1 da indicizzare messaggio per messaggio (~9 minuti per corsa a 700 hPa).
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
WRF_LAMBERT = (11.0, 43.421665, 37.21344)  # LoV, Latin1, Latin2 della griglia WRF di ItaliaMeteo


def _ms_to_kmh(x):
    return np.asarray(x, dtype=np.float64) * 3.6


def _wind_component(comp: str, level: str) -> Variable:
    """Componente `comp` ("u" o "v") del vento a `level` ("10" = 10 m dal suolo, "700" = 700 hPa)."""
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
    name = "10 m" if level == "10" else f"{level} hPa"
    return Variable(
        id=f"{comp}{level}", label=f"Vento {name} ({'verso est' if u else 'verso nord'})", units="km/h", kind="instant",
        selectors=sel, convert={m: _ms_to_kmh for m in sel}, scale=WIND_SCALE, decimals=0,
        hidden=True, half_res=True,
    )


# Altezza della superficie di 850 hPa (m), solo per il riquadro della località sulla mappa della T850.
# ICON dà il geopotenziale (m²/s²): diviso per g; gli altri l'altezza geopotenziale (m).
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
        },
        convert={"gfs": _identity, "ecmwf": _identity, "icon-d2": _geopot_to_m, "icon-2i": _geopot_to_m, "wrf": _identity},
        scale=HZERO_SCALE, decimals=0, hidden=True, half_res=True,
    )
)


for _lvl in ("10", "700"):
    for _c in ("u", "v"):
        register(_wind_component(_c, _lvl))

# voci del menu per il vento: velocità a colori dalle due componenti, frecce per la direzione
VECTORS = [
    {"id": "wind10", "label": "Vento 10 m", "u": "u10", "v": "v10"},
    {"id": "wind700", "label": "Vento 700 hPa", "u": "u700", "v": "v700"},
]


# Voci combinate del menu "Grandezza": i colori di una grandezza e, alla stessa ora, le linee di livello di un'altra
# (contour_field) o le frecce di un vento (arrows, una voce di VECTORS). Non hanno dati propri (la pagina chiede i campi
# delle grandezze che combinano), quindi niente download né spazio in più.
COMBOS = [
    {
        "id": "tp_hzero",
        "label": "Precip. e zero termico",
        "after": "tp",  # posizione nel menu
        "field": "tp",  # colori, legenda, località e modalità
        "contour_field": "hzero",  # linee
        "contours": {"label": "Zero termico", "units": "m", "step": 250, "bold": [1000, 2000, 3000, 4000]},
    },
    {
        "id": "tp_wind700",
        "label": "Precip. e vento 700 hPa",
        "after": "tp_hzero",  # posizione nel menu: dopo l'altra combinata della pioggia
        "field": "tp",
        "arrows": "wind700",  # frecce del vento a 700 hPa (direzione e, con la lunghezza, intensità)
    },
]


def menu() -> list[dict]:
    """Grandezze per /api/meta: quelle scaricate più le combinate, ognuna dopo la sua `after`."""
    out = []
    for var in REGISTRY.values():
        if var.hidden:
            continue
        out.append(var.as_dict())
        after = [var.id]
        while True:  # combinate dopo questa grandezza, e quelle dopo le combinate appena aggiunte
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
        out.append({**u, "id": vec["id"], "label": vec["label"], "kind": "vector", "rank": "desc",
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
    return {**base, "id": c["id"], "label": c["label"], "base_label": base["label"], "field": c["field"], **extra,
            "models": models}


def get(var_id: str) -> Variable:
    try:
        return REGISTRY[var_id]
    except KeyError:
        raise KeyError(f"Grandezza sconosciuta: {var_id}") from None
