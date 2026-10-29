#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Creating Python environment..."
  python3 -m venv .venv
fi

.venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
echo ""
echo "  Chillian is running at http://${HOST}:${PORT}"
echo "  Press Ctrl+C to stop."
echo ""

if [ "${RELOAD:-0}" = "1" ]; then
  exec .venv/bin/python -m uvicorn server.main:app --host "$HOST" --port "$PORT" --reload
else
  exec .venv/bin/python -m uvicorn server.main:app --host "$HOST" --port "$PORT"
fi
