# Weathermaps

Mappe delle precipitazioni e della temperatura a 850 hPa previste da sei modelli sul Nord Italia, sopra OpenStreetMap / OpenTopoMap (all'avvio sempre la mappa con il rilievo):

| Modello | Fonte | Risoluzione | Orizzonte | Corse |
|---|---|---|---|---|
| GFS | NOAA/NCEP | 0.25° | +192h | 00/06/12/18 |
| ECMWF IFS | ECMWF Open Data | 0.1° | +192h | 00/12 |
| ICON-2I | ItaliaMeteo (MeteoHub) | 2.2 km | +72h | 00/12 |
| ICON-D2 | DWD Open Data | 2.2 km | +48h | ogni 3 ore |
| ICON-CH2-EPS (controllo) | MeteoSvizzera | ~2 km | +120h | ogni 6 ore |
| ICON-CH1-EPS (controllo) | MeteoSvizzera | ~1 km | +33h | ogni 3 ore |
| **Media modelli** | calcolata | ~2 km | fino a +192h | — |

La **media** è costruita per istante di validità da un orario comune T0 (inizio della corsa completa più recente, arrotondato alle 6 ore): per ogni modello si usa l'ultima corsa completa partita non dopo T0; la pioggia è la somma delle medie di ogni intervallo (così Totale e Intervallo restano coerenti quando un modello a breve scadenza esce), la temperatura è la media dei valori. In ogni passo la pagina indica quali modelli sono nella media.

- Grandezze: **Precipitazione** (classifica punti dal più piovoso) e **Temperatura a 850 hPa** (classifica dal più freddo)
- Modalità **Totale** (accumulo da inizio corsa) e **Intervallo** (pioggia del passo da 3h o 6h)
- Selettore modello, corsa (attuale e precedente), istante (slider, frecce ←/→, spazio = play)
- Overlay semitrasparente con opacità regolabile, valore in mm sotto il cursore
- Vista condivisibile: lo stato è nell'URL

## Avvio in locale

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env              # opzionale
python scripts/fetch_once.py      # primo download (~5 min, poi incrementale)
uvicorn app.main:app --reload     # http://localhost:8000
```

In alternativa, senza attivare l'ambiente: `./dev.sh` (stesso server, http://localhost:8000).

Il server aggiorna i dati da solo ogni 10 minuti (`SCHEDULER_ENABLED=0` per disattivarlo).
Test: `pytest`.

## Configurazione (variabili d'ambiente)

| Variabile | Default | Significato |
|---|---|---|
| `BBOX` | `42,49,4,17` | Area: `lat_min,lat_max,lon_min,lon_max` (lon -180..180) |
| `INITIAL_VIEW` | `44.68,46.64,8.50,11.43` | Vista all'apertura (Lombardia), stesso formato, dentro `BBOX` |
| `DATA_DIR` | `./data` | Cartella dati |
| `RETENTION` | `2` | Corse tenute per modello (attuale + precedente) |
| `POINTS_FILE` | `points.json` | Punti fissi sulla mappa |
| `SCHEDULER_ENABLED` | `1` | Aggiornamento automatico |
| `SCHEDULER_INTERVAL_MIN` | `10` | Frequenza aggiornamento |

## Punti fissi

I punti sulla mappa, con il valore previsto e numerati in base alla classifica dei mm (1 = più pioggia), sono in `points.json` (`id`, `name`, `lat`, `lon` e, se serve, `label`: `right`, `left`, `above` o `below` per spostare il valore quando due punti sono vicini). Modifica il file e ricarica la pagina; il valore è quello del punto di griglia più vicino.

## Cambiare area

Imposta `BBOX` e riavvia. I dati della vecchia area vengono eliminati e la nuova viene scaricata al primo giro. Il frontend legge l'area da `/api/meta`, quindi non va toccato.

## Aggiungere una grandezza

Aggiungi una `Variable` in `app/variables.py` con:
- i selettori GRIB per modello: per GFS il nome NOMADS `var`/`level` (es. `TMP`, `2_m_above_ground`), per ECMWF `param`/`levtype` delle righe `.index` (es. `2t`, `sfc`), più `short_name` del messaggio decodificato;
- la conversione di unità e la scala colori;
- il tipo: `accum` (totale/intervallo) o `instant` (solo valore).

Fetcher, API e frontend la gestiscono senza altre modifiche; il selettore "Grandezza" compare quando ce n'è più d'una. Per il vento (`vector`) servirà un renderer a frecce dedicato.

## Pubblicazione gratuita su GitHub Pages

Il workflow `.github/workflows/pages.yml` gira ogni 30 minuti su GitHub Actions:
recupera dalla cache i dati già scaricati, scarica solo i passi nuovi (`scripts/fetch_once.py`),
genera il sito statico (`scripts/build_static.py`) e lo pubblica su GitHub Pages.
Nel sito statico la modalità Intervallo è calcolata nel browser e il pulsante "Aggiorna"
ricarica i dati pubblicati (il download vero avviene ogni 30 minuti).

Prova in locale:

```bash
python scripts/build_static.py public
cd public && python -m http.server 8090   # http://localhost:8090
```

Nota: GitHub sospende i workflow programmati di un repository pubblico dopo 60 giorni senza commit;
in quel caso basta riattivarlo dalla scheda Actions.

## Deploy su Railway

1. Crea un servizio dal repo: Railway usa `Dockerfile` e `railway.json` (health check su `/api/health`).
2. Aggiungi un **volume** montato su `/data` (il Dockerfile imposta già `DATA_DIR=/data`). Senza volume funziona lo stesso, ma dopo ogni deploy i dati si riscaricano.
3. Usa **una sola replica**: lo scheduler gira dentro il processo.
4. Genera un dominio pubblico. Railway imposta `PORT` in automatico.

## API

- `GET /api/meta`: area, passi, modelli, grandezze con scale colori
- `GET /api/runs`: corse disponibili e passi scaricati
- `GET /api/field?model=gfs&var=tp&run=2026110906&step=24&mode=total|interval`: griglia JSON (righe sud→nord)

## Fonti dati

- GFS: NOAA/NCEP via [NOMADS](https://nomads.ncep.noaa.gov/) (dominio pubblico)
- ECMWF: [Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data), licenza CC-BY-4.0
- ItaliaMeteo: [ICON-2I su MeteoHub](https://dati.agenziaitaliameteo.it/dataset/previsioni-meteorologiche-modello-icon-2i), licenza CC-BY, servizio "singola variabile" (si scaricano solo i messaggi dei passi necessari).
- DWD: [Open Data ICON-D2](https://opendata.dwd.de/weather/nwp/icon-d2/), griglia regolare 0.02°.
- MeteoSvizzera: [Open Data ICON-CH1/CH2-EPS](https://opendatadocs.meteoswiss.ch/e-forecast-data/e2-e3-numerical-weather-forecasting-model), licenza CC-BY. I campi sono su griglia ICON non strutturata e vengono riportati su una griglia regolare di ~2.2 km (punto del modello più vicino); le coordinate della griglia si scaricano una volta in `DATA_DIR/static`.
- Mappe: © OpenStreetMap contributors, OpenTopoMap (CC-BY-SA), etichette CARTO
