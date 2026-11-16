"""Radiosondaggi osservati (i palloni lanciati dalle stazioni, 00 e 12 UTC) intorno al Nord Italia.

Fonte: University of Wyoming, Department of Atmospheric Science (weather.uwyo.edu): profilo di ogni lancio in testo
(TEXT:LIST). Il servizio è gratuito e spesso risponde "troppo occupato" (503): si riprova qualche volta con una pausa e,
se non va, al giro successivo; intanto restano i lanci già scaricati.

Ogni lancio è un JSON in `{root}/soundings/{stazione}/{AAAAMMGGHH}.json` con i livelli
[pressione hPa, quota m, temperatura °C, rugiada °C, direzione vento °, velocità km/h]; si tengono gli ultimi giorni.
Un lancio che dopo `GIVE_UP` ore non c'è ancora (stazioni che lanciano una volta al giorno, o lancio saltato) si segna
con un file `.none` e non si chiede più.
"""
from __future__ import annotations

import html
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from .store import Store

log = logging.getLogger(__name__)

URL = "https://weather.uwyo.edu/wsgi/sounding"
KEEP_DAYS = 3  # lanci da tenere
LOOKBACK_H = 36  # lanci da cercare all'indietro a ogni giro
GIVE_UP = 18  # ore dopo il lancio oltre le quali non lo si cerca più
DELAY = timedelta(hours=2)  # i dati arrivano circa un'ora e mezza dopo il lancio (00/12 UTC)
TRIES = 3  # tentativi per richiesta (503 frequenti)
BUDGET = 180  # secondi al massimo per giro: il resto al giro dopo (la pubblicazione oraria non deve allungarsi)


@dataclass(frozen=True)
class Station:
    id: str  # codice WMO
    name: str
    lat: float
    lon: float


STATIONS = [
    Station("16064", "Novara Cameri", 45.53, 8.67),
    Station("16113", "Cuneo Levaldigi", 44.54, 7.62),
    Station("16045", "Udine Rivolto", 45.98, 13.05),
    Station("16144", "San Pietro Capofiume", 44.65, 11.62),
    Station("06610", "Payerne", 46.81, 6.94),
    Station("10868", "Monaco di Baviera", 48.24, 11.55),
    Station("10739", "Stoccarda", 48.83, 9.20),
    Station("14015", "Lubiana", 46.07, 14.52),
    Station("14430", "Zara", 44.10, 15.35),
    Station("07645", "Nîmes", 43.86, 4.41),
]
BY_ID = {s.id: s for s in STATIONS}
MS_TO_KMH = 3.6  # il servizio dà m/s (SPED): ×3.6 in km/h


def _dir(store: Store) -> Path:
    return store.root / "soundings"


def parse(text: str) -> list[list[float | None]]:
    """Livelli dalla pagina TEXT:LIST: la tabella fra le righe di trattini dopo l'intestazione PRES HGHT TEMP..."""
    t = html.unescape(re.sub(r"<[^>]+>", "\n", text))
    i = t.find("PRES   HGHT   TEMP")
    if i < 0:
        return []
    lines = t[i:].splitlines()
    out = []
    started = False
    for line in lines[1:]:
        if line.startswith("-----"):
            if started:
                break
            started = True
            continue
        if not started or not line.strip():
            continue
        if not line.strip()[0].isdigit():
            break
        cols = [line[k:k + 7].strip() for k in range(0, 77, 7)]  # colonne larghe 7 caratteri
        num = [float(c) if c else None for c in cols]
        pres, hght, temp, dwpt, _rh, _mixr, drct, sped = num[:8]
        if pres is None or pres < 100:  # oltre i 100 hPa non serve (il diagramma arriva lì)
            continue
        out.append([pres, hght, temp, dwpt, drct, None if sped is None else round(sped * MS_TO_KMH, 1)])
    return out


def _get(client: httpx.Client, params: dict) -> str | None:
    for k in range(TRIES):
        try:
            r = client.get(URL, params=params)
            if r.status_code == 200:
                return r.text
            if r.status_code == 404:
                return ""  # il servizio non ha quel lancio (non ancora, o mai): come una pagina senza tabella
            if r.status_code not in (502, 503, 504):
                return None
        except httpx.TransportError:
            pass
        time.sleep(2 + 3 * k)
    return None


def launches(now: datetime) -> list[datetime]:
    """Lanci (00 e 12 UTC) delle ultime LOOKBACK_H ore i cui dati dovrebbero già esserci, dal più recente."""
    t = (now - DELAY).replace(minute=0, second=0, microsecond=0)
    t = t.replace(hour=12 if t.hour >= 12 else 0)
    out = []
    while t >= now - timedelta(hours=LOOKBACK_H):
        out.append(t)
        t -= timedelta(hours=12)
    return out


def update(store: Store, now: datetime | None = None) -> dict:
    """Scarica i lanci mancanti di tutte le stazioni e toglie i vecchi. Ritorna un riassunto."""
    now = now or datetime.now(timezone.utc)
    base = _dir(store)
    got = missing = failed = 0
    deadline = time.monotonic() + BUDGET
    with httpx.Client(timeout=40, headers={"User-Agent": "weathermaps-soundings"}, follow_redirects=True) as client:
        for st in STATIONS:
            d = base / st.id
            d.mkdir(parents=True, exist_ok=True)
            for t in launches(now):
                key = t.strftime("%Y%m%d%H")
                if (d / f"{key}.json").exists() or (d / f"{key}.none").exists():
                    continue
                if time.monotonic() > deadline:
                    failed += 1  # tempo finito: al prossimo giro
                    continue
                text = _get(client, {"datetime": t.strftime("%Y-%m-%d %H:%M:%S"), "id": st.id,
                                     "type": "TEXT:LIST", "src": "UNKNOWN"})
                if text is None:
                    failed += 1  # servizio non raggiungibile: si riprova al prossimo giro
                    continue
                levels = parse(text)
                if len(levels) < 5:
                    if now - t > timedelta(hours=GIVE_UP):
                        (d / f"{key}.none").write_text("")  # lancio che non arriverà più
                    missing += 1
                    continue
                body = {"station": st.id, "name": st.name, "lat": st.lat, "lon": st.lon, "time": key,
                        "levels": levels}
                (d / f"{key}.json").write_text(json.dumps(body, separators=(",", ":")))
                got += 1
            # via i lanci più vecchi di KEEP_DAYS
            cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y%m%d%H")
            for p in d.iterdir():
                if p.stem < cutoff:
                    p.unlink(missing_ok=True)
    return {"soundings": got, "missing": missing, "failed": failed}


def index(store: Store) -> list[dict]:
    """Stazioni con i loro lanci disponibili (dal più recente)."""
    base = _dir(store)
    out = []
    for st in STATIONS:
        d = base / st.id
        times = sorted((p.stem for p in d.glob("*.json")), reverse=True) if d.exists() else []
        out.append({"id": st.id, "name": st.name, "lat": st.lat, "lon": st.lon, "times": times})
    return out


def load(store: Store, station: str, key: str) -> dict | None:
    p = _dir(store) / station / f"{key}.json"
    if station not in BY_ID or not re.fullmatch(r"\d{10}", key) or not p.exists():
        return None
    return json.loads(p.read_text())
