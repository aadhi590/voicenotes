"""Section 5 (voice loop STT -> RAG -> stream) and section 6 (latency report)."""

from __future__ import annotations

import re

from common import DOC_FILES, FIXTURES, Ctx, ask, cited_sources, connect, new_device, percentile, upload_all
from questions import QUESTIONS

FOUR_MS_RE = re.compile(r"\b(4|four)[\s-]*(ms|milliseconds?)\b", re.IGNORECASE)
SILENCE_MAX_WORDS = 3
TINY_MAX_MS = 100
STT_RUNS = 5
WARM_QUESTIONS = 10
RETRIEVAL_TARGET_MS = 50
TTFT_P50_TARGET_MS = 600


async def stt(ctx: Ctx, name: str) -> tuple[int, dict]:
    res = await ctx.client.post("/stt", files={"file": (name, (FIXTURES / name).read_bytes(), "audio/wav")})
    return res.status_code, (res.json() if res.headers.get("content-type", "").startswith("application/json") else {})


def words(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


async def run_voice(ctx: Ctx) -> None:
    r = ctx.report
    status, body = await stt(ctx, "question.wav")
    transcript = body.get("text", "")
    norm = words(transcript)
    r.info(f"transcript: {transcript!r}  stt_ms={body.get('ms')}")
    r.check("question.wav -> transcript has 'time quantum' and 'round robin'",
            status == 200 and "time quantum" in norm and "round robin" in norm, f"status={status}")

    dev = new_device("voice")
    await upload_all(ctx.client, dev, DOC_FILES)
    async with connect(ctx, dev) as ws:
        answer = await ask(ws, transcript or QUESTIONS[0].text)
    r.info(f"voice A: {answer.text}")
    page2 = [s for s in cited_sources(answer) if s["doc_name"] == "notes_os.pdf" and s["page"] == 2]
    r.check("voice answer mentions 4 ms", bool(FOUR_MS_RE.search(answer.text)))
    r.check("voice answer cites notes_os.pdf page 2", bool(page2))

    status, body = await stt(ctx, "silence.wav")
    text = body.get("text", "")
    r.check(f"silence.wav -> 200 with <= {SILENCE_MAX_WORDS} words", status == 200 and len(text.split()) <= SILENCE_MAX_WORDS,
            f"status={status} text={text!r}")
    status, body = await stt(ctx, "tiny.wav")
    r.check("tiny (<1 KB) -> {text: ''} without Groq call",
            status == 200 and body.get("text") == "" and body.get("ms", 999) < TINY_MAX_MS, f"body={body}")


async def run_latency(ctx: Ctx) -> None:
    r = ctx.report
    stt_ms = []
    for _ in range(STT_RUNS):
        status, body = await stt(ctx, "question.wav")
        if status == 200:
            stt_ms.append(body["ms"])

    dev = new_device("latency")
    await upload_all(ctx.client, dev, DOC_FILES)
    metrics = []
    async with connect(ctx, dev) as ws:
        await ask(ws, QUESTIONS[0].text)  # warm-up (TLS + connection pool to Groq)
        for i in range(WARM_QUESTIONS):
            answer = await ask(ws, QUESTIONS[i % len(QUESTIONS)].text)
            if answer.metrics:
                metrics.append(answer.metrics)

    series = {"stt_ms": stt_ms}
    for key in ("retrieval_ms", "ttft_ms", "total_ms"):
        series[key] = [m[key] for m in metrics if m.get(key) is not None]
    r.info(f"{'metric':<13}{'n':>3}{'p50':>8}{'p95':>8}")
    for key, values in series.items():
        if values:
            r.info(f"{key:<13}{len(values):>3}{percentile(values, 50):>8.0f}{percentile(values, 95):>8.0f}")
    r.check("all warm questions completed", len(metrics) == WARM_QUESTIONS, f"{len(metrics)}/{WARM_QUESTIONS}")
    retrieval = series["retrieval_ms"] or [9999]
    ttft = series["ttft_ms"] or [9999]
    r.check(f"retrieval_ms p95 < {RETRIEVAL_TARGET_MS}", percentile(retrieval, 95) < RETRIEVAL_TARGET_MS,
            f"p95={percentile(retrieval, 95)}")
    r.check(f"warm ttft_ms p50 < {TTFT_P50_TARGET_MS}", percentile(ttft, 50) < TTFT_P50_TARGET_MS,
            f"p50={percentile(ttft, 50)}")
