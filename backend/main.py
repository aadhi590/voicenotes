"""VoiceNotes FastAPI app: document upload, speech-to-text, and streaming /ask WebSocket."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import PurePosixPath
from typing import Any

import groq
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

import llm  # noqa: E402  (env must be loaded first)
import rag  # noqa: E402
from config import (  # noqa: E402
    AUDIO_EXTENSIONS,
    LLM_MODEL,
    MAX_AUDIO_MB,
    MAX_QUESTION_CHARS,
    MAX_UPLOAD_MB,
    MIN_AUDIO_BYTES,
    MISSING_KEY_MESSAGE,
    NO_DOCS_MESSAGE,
    NOT_FOUND_MESSAGE,
    RATE_LIMIT_MESSAGE,
    SNIPPET_CHARS,
    STT_MODEL,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("voicenotes")

MB = 1024 * 1024
WS_MISSING_DEVICE_CODE = 4400

@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # One startup line for deploy logs. Never log the key itself.
    log.info("startup llm=%s stt=%s groq_key_set=%s", LLM_MODEL, STT_MODEL, llm.groq_configured())
    yield


# Our API owns /docs, so move FastAPI's Swagger UI out of the way.
app = FastAPI(title="VoiceNotes", docs_url="/swagger", redoc_url=None, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def ms_since(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)


def safe_filename(name: str | None) -> str:
    """Strip any client-supplied directory components."""
    return PurePosixPath((name or "").replace("\\", "/")).name


def require_device(x_device_id: str | None = Header(default=None)) -> str:
    if not x_device_id or not x_device_id.strip():
        raise HTTPException(400, "Missing X-Device-Id header.")
    return x_device_id.strip()


async def read_limited(file: UploadFile, max_mb: int) -> bytes:
    data = await file.read(max_mb * MB + 1)
    if len(data) > max_mb * MB:
        raise HTTPException(413, f"File too large. Max {max_mb} MB.")
    return data


# ---------------------------------------------------------------- HTTP

@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "groq_configured": llm.groq_configured()}


def _ingest(device_id: str, doc_name: str, data: bytes) -> tuple[int, int]:
    """CPU-bound: extract, chunk, index. Runs in a worker thread."""
    pages = rag.extract_pages(doc_name, data)
    chunks = rag.chunk_pages(doc_name, pages)
    rag.add_document(device_id, doc_name, chunks)
    return len(pages), len(chunks)


@app.post("/docs")
async def upload_doc(file: UploadFile = File(...), device_id: str = Depends(require_device)) -> dict[str, Any]:
    start = time.perf_counter()
    doc_name = safe_filename(file.filename)
    if not doc_name:
        raise HTTPException(400, "File must have a name.")
    data = await read_limited(file, MAX_UPLOAD_MB)
    try:
        pages, chunks = await asyncio.to_thread(_ingest, device_id, doc_name, data)
    except rag.ExtractionError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    log.info("upload device=%s doc=%s pages=%d chunks=%d ms=%d", device_id, doc_name, pages, chunks, ms_since(start))
    return {"doc_name": doc_name, "pages": pages, "chunks": chunks}


@app.get("/docs")
async def list_docs(device_id: str = Depends(require_device)) -> dict[str, Any]:
    store = rag.list_docs(device_id)
    return {
        "docs": [{"doc_name": name, "chunks": n} for name, n in store.docs.items()],
        "total_chunks": len(store.chunks),
    }


@app.delete("/docs")
async def clear_docs(device_id: str = Depends(require_device)) -> dict[str, bool]:
    rag.clear_device(device_id)
    return {"cleared": True}


@app.delete("/docs/{doc_name}")
async def delete_doc(doc_name: str, device_id: str = Depends(require_device)) -> dict[str, Any]:
    removed = await asyncio.to_thread(rag.remove_document, device_id, doc_name)
    if not removed:
        raise HTTPException(404, f"Document '{doc_name}' not found.")
    return {"deleted": doc_name}


@app.post("/stt")
async def speech_to_text(
    file: UploadFile = File(...), x_device_id: str | None = Header(default=None)
) -> dict[str, Any]:
    start = time.perf_counter()
    filename = safe_filename(file.filename) or "audio.m4a"
    if PurePosixPath(filename).suffix.lower() not in AUDIO_EXTENSIONS:
        raise HTTPException(400, "Unsupported audio type. Use m4a, mp4, aac, wav, webm, mp3 or ogg.")
    data = await read_limited(file, MAX_AUDIO_MB)
    if len(data) < MIN_AUDIO_BYTES:
        return {"text": "", "ms": ms_since(start)}
    if not llm.groq_configured():
        raise HTTPException(503, MISSING_KEY_MESSAGE)
    try:
        text = await llm.transcribe(filename, data)
    except Exception as exc:
        log.warning("stt failed device=%s: %s", x_device_id, exc)
        raise HTTPException(502, f"Transcription failed: {type(exc).__name__}: {str(exc)[:120]}") from exc
    ms = ms_since(start)
    log.info("stt device=%s bytes=%d ms=%d chars=%d", x_device_id, len(data), ms, len(text))
    return {"text": text, "ms": ms}


# ---------------------------------------------------------------- WebSocket

class AskSession:
    """One per socket: serialized sends and at most one running answer task."""

    def __init__(self, ws: WebSocket, device_id: str):
        self.ws = ws
        self.device_id = device_id
        self.task: asyncio.Task | None = None
        self.active_id: Any = None
        self._send_lock = asyncio.Lock()

    async def send(self, payload: dict[str, Any]) -> None:
        """All sends go through here; errors on a closed socket are swallowed."""
        try:
            async with self._send_lock:
                await self.ws.send_text(json.dumps(payload))
        except Exception:
            pass

    async def error(self, qid: Any, message: str) -> None:
        await self.send({"type": "error", "id": qid, "message": message})

    def is_running(self) -> bool:
        return self.task is not None and not self.task.done()

    async def cancel_active(self, notify: bool = True) -> None:
        if not self.is_running():
            return
        qid, task = self.active_id, self.task
        task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task
        self.task = None
        self.active_id = None
        if notify:
            await self.send({"type": "cancelled", "id": qid})
        log.info("ask cancelled device=%s id=%s", self.device_id, qid)

    async def start(self, qid: Any, question: str) -> None:
        await self.cancel_active()
        self.active_id = qid
        self.task = asyncio.create_task(self._answer(qid, question))

    async def _answer(self, qid: Any, question: str) -> None:
        try:
            await self._run_answer(qid, question)
        except asyncio.CancelledError:
            raise
        except groq.RateLimitError:
            log.warning("ask rate-limited device=%s id=%s", self.device_id, qid)
            await self.error(qid, RATE_LIMIT_MESSAGE)
        except Exception as exc:
            log.exception("ask failed device=%s id=%s", self.device_id, qid)
            await self.error(qid, f"Answer failed: {type(exc).__name__}")

    async def _single_token_answer(self, qid: Any, text: str, start: float, retrieval_ms: int) -> None:
        await self.send({"type": "token", "id": qid, "text": text})
        ttft = ms_since(start)
        await self._done(qid, retrieval_ms, ttft, start, tokens=1)

    async def _done(self, qid: Any, retrieval_ms: int, ttft_ms: int | None, start: float, tokens: int) -> None:
        metrics = {"retrieval_ms": retrieval_ms, "ttft_ms": ttft_ms, "total_ms": ms_since(start), "tokens": tokens}
        await self.send({"type": "done", "id": qid, "metrics": metrics})
        log.info("ask done device=%s id=%s %s", self.device_id, qid, metrics)

    async def _run_answer(self, qid: Any, question: str) -> None:
        start = time.perf_counter()
        question = (question or "").strip()
        if not question:
            await self.error(qid, "Question is empty.")
            return
        if len(question) > MAX_QUESTION_CHARS:
            await self.error(qid, f"Question too long (max {MAX_QUESTION_CHARS} characters).")
            return

        if not rag.has_docs(self.device_id):
            await self.send({"type": "sources", "id": qid, "sources": []})
            await self._single_token_answer(qid, NO_DOCS_MESSAGE, start, retrieval_ms=0)
            return

        t0 = time.perf_counter()
        sources = rag.retrieve(self.device_id, question)
        retrieval_ms = ms_since(t0)
        await self.send({
            "type": "sources",
            "id": qid,
            "sources": [
                {"n": n, "doc_name": c.doc_name, "page": c.page, "snippet": c.text[:SNIPPET_CHARS]}
                for n, (c, _score) in enumerate(sources, start=1)
            ],
        })

        if not sources:
            await self._single_token_answer(qid, NOT_FOUND_MESSAGE, start, retrieval_ms)
            return
        if not llm.groq_configured():
            await self.error(qid, MISSING_KEY_MESSAGE)
            return

        ttft_ms: int | None = None
        tokens = 0
        async for delta in llm.stream_answer(question, sources):
            if ttft_ms is None:
                ttft_ms = ms_since(start)
            tokens += 1
            await self.send({"type": "token", "id": qid, "text": delta})
        await self._done(qid, retrieval_ms, ttft_ms, start, tokens)

    async def handle(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            await self.error(None, "Invalid JSON.")
            return
        if not isinstance(msg, dict):
            await self.error(None, "Message must be a JSON object.")
            return

        kind, qid = msg.get("type"), msg.get("id")
        if kind == "ping":
            await self.send({"type": "pong"})
        elif kind == "ask":
            if qid is None:
                await self.error(None, "'ask' requires an 'id'.")
                return
            question = msg.get("question")
            await self.start(qid, question if isinstance(question, str) else "")
        elif kind == "cancel":
            if self.is_running() and qid == self.active_id:
                await self.cancel_active()
        else:
            await self.error(qid, f"Unknown message type: {kind!r}")


@app.websocket("/ask")
async def ask_ws(ws: WebSocket) -> None:
    await ws.accept()
    device_id = (ws.query_params.get("device_id") or "").strip()
    if not device_id:
        with suppress(Exception):
            await ws.send_text(json.dumps({"type": "error", "id": None, "message": "Missing device_id query parameter."}))
            await ws.close(code=WS_MISSING_DEVICE_CODE)
        return

    session = AskSession(ws, device_id)
    log.info("ws connected device=%s", device_id)
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            text = message.get("text")
            if text is None:
                await session.error(None, "Send JSON text frames only.")
                continue
            await session.handle(text)
    except (WebSocketDisconnect, RuntimeError):
        pass  # client went away; RuntimeError = receive after close
    finally:
        await session.cancel_active(notify=False)
        log.info("ws disconnected device=%s", device_id)
