"""Storage su disco dei campi già ritagliati e convertiti.

Layout: DATA_DIR/{bbox.key}/{model}/{run}/{var}/{step:03d}.npy (+ meta.json per var).
Il namespace per box fa sì che cambiare area non mescoli griglie diverse.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

import numpy as np

from .config import BBox, get_bbox, get_data_dir
from .grid import Field


class Store:
    def __init__(self, data_dir: Path | None = None, bbox: BBox | None = None):
        self.data_dir = data_dir or get_data_dir()
        self.bbox = bbox or get_bbox()
        self.root = self.data_dir / self.bbox.key
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "bbox.json").write_text(json.dumps(self.bbox.as_dict()))

    # ---- percorsi
    def var_dir(self, model: str, run: str, var: str) -> Path:
        return self.root / model / run / var

    def step_path(self, model: str, run: str, var: str, step: int) -> Path:
        return self.var_dir(model, run, var) / f"{step:03d}.npy"

    # ---- scrittura
    def save(self, model: str, run: str, var: str, step: int, field: Field) -> None:
        d = self.var_dir(model, run, var)
        d.mkdir(parents=True, exist_ok=True)
        meta_path = d / "meta.json"
        grid = field.grid_dict()
        if meta_path.exists():
            existing = json.loads(meta_path.read_text())
            if existing["grid"] != grid:
                raise ValueError(f"Griglia incoerente per {model}/{run}/{var}: {existing['grid']} vs {grid}")
        else:
            _atomic_write_text(meta_path, json.dumps({"grid": grid, "bbox": self.bbox.as_dict()}))
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "wb") as fh:
            np.save(fh, field.values.astype(np.float32))
        os.replace(tmp, self.step_path(model, run, var, step))

    # ---- lettura
    def has(self, model: str, run: str, var: str, step: int) -> bool:
        return self.step_path(model, run, var, step).exists()

    def load(self, model: str, run: str, var: str, step: int) -> tuple[np.ndarray, dict]:
        path = self.step_path(model, run, var, step)
        if not path.exists():
            raise FileNotFoundError(path)
        meta = json.loads((path.parent / "meta.json").read_text())
        return np.load(path), meta["grid"]

    def steps(self, model: str, run: str, var: str) -> list[int]:
        d = self.var_dir(model, run, var)
        if not d.exists():
            return []
        return sorted(int(p.stem) for p in d.glob("*.npy"))

    def runs(self, model: str) -> list[str]:
        d = self.root / model
        if not d.exists():
            return []
        return sorted((p.name for p in d.iterdir() if p.is_dir() and p.name.isdigit()), reverse=True)

    def variables(self, model: str, run: str) -> list[str]:
        d = self.root / model / run
        return sorted(p.name for p in d.iterdir() if p.is_dir()) if d.exists() else []

    # ---- pulizia
    def purge(self, model: str, retention: int) -> list[str]:
        removed = []
        for run in self.runs(model)[retention:]:
            shutil.rmtree(self.root / model / run, ignore_errors=True)
            removed.append(run)
        return removed

    def purge_other_bboxes(self) -> list[str]:
        removed = []
        for p in self.data_dir.iterdir():
            if p.is_dir() and p.name != self.bbox.key and (p / "bbox.json").exists():
                shutil.rmtree(p, ignore_errors=True)
                removed.append(p.name)
        return removed


def _atomic_write_text(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)
