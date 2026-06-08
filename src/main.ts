import { AudioEngine, type ResonatorAudioParams } from "./audio/audioEngine";
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

const LIQUID_ANIMATION_ENABLED = true;
const AUDIO_SETTINGS_KEY = "liquidated.audioSettings.v1";
const DEFAULT_AGGREGATE = { windowMs: 250, bucket: 1 };
const MIN_PRINT_SIZE = 1_000;
const MAX_PRINT_SIZE = 5_000_000;
const RANGE_STEPS = 1_000;
const aggregateState = { ...DEFAULT_AGGREGATE };

const elements = {
  symbolSummary: mustQuery<HTMLElement>("#symbolSummary"),
  symbolOptions: [...document.querySelectorAll<HTMLButtonElement>("[data-market]")],
  live: mustQuery<HTMLButtonElement>("#liveButton"),
  off: mustQuery<HTMLButtonElement>("#offButton"),
  raw: mustQuery<HTMLButtonElement>("#rawButton"),
  aggregated: mustQuery<HTMLButtonElement>("#aggregatedButton"),
  statusLight: mustQuery<HTMLSpanElement>("#statusLight"),
  statusText: mustQuery<HTMLSpanElement>("#statusText"),
  buyFlow: mustQuery<HTMLElement>("#buyFlow"),
  sellFlow: mustQuery<HTMLElement>("#sellFlow"),
  liquidations: mustQuery<HTMLElement>("#liquidations"),
  pulse: mustQuery<HTMLElement>("#pulse"),
  pressureLabel: mustQuery<HTMLElement>("#pressureLabel"),
  pressureFill: mustQuery<HTMLDivElement>("#pressureFill"),
  minSize: mustQuery<HTMLInputElement>("#minSize"),
  minSizeValue: mustQuery<HTMLElement>("#minSizeValue"),
  maxSize: mustQuery<HTMLInputElement>("#maxSize"),
  maxSizeValue: mustQuery<HTMLElement>("#maxSizeValue"),
  aggregateOptions: [...document.querySelectorAll<HTMLButtonElement>("[data-aggregate-kind]")],
  saveAudioSettings: mustQuery<HTMLButtonElement>("#saveAudioSettings"),
  tape: mustQuery<HTMLOListElement>("#eventTape"),
  resonator: {
    maxVoices: control("resMaxVoices"),
    baseFrequency: control("resFrequency"),
    structure: control("resStructure"),
    baseDamping: control("resBaseDamping"),
    basePosition: control("resBasePosition"),
    dampingLift: control("resDampingLift"),
    positionSpread: control("resPositionSpread"),
    brightness: control("resBrightness"),
    release: control("resRelease"),
  },
  liquid: {
    mouseSize: control("liqMouseSize"),
    viscosity: control("liqViscosity"),
    waveHeight: control("liqWaveHeight"),
    smoothWater: mustQuery<HTMLButtonElement>("#smoothWater"),
  },
};

const stats = {
  buy: 0,
  sell: 0,
  cvd: 0,
  pulse: 0,
  signals: 0,
  context: null as AssetContext | null,
};

const TAPE_MIN_PRINT_SIZE = MIN_PRINT_SIZE;
const MARKET_TAPE_PROFILE: Record<Market, { bucket: number; window: number; minSize: number; maxSize: number }> = {
  BTC: { bucket: 1, window: 250, minSize: MIN_PRINT_SIZE, maxSize: MAX_PRINT_SIZE },
  ETH: { bucket: 0.1, window: 250, minSize: MIN_PRINT_SIZE, maxSize: MAX_PRINT_SIZE },
  SOL: { bucket: 0.01, window: 250, minSize: MIN_PRINT_SIZE, maxSize: MAX_PRINT_SIZE },
  HYPE: { bucket: 0.01, window: 500, minSize: MIN_PRINT_SIZE, maxSize: MAX_PRINT_SIZE },
};

let settings: ScannerSettings = {
  market: "BTC",
  mode: "live",
  minPrintSize: TAPE_MIN_PRINT_SIZE,
  maxPrintSize: MAX_PRINT_SIZE,
  sensitivity: 1.15,
  clusterWindowMs: aggregateState.windowMs,
  volume: 0.28,
  timbre: 0.45,
  space: 0.35,
  cascadeIntensity: 1,
  viscosity: 0.7,
  turbulence: 0.55,
};

const renderer = LIQUID_ANIMATION_ENABLED ? new LiquidRenderer(canvas) : null;
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
let aggWindowMs = aggregateState.windowMs;
let priceBucket = aggregateState.bucket;
let currentTapePrint: TapePrint | null = null;
let aggregateFlushTimer = 0;
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

function control(id: string) {
  return {
    input: mustQuery<HTMLInputElement>(`#${id}`),
    value: mustQuery<HTMLElement>(`#${id}Value`),
  };
}

function ingestTrade(trade: TradeEvent): void {
  if (feedShaping === "raw") {
    flushCurrentTapePrint();
    handleTrade({ trade, fills: 1, endedAt: trade.timestamp });
    return;
  }

  audio.playTrade(trade, { micro: true });

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
    scheduleAggregateFlush();
    return;
  }

  flushCurrentTapePrint();
  currentTapePrint = { trade, fills: 1, endedAt: trade.timestamp };
  scheduleAggregateFlush();
}

function scheduleAggregateFlush(): void {
  if (aggregateFlushTimer) window.clearTimeout(aggregateFlushTimer);
  aggregateFlushTimer = window.setTimeout(() => {
    aggregateFlushTimer = 0;
    flushCurrentTapePrint();
  }, aggWindowMs + 24);
}

function flushCurrentTapePrint(): void {
  if (aggregateFlushTimer) {
    window.clearTimeout(aggregateFlushTimer);
    aggregateFlushTimer = 0;
  }
  const print = currentTapePrint;
  if (!print) return;
  currentTapePrint = null;
  handleTrade(print);
}

function handleTrade(print: TapePrint): void {
  const trade = print.trade;
  const maxPrintSize = settings.maxPrintSize ?? MAX_PRINT_SIZE;
  if (trade.size < settings.minPrintSize || trade.size > maxPrintSize) return;

  if (trade.side === "buy") stats.buy += trade.size;
  if (trade.side === "sell") stats.sell += trade.size;
  stats.pulse = Math.min(999, stats.pulse + Math.sqrt(trade.size) / 42);

  renderer?.pushTrade(trade, settings);
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
  audio.playSignal(signal);
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
let feedMode: FeedMode = "off";

async function setMode(mode: FeedMode): Promise<void> {
  feedMode = mode;
  elements.live.classList.toggle("active", mode === "live");
  elements.off.classList.toggle("active", mode === "off");

  if (mode === "live") {
    live.connect();
    await audio.setEnabled(settings, true);
  } else {
    live.disconnect();
    await audio.setEnabled(settings, false);
    elements.statusText.textContent = "Feed Off";
    elements.statusLight.classList.remove("live");
  }
}

function setMarket(market: Market): void {
  flushCurrentTapePrint();
  elements.symbolSummary.textContent = market;
  for (const option of elements.symbolOptions) {
    const active = option.dataset.market === market;
    option.classList.toggle("active", active);
  }
  const profile = MARKET_TAPE_PROFILE[market];
  elements.minSize.value = String(sizeToSliderValue(profile.minSize));
  elements.maxSize.value = String(sizeToSliderValue(profile.maxSize));
  syncRangeControls();
  setAggregate(profile.window, profile.bucket, false);
  aggWindowMs = profile.window;
  priceBucket = profile.bucket;
  settings = {
    ...settings,
    market,
    minPrintSize: profile.minSize,
    maxPrintSize: profile.maxSize,
    clusterWindowMs: profile.window,
  };
  aggregator.setMarket(market);
  signals.setMarket(market);
  stats.buy = 0;
  stats.sell = 0;
  stats.cvd = 0;
  stats.signals = 0;
  audio.reset();
  elements.tape.replaceChildren();

  if (feedMode === "live") {
    live.setMarket(market);
  }
}

function syncSettings(): void {
  const { minPrintSize, maxPrintSize } = syncRangeControls();
  aggWindowMs = aggregateState.windowMs;
  priceBucket = aggregateState.bucket;
  settings = {
    ...settings,
    minPrintSize,
    maxPrintSize,
    clusterWindowMs: aggregateState.windowMs,
  };
  aggregator.setWindow(aggregateState.windowMs);
  updateAggregateMenu();
  audio.setSettings(settings);
}

function setAggregate(windowMs: number, bucket: number, shouldSync = true): void {
  aggregateState.windowMs = windowMs;
  aggregateState.bucket = bucket;
  updateAggregateMenu();
  if (!shouldSync) return;
  flushCurrentTapePrint();
  syncSettings();
}

function updateAggregateMenu(): void {
  for (const option of elements.aggregateOptions) {
    const kind = option.dataset.aggregateKind;
    const value = Number(option.dataset.aggregateValue);
    const active = kind === "window"
      ? value === aggregateState.windowMs
      : value === aggregateState.bucket;
    option.classList.toggle("active", active);
    option.textContent = `${active ? "✓ " : ""}${option.dataset.aggregateLabel ?? baseAggregateLabel(option)}`;
  }
}

function baseAggregateLabel(option: HTMLButtonElement): string {
  option.dataset.aggregateLabel ??= option.textContent?.replace(/^✓\s*/, "") ?? "";
  return option.dataset.aggregateLabel;
}

function syncRangeControls(): { minPrintSize: number; maxPrintSize: number } {
  let minPrintSize = sliderValueToSize(elements.minSize);
  let maxPrintSize = sliderValueToSize(elements.maxSize);
  if (minPrintSize > maxPrintSize) {
    const active = document.activeElement;
    if (active === elements.minSize) {
      maxPrintSize = minPrintSize;
    } else {
      minPrintSize = maxPrintSize;
    }
  }
  elements.minSize.value = String(sizeToSliderValue(minPrintSize));
  elements.maxSize.value = String(sizeToSliderValue(maxPrintSize));
  updateRangeReadout(elements.minSize, elements.minSizeValue, minPrintSize);
  updateRangeReadout(elements.maxSize, elements.maxSizeValue, maxPrintSize);
  const start = rangeProgress(minPrintSize);
  const end = rangeProgress(maxPrintSize);
  const range = elements.minSize.closest<HTMLElement>(".dual-range");
  range?.style.setProperty("--range-start", `${start * 100}%`);
  range?.style.setProperty("--range-end", `${end * 100}%`);
  return { minPrintSize, maxPrintSize };
}

function updateRangeReadout(input: HTMLInputElement, output: HTMLElement, value: number): void {
  output.textContent = money(value);
  output.style.left = `${sizeToRangeProgress(value) * input.offsetWidth}px`;
}

function rangeProgress(value: number): number {
  return sizeToRangeProgress(value);
}

function sliderValueToSize(input: HTMLInputElement): number {
  const min = Number(input.min);
  const max = Number(input.max);
  const progress = Math.min(1, Math.max(0, (Number(input.value) - min) / Math.max(1, max - min)));
  const logMin = Math.log(MIN_PRINT_SIZE);
  const logMax = Math.log(MAX_PRINT_SIZE);
  const value = Math.exp(logMin + progress * (logMax - logMin));
  return clampPrintSize(value);
}

function sizeToSliderValue(value: number): number {
  return Math.round(sizeToRangeProgress(value) * RANGE_STEPS);
}

function sizeToRangeProgress(value: number): number {
  const logMin = Math.log(MIN_PRINT_SIZE);
  const logMax = Math.log(MAX_PRINT_SIZE);
  const clamped = Math.min(MAX_PRINT_SIZE, Math.max(MIN_PRINT_SIZE, value));
  return Math.min(1, Math.max(0, (Math.log(clamped) - logMin) / (logMax - logMin)));
}

function clampPrintSize(value: number): number {
  return Math.min(MAX_PRINT_SIZE, Math.max(MIN_PRINT_SIZE, Math.round(value / 1_000) * 1_000));
}

function showRangeReadout(input: HTMLInputElement): void {
  input.closest(".dual-range")?.classList.add(input === elements.minSize ? "show-min" : "show-max");
}

function hideRangeReadout(input: HTMLInputElement): void {
  input.closest(".dual-range")?.classList.remove(input === elements.minSize ? "show-min" : "show-max");
}

function readResonatorParams(): Partial<ResonatorAudioParams> {
  return {
    maxVoices: Number(elements.resonator.maxVoices.input.value),
    baseFrequency: Number(elements.resonator.baseFrequency.input.value),
    structure: Number(elements.resonator.structure.input.value),
    baseDamping: Number(elements.resonator.baseDamping.input.value),
    basePosition: Number(elements.resonator.basePosition.input.value),
    dampingLift: Number(elements.resonator.dampingLift.input.value),
    positionSpread: Number(elements.resonator.positionSpread.input.value),
    brightness: Number(elements.resonator.brightness.input.value),
    release: Number(elements.resonator.release.input.value),
  };
}

function syncResonatorControls(): void {
  const params = readResonatorParams();
  elements.resonator.maxVoices.value.textContent = String(Math.round(params.maxVoices ?? 0));
  elements.resonator.baseFrequency.value.textContent = `${Math.round(params.baseFrequency ?? 0)} st`;
  elements.resonator.structure.value.textContent = (params.structure ?? 0).toFixed(2);
  elements.resonator.baseDamping.value.textContent = (params.baseDamping ?? 0).toFixed(2);
  elements.resonator.basePosition.value.textContent = (params.basePosition ?? 0).toFixed(2);
  elements.resonator.dampingLift.value.textContent = (params.dampingLift ?? 0).toFixed(2);
  elements.resonator.positionSpread.value.textContent = (params.positionSpread ?? 0).toFixed(2);
  elements.resonator.brightness.value.textContent = (params.brightness ?? 0).toFixed(2);
  elements.resonator.release.value.textContent = `${(params.release ?? 0).toFixed(2)}s`;
  audio.setResonatorParams(params);
}

function readLiquidParams(): { mouseSize: number; viscosity: number; waveHeight: number } {
  return {
    mouseSize: Number(elements.liquid.mouseSize.input.value),
    viscosity: Number(elements.liquid.viscosity.input.value),
    waveHeight: Number(elements.liquid.waveHeight.input.value),
  };
}

function syncLiquidControls(): void {
  const params = readLiquidParams();
  elements.liquid.mouseSize.value.textContent = String(Math.round(params.mouseSize));
  elements.liquid.viscosity.value.textContent = params.viscosity.toFixed(3);
  elements.liquid.waveHeight.value.textContent = params.waveHeight.toFixed(2);
  renderer?.setLiquidParams(params);
}

function loadAudioSettings(): void {
  const saved = window.localStorage.getItem(AUDIO_SETTINGS_KEY);
  if (!saved) return;
  try {
    const params = JSON.parse(saved) as Partial<Record<keyof ResonatorAudioParams, number>>;
    type ResonatorControl = { input: HTMLInputElement; value: HTMLElement };
    for (const [key, resonatorControl] of Object.entries(elements.resonator) as Array<[keyof ResonatorAudioParams, ResonatorControl]>) {
      const value = params[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        resonatorControl.input.value = String(value);
      }
    }
  } catch {
    window.localStorage.removeItem(AUDIO_SETTINGS_KEY);
  }
}

function saveAudioSettings(): void {
  window.localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(readResonatorParams()));
  const label = elements.saveAudioSettings.textContent;
  elements.saveAudioSettings.textContent = "Saved";
  window.setTimeout(() => {
    elements.saveAudioSettings.textContent = label || "Save";
  }, 900);
}

function closeDropdowns(except?: HTMLDetailsElement): void {
  for (const dropdown of document.querySelectorAll<HTMLDetailsElement>(".pair-menu, .group-menu, .resonator-menu, .liquid-menu")) {
    if (dropdown !== except) dropdown.removeAttribute("open");
  }
}

function setShaping(next: FeedShaping): void {
  flushCurrentTapePrint();
  feedShaping = next;
  elements.raw.classList.toggle("active", next === "raw");
  elements.aggregated.classList.toggle("active", next === "aggregated");
}

elements.live.addEventListener("click", () => void setMode("live"));
elements.off.addEventListener("click", () => void setMode("off"));
elements.symbolOptions.forEach((option) => {
  option.addEventListener("click", () => {
    setMarket(option.dataset.market as Market);
    option.closest("details")?.removeAttribute("open");
  });
});
elements.raw.addEventListener("click", () => setShaping("raw"));
elements.aggregated.addEventListener("click", () => setShaping("aggregated"));
[elements.minSize, elements.maxSize].forEach((input) => {
  input.addEventListener("input", () => {
    showRangeReadout(input);
    flushCurrentTapePrint();
    syncSettings();
  });
  input.addEventListener("pointerdown", () => showRangeReadout(input));
  input.addEventListener("pointerup", () => hideRangeReadout(input));
  input.addEventListener("pointercancel", () => hideRangeReadout(input));
  input.addEventListener("focus", () => showRangeReadout(input));
  input.addEventListener("blur", () => hideRangeReadout(input));
});
elements.aggregateOptions.forEach((option) => {
  option.addEventListener("click", () => {
    const value = Number(option.dataset.aggregateValue);
    if (option.dataset.aggregateKind === "window") {
      setAggregate(value, aggregateState.bucket);
    } else {
      setAggregate(aggregateState.windowMs, value);
    }
  });
});
document.querySelectorAll<HTMLDetailsElement>(".pair-menu, .group-menu, .resonator-menu, .liquid-menu").forEach((dropdown) => {
  dropdown.addEventListener("toggle", () => {
    if (dropdown.open) closeDropdowns(dropdown);
  });
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Node && !document.querySelector(".pair-menu, .group-menu, .resonator-menu, .liquid-menu")?.contains(target)) {
    const openDropdown = [...document.querySelectorAll<HTMLDetailsElement>(".pair-menu, .group-menu, .resonator-menu, .liquid-menu")]
      .find((dropdown) => dropdown.open && dropdown.contains(target));
    if (!openDropdown) closeDropdowns();
  }
});
Object.values(elements.resonator).forEach(({ input }) => {
  input.addEventListener("input", syncResonatorControls);
});
Object.values(elements.liquid).forEach((controlOrButton) => {
  if ("input" in controlOrButton) controlOrButton.input.addEventListener("input", syncLiquidControls);
});
elements.liquid.smoothWater.addEventListener("click", () => renderer?.smoothWater());
elements.saveAudioSettings.addEventListener("click", saveAudioSettings);

// ── Mobile chrome: burger menu, draggable tape drawer, portrait visual ───────
const appShell = mustQuery<HTMLElement>(".app-shell");
const burgerToggle = mustQuery<HTMLButtonElement>("#burgerToggle");
const tapePanel = mustQuery<HTMLElement>(".side-panel");
const tapeHandle = mustQuery<HTMLButtonElement>("#tapeHandle");

burgerToggle.addEventListener("click", () => {
  const open = appShell.classList.toggle("menu-open");
  burgerToggle.setAttribute("aria-expanded", String(open));
});

// On mobile the flow field is rotated so buys sink to the bottom and sells rise
// to the top; keep it in sync with the layout breakpoint.
const mobileMedia = window.matchMedia("(max-width: 820px)");
const syncOrientation = () => renderer?.setOrientation(mobileMedia.matches ? "portrait" : "landscape");
mobileMedia.addEventListener("change", syncOrientation);
syncOrientation();

// Grab/drag the tape up or down (it grows above the always-visible flow
// metrics); a tap toggles, release snaps open or closed.
const tapeMaxHeight = () => Math.min(window.innerHeight * 0.56, 460);
let tapeDragStartY = 0;
let tapeDragStartH = 0;
let tapeDragging = false;
let tapeDragMoved = false;
let tapeCurrentH = 0;

tapeHandle.addEventListener("pointerdown", (event) => {
  tapeDragging = true;
  tapeDragMoved = false;
  tapeDragStartY = event.clientY;
  tapeDragStartH = elements.tape.getBoundingClientRect().height;
  tapeCurrentH = tapeDragStartH;
  tapePanel.classList.add("dragging");
  tapeHandle.setPointerCapture(event.pointerId);
});

tapeHandle.addEventListener("pointermove", (event) => {
  if (!tapeDragging) return;
  const dy = tapeDragStartY - event.clientY; // drag up → grow
  if (Math.abs(dy) > 4) tapeDragMoved = true;
  tapeCurrentH = Math.min(tapeMaxHeight(), Math.max(0, tapeDragStartH + dy));
  elements.tape.style.height = `${tapeCurrentH}px`;
});

function endTapeDrag(event: PointerEvent): void {
  if (!tapeDragging) return;
  tapeDragging = false;
  tapePanel.classList.remove("dragging");
  elements.tape.style.height = "";
  if (tapeHandle.hasPointerCapture(event.pointerId)) tapeHandle.releasePointerCapture(event.pointerId);
  const open = tapeDragMoved ? tapeCurrentH > tapeMaxHeight() / 2 : !appShell.classList.contains("tape-open");
  appShell.classList.toggle("tape-open", open);
}

tapeHandle.addEventListener("pointerup", endTapeDrag);
tapeHandle.addEventListener("pointercancel", endTapeDrag);
loadAudioSettings();
syncResonatorControls();
syncLiquidControls();
syncSettings();
setMarket(settings.market);
renderer?.render(settings);
void setMode(feedMode);
setShaping(feedShaping);
updateTapeAges();
decayStats();
