import { MARKET_CONFIG } from "../config/markets";
import { shapeTrade } from "../synth/tradeMapping";
import type { FlowSignal, ScannerSettings, TradeEvent } from "../types";
import { clamp } from "../utils/format";
import { FluidSimulation, type LiquidVisualParams } from "./fluid/FluidSimulation";

const COLORS = {
  buy: [38, 255, 148] as [number, number, number],
  sell: [255, 52, 76] as [number, number, number],
  neutral: [235, 245, 248] as [number, number, number],
};

const BASE_NOTIONAL = 1_000;
const MAX_VISUAL_NOTIONAL = 1_000_000;
const DEFAULT_MOUSE_SIZE = 63;
const MAX_MOUSE_SIZE = 220;
const DEFAULT_WAVE_HEIGHT = 1.1;
const MAX_WAVE_HEIGHT = 2.2;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class LiquidRenderer {
  private fluid: FluidSimulation;
  private pressureBias = 0;
  private animationFrame = 0;
  private priceLo: number | null = null;
  private priceHi: number | null = null;
  private market: ScannerSettings["market"] | null = null;
  private orientation: "landscape" | "portrait" = "landscape";
  private liquidParams: LiquidVisualParams = {
    mouseSize: DEFAULT_MOUSE_SIZE,
    viscosity: 0.985,
    waveHeight: DEFAULT_WAVE_HEIGHT,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.fluid = new FluidSimulation(canvas);
  }

  pushTrade(trade: TradeEvent, settings: ScannerSettings): void {
    const shaped = shapeTrade(trade, { baseDecay: 1, floor: settings.minPrintSize });
    if (this.market !== settings.market) {
      this.market = settings.market;
      this.priceLo = null;
      this.priceHi = null;
    }
    this.trackPrice(trade.price);
    const visualWeight = this.visualWeight(trade.size);
    const intensity = clamp((0.35 + shaped.mag * 1.45) * settings.sensitivity, 0.25, 1.95);
    const sideSign = trade.side === "buy" ? 1 : -1;
    this.pressureBias = clamp(this.pressureBias * 0.86 + sideSign * intensity * 0.075, -1, 1);

    const sideOffset = lerp(0.42, 0.08, visualWeight);
    const priceAxis = this.priceToY(trade.price);
    const flow = sideSign * (0.5 + shaped.visual.spread * 0.08);
    const jitter = (Math.random() - 0.5) * 0.22;
    const radius = lerp(this.liquidParams.mouseSize, MAX_MOUSE_SIZE, visualWeight);
    const force = lerp(this.liquidParams.waveHeight, MAX_WAVE_HEIGHT, visualWeight) * clamp(0.9 + shaped.mag * 0.45, 0.9, 1.35);

    // Portrait (mobile) rotates the field 90°: side runs vertically with buys
    // sinking toward the bottom and sells rising toward the top, price runs
    // left→right. The vertical spread is pulled inward so prints stay clear of
    // the top bar and the bottom metrics sheet, and scattered across the width
    // so the coloured lights fill the field instead of stacking in one column.
    const portrait = this.orientation === "portrait";
    this.fluid.splat({
      // Centre the horizontal (price) axis on the screen's middle axis with a
      // mild price drift + scatter, so the field stays symmetric across devices.
      x: portrait
        ? clamp(0.5 + (priceAxis - 0.5) * 0.34 + (Math.random() - 0.5) * 0.5, 0.08, 0.92)
        : clamp(0.5 + sideSign * sideOffset, 0.04, 0.96),
      y: portrait
        ? clamp(0.5 + sideSign * lerp(0.3, 0.08, visualWeight), 0.18, 0.82)
        : priceAxis,
      dx: portrait ? jitter : flow,
      dy: portrait ? flow : jitter,
      color: COLORS[trade.side],
      radius,
      force,
    });
  }

  pushSignal(signal: FlowSignal, settings: ScannerSettings): void {
    if (signal.side === "neutral") return;
    const visualWeight = this.visualWeight(signal.size);
    const sideSign = signal.side === "buy" ? 1 : -1;
    const sideAxis = clamp(0.5 + sideSign * 0.16 + this.pressureBias * 0.08, 0.08, 0.92);
    const sizeAxis = clamp(this.sizeToY(signal.size, settings), 0.08, 0.92);
    const flow = sideSign * (0.6 + signal.intensity * 0.4);
    const portrait = this.orientation === "portrait";

    this.fluid.splat({
      x: portrait ? clamp(0.5 + (sizeAxis - 0.5) * 0.4, 0.1, 0.9) : sideAxis,
      y: portrait ? clamp(0.5 + sideSign * 0.16, 0.18, 0.82) : sideAxis,
      dx: portrait ? 0 : flow,
      dy: portrait ? flow : 0,
      color: COLORS[signal.side],
      radius: lerp(this.liquidParams.mouseSize * 0.9, MAX_MOUSE_SIZE * 0.8, visualWeight),
      force: lerp(this.liquidParams.waveHeight * 0.8, MAX_WAVE_HEIGHT, visualWeight) * clamp(signal.intensity, 0.8, 1.8),
    });
  }

  setOrientation(orientation: "landscape" | "portrait"): void {
    this.orientation = orientation;
    this.fluid.setOrientation(orientation);
  }

  setLiquidParams(params: Partial<LiquidVisualParams>): void {
    this.liquidParams = { ...this.liquidParams, ...params };
    this.fluid.setLiquidParams(this.liquidParams);
  }

  smoothWater(): void {
    this.fluid.smoothNow();
  }

  render(settings: ScannerSettings): void {
    this.fluid.setConfig({
      densityDissipation: 1,
      velocityDissipation: this.liquidParams.viscosity,
      pressure: 0,
      curl: settings.turbulence,
      splatRadius: 0,
      bloomIntensity: 0,
      bloomThreshold: 0,
      sunraysWeight: 0,
    });
    this.fluid.render();
    this.pressureBias *= 0.992;
    this.animationFrame = window.requestAnimationFrame(() => this.render(settings));
  }

  stop(): void {
    if (this.animationFrame) window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  private visualWeight(size: number): number {
    const safe = Math.max(size, BASE_NOTIONAL);
    return clamp(Math.log(safe / BASE_NOTIONAL) / Math.log(MAX_VISUAL_NOTIONAL / BASE_NOTIONAL), 0, 1);
  }

  private trackPrice(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    if (this.priceLo === null || this.priceHi === null) {
      this.priceLo = price * 0.999;
      this.priceHi = price * 1.001;
      return;
    }
    this.priceLo += (price - this.priceLo) * (price < this.priceLo ? 0.5 : 0.001);
    this.priceHi += (price - this.priceHi) * (price > this.priceHi ? 0.5 : 0.001);
  }

  private priceToY(price: number): number {
    if (this.priceLo === null || this.priceHi === null) return 0.5;
    const span = this.priceHi - this.priceLo;
    if (span <= 0) return 0.5;
    const n = clamp((price - this.priceLo) / span, 0, 1);
    return clamp(0.91 - n * 0.82, 0.09, 0.91);
  }

  private sizeToY(size: number, settings: ScannerSettings): number {
    const config = MARKET_CONFIG[settings.market];
    const min = Math.max(1, settings.minPrintSize || config.minPrintSize);
    const max = Math.max(min * 4, config.clusterSize * 4);
    const score = Math.log(Math.max(size, min) / min) / Math.log(max / min);
    return clamp(0.9 - clamp(score, 0, 1) * 0.78, 0.1, 0.9);
  }
}
