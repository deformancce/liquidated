import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const THE_GRAPH_ENDPOINT = "https://token-api.thegraph.com/v1/hyperliquid/markets/liquidations";

function liquidationsProxy(env: Record<string, string>) {
  return {
    name: "liquidations-proxy",
    configureServer(server: { middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      server.middlewares.use("/api/liquidations", (req, res) => {
        handleLiquidationsRequest(req, res, env);
      });
    },
    configurePreviewServer(server: { middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      server.middlewares.use("/api/liquidations", (req, res) => {
        handleLiquidationsRequest(req, res, env);
      });
    },
  };
}

async function handleLiquidationsRequest(req: IncomingMessage, res: ServerResponse, env: Record<string, string>) {
  const token = env.THE_GRAPH_TOKEN_API_KEY || env.GRAPH_TOKEN_API_KEY || process.env.THE_GRAPH_TOKEN_API_KEY || process.env.GRAPH_TOKEN_API_KEY;
  if (!token) {
    sendJson(res, 500, { error: "Missing THE_GRAPH_TOKEN_API_KEY" });
    return;
  }

  try {
    const requestUrl = new URL(req.url || "", "http://localhost");
    const coin = sanitizeCoin(requestUrl.searchParams.get("coin"));
    const limit = sanitizeLimit(requestUrl.searchParams.get("limit"));
    const upstreamUrl = new URL(THE_GRAPH_ENDPOINT);
    upstreamUrl.searchParams.set("coin", coin);
    upstreamUrl.searchParams.set("dex", "perps");
    upstreamUrl.searchParams.set("sort_by", "time");
    upstreamUrl.searchParams.set("limit", String(limit));
    upstreamUrl.searchParams.set("page", "1");

    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", "application/json");
    res.end(text || "{}");
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Liquidations proxy failed" });
  }
}

function sanitizeCoin(value: string | null) {
  return ["BTC", "ETH", "SOL", "HYPE"].includes(value || "") ? value || "BTC" : "BTC";
}

function sanitizeLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), liquidationsProxy(env)],
    server: { host: "0.0.0.0" },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          resonator: resolve(__dirname, "resonator.html"),
          resonatorLive: resolve(__dirname, "resonator-live.html"),
          visuals: resolve(__dirname, "visuals.html"),
          synth: resolve(__dirname, "synth.html"),
          tape: resolve(__dirname, "tape.html"),
          water: resolve(__dirname, "water.html"),
          waterReflect: resolve(__dirname, "water-reflect.html"),
          waterLive: resolve(__dirname, "water-live.html"),
        },
      },
    },
  };
});
