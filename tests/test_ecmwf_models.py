"""ECMWF IFS 0.1° and AIFS: separate models, both in the median. The AIFS has a step every 6 hours."""
from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import mean, variables
from app.config import BBox
from app.fetcher import steps_for
from app.grid import Field
from app.main import create_app
from app.sources import aifs, ecmwf, ecmwf_hres
from app.store import Store

BOX = BBox.parse("42,49,4,17")
RUN = "2026112100"
RUN_DT = datetime(2026, 11, 21, 0, tzinfo=timezone.utc)


def _field(d: float, value: float) -> Field:
    ny = int(round((BOX.lat_max - BOX.lat_min) / d)) + 1
    nx = int(round((BOX.lon_max - BOX.lon_min) / d)) + 1
    return Field(values=np.full((ny, nx), value, np.float32), lat0=BOX.lat_min, lon0=BOX.lon_min, dlat=d, dlon=d)


def test_urls():
    assert ecmwf.base_url(RUN_DT, 24).endswith("/20261121/00z/ifs/0p25/oper/20261121000000-24h-oper-fc")
    assert ecmwf_hres.base_url(RUN_DT, 24, "sfc").endswith("/ifs/0p1/oper/20261121000000-24h-oper-fc-sfc")
    assert ecmwf_hres.base_url(RUN_DT, 24, "pl").endswith("/ifs/0p1/oper/20261121000000-24h-oper-fc-pl")
    assert aifs.base_url(RUN_DT, 24).endswith("/20261121/00z/aifs-single/0p25/oper/20261121000000-24h-oper-fc")


def test_fields_of_the_new_models():
    ifs = {v.id for v in variables.REGISTRY.values() if "ecmwf" in v.selectors}
    assert {v.id for v in variables.REGISTRY.values() if "aifs" in v.selectors} == ifs
    # the 0.1° without the synoptic chart
    assert {v.id for v in variables.REGISTRY.values() if "ecmwf-hres" in v.selectors} == ifs - {"z500", "msl"}
    tp = variables.REGISTRY["tp"]
    # IFS in metres of water, AIFS already in mm (kg m-2): the GRIB units of the two open datasets
    assert tp.convert["ecmwf-hres"](0.001) == pytest.approx(1.0) and tp.convert["aifs"](1.0) == pytest.approx(1.0)
    sf = variables.REGISTRY["sf"]
    assert sf.convert["ecmwf"](0.001) == pytest.approx(1.0) and sf.convert["aifs"](1.0) == pytest.approx(1.0)
    assert steps_for(tp, "aifs") == list(range(6, 193, 6))
    assert steps_for(tp, "ecmwf-hres") == steps_for(tp, "ecmwf")


def test_aifs_interval_and_meta(tmp_path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    for s in steps_for(variables.REGISTRY["tp"], "aifs"):
        store.save("aifs", RUN, "tp", s, _field(0.25, s * 1.0))
    with TestClient(create_app(store=store, start_scheduler=False)) as c:
        models = {x["id"]: x for x in c.get("/api/meta").json()["models"]}
        assert models["aifs"]["steps"] == list(range(6, 193, 6)) and "steps" not in models["ecmwf"]
        assert models["ecmwf-hres"]["label"] == "ECMWF IFS 0.1°"
        # interval: the step before +12h is +6h (there is no +9h)
        f = c.get("/api/field", params={"model": "aifs", "var": "tp", "run": RUN, "step": 12, "mode": "interval"}).json()
        assert f["prev_step"] == 6 and f["max"] == pytest.approx(6.0)
        assert c.get("/api/runs").json()["aifs"][0]["variables"]["tp"]["complete"] is True


def test_all_three_in_the_median_aifs_on_every_interval(tmp_path):
    """1 mm/h for IFS 0.25°, 2 for IFS 0.1°, 3 for AIFS (only every 6 hours): the median of each 3-hour interval is
    2 mm/h, so the AIFS enters the 3-hour steps too (with half of its 6 hours)."""
    store = Store(data_dir=tmp_path, bbox=BOX)
    tp = variables.REGISTRY["tp"]
    for model, d, rate in (("ecmwf", 0.25, 1.0), ("ecmwf-hres", 0.1, 2.0), ("aifs", 0.25, 3.0)):
        for s in steps_for(tp, model):
            store.save(model, RUN, "tp", s, _field(d, s * rate))
    mean.build_mean(store)
    info = mean.members_info(store, RUN, "tp")
    assert set(info["members"]) == {"ecmwf", "ecmwf-hres", "aifs"}
    assert info["steps"]["3"] == ["ecmwf", "ecmwf-hres", "aifs"] and info["steps"]["9"] == ["ecmwf", "ecmwf-hres", "aifs"]
    for step in (3, 9, 24):
        vals, _ = store.load("mean", RUN, "tp", step)
        assert np.nanmax(vals) == pytest.approx(2.0 * step, abs=0.01)
        assert np.nanmin(vals) == pytest.approx(2.0 * step, abs=0.01)


def test_median_instant_fields_aifs_only_at_its_steps(tmp_path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    t850 = variables.REGISTRY["t850"]
    for model, value in (("ecmwf", 0.0), ("ecmwf-hres", 1.0), ("aifs", 10.0)):
        for s in steps_for(t850, model):
            store.save(model, RUN, "t850", s, _field(0.25, value))
    mean.build_mean(store)
    info = mean.members_info(store, RUN, "t850")
    assert info["steps"]["3"] == ["ecmwf", "ecmwf-hres"] and info["steps"]["6"] == ["ecmwf", "ecmwf-hres", "aifs"]
