// Reflective order-flow water. The original demo reflects material.map through
// wave normals; here that map is a living canvas texture fed by trade drops.

// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer"
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise"

// Core boilerplate code deps (shared with src/water)
import { createRenderer, runApp, updateLoadingProgressBar } from "../water/core-utils"

// Live feed deps
import { WaterFeed } from "../water-live/feed"
import { HyperliquidClient } from "../data/hyperliquidClient"
import { DemoFeed } from "../data/demoFeed"
import { MARKET_CONFIG } from "../config/markets"

// Other deps
import WaterVertex from "../water/shaders/waterVertex.glsl?raw"
import WaterFragment from "./shaders/waterFragment.glsl?raw"
import HeightmapFragment from "../water/shaders/heightmapFragment.glsl?raw"
import SmoothFragment from "../water/shaders/smoothFragment.glsl?raw"

globalThis.THREE = THREE
// previously this feature is .legacyMode = false, see https://www.donmccurdy.com/2020/06/17/color-management-in-threejs/
// turning this on has the benefit of doing certain automatic conversions (for hexadecimal and CSS colors from sRGB to linear-sRGB)
THREE.ColorManagement.enabled = true

/**************************************************
 * 0. Tweakable parameters for the scene
 *************************************************/
const params = {
  // general scene params
  mouseSize: 63.0,
  viscosity: 0.985,
  waveHeight: 1.1
}

// Texture width for simulation
const FBO_WIDTH = 512
const FBO_HEIGHT = 256
// Water size in system units
const GEOM_WIDTH = window.innerWidth
const GEOM_HEIGHT = window.innerWidth / 2

const simplex = new SimplexNoise()

/**************************************************
 * Live feed wiring
 *************************************************/
const url = new URL(window.location.href)
const coinParam = (url.searchParams.get("coin") || "BTC").toUpperCase()
const market = ["BTC", "ETH", "SOL", "HYPE"].includes(coinParam) ? coinParam : "BTC"
const forceDemo = url.searchParams.get("demo") === "1"
const forceLive = url.searchParams.get("live") === "1"
const marketConfig = MARKET_CONFIG[market]

const feed = new WaterFeed({ geomWidth: GEOM_WIDTH, geomHeight: GEOM_HEIGHT, marketConfig })

let hud = null
let demo = null
let client = null
let lastTradeAt = 0

function setMode(text) {
  if (hud) hud.querySelector(".mode").textContent = text
}

const onTrade = (trade) => {
  lastTradeAt = Date.now()
  feed.ingestTrade(trade)
}

function startDemo() {
  if (demo) return
  if (client) client.disconnect()
  demo = new DemoFeed(market, { onTrade, onBbo: () => {} })
  demo.start()
  setMode("demo")
}

function startLive() {
  if (forceDemo) {
    startDemo()
    return
  }

  client = new HyperliquidClient(market, {
    onTrade,
    onBbo: () => {},
    onAssetContext: () => {},
    onStatus: (status) => {
      if (status === "error") startDemo()
      else if (!demo) setMode(status)
    },
  })
  client.connect()

  window.setTimeout(() => {
    if (!forceLive && !demo && Date.now() - lastTradeAt > 5500) startDemo()
  }, 6000)
}

function createHud() {
  const el = document.createElement("div")
  el.style.cssText = [
    "position:absolute",
    "left:18px",
    "bottom:18px",
    "z-index:5",
    "color:#fff",
    "font:700 16px/1.3 system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
    "text-shadow:0 1px 8px rgba(0,0,0,.65)",
    "pointer-events:none",
  ].join(";")
  el.innerHTML = `
    <div>${market} · <span class="mode">connecting</span></div>
    <div style="display:flex;gap:12px;font-size:13px;margin-top:4px">
      <span><i style="display:inline-block;width:7px;height:7px;border-radius:999px;background:#31ff94;margin-right:5px"></i>buy</span>
      <span><i style="display:inline-block;width:7px;height:7px;border-radius:999px;background:#ff4055;margin-right:5px"></i>sell</span>
    </div>
  `
  document.body.appendChild(el)
  return el
}

function createDynamicReflectionTexture() {
  const canvas = document.createElement("canvas")
  canvas.width = 1024
  canvas.height = 512
  const ctx = canvas.getContext("2d")
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return { canvas, ctx, texture }
}

function drawReflectionTexture(target, splats, dt, elapsed, dominance = 0) {
  const { canvas, ctx, texture } = target
  const w = canvas.width
  const h = canvas.height

  ctx.globalCompositeOperation = "source-over"
  ctx.fillStyle = "#020303"
  ctx.fillRect(0, 0, w, h)

  const base = ctx.createLinearGradient(0, 0, w, h)
  base.addColorStop(0.0, "#050606")
  base.addColorStop(0.28, "#313638")
  base.addColorStop(0.48, "#080909")
  base.addColorStop(0.72, "#6e7678")
  base.addColorStop(1.0, "#030404")
  ctx.globalAlpha = 0.82
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 1

  const buyDominance = Math.max(0, dominance)
  const sellDominance = Math.max(0, -dominance)
  if (buyDominance > 0.01) {
    const edge = THREE.MathUtils.lerp(w * 0.98, w * 0.16, buyDominance)
    const g = ctx.createLinearGradient(edge, 0, w, 0)
    g.addColorStop(0.0, "rgba(38,255,148,0)")
    g.addColorStop(0.48, `rgba(38,255,148,${0.12 + buyDominance * 0.16})`)
    g.addColorStop(1.0, `rgba(38,255,148,${0.22 + buyDominance * 0.28})`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }
  if (sellDominance > 0.01) {
    const edge = THREE.MathUtils.lerp(w * 0.02, w * 0.84, sellDominance)
    const g = ctx.createLinearGradient(0, 0, edge, 0)
    g.addColorStop(0.0, `rgba(255,52,76,${0.22 + sellDominance * 0.28})`)
    g.addColorStop(0.52, `rgba(255,52,76,${0.12 + sellDominance * 0.16})`)
    g.addColorStop(1.0, "rgba(255,52,76,0)")
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }

  for (let i = 0; i < 7; i++) {
    const a = elapsed * (0.18 + i * 0.015) + i * 1.73
    const cx = (0.5 + Math.sin(a) * 0.42) * w
    const cy = (0.5 + Math.cos(a * 1.27) * 0.36) * h
    const r = (0.22 + (i % 3) * 0.09) * w
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0.0, "rgba(235,245,248,0.22)")
    g.addColorStop(0.42, "rgba(105,116,118,0.08)")
    g.addColorStop(1.0, "rgba(0,0,0,0)")
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }

  ctx.globalCompositeOperation = "screen"
  for (const splat of splats) {
    splat.age += dt
    const t = Math.min(1, splat.age / splat.life)
    const fade = (1 - t) * (1 - t)
    const radius = splat.radius * (0.7 + t * 1.45)
    const pulse = 0.92 + Math.sin(elapsed * 3.2 + splat.seed) * 0.08
    const alpha = Math.min(0.92, splat.strength * fade) * pulse
    const rgb = splat.side === "buy" ? [38, 255, 148] : [255, 52, 76]
    const x = splat.u * w
    const y = splat.v * h
    const g = ctx.createRadialGradient(x, y, radius * 0.04, x, y, radius)
    g.addColorStop(0.0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`)
    g.addColorStop(0.38, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.42})`)
    g.addColorStop(0.76, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.14})`)
    g.addColorStop(1.0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }
  ctx.globalCompositeOperation = "source-over"

  for (let i = splats.length - 1; i >= 0; i--) {
    if (splats[i].age >= splats[i].life) splats.splice(i, 1)
  }

  texture.needsUpdate = true
}

/**************************************************
 * 1. Initialize core threejs components
 *************************************************/
// Create the scene
let scene = new THREE.Scene()

// Create the renderer via 'createRenderer',
// 1st param receives additional WebGLRenderer properties
// 2nd param receives a custom callback to further configure the renderer
let renderer = createRenderer({ antialias: true }, (_renderer) => {
  // best practice: ensure output colorspace is in sRGB, see Color Management documentation:
  // https://threejs.org/docs/#manual/en/introduction/Color-management
  _renderer.outputColorSpace = THREE.SRGBColorSpace
})

// Create the camera
let camera = new THREE.OrthographicCamera(
  window.innerWidth / -2, // left
  window.innerWidth / 2,  // right
  window.innerHeight / 2, // top
  window.innerHeight / -2, // bottom
  -1000, // near plane
  1000 // far plane
)

/**************************************************
 * 2. Build your scene in this threejs app
 *************************************************/
let app = {
  async initScene() {
    this.reflection = createDynamicReflectionTexture()
    this.dyeSplats = []
    this.sideDominance = 0
    drawReflectionTexture(this.reflection, this.dyeSplats, 0, 0, this.sideDominance)
    const Texture = this.reflection.texture

    await updateLoadingProgressBar(0.1)

    this.mouseMoved = false
    this.mouseCoords = new THREE.Vector2()
    this.raycaster = new THREE.Raycaster()

    this.container.style.touchAction = 'none'
    this.container.addEventListener( 'pointermove', this.onPointerMove.bind(this) )

    const sun = new THREE.DirectionalLight( 0xFFFFFF, 5.0 )
    sun.position.set( 300, 400, 175 )
    scene.add( sun )

    const sun2 = new THREE.DirectionalLight( 0xFFFFFF, 0.6 )
    sun2.position.set( - 100, 350, - 200 )
    scene.add( sun2 )

    const materialColor = 0xFFFFFF

    const geometry = new THREE.PlaneGeometry( GEOM_WIDTH, GEOM_HEIGHT, FBO_WIDTH, FBO_HEIGHT )

    // material: make a THREE.ShaderMaterial clone of THREE.MeshPhongMaterial, with customized vertex shader
    const material = new THREE.ShaderMaterial( {
      uniforms: THREE.UniformsUtils.merge( [
        THREE.ShaderLib[ 'phong' ].uniforms,
        {
          'heightmap': { value: null },
        }
      ] ),
      vertexShader: WaterVertex,
      fragmentShader: WaterFragment
    } );

    material.lights = true

    // Material attributes from THREE.MeshPhongMaterial
    // for the color map to work, we need all 3 lines (define material.color, material.map and material.uniforms[ 'map' ].value)
    material.color = new THREE.Color( materialColor )
    material.specular = new THREE.Color( 0x111111 )
    material.shininess = 50
    material.map = Texture

    // Sets the uniforms with the material values
    material.uniforms[ 'diffuse' ].value = material.color
    material.uniforms[ 'specular' ].value = material.specular
    material.uniforms[ 'shininess' ].value = Math.max( material.shininess, 1e-4 )
    material.uniforms[ 'opacity' ].value = material.opacity
    material.uniforms[ 'map' ].value = Texture

    // Defines
    material.defines.FBO_WIDTH = FBO_WIDTH.toFixed( 1 )
    material.defines.FBO_HEIGHT = FBO_HEIGHT.toFixed( 1 )
    material.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed( 1 )
    material.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed( 1 )

    this.waterUniforms = material.uniforms

    this.waterMesh = new THREE.Mesh( geometry, material )
    this.waterMesh.matrixAutoUpdate = false
    this.waterMesh.updateMatrix()

    scene.add( this.waterMesh )

    // Creates the gpu computation class and sets it up
    this.gpuCompute = new GPUComputationRenderer( FBO_WIDTH, FBO_HEIGHT, renderer )

    if ( renderer.capabilities.isWebGL2 === false ) {
      this.gpuCompute.setDataType( THREE.HalfFloatType )
    }

    const heightmap0 = this.gpuCompute.createTexture()

    this.fillTexture( heightmap0 )

    this.heightmapVariable = this.gpuCompute.addVariable( 'heightmap', HeightmapFragment, heightmap0 )

    this.gpuCompute.setVariableDependencies( this.heightmapVariable, [ this.heightmapVariable ] )

    this.heightmapVariable.material.uniforms[ 'mousePos' ] = { value: new THREE.Vector2( 10000, 10000 ) }
    this.heightmapVariable.material.uniforms[ 'mouseSize' ] = { value: params.mouseSize }
    this.heightmapVariable.material.uniforms[ 'viscosityConstant' ] = { value: params.viscosity }
    this.heightmapVariable.material.uniforms[ 'waveheightMultiplier' ] = { value: params.waveHeight }
    this.heightmapVariable.material.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed( 1 )
    this.heightmapVariable.material.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed( 1 )

    const error = this.gpuCompute.init()
    if ( error !== null ) {
      console.error( error )
    }

    // Create compute shader to smooth the water surface and velocity
    this.smoothShader = this.gpuCompute.createShaderMaterial( SmoothFragment, { smoothTexture: { value: null } } )

    // GUI controls
    const gui = new dat.GUI()
    gui.add(params, "mouseSize", 1.0, 100.0, 1.0 ).onChange((newVal) => {
      this.heightmapVariable.material.uniforms[ 'mouseSize' ].value = newVal
    })
    gui.add(params, "viscosity", 0.9, 0.999, 0.001 ).onChange((newVal) => {
      this.heightmapVariable.material.uniforms[ 'viscosityConstant' ].value = newVal
    })
    gui.add(params, "waveHeight", 0.1, 2.0, 0.05 ).onChange((newVal) => {
      this.heightmapVariable.material.uniforms[ 'waveheightMultiplier' ].value = newVal
    })
    const buttonSmooth = {
      smoothWater: this.smoothWater.bind(this)
    }
    gui.add( buttonSmooth, 'smoothWater' )

    // Stats - show fps
    this.stats1 = new Stats()
    this.stats1.showPanel(0) // Panel 0 = fps
    this.stats1.domElement.style.cssText = "position:absolute;top:0px;left:0px;"
    // this.container is the parent DOM element of the threejs canvas element
    this.container.appendChild(this.stats1.domElement)

    hud = createHud()
    startLive()

    await updateLoadingProgressBar(1.0, 100)
  },
  fillTexture( texture ) {
    const waterMaxHeight = 2;

    function noise( x, y ) {
      let multR = waterMaxHeight;
      let mult = 0.025;
      let r = 0;
      for ( let i = 0; i < 15; i ++ ) {
        r += multR * simplex.noise( x * mult, y * mult );
        multR *= 0.53 + 0.025 * i;
        mult *= 1.25;
      }

      return r;
    }

    const pixels = texture.image.data;

    let p = 0;
    for ( let j = 0; j < FBO_HEIGHT; j ++ ) {
      for ( let i = 0; i < FBO_WIDTH; i ++ ) {
        const x = i * 128 / FBO_WIDTH;
        const y = j * 128 / FBO_HEIGHT;

        pixels[ p + 0 ] = noise( x, y );
        pixels[ p + 1 ] = 0;
        pixels[ p + 2 ] = 0;
        pixels[ p + 3 ] = 1;

        p += 4;
      }
    }
  },
  smoothWater() {
    const currentRenderTarget = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable )
    const alternateRenderTarget = this.gpuCompute.getAlternateRenderTarget( this.heightmapVariable )

    for ( let i = 0; i < 10; i ++ ) {
      this.smoothShader.uniforms[ 'smoothTexture' ].value = currentRenderTarget.texture
      this.gpuCompute.doRenderTarget( this.smoothShader, alternateRenderTarget )

      this.smoothShader.uniforms[ 'smoothTexture' ].value = alternateRenderTarget.texture
      this.gpuCompute.doRenderTarget( this.smoothShader, currentRenderTarget )
    }
  },
  fireDrop(x, y, size, amp) {
    const hmUniforms = this.heightmapVariable.material.uniforms
    hmUniforms[ 'mousePos' ].value.set(x, y)
    hmUniforms[ 'mouseSize' ].value = size
    hmUniforms[ 'waveheightMultiplier' ].value = amp
    this.gpuCompute.compute()
  },
  positionDropByDominance(drop) {
    const side = drop.charge >= 0 ? "buy" : "sell"
    const direction = side === "buy" ? 1 : -1
    const incomingWeight = THREE.MathUtils.clamp(Math.abs(drop.amp) * 0.1, 0.035, 0.14)
    const predictedDominance = THREE.MathUtils.clamp(this.sideDominance + direction * incomingWeight, -1, 1)
    const buyShift = Math.max(0, predictedDominance)
    const sellShift = Math.max(0, -predictedDominance)
    const shift =
      side === "buy"
        ? -buyShift * GEOM_WIDTH * 0.34
        : sellShift * GEOM_WIDTH * 0.34

    return {
      ...drop,
      x: THREE.MathUtils.clamp(drop.x + shift, GEOM_WIDTH * -0.46, GEOM_WIDTH * 0.46),
    }
  },
  addDyeSplat(drop) {
    const u = THREE.MathUtils.clamp(drop.x / GEOM_WIDTH + 0.5, 0, 1)
    const v = THREE.MathUtils.clamp(0.5 - drop.y / GEOM_HEIGHT, 0, 1)
    const side = drop.charge >= 0 ? "buy" : "sell"
    const direction = side === "buy" ? 1 : -1
    this.sideDominance = THREE.MathUtils.clamp(
      this.sideDominance + direction * THREE.MathUtils.clamp(Math.abs(drop.amp) * 0.12, 0.045, 0.18),
      -1,
      1
    )
    const sizeNorm = THREE.MathUtils.clamp((drop.size - 63) / (132 - 63), 0, 1)
    const ampNorm = THREE.MathUtils.clamp((Math.abs(drop.amp) - 1.1) / (1.2 - 1.1), 0, 1)
    const visualWeight = Math.max(sizeNorm, ampNorm)
    this.dyeSplats.push({
      u,
      v,
      side,
      age: 0,
      life: THREE.MathUtils.lerp(2.8, 8.5, visualWeight),
      radius: THREE.MathUtils.clamp(drop.size * 4.4, 120, 620),
      strength: THREE.MathUtils.clamp(Math.abs(drop.amp) * 0.92, 0.32, 1.0),
      seed: Math.random() * Math.PI * 2,
    })
  },
  setMouseCoords( x, y ) {
    this.mouseCoords.set( ( x / renderer.domElement.clientWidth ) * 2 - 1, ( y / renderer.domElement.clientHeight ) * 2 - 1 )
    this.mouseMoved = true
  },
  onPointerMove( event ) {
    if ( event.isPrimary === false ) return
    this.setMouseCoords( event.clientX, event.clientY )
  },
  resize() {
    camera.left = window.innerWidth / -2
    camera.right = window.innerWidth / 2
    camera.top = window.innerHeight / 2
    camera.bottom = window.innerHeight / -2
    camera.updateProjectionMatrix()
  },
  // @param {number} interval - time elapsed between 2 frames
  // @param {number} elapsed - total time elapsed since app start
  updateScene(interval, elapsed) {
    // this.controls.update()
    this.stats1.update()

    // Set uniforms: mouse interaction
    const hmUniforms = this.heightmapVariable.material.uniforms
    hmUniforms[ 'viscosityConstant' ].value = params.viscosity
    this.sideDominance *= Math.exp(-Math.min(interval, 0.1) / 3.8)

    let computed = false
    if ( this.mouseMoved ) {

      this.raycaster.setFromCamera( this.mouseCoords, camera )

      const intersects = this.raycaster.intersectObject( this.waterMesh )

      if ( intersects.length > 0 ) {
        const point = intersects[ 0 ].point
        this.fireDrop(point.x, point.y, params.mouseSize, params.waveHeight)
        computed = true
      }

      this.mouseMoved = false
    }

    const drops = feed.collectDrops(10)
    for (const drop of drops) {
      const positionedDrop = this.positionDropByDominance(drop)
      this.fireDrop(positionedDrop.x, positionedDrop.y, positionedDrop.size, positionedDrop.amp)
      this.addDyeSplat(positionedDrop)
      computed = true
    }

    if (!computed) {
      hmUniforms[ 'mousePos' ].value.set( 10000, 10000 )
      hmUniforms[ 'mouseSize' ].value = params.mouseSize
      hmUniforms[ 'waveheightMultiplier' ].value = params.waveHeight
      this.gpuCompute.compute()
    }

    drawReflectionTexture(this.reflection, this.dyeSplats, interval, elapsed, this.sideDominance)

    // Get compute output in custom uniform
    this.waterUniforms[ 'heightmap' ].value = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable ).texture
  }
}

/**************************************************
 * 3. Run the app
 *************************************************/
runApp(app, scene, renderer, camera, true)
