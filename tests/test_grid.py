from pathlib import Path

import numpy as np
import pytest

from app.config import BBox
from app.grid import crop, decode_grib, select
from app.variables import get

FIX = Path(__file__).parent / "fixtures"
NORD_ITALIA = BBox.parse("42,49,4,17")


def load(name):
    return decode_grib((FIX / name).read_bytes())


def test_gfs_picks_total_from_start():
    fields = load("gfs_f024.grb")
    assert sorted(f.step_range for f in fields) == ["0-24", "18-24"]
    f = select(fields, get("tp").selectors["gfs"])
    assert f.step_range == "0-24"
    assert f.units == "kg m**-2"


def test_gfs_shape_and_orientation():
    f = crop(select(load("gfs_f024.grb"), get("tp").selectors["gfs"]), NORD_ITALIA)
    assert f.values.shape == (29, 53)
    assert (f.lat0, f.lon0, f.dlat, f.dlon) == (42.0, 4.0, 0.25, 0.25)
    assert f.lats()[-1] == pytest.approx(49.0)
    assert f.lons()[-1] == pytest.approx(17.0)


def test_gfs_total_ge_bucket():
    fields = {f.step_range: f.values for f in load("gfs_f024.grb")}
    assert np.all(fields["0-24"] >= fields["18-24"] - 1e-3)


def test_ecmwf_crop_and_units():
    f = load("ec01_tp24.grb")[0]
    assert f.units == "m"
    assert f.step_range == "0-24"
    c = crop(f, NORD_ITALIA)
    assert c.values.shape == (71, 131)
    assert c.lat0 == pytest.approx(42.0)
    assert c.lon0 == pytest.approx(4.0)
    assert c.lats()[-1] == pytest.approx(49.0)
    mm = get("tp").convert["ecmwf"](c.values)
    assert 0 <= np.nanmax(mm) < 500  # plausibile per 24h


def test_ecmwf_point_matches_eccodes_nearest():
    # valore di riferimento letto con: grib_get -l 45.5,9.2,1 (Milano) = 0.000854492 m
    c = crop(load("ec01_tp24.grb")[0], NORD_ITALIA)
    iy = round((45.5 - c.lat0) / c.dlat)
    ix = round((9.2 - c.lon0) / c.dlon)
    assert c.values[iy, ix] == pytest.approx(0.000854492, abs=1e-6)


def test_crop_other_bbox():
    c = crop(load("ec01_tp24.grb")[0], BBox.parse("44,47,6,12"))
    assert c.values.shape == (31, 61)
    assert (round(c.lat0, 4), round(c.lon0, 4)) == (44.0, 6.0)


def test_crop_across_greenwich():
    f = load("ec01_tp24.grb")[0]
    c = crop(f, BBox.parse("40,50,-5,10"))
    assert c.values.shape == (101, 151)
    assert c.lon0 == pytest.approx(-5.0)
    assert np.all(np.diff(c.lons()) > 0)
    # la colonna a 0° deve coincidere con quella del box che parte a 0°
    ref = crop(f, BBox.parse("40,50,0,10"))
    np.testing.assert_array_equal(c.values[:, 50], ref.values[:, 0])


def test_bbox_validation():
    with pytest.raises(ValueError):
        BBox.parse("49,42,4,17")
    with pytest.raises(ValueError):
        BBox.parse("42,49,4")


# ---------- temperatura a 850 hPa
from app.sources import ecmwf as ecmwf_src  # noqa: E402


def test_t850_gfs_decode_and_convert():
    v = get("t850")
    f = crop(select(load("gfs_t850_f024.grb"), v.selectors["gfs"]), NORD_ITALIA)
    assert f.values.shape == (29, 53) and f.units == "K" and f.step_range == "24"
    c = v.convert["gfs"](f.values)
    # riferimento: grib_get -l 46.17,9.87,1 (Sondrio) = 277.445 K
    iy, ix = round((46.17 - f.lat0) / f.dlat), round((9.87 - f.lon0) / f.dlon)
    assert c[iy, ix] == pytest.approx(277.445 - 273.15, abs=0.01)
    assert -40 < np.nanmin(c) and np.nanmax(c) < 40


def test_t850_ecmwf_decode_and_convert():
    v = get("t850")
    f = crop(select(load("ec_t850_24.grb"), v.selectors["ecmwf"]), NORD_ITALIA)
    assert f.values.shape == (71, 131)
    c = v.convert["ecmwf"](f.values)
    iy, ix = round((46.17 - f.lat0) / f.dlat), round((9.87 - f.lon0) / f.dlon)
    assert c[iy, ix] == pytest.approx(277.055 - 273.15, abs=0.01)


def test_ecmwf_index_matches_level():
    text = (FIX / "ec_pl_sample.index").read_text()
    offset, length = ecmwf_src.find_in_index(text, get("t850"), 24)
    rec = next(r for r in map(__import__("json").loads, text.splitlines()) if r["param"] == "t" and r["levelist"] == "850")
    assert (offset, length) == (rec["_offset"], rec["_length"])
    assert ecmwf_src.base_url(__import__("datetime").datetime(2026, 11, 9), 24, "pl").endswith("-24h-oper-fc-pl")


def test_t850_meta_rank_ascending():
    d = get("t850").as_dict()
    assert d["rank"] == "asc" and d["modes"] == ["value"] and d["units"] == "°C"
    assert get("tp").as_dict()["rank"] == "desc"


# ---------- ICON-CH2 (griglia non strutturata)
from app.sources import icon_ch2  # noqa: E402


def test_icon_horizon_format():
    assert icon_ch2.horizon(3) == "P0DT03H00M00S"
    assert icon_ch2.horizon(24) == "P1DT00H00M00S"
    assert icon_ch2.horizon(120) == "P5DT00H00M00S"
    assert icon_ch2.horizon(27) == "P1DT03H00M00S"


def test_icon_regridder_nearest_and_mask():
    # nuvola di punti irregolare su metà del box: l'altra metà deve risultare fuori dominio
    rng = np.random.default_rng(0)
    lat = rng.uniform(44, 47, 40000)
    lon = rng.uniform(6, 9, 40000)
    vals = lat * 10 + lon  # campo noto e liscio
    box = BBox.parse("44,47,6,12")
    rg = icon_ch2.Regridder.build(lat, lon, box)
    out = rg.apply(vals)
    ny, nx = out.shape
    lats = box.lat_min + np.arange(ny) * rg.dlat
    lons = box.lon_min + np.arange(nx) * rg.dlon
    inside = lons <= 8.9
    outside = lons >= 9.2
    assert np.isfinite(out[5:-5][:, inside][:, 5:]).all()
    assert np.isnan(out[:, outside]).all()
    # il valore riproiettato è quello del punto sorgente più vicino: errore piccolo sul campo liscio
    glon, glat = np.meshgrid(lons, lats)
    interior = (glat > 44.1) & (glat < 46.9) & (glon > 6.1) & (glon < 8.9)
    err = np.abs(out - (glat * 10 + glon))[interior]
    assert np.isfinite(out[interior]).all()
    assert err.max() < 0.25  # vicino più prossimo entro ~0.02° su un gradiente di 10/grado
