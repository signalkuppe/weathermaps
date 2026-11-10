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


# ---------- MeteoSvizzera ICON-CH1/CH2 (griglia non strutturata)
from app.sources import meteoswiss  # noqa: E402


def test_icon_horizon_format():
    assert meteoswiss.horizon(3) == "P0DT03H00M00S"
    assert meteoswiss.horizon(24) == "P1DT00H00M00S"
    assert meteoswiss.horizon(120) == "P5DT00H00M00S"
    assert meteoswiss.horizon(27) == "P1DT03H00M00S"


def test_icon_sources_configured():
    assert meteoswiss.icon_ch2.MODEL.max_step == 120 and meteoswiss.icon_ch1.MODEL.max_step == 33
    assert meteoswiss.icon_ch1.dlat < meteoswiss.icon_ch2.dlat  # CH1 più fine


def test_icon_regridder_nearest_and_mask():
    # nuvola di punti irregolare su metà del box: l'altra metà deve risultare fuori dominio
    rng = np.random.default_rng(0)
    lat = rng.uniform(44, 47, 40000)
    lon = rng.uniform(6, 9, 40000)
    vals = lat * 10 + lon  # campo noto e liscio
    box = BBox.parse("44,47,6,12")
    rg = meteoswiss.Regridder.build(lat, lon, box, 0.02, 0.028)
    out = rg.apply(vals)
    ny, nx = out.shape
    lats = box.lat_min + np.arange(ny) * rg.dlat
    lons = box.lon_min + np.arange(nx) * rg.dlon
    assert np.isnan(out[:, lons >= 9.2]).all()
    glon, glat = np.meshgrid(lons, lats)
    interior = (glat > 44.1) & (glat < 46.9) & (glon > 6.1) & (glon < 8.9)
    assert np.isfinite(out[interior]).all()
    assert np.abs(out - (glat * 10 + glon))[interior].max() < 0.25  # vicino più prossimo entro ~0.02°


# ---------- ICON-D2 e ICON-2I: indirizzi dei file
from datetime import datetime as _dt  # noqa: E402

from app.sources import icon_2i, icon_d2  # noqa: E402


def test_icon_d2_urls():
    run = _dt(2026, 11, 9, 12)
    assert icon_d2.url(run, 24, get("tp")).endswith(
        "/12/tot_prec/icon-d2_germany_regular-lat-lon_single-level_2026110912_024_2d_tot_prec.grib2.bz2")
    assert icon_d2.url(run, 24, get("t850")).endswith(
        "/12/t/icon-d2_germany_regular-lat-lon_pressure-level_2026110912_024_850_t.grib2.bz2")


def test_icon_2i_urls():
    run = _dt(2026, 11, 9, 12)
    assert icon_2i.url(run, get("tp")).endswith("/2026110912/TOT_PREC/ICON_2I_SURFACE_PRESSURE_LEVELS_2026110912_surface-0.grib")
    assert icon_2i.url(run, get("t850")).endswith("/2026110912/T/ICON_2I_SURFACE_PRESSURE_LEVELS_2026110912_isobaricInhPa-850.grib")


# ---------- interpolazione per la media
from app.mean import bilinear  # noqa: E402


def test_bilinear_exact_on_linear_field():
    lats = 42 + np.arange(29) * 0.25
    lons = 4 + np.arange(53) * 0.25
    vals = (lats[:, None] * 2 + lons[None, :] * 3).astype(np.float32)
    grid = {"lat0": 42, "lon0": 4, "dlat": 0.25, "dlon": 0.25}
    tl = np.array([42.0, 45.13, 48.99, 49.2])
    tn = np.array([4.0, 9.87, 16.99, 3.5])
    out = bilinear(vals, grid, tl, tn)
    np.testing.assert_allclose(out[:3, :3], tl[:3, None] * 2 + tn[None, :3] * 3, rtol=1e-5)
    assert np.isnan(out[3]).all() and np.isnan(out[:, 3]).all()  # fuori griglia


# ---------- MeteoHub (WRF, MOLOCH): lettura delle intestazioni GRIB2 senza decodificare i dati
import eccodes  # noqa: E402

from app.sources import meteohub  # noqa: E402


def _grib2(template: int, discipline: int, cat: int, num: int, ftime: int, length: int = 0) -> bytes:
    gid = eccodes.codes_grib_new_from_samples("GRIB2")
    try:
        eccodes.codes_set(gid, "productDefinitionTemplateNumber", template)
        eccodes.codes_set(gid, "discipline", discipline)
        eccodes.codes_set(gid, "parameterCategory", cat)
        eccodes.codes_set(gid, "parameterNumber", num)
        eccodes.codes_set(gid, "indicatorOfUnitOfTimeRange", 1)
        eccodes.codes_set(gid, "forecastTime", ftime)
        if template == 8:
            eccodes.codes_set(gid, "typeOfStatisticalProcessing", 1)
            eccodes.codes_set(gid, "indicatorOfUnitForTimeRange", 1)
            eccodes.codes_set(gid, "lengthOfTimeRange", length)
        return eccodes.codes_get_message(gid)
    finally:
        eccodes.codes_release(gid)


def test_meteohub_header_accumulated_from_start():
    m = meteohub.parse_header(_grib2(8, 0, 1, 8, 0, 24), offset=123)
    assert m.code == (0, 1, 8) and m.accum_from == 0 and m.step == 24 and m.offset == 123


def test_meteohub_header_hourly_bucket_and_instant():
    b = meteohub.parse_header(_grib2(8, 0, 1, 8, 23, 1), offset=0)  # pioggia fra 23 e 24h (MOLOCH)
    assert b.accum_from == 23 and b.step == 24
    t = meteohub.parse_header(_grib2(0, 0, 0, 0, 48), offset=0)  # temperatura istantanea
    assert t.code == (0, 0, 0) and t.accum_from is None and t.step == 48


def test_meteohub_urls_and_selectors():
    run = _dt(2026, 11, 9, 0)
    assert meteohub.wrf.url(run, get("tp")).endswith("/WRF/2026110900/tp/WRF_2026110900_surface-0.grib")
    assert meteohub.wrf.url(run, get("t850")).endswith("/WRF/2026110900/t/WRF_2026110900_isobaricInhPa-850.grib")
    assert not get("tp").selectors["wrf"].hourly_buckets
    assert "moloch" not in get("tp").selectors  # escluso per ora


# ---------- Météo-France AROME: paquets a blocchi di 6 ore
from app.sources import arome as arome_mod  # noqa: E402


def test_arome_urls_and_blocks():
    run = _dt(2026, 11, 10, 3)
    a = arome_mod.arome
    assert a.url(run, get("tp"), 3).endswith(
        "/2026-11-10T03:00:00Z/arome/0025/SP1/arome__0025__SP1__00H06H__2026-11-10T03:00:00Z.grib2")
    assert "/SP1/arome__0025__SP1__49H51H__" in a.url(run, get("tp"), 51)
    assert "arome" not in get("t850").selectors  # solo pioggia
    assert [arome_mod.block(s) for s in (6, 7, 12, 48, 51)] == ["00H06H", "07H12H", "07H12H", "43H48H", "49H51H"]
    with pytest.raises(ValueError):
        arome_mod.block(54)


# ---------- vento: metà risoluzione e rotazione della griglia Lambert (WRF)
from app.grid import Field, halve, lambert_to_earth  # noqa: E402


def test_halve_only_fine_grids():
    fine = Field(values=np.arange(20, dtype=np.float32).reshape(4, 5), lat0=45, lon0=9, dlat=0.02, dlon=0.025)
    h = halve(fine)
    assert h.values.shape == (2, 3) and h.dlat == pytest.approx(0.04) and h.dlon == pytest.approx(0.05)
    assert h.values[1, 2] == fine.values[2, 4] and h.lat0 == 45 and h.lon0 == 9
    coarse = Field(values=np.zeros((4, 5), np.float32), lat0=45, lon0=9, dlat=0.1, dlon=0.1)
    assert halve(coarse) is coarse  # ECMWF e GFS restano come sono


def test_lambert_rotation_keeps_speed_and_turns_east_of_central_meridian():
    u, v = np.array([10.0, 10.0]), np.array([0.0, 0.0])
    ue, ve = lambert_to_earth(u, v, np.array([11.0, 17.0]), 11.0, 43.42, 37.21)
    assert ue[0] == pytest.approx(10) and ve[0] == pytest.approx(0)  # sul meridiano centrale: nessuna rotazione
    assert np.hypot(ue[1], ve[1]) == pytest.approx(10)  # la velocità non cambia
    assert ve[1] < 0  # a est il "verso est" della griglia punta un po' a sud del vero est
