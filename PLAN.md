# Webapp mappe precipitazioni GFS / ECMWF sul Nord Italia

## Contesto

Si vuole una webapp che mostri su una base OpenStreetMap la precipitazione prevista dai modelli GFS (NOAA) e ECMWF IFS, sul Nord Italia e i settori confinanti (Svizzera, Austria occidentale, Francia SE, Slovenia, Croazia nord), fino a +192h, con selettore modello / corsa / istante, overlay semitrasparente sopra il terreno e le località, valore in mm al passaggio del mouse. Due modalità: **totale da inizio corsa** fino all'istante scelto e **pioggia dell'intervallo** (3h o 6h). Deve girare in locale e poi su Railway.

La cartella `/Users/signalkuppe/projects/weathermaps` è vuota: progetto greenfield, nessun codice esistente da riusare.

### Fatti verificati oggi (2026-11-09) con download reali

- **GFS 0.25°** via filtro NOMADS con sottodominio, nessuna chiave:
  `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.YYYYMMDD%2FHH%2Fatmos&file=gfs.tHHz.pgrb2.0p25.fFFF&var_APCP=on&lev_surface=on&subregion=&toplat=49&leftlon=4&rightlon=17&bottomlat=42`
  Risposta 3–4 KB, griglia 53×29 (lat 42→49, lon 4→17), unità kg m⁻² (= mm). Ogni file contiene **due messaggi**: il bucket (es. `18-24`) e il **totale da inizio corsa** (`0-24`); a f003/f006 i due coincidono. Si usa sempre il messaggio con stepRange `0-N`. Corse 00/06/12/18, passi 3h fino a 240h.
- **ECMWF Open Data IFS 0.1°** (nuovo da ottobre 2026), nessuna chiave, licenza CC-BY-4.0:
  `https://data.ecmwf.int/forecasts/YYYYMMDD/HHz/ifs/0p1/oper/YYYYMMDDHH0000-{step}h-oper-fc-sfc.grib2` con `.index` a fianco (una riga JSON per campo con `_offset`/`_length`). Il campo `tp` si scarica con una `Range:` request (HTTP 206, ~1.8 MB), griglia globale 3600×1801 regular_ll passo 0.1°, lat 90→-90, lon 0→359.9, **unità m**, stepRange `0-N` (accumulato da inizio corsa). Passi 00z/12z: 0–144 ogni 3h, 150–360 ogni 6h; 06z/18z si fermano a 144h. Retention sul server ~3–4 giorni. Esce circa 2h dopo lo 0.25° (00z disponibile verso le 08–09 UTC).
- Sul Mac: Python 3.15 (Homebrew), ecCodes 2.45 CLI (`grib_ls`), Node 24. Nessun pacchetto Python installato: si usa un venv.
- File di esempio già scaricati in `/private/tmp/claude-501/-Users-signalkuppe-projects-weathermaps/0850814a-e95d-4de9-b46a-68aacc2462fa/scratchpad/dl/` (`gfs_f024.grb`, `ec_tp24.grb` 0.25°, `ec01_tp24.grb` 0.1°): da copiare in `tests/fixtures/` come fixture.

## Requisiti di estensibilità

Due evoluzioni sono previste fin dall'inizio e guidano il design:

1. **Altre grandezze in seguito** (es. neve, temperatura a 2 m, vento, pressione, CAPE). Nessun codice deve essere "cablato" sulla precipitazione: la grandezza è un oggetto di configurazione e tutto il resto (fetch, storage, API, frontend) la tratta in modo generico.
2. **Area della mappa modificabile** (allargare, spostare, cambiare regione). Il box geografico vive in un unico punto di configurazione e viene propagato a URL di download, crop, metadati API e bounds del frontend; cambiare area non deve richiedere modifiche al codice, solo rifetch dei dati.

### Registro delle grandezze (`app/variables.py`)

Ogni grandezza è una `dataclass Variable` con:
- `id` (es. `tp`), `label`, `units` di presentazione (es. `mm`)
- `kind`: `accum` (accumulata da inizio corsa: ammette modalità totale/intervallo), `instant` (es. T2m, vento: solo valore all'istante), `vector` (u/v: due componenti, per il futuro vento)
- per modello, come selezionare il campo nel GRIB: `gfs=GribSelector(var="APCP", level="surface", step_range_prefix="0-")`, `ecmwf=GribSelector(param="tp", levtype="sfc")`
- `convert`: funzione unità GRIB → unità di presentazione (ECMWF tp: m → mm; T2m: K → °C)
- `scale`: soglie e colori della legenda, più `transparent_below`
- `steps`: opzionale, se la grandezza ha una disponibilità temporale diversa

Il registro iniziale contiene solo `tp`. Aggiungere una grandezza = aggiungere una voce al registro (più eventuale test con una fixture). I selettori GRIB alimentano direttamente i parametri `var_*`/`lev_*` del filtro NOMADS e il match sulle righe `.index` di ECMWF, quindi il fetch non cambia.

### Area configurabile (`app/config.py`)

- `BBOX` letto da env `BBOX="lat_min,lat_max,lon_min,lon_max"` (default `42,49,4,17`), validato all'avvio.
- Da `BBOX` derivano: parametri `toplat/bottomlat/leftlon/rightlon` del filtro NOMADS, indici di crop dell'ECMWF (gestendo il caso in cui il box attraversa il meridiano 0, con longitudini 0–360 del GRIB: si concatena la fetta ovest e quella est), bounds dell'overlay e `maxBounds`/centro iniziale della mappa.
- Il frontend **non contiene coordinate**: legge griglia e bounds da `/api/meta` e da `grid` in ogni risposta `/api/field`.
- I dati salvati includono il box nel `meta.json`; se all'avvio il `BBOX` configurato è diverso da quello dei dati su disco, la corsa viene scartata e riscaricata (il namespace di storage include un hash del box, vedi `store.py`).

## Decisioni

- **Stack**: backend Python (FastAPI + uvicorn, `eccodes` da pip con libreria binaria inclusa, numpy, httpx, APScheduler). Frontend statico vanilla JS + Leaflet 1.9 da CDN, nessun build step. Un solo processo serve API e frontend: su Railway diventa un solo servizio.
- **Dominio iniziale**: lat 42–49 N, lon 4–17 E, configurabile via `BBOX` (vedi sopra).
- **Modelli**: `gfs` (0.25°) e `ecmwf` (0.1°). Corse: GFS 00/06/12/18, ECMWF solo 00/12 (le 06/18 non arrivano a 192h). Retention locale: ultime 3 corse per modello.
- **Passi comuni** a entrambi i modelli per avere uno slider coerente nel confronto: 3,6,…,144 poi 150,156,…,192 (56 passi). Il GFS avrebbe anche i 3h fra 144 e 192: si scartano.
- **Il server memorizza solo i totali da inizio corsa**; l'intervallo è la differenza fra il totale al passo e quello al passo precedente, calcolata dal server su richiesta (`mode=interval`).
- **Rendering lato client** su canvas: le griglie sono piccole (GFS 53×29, ECMWF 131×71 ≈ 9.300 valori ≈ 40 KB JSON gzip-ato), quindi niente tile PNG server-side. Questo permette tooltip puntuale, scala colori e opacità regolabili senza rigenerare immagini.

## Struttura del progetto

```
weathermaps/
  app/
    __init__.py
    config.py        BBOX (da env), STEPS, DATA_DIR (env, default ./data), RETENTION=3, URL template
    variables.py     registro Variable (vedi sopra); inizialmente solo `tp`
    grid.py          decode_grib(bytes) -> list[Field] ; crop(field, bbox) ; select(fields, selector)
    sources/gfs.py   url(run, step, selector), fetch(run, step, variable) -> Field
    sources/ecmwf.py index + byte-range fetch per selector, crop globale ; fetch(run, step, variable)
    store.py         save/load per (model, run, variable, step) in
                     DATA_DIR/{bbox_hash}/{model}/{run}/{var}/{step}.npy + meta.json ;
                     list_runs() ; purge(retention)
    fetcher.py       update_model(model): per ogni corsa candidata e ogni variabile del registro
                     scarica i passi mancanti in modo idempotente, con retry/backoff, sequenziale
    scheduler.py     APScheduler: job ogni 10 min per modello, avvio all'startup
    api.py           route /api/*
    main.py          crea FastAPI, GZipMiddleware, mount static, startup scheduler
  static/
    index.html  app.js  style.css
  tests/
    fixtures/ (gfs_f024.grb, ec_tp24.grb, ec01_tp24.grb)
    test_grid.py  test_api.py
  scripts/fetch_once.py    popola DATA_DIR per l'ultima corsa disponibile, poi esce
  requirements.txt  Dockerfile  railway.json  .env.example  .gitignore  README.md
```

## Backend: dettagli

### `grid.py`
- `decode_grib(data: bytes) -> list[Field]`: itera i messaggi con `eccodes.codes_new_from_message`, legge `shortName`, `stepRange`, `units`, `Ni`, `Nj`, lat/lon del primo punto e incrementi, flag di scansione; ricostruisce `values.reshape(Nj, Ni)` e normalizza sempre a **lat crescente (sud→nord), lon crescente**. Converte `m` → mm (×1000). Restituisce anche `step_range`.
- `crop(field, bbox)`: slicing per indici, gestendo lon 0–360 dell'ECMWF (il box 4–17 E non attraversa il meridiano 0, quindi basta `lon_idx = round(lon/0.1)`).
- `select_total(fields)`: sceglie il messaggio con `stepRange` che inizia per `0-` (GFS ne ha due).

### `sources/gfs.py`
- Costruisce l'URL NOMADS verificato sopra; `fFFF` a tre cifre.
- `run_available(run)`: HEAD/GET sul file dello step 192 (se c'è, la corsa è completa fino a 192h). Alternativa più reattiva: scaricare i passi via via che compaiono; si adotta questa (fetch dei passi mancanti, il run diventa "completo" quando ci sono tutti i 56 passi; l'API espone anche run parziali con la lista dei passi presenti).
- Nessun campo nel file = NOMADS restituisce HTML di errore: controllare che i primi 4 byte siano `GRIB`.

### `sources/ecmwf.py`
- Scarica `.index`, trova la riga con `"param": "tp"`, fa GET con header `Range: bytes=off-(off+len-1)`, verifica 206 e primi byte `GRIB`.
- Crop globale 0.1° al box: colonne 40–170, righe corrispondenti a lat 42–49 dopo la normalizzazione sud→nord.
- 404 su index = passo non ancora pubblicato: non è errore, si riprova al prossimo giro.

### `store.py`
- `DATA_DIR/{model}/{YYYYMMDDHH}/{step:03d}.npy` (float32 mm) + `DATA_DIR/{model}/{YYYYMMDDHH}/meta.json` con griglia (lat0, lon0, dlat, dlon, nx, ny), passi presenti, timestamp.
- `purge()`: tiene le ultime 3 corse per modello.

### `fetcher.py` / `scheduler.py`
- Corse candidate = ultimi 3 cicli del modello calcolati da `now UTC` (GFS ogni 6h, ECMWF ogni 12h) partendo da ~4h (GFS) e ~8h (ECMWF 0.1°) dopo il run time.
- Per ogni corsa candidata scarica i passi mancanti in sequenza (gentile con NOMADS), max 2–3 tentativi con backoff, timeout 30 s. Un lock evita job sovrapposti.
- Job all'avvio del server (in background, il server risponde subito) e poi ogni 10 minuti. Disattivabile con `SCHEDULER_ENABLED=0` (utile nei test).

### `api.py`
- `GET /api/health` → `{ok: true}` (healthcheck Railway).
- `GET /api/meta` → `{ bbox, steps, models:[{id,label,resolution}], variables:[{id,label,units,kind,scale,modes}] }`: il frontend costruisce da qui selettori, legenda e bounds, senza costanti cablate.
- `GET /api/runs` → `{ gfs: [{run, variables:{tp:{steps:[...], complete}}}], ecmwf: [...] }`, ordinate dalla più recente.
- `GET /api/field?model=gfs|ecmwf&var=tp&run=YYYYMMDDHH&step=24&mode=total|interval` → `{model, var, run, step, prev_step, valid_time, mode, units, grid:{lat0,lon0,dlat,dlon,nx,ny}, values:[...]}` row-major sud→nord, valori arrotondati alla precisione della variabile, `null` dove mancante. `mode` ammesso solo per variabili `accum`; `interval` = totale(step) − totale(passo precedente nella lista comune), clamp a ≥0. 404 se il passo non c'è ancora, 400 se var/mode non validi.
- Cache-Control: `max-age=600` su `/api/runs`, `immutable` lunga su `/api/field` (i dati di una corsa non cambiano).

### `main.py`
- `GZipMiddleware`, `StaticFiles` su `/` con `index.html`, porta da env `PORT` (Railway) default 8000.

## Frontend: dettagli (`static/`)

- **Bootstrap**: al caricamento legge `/api/meta` e `/api/runs`; da lì popola selettore modello, selettore grandezza (nascosto finché c'è una sola voce), legenda (soglie/colori della `scale` della variabile), modalità ammesse (`modes`), bounds e centro della mappa. Nessuna coordinata, soglia o nome di variabile scritto nel JS.
- **Mappa Leaflet** centrata sul box ricevuto da `/api/meta`, `maxBounds` leggermente più ampi del box. Due basemap selezionabili con `L.control.layers`: OSM standard (località, strade) e OpenTopoMap (rilievo + località), entrambe con attribuzione corretta.
- **Overlay**: canvas renderizzato lato client e mostrato come `L.imageOverlay` con bounds presi dalla `grid` della risposta (oggi `[[42,4],[49,17]]`). Per evitare la distorsione Mercatore sui 7° di latitudine, l'immagine viene generata con altezza in pixel proporzionale alla proiezione: per ogni riga del canvas si calcola la lat tramite l'inversa di Mercatore fra 42 e 49 e si campiona la riga di griglia corrispondente. Upscale ×4 con interpolazione bilineare manuale per un aspetto fluido ma fedele (opzione "celle nette" nel menu). Slider opacità (default 0.55). Pixel con valore sotto 0.1 mm completamente trasparenti così il terreno resta visibile dove non piove.
- **Scala colori** definita dalla variabile (`scale` in `/api/meta`), discreta, con legenda. Per `tp`: 0.1–1, 1–2, 2–5, 5–10, 10–20, 20–30, 30–50, 50–75, 75–100, 100–150, 150–200, >200 mm. Il renderer è generico: riceve soglie, colori e `transparent_below`, quindi una grandezza futura (es. T2m con scala divergente) non richiede modifiche al codice di disegno.
- **Controlli** (pannello in alto a sinistra): selettore modello (GFS 0.25° / ECMWF 0.1°), selettore corsa (da `/api/runs`, default la più recente completa), slider passo con pulsanti ◀ ▶, frecce tastiera e Play/Pausa (~600 ms per frame), toggle Totale / Intervallo, slider opacità. Testo con ora di validità in locale (Europe/Rome) e UTC, e ampiezza intervallo (3h o 6h).
- **Tooltip** su `mousemove`: valore in mm del punto di griglia più vicino al cursore (nearest neighbour sulla griglia nativa, non sull'immagine interpolata), con lat/lon. Mostra "—" fuori dal box.
- **Cache client** `Map` per (model, run, step, mode) e prefetch del passo successivo e precedente, così lo scorrimento è istantaneo.
- Stato (modello, grandezza, corsa, passo, modalità, opacità, basemap) nell'hash dell'URL per poter condividere una vista.

## Come si estende in seguito (promemoria operativo)

- **Nuova grandezza**: aggiungere una `Variable` in `app/variables.py` con selettori GFS/ECMWF, conversione unità e scala colori; aggiungere una fixture GRIB e un test in `tests/test_grid.py`. Il fetcher la scarica al prossimo giro, l'API la espone, il frontend mostra il selettore grandezza. Nota per il futuro: le variabili `instant` non hanno modalità intervallo; le `vector` (vento) richiederanno un renderer dedicato (frecce o barbe), previsto come secondo tipo di layer accanto a quello a celle colorate.
- **Nuova area**: cambiare `BBOX` nell'env (locale: `.env`; Railway: variabile del servizio) e riavviare; i dati vecchi restano in una cartella separata per hash e vengono eliminati dalla purge. Il frontend si adatta da solo. Vincoli: il box deve stare dentro la griglia dei modelli (globali, quindi sempre) e la dimensione della griglia ECMWF 0.1° cresce con l'area (10 000 punti per 10°×10°: fino a circa 30°×30° il JSON per passo resta sotto 1 MB gzip-ato; oltre, valutare float16 binario o tile).

## Deploy

- **Locale**: `python -m venv .venv && pip install -r requirements.txt`, `python scripts/fetch_once.py` per popolare, `uvicorn app.main:app --reload`, apri `http://localhost:8000`.
- **Docker/Railway**: `Dockerfile` da `python:3.12-slim`, `pip install -r requirements.txt` (il wheel `eccodes` include la libreria), `CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT`. `railway.json` con `healthcheckPath: /api/health`. Variabili: `DATA_DIR=/data` con volume Railway montato su `/data` (altrimenti i dati si rigenerano al riavvio in ~10–15 minuti, accettabile anche senza volume). `git init` del progetto per il deploy via repo.

## Verifica

1. **Unit test** (`pytest`): `test_grid.py` decodifica le fixture e controlla shape (GFS 53×29; ECMWF 0.1° croppato 131×71), orientamento (lat crescente), unità (ECMWF convertito in mm, valori max plausibili), scelta del messaggio `0-N` sul GFS; un test di crop con un `BBOX` diverso (es. `44,47,6,12`) e uno con box che attraversa il meridiano 0 (es. `40,50,-5,10`) sul GRIB globale ECMWF. `test_api.py` con `TestClient` e `DATA_DIR` temporaneo popolato dalle fixture: `/api/meta`, `/api/runs`, `/api/field` total e interval, 404 su passo mancante, 400 su `var` sconosciuta; un test che registra una seconda `Variable` fittizia e verifica che compaia in `/api/meta` senza altre modifiche.
2. **Fetch reale**: `python scripts/fetch_once.py` sull'ultima corsa disponibile di entrambi i modelli, controllo che `DATA_DIR` contenga 56 file per corsa e che il log non mostri errori.
3. **Confronto puntuale**: per un passo, confronto il valore restituito da `/api/field` in un punto (es. Milano 45.46N 9.19E) con `grib_get -l 45.46,9.19,1` sul GRIB originale, tolleranza 0.1 mm.
4. **Browser** (claude-in-chrome): apro `http://localhost:8000`, verifico overlay allineato ai confini (Lago di Garda, costa ligure come riferimento visivo), cambio modello/corsa/passo/modalità, tooltip, opacità, basemap, play; controllo console senza errori.
5. **Docker**: `docker build` + `docker run -p 8000:8000 -e PORT=8000` e ripeto il punto 4 contro il container, prima del deploy su Railway.
