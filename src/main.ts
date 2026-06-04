import { AudioEngine } from "./audio/audioEngine";
import { MARKET_CONFIG } from "./config/markets";
import { HyperliquidClient } from "./data/hyperliquidClient";
import { FlowAggregator } from "./flow/flowAggregator";
import { SignalEngine } from "./signals/signalEngine";
import type { AssetContext, ConnectionStatus, FlowSignal, Market, ScannerSettings, TradeEvent } from "./types";
import { formatPrice, money } from "./utils/format";
import { LiquidRenderer } from "./visual/liquidRenderer";
import "./../styles.css";

const canvas = document.getElementById("flowCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Missing flow canvas");
}

const elements = {
  symbol: mustQuery<HTMLSelectElement>("#symbolSelect"),
  live: mustQuery<HTMLButtonElement>("#liveButton"),
  off: mustQuery<HTMLButtonElement>("#offButton"),
  raw: mustQuery<HTMLButtonElement>("#rawButton"),
  aggregated: mustQuery<HTMLButtonElement>("#aggregatedButton"),
  audio: mustQuery<HTMLButtonElement>("#audioButton"),
  statusLight: mustQuery<HTMLSpanElement>("#statusLight"),
  statusText: mustQuery<HTMLSpanElement>("#statusText"),
  buyFlow: mustQuery<HTMLElement>("#buyFlow"),
  sellFlow: mustQuery<HTMLElement>("#sellFlow"),
  liquidations: mustQuery<HTMLElement>("#liquidations"),
  pulse: mustQuery<HTMLElement>("#pulse"),
  pressureLabel: mustQuery<HTMLElement>("#pressureLabel"),
  pressureFill: mustQuery<HTMLDivElement>("#pressureFill"),
  minSize: mustQuery<HTMLSelectElement>("#minSize"),
  windowMs: mustQuery<HTMLSelectElement>("#windowMs"),
  priceBucket: mustQuery<HTMLSelectElement>("#priceBucket"),
  tape: mustQuery<HTMLOListElement>("#eventTape"),
};

const stats = {
  buy: 0,
  sell: 0,
  cvd: 0,
  pulse: 0,
  signals: 0,
  context: null as AssetContext | null,
};

const TAPE_MIN_PRINT_SIZE = 0;
const MARKET_TAPE_PROFILE: Record<Market, { bucket: number; window: number; minSize: number }> = {
  BTC: { bucket: 1, window: 250, minSize: 0 },
  ETH: { bucket: 0.1, window: 250, minSize: 0 },
  SOL: { bucket: 0.01, window: 250, minSize: 0 },
  HYPE: { bucket: 0.01, window: 500, minSize: 0 },
};

let settings: ScannerSettings = {
  market: "BTC",
  mode: "live",
  minPrintSize: TAPE_MIN_PRINT_SIZE,
  sensitivity: 1.15,
  clusterWindowMs: Number(elements.windowMs.value),
  volume: 0.28,
  timbre: 0.45,
  space: 0.35,
  cascadeIntensity: 1,
  viscosity: 0.7,
  turbulence: 0.55,
};

const renderer = new LiquidRenderer(canvas);
const audio = new AudioEngine();
const aggregator = new FlowAggregator(settings.market, settings.clusterWindowMs);
const signals = new SignalEngine(settings.market);
const live = new HyperliquidClient(settings.market, {
  onTrade: ingestTrade,
  onBbo: (event) => signals.updateBbo(event),
  onAssetContext: (context) => {
    stats.context = context;
  },
  onStatus: setStatus,
});

type FeedShaping = "raw" | "aggregated";
interface TapePrint {
  trade: TradeEvent;
  fills: number;
  endedAt: number;
}

let feedShaping: FeedShaping = "aggregated";
let aggWindowMs = Number(elements.windowMs.value);
let priceBucket = Number(elements.priceBucket.value);
let currentTapePrint: TapePrint | null = null;
let statsDirty = false;
let statsFrame = 0;
let tapeFrame = 0;
const pendingTapeRows: TapePrint[] = [];
const MAX_TAPE_ROWS = 120;
const MAX_TAPE_INSERTS_PER_FRAME = 24;

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as T;
}

function ingestTrade(trade: TradeEvent): void {
  if (feedShaping === "raw") {
    handleTrade({ trade, fills: 1, endedAt: trade.timestamp });
    return;
  }

  const head = currentTapePrint;
  const canMerge =
    head &&
    head.trade.side === trade.side &&
    trade.timestamp - head.endedAt <= aggWindowMs &&
    (priceBucket === 0 ? head.trade.price === trade.price : Math.abs(trade.price - head.trade.price) <= priceBucket);

  if (canMerge) {
    const quantity = head.trade.quantity + trade.quantity;
    const size = head.trade.size + trade.size;
    currentTapePrint = {
      trade: {
        ...trade,
        price: quantity > 0 ? size / quantity : trade.price,
        quantity,
        size,
        timestamp: trade.timestamp,
      },
      fills: head.fills + 1,
      endedAt: trade.timestamp,
    };
    return;
  }

  currentTapePrint = { trade, fills: 1, endedAt: trade.timestamp };
  handleTrade(currentTapePrint);
}

function handleTrade(print: TapePrint): void {
  const trade = print.trade;
  if (trade.size < settings.minPrintSize) return;

  if (trade.side === "buy") stats.buy += trade.size;
  if (trade.side === "sell") stats.sell += trade.size;
  stats.pulse = Math.min(999, stats.pulse + Math.sqrt(trade.size) / 42);

  renderer.pushTrade(trade, settings);
  audio.playTrade(trade);
  queueTape(print);

  for (const signal of signals.fromTrade(trade, settings.sensitivity)) {
    handleSignal(signal);
  }

  const completed = aggregator.addTrade(trade);
  if (completed) {
    stats.cvd = completed.cvd;
    for (const signal of signals.fromBucket(completed, settings.sensitivity)) {
      handleSignal(signal);
    }
  }

  queueStatsUpdate();
}

function handleSignal(signal: FlowSignal): void {
  stats.signals += 1;
  stats.pulse = Math.min(999, stats.pulse + signal.intensity * 18);
}

function queueTape(print: TapePrint): void {
  pendingTapeRows.push(print);
  if (pendingTapeRows.length > MAX_TAPE_ROWS) {
    pendingTapeRows.splice(0, pendingTapeRows.length - MAX_TAPE_ROWS);
  }
  if (!tapeFrame) {
    tapeFrame = window.requestAnimationFrame(flushTape);
  }
}

function flushTape(): void {
  tapeFrame = 0;
  if (pendingTapeRows.length === 0) return;

  const fragment = document.createDocumentFragment();
  const batch = pendingTapeRows.splice(0, MAX_TAPE_INSERTS_PER_FRAME);
  for (let index = batch.length - 1; index >= 0; index -= 1) {
    fragment.append(createTapeRow(batch[index]));
  }
  elements.tape.prepend(fragment);
  trimTape();

  if (pendingTapeRows.length > 0) {
    tapeFrame = window.requestAnimationFrame(flushTape);
  }
}

function createTapeRow(print: TapePrint): HTMLLIElement {
  const trade = print.trade;
  const row = document.createElement("li");
  const type = document.createElement("span");
  const price = document.createElement("span");
  const size = document.createElement("strong");
  const fills = document.createElement("span");
  const age = document.createElement("span");
  const decimals = MARKET_CONFIG[trade.market].priceDecimals;

  type.textContent = trade.side.toUpperCase();
  type.className = trade.side;
  price.textContent = formatPrice(trade.price, decimals);
  size.textContent = money(trade.size);
  fills.textContent = print.fills > 1 ? `×${print.fills}` : "";
  age.dataset.time = String(print.endedAt);
  age.textContent = "0s";
  age.className = "age";
  row.className = trade.side;
  row.append(type, price, size, fills, age);
  return row;
}

function trimTape(): void {
  while (elements.tape.children.length > MAX_TAPE_ROWS) {
    elements.tape.lastElementChild?.remove();
  }
}

function updateTapeAges(): void {
  const now = Date.now();
  for (const node of elements.tape.querySelectorAll<HTMLElement>(".age[data-time]")) {
    const age = Math.max(0, Math.floor((now - Number(node.dataset.time)) / 1000));
    node.textContent = `${age}s`;
  }
  window.setTimeout(updateTapeAges, 1_000);
}

function updateStats(): void {
  elements.buyFlow.textContent = money(stats.buy);
  elements.sellFlow.textContent = money(stats.sell);
  elements.liquidations.textContent = String(stats.signals);
  elements.pulse.textContent = String(Math.round(stats.pulse));

  const total = stats.buy + stats.sell;
  const pressure = total ? (stats.buy - stats.sell) / total : 0;
  const label = pressure > 0.16 ? "Bid Aggression" : pressure < -0.16 ? "Ask Aggression" : "Balanced";
  const width = Math.abs(pressure) * 50;
  const left = pressure < 0 ? 50 - width : 50;

  elements.pressureLabel.textContent = label;
  elements.pressureFill.style.left = `${left}%`;
  elements.pressureFill.style.width = `${width}%`;
}

function queueStatsUpdate(): void {
  statsDirty = true;
  if (statsFrame) return;
  statsFrame = window.requestAnimationFrame(() => {
    statsFrame = 0;
    if (!statsDirty) return;
    statsDirty = false;
    updateStats();
  });
}

function decayStats(): void {
  stats.buy *= 0.996;
  stats.sell *= 0.996;
  stats.pulse *= 0.986;
  queueStatsUpdate();
  window.setTimeout(decayStats, 120);
}

function setStatus(status: ConnectionStatus): void {
  const text: Record<ConnectionStatus, string> = {
    connecting: "Connecting",
    live: "Hyperliquid Live",
    demo: "Demo Stream",
    reconnecting: "Reconnecting",
    error: "Stream Error",
  };

  elements.statusText.textContent = text[status];
  elements.statusLight.classList.toggle("live", status === "live" || status === "demo");
}

type FeedMode = "off" | "live";
let feedMode: FeedMode = "live";

function setMode(mode: FeedMode): void {
  feedMode = mode;
  elements.live.classList.toggle("active", mode === "live");
  elements.off.classList.toggle("active", mode === "off");

  if (mode === "live") {
    live.connect();
  } else {
    live.disconnect();
    elements.statusText.textContent = "Feed Off";
    elements.statusLight.classList.remove("live");
  }
}

function setMarket(market: Market): void {
  const profile = MARKET_TAPE_PROFILE[market];
  elements.minSize.value = String(profile.minSize);
  elements.windowMs.value = String(profile.window);
  elements.priceBucket.value = String(profile.bucket);
  aggWindowMs = profile.window;
  priceBucket = profile.bucket;
  settings = { ...settings, market, minPrintSize: profile.minSize, clusterWindowMs: profile.window };
  aggregator.setMarket(market);
  signals.setMarket(market);
  stats.buy = 0;
  stats.sell = 0;
  stats.cvd = 0;
  stats.signals = 0;
  currentTapePrint = null;
  elements.tape.replaceChildren();

  if (feedMode === "live") {
    live.setMarket(market);
  }
}

function syncSettings(): void {
  settings = {
    ...settings,
    minPrintSize: Number(elements.minSize.value),
    clusterWindowMs: Number(elements.windowMs.value),
  };
  audio.setSettings(settings);
}

function setShaping(next: FeedShaping): void {
  feedShaping = next;
  currentTapePrint = null;
  elements.raw.classList.toggle("active", next === "raw");
  elements.aggregated.classList.toggle("active", next === "aggregated");
  elements.windowMs.disabled = next === "raw";
  elements.priceBucket.disabled = next === "raw";
}

elements.live.addEventListener("click", () => setMode("live"));
elements.off.addEventListener("click", () => setMode("off"));
elements.symbol.addEventListener("change", () => setMarket(elements.symbol.value as Market));
elements.raw.addEventListener("click", () => setShaping("raw"));
elements.aggregated.addEventListener("click", () => setShaping("aggregated"));
elements.minSize.addEventListener("change", syncSettings);
elements.windowMs.addEventListener("change", () => {
  aggWindowMs = Number(elements.windowMs.value);
  syncSettings();
});
elements.priceBucket.addEventListener("change", () => {
  priceBucket = Number(elements.priceBucket.value);
  currentTapePrint = null;
});
elements.audio.addEventListener("click", async () => {
  const enabled = await audio.toggle(settings);
  elements.audio.setAttribute("aria-pressed", String(enabled));
});

renderer.render(settings);
setMode(feedMode);
setShaping(feedShaping);
updateTapeAges();
decayStats();
