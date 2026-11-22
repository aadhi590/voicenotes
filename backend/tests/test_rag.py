import pytest

import rag
from config import CHUNK_OVERLAP, CHUNK_WORDS


@pytest.fixture(autouse=True)
def clean_store():
    rag.STORE.clear()
    yield
    rag.STORE.clear()


def test_chunking_1200_words_overlap_and_pages():
    words = [f"w{i}" for i in range(1200)]
    chunks = rag.chunk_pages("notes.txt", [(3, " ".join(words)), (4, "short page here")])

    page3 = [c for c in chunks if c.page == 3]
    # step = 500 - 80 = 420 -> windows start at 0, 420, 840 (840+500 >= 1200)
    assert len(page3) == 3
    first, second = page3[0].text.split(), page3[1].text.split()
    assert len(first) == CHUNK_WORDS
    assert first[-CHUNK_OVERLAP:] == second[:CHUNK_OVERLAP]
    assert page3[-1].text.split()[-1] == "w1199"
    assert [c.id for c in page3] == ["notes.txt:3:0", "notes.txt:3:1", "notes.txt:3:2"]

    page4 = [c for c in chunks if c.page == 4]
    assert len(page4) == 1 and page4[0].text == "short page here"


def test_tokenizer_lowercases_and_drops_stopwords():
    assert rag.tokenize("The Mitochondria IS the Powerhouse of the CELL!") == ["mitochondria", "powerhouse", "cell"]


def test_extract_txt_normalizes_whitespace():
    assert rag.extract_pages("a.md", b"hello   \n\n world") == [(1, "hello world")]


def test_extract_rejects_unsupported_and_empty():
    with pytest.raises(rag.ExtractionError) as unsupported:
        rag.extract_pages("a.docx", b"x")
    assert unsupported.value.status_code == 400
    with pytest.raises(rag.ExtractionError) as empty:
        rag.extract_pages("a.txt", b"   \n ")
    assert empty.value.status_code == 422


def _load_three_docs(device: str) -> None:
    docs = {
        "bio.txt": "Photosynthesis converts light energy into chemical energy in chloroplasts using chlorophyll.",
        "os.txt": "Round robin scheduling gives each process a fixed time quantum on the CPU.",
        "history.txt": "The French Revolution began in 1789 with the storming of the Bastille.",
    }
    for name, text in docs.items():
        rag.add_document(device, name, rag.chunk_pages(name, rag.extract_pages(name, text.encode())))


def test_retrieval_ranks_relevant_doc_first():
    _load_three_docs("d1")
    results = rag.retrieve("d1", "How does round robin CPU scheduling work?")
    assert results and results[0][0].doc_name == "os.txt"
    assert all(score > 0 for _, score in results)
    assert [s for _, s in results] == sorted((s for _, s in results), reverse=True)


def test_retrieval_empty_for_unrelated_question():
    _load_three_docs("d1")
    assert rag.retrieve("d1", "zebra migration patterns") == []


def test_retrieval_works_with_single_chunk_corpus():
    rag.add_document("d2", "one.txt", rag.chunk_pages("one.txt", [(1, "Photosynthesis uses light.")]))
    results = rag.retrieve("d2", "what is photosynthesis")
    assert len(results) == 1 and results[0][1] > 0


def test_reupload_replaces_and_remove_document():
    _load_three_docs("d1")
    rag.add_document("d1", "bio.txt", rag.chunk_pages("bio.txt", [(1, "new bio text")]))
    store = rag.list_docs("d1")
    assert len(store.chunks) == 3 and store.docs["bio.txt"] == 1
    assert rag.remove_document("d1", "bio.txt") is True
    assert rag.remove_document("d1", "bio.txt") is False
    assert "bio.txt" not in rag.list_docs("d1").docs


# ---------- memory guards (public URL, no auth) ----------

def _doc(name: str, n_chunks: int = 1) -> list:
    return [rag.Chunk(f"{name}:1:{i}", name, 1, f"word{i} topic") for i in range(n_chunks)]


def test_doc_limit_per_device(monkeypatch):
    monkeypatch.setattr(rag, "MAX_DOCS_PER_DEVICE", 2)
    rag.add_document("d", "a.txt", _doc("a.txt"))
    rag.add_document("d", "b.txt", _doc("b.txt"))
    rag.add_document("d", "a.txt", _doc("a.txt"))  # replacing an existing doc is allowed
    with pytest.raises(rag.StoreLimitError) as exc:
        rag.add_document("d", "c.txt", _doc("c.txt"))
    assert exc.value.status_code == 409
    assert set(rag.list_docs("d").docs) == {"a.txt", "b.txt"}


def test_chunk_limit_per_device(monkeypatch):
    monkeypatch.setattr(rag, "MAX_CHUNKS_PER_DEVICE", 5)
    rag.add_document("d", "a.txt", _doc("a.txt", 4))
    with pytest.raises(rag.StoreLimitError) as exc:
        rag.add_document("d", "b.txt", _doc("b.txt", 2))
    assert exc.value.status_code == 413
    assert len(rag.list_docs("d").chunks) == 4  # store unchanged on rejection


def test_global_budget_evicts_least_recently_used(monkeypatch):
    monkeypatch.setattr(rag, "MAX_TOTAL_CHUNKS", 6)
    rag._LAST_USED.clear()
    for dev in ("old", "mid", "new"):
        rag.add_document(dev, "n.txt", _doc("n.txt", 2))
    rag.retrieve("old", "word0")  # touching "old" makes "mid" the least recently used
    evicted = rag.add_document("newest", "n.txt", _doc("n.txt", 2))
    assert evicted == ["mid"]
    assert set(rag.STORE) == {"old", "new", "newest"}
    assert rag.store_stats() == {"devices": 3, "chunks": 6}


def test_concurrent_uploads_to_one_device_keep_every_doc():
    import threading

    threads = [threading.Thread(target=rag.add_document, args=("d", f"doc{i}.txt", _doc(f"doc{i}.txt", 3)))
               for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    store = rag.list_docs("d")
    assert len(store.docs) == 10 and len(store.chunks) == 30
