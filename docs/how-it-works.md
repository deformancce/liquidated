# Liquidated — What it is & how it works

**Liquidated** is an audio-visual order-flow instrument for [Hyperliquid](https://hyperliquid.xyz)
perpetual markets. It listens to the public trade stream for a market (BTC, ETH, SOL, HYPE),
and turns the raw buy/sell flow into three things at once:

- a **live tape** of recent prints,
- a **trade-triggered synth** (a physical-modelling resonator) that you can hear, and
- a **liquid WebGL visual** where the size and direction of each trade pushes, colours, and
  ripples the fluid.

Nothing is simulated by default — when the feed is **Live**, every drop of sound and motion is
driven by real trades coming off Hyperliquid's WebSocket.

The opening landing page acts as the threshold into the instrument. Pressing **Enter live instrument** connects the market feed and primes Web Audio in the same gesture, which is important for browsers that block audio until the user interacts with the page. No wallet or exchange login is required.

> Live app: https://liquidated.app

---

## The big picture

```
Hyperliquid WS ──► Trade events ──► Aggregator ──► Tape + Metrics
                         │                            │
                         ├──► Signal engine ──────────┤   (large prints, clusters,
                         │                            │    absorption, cascades…)
                         ├──► Audio engine ───────────►  resonator synth voices
                         └──► Liquid renderer ────────►  WebGL fluid simulation
```

Every incoming trade fans out to four consumers: the tape/metrics, the signal engine,
the audio engine, and the fluid renderer. They all read the same `TradeEvent`, so what you
**see**, **hear**, and **read** are three views of the exact same flow.

---

## Using the interface

The control bar (top-left on desktop, top bar + burger menu on mobile) drives everything.

| Control | What it does |
| --- | --- |
| **Instrument** (BTC / ETH / SOL / HYPE) | Picks which Hyperliquid perp to stream. |
| **Raw / Aggregated** | *Raw* shows every fill. *Aggregated* merges same-side fills that land close together in time and price into a single, larger print. |
| **Range** | A dual slider that filters prints by notional size ($), so you can hide noise and focus on the big flow. |
| **Grouping** | The aggregation buckets — a time window (ms) and a price bucket ($). Click it to pick values; the active choice is checked. |
| **Sound off / Sound on** | Mutes or resumes the resonator without stopping the live market feed. The indicator turns green while audio is active. |
| **Audio settings** | Tunes the resonator synth (voices, frequency, structure, damping, brightness, release…). |
| **Liquid settings** | Tunes the fluid renderer (mouse/impact size, viscosity, wave height). |

On the right side you get the **tape** (recent prints with side, price, size, fill-count, and age)
and a metric block:

- **Buy Flow / Sell Flow** — rolling notional traded on each side (decays over time).
- **Liqs** — count of fired flow signals.
- **Pulse** — a fast-moving "energy" reading that spikes on big prints and signals.
- **Pressure** — a left/right meter showing whether bid or ask aggression dominates.

> On mobile, drag the handle at the bottom to pull the tape sheet up over the visual.

The feed connects when you enter the instrument. Sound remains a separate control, so the tape and liquid field can keep following the market in silence.

---

## How the pieces work

### 1. Data feed
A WebSocket client subscribes to Hyperliquid's public **trades** and **BBO** (best bid/offer)
channels for the selected market. Each trade becomes a normalised `TradeEvent`
(side, price, size in $, quantity, timestamp). BBO updates keep a running mid-price used by the
signal engine. If the live stream can't connect, the app can fall back to a demo stream so the
visuals still move.

### 2. Aggregation (the tape)
In *Aggregated* mode, consecutive fills on the **same side** are merged when they fall inside the
**Grouping** time window and price bucket. The merged print keeps a size-weighted average price and
a `×N` fill count. A short flush timer makes sure a print is emitted even when the flow goes quiet.
The result is a readable tape instead of a firehose of micro-fills.

In parallel, a **flow aggregator** rolls trades into time buckets to track buy vs. sell volume,
price movement, and **CVD** (cumulative volume delta).

### 3. Signal engine
Each trade and each completed bucket is checked against per-market thresholds to raise
**flow signals**, for example:

- **Large Buy / Large Sell** — a single print above the market's "large print" size.
- **Buy / Sell Cluster** — one side dominating a whole bucket's volume.
- **Absorption / Cascade / Volatility** — higher-order conditions from the bucket stats.

Thresholds scale per instrument (a "large" BTC print is very different from a HYPE print), and the
**sensitivity** setting scales the intensity of what fires. Signals add to Pulse and trigger
heavier audio hits.

### 4. Audio engine
The synth is a **physical-modelling resonator** (a Rings-style modal/sympathetic-string voice,
compiled from the original Rings DSP core to WebAssembly). Trades pluck voices: trade size maps
to which "tier" and velocity is used, side influences pitch/colour, and signals trigger stronger
strikes. The **Audio settings** panel exposes the resonator's core parameters so you can shape the
instrument live. Audio is unlocked directly from the entry or sound-button gesture. On iOS, Liquidated also requests the playback audio session so the instrument can sound even when the hardware ring switch is silent.

### 5. Liquid renderer
A GPU **fluid simulation** (WebGL) reacts to flow: each trade injects a splat whose **size** scales
with notional, whose **colour** is green for buys / orange for sells, and whose **direction** reflects
buy vs. sell pressure. Larger trades make bigger, brighter impacts. Directional pressure also tints the reflected surface, so sustained one-sided flow changes the character of the whole field rather than only producing isolated drops.

The **Liquid settings** panel tunes impact size, viscosity, and wave height through normalized controls with a usable midpoint. The renderer adapts to portrait and landscape: buys occupy the lower side and sells the upper side in portrait, while the same opposition runs horizontally on wider screens. Pending impact and colour queues are capped and stale frame time is discarded after sleep, which prevents a backgrounded tab from replaying a large render backlog when it wakes.

---

## Other views

Liquidated ships a few focused single-purpose pages alongside the full experience:

| View | URL | What it is |
| --- | --- | --- |
| Full experience | `/` | Tape + synth + liquid visual together. |
| Buy/sell tape | `/tape` | The flow tape on its own. |
| Flow synth | `/synth` | The trade-triggered synth, isolated. |
| Visual lab | `/visuals` | The fluid renderer with tuning controls, no live data or audio — handy for dialling in visuals. |

---

## Run it locally

```bash
npm install
npm run dev
```

Build a static bundle:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the build locally
```

### Data sources
- **[Hyperliquid public WebSocket](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)** — live trades and BBO (the default, no wallet or API key needed).
- Optional Hyperliquid user-events / fills clients for user-scoped liquidation experiments.
- Optional local **liquidation indexer** reading a Hyperliquid node's `node_fills_by_block` output
  or a gRPC-style liquidation feed.
- Optional The Graph Token API proxy for historical liquidation experiments
  (`THE_GRAPH_TOKEN_API_KEY`).

The live market stream is publicly accessible data; it is not described here as “open-source data.” See [Sources, credits and thanks](credits.md) for provenance, licences, and acknowledgements for the liquid and sound algorithms.

---

## Tech stack
- **Vite + TypeScript** app, no framework for the main view (React is used by some sub-apps).
- **Three.js + GPUComputationRenderer** for the WebGL liquid simulation and reflected water surface.
- **Original Rings DSP compiled to WebAssembly** and routed through Web Audio for sound.
- Deployed as a static site on Cloudflare Pages.

---

## Disclaimer
Liquidated is an experimental art/data instrument for **observing** market flow. It is **not**
trading software, financial advice, or a signal service. Market data is public and provided as-is.
