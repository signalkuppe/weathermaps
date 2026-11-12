"""Bulbo umido a 2 m (app/variables.py, wet_bulb_k)."""
import dataclasses
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
import pytest

from app.config import BBox
from app.fetcher import SOURCES, _fetch_field
from app.grid import Field
from app.sources import gfs
from app.variables import REGISTRY, dewpoint_from_rh_k, wet_bulb_k, wet_bulb_zero_m

K = 273.15


def test_dewpoint_from_relative_humidity():
    assert np.isclose(dewpoint_from_rh_k(293.15, 100), 293.15)
    assert np.isclose(dewpoint_from_rh_k(293.15, 50) - K, 9.255, atol=0.01)
    assert np.isnan(dewpoint_from_rh_k(293.15, 0))


@pytest.mark.parametrize("temperature, heights, pressure, surface, terrain, expected", [
    ([4, 2, -2], [2, 1000, 2000], [1000, 900, 800], 1000, 0, 1500),
    ([4, 2, 0], [2, 1000, 2000], [1000, 900, 800], 1000, 0, 2000),
    ([4, 2, 1], [2, 1000, 2000], [1000, 900, 800], 1000, 0, np.nan),
    ([-4, -2, -1], [2, 1000, 2000], [1000, 900, 800], 1000, 0, np.nan),
    ([4, np.nan, -2], [2, 1000, 2000], [1000, 900, 800], 1000, 0, np.nan),
    ([4, -9, -4], [1502, 1000, 2502], [850, 900, 750], 850, 1500, 2002),
    ([4, -9, -4], [2, 1, 1002], [1010, 1000, 900], 1010, 0, 502),
    ([4, -4, 2, -2], [2, 1002, 2002, 3002], [1000, 900, 800, 700], 1000, 0, 502),
    ([-4, 2, -2], [2, 1000, 2000], [1000, 900, 800], 1000, 0, 1500),
])
def test_zero_wetbulb_profile(temperature, heights, pressure, surface, terrain, expected):
    temperature = np.asarray(temperature) + K
    result = wet_bulb_zero_m(temperature, temperature, pressure, heights, surface, terrain)
    assert np.allclose(result, expected, equal_nan=True, atol=0.01)
    assert result.dtype == np.float32


def test_unsaturated_zero_below_dry_zero():
    temperature = np.array([4, -4]) + K
    dewpoint = dewpoint_from_rh_k(temperature, 70)
    result = wet_bulb_zero_m(temperature, dewpoint, [1000, 800], [2, 2002], 1000, 0)
    assert 2 < result < 1002


@pytest.fixture
def gfs_profile():
    def field(name, level_type, level, units, value):
        return Field(np.full((2, 2), value, dtype=np.float32), 42, 4, 0.25, 0.25,
                     short_name=name, units=units, level_type=level_type, level=level)
    fields = [
        field("sp", "surface", 0, "Pa", 101000),
        field("orog", "surface", 0, "m", 100),
        field("2t", "heightAboveGround", 2, "K", K + (1500 - 102) / 200),
        field("2d", "heightAboveGround", 2, "K", K + (1500 - 102) / 200),
    ]
    for level in gfs.WET_ZERO_LEVELS:
        height = (1010 - level) * 10 + 100
        fields.extend([
            field("t", "isobaricInhPa", level, "K", K + (1500 - height) / 200),
            field("r", "isobaricInhPa", level, "%", 100),
            field("gh", "isobaricInhPa", level, "gpm", height),
        ])
    return fields


def test_gfs_wet_zero_fetch(monkeypatch, gfs_profile):
    bbox = BBox(lat_min=42, lat_max=42.25, lon_min=4, lon_max=4.25)
    run = datetime(2026, 11, 12, 6, tzinfo=timezone.utc)
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, content=b"GRIB")

    monkeypatch.setattr(gfs, "decode_grib", lambda data: list(reversed(gfs_profile)))
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        result = _fetch_field(gfs, client, run, 24, REGISTRY["hwzero"], bbox)
    assert np.allclose(result.values, 1500, atol=0.01)
    assert result.units == "m"
    assert len(requests) == 1
    params = parse_qs(urlparse(str(requests[0].url)).query, keep_blank_values=True)
    assert all(params[f"lev_{level}_mb"] == ["on"] for level in gfs.WET_ZERO_LEVELS)
    assert all(params[f"var_{name}"] == ["on"] for name in ("TMP", "RH", "HGT", "DPT", "PRES"))
    assert params["lev_surface"] == params["lev_2_m_above_ground"] == ["on"]
    assert params["leftlon"] == ["4"]
    assert params["rightlon"] == ["4.25"]
    assert REGISTRY["hwzero"].as_dict()["models"] == ["gfs"]


@pytest.mark.parametrize("defect", ["missing", "duplicate", "units", "grid"])
def test_gfs_wet_zero_rejects_bad_profile(gfs_profile, defect):
    bbox = BBox(lat_min=42, lat_max=42.25, lon_min=4, lon_max=4.25)
    if defect == "missing":
        gfs_profile.pop()
    elif defect == "duplicate":
        gfs_profile.append(gfs_profile[-1])
    elif defect == "units":
        gfs_profile[-1] = dataclasses.replace(gfs_profile[-1], units="m2 s-2")
    else:
        gfs_profile[-1] = dataclasses.replace(gfs_profile[-1], dlat=0.5)
    with pytest.raises(ValueError):
        gfs._wet_zero(gfs_profile, bbox)


def test_equazione_con_coefficiente_costante():
    temperature = np.array([30.0, 20.0, 5.0, -5.0])
    dewpoint = np.array([10.0, 10.0, -5.0, -15.0])
    pressure = np.array([1013.25, 850.0, 700.0, 600.0])
    wet_bulb = wet_bulb_k(temperature + K, dewpoint + K, pressure) - K
    vapor_pressure = 6.112 * np.exp(17.62 * dewpoint / (243.12 + dewpoint))
    saturation = 6.112 * np.exp(17.62 * wet_bulb / (243.12 + wet_bulb))
    assert np.allclose(saturation - 6.46e-4 * pressure * (temperature - wet_bulb),
                       vapor_pressure, atol=1e-7, rtol=0)


def test_valori_di_riferimento():
    # tabelle psicrometriche a 1013 hPa: T 20 °C, rugiada 10 °C -> bulbo umido ~14,2 °C
    tw = wet_bulb_k(np.array([20 + K]), np.array([10 + K]), 1013.25)[0] - K
    assert abs(tw - 14.2) < 0.15


def test_saturo_e_limiti():
    t = np.array([5, -3, 30]) + K
    tw = wet_bulb_k(t, t, 850.0) - K  # aria satura: bulbo umido = temperatura
    assert np.allclose(tw, [5, -3, 30], atol=0.01)
    td = np.array([-10, -15, 5]) + K
    tw = wet_bulb_k(t, td, 850.0) - K
    assert np.all(tw <= t - K) and np.all(tw >= td - K)


def test_mancanti_restano_mancanti():
    tw = wet_bulb_k(np.array([np.nan, 10 + K]), np.array([5 + K, 5 + K]), 850.0)
    assert np.isnan(tw[0]) and np.isfinite(tw[1])


def test_registrata_con_il_punto_di_rugiada():
    v = REGISTRY["tw2m"]
    assert v.combine is wet_bulb_k
    assert all(sel.dew is not None for sel in v.selectors.values())
    assert all(sel.pressure is not None for sel in v.selectors.values())
    assert set(v.selectors) == set(REGISTRY["t2m"].selectors) - {"wrf"}


def test_pressione_locale_e_mancanti():
    pressure = np.array([1013.25, 800.0, np.nan, 0.0, -1.0, np.inf])
    wet_bulb = wet_bulb_k(20 + K, 10 + K, pressure)
    assert wet_bulb[1] < wet_bulb[0]
    assert np.isnan(wet_bulb[2:]).all()


@pytest.mark.parametrize("model_id", REGISTRY["tw2m"].selectors)
@pytest.mark.parametrize("units,factor", [("Pa", 100.0), ("hPa", 1.0), ("kPa", 0.1)])
def test_fetch_con_pressione_locale(monkeypatch, model_id, units, factor):
    variable = REGISTRY["tw2m"]
    selector = variable.selectors[model_id]
    pressure_hpa = np.array([[800.0, 1000.0]], dtype=np.float32)
    calls = []

    def fetch(source, client, run, step, var, bbox):
        selected = var.selectors[model_id]
        calls.append(selected)
        if selected == selector:
            values, field_units = np.full((1, 2), 20 + K), "K"
        elif selected == selector.dew:
            values, field_units = np.full((1, 2), 10 + K), "K"
        else:
            assert selected == selector.pressure
            values, field_units = pressure_hpa * factor, units
        return Field(values=values, lat0=42, lon0=4, dlat=0.25, dlon=0.25, units=field_units)

    monkeypatch.setattr("app.fetcher._fetch_with_retry", fetch)
    result = _fetch_field(SOURCES[model_id], None, datetime(2026, 11, 12, tzinfo=timezone.utc),
                          3, variable, BBox.parse("42,49,4,17"))
    expected = wet_bulb_k(20 + K, 10 + K, pressure_hpa)
    assert np.allclose(result.values, expected)
    assert result.values.dtype == np.float32
    assert calls == [selector, selector.dew, selector.pressure]


@pytest.mark.parametrize("units,lon0,shape", [("m", 4, (1, 2)), ("Pa", 5, (1, 2)), ("Pa", 4, (2, 2))])
def test_fetch_rifiuta_pressione_incompatibile(monkeypatch, units, lon0, shape):
    variable = REGISTRY["tw2m"]
    selector = variable.selectors["gfs"]
    template = Field(values=np.full((1, 2), 280.0), lat0=42, lon0=4, dlat=0.25, dlon=0.25)

    def fetch(source, client, run, step, var, bbox):
        if var.selectors["gfs"] == selector.pressure:
            return dataclasses.replace(template, values=np.full(shape, 80000.0), lon0=lon0, units=units)
        return dataclasses.replace(template)

    monkeypatch.setattr("app.fetcher._fetch_with_retry", fetch)
    with pytest.raises(ValueError, match="pressione"):
        _fetch_field(SOURCES["gfs"], None, datetime(2026, 11, 12, tzinfo=timezone.utc),
                     3, variable, BBox.parse("42,49,4,17"))
