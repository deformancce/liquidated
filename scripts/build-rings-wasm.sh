#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/public/rings"
VENDOR_DIR="$ROOT/vendor/mutable-eurorack"
BRIDGE="$ROOT/src/resonator/wasm/rings_bridge.cc"
EM_CACHE_DIR="$ROOT/.cache/emscripten"

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found. Install Emscripten first, then rerun npm run build:rings-wasm." >&2
  exit 127
fi

if [ ! -d "$VENDOR_DIR/rings/dsp" ]; then
  echo "Missing vendor source at $VENDOR_DIR." >&2
  echo "Fetch or vendor pichenettes/eurorack before building the 1:1 Rings DSP WASM." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
mkdir -p "$EM_CACHE_DIR"
export EM_CACHE="$EM_CACHE_DIR"

emcc \
  "$BRIDGE" \
  "$VENDOR_DIR/rings/dsp/part.cc" \
  "$VENDOR_DIR/rings/dsp/resonator.cc" \
  "$VENDOR_DIR/rings/dsp/string.cc" \
  "$VENDOR_DIR/rings/dsp/string_synth_part.cc" \
  "$VENDOR_DIR/rings/dsp/fm_voice.cc" \
  "$VENDOR_DIR/rings/resources.cc" \
  "$VENDOR_DIR/stmlib/dsp/units.cc" \
  "$VENDOR_DIR/stmlib/utils/random.cc" \
  -I "$VENDOR_DIR" \
  -DTEST \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=CreateRingsDsp \
  -s ENVIRONMENT=web,worker \
  -s EXPORTED_FUNCTIONS='["_rings_init","_rings_set_patch","_rings_set_mods","_rings_set_model","_rings_process","_rings_strum","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPF32"]' \
  -o "$OUT_DIR/rings-dsp.js"

echo "Built $OUT_DIR/rings-dsp.js"
