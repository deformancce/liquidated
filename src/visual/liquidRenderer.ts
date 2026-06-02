import { clamp } from "../utils/format";
import type { FlowSignal, ScannerSettings, Side, TradeEvent } from "../types";
import { MARKET_CONFIG } from "../config/markets";
import { FluidSimulation } from "./fluid/FluidSimulation";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  life: number;
  decay: number;
  color: [number, number, number];
  pressure: number;
}

const COLORS: Record<Side | "cascade" | "absorption" | "core", [number, number, number]> = {
  buy: [118, 218, 168],
  sell: [235, 104, 119],
  cascade: [238, 196, 86],
  absorption: [188, 222, 232],
  core: [242, 241, 236],
};

const FLUID_PRESET = {
  densityDissipation: 1,
  velocityDissipation: 2.38,
  pressure: 0.62,
  vorticity: 0,
  splatRadius: 0.18,
  bloomIntensity: 0.8,
  bloomThreshold: 0.6,
  sunraysWeight: 1,
};

export class LiquidRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private fluid: FluidSimulation | null = null;
  private particles: Particle[] = [];
  private lastFrame = performance.now();
  private lastAmbientSplat = 0;
  private pressure = 0;
  private pressureBias = 0;
  private turbulence = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    try {
      this.fluid = new FluidSimulation(canvas);
    } catch {
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Canvas context is unavailable");
      this.ctx = context;
      this.fit();
      window.addEventListener("resize", () => this.fit());
    }
  }

  fit(): void {
    if (!this.ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  pushTrade(trade: TradeEvent, settings: ScannerSettings): void {
    const intensity = clamp(Math.log10(trade.size + 1) / 6, 0.25, 1.75) * settings.sensitivity;
    this.applyPressure(trade.side === "buy" ? intensity : -intensity);

    if (this.fluid) {
      const pressureX = this.pressureToX();
      const sideOffset = trade.side === "buy" ? 0.11 : -0.11;
      const x = clamp(pressureX + sideOffset + (Math.random() - 0.5) * 0.12, 0.05, 0.95);
      const y = this.sizeToY(trade.size, settings);
      this.applyFluidPreset(0, intensity * 0.08);
      this.fluid.splat({
        x,
        y: clamp(y + (Math.random() - 0.5) * 0.08, 0.08, 0.92),
        dx: this.pressureBias * (1.2 + intensity * 1.2) + (trade.side === "buy" ? 0.42 : -0.42),
        dy: (0.5 - y) * 0.9 + (Math.random() - 0.5) * 0.55,
        color: COLORS[trade.side],
        radius: this.splatRadius(intensity, false),
        force: 0.85 + intensity * 0.86,
      });
      return;
    }

    const count = Math.round(clamp(intensity * 8, 2, 28));
    this.pressure += trade.side === "buy" ? intensity : -intensity;
    this.turbulence += intensity * 0.06;
    this.spawn(trade.side, count, intensity, settings);
  }

  pushSignal(signal: FlowSignal, settings: ScannerSettings): void {
    const side = signal.side === "neutral" ? "buy" : signal.side;
    const colorKey = signal.type === "cascadeRisk" ? "cascade" : signal.type.includes("absorption") ? "absorption" : side;
    if (signal.side !== "neutral") {
      this.applyPressure(signal.side === "buy" ? signal.intensity * 1.35 : -signal.intensity * 1.35);
    }

    if (this.fluid) {
      const isCascade = signal.type === "cascadeRisk";
      const isAbsorption = signal.type.includes("absorption");
      const pressureX = this.pressureToX();
      const absorptionOffset = isAbsorption ? -Math.sign(this.pressureBias || (side === "buy" ? 1 : -1)) * 0.16 : 0;
      const x = isCascade ? pressureX : clamp(pressureX + absorptionOffset + (Math.random() - 0.5) * 0.16, 0.08, 0.92);
      const y = this.sizeToY(signal.size, settings);
      this.applyFluidPreset(isCascade ? 0.02 : 0, signal.intensity * (isCascade ? 0.14 : 0.07));
      if (isCascade) {
        this.pushLiquidationShockwave(signal.intensity, signal.size, settings);
        return;
      }

      this.fluid.splat({
        x,
        y: clamp(y + (Math.random() - 0.5) * 0.08, 0.08, 0.92),
        dx: isCascade ? this.pressureBias * 4.2 + (Math.random() - 0.5) * 2.2 : this.pressureBias * (1.5 + signal.intensity) + (side === "buy" ? 0.36 : -0.36),
        dy: isCascade ? (Math.random() - 0.5) * 4.2 : (0.5 - y) * 1.2 + (Math.random() - 0.5) * 0.9,
        color: COLORS[colorKey],
        radius: this.splatRadius(signal.intensity, isCascade),
        force: isCascade ? 2.4 + signal.intensity * 0.8 : 1 + signal.intensity * 0.72,
      });
      return;
    }

    const count = Math.round(clamp(signal.intensity * 14, 5, 64));
    this.turbulence += signal.intensity * (signal.type === "cascadeRisk" ? 0.26 : 0.11);
    this.spawn(colorKey, count, signal.intensity, settings);
  }

  render(settings: ScannerSettings): void {
    if (this.fluid) {
      this.applyFluidPreset();
      this.pushAmbientFluid(settings);
      this.fluid.render();
      this.pressureBias *= 0.992;
      requestAnimationFrame(() => this.render(settings));
      return;
    }

    if (!this.ctx) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.04);
    this.lastFrame = now;

    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.ctx.clearRect(0, 0, width, height);
    this.drawField(width, height, now, settings);
    this.drawCore(width, height, now, settings);
    this.drawParticles(dt);

    this.pressure *= 0.985;
    this.pressureBias *= 0.992;
    this.turbulence *= 0.965;
    requestAnimationFrame(() => this.render(settings));
  }

  private spawn(colorKey: Side | "cascade" | "absorption", count: number, intensity: number, settings: ScannerSettings): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const fromLeft = colorKey === "buy" || colorKey === "absorption";
    const originX = fromLeft ? width * 0.16 : width * 0.84;
    const targetX = fromLeft ? width * 0.72 : width * 0.28;
    const originY = height * (0.22 + Math.random() * 0.58);
    const color = COLORS[colorKey];

    for (let i = 0; i < count; i += 1) {
      const speed = 70 + Math.random() * 240 * intensity;
      const angle = Math.atan2(height * 0.52 - originY, targetX - originX) + (Math.random() - 0.5) * (0.55 + settings.turbulence * 0.45);
      this.particles.push({
        x: originX + (Math.random() - 0.5) * 90,
        y: originY + (Math.random() - 0.5) * 90,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 1.2 + Math.random() * 5.4 * intensity,
        life: 1,
        decay: 0.52 + Math.random() * 0.58 + (1 - settings.viscosity) * 0.28,
        color,
        pressure: intensity,
      });
    }
  }

  private pushAmbientFluid(settings: ScannerSettings): void {
    if (!this.fluid) return;
    const now = performance.now();
    if (now - this.lastAmbientSplat < 240) return;
    this.lastAmbientSplat = now;

    const drift = Math.sin(now * 0.0002) * 0.36;
    const pressureX = this.pressureToX();
    this.fluid.splat({
      x: clamp(pressureX + drift * 0.28 + (Math.random() - 0.5) * 0.18, 0.08, 0.92),
      y: 0.18 + Math.random() * 0.68,
      dx: this.pressureBias * 0.65 + (Math.random() - 0.5) * (0.42 + settings.turbulence * 0.36),
      dy: 0.25 + Math.random() * 0.55,
      color: COLORS.core,
      radius: this.splatRadius(0.85, false) * 1.15,
      force: 0.16 + settings.turbulence * 0.08,
    });
  }

  private pushLiquidationShockwave(intensity: number, size: number, settings: ScannerSettings): void {
    if (!this.fluid) return;
    const direction = this.pressureBias >= 0 ? 1 : -1;
    const startX = direction > 0 ? 0.08 : 0.92;
    const force = 2.8 + intensity * 1.2;
    const radius = this.splatRadius(intensity, true);
    const y = this.sizeToY(size, settings);
    const rows = [-0.18, -0.06, 0.06, 0.18].map((offset) => clamp(y + offset, 0.08, 0.92));

    rows.forEach((y, index) => {
      const phase = index / Math.max(1, rows.length - 1);
      this.fluid?.splat({
        x: clamp(startX + direction * phase * 0.22, 0.06, 0.94),
        y,
        dx: direction * force * (1.15 - phase * 0.28),
        dy: (phase - 0.5) * (1.5 + settings.turbulence),
        color: COLORS.cascade,
        radius,
        force: 2.6 + intensity * 0.7,
      });
    });

    this.fluid.splat({
      x: this.pressureToX(),
      y,
      dx: direction * force * 1.65,
      dy: 0,
      color: COLORS.core,
      radius: radius * 1.45,
      force: 3.4 + intensity,
    });
  }

  private applyPressure(delta: number): void {
    this.pressureBias = clamp(this.pressureBias * 0.86 + delta * 0.075, -1, 1);
  }

  private pressureToX(): number {
    return clamp(0.5 + this.pressureBias * 0.34, 0.08, 0.92);
  }

  private sizeToY(size: number, settings: ScannerSettings): number {
    const config = MARKET_CONFIG[settings.market];
    const min = Math.max(1, settings.minPrintSize || config.minPrintSize);
    const max = Math.max(min * 4, config.clusterSize * 4);
    const score = Math.log(Math.max(size, min) / min) / Math.log(max / min);
    return clamp(0.9 - clamp(score, 0, 1) * 0.78, 0.1, 0.9);
  }

  private splatRadius(intensity: number, isLiquidation: boolean): number {
    const base = FLUID_PRESET.splatRadius / 100;
    return base * (isLiquidation ? 7.2 : 3.6) + intensity * (isLiquidation ? 0.0052 : 0.0028);
  }

  private applyFluidPreset(densityLift = 0, curlLift = 0): void {
    this.fluid?.setConfig({
      densityDissipation: clamp(1 - FLUID_PRESET.densityDissipation * 0.012 + densityLift, 0.94, 0.998),
      velocityDissipation: clamp(1 - FLUID_PRESET.velocityDissipation * 0.012, 0.9, 0.992),
      pressure: FLUID_PRESET.pressure,
      curl: FLUID_PRESET.vorticity + curlLift,
      splatRadius: FLUID_PRESET.splatRadius / 100,
      bloomIntensity: FLUID_PRESET.bloomIntensity,
      bloomThreshold: FLUID_PRESET.bloomThreshold,
      sunraysWeight: FLUID_PRESET.sunraysWeight,
    });
  }

  private drawField(width: number, height: number, now: number, settings: ScannerSettings): void {
    if (!this.ctx) return;
    const gap = 42;
    const offset = (now * 0.018 * (1 + this.turbulence)) % gap;
    this.ctx.strokeStyle = "rgba(255,255,255,0.045)";
    this.ctx.lineWidth = 1;

    for (let x = -gap; x < width + gap; x += gap) {
      this.ctx.beginPath();
      this.ctx.moveTo(x + offset, 0);
      this.ctx.lineTo(x + offset - width * 0.16 + this.pressure * settings.viscosity, height);
      this.ctx.stroke();
    }

    for (let y = -gap; y < height + gap; y += gap) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y + offset);
      this.ctx.lineTo(width, y + offset + this.turbulence * 28);
      this.ctx.stroke();
    }
  }

  private drawCore(width: number, height: number, now: number, settings: ScannerSettings): void {
    if (!this.ctx) return;
    const x = width * 0.5 + clamp(this.pressure, -80, 80);
    const y = height * 0.52;
    const pulse = 0.78 + Math.sin(now * 0.003) * 0.08 + clamp(this.turbulence, 0, 0.42);
    const radius = Math.min(width, height) * 0.16 * pulse * (0.8 + settings.viscosity * 0.35);
    const gradient = this.ctx.createRadialGradient(x, y, radius * 0.1, x, y, radius);

    gradient.addColorStop(0, "rgba(244,241,232,0.38)");
    gradient.addColorStop(0.34, "rgba(100,215,255,0.18)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");

    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.strokeStyle = "rgba(244,241,232,0.36)";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius * 0.64, now * 0.001, now * 0.001 + Math.PI * (1.3 + this.turbulence));
    this.ctx.stroke();
  }

  private drawParticles(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.globalCompositeOperation = "lighter";
    this.particles = this.particles.filter((particle) => {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= 0.99;
      particle.vy *= 0.99;
      particle.life -= particle.decay * dt;

      if (particle.life <= 0) return false;

      const [r, g, b] = particle.color;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${particle.life})`;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${particle.life})`;
      ctx.shadowBlur = 10 + particle.pressure * 9;
      ctx.arc(particle.x, particle.y, particle.radius * particle.life, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
  }
}
