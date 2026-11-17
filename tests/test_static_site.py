"""Static site (scripts/build_static.py): what goes online, built from fake data in a temporary folder.

- the files the page expects are there and say the right things (meta.json, runs.json, fields, series,
  soundings); no files for the runs still incoming;
- the .bin fields read back equal to /api/field;
- the series read by the real page (getSeries, unpackField and valueAt from app.js, in node) give the same values
  as the API and, for precipitation and snow, the same number as the map tooltip.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import fetcher, packed, series, variables
from app.grid import Field
from app.main import create_app
from app.store import Store

ROOT = Path(__file__).resolve().parent.parent
HELPER = Path(__file__).parent / "helpers" / "page_series.mjs"
BBOX = "42,49,4,17"
RUN, NEW = "2026111600", "2026111606"  # complete run and run still incoming
GRID = dict(lat0=42.0, lon0=4.0, dlat=0.25, dlon=0.25)  # GFS: 29 × 53
SMOOTH_VARS = ("t850", "hzero", "u10", "v10")


def _fields(step: int) -> dict[str, np.ndarray]:
    """Fake fields, but different from cell to cell and from step to step, with missing values in a corner."""
    iy, ix = np.mgrid[0:29, 0:53].astype(np.float32)
    tp = np.round(step * (0.05 + 0.01 * ((iy * 7 + ix * 3) % 11)), 1)
    tp[:4, :5] = np.nan  # outside the domain: null in the series and in the tooltip
    return {
        "tp": tp,
        "t850": np.round(-12 + 0.3 * iy - 0.2 * ix + 0.05 * step, 1),
        "hzero": np.round(1500 + 40 * iy + 10 * ix - step, 0),
        "u10": np.round(np.sin(iy + step / 10) * 20, 0),
        "v10": np.round(np.cos(ix - step / 10) * 15, 0),
    }


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    data = tmp_path_factory.mktemp("dati")
    out = tmp_path_factory.mktemp("sito") / "public"
    mp = pytest.MonkeyPatch()
    mp.setenv("DATA_DIR", str(data))
    mp.setenv("BBOX", BBOX)
    store = Store()
    for step in fetcher.steps_for(variables.get("tp"), "gfs"):
        for var, values in _fields(step).items():
            store.save("gfs", RUN, var, step, Field(values=values, **GRID))
    store.save("gfs", NEW, "tp", 3, Field(values=_fields(3)["tp"], **GRID))  # incoming: a single step
    # soundings: two launches, only the latest goes on the site
    snd = store.root / "soundings" / "16064"
    snd.mkdir(parents=True)
    for key in ("2026111600", "2026111612"):
        (snd / f"{key}.json").write_text(json.dumps({"station": "16064", "time": key, "levels": [[1000, 100, 5, 4, 0, 0]]}))

    sys.path.insert(0, str(ROOT / "scripts"))
    import build_static
    # the esbuild bundle (npx, network) is not needed here: an app.js for the fingerprint in the URL is enough
    mp.setattr(build_static, "build_javascript", lambda path: shutil.copy(ROOT / "static" / "app.js", path))
    import contextlib
    import io
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        assert build_static.main(out) == 0
    yield {"out": out, "store": store, "log": log.getvalue()}
    mp.undo()


def _json(site, path):
    return json.loads((site["out"] / path).read_text())


def test_meta_and_runs(site):
    meta = _json(site, "data/meta.json")
    assert meta["series"], "without `series` the popup does not show Grafico and Multimodel"
    gfs = _json(site, "data/runs.json")["models"]["gfs"]
    assert [i["run"] for i in gfs] == [RUN, NEW] and gfs[1]["incoming"] is True
    assert set(gfs[0]["series"]) == {"native", "smooth"}
    assert gfs[0]["series"]["native"] == {**GRID, "ny": 29, "nx": 53, "block": 8}
    assert "series" not in gfs[1]  # incoming run: no series...
    assert not (site["out"] / "data" / "field" / "gfs" / "tp" / NEW).exists()  # ...and no fields
    assert not (site["out"] / "data" / "series" / "gfs" / NEW).exists()


def test_fields_match_api(site):
    steps = fetcher.steps_for(variables.get("tp"), "gfs")
    d = site["out"] / "data" / "field" / "gfs"
    assert sorted(int(p.stem) for p in (d / "tp" / RUN).glob("*.bin")) == steps
    assert not (d / "u10").exists() and (d / "wind10" / RUN / "24.bin").exists()  # wind: u and v in one file
    wind = packed.unpack((d / "wind10" / RUN / "24.bin").read_bytes())
    assert len(wind["u"]) == len(wind["v"]) == 29 * 53
    with TestClient(create_app(store=site["store"], start_scheduler=False)) as c:
        for step in (3, 24, steps[-1]):
            api = c.get("/api/field", params={"model": "gfs", "run": RUN, "var": "tp", "step": step}).json()
            assert packed.unpack((d / "tp" / RUN / f"{step}.bin").read_bytes())["values"] == api["values"]


def test_soundings_and_summary(site):
    idx = {s["id"]: s for s in _json(site, "data/soundings/index.json")}
    assert idx["16064"]["times"][0] == "2026111612"
    assert [p.name for p in (site["out"] / "data" / "soundings" / "16064").iterdir()] == ["2026111612.json"]
    # the summary counts the files actually written (there is no ensemble here)
    m = re.search(r"(\d+) fields, (\d+) series tiles, (\d+) ensemble points", site["log"])
    nfield = len(list((site["out"] / "data" / "field").rglob("*.bin")))
    nser = len(list((site["out"] / "data" / "series").rglob("*.bin")))
    assert m and (int(m[1]), int(m[2]), int(m[3])) == (nfield, nser, 0)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed for the page side")
def test_series_read_by_the_page(site, tmp_path):
    """The page's getSeries: same values as the API at every point (tile edges, missing cells, outside the
    domain) and, for precipitation, the same number as the map tooltip at the same step."""
    tiles = list((site["out"] / "data" / "series" / "gfs" / RUN).rglob("*.bin"))
    kinds = {k for p in tiles for k in re.findall(rb'"\$([qz])"', p.read_bytes()[:20000])}
    assert kinds == {b"q", b"z"}, "tiles with both value forms are needed"
    step = 120
    pts = [
        (45.46, 9.19),  # Milan
        (46.17, 9.87),  # Sondrio
        (42.0, 4.0), (42.6, 4.9),  # corner without data
        (43.99, 5.99), (44.0, 6.0), (44.13, 6.13),  # around the edge between two tiles (8 cells = 2°)
        (45.95, 11.87), (46.05, 12.05),  # regular grid: edge between 2° tiles
        (48.99, 16.99),  # last corner
        (41.0, 9.0), (46.0, 18.5),  # outside the area
    ]
    queries = [{"model": "gfs", "run": RUN, "lat": lat, "lon": lon, "field": f"data/field/gfs/tp/{RUN}/{step}.bin"}
               for lat, lon in pts]
    reqp = tmp_path / "richiesta.json"
    reqp.write_text(json.dumps({"site": str(site["out"]), "queries": queries}))
    res = json.loads(subprocess.run(["node", str(HELPER), str(reqp)], capture_output=True, text=True,
                                    check=True).stdout)
    for (lat, lon), r in zip(pts, res):
        got = r["series"]
        assert "error" not in got, (lat, lon, got)
        want = series.point_series(site["store"], "gfs", RUN, lat, lon)
        assert set(got["vars"]) == set(want["vars"]), (lat, lon)
        for var, w in want["vars"].items():
            assert got["vars"][var]["steps"] == w["steps"], (lat, lon, var)
            assert got["vars"][var]["values"] == w["values"], (lat, lon, var)
        if "tp" in want["vars"]:
            i = want["vars"]["tp"]["steps"].index(step)
            assert got["vars"]["tp"]["values"][i] == r["map"], (lat, lon)  # chart = map tooltip
            assert (round(got["lat"], 4), round(got["lon"], 4)) == (want["lat"], want["lon"])
