"""Relative humidity and wind at 850 hPa: the models that publish them, the ones where the humidity is computed from
the specific humidity (AIFS, MOLOCH) at the level's constant pressure, and the combined menu entry."""
from datetime import datetime, timezone

import numpy as np
import pytest

from app.config import BBox
from app.fetcher import SOURCES, _fetch_field
from app.grid import Field
from app.variables import COMBOS, REGISTRY, VECTORS, menu, rh_from_q

K = 273.15
MODELS = {"gfs", "ecmwf", "ecmwf-hres", "aifs", "icon-2i", "icon-2i-ruc", "icon-d2", "wrf", "moloch"}


def test_rh_from_specific_humidity():
    # 4.5 g/kg at 850 hPa: saturated at 0 °C, about half at 10 °C; never outside 0-100
    rh = rh_from_q(np.array([K, 10 + K, -30 + K]), np.array([0.0045, 0.0045, 0.0]), 850.0)
    assert rh[0] == pytest.approx(100.0, abs=0.5)
    assert rh[1] == pytest.approx(50.0, abs=1.0)
    assert rh[2] == 0.0
    assert rh_from_q(np.array([-20 + K]), np.array([0.01]), 850.0)[0] == 100.0  # supersaturated: clipped


def test_models_and_menu():
    r = REGISTRY["r850"]
    assert set(r.selectors) == MODELS and r.hidden and r.units == "%"
    assert set(REGISTRY["u850"].selectors) == set(REGISTRY["v850"].selectors) == MODELS
    # published as relative humidity, or computed from temperature + specific humidity
    computed = {m for m, s in r.selectors.items() if s.dew is not None}
    assert computed == {"aifs", "moloch"}
    assert r.selectors["aifs"].dew.param == "q" and r.selectors["moloch"].dew.param == "qv"
    assert r.extra["pressure_hpa"] == 850.0
    assert {"id": "wind850", "label": "Vento 850 hPa", "u": "u850", "v": "v850"} in VECTORS
    combo = next(c for c in COMBOS if c["id"] == "r850_wind850")
    assert combo["field"] == "r850" and combo["arrows"] == "wind850"
    ids = [m["id"] for m in menu()]
    assert ids.index("r850_wind850") == ids.index("t850") + 2  # after T850 and the synoptic chart
    assert "r850" not in ids  # only through the combined entry


@pytest.mark.parametrize("model_id", ["aifs", "moloch"])
def test_fetch_computes_rh_at_constant_pressure(monkeypatch, model_id):
    variable = REGISTRY["r850"]
    selector = variable.selectors[model_id]
    calls = []

    def fetch(source, client, run, step, var, bbox):
        selected = var.selectors[model_id]
        calls.append(selected)
        if selected == selector:
            values, units = np.array([[K, 10 + K]]), "K"
        else:
            assert selected == selector.dew  # no pressure field is downloaded
            values, units = np.full((1, 2), 0.0045), "kg kg**-1"
        return Field(values=values, lat0=42, lon0=4, dlat=0.25, dlon=0.25, units=units)

    monkeypatch.setattr("app.fetcher._fetch_with_retry", fetch)
    result = _fetch_field(SOURCES[model_id], None, datetime(2026, 11, 23, tzinfo=timezone.utc),
                          12, variable, BBox.parse("42,49,4,17"))
    assert calls == [selector, selector.dew]
    assert np.allclose(result.values, rh_from_q(np.array([[K, 10 + K]]), 0.0045, 850.0))
    assert result.values.dtype == np.float32


def test_published_humidity_clipped_to_100():
    conv = REGISTRY["r850"].convert
    assert set(conv) == MODELS
    assert list(conv["ecmwf-hres"](np.array([103.0, -1.0, 55.0]))) == [100.0, 0.0, 55.0]
