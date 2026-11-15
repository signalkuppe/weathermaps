"""Popola DATA_DIR scaricando le ultime corse di tutti i modelli, poi esce.

Uso:  python scripts/fetch_once.py [gfs|ecmwf|gefs|ecens ...]   (gefs, ecens = ensemble, vedi app/ensemble.py)
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import ensemble  # noqa: E402
from app.fetcher import SOURCES, update_model  # noqa: E402
from app.mean import build_mean  # noqa: E402
from app.store import Store  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)


def main(argv: list[str]) -> int:
    ens = {s.store_id: m for m, s in ensemble.SOURCES.items()}  # "gefs" -> "gfs", "ecens" -> "ecmwf"
    models = [m for m in argv if m not in ens] or (list(SOURCES) if not argv else [])
    store = Store()
    store.purge_other_bboxes()
    errors = 0
    for m in models:
        summary = update_model(m, store)
        print(json.dumps(summary, indent=2))
        errors += summary.get("errors", 0)
    print("mediana:", json.dumps(build_mean(store), indent=2))
    for sid, model in ens.items():  # spaghetti delle località nella carta sinottica
        if not argv or sid in argv:
            summary = ensemble.update(model, store)
            print("ensemble:", json.dumps(summary, indent=2))
            errors += summary.get("errors", 0)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
