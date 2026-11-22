"""Text extraction, chunking, tokenization, in-memory BM25 store and retrieval."""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import PurePath

from pypdf import PdfReader
from rank_bm25 import BM25Okapi

from config import BM25_IDF_FLOOR, CHUNK_OVERLAP, CHUNK_WORDS, TEXT_EXTENSIONS, TOP_K


class ExtractionError(Exception):
    """Raised when a document cannot be turned into text. Carries an HTTP status."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


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


def add_document(device_id: str, doc_name: str, chunks: list[Chunk]) -> None:
    """Add (or replace) a document's chunks for a device and rebuild the index."""
    old = STORE.get(device_id, DeviceStore())
    new_chunks = [c for c in old.chunks if c.doc_name != doc_name] + chunks
    new_docs = {**{k: v for k, v in old.docs.items() if k != doc_name}, doc_name: len(chunks)}
    STORE[device_id] = DeviceStore(docs=new_docs, chunks=new_chunks, bm25=_build_index(new_chunks))


def remove_document(device_id: str, doc_name: str) -> bool:
    old = STORE.get(device_id)
    if old is None or doc_name not in old.docs:
        return False
    new_chunks = [c for c in old.chunks if c.doc_name != doc_name]
    new_docs = {k: v for k, v in old.docs.items() if k != doc_name}
    STORE[device_id] = DeviceStore(docs=new_docs, chunks=new_chunks, bm25=_build_index(new_chunks))
    return True


def clear_device(device_id: str) -> None:
    STORE.pop(device_id, None)


def list_docs(device_id: str) -> DeviceStore:
    return STORE.get(device_id, DeviceStore())


def has_docs(device_id: str) -> bool:
    store = STORE.get(device_id)
    return bool(store and store.chunks)


# ---------- retrieval ----------

def retrieve(device_id: str, question: str, k: int = TOP_K) -> list[tuple[Chunk, float]]:
    """Top-k (chunk, score) sorted desc; chunks scoring <= 0 are dropped."""
    store = STORE.get(device_id)
    if store is None or store.bm25 is None:
        return []
    query = tokenize(question)
    if not query:
        return []
    scores = store.bm25.get_scores(query)
    ranked = [(c, float(s)) for c, s in zip(store.chunks, scores) if s > 0]
    ranked.sort(key=lambda cs: cs[1], reverse=True)
    return ranked[:k]
