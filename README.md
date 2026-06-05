# Liquidated

Liquidated is an audio-visual orderflow instrument for Hyperliquid perpetual markets. It turns public buy/sell flow into a live tape, a trade-triggered synth, and liquid WebGL visuals where order size controls impact, spread, colour, and sound.

The project is built as a Vite + TypeScript app with three views:

- `index.html` - the full Liquidated experience: live tape, synth trigger path, and centre-weighted liquid visuals.
- `tape.html` - a raw/aggr-style Hyperliquid buy/sell tape for comparing public trade prints.
- `synth.html` - a standalone Tone.js instrument driven by Hyperliquid trade flow.
- `visuals.html` - an isolated visual lab for tuning buy/sell drops and impact waves.

## Run Locally

```bash
npm install
npm run dev
```

## Data Sources

- Hyperliquid public WebSocket API for live trades and BBO updates.
- Optional Hyperliquid user events / fills clients for user-scoped liquidation experiments.
- Optional local liquidation indexer that can read `node_fills_by_block` output from a Hyperliquid non-validating node or proxy gRPC-style liquidation rows.
- Optional The Graph Token API proxy for historical/third-party liquidation experiments when `THE_GRAPH_TOKEN_API_KEY` is configured.

## Resources

- Hyperliquid API docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
- Hyperliquid Python SDK: https://github.com/hyperliquid-dex/hyperliquid-python-sdk
- WebGL liquid renderer inspiration: https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
- Tone.js audio engine: https://tonejs.github.io/
- Three.js rendering: https://threejs.org/

## Current Scope

- Hyperliquid WebSocket data pipeline
- Tape aggregation by time, market, and side
- Delta, CVD, large print, cluster, and absorption signals
- Tunable synth engine triggered by flow
- Liquid visual layer reacting to buy/sell pressure, trade size, and impact direction
- Isolated visual lab for tuning the renderer without live data or audio

## Deployment

The app builds to `dist/` and can be deployed as a static site:

```bash
npm run build
npx netlify deploy --prod --dir=dist
```
