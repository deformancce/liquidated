import asyncio
import json
import os
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
import grpc
from aiohttp import web
from dotenv import load_dotenv

try:
    import hyperliquid_pb2
    import hyperliquid_pb2_grpc
except ImportError:
    print("Missing generated proto modules. Run: python3 -m grpc_tools.protoc -I indexer --python_out=indexer --grpc_python_out=indexer indexer/hyperliquid.proto")
    raise


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / ".env")

MAX_EVENTS = int(os.getenv("LIQ_INDEXER_MAX_EVENTS", "500"))
PORT = int(os.getenv("LIQ_INDEXER_PORT", "8787"))
HOST = os.getenv("LIQ_INDEXER_HOST", "127.0.0.1")
START_TIMESTAMP_MS = int(os.getenv("LIQ_INDEXER_START_TIMESTAMP_MS", "0"))
NODE_FILLS_PATH = os.getenv("HL_NODE_FILLS_BY_BLOCK_PATH") or str(Path.home() / "hl/data/node_fills_by_block")
INDEXER_SOURCE = os.getenv("LIQ_INDEXER_SOURCE") or ("files" if os.getenv("HL_NODE_FILLS_BY_BLOCK_PATH") else "grpc")
FILE_POLL_INTERVAL = float(os.getenv("LIQ_INDEXER_FILE_POLL_INTERVAL", "0.5"))
FILE_START_MODE = os.getenv("LIQ_INDEXER_FILE_START_MODE", "tail")
ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}

connected_clients: set[web.WebSocketResponse] = set()
recent_liquidations: deque[dict[str, Any]] = deque(maxlen=MAX_EVENTS)
seen_ids: deque[str] = deque(maxlen=10_000)
seen_id_set: set[str] = set()
stats = {
    "blocks": 0,
    "liquidations": 0,
    "started_at": datetime.now(timezone.utc).isoformat(),
    "last_block_time": None,
    "last_error": None,
    "source": INDEXER_SOURCE,
    "node_fills_path": NODE_FILLS_PATH if "files" in INDEXER_SOURCE else None,
}


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({
        "status": "healthy",
        "clients": len(connected_clients),
        "recent": len(recent_liquidations),
        **stats,
    })


async def handle_liquidations(request: web.Request) -> web.Response:
    coin = request.query.get("coin")
    limit = clamp_int(request.query.get("limit"), 100, 1, MAX_EVENTS)
    rows = list(recent_liquidations)
    if coin:
        rows = [row for row in rows if row.get("coin") == coin]
    return web.json_response({"data": rows[-limit:]})


async def handle_options(_request: web.Request) -> web.Response:
    return web.Response(status=204)


@web.middleware
async def cors_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    if request.method == "OPTIONS":
      response = await handle_options(request)
    else:
      response = await handler(request)

    origin = request.headers.get("Origin")
    response.headers["Access-Control-Allow-Origin"] = origin if origin in ALLOWED_ORIGINS else "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


async def handle_websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    connected_clients.add(ws)
    await ws.send_str(json.dumps({"type": "snapshot", "data": list(recent_liquidations)}))

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT and msg.data == "ping":
                await ws.send_str("pong")
    finally:
        connected_clients.discard(ws)

    return ws


async def broadcast(event: dict[str, Any]) -> None:
    if not connected_clients:
        return
    message = json.dumps({"type": "liquidation", "data": event})
    stale: set[web.WebSocketResponse] = set()
    for ws in connected_clients:
        try:
            await ws.send_str(message)
        except Exception:
            stale.add(ws)
    connected_clients.difference_update(stale)


def normalize_block_fills(raw_data: bytes) -> list[dict[str, Any]]:
    decoded = json.loads(raw_data.decode("utf-8"))
    return normalize_decoded_fills(decoded, "grpc")


def normalize_decoded_fills(decoded: Any, source: str) -> list[dict[str, Any]]:
    events = extract_events(decoded)
    liquidations = []

    for user_address, fill in events:
        liquidation = fill.get("liquidation")
        if not isinstance(liquidation, dict):
            continue

        liquidated_user = str(liquidation.get("liquidatedUser") or "").lower()
        direction = str(fill.get("dir") or "")
        if "close" not in direction.lower() or user_address.lower() != liquidated_user:
            continue

        event_id = f'{fill.get("hash", "")}:{fill.get("tid", "")}'
        if not remember_event_id(event_id):
            continue

        price = float_or_zero(fill.get("px"))
        quantity = float_or_zero(fill.get("sz"))
        side = "sell" if "close long" in direction.lower() else "buy"
        timestamp = int(float_or_zero(fill.get("time")) or time.time() * 1000)
        event = {
            "id": event_id,
            "source": source,
            "coin": fill.get("coin"),
            "side": side,
            "price": price,
            "markPrice": float_or_none(liquidation.get("markPx")),
            "quantity": quantity,
            "notional": price * quantity,
            "timestamp": timestamp,
            "blockTime": decoded.get("block_time") if isinstance(decoded, dict) else None,
            "blockNumber": decoded.get("block_number") if isinstance(decoded, dict) else None,
            "direction": direction,
            "method": liquidation.get("method"),
            "liquidatedUser": liquidation.get("liquidatedUser"),
            "closedPnl": float_or_none(fill.get("closedPnl")),
            "hash": fill.get("hash"),
            "tid": fill.get("tid"),
            "crossed": fill.get("crossed"),
            "fee": float_or_none(fill.get("fee")),
        }
        liquidations.append(event)

    return liquidations


def extract_events(decoded: Any) -> list[tuple[str, dict[str, Any]]]:
    if isinstance(decoded, dict):
        block_events = decoded.get("events")
        if isinstance(block_events, list):
            return pair_events(block_events)
    if isinstance(decoded, list):
        if len(decoded) == 2 and isinstance(decoded[0], str) and isinstance(decoded[1], dict):
            return [(decoded[0], decoded[1])]
        return pair_events(decoded)
    return []


def pair_events(events: list[Any]) -> list[tuple[str, dict[str, Any]]]:
    paired = []
    for item in events:
        if isinstance(item, list) and len(item) == 2 and isinstance(item[0], str) and isinstance(item[1], dict):
            paired.append((item[0], item[1]))
    return paired


def remember_event_id(event_id: str) -> bool:
    if event_id in seen_id_set:
        return False
    seen_ids.append(event_id)
    seen_id_set.add(event_id)
    while len(seen_id_set) > seen_ids.maxlen:
        old = seen_ids.popleft()
        seen_id_set.discard(old)
    return True


async def stream_block_fills() -> None:
    endpoint = os.getenv("HYPERLIQUID_GRPC_ENDPOINT") or os.getenv("HYPERLIQUID_ENDPOINT")
    api_key = os.getenv("HYPERLIQUID_GRPC_API_KEY") or os.getenv("API_KEY")
    if not endpoint or not api_key:
        stats["last_error"] = "Missing HYPERLIQUID_GRPC_ENDPOINT/HYPERLIQUID_GRPC_API_KEY"
        print(stats["last_error"])
        return

    loop = asyncio.get_running_loop()
    await asyncio.to_thread(run_grpc_stream, endpoint, api_key, loop)


def run_grpc_stream(endpoint: str, api_key: str, loop: asyncio.AbstractEventLoop) -> None:
    metadata = [("x-api-key", api_key)]
    credentials = grpc.ssl_channel_credentials()
    options = [("grpc.max_receive_message_length", 150 * 1024 * 1024)]

    while True:
        try:
            print(f"Connecting to Hyperliquid gRPC fills: {endpoint}")
            with grpc.secure_channel(endpoint, credentials, options=options) as channel:
                client = hyperliquid_pb2_grpc.HyperLiquidL1GatewayStub(channel)
                request = hyperliquid_pb2.Timestamp(timestamp=START_TIMESTAMP_MS)

                for response in client.StreamBlockFills(request, metadata=metadata):
                    stats["blocks"] += 1
                    for event in normalize_block_fills(response.data):
                        recent_liquidations.append(event)
                        stats["liquidations"] += 1
                        stats["last_block_time"] = event.get("blockTime")
                        print(f'{event["coin"]} {event["side"]} liq {event["notional"]:.0f} @ {event["price"]}')
                        asyncio.run_coroutine_threadsafe(broadcast(event), loop)

        except grpc.RpcError as error:
            stats["last_error"] = str(error)
            print(f"gRPC error: {error}. Reconnecting in 5s.")
            time.sleep(5)
        except Exception as error:
            stats["last_error"] = str(error)
            print(f"Indexer error: {error}. Reconnecting in 5s.")
            time.sleep(5)


async def start_background_tasks(app: web.Application) -> None:
    tasks = []
    if INDEXER_SOURCE in {"grpc", "both"}:
        tasks.append(asyncio.create_task(stream_block_fills()))
    if INDEXER_SOURCE in {"files", "both"}:
        tasks.append(asyncio.create_task(watch_node_fills_path()))
    app["tasks"] = tasks


async def cleanup_background_tasks(app: web.Application) -> None:
    for task in app.get("tasks", []):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def watch_node_fills_path() -> None:
    path = Path(NODE_FILLS_PATH).expanduser()
    loop = asyncio.get_running_loop()
    print(f"Watching node fills path: {path}")
    await asyncio.to_thread(run_file_watcher, path, loop)


def run_file_watcher(path: Path, loop: asyncio.AbstractEventLoop) -> None:
    processed: dict[Path, int] = {}
    initialized = False

    while True:
        try:
            if not path.exists():
                stats["last_error"] = f"Node fills path not found: {path}"
                time.sleep(2)
                continue

            files = discover_fill_files(path)
            if not initialized and FILE_START_MODE == "tail":
                for file_path in files:
                    processed[file_path] = file_path.stat().st_size
                initialized = True
                stats["last_error"] = None
                print(f"Tailing {len(files)} existing node fill files")
                time.sleep(FILE_POLL_INTERVAL)
                continue

            initialized = True
            for file_path in files:
                read_new_file_bytes(file_path, processed, loop)

            stats["last_error"] = None
            time.sleep(FILE_POLL_INTERVAL)
        except Exception as error:
            stats["last_error"] = str(error)
            print(f"File watcher error: {error}. Retrying in 2s.")
            time.sleep(2)


def discover_fill_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    files = [item for item in path.rglob("*") if item.is_file() and not item.name.startswith(".")]
    files.sort(key=lambda item: item.stat().st_mtime)
    return files[-200:]


def read_new_file_bytes(file_path: Path, processed: dict[Path, int], loop: asyncio.AbstractEventLoop) -> None:
    offset = processed.get(file_path, 0)
    size = file_path.stat().st_size
    if size < offset:
        offset = 0
    if size == offset:
        return

    with file_path.open("rb") as handle:
        handle.seek(offset)
        chunk = handle.read()
    processed[file_path] = size

    for line in chunk.splitlines():
        if not line.strip():
            continue
        process_file_payload(line, file_path, loop)


def process_file_payload(raw: bytes, file_path: Path, loop: asyncio.AbstractEventLoop) -> None:
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        try:
            decoded = json.loads(raw)
        except Exception:
            print(f"Skipping non-json fill line in {file_path}")
            return

    stats["blocks"] += 1
    for event in normalize_decoded_fills(decoded, "node-files"):
        recent_liquidations.append(event)
        stats["liquidations"] += 1
        stats["last_block_time"] = event.get("blockTime")
        print(f'{event["coin"]} {event["side"]} file liq {event["notional"]:.0f} @ {event["price"]}')
        asyncio.run_coroutine_threadsafe(broadcast(event), loop)


def float_or_zero(value: Any) -> float:
    parsed = float_or_none(value)
    return parsed if parsed is not None else 0.0


def float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def clamp_int(value: str | None, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value or fallback)
    except ValueError:
        parsed = fallback
    return min(maximum, max(minimum, parsed))


def main() -> None:
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/health", handle_health)
    app.router.add_get("/liquidations", handle_liquidations)
    app.router.add_get("/ws", handle_websocket)
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(cleanup_background_tasks)
    print(f"Liquidation indexer serving on http://{HOST}:{PORT}")
    web.run_app(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
