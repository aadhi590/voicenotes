"""Section 4: barge-in, back-to-back, parallel sockets, abrupt disconnect."""

from __future__ import annotations

import asyncio
import time
import uuid

from common import (
    DOC_FILES, MAX_RATE_LIMIT_RETRIES, Answer, Ctx, ask, backoff, collect, connect, is_rate_limited, new_device, recv,
    send, start_streaming, upload_all,
)
from questions import LONG_ANSWER_QUESTION, QUESTIONS

CANCEL_BUDGET_MS = 300
DRAIN_S = 0.5


async def measure_rtt_ms(ws) -> float:
    started = time.perf_counter()
    await send(ws, {"type": "ping"})
    while await recv(ws) != {"type": "pong"}:
        pass
    return (time.perf_counter() - started) * 1000


async def _stream_then_cancel(ws, n_tokens: int) -> tuple[Answer, float]:
    """Ask, wait for `sources` + n tokens, send cancel. Returns (answer, ms from cancel to terminal)."""
    for _ in range(MAX_RATE_LIMIT_RETRIES):
        answer = Answer(qid=uuid.uuid4().hex[:8], question=LONG_ANSWER_QUESTION)
        await send(ws, {"type": "ask", "id": answer.qid, "question": answer.question})
        tokens, seen_sources, finished, limited = 0, False, False, False
        while True:
            msg = await recv(ws)
            answer.events.append((time.perf_counter(), msg))
            if msg.get("id") != answer.qid:
                continue
            if is_rate_limited(msg):
                limited = True
                break
            if msg["type"] == "sources":
                seen_sources = True
            elif msg["type"] == "token":
                tokens += 1
            elif msg["type"] in ("done", "error", "cancelled"):
                finished = True
                break
            if seen_sources and tokens >= n_tokens:
                break
        if limited:
            await backoff(answer.question)
            continue
        sent_at = time.perf_counter()
        if not finished:
            await send(ws, {"type": "cancel", "id": answer.qid})
            await collect(ws, answer)
        return answer, (answer.events[-1][0] - sent_at) * 1000
    return answer, float("inf")


async def cancel_after_tokens(ctx: Ctx, ws, n_tokens: int = 3) -> None:
    """Over a real network the whole answer can finish before the cancel arrives (Groq streams
    ~250 tokens in a few hundred ms). The server then correctly ignores the cancel, which proves
    nothing, so retry with an earlier cancel point. The budget allows for the network round trip."""
    r = ctx.report
    rtt = await measure_rtt_ms(ws)
    budget = CANCEL_BUDGET_MS + rtt
    for cancel_at in (n_tokens, 1, 0):
        answer, latency_ms = await _stream_then_cancel(ws, cancel_at)
        if answer.terminal.get("type") == "cancelled":
            break
        r.note(f"answer finished before the cancel arrived (cancel after {cancel_at} tokens, rtt {rtt:.0f} ms); "
               "retrying with an earlier cancel")
    r.check(f"cancel mid-stream -> 'cancelled' within {CANCEL_BUDGET_MS} ms + RTT",
            answer.terminal.get("type") == "cancelled" and latency_ms < budget,
            f"cancel after {cancel_at} tokens, terminal={answer.terminal.get('type')}, "
            f"latency={latency_ms:.0f} ms, rtt={rtt:.0f} ms, budget={budget:.0f} ms")

    # Drain: anything for this id after 'cancelled' is a bug. Ping flushes the pipe.
    await asyncio.sleep(DRAIN_S)
    await send(ws, {"type": "ping"})
    trailing = []
    while (msg := await recv(ws)) != {"type": "pong"}:
        trailing.append(msg)
    late = [m for m in trailing if m.get("id") == answer.qid]
    r.check("no 'done' and no tokens for the cancelled id afterwards", "done" not in answer.types and not late,
            f"late={late[:2]}")


async def ask_while_streaming(ctx: Ctx, ws) -> None:
    r = ctx.report
    a = await start_streaming(ws, LONG_ANSWER_QUESTION, prefix="A-")
    b = Answer(qid="B-" + uuid.uuid4().hex[:6], question=QUESTIONS[2].text)
    await send(ws, {"type": "ask", "id": b.qid, "question": b.question})
    await collect(ws, b)
    stream = [m for _, m in b.events]
    if is_rate_limited(b.terminal):  # A was still cancelled; retry B only for the 'done' check
        b = await ask(ws, b.question)
    b_start = next((i for i, m in enumerate(stream) if m.get("id") == b.qid), len(stream))
    a_after_b = [m for m in stream[b_start:] if m.get("id") == a.qid]
    r.check("ask B while A streams: A gets 'cancelled'", {"type": "cancelled", "id": a.qid} in stream)
    r.check("ask B while A streams: B completes with 'done'", b.types[-1:] == ["done"], f"B types end={b.types[-1:]}")
    r.check("ask B while A streams: no A events after B starts", not a_after_b and "done" not in a.types,
            f"late A={a_after_b[:2]}")


async def back_to_back(ctx: Ctx, ws) -> None:
    results = [await ask(ws, q.text) for q in QUESTIONS[:5]]
    done = sum(1 for a in results if a.types[-1:] == ["done"])
    ctx.report.check("5 questions back-to-back on one socket all complete", done == 5, f"{done}/5 done")


async def parallel_sockets(ctx: Ctx) -> None:
    plan = [("notes_os.pdf", QUESTIONS[0]), ("notes_bio.txt", QUESTIONS[4]), ("long_notes.txt", QUESTIONS[8])]
    devices = [new_device(f"par{i}") for i in range(len(plan))]
    for dev, (doc, _) in zip(devices, plan):
        await upload_all(ctx.client, dev, [doc])

    async def one(dev: str, question: str) -> Answer:
        async with connect(ctx, dev) as ws:
            return await ask(ws, question)

    answers = await asyncio.gather(*(one(dev, q.text) for dev, (_, q) in zip(devices, plan)))
    all_done = all(a.types[-1:] == ["done"] for a in answers)
    foreign = [(doc, s["doc_name"]) for (doc, _), a in zip(plan, answers) for s in a.sources if s["doc_name"] != doc]
    ctx.report.check("3 parallel sockets all complete", all_done, f"terminals={[a.types[-1:] for a in answers]}")
    ctx.report.check("parallel sockets never see another device's sources", not foreign, f"foreign={foreign}")


async def disconnect_mid_stream(ctx: Ctx, dev: str) -> None:
    r = ctx.report
    log_offset = ctx.server_log.stat().st_size if ctx.server_log and ctx.server_log.exists() else None
    ws = await connect(ctx, dev)
    answer = await start_streaming(ws, LONG_ANSWER_QUESTION)
    tokens = answer.types.count("token")
    while tokens < 2:
        if (await recv(ws))["type"] == "token":
            tokens += 1
    ws.transport.abort()  # abrupt drop, no close frame
    await asyncio.sleep(1.5)

    async with connect(ctx, dev) as ws2:
        await send(ws2, {"type": "ping"})
        alive = await recv(ws2) == {"type": "pong"}
        answer = await ask(ws2, QUESTIONS[0].text)
    health = (await ctx.client.get("/health")).status_code
    r.check("after abrupt disconnect: server keeps serving new connections",
            alive and answer.types[-1:] == ["done"] and health == 200)
    if log_offset is None:
        r.note("no --server-log given; traceback check skipped")
        return
    with ctx.server_log.open("rb") as fh:
        fh.seek(log_offset)
        new_log = fh.read().decode("utf-8", errors="ignore")
    r.check("no traceback / ERROR in server log after disconnect",
            "Traceback" not in new_log and " ERROR " not in new_log, new_log[-300:] if "Traceback" in new_log else "")


async def run(ctx: Ctx) -> None:
    dev = new_device("barge")
    await upload_all(ctx.client, dev, DOC_FILES)
    async with connect(ctx, dev) as ws:
        await cancel_after_tokens(ctx, ws)
        await ask_while_streaming(ctx, ws)
        await back_to_back(ctx, ws)
    await parallel_sockets(ctx)
    await disconnect_mid_stream(ctx, dev)
