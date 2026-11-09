#!/bin/sh
# Avvia il server in locale usando l'ambiente virtuale del progetto (non serve attivarlo).
# Uso: ./dev.sh            -> http://localhost:8000
#      PORT=8001 ./dev.sh  -> altra porta
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "Ambiente virtuale mancante: crealo con"
  echo "  python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt"
  exit 1
fi
exec .venv/bin/python -m uvicorn app.main:app --reload --port "${PORT:-8000}"
