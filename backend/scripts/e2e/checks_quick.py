"""--quick smoke test: health, 1 upload, 2 WS questions, 1 cancel, 1 STT. ~2 LLM calls, < 1 minute."""

from __future__ import annotations

from checks_bargein import cancel_after_tokens
from checks_voice import stt, words
from common import NOT_FOUND, Ctx, analyze, ask, cited_sources, connect, list_docs, new_device, normalize_quotes, upload
from questions import QUESTIONS


async def run(ctx: Ctx) -> None:
    r, c = ctx.report, ctx.client
    health = (await c.get("/health")).json()
    r.check("GET /health -> ok + groq_configured", health == {"status": "ok", "groq_configured": True}, str(health))

    dev = new_device("quick")
    res = await upload(c, dev, "notes_os.pdf")
    body = res.json() if res.status_code == 200 else {}
    r.check("upload notes_os.pdf -> 3 pages", res.status_code == 200 and body.get("pages") == 3, res.text[:120])
    listed = await list_docs(c, dev)
    r.check("GET /docs lists it", [d["doc_name"] for d in listed["docs"]] == ["notes_os.pdf"])

    async with connect(ctx, dev) as ws:  # proves the ws/wss upgrade works (through Railway's proxy when remote)
        answer = await ask(ws, QUESTIONS[0].text)
        r.info(f"in-scope A: {answer.text}  metrics={answer.metrics}")
        a = analyze(answer, ctx.local_chunks)
        r.check("WS in-scope: sources -> tokens -> done", answer.types[:1] == ["sources"] and answer.types[-1:] == ["done"],
                f"terminal={answer.terminal}")
        r.check("WS in-scope: cites notes_os.pdf p.2, no out-of-range [n]",
                any(s["page"] == 2 for s in cited_sources(answer)) and a.citations and not a.out_of_range)

        oos = await ask(ws, "Who won the 2022 World Cup?")
        r.check("WS out-of-scope -> \"I couldn't find that in your notes.\"",
                NOT_FOUND in normalize_quotes(oos.text) and oos.types[-1:] == ["done"], oos.text)

        await cancel_after_tokens(ctx, ws)

    status, stt_body = await stt(ctx, "question.wav")
    norm = words(stt_body.get("text", ""))
    r.check("POST /stt question.wav -> 'time quantum' + 'round robin'",
            status == 200 and "time quantum" in norm and "round robin" in norm,
            f"status={status} text={stt_body.get('text')!r} ms={stt_body.get('ms')}")
