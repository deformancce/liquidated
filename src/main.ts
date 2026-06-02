import { AudioEngine } from "./audio/audioEngine";
import { SynthLab } from "./audio/synthLab";
import { MARKET_CONFIG } from "./config/markets";
import { DemoFeed } from "./data/demoFeed";
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
  title: mustQuery<HTMLHeadingElement>("h1"),
  symbol: mustQuery<HTMLSelectElement>("#symbolSelect"),
  live: mustQuery<HTMLButtonElement>("#liveButton"),
  demo: mustQuery<HTMLButtonElement>("#demoButton"),
  audio: mustQuery<HTMLButtonElement>("#audioButton"),
  statusLight: mustQuery<HTMLSpanElement>("#statusLight"),
  statusText: mustQuery<HTMLSpanElement>("#statusText"),
  buyFlow: mustQuery<HTMLElement>("#buyFlow"),
  sellFlow: mustQuery<HTMLElement>("#sellFlow"),
  liquidations: mustQuery<HTMLElement>("#liquidations"),
  pulse: mustQuery<HTMLElement>("#pulse"),
  pressureLabel: mustQuery<HTMLElement>("#pressureLabel"),
  pressureFill: mustQuery<HTMLDivElement>("#pressureFill"),
  sensitivity: mustQuery<HTMLInputElement>("#sensitivity"),
  minSize: mustQuery<HTMLInputElement>("#minSize"),
  volume: mustQuery<HTMLInputElement>("#volume"),
  timbre: mustQuery<HTMLInputElement>("#timbre"),
  space: mustQuery<HTMLInputElement>("#space"),
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

let settings: ScannerSettings = {
  market: "BTC",
  mode: "live",
  minPrintSize: MARKET_CONFIG.BTC.minPrintSize,
  sensitivity: Number(elements.sensitivity.value),
  clusterWindowMs: 500,
  volume: Number(elements.volume.value),
  timbre: Number(elements.timbre.value),
  space: Number(elements.space.value),
  cascadeIntensity: 1,
  viscosity: 0.7,
  turbulence: 0.55,
};

const renderer = new LiquidRenderer(canvas);
const audio = new AudioEngine();
const synthLabRoot = document.getElementById("synthLab");
if (synthLabRoot) {
  new SynthLab(synthLabRoot);
}
const aggregator = new FlowAggregator(settings.market, settings.clusterWindowMs);
const signals = new SignalEngine(settings.market);
const demo = new DemoFeed(settings.market, {
  onTrade: handleTrade,
  onBbo: (event) => signals.updateBbo(event),
});
const live = new HyperliquidClient(settings.market, {
  onTrade: handleTrade,
  onBbo: (event) => signals.updateBbo(event),
  onAssetContext: (context) => {
    stats.context = context;
  },
  onStatus: setStatus,
});

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as T;
}

function handleTrade(trade: TradeEvent): void {
  if (trade.size < settings.minPrintSize) return;

  if (trade.side === "buy") stats.buy += trade.size;
  if (trade.side === "sell") stats.sell += trade.size;
  stats.pulse = Math.min(999, stats.pulse + Math.sqrt(trade.size) / 42);

  renderer.pushTrade(trade, settings);
  audio.playTrade(trade, settings);
  appendTape(trade);

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

  updateStats();
}

function handleSignal(signal: FlowSignal): void {
  stats.signals += 1;
  stats.pulse = Math.min(999, stats.pulse + signal.intensity * 18);
  renderer.pushSignal(signal, settings);
  audio.playSignal(signal, settings);
  appendSignal(signal);
}

function appendTape(trade: TradeEvent): void {
  const row = document.createElement("li");
  const type = document.createElement("span");
  const price = document.createElement("span");
  const size = document.createElement("strong");
  const decimals = MARKET_CONFIG[trade.market].priceDecimals;

  type.textContent = trade.side.toUpperCase();
  type.className = trade.side;
  price.textContent = formatPrice(trade.price, decimals);
  size.textContent = money(trade.size);
  row.append(type, price, size);
  prependTape(row);
}

function appendSignal(signal: FlowSignal): void {
  const row = document.createElement("li");
  const type = document.createElement("span");
  const price = document.createElement("span");
  const size = document.createElement("strong");
  const decimals = MARKET_CONFIG[signal.market].priceDecimals;

  type.textContent = signal.type === "cascadeRisk" ? "RISK" : signal.type.includes("absorption") ? "ABS" : "FLOW";
  type.className = signal.type === "cascadeRisk" ? "liq" : signal.side === "buy" ? "buy" : "sell";
  price.textContent = signal.label;
  size.textContent = signal.price ? formatPrice(signal.price, decimals) : money(signal.size);
  row.append(type, price, size);
  prependTape(row);
}

function prependTape(row: HTMLLIElement): void {
  elements.tape.prepend(row);
  while (elements.tape.children.length > 22) {
    elements.tape.lastElementChild?.remove();
  }
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

function decayStats(): void {
  stats.buy *= 0.996;
  stats.sell *= 0.996;
  stats.pulse *= 0.986;
  updateStats();
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

function setMode(mode: ScannerSettings["mode"]): void {
  settings = { ...settings, mode };
  elements.live.classList.toggle("active", mode === "live");
  elements.demo.classList.toggle("active", mode === "demo");

  if (mode === "live") {
    demo.stop();
    live.connect();
  } else {
    live.disconnect();
    setStatus("demo");
    demo.start();
  }
}

function setMarket(market: Market): void {
  const config = MARKET_CONFIG[market];
  settings = { ...settings, market, minPrintSize: config.minPrintSize };
  elements.title.textContent = market;
  elements.minSize.value = String(config.minPrintSize);
  aggregator.setMarket(market);
  signals.setMarket(market);
  demo.setMarket(market);
  stats.buy = 0;
  stats.sell = 0;
  stats.cvd = 0;
  stats.signals = 0;
  elements.tape.replaceChildren();

  if (settings.mode === "live") {
    live.setMarket(market);
  }
}

function syncSettings(): void {
  settings = {
    ...settings,
    sensitivity: Number(elements.sensitivity.value),
    minPrintSize: Number(elements.minSize.value),
    volume: Number(elements.volume.value),
    timbre: Number(elements.timbre.value),
    space: Number(elements.space.value),
  };
  audio.setSettings(settings);
}

elements.live.addEventListener("click", () => setMode("live"));
elements.demo.addEventListener("click", () => setMode("demo"));
elements.symbol.addEventListener("change", () => setMarket(elements.symbol.value as Market));
elements.audio.addEventListener("click", async () => {
  const enabled = await audio.toggle(settings);
  elements.audio.setAttribute("aria-pressed", String(enabled));
});

for (const input of [elements.sensitivity, elements.minSize, elements.volume, elements.timbre, elements.space]) {
  input.addEventListener("input", syncSettings);
}

renderer.render(settings);
setMode(settings.mode);
decayStats();
