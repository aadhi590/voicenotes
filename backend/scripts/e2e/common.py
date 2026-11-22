"""Shared helpers for the e2e suite: report, HTTP/WS clients, answer analysis."""

from __future__ import annotations

import asyncio
import json
import math
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import websockets

E2E_DIR = Path(__file__).resolve().parent
FIXTURES = E2E_DIR / "fixtures"
BACKEND_DIR = E2E_DIR.parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import rag  # noqa: E402  (same pipeline code the server runs)

DOC_FILES = ["notes_os.pdf", "notes_bio.txt", "long_notes.txt"]
MIME = {".pdf": "application/pdf", ".txt": "text/plain", ".wav": "audio/wav"}
WS_TIMEOUT_S = 60
CITE_RE = re.compile(r"\[(\d+)\]")
NOT_FOUND = "couldn't find that in your notes"
THINK_MARKERS = ("<think>", "</think>", "let me think", "okay, so the user", "the user is asking", "we need to answer")


def new_device(prefix: str) -> str:
    return f"e2e-{prefix}-{uuid.uuid4().hex[:8]}"


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(pct / 100 * len(ordered)) - 1)]


# ---------------------------------------------------------------- report

@dataclass
class Report:
    section: str = ""
    results: list[tuple[str, str, bool, str]] = field(default_factory=list)
    notes: dict[str, list[str]] = field(default_factory=dict)

    def check(self, name: str, ok: Any, detail: str = "") -> bool:
        ok = bool(ok)
        self.results.append((self.section, name, ok, detail))
        suffix = f" -- {detail}" if detail else ""
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{suffix}", flush=True)
        return ok

    def note(self, msg: str) -> None:
        self.notes.setdefault(self.section, []).append(msg)
        print(f"  [NOTE] {msg}", flush=True)

    def info(self, msg: str) -> None:
        print(f"         {msg}", flush=True)


@dataclass
class Ctx:
    base: str
    client: httpx.AsyncClient
    report: Report
    server_log: Path | None
    local_chunks: dict[str, list[rag.Chunk]]

    def ws_url(self, device: str) -> str:
        return self.base.replace("https://", "wss://").replace("http://", "ws://") + f"/ask?device_id={device}"


def build_local_chunks() -> dict[str, list[rag.Chunk]]:
    """Chunk the fixtures with the same code the server uses (for snippet -> full text lookup)."""
    out = {}
    for name in DOC_FILES:
        pages = rag.extract_pages(name, (FIXTURES / name).read_bytes())
        out[name] = rag.chunk_pages(name, pages)
    return out


# ---------------------------------------------------------------- HTTP

async def upload(client: httpx.AsyncClient, device: str | None, name: str, data: bytes | None = None) -> httpx.Response:
    payload = data if data is not None else (FIXTURES / name).read_bytes()
    headers = {"X-Device-Id": device} if device else {}
    mime = MIME.get(Path(name).suffix, "application/octet-stream")
    return await client.post("/docs", headers=headers, files={"file": (name, payload, mime)})


async def upload_all(client: httpx.AsyncClient, device: str, names: list[str] = DOC_FILES) -> None:
    for name in names:
        r = await upload(client, device, name)
        r.raise_for_status()


async def list_docs(client: httpx.AsyncClient, device: str) -> dict[str, Any]:
    r = await client.get("/docs", headers={"X-Device-Id": device})
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------- WebSocket

@dataclass
class Answer:
    qid: str
    question: str
    events: list[tuple[float, dict]] = field(default_factory=list)  # (perf_counter, msg)

    def own(self) -> list[dict]:
        return [m for _, m in self.events if m.get("id") == self.qid]

    @property
    def types(self) -> list[str]:
        return [m["type"] for m in self.own()]

    @property
    def sources(self) -> list[dict]:
        return next((m["sources"] for m in self.own() if m["type"] == "sources"), [])

    @property
    def text(self) -> str:
        return "".join(m["text"] for m in self.own() if m["type"] == "token")

    @property
    def terminal(self) -> dict:
        return self.own()[-1] if self.own() else {}

    @property
    def metrics(self) -> dict:
        return self.terminal.get("metrics", {}) if self.terminal.get("type") == "done" else {}


async def recv(ws) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=WS_TIMEOUT_S))


async def send(ws, payload: dict) -> None:
    await ws.send(json.dumps(payload))


async def collect(ws, answer: Answer, terminal=("done", "cancelled", "error")) -> Answer:
    while True:
        msg = await recv(ws)
        answer.events.append((time.perf_counter(), msg))
        if msg.get("id") == answer.qid and msg["type"] in terminal:
            return answer


RATE_LIMIT_WAIT_S = 20
MAX_RATE_LIMIT_RETRIES = 8
RATE_LIMIT_HITS: list[str] = []  # questions that had to back off (Groq TPM quota)


def is_rate_limited(msg: dict) -> bool:
    return msg.get("type") == "error" and "rate limit" in msg.get("message", "").lower()


async def _backoff(question: str) -> None:
    RATE_LIMIT_HITS.append(question)
    print(f"         (Groq rate limit -> waiting {RATE_LIMIT_WAIT_S}s and retrying)", flush=True)
    await asyncio.sleep(RATE_LIMIT_WAIT_S)


async def ask(ws, question: str) -> Answer:
    """Ask and collect until terminal. Retries when the server reports a Groq rate limit."""
    for _ in range(MAX_RATE_LIMIT_RETRIES):
        answer = Answer(qid=uuid.uuid4().hex[:8], question=question)
        await send(ws, {"type": "ask", "id": answer.qid, "question": question})
        await collect(ws, answer)
        if not is_rate_limited(answer.terminal):
            return answer
        await _backoff(question)
    return answer


async def start_streaming(ws, question: str, prefix: str = "") -> Answer:
    """Send an ask and return once the first token has arrived (rate-limit aware)."""
    for _ in range(MAX_RATE_LIMIT_RETRIES):
        answer = Answer(qid=prefix + uuid.uuid4().hex[:6], question=question)
        await send(ws, {"type": "ask", "id": answer.qid, "question": question})
        while True:
            msg = await recv(ws)
            answer.events.append((time.perf_counter(), msg))
            if msg.get("id") != answer.qid:
                continue
            if msg["type"] == "token" or msg["type"] in ("done", "cancelled") or (msg["type"] == "error" and not is_rate_limited(msg)):
                return answer
            if is_rate_limited(msg):
                break
        await _backoff(question)
    return answer


def connect(ctx: Ctx, device: str):
    return websockets.connect(ctx.ws_url(device), open_timeout=20, max_size=None)


# ---------------------------------------------------------------- answer analysis

def split_sentences(text: str) -> list[str]:
    # Pull citations that trail the period ("... light. [1]") back inside the sentence.
    text = re.sub(r"([.!?])((?:\s*\[\d+\])+)", lambda m: m.group(2) + m.group(1), text.strip())
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def chunk_text_for(source: dict, local_chunks: dict[str, list[rag.Chunk]]) -> str:
    for chunk in local_chunks.get(source["doc_name"], []):
        if chunk.page == source["page"] and chunk.text.startswith(source["snippet"]):
            return chunk.text
    return source["snippet"]


@dataclass
class Analysis:
    citations: list[int]
    out_of_range: list[int]
    ungrounded: list[str]
    uncited: list[str]
    sentences: list[str]
    markdown: bool
    think_leak: bool


def analyze(answer: Answer, local_chunks: dict[str, list[rag.Chunk]]) -> Analysis:
    text, sources = answer.text, answer.sources
    citations = [int(n) for n in CITE_RE.findall(text)]
    out_of_range = [n for n in citations if not 1 <= n <= len(sources)]
    ungrounded, uncited = [], []
    sentences = split_sentences(text)
    for sentence in sentences:
        nums = [int(n) for n in CITE_RE.findall(sentence)]
        terms = {t for t in rag.tokenize(CITE_RE.sub("", sentence)) if len(t) >= 3}
        if not nums:
            uncited.append(sentence)
            continue
        for n in nums:
            if 1 <= n <= len(sources):
                chunk_terms = set(rag.tokenize(chunk_text_for(sources[n - 1], local_chunks)))
                if terms and not terms & chunk_terms:
                    ungrounded.append(f"[{n}] {sentence}")
    markdown = bool(re.search(r"\*|#|```|(^|\n)\s*[-•]\s", text))
    lowered = text.lower()
    think_leak = any(marker in lowered for marker in THINK_MARKERS)
    return Analysis(citations, out_of_range, ungrounded, uncited, sentences, markdown, think_leak)


def cited_sources(answer: Answer) -> list[dict]:
    sources = answer.sources
    return [sources[n - 1] for n in {int(x) for x in CITE_RE.findall(answer.text)} if 1 <= n <= len(sources)]


def normalize_quotes(text: str) -> str:
    return text.replace("’", "'").replace("‘", "'").lower()
