// Live order-flow water — Hyperliquid trades drive ripples on a GPU heightmap.
// Built on franky-adl's "Water Ripples" demo 3 (bioluminescent + UnrealBloom),
// extended with multi-drop injection + a signed buy/sell charge channel.

// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer"
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise"
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass"

// Core boilerplate code deps
import { createComposer, createRenderer, runApp, updateLoadingProgressBar } from "../water/core-utils"

// Live feed deps
import { WaterFeed } from "./feed"
import { HyperliquidClient } from "../data/hyperliquidClient"
import { DemoFeed } from "../data/demoFeed"
import { MARKET_CONFIG } from "../config/markets"

// Shaders (live variants: multi-drop heightmap + charge tint)
import WaterVertex from "./shaders/waterVertexLive.glsl?raw"
import WaterFragment from "./shaders/waterFragmentLive.glsl?raw"
import HeightmapFragment from "./shaders/heightmapFragmentLive.glsl?raw"
import SmoothFragment from "../water/shaders/smoothFragment.glsl?raw"

globalThis.THREE = THREE
THREE.ColorManagement.enabled = true

// Must match #define MAX_DROPS in heightmapFragmentLive.glsl
const MAX_DROPS = 32

/**************************************************
 * 0. Tweakable parameters
 *************************************************/
const params = {
  viscosity: 0.985,
  chargeDecay: 0.993,
  bloomThreshold: 0.9,
  mouseSize: 24.0,
  mouseWave: 0.45,
}

// Texture width for simulation
const FBO_WIDTH = 512
const FBO_HEIGHT = 256
// Water size in system units
const GEOM_WIDTH = window.innerWidth
const GEOM_HEIGHT = window.innerWidth / 2

const simplex = new SimplexNoise()

/**************************************************
 * Live feed wiring (market from ?coin=, ?demo=1 forces demo)
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
  // fall back to demo if no live prints arrive shortly
  window.setTimeout(() => {
    if (!forceLive && !demo && Date.now() - lastTradeAt > 5500) startDemo()
  }, 6000)
}

/**************************************************
 * 1. Core threejs components
 *************************************************/
let scene = new THREE.Scene()

let renderer = createRenderer({ antialias: true }, (_renderer) => {
  _renderer.outputColorSpace = THREE.SRGBColorSpace
})

let camera = new THREE.OrthographicCamera(
  window.innerWidth / -2,
  window.innerWidth / 2,
  window.innerHeight / 2,
  window.innerHeight / -2,
  -1000,
  1000
)

let bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.08, // strength (feed-driven at runtime)
  0.01, // radius (feed-driven at runtime)
  params.bloomThreshold
)
let composer = createComposer(renderer, scene, camera, (comp) => {
  comp.addPass(bloomPass)
})

// Pre-allocated uniform array buffers for the drops
const dropPosArr = Array.from({ length: MAX_DROPS }, () => new THREE.Vector2())
const dropSizeArr = new Float32Array(MAX_DROPS).fill(1)
const dropAmpArr = new Float32Array(MAX_DROPS)
const dropChargeArr = new Float32Array(MAX_DROPS)

/**************************************************
 * 2. Scene
 *************************************************/
let app = {
  async initScene() {
    await updateLoadingProgressBar(0.1)

    this.mouseMoved = false
    this.mouseCoords = new THREE.Vector2()
    this.raycaster = new THREE.Raycaster()

    this.container.style.touchAction = "none"
    this.container.addEventListener("pointermove", this.onPointerMove.bind(this))

    const sun = new THREE.DirectionalLight(0xffffff, 5.0)
    sun.position.set(300, 400, 175)
    scene.add(sun)

    const geometry = new THREE.PlaneGeometry(GEOM_WIDTH, GEOM_HEIGHT, FBO_WIDTH, FBO_HEIGHT)

    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.ShaderLib["phong"].uniforms,
        { heightmap: { value: null } },
      ]),
      vertexShader: WaterVertex,
      fragmentShader: WaterFragment,
    })

    material.lights = true
    material.color = new THREE.Color(0xffffff)
    material.specular = new THREE.Color(0x111111)
    material.shininess = 50

    material.uniforms["diffuse"].value = material.color
    material.uniforms["specular"].value = material.specular
    material.uniforms["shininess"].value = Math.max(material.shininess, 1e-4)
    material.uniforms["opacity"].value = material.opacity

    material.defines.FBO_WIDTH = FBO_WIDTH.toFixed(1)
    material.defines.FBO_HEIGHT = FBO_HEIGHT.toFixed(1)
    material.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed(1)
    material.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed(1)

    this.waterUniforms = material.uniforms

    this.waterMesh = new THREE.Mesh(geometry, material)
    this.waterMesh.matrixAutoUpdate = false
    this.waterMesh.updateMatrix()
    scene.add(this.waterMesh)

    // GPU heightmap compute
    this.gpuCompute = new GPUComputationRenderer(FBO_WIDTH, FBO_HEIGHT, renderer)
    if (renderer.capabilities.isWebGL2 === false) {
      this.gpuCompute.setDataType(THREE.HalfFloatType)
    }

    const heightmap0 = this.gpuCompute.createTexture()
    this.fillTexture(heightmap0)

    this.heightmapVariable = this.gpuCompute.addVariable("heightmap", HeightmapFragment, heightmap0)
    this.gpuCompute.setVariableDependencies(this.heightmapVariable, [this.heightmapVariable])

    const hm = this.heightmapVariable.material
    hm.uniforms["dropCount"] = { value: 0 }
    hm.uniforms["dropPos"] = { value: dropPosArr }
    hm.uniforms["dropSize"] = { value: dropSizeArr }
    hm.uniforms["dropAmp"] = { value: dropAmpArr }
    hm.uniforms["dropCharge"] = { value: dropChargeArr }
    hm.uniforms["viscosityConstant"] = { value: params.viscosity }
    hm.uniforms["chargeDecay"] = { value: params.chargeDecay }
    hm.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed(1)
    hm.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed(1)

    const error = this.gpuCompute.init()
    if (error !== null) console.error(error)

    this.smoothShader = this.gpuCompute.createShaderMaterial(SmoothFragment, { smoothTexture: { value: null } })

    // GUI controls
    const gui = new dat.GUI()
    gui.add(params, "viscosity", 0.9, 0.999, 0.001).onChange((v) => {
      this.heightmapVariable.material.uniforms["viscosityConstant"].value = v
    })
    gui.add(params, "chargeDecay", 0.9, 0.995, 0.001).onChange((v) => {
      this.heightmapVariable.material.uniforms["chargeDecay"].value = v
    })
    gui.add(params, "mouseSize", 1.0, 100.0, 1.0)
    gui.add(params, "mouseWave", 0.0, 2.0, 0.05)
    gui.add(params, "bloomThreshold", 0, 1, 0.05).onChange((v) => {
      bloomPass.threshold = Number(v)
    })
    gui.add({ smoothWater: this.smoothWater.bind(this) }, "smoothWater")

    // Stats
    this.stats1 = new Stats()
    this.stats1.showPanel(0)
    this.stats1.domElement.style.cssText = "position:absolute;top:0px;left:0px;"
    this.container.appendChild(this.stats1.domElement)

    buildHud(market)
    startLive()

    await updateLoadingProgressBar(1.0, 100)
  },
  fillTexture(texture) {
    const waterMaxHeight = 0
    function noise(x, y) {
      let multR = waterMaxHeight
      let mult = 0.025
      let r = 0
      for (let i = 0; i < 15; i++) {
        r += multR * simplex.noise(x * mult, y * mult)
        multR *= 0.53 + 0.025 * i
        mult *= 1.25
      }
      return r
    }
    const pixels = texture.image.data
    let p = 0
    for (let j = 0; j < FBO_HEIGHT; j++) {
      for (let i = 0; i < FBO_WIDTH; i++) {
        const x = (i * 128) / FBO_WIDTH
        const y = (j * 128) / FBO_HEIGHT
        pixels[p + 0] = noise(x, y)
        pixels[p + 1] = 0
        pixels[p + 2] = 0 // charge channel starts neutral
        pixels[p + 3] = 0 // previous charge starts neutral
        p += 4
      }
    }
  },
  smoothWater() {
    const current = this.gpuCompute.getCurrentRenderTarget(this.heightmapVariable)
    const alternate = this.gpuCompute.getAlternateRenderTarget(this.heightmapVariable)
    for (let i = 0; i < 10; i++) {
      this.smoothShader.uniforms["smoothTexture"].value = current.texture
      this.gpuCompute.doRenderTarget(this.smoothShader, alternate)
      this.smoothShader.uniforms["smoothTexture"].value = alternate.texture
      this.gpuCompute.doRenderTarget(this.smoothShader, current)
    }
  },
  setMouseCoords(x, y) {
    this.mouseCoords.set((x / renderer.domElement.clientWidth) * 2 - 1, (y / renderer.domElement.clientHeight) * 2 - 1)
    this.mouseMoved = true
  },
  onPointerMove(event) {
    if (event.isPrimary === false) return
    this.setMouseCoords(event.clientX, event.clientY)
  },
  resize() {
    camera.left = window.innerWidth / -2
    camera.right = window.innerWidth / 2
    camera.top = window.innerHeight / 2
    camera.bottom = window.innerHeight / -2
    camera.updateProjectionMatrix()
  },
  updateScene(interval) {
    this.stats1.update()

    // Assemble this frame's drops: mouse first (white), then feed orders
    let n = 0
    if (this.mouseMoved) {
      this.raycaster.setFromCamera(this.mouseCoords, camera)
      const hits = this.raycaster.intersectObject(this.waterMesh)
      if (hits.length > 0) {
        const p = hits[0].point
        dropPosArr[n].set(p.x, p.y)
        dropSizeArr[n] = params.mouseSize
        dropAmpArr[n] = params.mouseWave
        dropChargeArr[n] = 0
        n++
      }
      this.mouseMoved = false
    }

    const orders = feed.collectDrops(MAX_DROPS - n)
    for (let i = 0; i < orders.length && n < MAX_DROPS; i++, n++) {
      const d = orders[i]
      dropPosArr[n].set(d.x, d.y)
      dropSizeArr[n] = Math.max(d.size, 1)
      dropAmpArr[n] = d.amp
      dropChargeArr[n] = d.charge
    }

    this.heightmapVariable.material.uniforms["dropCount"].value = n

    // GPU step
    this.gpuCompute.compute()
    this.waterUniforms["heightmap"].value = this.gpuCompute.getCurrentRenderTarget(this.heightmapVariable).texture

    // Global bloom eased toward feed targets
    const targets = feed.bloomTargets(interval || 0.016)
    bloomPass.strength += (targets.strength - bloomPass.strength) * 0.06
    bloomPass.radius += (targets.radius - bloomPass.radius) * 0.06
  },
}

/**************************************************
 * HUD (coin + mode + buy/sell legend)
 *************************************************/
function buildHud(coin) {
  hud = document.createElement("div")
  hud.style.cssText =
    "position:absolute;bottom:18px;left:18px;font:13px/1.5 helvetica,sans-serif;color:#cfe;letter-spacing:.04em;pointer-events:none;text-shadow:0 1px 3px #000;"
  hud.innerHTML =
    `<div style="font-weight:600;font-size:15px">${coin} · <span class="mode">connecting</span></div>` +
    `<div><span style="color:#1aff66">●</span> buy &nbsp; <span style="color:#ff3640">●</span> sell</div>`
  document.body.appendChild(hud)
}

/**************************************************
 * 3. Run
 *************************************************/
runApp(app, scene, renderer, camera, true, undefined, composer)
