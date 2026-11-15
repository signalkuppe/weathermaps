"""Ensemble di GFS ed ECMWF: gli "spaghetti" di una località nella carta sinottica.

Temperatura a 850 hPa e pioggia di ogni 6 ore, un valore per membro, solo sulla nostra area (BBOX) e solo per le corse
delle 00 e 12 UTC. Si salvano nello Store come modelli in più (non sono nel menu dei modelli), con grandezze
"t850.<membro>" e "tp.<membro>"; si tiene l'ultima corsa completa (più quella in arrivo).

- GFS (GEFS 0,5°, dati aperti NOAA su AWS, noaa-gefs-pds): controllo c00 e 30 membri p01...p30, fino a +384h. Un file
  per membro e passo: si legge l'indice .idx e poi solo i due campi. La pioggia è già a intervalli di 6 ore (0-6,
  6-12...). L'ensemble a 0,25° non ha la temperatura a 850 hPa.
- ECMWF (ENS 0,25°, dati aperti ECMWF): 50 membri perturbati (il controllo non è nei dati aperti), fino a +360h. Un
  file per passo con tutti i membri: si legge l'indice e poi, per ogni grandezza, il blocco dei 50 membri (sono uno
  dopo l'altro). La pioggia è cumulata dall'inizio della corsa, in metri: nei punti per la pagina diventa quella di
  ogni 6 ore (differenza fra passi).
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
    model: str  # modello della pagina (bandiera, selettore del grafico): "gfs" o "ecmwf"
    store_id: str  # "modello" nello Store
    label: str
    members: tuple[str, ...]
    steps: tuple[int, ...]
    info: ModelInfo  # corse e ritardo (candidate_runs)
    control: str | None  # membro di controllo, disegnato a parte
    tp_cumulative: bool  # pioggia cumulata dall'inizio: nei punti si fanno le differenze
    download: Callable  # (client, run, rid, store, source) -> (scaricati, errori)


def _get(client: httpx.Client, url: str, **kw) -> httpx.Response:
    """GET con qualche nuovo tentativo sugli errori di rete passeggeri (connessioni chiuse, DNS)."""
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


# ---------- GFS: GEFS 0,5°, un file per membro e passo

GEFS_ROOT = "https://noaa-gefs-pds.s3.amazonaws.com"
GEFS_WORKERS = 12  # membri scaricati insieme: con tutti e 31 la rete di casa perdeva connessioni


def gefs_url(run: datetime, member: str, step: int) -> str:
    hh = f"{run.hour:02d}"
    return f"{GEFS_ROOT}/gefs.{run:%Y%m%d}/{hh}/atmos/pgrb2ap5/ge{member}.t{hh}z.pgrb2a.0p50.f{step:03d}"


def gefs_ranges(index_text: str, step: int) -> dict[str, tuple[int, int | None]]:
    """Intervalli di byte (inizio, fine compresa o None = fino in fondo) dei due campi nell'indice wgrib2."""
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
                if idx.status_code in (403, 404):  # S3 risponde 403 per i file che non ci sono (ancora)
                    break  # i passi escono in ordine
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


# ---------- ECMWF: ENS 0,25°, un file per passo con tutti i membri

ECENS_ROOT = "https://data.ecmwf.int/forecasts"
ECENS_WORKERS = 4  # passi scaricati insieme (ogni passo sono due blocchi da ~15 MB)


def ecens_url(run: datetime, step: int) -> str:
    return f"{ECENS_ROOT}/{run:%Y%m%d}/{run.hour:02d}z/ifs/0p25/enfo/{run:%Y%m%d%H}0000-{step}h-enfo-ef"


def ecens_records(index_text: str, members: tuple[str, ...]) -> dict[str, dict[str, tuple[int, int]]]:
    """{grandezza: {membro: (offset, lunghezza)}} dall'indice JSON dei dati aperti ECMWF."""
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
    """Membri vicini nel file uniti in blocchi da leggere con una richiesta sola: (inizio, fine compresa, membri)."""
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
                return 0, 0  # passo non ancora pubblicato
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
                f.values = f.values * 1000.0  # metri -> mm
            store.save(src.store_id, rid, _var(var, m), step, f)
        return 1, 0

    got = errors = 0
    with ThreadPoolExecutor(max_workers=ECENS_WORKERS) as pool:
        for g, e in pool.map(step_job, src.steps):
            got, errors = got + g, errors + e
    return got, errors


SOURCES: dict[str, Source] = {
    "gfs": Source(
        model="gfs", store_id="gefs", label="Ensemble GFS 0,5°",
        members=("c00",) + tuple(f"p{i:02d}" for i in range(1, 31)), steps=tuple(range(6, 385, 6)),
        info=ModelInfo(id="gefs", label="GEFS", resolution=0.5, cycles=(0, 12), delay_hours=6, max_step=384),
        control="c00", tp_cumulative=False, download=_gefs_download,
    ),
    "ecmwf": Source(
        model="ecmwf", store_id="ecens", label="Ensemble ECMWF 0,25°",
        members=tuple(f"{i:02d}" for i in range(1, 51)), steps=tuple(range(6, 361, 6)),
        info=ModelInfo(id="ecens", label="ENS", resolution=0.25, cycles=(0, 12), delay_hours=8, max_step=360),
        control=None, tp_cumulative=True, download=_ecens_download,
    ),
}
STORE_IDS = {s.store_id: s for s in SOURCES.values()}
_locks = {k: threading.Lock() for k in SOURCES}


def is_complete(store: Store, src: Source, rid: str) -> bool:
    return all(set(src.steps) <= set(store.steps(src.store_id, rid, _var(v, m))) for v in VARS for m in src.members)


def latest_complete(store: Store, src: Source) -> str | None:
    return next((rid for rid in store.runs(src.store_id) if is_complete(store, src, rid)), None)


def update(model: str, store: Store | None = None, now: datetime | None = None) -> dict:
    """Scarica quello che manca delle ultime corse dell'ensemble di `model` ("gfs" o "ecmwf"). Idempotente."""
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
                # c'è già una corsa più nuova completa: questa non serve
                if any(r > rid and is_complete(store, src, r) for r in store.runs(src.store_id)):
                    continue
                got, errors = src.download(client, run, rid, store, src)
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


# ---------- punti per la pagina


def _grid(store: Store, src: Source, rid: str) -> dict:
    return store.load(src.store_id, rid, _var("t850", src.members[0]), src.steps[0])[1]


def info(store: Store) -> dict:
    """Per /api/meta: per ogni modello con l'ensemble pronto, corsa, membri e griglia dei punti."""
    out = {}
    for model, src in SOURCES.items():
        rid = latest_complete(store, src)
        if rid:
            out[model] = {"run": rid, "label": src.label, "members": list(src.members), "control": src.control,
                          "steps": list(src.steps), "grid": _grid(store, src, rid)}
    return out


def point_index(grid: dict, lat: float, lon: float) -> tuple[int, int]:
    iy = int(round((lat - grid["lat0"]) / grid["dlat"]))
    ix = int(round((lon - grid["lon0"]) / grid["dlon"]))
    return min(max(iy, 0), grid["ny"] - 1), min(max(ix, 0), grid["nx"] - 1)


def _cube(store: Store, src: Source, rid: str, rows=slice(None), cols=slice(None)) -> dict[str, np.ndarray]:
    """{grandezza: array[membri, passi, righe, colonne]}, con la pioggia già di ogni 6 ore."""
    out = {}
    for v in VARS:
        a = np.stack([np.stack([store.load(src.store_id, rid, _var(v, m), s)[0][rows, cols] for s in src.steps])
                      for m in src.members])
        if v == "tp" and src.tp_cumulative:
            a = np.maximum(np.diff(a, axis=1, prepend=0), 0)  # passi ogni 6 ore dal primo (+6h, cumulata da 0)
        out[v] = a
    return out


def _point(src: Source, cube: dict[str, np.ndarray], rid: str, lat: float, lon: float, iy: int, ix: int) -> dict:
    def series(v: str) -> list[list]:
        a = np.round(cube[v][:, :, iy, ix].astype(np.float64), DECIMALS)
        return [[None if x != x else x for x in row] for row in a.tolist()]

    return {"model": src.model, "run": rid, "lat": round(lat, 3), "lon": round(lon, 3), "members": list(src.members),
            "control": src.control, "steps": list(src.steps), "t850": series("t850"), "tp": series("tp")}


def point_series(store: Store, model: str, lat: float, lon: float) -> dict | None:
    src = SOURCES.get(model)
    rid = src and latest_complete(store, src)
    if not rid:
        return None
    g = _grid(store, src, rid)
    iy, ix = point_index(g, lat, lon)
    cube = _cube(store, src, rid, slice(iy, iy + 1), slice(ix, ix + 1))
    return _point(src, cube, rid, g["lat0"] + iy * g["dlat"], g["lon0"] + ix * g["dlon"], 0, 0)


def all_points(store: Store):
    """Per il sito statico: (modello, riga, colonna, json) di ogni punto delle ultime corse complete."""
    for model, src in SOURCES.items():
        rid = latest_complete(store, src)
        if not rid:
            continue
        g = _grid(store, src, rid)
        cube = _cube(store, src, rid)
        for iy in range(g["ny"]):
            for ix in range(g["nx"]):
                yield model, iy, ix, _point(src, cube, rid, g["lat0"] + iy * g["dlat"], g["lon0"] + ix * g["dlon"],
                                            iy, ix)


if __name__ == "__main__":  # python -m app.ensemble [gfs|ecmwf]: scarica le ultime corse
    import sys

    logging.basicConfig(level=logging.INFO)
    for m in sys.argv[1:] or list(SOURCES):
        print(update(m))
