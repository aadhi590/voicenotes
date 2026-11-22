"""Live sanity check against a running VoiceNotes server.

Usage:
    python scripts/ws_test.py [--base http://localhost:8000] [--question "..."] [--cancel-after N]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path

import httpx
import websockets

NOTES = Path(__file__).with_name("sample_notes.txt")
DEFAULT_QUESTION = "What happens in the Calvin cycle and where does it take place?"
RECV_TIMEOUT_S = 60


def upload(base: str, device_id: str) -> None:
    with NOTES.open("rb") as fh:
        r = httpx.post(
            f"{base}/docs",
            headers={"X-Device-Id": device_id},
            files={"file": (NOTES.name, fh, "text/plain")},
            timeout=30,
        )
    r.raise_for_status()
    print(f"uploaded: {r.json()}")


async def recv_json(ws) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT_S))


async def ask(base: str, device_id: str, question: str, cancel_after: int | None) -> int:
    ws_url = base.replace("https://", "wss://").replace("http://", "ws://") + f"/ask?device_id={device_id}"
    qid = uuid.uuid4().hex[:8]
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"type": "ask", "id": qid, "question": question}))
        print(f"Q: {question}")
        tokens = 0
        cancel_sent = False
        while True:
            msg = await recv_json(ws)
            kind = msg["type"]
            if kind == "sources":
                print("sources:")
                for s in msg["sources"]:
                    print(f"  [{s['n']}] {s['doc_name']} p.{s['page']}: {s['snippet'][:80]}...")
                print("A: ", end="", flush=True)
            elif kind == "token":
                tokens += 1
                sys.stdout.write(msg["text"])
                sys.stdout.flush()
                if cancel_after and tokens >= cancel_after and not cancel_sent:
                    await ws.send(json.dumps({"type": "cancel", "id": qid}))
                    cancel_sent = True
            elif kind == "done":
                print(f"\nmetrics: {msg['metrics']}")
                if cancel_after:
                    print("FAIL: expected 'cancelled' but the answer completed")
                    return 1
                return 0
            elif kind == "cancelled":
                print(f"\nOK: cancelled after {tokens} tokens")
                await ws.send(json.dumps({"type": "ping"}))
                print(f"socket still alive: {await recv_json(ws)}")
                return 0
            elif kind == "error":
                print(f"\nERROR: {msg['message']}")
                return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--cancel-after", type=int, default=None)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252

    base = args.base.rstrip("/")
    device_id = f"wstest-{uuid.uuid4().hex[:8]}"
    upload(base, device_id)
    return asyncio.run(ask(base, device_id, args.question, args.cancel_after))


if __name__ == "__main__":
    sys.exit(main())
