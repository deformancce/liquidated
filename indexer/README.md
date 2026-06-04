# Hyperliquid Liquidation Indexer

Streams or tails raw Hyperliquid fills, filters liquidation fills, and exposes them locally:

- REST: `http://localhost:8787/liquidations?coin=BTC&limit=100`
- WebSocket: `ws://localhost:8787/ws`
- Health: `http://localhost:8787/health`

## Setup

```bash
python3 -m pip install -r indexer/requirements.txt
python3 -m grpc_tools.protoc -I indexer --python_out=indexer --grpc_python_out=indexer indexer/hyperliquid.proto
```

## Local node mode

If you run a Hyperliquid non-validating node with `--write-fills --batch-by-block`, point the indexer at the node output:

```bash
LIQ_INDEXER_SOURCE=files
HL_NODE_FILLS_BY_BLOCK_PATH=/Users/you/hl/data/node_fills_by_block
LIQ_INDEXER_FILE_START_MODE=tail
LIQ_INDEXER_PORT=8787
```

`tail` starts at the end of existing files and only emits new liquidations. Use `all` if you want to scan existing files on startup.

## gRPC provider mode

Add provider credentials to `.env.local`:

```bash
LIQ_INDEXER_SOURCE=grpc
HYPERLIQUID_GRPC_ENDPOINT=YOUR_CUSTOM_URL.n.dwellir.com:443
HYPERLIQUID_GRPC_API_KEY=your-api-key
LIQ_INDEXER_PORT=8787
```

Use `LIQ_INDEXER_SOURCE=both` to run both inputs.

## Run

```bash
python3 indexer/server.py
```

The Tape page reads `VITE_LIQUIDATIONS_WS_URL` or defaults to `ws://localhost:8787/ws`.
