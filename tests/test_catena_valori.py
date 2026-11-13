"""I valori sulla mappa sono quelli del modello: tutta la catena, dal GRIB al tooltip e al colore del pixel.

Per ogni città il valore di riferimento lo dà ecCodes (`codes_grib_find_nearest`, il punto di griglia più vicino nel
messaggio GRIB originale), senza passare dal nostro codice. Il valore controllato invece fa la strada vera:

  GRIB -> decode_grib -> select -> crop -> conversione delle unità (come fetcher) -> Store -> /api/field
       -> formato compatto .bin (come build_static) -> unpackField e valueAt della pagina (node) -> tooltip
       -> wmRenderPixels (render.js, celle nette) -> colore del pixel sopra la città

Il pixel si cerca con i bordi dell'immagine sulla mappa (bordi delle celle, Mercatore), calcolati qui a parte, e il
suo colore atteso viene dal valore di ecCodes nel centro del pixel e dalle soglie della scala che riceve la pagina.
"""

import json
import math
import shutil
import subprocess
from pathlib import Path

import eccodes
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import fetcher, packed, variables
from app.config import BBox
from app.grid import crop, decode_grib, halve, select
from app.main import create_app
from app.store import Store

FIX = Path(__file__).parent / "fixtures"
HELPER = Path(__file__).parent / "helpers" / "catena_valori.mjs"
BOX = BBox.parse("42,49,4,17")
RUN = "2026110900"

# lontane da metà fra due punti di griglia (0.25° e 0.1°), dove "il più vicino" sarebbe ambiguo
CITIES = {
    "Milano": (45.4642, 9.19),
    "Sondrio": (46.17, 9.87),
    "Trento": (46.07, 11.12),
    "Bolzano": (46.498, 11.354),
    "Torino": (45.07, 7.69),
    "Venezia": (45.44, 12.33),
    "Bologna": (44.49, 11.34),
    "Genova": (44.41, 8.93),
}

# (modello, grandezza, file GRIB, passo)
CASES = [
    ("gfs", "tp", "gfs_f024.grb", 24),
    ("gfs", "t850", "gfs_t850_f024.grb", 24),
    ("ecmwf", "tp", "ec01_tp24.grb", 24),
    ("ecmwf", "t850", "ec_t850_24.grb", 24),
]

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="serve node per la parte della pagina")


# ---------- riferimento: ecCodes sul GRIB originale


def _raw_nearest(fixture: str, meta, points):
    """Valore grezzo del punto di griglia più vicino, per ogni (lat, lon), nel messaggio uguale a quello scelto."""
    with open(FIX / fixture, "rb") as fh:
        while (gid := eccodes.codes_grib_new_from_file(fh)) is not None:
            try:
                same = (
                    eccodes.codes_get(gid, "shortName") == meta.short_name
                    and str(eccodes.codes_get(gid, "stepRange")) == meta.step_range
                    and float(eccodes.codes_get(gid, "level")) == meta.level
                )
                if same:
                    out = []
                    for lat, lon in points:
                        v = eccodes.codes_grib_find_nearest(gid, lat, lon % 360)[0]["value"]
                        out.append(np.nan if v == eccodes.codes_get(gid, "missingValue") else float(v))
                    return out
            finally:
                eccodes.codes_release(gid)
    raise AssertionError(f"messaggio non trovato in {fixture}")


def _expected(var, model, raw):
    """Conversione delle unità della grandezza (e niente negativi dove non hanno senso), su valori sciolti."""
    v = np.asarray(var.convert[model](np.asarray(raw, dtype=np.float64)), dtype=np.float64)
    if var.nonnegative:
        v = np.where(np.isnan(v), v, np.maximum(v, 0))
    return v


# ---------- la strada vera: server, formato compatto, pagina


def _through_server(tmp_path, model, var_id, fixture, step, extra=()):
    """Salva il campo come fa fetcher e lo chiede a /api/field come fa build_static. Torna (selezionato, json)."""
    var = variables.get(var_id)
    store = Store(data_dir=tmp_path / "data", bbox=BOX)
    chosen = None
    for fx, st in [(fixture, step), *extra]:
        f = select(decode_grib((FIX / fx).read_bytes()), var.selectors[model])
        if st == step:
            chosen = f
        f = fetcher._convert(var, model, crop(f, BOX))
        if var.half_res:
            f = halve(f)
        store.save(model, RUN, var_id, st, f)
    client = TestClient(create_app(store=store, start_scheduler=False))
    return chosen, client


def _page(tmp_path, field_json, var, points, pixels):
    """Parte della pagina (node): decodifica, valori, testi del tooltip e colori dei pixel."""
    binp = tmp_path / "field.bin"
    binp.write_bytes(packed.pack(field_json))
    reqp = tmp_path / "req.json"
    reqp.write_text(
        json.dumps(
            {
                "bin": str(binp),
                "decimals": var["decimals"],
                "scale": var["scale"],
                "points": [{"lat": a, "lon": b} for a, b in points],
                "pixels": pixels,
            }
        )
    )
    out = subprocess.run(["node", str(HELPER), str(reqp)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


# ---------- geometria dell'immagine sulla mappa e colori attesi, rifatti qui


def _merc(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def _inv_merc(y):
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


def _image_geometry(grid, upscale):
    """Bordi dell'immagine sulla mappa (bordi delle celle) e dimensioni in pixel, come la pagina la posa."""
    south = grid["lat0"] - grid["dlat"] / 2
    north = grid["lat0"] + (grid["ny"] - 1) * grid["dlat"] + grid["dlat"] / 2
    west = grid["lon0"] - grid["dlon"] / 2
    east = grid["lon0"] + (grid["nx"] - 1) * grid["dlon"] + grid["dlon"] / 2
    W = grid["nx"] * upscale
    H = max(1, round(W * (_merc(north) - _merc(south)) / math.radians(east - west)))
    return south, north, west, east, W, H


def _pixel_of(lat, lon, geo):
    """Pixel dell'immagine sopra (lat, lon) e il punto al centro di quel pixel."""
    south, north, west, east, W, H = geo
    x = int((lon - west) / (east - west) * W)
    y = int((_merc(north) - _merc(lat)) / (_merc(north) - _merc(south)) * H)
    clon = west + (x + 0.5) / W * (east - west)
    clat = _inv_merc(_merc(north) - (y + 0.5) / H * (_merc(north) - _merc(south)))
    return [x, y], (clat, clon)


def _hex(c):
    return [int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)]


def _color(scale, v):
    """Colore atteso (r, g, b, a) per un valore: fasce nette o scala sfumata, come descritto in render.js."""
    if v is None or math.isnan(v):
        return [0, 0, 0, 0]
    th, cols = scale["thresholds"], [_hex(c) for c in scale["colors"]]
    if scale.get("continuous"):
        v = min(max(v, th[0]), th[-1])
        k = 0
        while k + 1 < len(th) - 1 and v >= th[k + 1]:
            k += 1
        t = (v - th[k]) / (th[k + 1] - th[k])
        return [round(a + (b - a) * t) for a, b in zip(cols[k], cols[k + 1])] + [255]
    if scale.get("transparent_below") is not None and v < scale["transparent_below"]:
        return [0, 0, 0, 0]
    k = max([i for i, x in enumerate(th) if x <= v], default=0)
    return cols[k] + [255]


# ---------- i test


@pytest.mark.parametrize(("model", "var_id", "fixture", "step"), CASES, ids=[f"{m}-{v}" for m, v, _, _ in CASES])
def test_tooltip_e_colore_uguali_al_grib(tmp_path, model, var_id, fixture, step):
    var = variables.get(var_id)
    chosen, client = _through_server(tmp_path, model, var_id, fixture, step)
    with client:
        page_var = next(x for x in client.get("/api/meta").json()["variables"] if x["id"] == var_id)
        field_json = client.get("/api/field", params={"model": model, "var": var_id, "run": RUN, "step": step}).json()

    points = list(CITIES.values())
    upscale = max(2, math.ceil(1100 / field_json["grid"]["nx"]))
    geo = _image_geometry(field_json["grid"], upscale)
    pix = [_pixel_of(lat, lon, geo) for lat, lon in points]
    out = _page(tmp_path, field_json, page_var, points, [p for p, _ in pix])

    # stessa geometria dell'immagine calcolata qui e nella pagina
    assert (out["W"], out["H"]) == geo[4:]

    expected = _expected(var, model, _raw_nearest(fixture, chosen, points))
    tol = 0.5 * 10 ** -var.decimals + 1e-6  # il formato compatto tiene i decimali della grandezza
    for name, exp, got, text in zip(CITIES, expected, out["values"], out["texts"]):
        assert got is not None, name
        assert got == pytest.approx(exp, abs=tol), f"{name}: tooltip {got}, GRIB {exp}"
        assert float(text) == pytest.approx(exp, abs=tol), f"{name}: testo {text}, GRIB {exp}"

    centers = _expected(var, model, _raw_nearest(fixture, chosen, [c for _, c in pix]))
    for name, exp, got in zip(CITIES, centers, out["rgba"]):
        want = _color(page_var["scale"], float(exp))
        assert all(abs(a - b) <= 3 for a, b in zip(got, want)), f"{name}: pixel {got}, atteso {want} per {exp}"


def test_cumulata_fra_due_passi_uguale_alla_differenza_nel_grib(tmp_path):
    """Intervallo +3h → +24h (GFS): differenza dei due totali, letti ciascuno nel proprio GRIB."""
    var = variables.get("tp")
    chosen, client = _through_server(tmp_path, "gfs", "tp", "gfs_f024.grb", 24, extra=[("gfs_f003.grb", 3)])
    with client:
        page_var = next(x for x in client.get("/api/meta").json()["variables"] if x["id"] == "tp")
        params = {"model": "gfs", "var": "tp", "run": RUN, "step": 24, "mode": "interval", "prev": 3}
        field_json = client.get("/api/field", params=params).json()
    points = list(CITIES.values())
    out = _page(tmp_path, field_json, page_var, points, [])

    first = select(decode_grib((FIX / "gfs_f003.grb").read_bytes()), var.selectors["gfs"])
    tot24 = _expected(var, "gfs", _raw_nearest("gfs_f024.grb", chosen, points))
    tot3 = _expected(var, "gfs", _raw_nearest("gfs_f003.grb", first, points))
    tol = 10 ** -var.decimals + 1e-6  # due valori arrotondati
    for name, a, b, got in zip(CITIES, tot24, tot3, out["values"]):
        assert got == pytest.approx(max(0.0, a - b), abs=tol), f"{name}: tooltip {got}, GRIB {a} - {b}"
