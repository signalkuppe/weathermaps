"""GFS and ECMWF ensembles (place spaghetti plots on the synoptic chart): indexes, storage, points for the page."""
import gzip
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import ensemble
from app.config import BBox
from app.grid import Field
from app.main import create_app
from app.store import Store

BOX = BBox.parse("42,49,4,17")
RUN = "2026111500"
GFS, EC = ensemble.SOURCES["gfs"], ensemble.SOURCES["ecmwf"]

IDX = """1:0:d=2026111500:HGT:500 mb:12 hour fcst:ENS=+1
2:1000:d=2026111500:TMP:850 mb:12 hour fcst:ENS=+1
3:2500:d=2026111500:APCP:surface:0-12 hour acc fcst:ENS=+1
4:4000:d=2026111500:APCP:surface:6-12 hour acc fcst:ENS=+1
5:5200:d=2026111500:UGRD:10 m above ground:12 hour fcst:ENS=+1
"""


def test_gefs_index_temperature_and_last_6h_precipitation():
    assert ensemble.gefs_ranges(IDX, 12) == {"t850": (1000, 2499), "tp": (4000, 5199)}  # 6-12, not the 0-12 total
    with pytest.raises(LookupError):
        ensemble.gefs_ranges(IDX, 18)


def test_ens_index_and_member_blocks():
    recs = []
    for k in range(1, 51):  # t850 of the 50 members one after the other, precipitation elsewhere (and out of order)
        recs.append({"type": "pf", "param": "t", "levelist": "850", "levtype": "pl", "number": str(k),
                     "_offset": 1000 + (k - 1) * 10, "_length": 10})
        recs.append({"type": "pf", "param": "tp", "levtype": "sfc", "number": str(k),
                     "_offset": 90000 + (50 - k) * 20, "_length": 20})
    recs.append({"type": "pf", "param": "t", "levelist": "500", "levtype": "pl", "number": "1", "_offset": 5, "_length": 5})
    r = ensemble.ecens_records("\n".join(json.dumps(x) for x in recs), EC.members)
    assert r["t850"]["01"] == (1000, 10) and r["tp"]["50"] == (90000, 20)
    assert ensemble._blocks(r["t850"]) == [(1000, 1499, list(EC.members))]  # a single request
    assert ensemble._blocks(r["tp"])[0] == (90000, 90999, list(reversed(EC.members)))
    with pytest.raises(LookupError):
        ensemble.ecens_records(json.dumps(recs[0]), EC.members)


def _fill(store: Store, src, run: str = RUN, cumulative: bool = False):
    """Fake complete run: 3×3 points, values that tell member and step; precipitation 1 mm every 6 hours per member."""
    for k, m in enumerate(src.members):
        for j, s in enumerate(src.steps):
            for v, val in (("t850", k + s / 1000), ("tp", (j + 1.0) if cumulative else 1.0)):
                vals = np.full((3, 3), val, np.float32)
                vals[1, 2] += 100 if v == "t850" else 0  # the point (row 1, column 2) is recognisable
                store.save(src.store_id, run, f"{v}.{m}", s, Field(values=vals, lat0=45, lon0=9, dlat=0.5, dlon=0.5))


def test_nearest_point_and_meta(tmp_path: Path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    assert ensemble.info(store) == {}
    _fill(store, GFS)
    assert ensemble.latest_complete(store, GFS) == RUN
    info = ensemble.info(store)
    assert list(info) == ["gfs"] and info["gfs"]["control"] == "c00" and len(info["gfs"]["members"]) == 31
    d = ensemble.point_series(store, "gfs", 45.6, 9.9)  # nearest to (45.5, 10.0): row 1, column 2
    assert (d["lat"], d["lon"]) == (45.5, 10.0)
    assert len(d["t850"]) == 31 and len(d["t850"][0]) == 64
    assert d["t850"][3][0] == pytest.approx(103.0, abs=0.05) and d["tp"][5][10] == pytest.approx(1)
    pts = list(ensemble.all_points(store))
    assert len(pts) == 9 and pts[5][:3] == ("gfs", 1, 2)


def test_ecmwf_precipitation_from_accumulated_to_6h(tmp_path: Path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    _fill(store, EC, cumulative=True)
    d = ensemble.point_series(store, "ecmwf", 45.5, 10)
    assert d["control"] is None and len(d["members"]) == 50 and d["steps"][-1] == 360
    assert d["tp"][0][:3] == [1.0, 1.0, 1.0]  # accumulated 1, 2, 3 mm -> 1 mm every 6 hours


def test_ensemble_api(tmp_path: Path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    with TestClient(create_app(store=store, start_scheduler=False)) as c:
        assert c.get("/api/meta").json()["ensemble"] == {}
        assert c.get("/api/ensemble", params={"model": "gfs", "lat": 45.5, "lon": 10}).status_code == 404
        _fill(store, GFS)
        assert c.get("/api/meta").json()["ensemble"]["gfs"]["run"] == RUN
        d = c.get("/api/ensemble", params={"model": "gfs", "lat": 45.5, "lon": 10}).json()
        assert d["members"][0] == "c00" and d["steps"][-1] == 384
        assert c.get("/api/ensemble", params={"model": "ecmwf", "lat": 45.5, "lon": 10}).status_code == 404


def test_incomplete_run_not_shown_and_old_one_kept(tmp_path: Path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    _fill(store, GFS, "2026111412")
    store.save(GFS.store_id, RUN, "t850.c00", 6,
               Field(values=np.zeros((3, 3), np.float32), lat0=45, lon0=9, dlat=0.5, dlon=0.5))
    assert ensemble.latest_complete(store, GFS) == "2026111412"


def test_ecmwf_operational_index():
    recs = [
        {"type": "fc", "param": "t", "levelist": "500", "levtype": "pl", "_offset": 5, "_length": 5},
        {"type": "fc", "param": "t", "levelist": "850", "levtype": "pl", "_offset": 100, "_length": 50},
        {"type": "fc", "param": "tp", "levtype": "sfc", "_offset": 300, "_length": 70},
    ]
    assert ensemble.ecmwf_op_records("\n".join(json.dumps(x) for x in recs)) == {"t850": (100, 50), "tp": (300, 70)}
    with pytest.raises(LookupError):
        ensemble.ecmwf_op_records(json.dumps(recs[0]))


def test_operational_run_on_its_own_grid(tmp_path: Path):
    """The operational run (member "op") has its own grid (GFS 0.25° under the GEFS 0.5° points): it is read at the
    nearest cell of each point; missing steps stay missing and the run is complete without it."""
    store = Store(data_dir=tmp_path, bbox=BOX)
    _fill(store, GFS)
    d = ensemble.point_series(store, "gfs", 45.5, 10)
    assert d["op"] is None  # not downloaded: spaghetti without the operational run
    for s in GFS.steps[:-1]:  # the last step is missing
        t = np.full((5, 5), 20.0, np.float32)
        t[2, 4] = s / 10  # the cell under (45.5, 10.0) on the 0.25° grid
        t[3, 3] = 100 + s / 10
        store.save(GFS.store_id, RUN, "t850.op", s, Field(values=t, lat0=45, lon0=9, dlat=0.25, dlon=0.25))
        rain = np.full((5, 5), 2.0, np.float32)
        rain[3, 3] = 18.6
        store.save(GFS.store_id, RUN, "tp.op", s, Field(values=rain, lat0=45, lon0=9,
                                                         dlat=0.25, dlon=0.25))
    assert ensemble.latest_complete(store, GFS) == RUN
    d = ensemble.point_series(store, "gfs", 45.5, 10)
    assert d["op"]["t850"][:2] == [0.6, 1.2] and d["op"]["t850"][-1] is None
    assert d["op"]["tp"][:2] == [2.0, 2.0]  # GFS: already 6-hour buckets
    pts = {(iy, ix): p for _, iy, ix, p in ensemble.all_points(store)}
    assert pts[(1, 2)]["op"]["t850"][0] == 0.6 and pts[(0, 0)]["op"]["t850"][0] == 20.0
    point = ensemble.point_series(store, "gfs", 45.65, 9.85)
    assert (point["lat"], point["lon"]) == (45.5, 10.0)
    assert point["t850"] == d["t850"]
    assert point["op"]["t850"][:2] == [100.6, 101.2]
    assert point["op"]["tp"][:2] == [18.6, 18.6]
    assert point["op"]["tp"][-1] is None
    op_grid = ensemble.info(store)["gfs"]["op_grid"]
    assert (op_grid["dlat"], op_grid["dlon"], op_grid["ny"], op_grid["nx"]) == (0.25, 0.25, 5, 5)
    assert ensemble.point_index(op_grid, 45.625, 9.625) == (3, 3)
    assert ensemble.point_series(store, "gfs", 45.625, 9.625)["op"] == point["op"]
    official = {(iy, ix): body for _, _, iy, ix, body in ensemble.all_operational_points(store)}
    assert len(official) == 25
    assert official[(3, 3)] == point["op"]
    from scripts import build_static

    output = tmp_path / "public"
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(build_static, "Store", lambda: store)
        patch.setattr(build_static, "build_page", lambda _: None)
        assert build_static.main(output) == 0
    exported = json.loads(gzip.decompress((output / "data" / "ensemble" / "gfs" / RUN / "op" / "3_3.json").read_bytes()))  # stored compressed
    assert exported == point["op"]
    assert json.loads((output / "data" / "meta.json").read_text())["ensemble"]["gfs"]["op_grid"] == op_grid
    with TestClient(create_app(store=store, start_scheduler=False)) as client:
        response = client.get("/api/ensemble", params={"model": "gfs", "lat": 45.65, "lon": 9.85})
        assert response.status_code == 200
        assert response.json()["op"] == exported


def test_ecmwf_operational_precipitation_from_accumulated(tmp_path: Path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    _fill(store, EC, cumulative=True)
    for j, s in enumerate(EC.steps[:4]):
        if s == 18:
            continue  # a missing step: the 6 hours after it cannot be computed
        for v, val in (("t850", 1.0), ("tp", 3.0 * (j + 1))):
            store.save(EC.store_id, RUN, f"{v}.op", s, Field(values=np.full((3, 3), val, np.float32), lat0=45,
                                                             lon0=9, dlat=0.5, dlon=0.5))
    d = ensemble.point_series(store, "ecmwf", 45.5, 10)
    assert d["op"]["tp"][:4] == [3.0, 3.0, None, None] and d["op"]["tp"][4] is None
