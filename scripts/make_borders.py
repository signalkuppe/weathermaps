"""Generates static/borders.json: coastlines, country, regional and provincial borders cropped to BBOX.

They help recognise places even when the data colours cover the basemap (high opacity):
the page draws them as thin lines above the colours. Data: Natural Earth 1:10m (public domain).

Usage:
  download into a folder the GeoJSON files from https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
    ne_10m_coastline, ne_10m_admin_0_boundary_lines_land,
    ne_10m_admin_1_states_provinces_lines
  python scripts/make_borders.py NE_FOLDER   (BBOX from the environment, like the rest of the app)

More precise coastlines (updates only "coast" in the existing borders.json):
  coastline from the OpenStreetMap sea outline, the same data as the Mapbox basemaps (no rivers, unlike the
  Mapbox water outline): https://osmdata.openstreetmap.de/download/simplified-water-polygons-split-3857.zip
  python scripts/make_borders.py --water EXTRACTED_OSM_FOLDER

Synoptic chart (static/borders-synoptic.json, coastlines and countries over the Atlantic and Europe):
  ne_50m_coastline and ne_50m_admin_0_boundary_lines_land from the same Natural Earth folder
  python scripts/make_borders.py --synoptic NE_FOLDER
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import get_bbox  # noqa: E402

MARGIN = 0.5  # degrees beyond the edge: lines do not stop exactly at the edge of the data
TOLERANCE = 0.004  # simplification (~400 m): invisible at the map scales, much smaller file
# Natural Earth calls "Admin-1" the first level below the country, which is not the same everywhere: in Italy and
# France they are provinces and departments, grouped into regions ("Admin-1 region boundary" lines); in Switzerland,
# Austria, Germany, Croatia... cantons/Länder/counties are already the "region" level. In Slovenia Admin-1 are municipalities.
WITH_REGIONS = {"Italy", "France", "Hungary", "Slovenia"}
MAX_MIN_ZOOM = 9  # beyond that (Slovenian municipalities, Liechtenstein, San Marino) too dense for this scale


def admin1_layer(props: dict) -> str | None:
    """'regions', 'provinces' or None (line to discard) for a line of ne_10m_admin_1_states_provinces_lines."""
    cla, country = props.get("FEATURECLA") or "", props.get("ADM0_NAME")
    if (props.get("MIN_ZOOM") or 0) > MAX_MIN_ZOOM and cla != "Admin-1 region boundary":
        return None
    if cla == "Admin-1 region boundary":
        return "regions"
    if cla == "Admin-1 boundary":
        return "provinces" if country in WITH_REGIONS else "regions"
    return None  # statistical boundaries


def simplify(pts: list[list[float]], tol: float) -> list[list[float]]:
    """Iterative Douglas-Peucker."""
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
            # closed ring (coinciding ends): distance from the point, not from the line
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm if norm else ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def clip(line: list[list[float]], box) -> list[list[list[float]]]:
    """Splits the line into the stretches inside the box (with one point outside at each end, to reach the edge)."""
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


FINE_TOL = 0.001  # coastlines: ~100 m, they must trace the basemap even when zoomed in
FINE_DEC = 4


def shp_polygons(path: Path):
    """Polygon rings of a shapefile (type 5), without libraries: [[(x, y), ...], ...] per record."""
    data = path.read_bytes()
    pos = 100  # file header
    while pos + 8 <= len(data):
        _, length = struct.unpack(">ii", data[pos:pos + 8])
        rec = data[pos + 8:pos + 8 + length * 2]
        pos += 8 + length * 2
        if len(rec) < 44 or struct.unpack("<i", rec[:4])[0] != 5:
            continue
        nparts, npoints = struct.unpack("<ii", rec[36:44])
        parts = list(struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts])) + [npoints]
        base = 44 + 4 * nparts
        pts = struct.unpack(f"<{2 * npoints}d", rec[base:base + 16 * npoints])
        yield [[(pts[2 * i], pts[2 * i + 1]) for i in range(parts[k], parts[k + 1])] for k in range(nparts)]


def merc_to_lonlat(x: float, y: float) -> list[float]:
    r = 6378137.0
    return [math.degrees(x / r), math.degrees(2 * math.atan(math.exp(y / r)) - math.pi / 2)]


def osm_coast(osm_dir: Path, box) -> list:
    """Sea outline: the edges of the water polygons, minus the straight cuts of the tiling."""
    lat0, lat1, lon0, lon1 = box
    shp = next(osm_dir.rglob("simplified_water_polygons.shp"))
    parts = []
    for rings in shp_polygons(shp):
        for ring in rings:
            # tiling edges: exactly horizontal or vertical segments (the coastline never is)
            cur: list = []
            for a, b in zip(ring, ring[1:]):
                if a[0] == b[0] or a[1] == b[1]:
                    if len(cur) >= 2:
                        parts.append(cur)
                    cur = []
                    continue
                if not cur:
                    cur = [merc_to_lonlat(*a)]
                cur.append(merc_to_lonlat(*b))
            if len(cur) >= 2:
                parts.append(cur)
    out = []
    for line in parts:
        xs, ys = [p[0] for p in line], [p[1] for p in line]
        if max(xs) < lon0 or min(xs) > lon1 or max(ys) < lat0 or min(ys) > lat1:
            continue
        for seg in clip(line, box):
            seg = simplify(seg, FINE_TOL)
            if len(seg) >= 2:
                out.append([[round(y, FINE_DEC), round(x, FINE_DEC)] for x, y in seg])
    return out


def main_water(osm_dir: Path) -> int:
    b = get_bbox()
    box = (b.lat_min - MARGIN, b.lat_max + MARGIN, b.lon_min - MARGIN, b.lon_max + MARGIN)
    path = ROOT / "static" / "borders.json"
    out = json.loads(path.read_text(encoding="utf-8"))
    out["coast"] = osm_coast(osm_dir, box)
    print(f"coast: {len(out['coast'])} lines, {sum(len(p) for p in out['coast'])} points")
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{path}: {path.stat().st_size / 1e3:.0f} kB")
    return 0


def main(ne_dir: Path) -> int:
    b = get_bbox()
    box = (b.lat_min - MARGIN, b.lat_max + MARGIN, b.lon_min - MARGIN, b.lon_max + MARGIN)
    layers = {
        "coast": "ne_10m_coastline.geojson",
        "countries": "ne_10m_admin_0_boundary_lines_land.geojson",
        "regions": "ne_10m_admin_1_states_provinces_lines.geojson",
        "provinces": "ne_10m_admin_1_states_provinces_lines.geojson",
    }
    out: dict[str, list] = {}
    for key, name in layers.items():
        data = json.loads((ne_dir / name).read_text(encoding="utf-8"))
        features = data["features"]
        if key in ("regions", "provinces"):
            features = [f for f in features if admin1_layer(f["properties"]) == key]
        parts = []
        for feat in features:
            for line in lines_of(feat["geometry"]):
                for seg in clip(line, box):
                    seg = simplify(seg, TOLERANCE)
                    if len(seg) >= 2:
                        # [lat, lon] with 3 decimals (~100 m), the order Leaflet uses
                        parts.append([[round(y, 3), round(x, 3)] for x, y in seg])
        out[key] = parts
        print(f"{key}: {len(parts)} lines, {sum(len(p) for p in parts)} points")
    path = ROOT / "static" / "borders.json"
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{path}: {path.stat().st_size / 1e3:.0f} kB")
    return 0


SYN_TOL = 0.05  # synoptic chart: ~5 km, enough at that scale


def main_synoptic(ne_dir: Path) -> int:
    """static/borders-synoptic.json: coastlines and countries (Natural Earth 1:50m) over the synoptic chart area."""
    from app.config import SYNOPTIC_BBOX, BBox

    b = BBox.parse(SYNOPTIC_BBOX)
    box = (b.lat_min - 0.5, b.lat_max + 0.5, b.lon_min - 0.5, b.lon_max + 0.5)
    out: dict[str, list] = {}
    for key, name in (("coast", "ne_50m_coastline.geojson"), ("countries", "ne_50m_admin_0_boundary_lines_land.geojson")):
        parts = []
        for feat in json.loads((ne_dir / name).read_text(encoding="utf-8"))["features"]:
            for line in lines_of(feat["geometry"]):
                for seg in clip(line, box):
                    seg = simplify(seg, SYN_TOL)
                    if len(seg) >= 2:
                        parts.append([[round(y, 2), round(x, 2)] for x, y in seg])
        out[key] = parts
        print(f"{key}: {len(parts)} lines, {sum(len(p) for p in parts)} points")
    path = ROOT / "static" / "borders-synoptic.json"
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{path}: {path.stat().st_size / 1e3:.0f} kB")
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--water":
        raise SystemExit(main_water(Path(sys.argv[2])))
    if len(sys.argv) == 3 and sys.argv[1] == "--synoptic":
        raise SystemExit(main_synoptic(Path(sys.argv[2])))
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(Path(sys.argv[1])))
