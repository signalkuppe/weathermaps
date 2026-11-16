"""Climatologia della temperatura a 850 hPa per gli spaghetti degli ensemble (linea rossa): media 1991-2020 di ogni
giorno dell'anno e di ogni ora sinottica (00, 06, 12, 18 UTC) sopra il Nord Italia, dalla rianalisi NCEP/NCAR (NOAA
PSL, 2.5°, ogni 6 ore). Con le quattro ore la linea ha il ciclo del giorno, come gli spaghetti (e Wetterzentrale).

Si lancia una volta sola (la climatologia non cambia) e scrive static/clim-t850.json:
    .venv/bin/python scripts/make_climate.py

Per ogni anno si scarica via OPeNDAP solo il riquadro che serve (livello 850 hPa, 37.5-55 N, 0-20 E), in testo:
niente librerie netCDF. Il 29 febbraio si salta; la media di ogni giorno e ora si smussa su ±15 giorni (circolare, ogni ora
per conto suo), così la linea non ha i salti del rumore di 30 anni ma tiene il ciclo del giorno.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np

URL = "https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis/pressure/air.{year}.nc.ascii"  # ogni 6 ore
YEARS = range(1991, 2021)
LEVEL = 2  # indice di 850 hPa in [1000, 925, 850, ...]
LAT_I = (14, 21)  # 55 .. 37.5 N (la griglia va da nord a sud, passo 2.5)
LON_I = (0, 8)  # 0 .. 20 E
SMOOTH = 15  # giorni per lato della media mobile
OUT = Path(__file__).resolve().parent.parent / "static" / "clim-t850.json"


def fetch_year(year: int) -> np.ndarray:
    """(giorni, 4 ore, lat, lon) in °C, da nord a sud; 365 o 366 giorni."""
    days = 366 if (year % 4 == 0 and year % 100 != 0) or year % 400 == 0 else 365
    last = days * 4 - 1  # ultimo istante (0-based), dal 1 gennaio 00 UTC ogni 6 ore
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
            a = np.delete(a, 59, axis=0)  # 29 febbraio
        total = a if total is None else total + a
        print(year, a.shape, f"{a.mean():.1f} °C", file=sys.stderr)
    mean = total / len(YEARS)
    k = np.ones(2 * SMOOTH + 1) / (2 * SMOOTH + 1)
    ext = np.concatenate([mean[-SMOOTH:], mean, mean[:SMOOTH]])  # circolare: dicembre continua in gennaio
    smooth = np.apply_along_axis(lambda s: np.convolve(s, k, mode="valid"), 0, ext)
    smooth = smooth[:, :, ::-1, :]  # righe da sud a nord, come le altre griglie del progetto
    out = {
        "source": "NCEP/NCAR Reanalysis 1 (NOAA PSL), media 1991-2020 ogni 6 ore, smussata ±15 giorni",
        "hours": [0, 6, 12, 18],  # UTC
        "lat0": 90 - 2.5 * LAT_I[1],
        "lon0": 2.5 * LON_I[0],
        "dlat": 2.5,
        "dlon": 2.5,
        "ny": smooth.shape[2],
        "nx": smooth.shape[3],
        # [giorno dell'anno 0..364, 1 gennaio = 0][ora 0/6/12/18 UTC][riga da sud][colonna da ovest], °C, un decimale
        "t850": np.round(smooth, 1).tolist(),
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"scritto {OUT} ({OUT.stat().st_size / 1024:.0f} kB)", file=sys.stderr)


if __name__ == "__main__":
    main()
