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

interface Fbo {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

interface DoubleFbo {
  read: Fbo;
  write: Fbo;
  swap: () => void;
}

type UniformMap = Record<string, WebGLUniformLocation | null>;

interface Program {
  program: WebGLProgram;
  uniforms: UniformMap;
}

const BASE_VERTEX = `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main () {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const ADVECT_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSource;
  uniform sampler2D uVelocity;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;

  void main () {
    vec2 velocity = texture2D(uVelocity, vUv).xy * 2.0 - 1.0;
    vec2 coord = vUv - velocity * texelSize * dt * 120.0;
    vec4 value = texture2D(uSource, coord);
    gl_FragColor = value * dissipation;
  }
`;

const SPLAT_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;

  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`;

const VELOCITY_SPLAT_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec2 force;
  uniform vec2 point;
  uniform float radius;

  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec2 splat = exp(-dot(p, p) / radius) * force;
    vec2 base = texture2D(uTarget, vUv).xy * 2.0 - 1.0;
    vec2 velocity = clamp(base + splat, -1.0, 1.0);
    gl_FragColor = vec4(velocity * 0.5 + 0.5, 0.0, 1.0);
  }
`;

const DISPLAY_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec2 texelSize;
  uniform float bloom;
  uniform float threshold;
  uniform float sunrays;
  uniform float background;

  void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;
    vec3 l = texture2D(uTexture, vUv - vec2(texelSize.x, 0.0)).rgb;
    vec3 r = texture2D(uTexture, vUv + vec2(texelSize.x, 0.0)).rgb;
    vec3 t = texture2D(uTexture, vUv + vec2(0.0, texelSize.y)).rgb;
    vec3 b = texture2D(uTexture, vUv - vec2(0.0, texelSize.y)).rgb;
    float edge = length(r - l) + length(t - b);
    vec3 silver = vec3(dot(c, vec3(0.36, 0.36, 0.42)));
    float light = smoothstep(threshold, 1.0, max(c.r, max(c.g, c.b)));
    float ray = smoothstep(0.0, 1.0, 1.0 - distance(vUv, vec2(0.5, 0.5))) * sunrays;
    vec3 shaded = mix(c, silver + c * 0.34, 0.58) + edge * bloom + light * ray * 0.18;
    vec3 back = vec3(0.022, 0.024, 0.028) * background;
    gl_FragColor = vec4(back + shaded, 1.0);
  }
`;

const CLEAR_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform vec4 value;

  void main () {
    gl_FragColor = value;
  }
`;

export class FluidSimulation {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private dye: DoubleFbo;
  private velocity: DoubleFbo;
  private vertex: WebGLShader;
  private advectProgram: Program;
  private splatProgram: Program;
  private velocitySplatProgram: Program;
  private displayProgram: Program;
  private clearProgram: Program;
  private buffer: WebGLBuffer;
  private config: FluidConfig = {
    densityDissipation: 0.99,
    velocityDissipation: 0.97144,
    pressure: 0.62,
    curl: 0,
    splatRadius: 0.0018,
    bloomIntensity: 0.8,
    bloomThreshold: 0.6,
    sunraysWeight: 1,
  };
  private lastFrame = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      throw new Error("WebGL is unavailable");
    }

    this.canvas = canvas;
    this.gl = gl;
    this.vertex = this.compile(gl.VERTEX_SHADER, BASE_VERTEX);
    this.advectProgram = this.createProgram(ADVECT_FRAGMENT);
    this.splatProgram = this.createProgram(SPLAT_FRAGMENT);
    this.velocitySplatProgram = this.createProgram(VELOCITY_SPLAT_FRAGMENT);
    this.displayProgram = this.createProgram(DISPLAY_FRAGMENT);
    this.clearProgram = this.createProgram(CLEAR_FRAGMENT);
    this.buffer = this.createFullscreenBuffer();
    this.fit();
    this.dye = this.createDoubleFbo(this.canvas.width, this.canvas.height, [0, 0, 0, 255]);
    this.velocity = this.createDoubleFbo(Math.max(2, this.canvas.width >> 1), Math.max(2, this.canvas.height >> 1), [128, 128, 0, 255]);
    window.addEventListener("resize", () => this.resize());
    this.attachPointerSplats();
  }

  setConfig(config: Partial<FluidConfig>): void {
    this.config = { ...this.config, ...config };
  }

  splat(input: FluidSplat): void {
    const x = clamp(input.x, 0, 1);
    const y = clamp(input.y, 0, 1);
    const radius = Math.max(0.002, input.radius || this.config.splatRadius);
    const forceScale = input.force * 0.00034;
    const color = input.color.map((channel) => clamp(channel / 220, 0, 1.25)) as [number, number, number];

    this.drawVelocitySplat(x, y, input.dx * forceScale, input.dy * forceScale, radius);
    this.drawDyeSplat(x, y, color, radius * 1.35);
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.033);
    this.lastFrame = now;

    this.advect(this.velocity, this.velocity, dt, this.config.velocityDissipation);
    this.advect(this.dye, this.velocity, dt, this.config.densityDissipation);
    this.display();
  }

  private resize(): void {
    const previousWidth = this.canvas.width;
    const previousHeight = this.canvas.height;
    this.fit();
    if (previousWidth === this.canvas.width && previousHeight === this.canvas.height) return;
    this.dye = this.createDoubleFbo(this.canvas.width, this.canvas.height, [0, 0, 0, 255]);
    this.velocity = this.createDoubleFbo(Math.max(2, this.canvas.width >> 1), Math.max(2, this.canvas.height >> 1), [128, 128, 0, 255]);
  }

  private fit(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private advect(target: DoubleFbo, velocity: DoubleFbo, dt: number, dissipation: number): void {
    const gl = this.gl;
    this.bindProgram(this.advectProgram);
    gl.uniform2f(this.advectProgram.uniforms.texelSize, 1 / target.read.width, 1 / target.read.height);
    gl.uniform1f(this.advectProgram.uniforms.dt, dt);
    gl.uniform1f(this.advectProgram.uniforms.dissipation, dissipation);
    this.bindTexture(target.read.texture, 0);
    gl.uniform1i(this.advectProgram.uniforms.uSource, 0);
    this.bindTexture(velocity.read.texture, 1);
    gl.uniform1i(this.advectProgram.uniforms.uVelocity, 1);
    this.blit(target.write);
    target.swap();
  }

  private drawDyeSplat(x: number, y: number, color: [number, number, number], radius: number): void {
    const gl = this.gl;
    this.bindProgram(this.splatProgram);
    this.bindTexture(this.dye.read.texture, 0);
    gl.uniform1i(this.splatProgram.uniforms.uTarget, 0);
    gl.uniform1f(this.splatProgram.uniforms.aspectRatio, this.canvas.width / this.canvas.height);
    gl.uniform2f(this.splatProgram.uniforms.point, x, y);
    gl.uniform3f(this.splatProgram.uniforms.color, color[0], color[1], color[2]);
    gl.uniform1f(this.splatProgram.uniforms.radius, radius);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  private drawVelocitySplat(x: number, y: number, dx: number, dy: number, radius: number): void {
    const gl = this.gl;
    this.bindProgram(this.velocitySplatProgram);
    this.bindTexture(this.velocity.read.texture, 0);
    gl.uniform1i(this.velocitySplatProgram.uniforms.uTarget, 0);
    gl.uniform1f(this.velocitySplatProgram.uniforms.aspectRatio, this.canvas.width / this.canvas.height);
    gl.uniform2f(this.velocitySplatProgram.uniforms.point, x, y);
    gl.uniform2f(this.velocitySplatProgram.uniforms.force, dx, dy);
    gl.uniform1f(this.velocitySplatProgram.uniforms.radius, radius);
    this.blit(this.velocity.write);
    this.velocity.swap();
  }

  private display(): void {
    const gl = this.gl;
    this.bindProgram(this.displayProgram);
    this.bindTexture(this.dye.read.texture, 0);
    gl.uniform1i(this.displayProgram.uniforms.uTexture, 0);
    gl.uniform2f(this.displayProgram.uniforms.texelSize, 1 / this.dye.read.width, 1 / this.dye.read.height);
    gl.uniform1f(this.displayProgram.uniforms.bloom, this.config.bloomIntensity + this.config.curl * 0.2);
    gl.uniform1f(this.displayProgram.uniforms.threshold, this.config.bloomThreshold);
    gl.uniform1f(this.displayProgram.uniforms.sunrays, this.config.sunraysWeight);
    gl.uniform1f(this.displayProgram.uniforms.background, 1);
    this.blit(null);
  }

  private createFullscreenBuffer(): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Unable to create WebGL buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    return buffer;
  }

  private createDoubleFbo(width: number, height: number, clearColor: [number, number, number, number]): DoubleFbo {
    let read = this.createFbo(width, height, clearColor);
    let write = this.createFbo(width, height, clearColor);
    return {
      get read() {
        return read;
      },
      get write() {
        return write;
      },
      swap() {
        const temp = read;
        read = write;
        write = temp;
      },
    };
  }

  private createFbo(width: number, height: number, clearColor: [number, number, number, number]): Fbo {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("Unable to create WebGL framebuffer");

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, width, height);
    gl.clearColor(clearColor[0] / 255, clearColor[1] / 255, clearColor[2] / 255, clearColor[3] / 255);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { texture, framebuffer, width, height };
  }

  private blit(target: Fbo | null): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }

  private bindTexture(texture: WebGLTexture, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  private bindProgram(program: Program): void {
    this.gl.useProgram(program.program);
  }

  private createProgram(fragmentSource: string): Program {
    const gl = this.gl;
    const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error("Unable to create WebGL program");
    gl.attachShader(program, this.vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "WebGL program link failed");
    }

    return {
      program,
      uniforms: this.getUniforms(program),
    };
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Unable to create WebGL shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader compile failed");
    }

    return shader;
  }

  private getUniforms(program: WebGLProgram): UniformMap {
    const gl = this.gl;
    const uniforms: UniformMap = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let index = 0; index < count; index += 1) {
      const active = gl.getActiveUniform(program, index);
      if (active) uniforms[active.name] = gl.getUniformLocation(program, active.name);
    }
    return uniforms;
  }

  private attachPointerSplats(): void {
    let previous: { x: number; y: number } | null = null;

    this.canvas.addEventListener("pointerdown", (event) => {
      previous = this.pointerPosition(event);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!previous) return;
      const next = this.pointerPosition(event);
      this.splat({
        x: next.x,
        y: next.y,
        dx: (next.x - previous.x) * 900,
        dy: (next.y - previous.y) * 900,
        color: [100, 215, 255],
        radius: this.config.splatRadius * 1.5,
        force: 1.2,
      });
      previous = next;
    });

    window.addEventListener("pointerup", () => {
      previous = null;
    });
  }

  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: 1 - (event.clientY - rect.top) / rect.height,
    };
  }
}
