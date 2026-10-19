#!/usr/bin/env bash
# Read-only Bluetooth diagnostics for a sensor.
#   ./scripts/inspect.sh              list Mi Flora sensors in range
#   ./scripts/inspect.sh <MAC>        show one sensor's advertisement and GATT layout
# Pauses the collector while it runs (only one program can use the adapter) and
# saves the output to data/inspect-<MAC>.txt.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm run build --silent
mac="${1:-}"
out="data/inspect-${mac//:/}.txt"
[[ -n "$mac" ]] || out="data/inspect-scan.txt"
mkdir -p data

if pm2 describe plant-collector >/dev/null 2>&1; then
  echo "Pausing plant-collector..."
  pm2 stop plant-collector >/dev/null
  trap 'echo "Restarting plant-collector..."; pm2 start plant-collector >/dev/null' EXIT
  sleep 2
fi

node dist/src/tools/inspect.js "$@" 2>&1 | tee "$out"
echo "Saved to $out"
