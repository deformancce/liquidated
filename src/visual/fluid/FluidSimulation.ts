import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { clamp } from "../../utils/format";
import SmoothFragment from "../../water/shaders/smoothFragment.glsl?raw";
import WaterFragment from "../../water-reflect/shaders/waterFragment.glsl?raw";
import WaterVertex from "../../water/shaders/waterVertex.glsl?raw";

export interface FluidConfig {
  densityDissipation: number;
  velocityDissipation: number;
  pressure: number;
  curl: number;
  splatRadius: number;
  bloomIntensity: number;
  bloomThreshold: number;
  sunraysWeight: number;
}

export interface FluidSplat {
  x: number;
  y: number;
  dx: number;
  dy: number;
  color: [number, number, number];
  radius: number;
  force: number;
}

interface PendingDrop {
  x: number;
  y: number;
  radius: number;
  strength: number;
  side: "buy" | "sell" | "neutral";
  visualWeight: number;
}

interface DyeSplat {
  u: number;
  v: number;
  side: "buy" | "sell";
  age: number;
  life: number;
  radius: number;
  strength: number;
  seed: number;
}

const FBO_WIDTH = 512;
const FBO_HEIGHT = 256;
const MAX_PENDING_DROPS = 48;
const DROPS_PER_FRAME = 10;
const DEFAULT_MOUSE_SIZE = 63;
const DEFAULT_WAVE_HEIGHT = 1.1;

export interface LiquidVisualParams {
  mouseSize: number;
  viscosity: number;
  waveHeight: number;
}

const HEIGHTMAP_FRAGMENT = `
  #define PI 3.1415926538

  uniform vec2 mousePos;
  uniform float mouseSize;
  uniform float viscosityConstant;
  uniform float waveheightMultiplier;

  void main() {
    vec2 cellSize = 1.0 / resolution.xy;
    vec2 uv = gl_FragCoord.xy * cellSize;
    vec4 heightmapValue = texture2D(heightmap, uv);

    vec4 north = texture2D(heightmap, uv + vec2(0.0, cellSize.y));
    vec4 south = texture2D(heightmap, uv + vec2(0.0, -cellSize.y));
    vec4 east = texture2D(heightmap, uv + vec2(cellSize.x, 0.0));
    vec4 west = texture2D(heightmap, uv + vec2(-cellSize.x, 0.0));

    float newHeight = ((north.x + south.x + east.x + west.x) * 0.5 - heightmapValue.y) * viscosityConstant;
    float mousePhase = clamp(length((uv - vec2(0.5)) * vec2(GEOM_WIDTH, GEOM_HEIGHT) - vec2(mousePos.x, -mousePos.y)) * PI / max(mouseSize, 1.0), 0.0, PI);
    newHeight += (cos(mousePhase) + 1.0) * waveheightMultiplier;

    heightmapValue.y = heightmapValue.x;
    heightmapValue.x = newHeight;
    gl_FragColor = heightmapValue;
  }
`;

export class FluidSimulation {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private waterMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private waterUniforms: THREE.ShaderMaterial["uniforms"];
  private gpuCompute!: GPUComputationRenderer;
  private heightmapVariable!: Variable;
  private smoothShader!: THREE.ShaderMaterial;
  private fboW = FBO_WIDTH;
  private fboH = FBO_HEIGHT;
  private sizeScale = 1;
  private pendingDrops: PendingDrop[] = [];
  private dyeSplats: DyeSplat[] = [];
  private reflectionCanvas = document.createElement("canvas");
  private reflectionCtx: CanvasRenderingContext2D;
  private reflectionTexture: THREE.CanvasTexture;
  private geomWidth = 1;
  private geomHeight = 1;
  private sideDominance = 0;
  private orientation: "landscape" | "portrait" = "landscape";
  private lastRender = performance.now();
  private elapsed = 0;
  private viscosity = 0.985;
  private mouseSize = DEFAULT_MOUSE_SIZE;
  private waveHeight = DEFAULT_WAVE_HEIGHT;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.reflectionCanvas.width = 2048;
    this.reflectionCanvas.height = 1024;
    const ctx = this.reflectionCanvas.getContext("2d");
    if (!ctx) throw new Error("Unable to create reflection texture");
    this.reflectionCtx = ctx;
    this.reflectionCtx.imageSmoothingEnabled = true;
    this.reflectionCtx.imageSmoothingQuality = "high";
    this.reflectionTexture = new THREE.CanvasTexture(this.reflectionCanvas);
    this.reflectionTexture.colorSpace = THREE.SRGBColorSpace;
    this.reflectionTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.reflectionTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.reflectionTexture.minFilter = THREE.LinearFilter;
    this.reflectionTexture.magFilter = THREE.LinearFilter;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.z = 100;
    this.camera.lookAt(0, 0, 0);

    const sun = new THREE.DirectionalLight(0xffffff, 5);
    sun.position.set(300, 400, 175);
    this.scene.add(sun);

    const sun2 = new THREE.DirectionalLight(0xffffff, 0.6);
    sun2.position.set(-100, 350, -200);
    this.scene.add(sun2);

    const material = this.createWaterMaterial();
    this.waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, this.fboW, this.fboH), material);
    this.waterMesh.matrixAutoUpdate = false;
    this.scene.add(this.waterMesh);
    this.waterUniforms = material.uniforms;

    this.buildCompute();

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.drawReflectionTexture(0);
  }

  // (Re)create the GPU heightmap simulation at the current FBO resolution. The
  // resolution tracks the viewport aspect (see resize) so simulation cells stay
  // roughly square and drops render round instead of stretched.
  private buildCompute(): void {
    (this.gpuCompute as GPUComputationRenderer | undefined)?.dispose?.();
    this.gpuCompute = new GPUComputationRenderer(this.fboW, this.fboH, this.renderer);
    if (!this.renderer.capabilities.isWebGL2) {
      this.gpuCompute.setDataType(THREE.HalfFloatType);
    }

    const heightmap0 = this.gpuCompute.createTexture();
    this.fillTexture(heightmap0);
    this.heightmapVariable = this.gpuCompute.addVariable("heightmap", HEIGHTMAP_FRAGMENT, heightmap0);
    this.gpuCompute.setVariableDependencies(this.heightmapVariable, [this.heightmapVariable]);
    this.heightmapVariable.material.uniforms.mousePos = { value: new THREE.Vector2(10000, 10000) };
    this.heightmapVariable.material.uniforms.mouseSize = { value: this.mouseSize };
    this.heightmapVariable.material.uniforms.viscosityConstant = { value: this.viscosity };
    this.heightmapVariable.material.uniforms.waveheightMultiplier = { value: this.waveHeight };

    const error = this.gpuCompute.init();
    if (error) throw new Error(error);
    this.smoothShader = this.gpuCompute.createShaderMaterial(SmoothFragment, { smoothTexture: { value: null } });
  }

  setConfig(config: Partial<FluidConfig>): void {
    this.viscosity = clamp(config.velocityDissipation ?? this.viscosity, 0.9, 0.999);
  }

  setLiquidParams(params: Partial<LiquidVisualParams>): void {
    this.mouseSize = clamp(params.mouseSize ?? this.mouseSize, 1, 240);
    this.viscosity = clamp(params.viscosity ?? this.viscosity, 0.9, 0.999);
    this.waveHeight = clamp(params.waveHeight ?? this.waveHeight, 0.1, 2.5);
  }

  setOrientation(orientation: "landscape" | "portrait"): void {
    this.orientation = orientation;
  }

  smoothNow(): void {
    this.smoothWater(10);
  }

  splat(input: FluidSplat): void {
    const side = input.color[1] > input.color[0] ? "buy" : input.color[0] > input.color[1] ? "sell" : "neutral";
    const minDim = Math.min(this.geomWidth, this.geomHeight);
    const baseRadius = input.radius <= 2 ? input.radius * minDim : input.radius;
    const radius = clamp(baseRadius * this.sizeScale, 8, 240);
    const strength = clamp(input.force, this.waveHeight, 2.5);
    const visualWeight = clamp(Math.max((radius - this.mouseSize) / 150, (strength - this.waveHeight) / 1.1), 0, 1);
    const positionedX =
      side === "neutral" || this.orientation === "portrait"
        ? input.x
        : this.positionXByDominance(input.x, side, strength);
    const x = clamp(positionedX, 0.035, 0.965);
    const y = clamp(input.y, 0.08, 0.92);

    this.pendingDrops.push({
      x: (x - 0.5) * this.geomWidth,
      y: (0.5 - y) * this.geomHeight,
      radius,
      strength,
      side,
      visualWeight,
    });
    if (this.pendingDrops.length > MAX_PENDING_DROPS) {
      this.pendingDrops.splice(0, this.pendingDrops.length - MAX_PENDING_DROPS);
    }

    if (side !== "neutral") {
      this.pushDyeSplat(x, y, side, radius, strength, visualWeight);
    }
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastRender) / 1000, 0.08);
    this.lastRender = now;
    this.elapsed += dt;
    this.sideDominance *= Math.exp(-dt / 3.8);

    const hmUniforms = this.heightmapVariable.material.uniforms;
    hmUniforms.viscosityConstant.value = this.viscosity;
    const drops = this.pendingDrops.splice(0, DROPS_PER_FRAME);

    if (drops.length === 0) {
      hmUniforms.mousePos.value.set(10000, 10000);
      hmUniforms.mouseSize.value = this.mouseSize;
      hmUniforms.waveheightMultiplier.value = this.waveHeight;
      this.gpuCompute.compute();
    } else {
      for (const drop of drops) {
        hmUniforms.mousePos.value.set(drop.x, drop.y);
        hmUniforms.mouseSize.value = drop.radius;
        hmUniforms.waveheightMultiplier.value = drop.strength;
        this.gpuCompute.compute();
        this.smoothWater(4);
      }
    }

    this.waterUniforms.heightmap.value = this.gpuCompute.getCurrentRenderTarget(this.heightmapVariable).texture;
    this.drawReflectionTexture(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private smoothWater(iterations: number): void {
    const currentRenderTarget = this.gpuCompute.getCurrentRenderTarget(this.heightmapVariable);
    const alternateRenderTarget = this.gpuCompute.getAlternateRenderTarget(this.heightmapVariable);

    for (let i = 0; i < iterations; i += 1) {
      this.smoothShader.uniforms.smoothTexture.value = currentRenderTarget.texture;
      this.gpuCompute.doRenderTarget(this.smoothShader, alternateRenderTarget);

      this.smoothShader.uniforms.smoothTexture.value = alternateRenderTarget.texture;
      this.gpuCompute.doRenderTarget(this.smoothShader, currentRenderTarget);
    }
  }

  private positionXByDominance(x: number, side: "buy" | "sell", strength: number): number {
    const direction = side === "buy" ? 1 : -1;
    const incomingWeight = clamp(strength * 0.08, 0.035, 0.16);
    const predictedDominance = clamp(this.sideDominance + direction * incomingWeight, -1, 1);
    const buyShift = Math.max(0, predictedDominance);
    const sellShift = Math.max(0, -predictedDominance);
    return side === "buy" ? x - buyShift * 0.34 : x + sellShift * 0.34;
  }

  private pushDyeSplat(x: number, y: number, side: "buy" | "sell", radius: number, strength: number, visualWeight: number): void {
    const direction = side === "buy" ? 1 : -1;
    this.sideDominance = clamp(this.sideDominance + direction * clamp(strength * 0.1, 0.045, 0.18), -1, 1);
    this.dyeSplats.push({
      u: x,
      v: y,
      side,
      age: 0,
      life: THREE.MathUtils.lerp(2.8, 8.5, visualWeight),
      // Extra sizeScale keeps the coloured glow proportional on small/portrait
      // screens (no-op at sizeScale 1 on desktop).
      radius: clamp(radius * 4.4 * this.sizeScale, 90 * this.sizeScale, 620),
      strength: clamp(strength * 0.55, 0.32, 1),
      seed: Math.random() * Math.PI * 2,
    });
  }

  private drawReflectionTexture(dt: number): void {
    const ctx = this.reflectionCtx;
    const w = this.reflectionCanvas.width;
    const h = this.reflectionCanvas.height;

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#020303";
    ctx.fillRect(0, 0, w, h);

    const base = ctx.createLinearGradient(0, 0, w, h);
    base.addColorStop(0.0, "#050606");
    base.addColorStop(0.28, "#313638");
    base.addColorStop(0.48, "#080909");
    base.addColorStop(0.72, "#6e7678");
    base.addColorStop(1.0, "#030404");
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    const buyDominance = Math.max(0, this.sideDominance);
    const sellDominance = Math.max(0, -this.sideDominance);
    if (this.orientation === "portrait") {
      // Portrait maps side to the vertical axis: buys glow up from the bottom,
      // sells down from the top.
      if (buyDominance > 0.01) {
        const edge = THREE.MathUtils.lerp(h * 0.98, h * 0.16, buyDominance);
        const g = ctx.createLinearGradient(0, edge, 0, h);
        g.addColorStop(0, "rgba(38,255,148,0)");
        g.addColorStop(0.48, `rgba(38,255,148,${0.12 + buyDominance * 0.16})`);
        g.addColorStop(1, `rgba(38,255,148,${0.22 + buyDominance * 0.28})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      if (sellDominance > 0.01) {
        const edge = THREE.MathUtils.lerp(h * 0.02, h * 0.84, sellDominance);
        const g = ctx.createLinearGradient(0, 0, 0, edge);
        g.addColorStop(0, `rgba(255,52,76,${0.22 + sellDominance * 0.28})`);
        g.addColorStop(0.52, `rgba(255,52,76,${0.12 + sellDominance * 0.16})`);
        g.addColorStop(1, "rgba(255,52,76,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      if (buyDominance > 0.01) {
        const edge = THREE.MathUtils.lerp(w * 0.98, w * 0.16, buyDominance);
        const g = ctx.createLinearGradient(edge, 0, w, 0);
        g.addColorStop(0, "rgba(38,255,148,0)");
        g.addColorStop(0.48, `rgba(38,255,148,${0.12 + buyDominance * 0.16})`);
        g.addColorStop(1, `rgba(38,255,148,${0.22 + buyDominance * 0.28})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      if (sellDominance > 0.01) {
        const edge = THREE.MathUtils.lerp(w * 0.02, w * 0.84, sellDominance);
        const g = ctx.createLinearGradient(0, 0, edge, 0);
        g.addColorStop(0, `rgba(255,52,76,${0.22 + sellDominance * 0.28})`);
        g.addColorStop(0.52, `rgba(255,52,76,${0.12 + sellDominance * 0.16})`);
        g.addColorStop(1, "rgba(255,52,76,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    }

    for (let i = 0; i < 7; i += 1) {
      const a = this.elapsed * (0.18 + i * 0.015) + i * 1.73;
      const cx = (0.5 + Math.sin(a) * 0.42) * w;
      const cy = (0.5 + Math.cos(a * 1.27) * 0.36) * h;
      const r = (0.22 + (i % 3) * 0.09) * w;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, "rgba(235,245,248,0.22)");
      g.addColorStop(0.42, "rgba(105,116,118,0.08)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // The reflection canvas is a fixed landscape texture UV-mapped across the
    // plane, so on a portrait viewport a circular blob would be squashed along
    // the short axis. Stretch each blob horizontally by the aspect ratio so the
    // coloured lights stay round on screen (≈1 on desktop, so it's a no-op there).
    const blobScaleX = (w * this.geomHeight) / (h * this.geomWidth);
    ctx.globalCompositeOperation = "screen";
    for (const splat of this.dyeSplats) {
      splat.age += dt;
      const t = Math.min(1, splat.age / splat.life);
      const fade = (1 - t) * (1 - t);
      const radius = splat.radius * (0.7 + t * 1.45);
      const pulse = 0.92 + Math.sin(this.elapsed * 3.2 + splat.seed) * 0.08;
      const alpha = Math.min(0.92, splat.strength * fade) * pulse;
      const rgb = splat.side === "buy" ? [38, 255, 148] : [255, 52, 76];
      const x = splat.u * w;
      const y = splat.v * h;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(blobScaleX, 1);
      const g = ctx.createRadialGradient(0, 0, radius * 0.04, 0, 0, radius);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`);
      g.addColorStop(0.38, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.42})`);
      g.addColorStop(0.76, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.14})`);
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";

    for (let i = this.dyeSplats.length - 1; i >= 0; i -= 1) {
      if (this.dyeSplats[i].age >= this.dyeSplats[i].life) this.dyeSplats.splice(i, 1);
    }
    this.reflectionTexture.needsUpdate = true;
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(2, rect.width);
    const height = Math.max(2, rect.height);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);

    // Drop radii are authored against a desktop-sized field; scale them down on
    // smaller / portrait screens so prints stay proportional instead of huge.
    this.sizeScale = clamp(Math.min(width, height) / 760, 0.5, 1);

    // Match the simulation grid aspect to the *actual* viewport width/height so
    // cells stay roughly square on any device and drops render round instead of
    // stretched. Long axis is fixed; the short axis tracks the aspect, snapped to
    // a power of two (NPOT float targets produce vertical comb artifacts).
    const snapPow2 = (value: number) => 2 ** Math.round(Math.log2(clamp(value, 128, FBO_WIDTH)));
    const aspect = width / height;
    const desiredW = aspect >= 1 ? FBO_WIDTH : snapPow2(FBO_WIDTH * aspect);
    const desiredH = aspect >= 1 ? snapPow2(FBO_WIDTH / aspect) : FBO_WIDTH;
    if (desiredW !== this.fboW || desiredH !== this.fboH) {
      this.fboW = desiredW;
      this.fboH = desiredH;
      this.buildCompute();
      this.waterMesh.material.defines.FBO_WIDTH = this.fboW.toFixed(1);
      this.waterMesh.material.defines.FBO_HEIGHT = this.fboH.toFixed(1);
    }

    this.camera.left = width / -2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = height / -2;
    this.camera.updateProjectionMatrix();

    this.geomWidth = width;
    this.geomHeight = height;
    this.waterMesh.geometry.dispose();
    this.waterMesh.geometry = new THREE.PlaneGeometry(this.geomWidth, this.geomHeight, this.fboW, this.fboH);
    this.waterMesh.updateMatrix();

    this.heightmapVariable.material.defines.GEOM_WIDTH = this.geomWidth.toFixed(1);
    this.heightmapVariable.material.defines.GEOM_HEIGHT = this.geomHeight.toFixed(1);
    this.waterMesh.material.defines.GEOM_WIDTH = this.geomWidth.toFixed(1);
    this.waterMesh.material.defines.GEOM_HEIGHT = this.geomHeight.toFixed(1);
    this.waterMesh.material.needsUpdate = true;
  }

  private createWaterMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.ShaderLib.phong.uniforms,
        {
          heightmap: { value: null },
        },
      ]),
      vertexShader: WaterVertex,
      fragmentShader: WaterFragment,
    });
    material.lights = true;

    const materialWithMap = material as THREE.ShaderMaterial & {
      color: THREE.Color;
      specular: THREE.Color;
      shininess: number;
      map: THREE.Texture;
      opacity: number;
    };
    materialWithMap.color = new THREE.Color(0xffffff);
    materialWithMap.specular = new THREE.Color(0x111111);
    materialWithMap.shininess = 50;
    materialWithMap.map = this.reflectionTexture;

    material.uniforms.diffuse.value = materialWithMap.color;
    material.uniforms.specular.value = materialWithMap.specular;
    material.uniforms.shininess.value = Math.max(materialWithMap.shininess, 1e-4);
    material.uniforms.opacity.value = materialWithMap.opacity;
    material.uniforms.map.value = this.reflectionTexture;

    material.defines.FBO_WIDTH = FBO_WIDTH.toFixed(1);
    material.defines.FBO_HEIGHT = FBO_HEIGHT.toFixed(1);
    material.defines.GEOM_WIDTH = this.geomWidth.toFixed(1);
    material.defines.GEOM_HEIGHT = this.geomHeight.toFixed(1);

    return material;
  }

  private fillTexture(texture: THREE.DataTexture): void {
    const pixels = texture.image.data as Float32Array;
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
      pixels[index + 3] = 1;
    }
  }
}
