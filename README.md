# Liquidated

Liquidated is an audio-visual orderflow instrument for Hyperliquid ecosystem markets. It turns aggressive flow, clusters, absorption, and cascade risk into sound and liquid motion.

The project is moving from a static sketch into a Vite + TypeScript app. See [docs/plan.md](docs/plan.md) for the working architecture.

## Run

```bash
npm install
npm run dev
```

## Current Scope

- Hyperliquid WebSocket data pipeline
- Tape aggregation by time, market, and side
- Delta, CVD, large print, cluster, and absorption signals
- Tunable synth engine triggered by flow
- Liquid visual layer reacting to pressure and turbulence
