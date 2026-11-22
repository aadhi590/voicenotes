import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import llm
import main
import rag
from config import NO_DOCS_MESSAGE

DEVICE = "dev-ws"
NOTES = b"Photosynthesis uses light energy to make glucose in the chloroplast."


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    rag.STORE.clear()
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    yield
    rag.STORE.clear()


def mock_stream(monkeypatch, tokens, delay):
    async def fake_stream(question, sources):
        for t in tokens:
            await asyncio.sleep(delay)
            yield t

    monkeypatch.setattr(llm, "stream_answer", fake_stream)


@pytest.fixture
def client():
    return TestClient(main.app)


def upload_notes(client):
    r = client.post("/docs", headers={"X-Device-Id": DEVICE}, files={"file": ("bio.txt", NOTES, "text/plain")})
    assert r.status_code == 200


def collect_until(ws, qid, terminal=("done", "cancelled", "error")):
    events = []
    while True:
        msg = ws.receive_json()
        events.append(msg)
        if msg.get("id") == qid and msg["type"] in terminal:
            return events


def ask(ws, qid, question="What does photosynthesis use?"):
    ws.send_json({"type": "ask", "id": qid, "question": question})


def test_ping_pong(client):
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_missing_device_id_closes_4400(client):
    with client.websocket_connect("/ask") as ws:
        assert ws.receive_json()["type"] == "error"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4400


def test_ask_without_docs(client, monkeypatch):
    mock_stream(monkeypatch, ["unused"], 0)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ask(ws, "q1")
        events = collect_until(ws, "q1")
    assert [e["type"] for e in events] == ["sources", "token", "done"]
    assert events[0]["sources"] == []
    assert events[1]["text"] == NO_DOCS_MESSAGE


def test_ask_after_upload_order_and_metrics(client, monkeypatch):
    mock_stream(monkeypatch, ["Photo", "synthesis ", "uses light [1]."], 0.01)
    upload_notes(client)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ask(ws, "q1")
        events = collect_until(ws, "q1")
    types = [e["type"] for e in events]
    assert types == ["sources", "token", "token", "token", "done"]
    src = events[0]["sources"][0]
    assert src["n"] == 1 and src["doc_name"] == "bio.txt" and src["page"] == 1 and src["snippet"]
    assert "".join(e["text"] for e in events if e["type"] == "token") == "Photosynthesis uses light [1]."
    assert set(events[-1]["metrics"]) == {"retrieval_ms", "ttft_ms", "total_ms", "tokens"}
    assert events[-1]["metrics"]["tokens"] == 3


def test_no_matching_notes(client, monkeypatch):
    mock_stream(monkeypatch, ["unused"], 0)
    upload_notes(client)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ask(ws, "q1", "zebra migration patterns")
        events = collect_until(ws, "q1")
    assert [e["type"] for e in events] == ["sources", "token", "done"]
    assert events[1]["text"] == "I couldn't find that in your notes."


def test_cancel_mid_stream(client, monkeypatch):
    mock_stream(monkeypatch, [f"t{i} " for i in range(20)], 0.05)
    upload_notes(client)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ask(ws, "q1")
        assert ws.receive_json()["type"] == "sources"
        assert ws.receive_json()["type"] == "token"
        ws.send_json({"type": "cancel", "id": "q1"})
        events = collect_until(ws, "q1")
        assert events[-1] == {"type": "cancelled", "id": "q1"}

        # cancel for an unknown id is ignored; socket still answers
        ws.send_json({"type": "cancel", "id": "nope"})
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}
    assert not any(e["type"] == "done" for e in events)


def test_new_ask_cancels_previous(client, monkeypatch):
    mock_stream(monkeypatch, [f"t{i} " for i in range(20)], 0.05)
    upload_notes(client)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ask(ws, "q1")
        assert ws.receive_json()["type"] == "sources"
        assert ws.receive_json()["type"] == "token"
        mock_stream(monkeypatch, ["fresh"], 0)
        ask(ws, "q2")
        events = collect_until(ws, "q2")
    q1_events = [e for e in events if e.get("id") == "q1"]
    assert {"type": "cancelled", "id": "q1"} in q1_events
    assert not any(e["type"] == "done" for e in q1_events)
    q2_types = [e["type"] for e in events if e.get("id") == "q2"]
    assert q2_types == ["sources", "token", "done"]
    # nothing from q1 arrives after it was cancelled
    cancelled_at = events.index({"type": "cancelled", "id": "q1"})
    assert all(e.get("id") != "q1" for e in events[cancelled_at + 1:])


def test_invalid_json_then_ask_works(client, monkeypatch):
    mock_stream(monkeypatch, ["ok [1]"], 0)
    upload_notes(client)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ws.send_text("{not json")
        err = ws.receive_json()
        assert err["type"] == "error" and err["id"] is None
        ws.send_json({"type": "bogus"})
        assert ws.receive_json()["type"] == "error"
        ask(ws, "q1")
        events = collect_until(ws, "q1")
    assert events[-1]["type"] == "done"


def test_validation_and_llm_errors_keep_socket(client, monkeypatch):
    async def broken(question, sources):
        raise RuntimeError("groq exploded")
        yield  # pragma: no cover

    monkeypatch.setattr(llm, "stream_answer", broken)
    upload_notes(client)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ask(ws, "q0", "   ")
        assert ws.receive_json() == {"type": "error", "id": "q0", "message": "Question is empty."}
        ask(ws, "q1")
        events = collect_until(ws, "q1")
        assert events[-1]["type"] == "error"
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_missing_key_sends_error(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY")
    upload_notes(client)
    with client.websocket_connect(f"/ask?device_id={DEVICE}") as ws:
        ask(ws, "q1")
        events = collect_until(ws, "q1")
    assert events[-1] == {"type": "error", "id": "q1", "message": "Server is missing GROQ_API_KEY"}
