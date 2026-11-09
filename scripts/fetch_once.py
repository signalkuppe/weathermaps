"""Popola DATA_DIR scaricando le ultime corse di tutti i modelli, poi esce.

Uso:  python scripts/fetch_once.py [gfs|ecmwf ...]
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.fetcher import SOURCES, update_model  # noqa: E402
from app.store import Store  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)


def main(argv: list[str]) -> int:
    models = argv or list(SOURCES)
    store = Store()
    store.purge_other_bboxes()
    errors = 0
    for m in models:
        summary = update_model(m, store)
        print(json.dumps(summary, indent=2))
        errors += summary.get("errors", 0)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
