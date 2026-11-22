"""Section 3: generation + citation quality over the real /ask WebSocket."""

from __future__ import annotations

from common import NOT_FOUND, Answer, Ctx, analyze, ask, cited_sources, connect, new_device, normalize_quotes, recv, send, upload_all
from config import MAX_QUESTION_CHARS, NO_DOCS_MESSAGE
from questions import GENERATION_INDEXES, QUESTIONS

METRIC_KEYS = {"retrieval_ms", "ttft_ms", "total_ms", "tokens"}
MIN_SENTENCES, MAX_SENTENCES = 2, 5


def order_ok(answer: Answer) -> bool:
    types = answer.types
    return (
        len(types) >= 3 and types[0] == "sources" and types[-1] == "done"
        and all(t == "token" for t in types[1:-1]) and set(answer.metrics) == METRIC_KEYS
    )


def check_answer(ctx: Ctx, label: str, answer: Answer) -> None:
    r = ctx.report
    a = analyze(answer, ctx.local_chunks)
    r.info(f"{label} A: {answer.text}")
    r.check(f"{label} event order sources->token..->done + metrics", order_ok(answer), f"types={answer.types[:3]}..{answer.types[-1:]}")
    r.check(f"{label} citations in range 1..{len(answer.sources)}", a.citations and not a.out_of_range,
            f"cites={sorted(set(a.citations))} bad={a.out_of_range}")
    r.check(f"{label} cited sentences grounded in their source", not a.ungrounded, "; ".join(a.ungrounded)[:200])
    r.check(f"{label} spoken style: no markdown, {MIN_SENTENCES}-{MAX_SENTENCES} sentences",
            not a.markdown and MIN_SENTENCES <= len(a.sentences) <= MAX_SENTENCES,
            f"sentences={len(a.sentences)} markdown={a.markdown}")
    r.check(f"{label} no reasoning / <think> leak", not a.think_leak)
    if a.uncited:
        r.note(f"{label} uncited sentence(s): {a.uncited}")


async def edge_cases(ctx: Ctx, ws, dev: str) -> None:
    r = ctx.report
    answer = await ask(ws, "Who won the 2022 World Cup?")
    text = normalize_quotes(answer.text)
    r.info(f"out-of-scope A: {answer.text}  (sources={len(answer.sources)})")
    r.check("out-of-scope -> \"I couldn't find that in your notes.\"",
            NOT_FOUND in text and "argentina" not in text and "messi" not in text and answer.types[-1] == "done")

    # Out of scope but shares a word with the notes ("pizza" is in the OSI mnemonic), so the LLM IS called.
    tricky = await ask(ws, "What is the best pizza topping?")
    tricky_text = normalize_quotes(tricky.text)
    r.info(f"out-of-scope (LLM path) A: {tricky.text}  (sources={len(tricky.sources)})")
    r.check("out-of-scope with retrieved sources -> still \"I couldn't find that\"",
            NOT_FOUND in tricky_text and len(tricky.sources) > 0, f"sources={len(tricky.sources)}")

    async with connect(ctx, new_device("nodocs")) as empty_ws:
        nodocs = await ask(empty_ws, "What is round robin?")
    r.check("no docs -> sources [] + upload-first message, no LLM",
            nodocs.types == ["sources", "token", "done"] and nodocs.sources == [] and nodocs.text == NO_DOCS_MESSAGE
            and nodocs.metrics.get("tokens") == 1, f"text={nodocs.text!r}")

    empty = await ask(ws, "   ")
    r.check("empty question -> error", empty.terminal.get("type") == "error", str(empty.terminal))
    too_long = await ask(ws, "x" * (MAX_QUESTION_CHARS * 2))
    r.check("2000-char question -> error", too_long.terminal.get("type") == "error", str(too_long.terminal))
    await send(ws, {"type": "ping"})
    pong = await recv(ws)
    follow = await ask(ws, QUESTIONS[0].text)
    r.check("socket usable after errors (pong + answer)", pong == {"type": "pong"} and follow.types[-1] == "done")

    both = await ask(ws, "Compare round robin and photosynthesis light reactions")
    r.info(f"compare A: {both.text}")
    retrieved = {s["doc_name"] for s in both.sources}
    cited = {s["doc_name"] for s in cited_sources(both)}
    r.check("two-topic question retrieves both docs", {"notes_os.pdf", "notes_bio.txt"} <= retrieved, f"retrieved={retrieved}")
    r.check("two-topic question cites both docs", {"notes_os.pdf", "notes_bio.txt"} <= cited, f"cited={cited}")


async def run(ctx: Ctx) -> None:
    dev = new_device("gen")
    await upload_all(ctx.client, dev)
    async with connect(ctx, dev) as ws:
        for i in GENERATION_INDEXES:
            q = QUESTIONS[i]
            answer = await ask(ws, q.text)
            label = f"Q{i + 1}"
            ctx.report.info(f"{label} Q: {q.text}")
            check_answer(ctx, label, answer)
            right_source = any(s["doc_name"] == q.doc and s["page"] == q.page for s in cited_sources(answer))
            ctx.report.check(f"{label} cites expected {q.doc} p.{q.page}", right_source)
        await edge_cases(ctx, ws, dev)
