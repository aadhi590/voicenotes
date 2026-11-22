import pytest
from fastapi.testclient import TestClient

import llm
import main
import rag

H = {"X-Device-Id": "dev-api"}


@pytest.fixture(autouse=True)
def clean_store():
    rag.STORE.clear()
    yield
    rag.STORE.clear()


@pytest.fixture
def client():
    return TestClient(main.app)


def upload(client, name="notes.txt", body=b"Photosynthesis happens in chloroplasts.", headers=H):
    return client.post("/docs", headers=headers, files={"file": (name, body, "text/plain")})


def test_health(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "groq_configured": False}


def test_missing_device_id_returns_400(client):
    r = upload(client, headers={})
    assert r.status_code == 400
    assert "X-Device-Id" in r.json()["detail"]
    assert client.get("/docs").status_code == 400


def test_upload_list_and_no_duplicates(client):
    r = upload(client)
    assert r.status_code == 200
    body = r.json()
    assert body["doc_name"] == "notes.txt" and body["pages"] == 1 and body["chunks"] > 0

    listed = client.get("/docs", headers=H).json()
    assert listed["docs"] == [{"doc_name": "notes.txt", "chunks": body["chunks"]}]

    upload(client)
    again = client.get("/docs", headers=H).json()
    assert len(again["docs"]) == 1
    assert again["total_chunks"] == body["chunks"]


def test_unsupported_extension_400(client):
    r = upload(client, name="notes.docx")
    assert r.status_code == 400
    assert r.json()["detail"] == "Unsupported file type. Use PDF, TXT or MD."


def test_empty_text_422(client):
    r = upload(client, body=b"   \n\n  ")
    assert r.status_code == 422
    assert "No text found" in r.json()["detail"]


def test_upload_too_large_413(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_MB", 0)
    assert upload(client).status_code == 413


def test_delete_all_and_one(client):
    upload(client)
    upload(client, name="other.md")
    r = client.delete("/docs/other.md", headers=H)
    assert r.status_code == 200
    assert client.delete("/docs/other.md", headers=H).status_code == 404
    assert client.delete("/docs", headers=H).json() == {"cleared": True}
    assert client.get("/docs", headers=H).json() == {"docs": [], "total_chunks": 0}


def test_stt_with_mocked_transcribe(client, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")

    async def fake_transcribe(filename, data):
        assert filename == "q.m4a"
        return "what is photosynthesis"

    monkeypatch.setattr(llm, "transcribe", fake_transcribe)
    r = client.post("/stt", files={"file": ("q.m4a", b"\0" * 4096, "audio/m4a")})
    assert r.status_code == 200
    assert r.json()["text"] == "what is photosynthesis"
    assert isinstance(r.json()["ms"], int)


def test_stt_tiny_file_skips_groq(client, monkeypatch):
    async def boom(*_):
        raise AssertionError("should not be called")

    monkeypatch.setattr(llm, "transcribe", boom)
    r = client.post("/stt", files={"file": ("q.wav", b"\0" * 10, "audio/wav")})
    assert r.status_code == 200 and r.json()["text"] == ""


def test_stt_missing_key_and_groq_error(client, monkeypatch):
    audio = {"file": ("q.mp3", b"\0" * 4096, "audio/mpeg")}
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    r = client.post("/stt", files=audio)
    assert r.status_code == 503 and "GROQ_API_KEY" in r.json()["detail"]

    monkeypatch.setenv("GROQ_API_KEY", "test-key")

    async def fail(*_):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(llm, "transcribe", fail)
    r = client.post("/stt", files=audio)
    assert r.status_code == 502
    assert r.json()["detail"].startswith("Transcription failed:")


def test_stt_rejects_bad_extension(client):
    r = client.post("/stt", files={"file": ("q.txt", b"\0" * 4096, "text/plain")})
    assert r.status_code == 400
