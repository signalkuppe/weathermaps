"""Generates the static site (for GitHub Pages) from the data in DATA_DIR.

Produces in OUT_DIR:
  index.html, app.js, render.js, style.css   the page, in static mode
  borders.json                       geographic outlines (from scripts/make_borders.py)
  borders-synoptic.json              coastlines and countries of the synoptic chart (make_borders.py --synoptic)
  clim-t850.json                     T850 1991-2020 climatology for the spaghetti plots (make_climate.py)
  data/meta.json                     like /api/meta
  data/runs.json                     like /api/runs + generation time
  data/field/{model}/{var}/{run}/{step}.bin    "total" (or "value") field like /api/field, in compact format:
                                               values as 16-bit integers (app/packed.py), about 1/3 of the JSON
  data/series/{model}/{run}/{grid}/{row}_{column}.bin   meteograms in tiles, compact format: precipitation and
                                               snow on the model grid ("native"), the rest on a regular grid
                                               ("smooth"); the grids are in runs.json (app/series.py)
  data/ensemble/{model}/{run}/{row}_{column}.json  GFS and ECMWF ensemble spaghetti, one point (app/ensemble.py)
    data/ensemble/{model}/{run}/op/{row}_{column}.json  operational run on its native grid
  data/soundings/index.json, {station}/{YYYYMMDDHH}.json  observed soundings (app/soundings.py)

To limit the number of files (GitHub Pages syncs them one by one, within 10 minutes):
  - the two wind components are in a single file per step: data/field/{model}/{vector}/{run}/{step}.bin
    with "u" and "v" instead of "values" (vector = wind10, wind700);
  - detail fields (e.g. z850, height of 850 hPa) are in the file of the field they belong to (t850),
    under "extra": {"z850": {grid, values, ...}}.

The Interval mode is computed in the browser as the difference between two totals.
Usage:  python scripts/build_static.py [OUT_DIR]   (default: ./public)
        python scripts/build_static.py --page-only [OUT_DIR]   only the page, on a site already generated
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app import ensemble, packed, series, soundings, variables  # noqa: E402
from app.main import create_app  # noqa: E402
from app.config import get_version  # noqa: E402
from app.store import Store  # noqa: E402


ESBUILD_VERSION = "0.27.3"


def build_javascript(out_path: Path) -> None:
    subprocess.run(
        [
            "npx",
            "--yes",
            f"esbuild@{ESBUILD_VERSION}",
            str(ROOT / "scripts" / "static_entry.js"),
            "--bundle",
            "--minify",
            "--sourcemap",  # app.js.map alongside: Sentry derives the original error lines from it (the code is public anyway)
            "--platform=browser",
            "--format=iife",
            "--legal-comments=none",
            "--banner:js=/*! range-slider-input v2.4.7 | MIT | Copyright (c) Utkarsh Verma */",
            f"--outfile={out_path}",
        ],
        cwd=ROOT,
        check=True,
    )


def write_bin(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = packed.pack(obj)
    path.write_bytes(data)
    return len(data)


def write_json(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text)


def build_page(out_dir: Path) -> None:
    """The page (HTML, script, style, icons and the small files it reads), without the data."""
    out_dir.mkdir(parents=True, exist_ok=True)
    # page: same files as the server, marked as static
    for name in ("render.js", "style.css", "borders.json", "borders-synoptic.json", "clim-t850.json",
                 "manifest.webmanifest"):
        shutil.copy(ROOT / "static" / name, out_dir / name)
    build_javascript(out_dir / "app.js")
    if (out_dir / "icons").exists():
        shutil.rmtree(out_dir / "icons")
    shutil.copytree(ROOT / "static" / "icons", out_dir / "icons")  # logo: favicon and phone home-screen icons
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    html = html.replace('<html lang="it">', '<html lang="it" data-mode="static">', 1)
    vendor_script = '    <script src="vendor/range-slider-input-2.4.7.min.js"></script>\n'
    assert vendor_script in html, "script range-slider-input non trovato in index.html"
    html = html.replace(vendor_script, "", 1)
    # content fingerprint in the script and style URLs: after an update the browser downloads the new files right
    # away instead of using the cached ones for 10 minutes (new page with old script = entries that do not work)
    for name, attr in (("app.js", "src"), ("render.js", "src"), ("style.css", "href")):
        digest = hashlib.sha1((out_dir / name).read_bytes()).hexdigest()[:10]
        old = f'{attr}="{name}"'
        assert old in html, f"{old} non trovato in index.html"
        html = html.replace(old, f'{attr}="{name}?v={digest}"', 1)
    (out_dir / "index.html").write_text(html, encoding="utf-8")
    (out_dir / ".nojekyll").write_text("")


def page_only(out_dir: Path) -> int:
    """Interface-only update of a site already generated (restored from the cache in the workflow): new page and the
    version in meta.json (the page compares it to reload after an update); the map data stay as they are."""
    meta_path = out_dir / "data" / "meta.json"
    if not meta_path.exists():
        print(f"{meta_path} missing: a full build is needed", file=sys.stderr)
        return 1
    build_page(out_dir)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["version"] = get_version()
    write_json(meta_path, meta)
    print(f"Page updated in {out_dir} (version {meta['version'] or '-'}), data unchanged")
    return 0


def main(out_dir: Path) -> int:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    build_page(out_dir)

    store = Store()
    app = create_app(store=store, start_scheduler=False)
    files = 0
    size = 0
    with TestClient(app) as client:
        meta = client.get("/api/meta").json()
        size += write_json(out_dir / "data" / "meta.json", meta)
        runs = client.get("/api/runs").json()
        # wind components and detail fields: they have no files of their own (see above)
        comp = {vec[c]: vec for vec in variables.VECTORS for c in ("u", "v")}
        detail_of = {d["var"]: v.id for v in variables.REGISTRY.values() for d in (v.details or [])}

        def get(model, var, run, step):
            r = client.get("/api/field", params={"model": model, "var": var, "run": run, "step": step})
            if r.status_code != 200:
                print(f"skipped {model}/{var}/{run}/{step}: {r.status_code}", file=sys.stderr)
                return None
            return r.json()

        for model, items in runs.items():
            for item in items:
                if item.get("incoming"):  # run still incoming: only the notice, its fields are not published
                    continue
                run, have = item["run"], item["variables"]
                for var, info in have.items():
                    if var in comp or var in detail_of:
                        continue
                    for step in info["steps"]:
                        body = get(model, var, run, step)
                        if body is None:
                            continue
                        for dvar, owner in detail_of.items():
                            if owner == var and step in have.get(dvar, {}).get("steps", []):
                                extra = get(model, dvar, run, step)
                                if extra:
                                    body.setdefault("extra", {})[dvar] = extra
                        size += write_bin(out_dir / "data" / "field" / model / var / run / f"{step}.bin", body)
                        files += 1
                for vec in variables.VECTORS:
                    su, sv = have.get(vec["u"], {}).get("steps", []), have.get(vec["v"], {}).get("steps", [])
                    for step in sorted(set(su) & set(sv)):
                        fu, fv = get(model, vec["u"], run, step), get(model, vec["v"], run, step)
                        if not fu or not fv:
                            continue
                        body = {k: x for k, x in fu.items() if k not in ("values", "max", "min", "var")}
                        body.update(var=vec["id"], u=fu["values"], v=fv["values"])
                        size += write_bin(out_dir / "data" / "field" / model / vec["id"] / run / f"{step}.bin", body)
                        files += 1
        # GFS and ECMWF ensemble spaghetti: one file per point of their grid (see app/ensemble.py)
        nens = 0
        for model, iy, ix, body in ensemble.all_points(store):
            size += write_json(out_dir / "data" / "ensemble" / model / body["run"] / f"{iy}_{ix}.json", body)
            nens += 1
        for model, rid, iy, ix, body in ensemble.all_operational_points(store):
            size += write_json(out_dir / "data" / "ensemble" / model / rid / "op" / f"{iy}_{ix}.json", body)
        # observed soundings: station index and one file per launch (see app/soundings.py)
        size += write_json(out_dir / "data" / "soundings" / "index.json", soundings.index(store))
        for st in soundings.index(store):
            for key in st["times"][:1]:  # the page shows only the latest launch
                size += write_json(out_dir / "data" / "soundings" / st["id"] / f"{key}.json",
                                   soundings.load(store, st["id"], key))
        # meteograms: series in the cells of the model grid, in tiles (see app/series.py); the grid
        # of each run goes into runs.json, to find the tile and cell of a place
        nser = 0
        for model, items in runs.items():
            for item in items:
                if item.get("incoming"):
                    continue
                grids, tiles = series.build_tiles(store, model, item["run"])
                if grids:
                    item["series"] = grids
                for (name, ty, tx), body in tiles.items():
                    size += write_bin(out_dir / "data" / "series" / model / item["run"] / name / f"{ty}_{tx}.bin", body)
                    nser += 1
        runs_out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "models": runs}
        size += write_json(out_dir / "data" / "runs.json", runs_out)
    print(f"Static site in {out_dir}: {files} fields, {nser} series tiles, {nens} ensemble points, "
          f"{size / 1e6:.1f} MB of data")
    return 0


if __name__ == "__main__":
    # --page-only: only the interface, on a site already generated (see page_only)
    args = [a for a in sys.argv[1:] if a != "--page-only"]
    out = Path(args[0] if args else ROOT / "public").resolve()
    raise SystemExit(page_only(out) if "--page-only" in sys.argv[1:] else main(out))
