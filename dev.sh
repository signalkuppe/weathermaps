#!/bin/sh
# Starts the local server using the project's virtual environment (no need to activate it).
# Usage: ./dev.sh            -> http://localhost:8000
#        PORT=8001 ./dev.sh  -> another port
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "Virtual environment missing: create it with"
  echo "  python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt"
  exit 1
fi
exec .venv/bin/python -m uvicorn app.main:app --reload --port "${PORT:-8000}"
