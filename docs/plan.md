# Liquidated Plan

Liquidated is an orderflow instrument for Hyperliquid ecosystem markets. It should feel closer to a tuned synthesizer than a dashboard: live tape aggression becomes sound, pressure, and liquid motion.

## Product Shape

The app has three engines:

1. Tape engine
   - Collect live Hyperliquid trades.
   - Group prints by time, market, and aggressor side.
   - Track notional size, trade count, delta, rolling CVD, and large prints.

2. Signal engine
   - Interpret aggression against price reaction.
   - Detect large buys/sells, same-side clusters, delta spikes, absorption, and cascade risk.
   - Keep derived signals separate from confirmed exchange liquidation events.

3. Audio/visual engine
   - Trigger synth voices from flow events.
   - Modulate a liquid visual layer from delta, pressure, volatility, OI, and cluster intensity.
   - Let the user tune scanner and synth parameters.

## Hyperliquid Data

Primary WebSocket endpoint:

- Mainnet: `wss://api.hyperliquid.xyz/ws`
- Testnet: `wss://api.hyperliquid-testnet.xyz/ws`

Initial subscriptions:

- `trades`: executed prints per coin
- `bbo`: best bid/offer for fast price reaction checks
- `l2Book`: liquidity field and imbalance
- `activeAssetCtx`: funding, open interest, mark price, oracle price, day volume
- `allMids`: optional ecosystem overview

Liquidation handling:

- `confirmedLiquidation` is reserved for direct public liquidation data if a reliable feed is available.
- `cascadeRisk` and `forcedFlowDetected` are derived from trade clusters, price velocity, volatility, and OI changes.

## Technical Direction

Target stack:

- Vite
- TypeScript
- PixiJS for the liquid renderer
- Tone.js for synth routing, envelopes, filters, and effects
- Small internal store first; add Zustand only when UI state needs it

The first implementation can keep a Canvas 2D renderer until PixiJS is installed. Module boundaries should already match the target architecture.

## Modules

`src/data/hyperliquidClient.ts`

- WebSocket connection lifecycle
- heartbeat/reconnect
- subscribe/unsubscribe
- message normalization

`src/flow/flowAggregator.ts`

- Bucket trades by window
- Compute buy/sell notional, delta, trade count, largest print, and rolling CVD

`src/signals/signalEngine.ts`

- Convert buckets and market context into events:
  - `largeBuy`
  - `largeSell`
  - `buyCluster`
  - `sellCluster`
  - `absorptionBid`
  - `absorptionAsk`
  - `cascadeRisk`
  - `volatilityPulse`

`src/audio/audioEngine.ts`

- Buy/sell voices
- Cluster bursts
- Cascade impact/noise layer
- Pressure drone and filter modulation

`src/visual/liquidRenderer.ts`

- Liquid core
- Buy/sell streams
- Liquidity bands
- Absorption walls
- Cascade turbulence

## MVP 1

- Single-market mode: `BTC`, `ETH`, `SOL`, `HYPE`
- Hyperliquid live trades, BBO, and active asset context
- Min print threshold per market
- Flow buckets and CVD
- Basic signals: large print, cluster, effective flow, absorption
- Tunable audio: volume, sensitivity, timbre, space, cascade intensity
- Liquid visual layer reacting to buy/sell pressure and cluster intensity
- Demo mode remains available for design work without a live socket

## MVP 2

- Multi-market ecosystem mode
- Each market as a separate visual/audio channel
- Global pressure and HYPE ecosystem mode
- Session recording and replay
- Presets for quiet scan, scalp, cascade watch, and ambient mode

## Interpretation Rules

- Aggressive buy plus upward price response means buying has impact.
- Aggressive sell plus downward price response means selling has impact.
- Aggressive sell with little downside movement suggests bid absorption.
- Aggressive buy with little upside movement suggests ask absorption.
- Fast same-side clusters plus price acceleration and OI/volume changes suggest cascade risk.

The app should never imply that derived cascade signals are confirmed liquidations unless the source is explicit.
