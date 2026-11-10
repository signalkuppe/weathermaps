"""Genera il sito statico (per GitHub Pages) dai dati in DATA_DIR.

Produce in OUT_DIR:
  index.html, app.js, style.css      la pagina, in modalità statica
  borders.json                       contorni geografici (da scripts/make_borders.py)
  data/meta.json                     come /api/meta
  data/runs.json                     come /api/runs + istante di generazione
  data/field/{model}/{var}/{run}/{step}.json   campo "totale" (o "valore") come /api/field

Per contenere il numero di file (GitHub Pages li sincronizza uno per uno, entro 10 minuti):
  - le due componenti del vento stanno in un solo file per passo: data/field/{model}/{vettore}/{run}/{step}.json
    con "u" e "v" al posto di "values" (vettore = wind10, wind700);
  - i campi dei dettagli (es. z850, quota di 850 hPa) stanno nel file della grandezza a cui appartengono (t850),
    sotto "extra": {"z850": {grid, values, ...}}.

La modalità Intervallo viene calcolata nel browser come differenza fra due totali.
Uso:  python scripts/build_static.py [OUT_DIR]   (default: ./public)
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app import variables  # noqa: E402
from app.main import create_app  # noqa: E402
from app.store import Store  # noqa: E402


def write_json(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text)


def main(out_dir: Path) -> int:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    # pagina: stessi file del server, marcati come statici
    for name in ("app.js", "style.css", "borders.json"):
        shutil.copy(ROOT / "static" / name, out_dir / name)
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    html = html.replace('<html lang="it">', '<html lang="it" data-mode="static">', 1)
    # impronta del contenuto negli indirizzi di script e stile: dopo un aggiornamento il browser scarica subito i file
    # nuovi invece di usare per 10 minuti quelli in cache (pagina nuova con script vecchio = voci che non funzionano)
    for name, attr in (("app.js", "src"), ("style.css", "href")):
        digest = hashlib.sha1((ROOT / "static" / name).read_bytes()).hexdigest()[:10]
        old = f'{attr}="{name}"'
        assert old in html, f"{old} non trovato in index.html"
        html = html.replace(old, f'{attr}="{name}?v={digest}"', 1)
    (out_dir / "index.html").write_text(html, encoding="utf-8")
    (out_dir / ".nojekyll").write_text("")

    store = Store()
    app = create_app(store=store, start_scheduler=False)
    files = 0
    size = 0
    with TestClient(app) as client:
        meta = client.get("/api/meta").json()
        size += write_json(out_dir / "data" / "meta.json", meta)
        runs = client.get("/api/runs").json()
        runs_out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "models": runs}
        size += write_json(out_dir / "data" / "runs.json", runs_out)
        # componenti del vento e campi dei dettagli: non hanno file propri (vedi sopra)
        comp = {vec[c]: vec for vec in variables.VECTORS for c in ("u", "v")}
        detail_of = {d["var"]: v.id for v in variables.REGISTRY.values() for d in (v.details or [])}

        def get(model, var, run, step):
            r = client.get("/api/field", params={"model": model, "var": var, "run": run, "step": step})
            if r.status_code != 200:
                print(f"saltato {model}/{var}/{run}/{step}: {r.status_code}", file=sys.stderr)
                return None
            return r.json()

        for model, items in runs.items():
            for item in items:
                if item.get("incoming"):  # corsa ancora in arrivo: solo l'avviso, i campi non si pubblicano
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
                        size += write_json(out_dir / "data" / "field" / model / var / run / f"{step}.json", body)
                        files += 1
                for vec in variables.VECTORS:
                    su, sv = have.get(vec["u"], {}).get("steps", []), have.get(vec["v"], {}).get("steps", [])
                    for step in sorted(set(su) & set(sv)):
                        fu, fv = get(model, vec["u"], run, step), get(model, vec["v"], run, step)
                        if not fu or not fv:
                            continue
                        body = {k: x for k, x in fu.items() if k not in ("values", "max", "min", "var")}
                        body.update(var=vec["id"], u=fu["values"], v=fv["values"])
                        size += write_json(out_dir / "data" / "field" / model / vec["id"] / run / f"{step}.json", body)
                        files += 1
    print(f"Sito statico in {out_dir}: {files} campi, {size / 1e6:.1f} MB di JSON")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "public").resolve()))
