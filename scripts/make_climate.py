"""Temperature climatology at 850 hPa for the ensemble spaghetti plots (red line): 1991-2020 mean of each day
of the year and each synoptic hour (00, 06, 12, 18 UTC) over Northern Italy, from the NCEP/NCAR reanalysis (NOAA
PSL, 2.5°, every 6 hours). With the four hours the line has the daily cycle, like the spaghetti (and Wetterzentrale).

It is run only once (the climatology does not change) and writes static/clim-t850.json:
    .venv/bin/python scripts/make_climate.py

For each year only the needed box is downloaded via OPeNDAP (850 hPa level, 37.5-55 N, 0-20 E), as text:
no netCDF libraries. 29 February is skipped; the mean of each day and hour is smoothed over ±15 days (circular, each
hour on its own), so the line has no jumps from 30 years of noise but keeps the daily cycle.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np

URL = "https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis/pressure/air.{year}.nc.ascii"  # every 6 hours
YEARS = range(1991, 2021)
LEVEL = 2  # index of 850 hPa in [1000, 925, 850, ...]
LAT_I = (14, 21)  # 55 .. 37.5 N (the grid goes from north to south, step 2.5)
LON_I = (0, 8)  # 0 .. 20 E
SMOOTH = 15  # days per side of the moving average
OUT = Path(__file__).resolve().parent.parent / "static" / "clim-t850.json"


def fetch_year(year: int) -> np.ndarray:
    """(days, 4 hours, lat, lon) in °C, from north to south; 365 or 366 days."""
    days = 366 if (year % 4 == 0 and year % 100 != 0) or year % 400 == 0 else 365
    last = days * 4 - 1  # last time index (0-based), from 1 January 00 UTC every 6 hours
    q = f"air[0:1:{last}][{LEVEL}][{LAT_I[0]}:{LAT_I[1]}][{LON_I[0]}:{LON_I[1]}]"
    q = q.replace("[", "%5B").replace("]", "%5D")
    req = urllib.request.Request(URL.format(year=year) + "?" + q, headers={"User-Agent": "weathermaps-climate"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode()
    ny, nx = LAT_I[1] - LAT_I[0] + 1, LON_I[1] - LON_I[0] + 1
    rows = {}
    for line in text.splitlines():
        m = re.match(r"\[(\d+)\]\[0\]\[(\d+)\], (.+)$", line)
        if m:
            rows[(int(m[1]), int(m[2]))] = [float(v) for v in m[3].split(",")]
    arr = np.full((days * 4, ny, nx), np.nan, np.float64)
    for (t, y), vals in rows.items():
        arr[t, y] = vals
    if np.isnan(arr).any():
        raise ValueError(f"{year}: dati mancanti")
    return arr.reshape(days, 4, ny, nx) - 273.15


def main() -> None:
    total = None
    for year in YEARS:
        a = fetch_year(year)
        if a.shape[0] == 366:
            a = np.delete(a, 59, axis=0)  # 29 February
        total = a if total is None else total + a
        print(year, a.shape, f"{a.mean():.1f} °C", file=sys.stderr)
    mean = total / len(YEARS)
    k = np.ones(2 * SMOOTH + 1) / (2 * SMOOTH + 1)
    ext = np.concatenate([mean[-SMOOTH:], mean, mean[:SMOOTH]])  # circular: December continues into January
    smooth = np.apply_along_axis(lambda s: np.convolve(s, k, mode="valid"), 0, ext)
    smooth = smooth[:, :, ::-1, :]  # rows from south to north, like the project's other grids
    out = {
        "source": "NCEP/NCAR Reanalysis 1 (NOAA PSL), media 1991-2020 ogni 6 ore, smussata ±15 giorni",
        "hours": [0, 6, 12, 18],  # UTC
        "lat0": 90 - 2.5 * LAT_I[1],
        "lon0": 2.5 * LON_I[0],
        "dlat": 2.5,
        "dlon": 2.5,
        "ny": smooth.shape[2],
        "nx": smooth.shape[3],
        # [day of year 0..364, 1 January = 0][hour 0/6/12/18 UTC][row from the south][column from the west], °C, one decimal
        "t850": np.round(smooth, 1).tolist(),
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"written {OUT} ({OUT.stat().st_size / 1024:.0f} kB)", file=sys.stderr)


if __name__ == "__main__":
    main()
