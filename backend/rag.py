"""Text extraction, chunking, tokenization, in-memory BM25 store and retrieval."""

from __future__ import annotations

import io
import itertools
import re
import threading
from dataclasses import dataclass, field
from pathlib import PurePath

from pypdf import PdfReader
from rank_bm25 import BM25Okapi

from config import (
    BM25_IDF_FLOOR,
    CHUNK_OVERLAP,
    CHUNK_WORDS,
    MAX_CHUNKS_PER_DEVICE,
    MAX_DOCS_PER_DEVICE,
    MAX_TOTAL_CHUNKS,
    TEXT_EXTENSIONS,
    TOP_K,
)


class RagError(Exception):
    """A user-facing ingestion error that carries an HTTP status."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class ExtractionError(RagError):
    """The document cannot be turned into text."""


class StoreLimitError(RagError):
    """The device would exceed its document/chunk limits."""


@dataclass(frozen=True)
class Chunk:
    id: str
    doc_name: str
    page: int
    text: str


@dataclass
class DeviceStore:
    docs: dict[str, int] = field(default_factory=dict)
    chunks: list[Chunk] = field(default_factory=list)
    bm25: BM25Okapi | None = None


STORE: dict[str, DeviceStore] = {}

STOPWORDS = frozenset(
    """a an the and or but if of to in on at by for with from as is are was were be been
    being it its this that these those i you he she we they me my your our their what which
    who whom how why when where do does did not no so than too very can will just about""".split()
)

_WS_RE = re.compile(r"\s+")
_TOKEN_RE = re.compile(r"[a-z0-9]+")


# ---------- extraction ----------

def normalize(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def extract_pages(filename: str, data: bytes) -> list[tuple[int, str]]:
    """Return [(1-based page, normalized text)] for non-empty pages."""
    ext = PurePath(filename).suffix.lower()
    if ext == ".pdf":
        try:
            reader = PdfReader(io.BytesIO(data))
            raw = [(i + 1, page.extract_text() or "") for i, page in enumerate(reader.pages)]
        except Exception as exc:  # pypdf raises many exception types on malformed files
            raise ExtractionError(422, f"Could not read PDF: {exc}") from exc
    elif ext in TEXT_EXTENSIONS:
        raw = [(1, data.decode("utf-8", errors="ignore"))]
    else:
        raise ExtractionError(400, "Unsupported file type. Use PDF, TXT or MD.")

    pages = [(n, normalize(t)) for n, t in raw]
    pages = [(n, t) for n, t in pages if t]
    if not pages:
        raise ExtractionError(422, "No text found. Scanned PDFs are not supported.")
    return pages


# ---------- chunking ----------

def chunk_words(words: list[str], size: int = CHUNK_WORDS, overlap: int = CHUNK_OVERLAP) -> list[list[str]]:
    """Sliding word window. Short inputs become a single window."""
    if not words:
        return []
    if len(words) <= size:
        return [words]
    step = size - overlap
    windows = []
    for start in range(0, len(words), step):
        windows.append(words[start:start + size])
        if start + size >= len(words):
            break
    return windows


def chunk_pages(doc_name: str, pages: list[tuple[int, str]]) -> list[Chunk]:
    """Chunk each page separately so every chunk carries one correct page number."""
    return [
        Chunk(id=f"{doc_name}:{page}:{i}", doc_name=doc_name, page=page, text=" ".join(window))
        for page, text in pages
        for i, window in enumerate(chunk_words(text.split()))
    ]


# ---------- tokenization ----------

def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if t not in STOPWORDS]


# ---------- store ----------

def _build_index(chunks: list[Chunk]) -> BM25Okapi | None:
    corpus = [tokenize(c.text) for c in chunks]
    if not any(corpus):
        return None
    bm25 = BM25Okapi(corpus)
    bm25.idf = {term: max(idf, BM25_IDF_FLOOR) for term, idf in bm25.idf.items()}
    return bm25


# Writers (upload/delete, run in worker threads) are serialized by this lock so concurrent
# uploads never lose each other's docs. Readers stay lock-free: they only do single dict
# lookups/assignments, which are atomic in CPython, and always see a complete DeviceStore.
_WRITE_LOCK = threading.Lock()
_LAST_USED: dict[str, int] = {}
_USE_COUNTER = itertools.count()  # strictly increasing; clocks can tie (Windows ~15 ms)


def _touch(device_id: str) -> None:
    _LAST_USED[device_id] = next(_USE_COUNTER)


def _evict_for_budget(keep: str) -> list[str]:
    """Drop least-recently-used devices until total chunks fit the global budget. Caller holds the lock."""
    evicted: list[str] = []
    total = sum(len(s.chunks) for s in list(STORE.values()))
    by_age = sorted(list(_LAST_USED.items()), key=lambda kv: kv[1])
    for device_id, _ in by_age:
        if total <= MAX_TOTAL_CHUNKS:
            break
        if device_id == keep:
            continue
        store = STORE.pop(device_id, None)
        _LAST_USED.pop(device_id, None)
        if store is not None:
            total -= len(store.chunks)
            evicted.append(device_id)
    return evicted


def add_document(device_id: str, doc_name: str, chunks: list[Chunk]) -> list[str]:
    """Add (or replace) a document's chunks for a device and rebuild the index.

    Raises StoreLimitError if the device would exceed its doc/chunk limits.
    Returns the ids of devices evicted to stay within the global memory budget.
    """
    with _WRITE_LOCK:
        old = STORE.get(device_id, DeviceStore())
        kept = [c for c in old.chunks if c.doc_name != doc_name]
        new_docs = {**{k: v for k, v in old.docs.items() if k != doc_name}, doc_name: len(chunks)}
        if len(new_docs) > MAX_DOCS_PER_DEVICE:
            raise StoreLimitError(409, f"Document limit reached ({MAX_DOCS_PER_DEVICE}). Delete a document first.")
        if len(kept) + len(chunks) > MAX_CHUNKS_PER_DEVICE:
            raise StoreLimitError(
                413, f"Notes too large: this would exceed {MAX_CHUNKS_PER_DEVICE} chunks per device. "
                "Upload a smaller file or delete a document first."
            )
        new_chunks = kept + chunks
        STORE[device_id] = DeviceStore(docs=new_docs, chunks=new_chunks, bm25=_build_index(new_chunks))
        _touch(device_id)
        return _evict_for_budget(keep=device_id)


def remove_document(device_id: str, doc_name: str) -> bool:
    with _WRITE_LOCK:
        old = STORE.get(device_id)
        if old is None or doc_name not in old.docs:
            return False
        new_chunks = [c for c in old.chunks if c.doc_name != doc_name]
        new_docs = {k: v for k, v in old.docs.items() if k != doc_name}
        STORE[device_id] = DeviceStore(docs=new_docs, chunks=new_chunks, bm25=_build_index(new_chunks))
        return True


def clear_device(device_id: str) -> None:
    with _WRITE_LOCK:
        STORE.pop(device_id, None)
        _LAST_USED.pop(device_id, None)


def list_docs(device_id: str) -> DeviceStore:
    return STORE.get(device_id, DeviceStore())


def has_docs(device_id: str) -> bool:
    store = STORE.get(device_id)
    return bool(store and store.chunks)


def store_stats() -> dict[str, int]:
    stores = list(STORE.values())
    return {"devices": len(stores), "chunks": sum(len(s.chunks) for s in stores)}


# ---------- retrieval ----------

def retrieve(device_id: str, question: str, k: int = TOP_K) -> list[tuple[Chunk, float]]:
    """Top-k (chunk, score) sorted desc; chunks scoring <= 0 are dropped."""
    store = STORE.get(device_id)
    if store is not None:
        _touch(device_id)
    if store is None or store.bm25 is None:
        return []
    query = tokenize(question)
    if not query:
        return []
    scores = store.bm25.get_scores(query)
    ranked = [(c, float(s)) for c, s in zip(store.chunks, scores) if s > 0]
    ranked.sort(key=lambda cs: cs[1], reverse=True)
    return ranked[:k]
