import { LiquidRenderer } from "../visual/liquidRenderer";
import type { ScannerSettings, Side, TradeEvent } from "../types";
import "./visual-lab.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

root.innerHTML = `
  <main class="visual-lab">
    <canvas id="visualCanvas" aria-label="Isolated liquid visual renderer"></canvas>
    <section class="feed-panel" aria-label="Market feed">
      <span class="feed-label">Market Feed</span>
      <label class="feed-control">
        <span>Pair</span>
        <select id="marketSelect">
          <option value="BTC" selected>BTC</option>
          <option value="ETH">ETH</option>
          <option value="SOL">SOL</option>
          <option value="HYPE">HYPE</option>
        </select>
      </label>
      <div class="feed-toggle" aria-label="Shaping">
        <button id="rawButton" type="button">Raw</button>
        <button id="aggregatedButton" class="active" type="button">Aggregated</button>
      </div>
      <label class="feed-control">
        <span>Min</span>
        <select id="minSize">
          <option value="0" selected>0</option>
          <option value="1000">$1k+</option>
          <option value="10000">$10k+</option>
          <option value="50000">$50k+</option>
          <option value="100000">$100k+</option>
        </select>
      </label>
      <label class="feed-control">
        <span>Window</span>
        <select id="windowMs">
          <option value="250" selected>250ms</option>
          <option value="500">500ms</option>
          <option value="1000">1000ms</option>
        </select>
      </label>
      <label class="feed-control">
        <span>Bucket</span>
        <select id="priceBucket">
          <option value="0">Exact</option>
          <option value="0.01">$0.01</option>
          <option value="0.05">$0.05</option>
          <option value="0.1">$0.10</option>
          <option value="0.25">$0.25</option>
          <option value="0.5">$0.50</option>
          <option value="1" selected>$1</option>
          <option value="2">$2</option>
          <option value="5">$5</option>
        </select>
      </label>
      <div class="segment" aria-label="Data mode">
        <button id="offButton" type="button">Off</button>
        <button id="liveButton" class="active" type="button">Live</button>
      </div>
      <div class="status-row">
        <span class="status-light live"></span>
        <span>Visual Lab</span>
      </div>
      <div class="test-row" aria-label="Visual test triggers">
        <span class="feed-label">Impact Test</span>
        <button id="burstBuy" type="button">Buy Burst</button>
        <button id="burstSell" type="button">Sell Burst</button>
        <button id="auto" type="button">Auto Off</button>
        <span id="readout" class="readout">Ready</span>
      </div>
      <div class="button-grid" aria-label="Buy impact tests">
        <button data-side="buy" data-size="500">$500 Buy</button>
        <button data-side="buy" data-size="5000">$5k Buy</button>
        <button data-side="buy" data-size="50000">$50k Buy</button>
        <button data-side="buy" data-size="250000">$250k Buy</button>
      </div>
      <div class="button-grid" aria-label="Sell impact tests">
        <button data-side="sell" data-size="500">$500 Sell</button>
        <button data-side="sell" data-size="5000">$5k Sell</button>
        <button data-side="sell" data-size="50000">$50k Sell</button>
        <button data-side="sell" data-size="250000">$250k Sell</button>
      </div>
    </section>
  </main>
`;

const canvas = document.getElementById("visualCanvas");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing visual canvas");

const controls = {
  market: must<HTMLSelectElement>("marketSelect"),
  minSize: must<HTMLSelectElement>("minSize"),
  windowMs: must<HTMLSelectElement>("windowMs"),
  priceBucket: must<HTMLSelectElement>("priceBucket"),
  raw: must<HTMLButtonElement>("rawButton"),
  aggregated: must<HTMLButtonElement>("aggregatedButton"),
  live: must<HTMLButtonElement>("liveButton"),
  off: must<HTMLButtonElement>("offButton"),
  auto: must<HTMLButtonElement>("auto"),
  burstBuy: must<HTMLButtonElement>("burstBuy"),
  burstSell: must<HTMLButtonElement>("burstSell"),
  readout: must<HTMLElement>("readout"),
};

let settings: ScannerSettings = {
  market: "BTC",
  mode: "demo",
  minPrintSize: 0,
  sensitivity: 1.15,
  clusterWindowMs: 250,
  volume: 0.28,
  timbre: 0.45,
  space: 0.35,
  cascadeIntensity: 1,
  viscosity: 0.7,
  turbulence: 0.55,
};

const renderer = new LiquidRenderer(canvas);
let autoTimer = 0;
let shaping: "raw" | "aggregated" = "aggregated";

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function syncSettings(): void {
  settings = {
    ...settings,
    market: controls.market.value as ScannerSettings["market"],
    minPrintSize: Number(controls.minSize.value),
    clusterWindowMs: Number(controls.windowMs.value),
  };
}

function trigger(side: Side, size: number): void {
  syncSettings();
  const price = settings.market === "BTC" ? 63_500 : settings.market === "ETH" ? 3_500 : settings.market === "SOL" ? 150 : 30;
  const trade: TradeEvent = {
    market: settings.market,
    side,
    price,
    size,
    quantity: size / price,
    timestamp: Date.now(),
    source: "demo",
  };
  renderer.pushTrade(trade, settings);
  controls.readout.textContent = `${side.toUpperCase()} $${size.toLocaleString("en-US")}`;
}

function burst(side: Side): void {
  const sizes = [1_000, 4_000, 12_000, 35_000, 85_000, 240_000];
  sizes.forEach((size, index) => {
    window.setTimeout(() => trigger(side, size), index * 115);
  });
}

function setAuto(enabled: boolean): void {
  window.clearInterval(autoTimer);
  autoTimer = 0;
  controls.auto.textContent = enabled ? "Auto On" : "Auto Off";
  controls.auto.classList.toggle("active", enabled);
  if (!enabled) return;

  autoTimer = window.setInterval(() => {
    const side: Side = Math.random() > 0.52 ? "buy" : "sell";
    const size = Math.round(Math.pow(10, 2.7 + Math.random() * 3.15));
    trigger(side, size);
  }, 430);
}

document.querySelectorAll<HTMLButtonElement>("[data-side][data-size]").forEach((button) => {
  button.addEventListener("click", () => trigger(button.dataset.side as Side, Number(button.dataset.size)));
});

controls.market.addEventListener("change", syncSettings);
controls.minSize.addEventListener("change", syncSettings);
controls.windowMs.addEventListener("change", syncSettings);
controls.priceBucket.addEventListener("change", syncSettings);
controls.raw.addEventListener("click", () => {
  shaping = "raw";
  controls.raw.classList.add("active");
  controls.aggregated.classList.remove("active");
  controls.windowMs.disabled = true;
  controls.priceBucket.disabled = true;
});
controls.aggregated.addEventListener("click", () => {
  shaping = "aggregated";
  controls.raw.classList.remove("active");
  controls.aggregated.classList.add("active");
  controls.windowMs.disabled = false;
  controls.priceBucket.disabled = false;
});
controls.live.addEventListener("click", () => {
  controls.live.classList.add("active");
  controls.off.classList.remove("active");
});
controls.off.addEventListener("click", () => {
  controls.off.classList.add("active");
  controls.live.classList.remove("active");
  setAuto(false);
});
controls.burstBuy.addEventListener("click", () => burst("buy"));
controls.burstSell.addEventListener("click", () => burst("sell"));
controls.auto.addEventListener("click", () => setAuto(!autoTimer));

void shaping;
renderer.render(settings);
window.setTimeout(() => burst("buy"), 250);
window.setTimeout(() => burst("sell"), 1_150);
