# Weathermaps

Mappe delle precipitazioni e della temperatura a 850 hPa previste da otto modelli sul Nord Italia, sopra OpenStreetMap / OpenTopoMap (all'avvio sempre la mappa con il rilievo):

| Modello | Fonte | Risoluzione | Orizzonte | Corse |
|---|---|---|---|---|
| GFS | NOAA/NCEP | 0.25° | +192h | 00/06/12/18 |
| ECMWF IFS | ECMWF Open Data | 0.1° | +192h | 00/12 |
| ICON-2I | ItaliaMeteo (MeteoHub) | 2.2 km | +72h | 00/12 |
| WRF | ItaliaMeteo, CIMA, LaMMA (MeteoHub) | 1.5 km | +72h | 00/12 |
| ICON-D2 | DWD Open Data | 2.2 km | +48h | ogni 3 ore |
| AROME (solo precipitazione) | Météo-France Open Data | 0.025° (~2.5 km) | +51h | ogni 3 ore |
| ICON-CH2-EPS (controllo) | MeteoSvizzera | ~2 km | +120h | ogni 6 ore |
| ICON-CH1-EPS (controllo) | MeteoSvizzera | ~1 km | +33h | ogni 3 ore |
| **Media modelli** | calcolata | ~2 km | fino a +192h | — |

La **media** è costruita per istante di validità da un orario comune T0 (inizio della corsa completa più recente, arrotondato alle 6 ore): per ogni modello si usa l'ultima corsa completa partita non dopo T0; la pioggia è la somma delle medie di ogni intervallo (così Totale e Intervallo restano coerenti quando un modello a breve scadenza esce), la temperatura è la media dei valori. In ogni passo la pagina indica quali modelli sono nella media.

- Grandezze: **Precipitazione** (classifica delle località dalla più piovosa) e **Temperatura a 850 hPa** (classifica dal più freddo)
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
| `SCHEDULER_ENABLED` | `1` | Aggiornamento automatico |
| `SCHEDULER_INTERVAL_MIN` | `10` | Frequenza aggiornamento |
| `APP_VERSION` | dai tag git | Versione mostrata accanto al nome: di norma `git describe` (`v1.2.0` sul tag, `v1.2.0+3` tre commit dopo); da impostare dove non c'è `.git`, per esempio nell'immagine Docker. Senza tag non si mostra |

## Località preferite

Le località sulla mappa le sceglie chi usa il sito: nella sezione **Località** del pannello si cercano per nome e
si aggiungono, poi con **Modifica** si rinominano o si eliminano (al massimo 20). Si parte senza località.
Sulla mappa ognuna ha il valore previsto e un numero in base alla classifica (1 = più pioggia o più freddo);
il valore è quello del punto di griglia più vicino, calcolato nel browser, quindi funziona anche sul sito statico.

- **Salvataggio:** nel browser (`localStorage`, chiave `weathermaps.places.v1`), quindi restano su quel browser
  e quel dispositivo. In navigazione privata o con i dati del sito bloccati le modifiche durano finché resti sulla pagina.
- **Ricerca:** [Photon](https://photon.komoot.io) (geocoder su dati OpenStreetMap), limitata all'area della mappa
  e a località abitate, cime e passi (`osm_tag=place`, `natural:peak`, `mountain_pass`).
  Il testo cercato viene inviato a quel servizio.

## Cambiare area

Imposta `BBOX` e riavvia. I dati della vecchia area vengono eliminati e la nuova viene scaricata al primo giro. Il frontend legge l'area da `/api/meta`, quindi non va toccato.

## Aggiungere una grandezza

Aggiungi una `Variable` in `app/variables.py` con:
- i selettori GRIB per modello: per GFS il nome NOMADS `var`/`level` (es. `TMP`, `2_m_above_ground`), per ECMWF `param`/`levtype` delle righe `.index` (es. `2t`, `sfc`), più `short_name` del messaggio decodificato;
- la conversione di unità e la scala colori;
- il tipo: `accum` (totale/intervallo) o `instant` (solo valore).

Fetcher, API e frontend la gestiscono senza altre modifiche; il selettore "Grandezza" compare quando ce n'è più d'una. Per il vento (`vector`) servirà un renderer a frecce dedicato.

## Pubblicazione gratuita su GitHub Pages

Il workflow `.github/workflows/pages.yml` gira una volta all'ora su GitHub Actions:
recupera dalla cache i dati già scaricati, scarica solo i passi nuovi (`scripts/fetch_once.py`),
genera il sito statico (`scripts/build_static.py`) e lo pubblica su GitHub Pages.
Nel sito statico la modalità Intervallo è calcolata nel browser e il pulsante "Aggiorna"
ricarica i dati pubblicati (il download vero avviene una volta all'ora).

### Perché una volta all'ora, con un avvio esterno

- **Una volta all'ora basta.** I modelli più frequenti (ICON-D2, ICON-CH1, AROME) hanno una corsa ogni 3 ore,
  gli altri ogni 6 o 12, e i dati escono 2–8 ore dopo l'inizio della corsa: con un giro all'ora una corsa nuova
  compare al massimo un'ora dopo la pubblicazione. Più spesso servirebbe solo a vedere prima i passi
  di una corsa ancora parziale.
- **Il cron di GitHub non è affidabile.** GitHub tratta gli avvii programmati come "best effort": sotto carico
  li ritarda o li scarta senza lasciare traccia. Nelle prime 15 ore di vita del repository, con un cron ogni
  30 minuti, è partito un solo avvio su circa trenta.
- **Quindi l'avvio vero arriva da fuori.** Un servizio esterno ([cron-job.org](https://cron-job.org), gratuito)
  chiama una volta all'ora l'API di GitHub per avviare il workflow (`workflow_dispatch`). Il cron nel workflow
  (`17 * * * *`, lontano dall'ora piena, che è il momento più carico) resta come riserva. Se partono entrambi,
  il gruppo di `concurrency` li mette in fila e il secondo giro trova poco o nulla da scaricare.

Configurazione dell'avvio esterno:

1. Su GitHub crea un token *fine-grained* (Settings → Developer settings → Personal access tokens →
   Fine-grained tokens) con accesso al solo repository `weathermaps` e il solo permesso
   **Actions: Read and write**. Annota la scadenza: alla scadenza l'avvio esterno si ferma.
2. Su cron-job.org crea un job:
   - URL: `https://api.github.com/repos/signalkuppe/weathermaps/actions/workflows/pages.yml/dispatches`
   - Metodo: `POST`, pianificazione: ogni ora (per esempio al minuto 47, sfalsato rispetto al cron di riserva)
   - Intestazioni: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - Corpo: `{"ref":"main"}`
3. Risposta attesa: `204 No Content`. Un `401` o `403` indica un token scaduto o senza il permesso Actions.

Prova da terminale, con lo stesso token:

```bash
curl -i -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/signalkuppe/weathermaps/actions/workflows/pages.yml/dispatches \
  -d '{"ref":"main"}'
```

Prova in locale:

```bash
python scripts/build_static.py public
cd public && python -m http.server 8090   # http://localhost:8090
```

Nota: GitHub disattiva il workflow di un repository pubblico dopo 60 giorni senza commit, e da quel momento
fallisce anche l'avvio esterno (risposta di errore su cron-job.org); basta riattivarlo dalla scheda Actions.

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
- WRF: [MeteoHub](https://meteohub.agenziaitaliameteo.it/nwp/), servizio "singola variabile"; si leggono solo le intestazioni dei messaggi GRIB2 e si scaricano i passi necessari. Griglia Lambert riportata su ~1.6 km con il punto più vicino.
- MOLOCH (CNR-ISAC, 1.5 km): supportato da `app/sources/meteohub.py` ma escluso per ora, perché fornisce la pioggia ora per ora (~430 MB per corsa da un server lento); le istruzioni per riattivarlo sono nel modulo.
- DWD: [Open Data ICON-D2](https://opendata.dwd.de/weather/nwp/icon-d2/), griglia regolare 0.02°.
- Météo-France: [Paquets AROME 0,025°](https://www.data.gouv.fr/datasets/paquets-arome-resolution-0-025/), Licence Ouverte Etalab 2.0. Solo precipitazione (paquet SP1, a blocchi di 6 ore): si leggono le intestazioni GRIB2 e si scaricano solo i messaggi necessari. I dati validi finiscono fra 13°E (a 42°N) e 14,5°E (a 49°N).
- MeteoSvizzera: [Open Data ICON-CH1/CH2-EPS](https://opendatadocs.meteoswiss.ch/e-forecast-data/e2-e3-numerical-weather-forecasting-model), licenza CC-BY. I campi sono su griglia ICON non strutturata e vengono riportati su una griglia regolare di ~2.2 km (punto del modello più vicino); le coordinate della griglia si scaricano una volta in `DATA_DIR/static`.
- Mappe: © OpenStreetMap contributors, OpenTopoMap (CC-BY-SA), etichette CARTO
