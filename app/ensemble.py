"""GFS and ECMWF ensembles: the "spaghetti" plots of a place on the synoptic chart.

Temperature at 850 hPa and 6-hourly precipitation, one value per member, only over our area (BBOX): GFS for all four
runs (00, 06, 12, 18 UTC), ECMWF for the 00 and 12 UTC runs (its 06/18 runs stop at +144h). They are stored in the Store as extra models (not in the model menu), with fields
"t850.<member>" and "tp.<member>"; the latest complete run is kept (plus the incoming one).

- GFS (GEFS 0.5°, NOAA open data on AWS, noaa-gefs-pds): control c00 and 30 members p01...p30, up to +384h. One file
  per member and step: the .idx index is read and then only the two fields. Precipitation is already in 6-hour
  intervals (0-6, 6-12...). The 0.25° ensemble has no temperature at 850 hPa.
- ECMWF (ENS 0.25°, ECMWF open data): 50 perturbed members (the control is not in the open data), up to +360h. One
  file per step with all members: the index is read and then, for each field, the block of the 50 members (they are
  one after the other). Precipitation is accumulated since the start of the run, in metres: in the points for the
  page it becomes 6-hourly (difference between steps).

With each ensemble run the operational run of the same cycle (the deterministic GFS 0.25° or ECMWF IFS 0.25°) is
downloaded too, only the same two fields and over the whole range (the maps stop at +192h): stored as the extra member
"op" (fields "t850.op", "tp.op"), on its own grid, and read at the cell nearest to the requested location,
independently of the ensemble grid. Static exports include separate operational point files. It is not needed for a
run to be complete: if it is missing the spaghetti are drawn without it.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from typing import Callable

import httpx
import numpy as np

from .grid import Field, crop, decode_grib
from .sources import ModelInfo, NotAvailable, make_client, run_id
from .store import Store

log = logging.getLogger("weathermaps.ensemble")

VARS = ("t850", "tp")
RETRIES = 3
DECIMALS = 1


@dataclass(frozen=True)
class Source:
    model: str  # the page's model (flag, chart selector): "gfs" or "ecmwf"
    store_id: str  # "model" in the Store
    label: str
    members: tuple[str, ...]
    steps: tuple[int, ...]
    info: ModelInfo  # runs and delay (candidate_runs)
    control: str | None  # control member, drawn separately
    tp_cumulative: bool  # precipitation accumulated since the start: differences are taken in the points
    download: Callable  # (client, run, rid, store, source) -> (downloaded, errors)
    op_download: Callable | None = None  # operational run of the same cycle, as the member OP


OP = "op"  # member name of the operational run


def _get(client: httpx.Client, url: str, **kw) -> httpx.Response:
    """GET with a few retries on transient network errors (closed connections, DNS)."""
    for attempt in range(RETRIES):
        try:
            return client.get(url, **kw)
        except httpx.TransportError:
            if attempt == RETRIES - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise AssertionError("irraggiungibile")


def _var(var: str, member: str) -> str:
    return f"{var}.{member}"


def _field(data: bytes, var: str, store: Store) -> Field:
    if not data.startswith(b"GRIB"):
        raise ValueError("risposta inattesa (non GRIB)")
    f = crop(decode_grib(data)[0], store.bbox)
    values = f.values - 273.15 if var == "t850" else np.maximum(f.values, 0)
    f.values = np.asarray(values, dtype=np.float32)
    return f


# ---------- GFS: GEFS 0.5°, one file per member and step

GEFS_ROOT = "https://noaa-gefs-pds.s3.amazonaws.com"
GEFS_WORKERS = 12  # members downloaded together: with all 31 the home network dropped connections


def gefs_url(run: datetime, member: str, step: int) -> str:
    hh = f"{run.hour:02d}"
    return f"{GEFS_ROOT}/gefs.{run:%Y%m%d}/{hh}/atmos/pgrb2ap5/ge{member}.t{hh}z.pgrb2a.0p50.f{step:03d}"


def gefs_ranges(index_text: str, step: int) -> dict[str, tuple[int, int | None]]:
    """Byte ranges (start, inclusive end or None = to the end) of the two fields in the wgrib2 index."""
    lines = [ln.split(":") for ln in index_text.splitlines() if ln.strip()]
    out: dict[str, tuple[int, int | None]] = {}
    for i, parts in enumerate(lines):
        name, level = parts[3], parts[4]
        if name == "TMP" and level == "850 mb":
            var = "t850"
        elif name == "APCP" and level == "surface" and parts[5] == f"{step - 6}-{step} hour acc fcst":
            var = "tp"
        else:
            continue
        end = int(lines[i + 1][1]) - 1 if i + 1 < len(lines) else None
        out[var] = (int(parts[1]), end)
    missing = set(VARS) - set(out)
    if missing:
        raise LookupError(f"GEFS +{step}h: mancano {sorted(missing)} nell'indice")
    return out


def _gefs_download(client: httpx.Client, run: datetime, rid: str, store: Store, src: Source) -> tuple[int, int]:
    def member_job(member: str) -> tuple[int, int]:
        got = errors = 0
        for step in src.steps:
            if all(store.has(src.store_id, rid, _var(v, member), step) for v in VARS):
                continue
            try:
                base = gefs_url(run, member, step)
                idx = _get(client, base + ".idx")
                if idx.status_code in (403, 404):  # S3 answers 403 for files that are not there (yet)
                    break  # steps come out in order
                idx.raise_for_status()
                fields = {}
                for var, (a, b) in gefs_ranges(idx.text, step).items():
                    resp = _get(client, base, headers={"Range": f"bytes={a}-{'' if b is None else b}"})
                    resp.raise_for_status()
                    fields[var] = _field(resp.content, var, store)
            except Exception as exc:  # noqa: BLE001
                log.error("GEFS %s %s +%dh: %s", rid, member, step, exc)
                errors += 1
                break
            for v, f in fields.items():
                store.save(src.store_id, rid, _var(v, member), step, f)
            got += 1
        return got, errors

    got = errors = 0
    with ThreadPoolExecutor(max_workers=GEFS_WORKERS) as pool:
        for g, e in pool.map(member_job, src.members):
            got, errors = got + g, errors + e
    return got, errors


# ---------- GFS operational run: 0.25°, one file per step (NOAA open data on AWS, noaa-gfs-bdp-pds)

GFS_OP_ROOT = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
OP_WORKERS = 8  # steps downloaded together


def gfs_op_url(run: datetime, step: int) -> str:
    hh = f"{run.hour:02d}"
    return f"{GFS_OP_ROOT}/gfs.{run:%Y%m%d}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{step:03d}"


def _gfs_op_download(client: httpx.Client, run: datetime, rid: str, store: Store, src: Source) -> tuple[int, int]:
    """Same index format as GEFS: TMP 850 mb and the APCP bucket of the last 6 hours (at steps multiple of 6 the
    bucket is always 6 hours long, also beyond +240h)."""
    def step_job(step: int) -> tuple[int, int]:
        if all(store.has(src.store_id, rid, _var(v, OP), step) for v in VARS):
            return 0, 0
        try:
            base = gfs_op_url(run, step)
            idx = _get(client, base + ".idx")
            if idx.status_code in (403, 404):
                return 0, 0  # not published yet
            idx.raise_for_status()
            fields = {}
            for var, (a, b) in gefs_ranges(idx.text, step).items():
                resp = _get(client, base, headers={"Range": f"bytes={a}-{'' if b is None else b}"})
                resp.raise_for_status()
                fields[var] = _field(resp.content, var, store)
        except Exception as exc:  # noqa: BLE001
            log.error("GFS op %s +%dh: %s", rid, step, exc)
            return 0, 1
        for v, f in fields.items():
            store.save(src.store_id, rid, _var(v, OP), step, f)
        return 1, 0

    return _pool(step_job, src.steps)


def _pool(job: Callable, steps) -> tuple[int, int]:
    got = errors = 0
    with ThreadPoolExecutor(max_workers=OP_WORKERS) as pool:
        for g, e in pool.map(job, steps):
            got, errors = got + g, errors + e
    return got, errors


# ---------- ECMWF: ENS 0.25°, one file per step with all members

ECENS_ROOT = "https://data.ecmwf.int/forecasts"
ECENS_WORKERS = 4  # steps downloaded together (each step is two blocks of ~15 MB)


def ecens_url(run: datetime, step: int) -> str:
    return f"{ECENS_ROOT}/{run:%Y%m%d}/{run.hour:02d}z/ifs/0p25/enfo/{run:%Y%m%d%H}0000-{step}h-enfo-ef"


def ecens_records(index_text: str, members: tuple[str, ...]) -> dict[str, dict[str, tuple[int, int]]]:
    """{field: {member: (offset, length)}} from the JSON index of the ECMWF open data."""
    out: dict[str, dict[str, tuple[int, int]]] = {v: {} for v in VARS}
    for line in index_text.splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("type") != "pf":
            continue
        if r.get("param") == "t" and str(r.get("levelist")) == "850":
            var = "t850"
        elif r.get("param") == "tp" and r.get("levtype") == "sfc":
            var = "tp"
        else:
            continue
        out[var][f"{int(r['number']):02d}"] = (int(r["_offset"]), int(r["_length"]))
    for var, recs in out.items():
        missing = set(members) - set(recs)
        if missing:
            raise LookupError(f"ENS: mancano {len(missing)} membri di {var} nell'indice")
    return out


def _blocks(recs: dict[str, tuple[int, int]]) -> list[tuple[int, int, list[str]]]:
    """Members close together in the file merged into blocks read with a single request: (start, inclusive end, members)."""
    out: list[tuple[int, int, list[str]]] = []
    for m, (off, length) in sorted(recs.items(), key=lambda kv: kv[1][0]):
        if out and off == out[-1][1] + 1:
            out[-1] = (out[-1][0], off + length - 1, out[-1][2] + [m])
        else:
            out.append((off, off + length - 1, [m]))
    return out


def _ecens_download(client: httpx.Client, run: datetime, rid: str, store: Store, src: Source) -> tuple[int, int]:
    def step_job(step: int) -> tuple[int, int]:
        if all(store.has(src.store_id, rid, _var(v, m), step) for v in VARS for m in src.members):
            return 0, 0
        try:
            base = ecens_url(run, step)
            idx = _get(client, base + ".index")
            if idx.status_code == 404:
                return 0, 0  # step not published yet
            idx.raise_for_status()
            records = ecens_records(idx.text, src.members)
            fields: list[tuple[str, str, Field]] = []
            for var, recs in records.items():
                for a, b, members in _blocks({m: recs[m] for m in src.members}):
                    resp = _get(client, base + ".grib2", headers={"Range": f"bytes={a}-{b}"})
                    resp.raise_for_status()
                    for m in members:
                        off, length = recs[m]
                        fields.append((var, m, _field(resp.content[off - a: off - a + length], var, store)))
        except Exception as exc:  # noqa: BLE001
            log.error("ENS %s +%dh: %s", rid, step, exc)
            return 0, 1
        for var, m, f in fields:
            if var == "tp":
                f.values = f.values * 1000.0  # metres -> mm
            store.save(src.store_id, rid, _var(var, m), step, f)
        return 1, 0

    got = errors = 0
    with ThreadPoolExecutor(max_workers=ECENS_WORKERS) as pool:
        for g, e in pool.map(step_job, src.steps):
            got, errors = got + g, errors + e
    return got, errors


# ---------- ECMWF operational run (IFS 0.25°, "oper" stream of the open data): up to +360h for the 00/12 runs

def ecmwf_op_url(run: datetime, step: int) -> str:
    return f"{ECENS_ROOT}/{run:%Y%m%d}/{run.hour:02d}z/ifs/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc"


def ecmwf_op_records(index_text: str) -> dict[str, tuple[int, int]]:
    """{field: (offset, length)} of t at 850 hPa and tp from the JSON index of the operational run."""
    out = {}
    for line in index_text.splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("param") == "t" and str(r.get("levelist")) == "850":
            out["t850"] = (int(r["_offset"]), int(r["_length"]))
        elif r.get("param") == "tp" and r.get("levtype") == "sfc":
            out["tp"] = (int(r["_offset"]), int(r["_length"]))
    missing = set(VARS) - set(out)
    if missing:
        raise LookupError(f"ECMWF op: {sorted(missing)} missing from the index")
    return out


def _ecmwf_op_download(client: httpx.Client, run: datetime, rid: str, store: Store, src: Source) -> tuple[int, int]:
    def step_job(step: int) -> tuple[int, int]:
        if all(store.has(src.store_id, rid, _var(v, OP), step) for v in VARS):
            return 0, 0
        try:
            base = ecmwf_op_url(run, step)
            idx = _get(client, base + ".index")
            if idx.status_code == 404:
                return 0, 0  # not published yet
            idx.raise_for_status()
            fields = {}
            for var, (off, length) in ecmwf_op_records(idx.text).items():
                resp = _get(client, base + ".grib2", headers={"Range": f"bytes={off}-{off + length - 1}"})
                resp.raise_for_status()
                fields[var] = _field(resp.content, var, store)
        except Exception as exc:  # noqa: BLE001
            log.error("ECMWF op %s +%dh: %s", rid, step, exc)
            return 0, 1
        for var, f in fields.items():
            if var == "tp":
                f.values = f.values * 1000.0  # metres -> mm (accumulated since the start, like the members)
            store.save(src.store_id, rid, _var(var, OP), step, f)
        return 1, 0

    return _pool(step_job, src.steps)


SOURCES: dict[str, Source] = {
    "gfs": Source(
        model="gfs", store_id="gefs", label="Ensemble GFS 0,5°",
        members=("c00",) + tuple(f"p{i:02d}" for i in range(1, 31)), steps=tuple(range(6, 385, 6)),
        info=ModelInfo(id="gefs", label="GEFS", resolution=0.5, cycles=(0, 6, 12, 18), delay_hours=6, max_step=384),
        control="c00", tp_cumulative=False, download=_gefs_download, op_download=_gfs_op_download,
    ),
    "ecmwf": Source(
        model="ecmwf", store_id="ecens", label="Ensemble ECMWF 0,25°",
        members=tuple(f"{i:02d}" for i in range(1, 51)), steps=tuple(range(6, 361, 6)),
        info=ModelInfo(id="ecens", label="ENS", resolution=0.25, cycles=(0, 12), delay_hours=8, max_step=360),  # 06/18: +144h only
        control=None, tp_cumulative=True, download=_ecens_download, op_download=_ecmwf_op_download,
    ),
}
STORE_IDS = {s.store_id: s for s in SOURCES.values()}
_locks = {k: threading.Lock() for k in SOURCES}


def is_complete(store: Store, src: Source, rid: str) -> bool:
    return all(set(src.steps) <= set(store.steps(src.store_id, rid, _var(v, m))) for v in VARS for m in src.members)


def latest_complete(store: Store, src: Source) -> str | None:
    return next((rid for rid in store.runs(src.store_id) if is_complete(store, src, rid)), None)


def update(model: str, store: Store | None = None, now: datetime | None = None) -> dict:
    """Downloads what is missing from the latest ensemble runs of `model` ("gfs" or "ecmwf"). Idempotent."""
    src = SOURCES[model]
    if not _locks[model].acquire(blocking=False):
        return {"model": src.store_id, "skipped": True}
    store = store or Store()
    summary = {"model": src.store_id, "downloaded": 0, "errors": 0, "runs": {}}
    try:
        candidates = src.info.candidate_runs(now, count=2)
        with make_client() as client:
            for run in candidates:
                rid = run_id(run)
                # a newer complete run already exists: this one is not needed
                if any(r > rid and is_complete(store, src, r) for r in store.runs(src.store_id)):
                    continue
                got, errors = src.download(client, run, rid, store, src)
                if src.op_download:  # operational run of the same cycle (optional for completeness)
                    g, e = src.op_download(client, run, rid, store, src)
                    got, errors = got + g, errors + e
                summary["downloaded"] += got
                summary["errors"] += errors
                summary["runs"][rid] = "completa" if is_complete(store, src, rid) else "in arrivo"
        current = latest_complete(store, src)
        keep = set(store.runs(src.store_id)) if current is None else {current} | {
            run_id(r) for r in candidates if run_id(r) > current}
        store.purge_superseded(src.store_id, keep)
        if summary["downloaded"]:
            log.info("%s: %s", src.label, summary)
        return summary
    finally:
        _locks[model].release()


def update_all(store: Store | None = None) -> list[dict]:
    store = store or Store()
    return [update(m, store) for m in SOURCES]


# ---------- points for the page


def _grid(store: Store, src: Source, rid: str) -> dict:
    return store.load(src.store_id, rid, _var("t850", src.members[0]), src.steps[0])[1]


def _op_grid(store: Store, src: Source, rid: str) -> dict | None:
    grid = None
    for var in VARS:
        steps = store.steps(src.store_id, rid, _var(var, OP))
        if not steps:
            return None
        if var == "t850":
            grid = store.load(src.store_id, rid, _var(var, OP), steps[0])[1]
    return grid


def info(store: Store) -> dict:
    """For /api/meta: for each model with the ensemble ready, run, members and point grid."""
    out = {}
    for model, src in SOURCES.items():
        rid = latest_complete(store, src)
        if rid:
            out[model] = {"run": rid, "label": src.label, "members": list(src.members), "control": src.control,
                          "steps": list(src.steps), "grid": _grid(store, src, rid),
                          "op_grid": _op_grid(store, src, rid)}
    return out


def point_index(grid: dict, lat: float, lon: float) -> tuple[int, int]:
    iy = int(np.floor((lat - grid["lat0"]) / grid["dlat"] + 0.5))
    ix = int(np.floor((lon - grid["lon0"]) / grid["dlon"] + 0.5))
    return min(max(iy, 0), grid["ny"] - 1), min(max(ix, 0), grid["nx"] - 1)


def _cube(store: Store, src: Source, rid: str, rows=slice(None), cols=slice(None)) -> dict[str, np.ndarray]:
    """{field: array[members, steps, rows, columns]}, with precipitation already 6-hourly."""
    out = {}
    for v in VARS:
        a = np.stack([np.stack([store.load(src.store_id, rid, _var(v, m), s)[0][rows, cols] for s in src.steps])
                      for m in src.members])
        if v == "tp" and src.tp_cumulative:
            a = np.maximum(np.diff(a, axis=1, prepend=0), 0)  # steps every 6 hours from the first (+6h, accumulated from 0)
        out[v] = a
    return out


def _op_cube(store: Store, src: Source, rid: str) -> dict[str, tuple[np.ndarray, dict]] | None:
    """Operational run: {field: (array[steps, rows, columns] on its own grid, grid)}, precipitation 6-hourly and NaN
    for the missing steps; None if it was not downloaded."""
    out = {}
    for v in VARS:
        have = set(store.steps(src.store_id, rid, _var(v, OP)))
        if not have:
            return None
        grid, arrs = None, []
        for s in src.steps:
            if s in have:
                a, grid = store.load(src.store_id, rid, _var(v, OP), s)
                arrs.append(a)
            else:
                arrs.append(None)
        shape = next(a.shape for a in arrs if a is not None)
        a = np.stack([np.full(shape, np.nan, np.float32) if x is None else x for x in arrs])
        if v == "tp" and src.tp_cumulative:
            # 6-hourly from the totals: a step without the previous one stays missing (no difference with a gap)
            prev = np.concatenate([np.zeros((1,) + shape, np.float32), a[:-1]])
            a = np.maximum(a - prev, 0)
        out[v] = (a, grid)
    return out


def _op_at(op: dict | None, lat: float, lon: float) -> dict | None:
    """Operational run at the cell nearest to (lat, lon): {field: [values per step]}."""
    if not op:
        return None
    out = {}
    for v, (a, g) in op.items():
        iy, ix = point_index(g, lat, lon)
        vals = np.round(a[:, iy, ix].astype(np.float64), DECIMALS).tolist()
        out[v] = [None if x != x else x for x in vals]
    return out


def _point(src: Source, cube: dict[str, np.ndarray], rid: str, lat: float, lon: float, iy: int, ix: int,
           op: dict | None = None) -> dict:
    def series(v: str) -> list[list]:
        a = np.round(cube[v][:, :, iy, ix].astype(np.float64), DECIMALS)
        return [[None if x != x else x for x in row] for row in a.tolist()]

    return {"model": src.model, "run": rid, "lat": round(lat, 3), "lon": round(lon, 3), "members": list(src.members),
            "control": src.control, "steps": list(src.steps), "t850": series("t850"), "tp": series("tp"),
            "op": _op_at(op, lat, lon)}


def point_series(store: Store, model: str, lat: float, lon: float) -> dict | None:
    src = SOURCES.get(model)
    rid = src and latest_complete(store, src)
    if not rid:
        return None
    g = _grid(store, src, rid)
    iy, ix = point_index(g, lat, lon)
    cube = _cube(store, src, rid, slice(iy, iy + 1), slice(ix, ix + 1))
    point = _point(src, cube, rid, g["lat0"] + iy * g["dlat"], g["lon0"] + ix * g["dlon"], 0, 0)
    point["op"] = _op_at(_op_cube(store, src, rid), lat, lon)
    return point


def all_points(store: Store):
    """For the static site: (model, row, column, json) of each point of the latest complete runs."""
    for model, src in SOURCES.items():
        rid = latest_complete(store, src)
        if not rid:
            continue
        g = _grid(store, src, rid)
        cube = _cube(store, src, rid)
        op = _op_cube(store, src, rid)
        for iy in range(g["ny"]):
            for ix in range(g["nx"]):
                yield model, iy, ix, _point(src, cube, rid, g["lat0"] + iy * g["dlat"], g["lon0"] + ix * g["dlon"],
                                            iy, ix, op)


def all_operational_points(store: Store):
    for model, src in SOURCES.items():
        rid = latest_complete(store, src)
        if not rid:
            continue
        op = _op_cube(store, src, rid)
        if not op:
            continue
        grid = op["t850"][1]
        for iy in range(grid["ny"]):
            for ix in range(grid["nx"]):
                lat = grid["lat0"] + iy * grid["dlat"]
                lon = grid["lon0"] + ix * grid["dlon"]
                yield model, rid, iy, ix, _op_at(op, lat, lon)


if __name__ == "__main__":  # python -m app.ensemble [gfs|ecmwf]: downloads the latest runs
    import sys

    logging.basicConfig(level=logging.INFO)
    for m in sys.argv[1:] or list(SOURCES):
        print(update(m))
