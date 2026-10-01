# Liquidated

Liquidated is an audio-visual orderflow instrument for Hyperliquid perpetual markets. It turns public buy/sell flow into a live tape, a trade-triggered synth, and liquid WebGL visuals where order size controls impact, spread, colour, and sound.

Live: https://liquidated.app

**New here?** Read [What it is & how it works](docs/how-it-works.md) for a full walkthrough of the interface and the data → tape → synth → visuals pipeline.

The project is built as a Vite + TypeScript app with three views:

- Full experience: https://liquidated.app
- Buy/sell tape: https://liquidated.app/tape
- Flow synth: https://liquidated.app/synth
- Visual lab: https://liquidated.app/visuals

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

- Hyperliquid public WebSocket data: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- Hyperliquid Python SDK: https://github.com/hyperliquid-dex/hyperliquid-python-sdk
- Liquid simulation lineage: https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_water.html, https://github.com/franky-adl/water-ripples, and https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
- Sound algorithm: https://github.com/pichenettes/eurorack/tree/master/rings by Émilie Gillet
- Tone.js audio engine: https://tonejs.github.io/
- Three.js rendering: https://threejs.org/
- Full attribution and licence notes: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Current Scope

- Hyperliquid WebSocket data pipeline
- Tape aggregation by time, market, and side
- Delta, CVD, large print, cluster, and absorption signals
- Tunable synth engine triggered by flow
- Liquid visual layer reacting to buy/sell pressure, trade size, and impact direction
- Isolated visual lab for tuning the renderer without live data or audio

## Deployment

The app builds to `dist/` and is deployed directly to Cloudflare Pages without a Git provider connection:

```bash
npm run build
npx wrangler@latest pages deploy dist --project-name=liquidated --branch=main
```

Production: https://liquidated.app
