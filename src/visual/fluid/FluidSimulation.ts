import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { clamp } from "../../utils/format";

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
}

interface ActiveTint {
  position: THREE.Vector2;
  color: THREE.Vector3;
  radius: number;
  strength: number;
}

const FBO_WIDTH = 512;
const FBO_HEIGHT = 256;
const MAX_LOCAL_TINTS = 16;
const MAX_PENDING_DROPS = 24;
const DROPS_PER_FRAME = 2;

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
    float mousePhase = clamp(length((uv - vec2(0.5)) * vec2(GEOM_WIDTH, GEOM_HEIGHT) - vec2(mousePos.x, -mousePos.y)) * PI / mouseSize, 0.0, PI);
    newHeight += (cos(mousePhase) + 1.0) * waveheightMultiplier;

    heightmapValue.y = heightmapValue.x;
    heightmapValue.x = newHeight;
    gl_FragColor = heightmapValue;
  }
`;

const WATER_VERTEX = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const WATER_FRAGMENT = `
  #define MAX_LOCAL_TINTS 16
  precision highp float;
  uniform sampler2D heightmap;
  uniform sampler2D map;
  uniform vec2 texelSize;
  uniform int localTintCount;
  uniform vec2 localTintPositions[MAX_LOCAL_TINTS];
  uniform vec3 localTintColors[MAX_LOCAL_TINTS];
  uniform float localTintRadii[MAX_LOCAL_TINTS];
  uniform float localTintStrengths[MAX_LOCAL_TINTS];
  varying vec2 vUv;

  void main() {
    float h = texture2D(heightmap, vUv).x;
    float left = texture2D(heightmap, vUv - vec2(texelSize.x, 0.0)).x;
    float right = texture2D(heightmap, vUv + vec2(texelSize.x, 0.0)).x;
    float top = texture2D(heightmap, vUv + vec2(0.0, texelSize.y)).x;
    float bottom = texture2D(heightmap, vUv - vec2(0.0, texelSize.y)).x;
    vec3 normal = normalize(vec3((left - right) * 12.0, (bottom - top) * 12.0, 1.0));
    vec2 refractedUv = clamp(vUv + normal.xy * 0.08 + vec2(h * 0.02, -h * 0.018), 0.0, 1.0);
    vec3 base = texture2D(map, refractedUv).rgb;
    base = pow(base, vec3(0.88)) * 1.08;
    vec3 localTint = vec3(0.0);
    float localMask = 0.0;
    for (int i = 0; i < MAX_LOCAL_TINTS; i += 1) {
      if (i >= localTintCount) break;
      vec2 delta = (vUv - localTintPositions[i]) * vec2(GEOM_WIDTH, GEOM_HEIGHT);
      float falloff = smoothstep(localTintRadii[i], 0.0, length(delta));
      float waveFocus = 0.52 + clamp(abs(h) * 6.0, 0.0, 0.65);
      float tintAmount = falloff * localTintStrengths[i] * waveFocus;
      localTint += localTintColors[i] * tintAmount;
      localMask += tintAmount;
    }
    if (localMask > 0.001) {
      vec3 tintColor = localTint / localMask;
      vec3 tintWash = base * (vec3(0.62) + tintColor * 1.18) + tintColor * 0.22;
      base = mix(base, tintWash, clamp(localMask, 0.0, 0.88));
    }
    vec3 lightDir = normalize(vec3(-0.28, 0.38, 0.9));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float specular = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), 64.0);
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.0);
    vec3 color = base * (1.02 + diffuse * 0.2);
    color += specular * vec3(1.0, 0.94, 0.92) * 0.58;
    color += fresnel * vec3(0.4, 0.72, 0.76) * 0.22;
    color = min(color + vec3(0.018, 0.016, 0.02), vec3(1.0));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export class FluidSimulation {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private waterMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private waterUniforms: THREE.ShaderMaterial["uniforms"];
  private gpuCompute: GPUComputationRenderer;
  private heightmapVariable: Variable;
  private pendingDrops: PendingDrop[] = [];
  private activeTints: ActiveTint[] = [];
  private geomWidth = 1;
  private geomHeight = 1;
  private config: FluidConfig = {
    densityDissipation: 0.99,
    velocityDissipation: 0.98,
    pressure: 0.62,
    curl: 0,
    splatRadius: 0.01,
    bloomIntensity: 0.8,
    bloomThreshold: 0.6,
    sunraysWeight: 1,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.z = 100;
    this.camera.lookAt(0, 0, 0);

    const material = this.createWaterMaterial();
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.waterMesh = new THREE.Mesh(geometry, material);
    this.waterMesh.matrixAutoUpdate = false;
    this.scene.add(this.waterMesh);
    this.waterUniforms = material.uniforms;

    this.gpuCompute = new GPUComputationRenderer(FBO_WIDTH, FBO_HEIGHT, this.renderer);
    if (!this.renderer.capabilities.isWebGL2) {
      this.gpuCompute.setDataType(THREE.HalfFloatType);
    }

    const heightmap0 = this.gpuCompute.createTexture();
    this.fillTexture(heightmap0);
    this.heightmapVariable = this.gpuCompute.addVariable("heightmap", HEIGHTMAP_FRAGMENT, heightmap0);
    this.gpuCompute.setVariableDependencies(this.heightmapVariable, [this.heightmapVariable]);
    this.heightmapVariable.material.uniforms.mousePos = { value: new THREE.Vector2(10000, 10000) };
    this.heightmapVariable.material.uniforms.mouseSize = { value: 63 };
    this.heightmapVariable.material.uniforms.viscosityConstant = { value: 0.98 };
    this.heightmapVariable.material.uniforms.waveheightMultiplier = { value: 0.3 };

    const error = this.gpuCompute.init();
    if (error) throw new Error(error);

    this.attachPointerDrops();
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  setConfig(config: Partial<FluidConfig>): void {
    this.config = { ...this.config, ...config };
    this.heightmapVariable.material.uniforms.viscosityConstant.value = clamp(this.config.velocityDissipation, 0.9, 0.999);
  }

  splat(input: FluidSplat): void {
    const x = clamp(input.x, 0, 1);
    const y = clamp(input.y, 0, 1);
    const radius = clamp(input.radius * Math.min(this.geomWidth, this.geomHeight), 12, 360);
    const motion = clamp(Math.hypot(input.dx, input.dy) * 0.052, 0, 0.48);
    const strength = clamp(input.force * 0.105 + motion, 0.14, 1.8);
    this.pendingDrops.push({
      x: (x - 0.5) * this.geomWidth,
      y: (0.5 - y) * this.geomHeight,
      radius,
      strength,
    });
    if (this.pendingDrops.length > MAX_PENDING_DROPS) {
      this.pendingDrops.splice(0, this.pendingDrops.length - MAX_PENDING_DROPS);
    }
    this.pushTint(x, y, input.color, radius, clamp(strength * 1.9 + input.force * 0.16, 0.2, 1.65));
  }

  render(): void {
    const hmUniforms = this.heightmapVariable.material.uniforms;
    const drops = this.pendingDrops.splice(0, DROPS_PER_FRAME);

    if (drops.length === 0) {
      hmUniforms.mousePos.value.set(10000, 10000);
      this.gpuCompute.compute();
    } else {
      for (const drop of drops) {
        hmUniforms.mousePos.value.set(drop.x, drop.y);
        hmUniforms.mouseSize.value = drop.radius;
        hmUniforms.waveheightMultiplier.value = drop.strength;
        this.gpuCompute.compute();
      }
      hmUniforms.mousePos.value.set(10000, 10000);
      hmUniforms.mouseSize.value = 63;
      hmUniforms.waveheightMultiplier.value = 0.3;
    }

    this.waterUniforms.heightmap.value = this.gpuCompute.getCurrentRenderTarget(this.heightmapVariable).texture;
    this.updateTintUniforms();
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(2, rect.width);
    const height = Math.max(2, rect.height);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);

    this.camera.left = width / -2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = height / -2;
    this.camera.updateProjectionMatrix();

    this.geomWidth = width;
    this.geomHeight = height;
    this.waterMesh.geometry.dispose();
    this.waterMesh.geometry = new THREE.PlaneGeometry(this.geomWidth, this.geomHeight, 1, 1);
    this.waterMesh.updateMatrix();

    this.heightmapVariable.material.defines.GEOM_WIDTH = this.geomWidth.toFixed(1);
    this.heightmapVariable.material.defines.GEOM_HEIGHT = this.geomHeight.toFixed(1);
    this.waterMesh.material.defines.GEOM_WIDTH = this.geomWidth.toFixed(1);
    this.waterMesh.material.defines.GEOM_HEIGHT = this.geomHeight.toFixed(1);
    this.waterMesh.material.needsUpdate = true;
  }

  private createWaterMaterial(): THREE.ShaderMaterial {
    const map = this.createGradientTexture();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        heightmap: { value: null },
        map: { value: map },
        texelSize: { value: new THREE.Vector2(1 / FBO_WIDTH, 1 / FBO_HEIGHT) },
        localTintCount: { value: 0 },
        localTintPositions: { value: Array.from({ length: MAX_LOCAL_TINTS }, () => new THREE.Vector2(10000, 10000)) },
        localTintColors: { value: Array.from({ length: MAX_LOCAL_TINTS }, () => new THREE.Vector3()) },
        localTintRadii: { value: Array.from({ length: MAX_LOCAL_TINTS }, () => 0) },
        localTintStrengths: { value: Array.from({ length: MAX_LOCAL_TINTS }, () => 0) },
      },
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
    });
    return material;
  }

  private createGradientTexture(): THREE.CanvasTexture {
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 2048;
    textureCanvas.height = 1072;
    const ctx = textureCanvas.getContext("2d");
    if (!ctx) throw new Error("Unable to create gradient texture");

    const base = ctx.createLinearGradient(0, 0, textureCanvas.width, textureCanvas.height);
    base.addColorStop(0, "#f786ba");
    base.addColorStop(0.33, "#763e57");
    base.addColorStop(0.62, "#35112f");
    base.addColorStop(1, "#fb86b9");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, textureCanvas.width, textureCanvas.height);

    const teal = ctx.createRadialGradient(0, textureCanvas.height * 0.78, 0, 0, textureCanvas.height * 0.78, textureCanvas.width * 0.55);
    teal.addColorStop(0, "rgba(9, 94, 83, 0.92)");
    teal.addColorStop(1, "rgba(3, 67, 59, 0)");
    ctx.fillStyle = teal;
    ctx.fillRect(0, 0, textureCanvas.width, textureCanvas.height);

    const dark = ctx.createRadialGradient(textureCanvas.width * 0.5, textureCanvas.height * 0.62, 0, textureCanvas.width * 0.5, textureCanvas.height * 0.62, textureCanvas.width * 0.7);
    dark.addColorStop(0, "rgba(40, 16, 45, 0.6)");
    dark.addColorStop(1, "rgba(32, 12, 35, 0)");
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, textureCanvas.width, textureCanvas.height);

    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
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

  private pushTint(x: number, y: number, color: [number, number, number], radius: number, amount: number): void {
    const reusable = this.activeTints.find(
      (tint) => tint.color.x === color[0] / 255 && tint.color.y === color[1] / 255 && tint.color.z === color[2] / 255,
    );
    if (reusable) {
      reusable.position.set(x, y);
      reusable.radius = clamp(Math.max(reusable.radius, radius * 2.2), 62, 260);
      reusable.strength = clamp(reusable.strength + amount * 0.34, 0.14, 1);
      return;
    }

    const next: ActiveTint = {
      position: new THREE.Vector2(x, y),
      color: new THREE.Vector3(color[0] / 255, color[1] / 255, color[2] / 255),
      radius: clamp(radius * 2.35, 62, 240),
      strength: clamp(amount * 0.82, 0.12, 0.92),
    };
    this.activeTints.unshift(next);
    if (this.activeTints.length > MAX_LOCAL_TINTS) {
      this.activeTints.length = MAX_LOCAL_TINTS;
    }
  }

  private updateTintUniforms(): void {
    this.activeTints = this.activeTints
      .map((tint) => ({ ...tint, strength: tint.strength * 0.952, radius: tint.radius * 1.006 }))
      .filter((tint) => tint.strength > 0.025);

    const count = Math.min(this.activeTints.length, MAX_LOCAL_TINTS);
    this.waterUniforms.localTintCount.value = count;
    for (let index = 0; index < MAX_LOCAL_TINTS; index += 1) {
      const tint = this.activeTints[index];
      const position = this.waterUniforms.localTintPositions.value[index] as THREE.Vector2;
      const color = this.waterUniforms.localTintColors.value[index] as THREE.Vector3;
      if (tint) {
        position.copy(tint.position);
        color.copy(tint.color);
        this.waterUniforms.localTintRadii.value[index] = tint.radius;
        this.waterUniforms.localTintStrengths.value[index] = tint.strength;
      } else {
        position.set(10000, 10000);
        color.set(0, 0, 0);
        this.waterUniforms.localTintRadii.value[index] = 0;
        this.waterUniforms.localTintStrengths.value[index] = 0;
      }
    }
  }

  private attachPointerDrops(): void {
    this.canvas.addEventListener("pointermove", (event) => {
      if (!event.isPrimary) return;
      if (this.pendingDrops.length > MAX_PENDING_DROPS * 0.75) return;
      const rect = this.canvas.getBoundingClientRect();
      this.pendingDrops.push({
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
        radius: 63,
        strength: 0.3,
      });
    });
  }
}
