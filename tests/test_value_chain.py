"""The values on the map are the model's: the whole chain, from the GRIB to the tooltip and the pixel colour.

For each city the reference value comes from ecCodes (`codes_grib_find_nearest`, the nearest grid point in the
original GRIB message), without going through our code. The checked value instead takes the real path:

  GRIB -> decode_grib -> select -> crop -> unit conversion (like fetcher) -> Store -> /api/field
       -> compact .bin format (like build_static) -> the page's unpackField and valueAt (node) -> tooltip
       -> wmRenderPixels (render.js, sharp cells) -> colour of the pixel over the city

The pixel is found with the image bounds on the map (cell edges, Mercator), computed separately here, and its
expected colour comes from the ecCodes value at the pixel centre and the thresholds of the scale the page receives.
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
HELPER = Path(__file__).parent / "helpers" / "value_chain.mjs"
BOX = BBox.parse("42,49,4,17")
RUN = "2026110900"

# away from halfway between two grid points (0.25° and 0.1°), where "the nearest" would be ambiguous
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

# (model, field, GRIB file, step)
CASES = [
    ("gfs", "tp", "gfs_f024.grb", 24),
    ("gfs", "t850", "gfs_t850_f024.grb", 24),
    ("ecmwf", "tp", "ec01_tp24.grb", 24),
    ("ecmwf", "t850", "ec_t850_24.grb", 24),
]

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is needed for the page side")


# ---------- reference: ecCodes on the original GRIB


def _raw_nearest(fixture: str, meta, points):
    """Raw value of the nearest grid point, for each (lat, lon), in the message equal to the one selected."""
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
    raise AssertionError(f"message not found in {fixture}")


def _expected(var, model, raw):
    """Unit conversion of the field (and no negatives where they make no sense), on plain values."""
    v = np.asarray(var.convert[model](np.asarray(raw, dtype=np.float64)), dtype=np.float64)
    if var.nonnegative:
        v = np.where(np.isnan(v), v, np.maximum(v, 0))
    return v


# ---------- the real path: server, compact format, page


def _through_server(tmp_path, model, var_id, fixture, step, extra=()):
    """Stores the field like fetcher does and requests it from /api/field like build_static. Returns (selected, json)."""
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
    """Page side (node): decoding, values, tooltip texts and pixel colours."""
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


# ---------- geometry of the image on the map and expected colours, recomputed here


def _merc(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def _inv_merc(y):
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


def _image_geometry(grid, upscale):
    """Image bounds on the map (cell edges) and size in pixels, as the page places it."""
    south = grid["lat0"] - grid["dlat"] / 2
    north = grid["lat0"] + (grid["ny"] - 1) * grid["dlat"] + grid["dlat"] / 2
    west = grid["lon0"] - grid["dlon"] / 2
    east = grid["lon0"] + (grid["nx"] - 1) * grid["dlon"] + grid["dlon"] / 2
    W = grid["nx"] * upscale
    H = max(1, round(W * (_merc(north) - _merc(south)) / math.radians(east - west)))
    return south, north, west, east, W, H


def _pixel_of(lat, lon, geo):
    """Pixel of the image over (lat, lon) and the point at the centre of that pixel."""
    south, north, west, east, W, H = geo
    x = int((lon - west) / (east - west) * W)
    y = int((_merc(north) - _merc(lat)) / (_merc(north) - _merc(south)) * H)
    clon = west + (x + 0.5) / W * (east - west)
    clat = _inv_merc(_merc(north) - (y + 0.5) / H * (_merc(north) - _merc(south)))
    return [x, y], (clat, clon)


def _hex(c):
    return [int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)]


def _color(scale, v):
    """Expected colour (r, g, b, a) for a value: sharp bands or smooth scale, as described in render.js."""
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


# ---------- the tests


@pytest.mark.parametrize(("model", "var_id", "fixture", "step"), CASES, ids=[f"{m}-{v}" for m, v, _, _ in CASES])
def test_tooltip_and_colour_match_grib(tmp_path, model, var_id, fixture, step):
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

    # same image geometry computed here and in the page
    assert (out["W"], out["H"]) == geo[4:]

    expected = _expected(var, model, _raw_nearest(fixture, chosen, points))
    tol = 0.5 * 10 ** -var.decimals + 1e-6  # the compact format keeps the field's decimals
    for name, exp, got, text in zip(CITIES, expected, out["values"], out["texts"]):
        assert got is not None, name
        assert got == pytest.approx(exp, abs=tol), f"{name}: tooltip {got}, GRIB {exp}"
        assert float(text) == pytest.approx(exp, abs=tol), f"{name}: testo {text}, GRIB {exp}"

    centers = _expected(var, model, _raw_nearest(fixture, chosen, [c for _, c in pix]))
    for name, exp, got in zip(CITIES, centers, out["rgba"]):
        want = _color(page_var["scale"], float(exp))
        assert all(abs(a - b) <= 3 for a, b in zip(got, want)), f"{name}: pixel {got}, atteso {want} per {exp}"


def test_interval_between_two_steps_matches_grib_difference(tmp_path):
    """+3h → +24h interval (GFS): difference of the two totals, each read from its own GRIB."""
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
    tol = 10 ** -var.decimals + 1e-6  # two rounded values
    for name, a, b, got in zip(CITIES, tot24, tot3, out["values"]):
        assert got == pytest.approx(max(0.0, a - b), abs=tol), f"{name}: tooltip {got}, GRIB {a} - {b}"
