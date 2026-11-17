"""Observed soundings (app/soundings.py): reading the Wyoming page, launches to look for, storage and API."""
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app import soundings
from app.config import BBox
from app.main import create_app
from app.store import Store

BOX = BBox.parse("42,49,4,17")

PAGE = """<html><body><h2>Observations for Station 16064 at 12 UTC 16 Nov 2026</h2><pre>
-----------------------------------------------------------------------------
   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SPED   THTA   THTE   THTV
    hPa      m      C      C      %   g/kg    deg    m/s      K      K      K
-----------------------------------------------------------------------------
  996.0    178    5.0    4.4     96   5.26      0    0.0  278.5  293.0  279.4
  925.0    781    3.8    1.8     87   4.71    235    0.5  283.2  296.5  284.0
  850.0   1465    1.0   -0.8     88   4.24    195    2.1  287.2  299.5  287.9
  700.0   3011   -3.7   -8.7     68   2.83    240   13.9  298.4  307.1  298.9
  500.0   5720  -20.1  -30.1     40   0.50    250   20.0  310.0  311.0  310.1
   50.0  20000  -60.0  -80.0      1   0.01    260   10.0  400.0  400.0  400.0
</pre><h3>Station information</h3></body></html>"""


def test_table_parsing():
    lv = soundings.parse(PAGE)
    assert len(lv) == 5  # the 50 hPa level (above 100) is discarded
    assert lv[0] == [996.0, 178.0, 5.0, 4.4, 0.0, 0.0]
    assert lv[3] == [700.0, 3011.0, -3.7, -8.7, 240.0, 50.0]  # 13.9 m/s -> 50 km/h
    assert soundings.parse("<html>nessun dato</html>") == []


def test_launches_to_look_for():
    # at 15 UTC the 12 UTC data are surely not there yet (about 1h30 after the launch): start from 12
    got = soundings.launches(datetime(2026, 11, 16, 15, tzinfo=timezone.utc))
    assert [t.strftime("%d%H") for t in got] == ["1612", "1600", "1512"]
    got = soundings.launches(datetime(2026, 11, 16, 13, tzinfo=timezone.utc))  # 12 UTC still too early
    assert got[0].strftime("%d%H") == "1600"


def test_index_and_api(tmp_path: Path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    d = tmp_path / BOX.key / "soundings" / "16064"
    d.mkdir(parents=True)
    body = {"station": "16064", "time": "2026111612", "levels": soundings.parse(PAGE)}
    (d / "2026111612.json").write_text(json.dumps(body))
    (d / "2026111600.none").write_text("")  # launch that will not arrive: not in the index
    st = next(s for s in soundings.index(store) if s["id"] == "16064")
    assert st["times"] == ["2026111612"] and st["name"] == "Novara Cameri"
    with TestClient(create_app(store=store, start_scheduler=False)) as c:
        assert c.get("/api/soundings").json()[0]["id"] == "16064"
        r = c.get("/api/sounding", params={"station": "16064", "time": "2026111612"})
        assert r.json()["levels"][0][0] == 996.0
        assert c.get("/api/sounding", params={"station": "16064", "time": "2026111600"}).status_code == 404
        assert c.get("/api/sounding", params={"station": "../x", "time": "2026111612"}).status_code == 404


def test_missing_launch_and_busy_service(monkeypatch):
    import httpx
    monkeypatch.setattr(soundings.time, "sleep", lambda s: None)
    codes = iter([503] * soundings.TRIES)
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(next(codes))))
    assert soundings._get(client, {}) is None  # always busy: retried at the next round
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(404)))
    assert soundings._get(client, {}) == ""  # launch the service does not have: counted as missing
