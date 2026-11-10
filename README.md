# Weathermaps

**App: <https://signalkuppe.github.io/weathermaps/>** (aggiornata una volta all'ora)

Mappe di precipitazione, temperatura a 850 hPa, neve e zero termico previste da otto modelli sul Nord Italia, sopra
OpenStreetMap (all'avvio) o OpenTopoMap con il rilievo, a scelta nelle impostazioni:

| Modello | Fonte | Risoluzione | Orizzonte | Corse |
|---|---|---|---|---|
| GFS | NOAA/NCEP | 0.25° | +192h | 00/06/12/18 |
| ECMWF IFS | ECMWF Open Data | 0.1° | +192h | 00/12 |
| ICON-2I | ItaliaMeteo (MeteoHub) | 2.2 km | +72h | 00/12 |
| WRF | ItaliaMeteo, CIMA, LaMMA (MeteoHub) | 1.5 km | +72h | 00/12 |
| ICON-D2 | DWD Open Data | 2.2 km | +48h | ogni 3 ore |
| AROME | Météo-France Open Data | 0.025° (~2.5 km) | +51h | ogni 3 ore |
| ICON-CH2-EPS (controllo) | MeteoSvizzera | ~2 km | +120h | ogni 6 ore |
| ICON-CH1-EPS (controllo) | MeteoSvizzera | ~1 km | +33h | ogni 3 ore |
| **Mediana modelli** | calcolata | ~2 km | fino a +192h | — |

Grandezze disponibili per modello:

| Modello | Pioggia | T 850 hPa | Neve | Zero termico |
|---|---|---|---|---|
| GFS | ✓ | ✓ | — (non pubblica la neve caduta) | ✓ |
| ECMWF | ✓ | ✓ | ✓ | — (non tra i dati aperti) |
| ICON-2I | ✓ | ✓ | ✓ | ✓ |
| WRF | ✓ | ✓ | — | — |
| ICON-D2 | ✓ | ✓ | ✓ | ✓ |
| AROME | ✓ | — | ✓ | — |
| ICON-CH2 / CH1 | ✓ | — | ✓ | ✓ |

La **neve** è in cm di neve fresca: i modelli danno l'acqua equivalente (mm), convertita col rapporto standard
10:1 (1 mm d'acqua = 1 cm di neve). È una stima: la neve umida si accumula meno, quella farinosa di più. Nei modelli ICON
è la somma della neve di griglia e di quella convettiva. Lo **zero termico** è la quota (m sul livello del mare) dell'isoterma 0 °C.

Di ogni modello si tiene e si mostra **solo l'ultima corsa completa**. Mentre la corsa successiva esce, la pagina
ne mostra l'avanzamento ("12Z in arrivo · 20/56 passi"); quando è completa prende il posto della precedente, che viene cancellata.

La **mediana dei modelli** è costruita per istante di validità da un orario comune T0 (inizio della corsa completa più recente, arrotondato alle 6 ore): per ogni modello si usa la sua ultima corsa completa, e un modello partito dopo T0 entra dai suoi primi passi. Per pioggia e neve il totale è la somma delle mediane di ogni intervallo (così Totale e Intervallo restano coerenti quando un modello a breve scadenza esce); per temperatura e zero termico è la mediana dei valori. La mediana, a differenza della media, non si lascia trascinare da un modello isolato molto diverso dagli altri; con due soli modelli le due coincidono. In ogni passo la pagina indica quali modelli sono nella mediana.

## Cosa fa la pagina

- **Grandezze:** Precipitazione e Neve (classifica delle località dalla più alta), Temperatura a 850 hPa e Zero termico
  (dal più basso), più la voce combinata **Precip. e zero termico**: la precipitazione a colori con sopra le isoipse
  dello zero termico, per i modelli che hanno entrambe le grandezze (GFS, ICON-2I, ICON-D2, ICON-CH1/CH2 e la mediana).
  Le voci combinate (`COMBOS` in `app/variables.py`) non hanno dati propri: la pagina chiede i due campi.
  Con le cumulate (3–24h) le isoipse mostrano lo **zero termico durante la precipitazione** (in pagina "Zero termico in 24h"): per ogni punto la media
  dei sotto-intervalli di 3 ore (o 6) del periodo, ognuno pesato con la pioggia caduta in esso e con lo zero termico
  medio fra i suoi estremi; dove nel periodo cadono meno di 0,1 mm si usa la media semplice. Con il Totale sono lo zero
  termico all'ora mostrata. Il calcolo è nel browser, con i campi già pubblicati (per "24h" circa 9 totali e 9 campi
  di zero termico, riusati dai passi vicini durante l'animazione).
- **Modalità** Totale (accumulo da inizio corsa) e cumulate su **3, 6, 12 o 24 ore** che finiscono all'ora mostrata
  (parametro `ore` nell'URL), con la durata sempre scritta: "Precipitazione in 24h" in legenda, nel riquadro delle
  località e nell'immagine condivisa. Sono differenze fra due totali, quindi non pesano sui dati pubblicati; oltre le
  +144h i passi sono ogni 6 ore e "3h" diventa 6h, all'inizio della corsa la cumulata parte da +0h.
- **Linee di livello** sopra i colori, con etichette: isoterme ogni 2 °C a 850 hPa (marcata quella di 0 °C) e isoipse
  dello zero termico ogni 250 m (marcate le migliaia). Sono calcolate nel browser dal campo (ammorbidito sulle griglie
  fini), si spengono nelle impostazioni e compaiono anche nell'immagine condivisa.
- **Contorni geografici** sopra i colori: coste, laghi, confini di stato e di provincia (Natural Earth 1:10m), più marcati
  quanto più alta è l'opacità, così i luoghi si riconoscono anche quando i colori coprono la mappa. Il file
  `static/borders.json` si rigenera con `scripts/make_borders.py` se cambia `BBOX`.
- **Navigazione:** modello, istante (slider, frecce ←/→, spazio = play), opacità regolabile, celle nette senza
  interpolazione. Su mobile c'è una barra in basso con ora, ‹ › ▶, modello e legenda compatta.
- **Legenda** orizzontale (titolo con unità, barra dei colori con le soglie), su desktop in basso a destra e su mobile
  nella barra.
- **Valore sotto il cursore** (desktop), con lo zero termico nella voce combinata; resta sempre dentro la finestra.
- **Condivisione:** riquadro di ritaglio a proporzioni fisse (4:3, 1:1, 16:9) su cui si sposta e ingrandisce la mappa,
  centrato all'apertura sulla posizione del dispositivo; intestazione con modello, corsa e ora, legenda, crediti e
  "Realizzato da signalkuppe.com"; interruttore per includere o no le località. Si condivide l'immagine, senza testo.
- **Stato nell'URL:** modello, grandezza, istante, modalità e opacità, quindi la vista si può condividere come link.
- **Versione** accanto al nome dell'app, dai tag git.

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
| `SCHEDULER_ENABLED` | `1` | Aggiornamento automatico |
| `SCHEDULER_INTERVAL_MIN` | `10` | Frequenza aggiornamento |
| `APP_VERSION` | dai tag git | Versione mostrata accanto al nome: di norma `git describe` (`v1.2.0` sul tag, `v1.2.0+3` tre commit dopo); da impostare dove non c'è `.git`, per esempio nell'immagine Docker. Senza tag non si mostra |

## Località preferite

Le località sulla mappa le sceglie chi usa il sito: nella sezione **Località preferite** del pannello si cercano per
nome e si aggiungono, poi con **Modifica** si rinominano o si eliminano (al massimo 20). Si parte senza località.
Sulla mappa ognuna ha un cerchio con il numero della classifica (1 = più pioggia o più freddo) e un'etichetta col
valore e l'unità (es. `2575m`); il valore è quello del punto di griglia più vicino, calcolato nel browser, quindi
funziona anche sul sito statico.

- **Etichette:** a destra del cerchio se c'è posto, altrimenti a sinistra, sopra o sotto, con un triangolino verso il
  cerchio; se nessun lato è libero resta solo il cerchio. La posizione si ricalcola a ogni zoom e cambio di dati.
- **Riquadro al click** (sul cerchio o sulla riga dell'elenco): nome, valore (e zero termico nella voce combinata) e ora,
  con la X per chiuderlo; sempre dentro la finestra, sotto pannello e barra.
- **Salvataggio:** nel browser (`localStorage`, chiave `weathermaps.places.v1`), quindi restano su quel browser
  e quel dispositivo; un nuovo deploy non le tocca. Si perdono cancellando i dati del sito; Safari cancella i dati dei
  siti non aperti da 7 giorni di utilizzo (non per le pagine aggiunte alla schermata Home). Quelle salvate in locale
  (`localhost`) non compaiono sul sito pubblicato e viceversa. In navigazione privata o con i dati del sito bloccati
  le modifiche durano finché resti sulla pagina.
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
- se il dato è la somma di più campi (es. neve ICON di griglia + convettiva), i selettori da aggiungere in `plus`;
- facoltativo, `contours` per le linee di livello sopra i colori (`step`, livelli marcati in `bold`, `signed` per il segno "+").

Per sovrapporre le linee di una grandezza ai colori di un'altra basta una riga in `COMBOS`.

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

- `GET /api/meta`: versione, area, passi, modelli, grandezze (anche le combinate) con scale colori e linee di livello
- `GET /api/runs`: per modello l'ultima corsa completa e, se c'è, quella in arrivo (`incoming`), con i passi scaricati
- `GET /api/field?model=gfs&var=tp&run=2026110906&step=24&mode=total|interval[&prev=12]`: griglia JSON (righe sud→nord);
  con `interval` la differenza col passo `prev` (default il precedente, `0` = dall'inizio della corsa)

## Fonti dati

- GFS: NOAA/NCEP via [NOMADS](https://nomads.ncep.noaa.gov/) (dominio pubblico)
- ECMWF: [Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data), licenza CC-BY-4.0
- ItaliaMeteo: [ICON-2I su MeteoHub](https://dati.agenziaitaliameteo.it/dataset/previsioni-meteorologiche-modello-icon-2i), licenza CC-BY, servizio "singola variabile" (si scaricano solo i messaggi dei passi necessari).
- WRF: [MeteoHub](https://meteohub.agenziaitaliameteo.it/nwp/), servizio "singola variabile"; si leggono solo le intestazioni dei messaggi GRIB2 e si scaricano i passi necessari. Griglia Lambert riportata su ~1.6 km con il punto più vicino.
- MOLOCH (CNR-ISAC, 1.5 km): supportato da `app/sources/meteohub.py` ma escluso per ora, perché fornisce la pioggia ora per ora (~430 MB per corsa da un server lento); le istruzioni per riattivarlo sono nel modulo.
- DWD: [Open Data ICON-D2](https://opendata.dwd.de/weather/nwp/icon-d2/), griglia regolare 0.02°.
- Météo-France: [Paquets AROME 0,025°](https://www.data.gouv.fr/datasets/paquets-arome-resolution-0-025/), Licence Ouverte Etalab 2.0. Precipitazione e neve (paquet SP1, a blocchi di 6 ore): si leggono le intestazioni GRIB2 e si scaricano solo i messaggi necessari. I dati validi finiscono fra 13°E (a 42°N) e 14,5°E (a 49°N).
- MeteoSvizzera: [Open Data ICON-CH1/CH2-EPS](https://opendatadocs.meteoswiss.ch/e-forecast-data/e2-e3-numerical-weather-forecasting-model), licenza CC-BY. I campi sono su griglia ICON non strutturata e vengono riportati su una griglia regolare di ~2.2 km (punto del modello più vicino); le coordinate della griglia si scaricano una volta in `DATA_DIR/static`.
- Mappe: © OpenStreetMap contributors, OpenTopoMap (CC-BY-SA)
- Contorni geografici: [Natural Earth](https://www.naturalearthdata.com/) 1:10m (pubblico dominio)
- Ricerca delle località: [Photon](https://photon.komoot.io) su dati OpenStreetMap
