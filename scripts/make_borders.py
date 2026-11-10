"""Genera static/borders.json: coste, laghi, confini di stato e regionali ritagliati su BBOX.

Servono a riconoscere i luoghi anche quando i colori dei dati coprono la mappa di sfondo (opacità alta):
la pagina li disegna come linee sottili sopra i colori. Dati: Natural Earth 1:10m (pubblico dominio).

Uso:
  scarica in una cartella i GeoJSON di https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
    ne_10m_coastline, ne_10m_lakes, ne_10m_lakes_europe, ne_10m_admin_0_boundary_lines_land,
    ne_10m_admin_1_states_provinces_lines
  python scripts/make_borders.py CARTELLA_NE   (BBOX dall'ambiente, come il resto dell'app)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import get_bbox  # noqa: E402

MARGIN = 0.5  # gradi oltre il bordo: le linee non si interrompono proprio sul bordo dei dati
TOLERANCE = 0.004  # semplificazione (~400 m): invisibile alle scale della mappa, file molto più piccolo
MIN_LAKE_POINTS = 4  # laghetti minuscoli: solo rumore


def simplify(pts: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas-Peucker iterativo."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            x, y = pts[i]
            # anello chiuso (capi coincidenti): distanza dal punto, non dalla retta
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm if norm else ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def clip(line: list[list[float]], box) -> list[list[list[float]]]:
    """Spezza la linea nei tratti dentro il riquadro (con un punto fuori a ogni capo, per arrivare al bordo)."""
    lat0, lat1, lon0, lon1 = box
    inside = [lon0 <= x <= lon1 and lat0 <= y <= lat1 for x, y in line]
    out, cur = [], []
    for i, p in enumerate(line):
        near = inside[i] or (i > 0 and inside[i - 1]) or (i + 1 < len(line) and inside[i + 1])
        if near:
            cur.append(p)
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [c for c in out if len(c) >= 2]


def lines_of(geom: dict | None) -> list[list[list[float]]]:
    if not geom:
        return []
    t, c = geom["type"], geom["coordinates"]
    if t == "LineString":
        return [c]
    if t == "MultiLineString":
        return c
    if t == "Polygon":
        return c
    if t == "MultiPolygon":
        return [ring for poly in c for ring in poly]
    return []


def main(ne_dir: Path) -> int:
    b = get_bbox()
    box = (b.lat_min - MARGIN, b.lat_max + MARGIN, b.lon_min - MARGIN, b.lon_max + MARGIN)
    layers = {
        "coast": "ne_10m_coastline.geojson",
        "lakes": "ne_10m_lakes.geojson",
        "countries": "ne_10m_admin_0_boundary_lines_land.geojson",
        "regions": "ne_10m_admin_1_states_provinces_lines.geojson",
    }
    out: dict[str, list] = {}
    for key, name in layers.items():
        data = json.loads((ne_dir / name).read_text(encoding="utf-8"))
        features = data["features"]
        if key == "lakes":
            # i laghi minori d'Europa (Iseo, Lugano...) sono in un file a parte; quelli già presenti si saltano
            seen = {f["properties"].get("name") for f in features}
            extra = json.loads((ne_dir / "ne_10m_lakes_europe.geojson").read_text(encoding="utf-8"))["features"]
            features = features + [f for f in extra if f["properties"].get("name") not in seen]
        parts = []
        for feat in features:
            for line in lines_of(feat["geometry"]):
                for seg in clip(line, box):
                    seg = simplify(seg, TOLERANCE)
                    if key == "lakes" and len(seg) < MIN_LAKE_POINTS:
                        continue
                    if len(seg) >= 2:
                        # [lat, lon] con 3 decimali (~100 m), l'ordine che usa Leaflet
                        parts.append([[round(y, 3), round(x, 3)] for x, y in seg])
        out[key] = parts
        print(f"{key}: {len(parts)} linee, {sum(len(p) for p in parts)} punti")
    path = ROOT / "static" / "borders.json"
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{path}: {path.stat().st_size / 1e3:.0f} kB")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(Path(sys.argv[1])))
