"""Genera il sito statico (per GitHub Pages) dai dati in DATA_DIR.

Produce in OUT_DIR:
  index.html, app.js, style.css      la pagina, in modalità statica
  data/meta.json                     come /api/meta
  data/runs.json                     come /api/runs + istante di generazione
  data/field/{model}/{var}/{run}/{step}.json   campo "totale" (o "valore") come /api/field

La modalità Intervallo viene calcolata nel browser come differenza fra due totali.
Uso:  python scripts/build_static.py [OUT_DIR]   (default: ./public)
"""
from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

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
    for name in ("app.js", "style.css"):
        shutil.copy(ROOT / "static" / name, out_dir / name)
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    html = html.replace('<html lang="it">', '<html lang="it" data-mode="static">', 1)
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
        for model, items in runs.items():
            for item in items:
                if item.get("incoming"):  # corsa ancora in arrivo: solo l'avviso, i campi non si pubblicano
                    continue
                for var, info in item["variables"].items():
                    for step in info["steps"]:
                        r = client.get("/api/field", params={"model": model, "var": var, "run": item["run"], "step": step})
                        if r.status_code != 200:
                            print(f"saltato {model}/{var}/{item['run']}/{step}: {r.status_code}", file=sys.stderr)
                            continue
                        size += write_json(out_dir / "data" / "field" / model / var / item["run"] / f"{step}.json", r.json())
                        files += 1
    print(f"Sito statico in {out_dir}: {files} campi, {size / 1e6:.1f} MB di JSON")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "public").resolve()))
