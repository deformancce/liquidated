import { clamp } from "../utils/format";
import type { FlowSignal, ScannerSettings, Side, TradeEvent } from "../types";
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
  buy: [69, 209, 150],
  sell: [255, 91, 110],
  cascade: [247, 198, 93],
  absorption: [100, 215, 255],
  core: [244, 241, 232],
};

export class LiquidRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private fluid: FluidSimulation | null = null;
  private particles: Particle[] = [];
  private lastFrame = performance.now();
  private pressure = 0;
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
    if (this.fluid) {
      const fromLeft = trade.side === "buy";
      this.fluid.setConfig({
        densityDissipation: 0.982 + settings.viscosity * 0.012,
        velocityDissipation: 0.955 + settings.viscosity * 0.028,
        curl: settings.turbulence + intensity * 0.08,
        splatRadius: 0.0028 + intensity * 0.0018,
      });
      this.fluid.splat({
        x: fromLeft ? 0.18 : 0.82,
        y: 0.22 + Math.random() * 0.58,
        dx: (fromLeft ? 1 : -1) * (0.8 + intensity * 1.8),
        dy: (Math.random() - 0.5) * (0.6 + settings.turbulence),
        color: COLORS[trade.side],
        radius: 0.0028 + intensity * 0.0022,
        force: 1.2 + intensity,
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
    if (this.fluid) {
      const isCascade = signal.type === "cascadeRisk";
      const isAbsorption = signal.type.includes("absorption");
      const fromLeft = side === "buy" || isAbsorption;
      this.fluid.setConfig({
        densityDissipation: isCascade ? 0.992 : 0.984 + settings.viscosity * 0.01,
        velocityDissipation: isCascade ? 0.972 : 0.958 + settings.viscosity * 0.022,
        curl: settings.turbulence + signal.intensity * (isCascade ? 0.26 : 0.11),
        splatRadius: 0.004 + signal.intensity * (isCascade ? 0.0028 : 0.0016),
      });
      this.fluid.splat({
        x: isCascade ? 0.5 : fromLeft ? 0.24 : 0.76,
        y: isCascade ? 0.5 : 0.26 + Math.random() * 0.52,
        dx: isCascade ? (Math.random() - 0.5) * 5 : (fromLeft ? 1 : -1) * (1.6 + signal.intensity),
        dy: isCascade ? (Math.random() - 0.5) * 5 : (Math.random() - 0.5) * 1.2,
        color: COLORS[colorKey],
        radius: 0.004 + signal.intensity * (isCascade ? 0.003 : 0.0014),
        force: isCascade ? 3 + signal.intensity : 1.4 + signal.intensity,
      });
      return;
    }

    const count = Math.round(clamp(signal.intensity * 14, 5, 64));
    this.turbulence += signal.intensity * (signal.type === "cascadeRisk" ? 0.26 : 0.11);
    this.spawn(colorKey, count, signal.intensity, settings);
  }

  render(settings: ScannerSettings): void {
    if (this.fluid) {
      this.fluid.setConfig({
        densityDissipation: 0.982 + settings.viscosity * 0.012,
        velocityDissipation: 0.955 + settings.viscosity * 0.026,
        curl: settings.turbulence,
      });
      this.fluid.render();
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
