const canvas = document.getElementById("flowCanvas");
const ctx = canvas.getContext("2d", { alpha: true });

const els = {
  title: document.querySelector("h1"),
  symbol: document.getElementById("symbolSelect"),
  live: document.getElementById("liveButton"),
  demo: document.getElementById("demoButton"),
  audio: document.getElementById("audioButton"),
  statusLight: document.getElementById("statusLight"),
  statusText: document.getElementById("statusText"),
  buyFlow: document.getElementById("buyFlow"),
  sellFlow: document.getElementById("sellFlow"),
  liquidations: document.getElementById("liquidations"),
  pulse: document.getElementById("pulse"),
  pressureLabel: document.getElementById("pressureLabel"),
  pressureFill: document.getElementById("pressureFill"),
  sensitivity: document.getElementById("sensitivity"),
  minSize: document.getElementById("minSize"),
  volume: document.getElementById("volume"),
  tape: document.getElementById("eventTape"),
};

const state = {
  symbol: "btcusdt",
  mode: "live",
  connected: false,
  particles: [],
  tape: [],
  stats: {
    buy: 0,
    sell: 0,
    liquidations: 0,
    pulse: 0,
  },
  audio: {
    enabled: false,
    ctx: null,
    master: null,
  },
  socket: null,
  demoTimer: null,
  lastFrame: performance.now(),
};

const colors = {
  buy: [69, 209, 150],
  sell: [255, 91, 110],
  liq: [247, 198, 93],
  cyan: [100, 215, 255],
};

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function money(value) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setStatus(text, connected) {
  state.connected = connected;
  els.statusText.textContent = text;
  els.statusLight.classList.toggle("live", connected);
}

function setMode(mode) {
  state.mode = mode;
  els.live.classList.toggle("active", mode === "live");
  els.demo.classList.toggle("active", mode === "demo");
  closeSocket();
  stopDemo();
  resetStats();

  if (mode === "live") {
    connectLive();
  } else {
    startDemo();
  }
}

function resetStats() {
  state.stats.buy = 0;
  state.stats.sell = 0;
  state.stats.liquidations = 0;
  state.stats.pulse = 0;
  state.tape = [];
  els.tape.replaceChildren();
  updateStats();
}

function updateStats() {
  els.buyFlow.textContent = money(state.stats.buy);
  els.sellFlow.textContent = money(state.stats.sell);
  els.liquidations.textContent = String(state.stats.liquidations);
  els.pulse.textContent = String(Math.round(state.stats.pulse));

  const total = state.stats.buy + state.stats.sell;
  const pressure = total ? (state.stats.buy - state.stats.sell) / total : 0;
  const label = pressure > 0.15 ? "Bid Heavy" : pressure < -0.15 ? "Ask Heavy" : "Neutral";
  const width = Math.abs(pressure) * 50;
  const left = pressure < 0 ? 50 - width : 50;

  els.pressureLabel.textContent = label;
  els.pressureFill.style.left = `${left}%`;
  els.pressureFill.style.width = `${width}%`;
}

function connectLive() {
  const streams = [
    `${state.symbol}@aggTrade`,
    `${state.symbol}@forceOrder`,
  ].join("/");
  const url = `wss://fstream.binance.com/stream?streams=${streams}`;

  setStatus("Connecting", false);
  state.socket = new WebSocket(url);

  state.socket.addEventListener("open", () => setStatus("Live Stream", true));
  state.socket.addEventListener("message", (message) => {
    const payload = JSON.parse(message.data);
    const event = normalizeBinanceEvent(payload.data);
    if (event) ingestEvent(event);
  });
  state.socket.addEventListener("close", () => {
    if (state.mode === "live") {
      setStatus("Reconnecting", false);
      window.setTimeout(connectLive, 1400);
    }
  });
  state.socket.addEventListener("error", () => {
    setStatus("Stream Error", false);
    state.socket.close();
  });
}

function closeSocket() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }
}

function normalizeBinanceEvent(data) {
  if (!data) return null;

  if (data.e === "aggTrade") {
    const price = Number(data.p);
    const quantity = Number(data.q);
    const side = data.m ? "sell" : "buy";
    return {
      type: "trade",
      side,
      price,
      size: price * quantity,
      quantity,
      at: data.T || Date.now(),
    };
  }

  if (data.e === "forceOrder" && data.o) {
    const price = Number(data.o.ap || data.o.p);
    const quantity = Number(data.o.q);
    const side = data.o.S === "BUY" ? "buy" : "sell";
    return {
      type: "liq",
      side,
      price,
      size: price * quantity,
      quantity,
      at: data.o.T || Date.now(),
    };
  }

  return null;
}

function startDemo() {
  setStatus("Demo Stream", true);
  state.demoTimer = window.setInterval(() => {
    const priceBase = state.symbol === "ethusdt" ? 3800 : state.symbol === "solusdt" ? 170 : state.symbol === "bnbusdt" ? 670 : 68000;
    const isLiq = Math.random() > 0.82;
    const side = Math.random() > 0.52 ? "buy" : "sell";
    const size = Math.pow(Math.random(), 2.4) * (isLiq ? 1_400_000 : 420_000) + 4_000;
    ingestEvent({
      type: isLiq ? "liq" : "trade",
      side,
      price: priceBase * (0.995 + Math.random() * 0.01),
      quantity: size / priceBase,
      size,
      at: Date.now(),
    });
  }, 90);
}

function stopDemo() {
  window.clearInterval(state.demoTimer);
  state.demoTimer = null;
}

function ingestEvent(event) {
  const minSize = Number(els.minSize.value);
  if (event.size < minSize) return;

  if (event.side === "buy") state.stats.buy += event.size;
  if (event.side === "sell") state.stats.sell += event.size;
  if (event.type === "liq") state.stats.liquidations += 1;
  state.stats.pulse = clamp(state.stats.pulse + Math.sqrt(event.size) / 42, 0, 999);

  spawnParticles(event);
  playEvent(event);
  addTapeEvent(event);
  updateStats();
}

function spawnParticles(event) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const sensitivity = Number(els.sensitivity.value);
  const intensity = clamp(Math.log10(event.size + 1) / 6, 0.25, 1.65) * sensitivity;
  const count = Math.round(clamp(intensity * (event.type === "liq" ? 18 : 9), 3, 42));
  const palette = event.type === "liq" ? colors.liq : colors[event.side];
  const originX = event.side === "buy" ? width * 0.18 : width * 0.82;
  const targetX = event.side === "buy" ? width * 0.72 : width * 0.28;
  const originY = height * (0.22 + Math.random() * 0.58);

  for (let i = 0; i < count; i += 1) {
    const speed = 80 + Math.random() * 260 * intensity;
    const angle = Math.atan2(height * 0.5 - originY, targetX - originX) + (Math.random() - 0.5) * 0.65;
    state.particles.push({
      x: originX + (Math.random() - 0.5) * 80,
      y: originY + (Math.random() - 0.5) * 80,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: 0.55 + Math.random() * 0.55,
      radius: 1.4 + Math.random() * 5.6 * intensity,
      color: palette,
      liq: event.type === "liq",
    });
  }
}

function ensureAudio() {
  if (state.audio.ctx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  state.audio.ctx = new AudioContext();
  state.audio.master = state.audio.ctx.createGain();
  state.audio.master.gain.value = Number(els.volume.value);
  state.audio.master.connect(state.audio.ctx.destination);
}

function playEvent(event) {
  if (!state.audio.enabled || !state.audio.ctx) return;

  const now = state.audio.ctx.currentTime;
  const osc = state.audio.ctx.createOscillator();
  const gain = state.audio.ctx.createGain();
  const pan = state.audio.ctx.createStereoPanner();
  const sizeTone = clamp(Math.log10(event.size + 1), 3.5, 6.8);
  const base = event.type === "liq" ? 170 : event.side === "buy" ? 260 : 115;
  const freq = base + sizeTone * (event.type === "liq" ? 74 : 32);

  osc.type = event.type === "liq" ? "triangle" : "sine";
  osc.frequency.setValueAtTime(freq, now);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.58, now + 0.18);
  pan.pan.value = event.side === "buy" ? -0.5 : 0.5;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(clamp(event.size / 900_000, 0.02, 0.28), now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (event.type === "liq" ? 0.42 : 0.16));

  osc.connect(gain).connect(pan).connect(state.audio.master);
  osc.start(now);
  osc.stop(now + 0.48);
}

function addTapeEvent(event) {
  const row = document.createElement("li");
  const type = document.createElement("span");
  const price = document.createElement("span");
  const size = document.createElement("strong");

  type.textContent = event.type === "liq" ? "LIQ" : event.side.toUpperCase();
  type.className = event.type === "liq" ? "liq" : event.side;
  price.textContent = event.price ? event.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "-";
  size.textContent = money(event.size);
  row.append(type, price, size);

  els.tape.prepend(row);
  while (els.tape.children.length > 18) {
    els.tape.lastElementChild.remove();
  }
}

function render(now) {
  const dt = Math.min((now - state.lastFrame) / 1000, 0.04);
  state.lastFrame = now;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  ctx.clearRect(0, 0, width, height);
  drawGrid(width, height, now);
  drawCore(width, height, now);

  ctx.globalCompositeOperation = "lighter";
  state.particles = state.particles.filter((particle) => {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.992;
    particle.vy *= 0.992;
    particle.life -= particle.decay * dt;

    if (particle.life <= 0) return false;
    const [r, g, b] = particle.color;
    ctx.beginPath();
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${particle.life})`;
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${particle.life})`;
    ctx.shadowBlur = particle.liq ? 22 : 12;
    ctx.arc(particle.x, particle.y, particle.radius * particle.life, 0, Math.PI * 2);
    ctx.fill();
    return true;
  });
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = "source-over";

  state.stats.buy *= 0.996;
  state.stats.sell *= 0.996;
  state.stats.pulse *= 0.985;
  if (Math.round(now) % 3 === 0) updateStats();

  requestAnimationFrame(render);
}

function drawGrid(width, height, now) {
  const gap = 44;
  const offset = (now * 0.018) % gap;
  ctx.strokeStyle = "rgba(255,255,255,0.045)";
  ctx.lineWidth = 1;

  for (let x = -gap; x < width + gap; x += gap) {
    ctx.beginPath();
    ctx.moveTo(x + offset, 0);
    ctx.lineTo(x + offset - width * 0.18, height);
    ctx.stroke();
  }

  for (let y = -gap; y < height + gap; y += gap) {
    ctx.beginPath();
    ctx.moveTo(0, y + offset);
    ctx.lineTo(width, y + offset);
    ctx.stroke();
  }
}

function drawCore(width, height, now) {
  const pulse = 0.75 + Math.sin(now * 0.003) * 0.08 + clamp(state.stats.pulse / 900, 0, 0.35);
  const x = width * 0.5;
  const y = height * 0.52;
  const radius = Math.min(width, height) * 0.16 * pulse;
  const gradient = ctx.createRadialGradient(x, y, radius * 0.12, x, y, radius);
  gradient.addColorStop(0, "rgba(244,241,232,0.36)");
  gradient.addColorStop(0.34, "rgba(100,215,255,0.18)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(244,241,232,0.36)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.64, now * 0.001, now * 0.001 + Math.PI * 1.45);
  ctx.stroke();
}

els.live.addEventListener("click", () => setMode("live"));
els.demo.addEventListener("click", () => setMode("demo"));
els.symbol.addEventListener("change", () => {
  state.symbol = els.symbol.value;
  els.title.textContent = state.symbol.toUpperCase();
  setMode(state.mode);
});
els.audio.addEventListener("click", async () => {
  ensureAudio();
  if (state.audio.ctx.state === "suspended") await state.audio.ctx.resume();
  state.audio.enabled = !state.audio.enabled;
  els.audio.setAttribute("aria-pressed", String(state.audio.enabled));
});
els.volume.addEventListener("input", () => {
  if (state.audio.master) state.audio.master.gain.value = Number(els.volume.value);
});

window.addEventListener("resize", fitCanvas);
fitCanvas();
connectLive();
requestAnimationFrame(render);
