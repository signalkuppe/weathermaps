from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import variables
from app.config import BBox
from app.grid import Field
from app.main import create_app
from app.store import Store

RUN = "2026110900"
BOX = BBox.parse("42,49,4,17")


def _field(value: float) -> Field:
    return Field(values=np.full((3, 4), value, dtype=np.float32), lat0=42, lon0=4, dlat=0.25, dlon=0.25)


@pytest.fixture
def client(tmp_path: Path):
    store = Store(data_dir=tmp_path, bbox=BOX)
    store.save("gfs", RUN, "tp", 3, _field(1.0))
    store.save("gfs", RUN, "tp", 6, _field(2.5))
    store.save("gfs", RUN, "tp", 9, _field(2.0))  # totale che "cala": l'intervallo va a 0
    app = create_app(store=store, start_scheduler=False)
    with TestClient(app) as c:
        yield c


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}


def test_meta(client):
    m = client.get("/api/meta").json()
    assert m["bbox"] == {"lat_min": 42, "lat_max": 49, "lon_min": 4, "lon_max": 17}
    assert m["steps"][:3] == [3, 6, 9] and m["steps"][-1] == 192 and len(m["steps"]) == 56
    assert {x["id"] for x in m["models"]} == {"gfs", "ecmwf", "icon-2i", "wrf", "icon-d2", "arome", "icon-ch2", "icon-ch1", "mean"}
    assert "mean" in next(v for v in m["variables"] if v["id"] == "tp")["models"]
    assert next(x for x in m["models"] if x["id"] == "icon-ch2")["max_step"] == 120
    tp = next(v for v in m["variables"] if v["id"] == "tp")
    assert tp["modes"] == ["total", "interval"]
    assert len(tp["scale"]["thresholds"]) == len(tp["scale"]["colors"])


def test_runs(client):
    r = client.get("/api/runs").json()
    assert r["ecmwf"] == []
    assert r["gfs"] == []  # nessuna grandezza completa: non c'è una corsa da mostrare


def _fill(store: Store, model: str, rid: str, var_ids=None):
    from app.fetcher import steps_for

    for var in variables.REGISTRY.values():
        if model in var.selectors and (var_ids is None or var.id in var_ids):
            for s in steps_for(var, model):
                store.save(model, rid, var.id, s, _field(1.0))


def test_runs_only_latest_complete_and_incoming(tmp_path: Path):
    from app.fetcher import runs_to_keep

    store = Store(data_dir=tmp_path, bbox=BOX)
    old, new, newer = "2026110900", "2026110906", "2026110912"
    _fill(store, "gfs", old)
    _fill(store, "gfs", new)
    store.save("gfs", newer, "tp", 3, _field(1.0))  # corsa nuova appena iniziata
    with TestClient(create_app(store=store, start_scheduler=False)) as c:
        r = c.get("/api/runs").json()["gfs"]
    assert [x["run"] for x in r] == [new, newer]
    assert "incoming" not in r[0] and r[1]["incoming"] is True
    assert r[1]["variables"]["tp"]["steps"] == [3] and r[1]["variables"]["tp"]["expected"] == 56
    # pulizia: restano la completa più recente e quella in arrivo
    assert runs_to_keep(store, "gfs", [newer, new]) == {new, newer}
    assert store.purge_superseded("gfs", {new, newer}) == [old]


def test_latest_complete_falls_back_and_keeps_all_without_complete(tmp_path: Path):
    from app.fetcher import latest_complete, runs_to_keep

    store = Store(data_dir=tmp_path, bbox=BOX)
    # una grandezza che non arriva mai (solo tp completa): il modello si mostra lo stesso
    _fill(store, "gfs", "2026110906", var_ids={"tp"})
    assert latest_complete(store, "gfs") == "2026110906"
    # niente di completo: non si cancella nulla
    store2 = Store(data_dir=tmp_path / "b", bbox=BOX)
    store2.save("gfs", "2026110900", "tp", 3, _field(1.0))
    store2.save("gfs", "2026110812", "tp", 3, _field(1.0))
    assert runs_to_keep(store2, "gfs", ["2026110906", "2026110900"]) == {"2026110900", "2026110812"}


def test_plus_selectors_are_summed():
    from datetime import datetime, timezone
    from types import SimpleNamespace

    from app.fetcher import _fetch_field

    var = variables.get("sf")
    seen = []

    def fetch(client, run, step, v, bbox):
        sel = v.selectors["icon-d2"]
        seen.append(sel.param)
        return _field(2.0 if sel.param == "snow_gsp" else 0.5)

    source = SimpleNamespace(MODEL=SimpleNamespace(id="icon-d2"), fetch=fetch)
    f = _fetch_field(source, None, datetime(2026, 11, 10, tzinfo=timezone.utc), 3, var, BOX)
    assert seen == ["snow_gsp", "snow_con"]
    assert f.values.tolist() == [[2.5] * 4] * 3


def test_field_total_and_interval(client):
    t = client.get("/api/field", params={"model": "gfs", "run": RUN, "step": 6, "mode": "total"}).json()
    assert t["values"] == [2.5] * 12
    assert t["grid"]["nx"] == 4 and t["grid"]["ny"] == 3
    assert t["valid_time"].startswith("2026-11-09T06:00")
    i = client.get("/api/field", params={"model": "gfs", "run": RUN, "step": 6, "mode": "interval"}).json()
    assert i["values"] == [1.5] * 12 and i["prev_step"] == 3
    first = client.get("/api/field", params={"model": "gfs", "run": RUN, "step": 3, "mode": "interval"}).json()
    assert first["values"] == [1.0] * 12 and first["prev_step"] == 0
    neg = client.get("/api/field", params={"model": "gfs", "run": RUN, "step": 9, "mode": "interval"}).json()
    assert neg["values"] == [0.0] * 12


def test_field_errors(client):
    base = {"model": "gfs", "run": RUN}
    assert client.get("/api/field", params={**base, "step": 12}).status_code == 404
    assert client.get("/api/field", params={**base, "step": 6, "var": "nope"}).status_code == 400
    assert client.get("/api/field", params={**base, "step": 7}).status_code == 400
    assert client.get("/api/field", params={**base, "step": 6, "mode": "boh"}).status_code == 400
    assert client.get("/api/field", params={"model": "x", "run": RUN, "step": 6}).status_code == 400


def test_new_variable_appears_without_other_changes(client):
    t2m = variables.Variable(
        id="t2m",
        label="Temperatura 2 m",
        units="°C",
        kind="instant",
        selectors={"gfs": variables.GribSelector(var="TMP", level="2_m_above_ground", short_name="2t")},
        convert={"gfs": lambda k: k - 273.15},
        scale=variables.ColorScale(thresholds=[-10, 0, 10, 20], colors=["#00f", "#0ff", "#ff0", "#f00"]),
    )
    variables.register(t2m)
    try:
        m = client.get("/api/meta").json()
        v = next(x for x in m["variables"] if x["id"] == "t2m")
        assert v["modes"] == ["value"] and v["models"] == ["gfs"]
        client.app.state.store.save("gfs", RUN, "t2m", 3, _field(12.0))
        f = client.get("/api/field", params={"model": "gfs", "run": RUN, "step": 3, "var": "t2m"}).json()
        assert f["mode"] == "value" and f["values"][0] == 12.0
        bad = client.get("/api/field", params={"model": "gfs", "run": RUN, "step": 3, "var": "t2m", "mode": "interval"})
        assert bad.status_code == 400
    finally:
        variables.REGISTRY.pop("t2m")


def test_store_namespaced_by_bbox(tmp_path):
    a = Store(data_dir=tmp_path, bbox=BOX)
    a.save("gfs", RUN, "tp", 3, _field(1.0))
    b = Store(data_dir=tmp_path, bbox=BBox.parse("40,50,0,20"))
    assert b.runs("gfs") == []
    assert b.purge_other_bboxes() == [BOX.key]
    assert not (tmp_path / BOX.key).exists()


def test_purge_keeps_latest(tmp_path):
    s = Store(data_dir=tmp_path, bbox=BOX)
    for run in ["2026110800", "2026110806", "2026110812", "2026110818"]:
        s.save("gfs", run, "tp", 3, _field(1.0))
    assert s.purge("gfs", 3) == ["2026110800"]
    assert s.runs("gfs") == ["2026110818", "2026110812", "2026110806"]


def test_initial_view_default_and_clipping(client, monkeypatch):
    from app.config import get_initial_view

    v = client.get("/api/meta").json()["initial_view"]
    assert v == {"lat_min": 44.68, "lat_max": 46.64, "lon_min": 8.5, "lon_max": 11.43}
    monkeypatch.setenv("INITIAL_VIEW", "40,46,2,10")  # sborda dal box: viene ritagliata
    assert get_initial_view(BOX).as_dict() == {"lat_min": 42, "lat_max": 46, "lon_min": 4, "lon_max": 10}
    monkeypatch.setenv("INITIAL_VIEW", "30,35,20,25")  # fuori dal box: si usa il box intero
    assert get_initial_view(BOX) == BOX


def test_refresh_starts_once_then_cooldown(client, monkeypatch):
    import threading
    import time

    from app import fetcher

    calls = []
    done = threading.Event()

    def fake_update(model_id, store):
        st = fetcher.STATUS[model_id]
        st.update(running=True, started=time.time(), downloaded=0)
        calls.append(model_id)
        st.update(running=False, finished=time.time(), downloaded=2)
        done.set()

    monkeypatch.setattr(fetcher, "update_model", fake_update)
    monkeypatch.setitem(fetcher.STATUS, "gfs", {"running": False, "started": None, "finished": None, "downloaded": 0, "errors": 0})

    r = client.post("/api/refresh", params={"model": "gfs"}).json()
    assert r["accepted"] is True and r["reason"] == "started"
    assert done.wait(2)
    st = client.get("/api/refresh", params={"model": "gfs"}).json()
    assert st["running"] is False and st["downloaded"] == 2
    again = client.post("/api/refresh", params={"model": "gfs"}).json()
    assert again["accepted"] is False and again["reason"] == "cooldown"
    assert calls == ["gfs"]
    assert client.post("/api/refresh", params={"model": "nope"}).status_code == 400



def test_mean_aligns_runs_and_keeps_total_interval_consistent(tmp_path):
    """Due modelli partiti a ore diverse, su griglie diverse: la media va per istante di validità."""
    from app import mean
    from app.fetcher import steps_for

    store = Store(data_dir=tmp_path, bbox=BOX)
    tp = variables.get("tp")
    # modello A (gfs): corsa 06Z, 1 mm/h ovunque -> totale = ore dall'inizio
    for s in steps_for(tp, "gfs"):
        store.save("gfs", "2026110906", "tp", s,
                   Field(values=np.full((29, 53), float(s), np.float32), lat0=42, lon0=4, dlat=0.25, dlon=0.25))
    # modello B (ecmwf): corsa 00Z, 3 mm/h ovunque, griglia diversa
    for s in steps_for(tp, "ecmwf"):
        store.save("ecmwf", "2026110900", "tp", s,
                   Field(values=np.full((71, 131), 3.0 * s, np.float32), lat0=42, lon0=4, dlat=0.1, dlon=0.1))
    summary = mean.build_mean(store)
    assert "tp" in summary
    # T0 = corsa più recente (06Z), già allineata alle 6 ore
    assert store.runs("mean") == ["2026110906"]
    v24, grid = store.load("mean", "2026110906", "tp", 24)
    v21, _ = store.load("mean", "2026110906", "tp", 21)
    # da T0: A ha 24 mm in 24h, B 72 mm -> media 48; intervallo 21-24: (3 + 9) / 2 = 6
    assert np.nanmean(v24) == pytest.approx(48, abs=0.01)
    assert np.nanmean(v24 - v21) == pytest.approx(6, abs=0.01)
    info = mean.members_info(store, "2026110906", "tp")
    assert info["members"] == {"gfs": "2026110906", "ecmwf": "2026110900"}
    assert info["steps"]["24"] == ["gfs", "ecmwf"]
    # ricalcolo con ingressi invariati: saltato
    assert mean.build_mean(store)["tp"] == "invariata"

    app = create_app(store=store, start_scheduler=False)
    with TestClient(app) as c:
        runs = c.get("/api/runs").json()["mean"][0]
        assert runs["variables"]["tp"]["complete"] is True and set(runs["variables"]["tp"]["members"]) == {"gfs", "ecmwf"}
        f = c.get("/api/field", params={"model": "mean", "run": "2026110906", "step": 24, "mode": "interval"}).json()
        assert f["members"] == ["gfs", "ecmwf"] and f["max"] == pytest.approx(6, abs=0.1)
        assert c.post("/api/refresh", params={"model": "mean"}).status_code == 400


def test_mean_model_started_after_t0_joins_from_its_first_steps(tmp_path):
    """Si tiene solo l'ultima corsa di ogni modello: uno partito dopo T0 entra dai suoi primi passi."""
    from app import mean
    from app.fetcher import steps_for

    store = Store(data_dir=tmp_path, bbox=BOX)
    tp = variables.get("tp")
    for s in steps_for(tp, "gfs"):  # corsa 06Z
        store.save("gfs", "2026110906", "tp", s, Field(values=np.full((29, 53), float(s), np.float32), lat0=42, lon0=4, dlat=0.25, dlon=0.25))
    for s in steps_for(tp, "icon-d2"):  # corsa 09Z, dopo T0 = 06Z
        store.save("icon-d2", "2026110909", "tp", s, Field(values=np.full((29, 53), float(s), np.float32), lat0=42, lon0=4, dlat=0.25, dlon=0.25))
    mean.build_mean(store)
    assert store.runs("mean") == ["2026110906"]
    info = mean.members_info(store, "2026110906", "tp")
    assert info["members"] == {"gfs": "2026110906", "icon-d2": "2026110909"}
    assert info["steps"]["3"] == ["gfs"]  # 06-09Z: ICON-D2 non era ancora partito
    assert info["steps"]["6"] == ["gfs", "icon-d2"]


def test_mean_model_uses_median_not_mean(tmp_path):
    """Con tre modelli un valore isolato non sposta il risultato: 1, 2 e 30 mm/h -> mediana 2 (la media sarebbe 11)."""
    from app import mean
    from app.fetcher import steps_for

    store = Store(data_dir=tmp_path, bbox=BOX)
    tp = variables.get("tp")
    for model, rate in (("gfs", 1.0), ("ecmwf", 2.0), ("icon-2i", 30.0)):
        for s in steps_for(tp, model):
            store.save(model, "2026110900", "tp", s,
                       Field(values=np.full((29, 53), rate * s, np.float32), lat0=42, lon0=4, dlat=0.25, dlon=0.25))
    mean.build_mean(store)
    v24, _ = store.load("mean", "2026110900", "tp", 24)
    assert np.nanmax(v24) == pytest.approx(48, abs=0.01)
    assert np.nanmin(v24) == pytest.approx(48, abs=0.01)


def test_meta_combo_precip_and_freezing_level(client):
    """Voce combinata: colori della pioggia e linee dello zero termico, solo per i modelli che hanno entrambi."""
    vs = client.get("/api/meta").json()["variables"]
    ids = [v["id"] for v in vs]
    assert ids.index("tp_hzero") == ids.index("tp") + 1
    combo = vs[ids.index("tp_hzero")]
    assert combo["field"] == "tp" and combo["contour_field"] == "hzero" and combo["units"] == "mm"
    assert combo["modes"] == ["total", "interval"]
    assert set(combo["models"]) == {"gfs", "icon-2i", "icon-d2", "icon-ch2", "icon-ch1", "mean"}


def test_version_from_git_describe(monkeypatch):
    from app.config import get_version, parse_describe

    assert parse_describe("v1.2.0-0-gabc1234\n") == "v1.2.0"
    assert parse_describe("v1.2.0-3-gabc1234") == "v1.2.0+3"
    assert parse_describe("release-2026-1-gabc1234") == "release-2026+1"  # trattini nel nome del tag
    monkeypatch.setenv("APP_VERSION", "v9.9.9")
    get_version.cache_clear()
    try:
        assert get_version() == "v9.9.9"
    finally:
        get_version.cache_clear()


def test_meta_has_version(client):
    assert isinstance(client.get("/api/meta").json()["version"], str)
