"""Section 1: ingestion over HTTP."""

from __future__ import annotations

from common import FIXTURES, Ctx, ask, connect, list_docs, new_device, rag, upload
from config import CHUNK_OVERLAP, MAX_UPLOAD_MB

OS_PAGE_FACTS = {1: "average waiting time of 17 ms", 2: "default time quantum in our lab is 4 ms", 3: "every 30 seconds"}


def _page_fidelity(ctx: Ctx) -> None:
    r = ctx.report
    pages = dict(rag.extract_pages("notes_os.pdf", (FIXTURES / "notes_os.pdf").read_bytes()))
    chunks = ctx.local_chunks["notes_os.pdf"]
    misplaced = [c.id for c in chunks if c.text not in pages.get(c.page, "")]
    r.check("every notes_os.pdf chunk's page matches its source page", not misplaced, f"misplaced={misplaced}")
    wrong = {}
    for page, fact in OS_PAGE_FACTS.items():
        found = sorted({c.page for c in chunks if fact in c.text.lower()})
        if found != [page]:
            wrong[page] = found
    r.check("page-specific facts land on the right page (1/2/3)", not wrong, f"wrong={wrong}")


def _overlap(ctx: Ctx) -> None:
    chunks = ctx.local_chunks["long_notes.txt"]
    pairs = list(zip(chunks, chunks[1:]))
    shared = [a.text.split()[-CHUNK_OVERLAP:] == b.text.split()[:CHUNK_OVERLAP] for a, b in pairs]
    ctx.report.check(
        f"long_notes consecutive chunks share {CHUNK_OVERLAP} words", pairs and all(shared),
        f"{sum(shared)}/{len(pairs)} pairs overlap",
    )


async def run(ctx: Ctx) -> None:
    r, c = ctx.report, ctx.client
    dev = new_device("ingest")
    expected = {name: len(chunks) for name, chunks in ctx.local_chunks.items()}

    res = await upload(c, dev, "notes_os.pdf")
    body = res.json() if res.status_code == 200 else {}
    r.check("upload notes_os.pdf -> 200", res.status_code == 200, res.text[:120])
    r.check("notes_os.pdf pages == 3", body.get("pages") == 3, f"pages={body.get('pages')}")
    r.check("notes_os.pdf chunks >= 3", body.get("chunks", 0) >= 3, f"chunks={body.get('chunks')}")
    _page_fidelity(ctx)

    for name in ("notes_bio.txt", "long_notes.txt"):
        res = await upload(c, dev, name)
        r.check(f"upload {name} -> 200", res.status_code == 200, res.text[:120])
    listing = await list_docs(c, dev)
    got = {d["doc_name"]: d["chunks"] for d in listing["docs"]}
    r.check("GET /docs lists all 3 with correct chunk counts", got == expected, f"got={got} expected={expected}")
    r.check("long_notes.txt has multiple chunks", got.get("long_notes.txt", 0) > 1, f"chunks={got.get('long_notes.txt')}")
    _overlap(ctx)

    total_before = listing["total_chunks"]
    await upload(c, dev, "notes_os.pdf")
    after = await list_docs(c, dev)
    r.check("re-upload notes_os.pdf: no duplicates, total unchanged",
            after["total_chunks"] == total_before and len(after["docs"]) == 3,
            f"before={total_before} after={after['total_chunks']}")

    res = await upload(c, dev, "scanned.pdf")
    r.check("scanned.pdf -> 422", res.status_code == 422, f"{res.status_code} {res.text[:80]}")
    res = await upload(c, dev, "notes.docx", b"PK\x03\x04 fake docx")
    r.check(".docx -> 400", res.status_code == 400, f"{res.status_code} {res.text[:80]}")
    res = await upload(c, dev, "huge.txt", b"a " * ((MAX_UPLOAD_MB * 1024 * 1024) // 2 + 1024))
    r.check(f"> {MAX_UPLOAD_MB} MB -> 413", res.status_code == 413, f"{res.status_code}")
    res = await upload(c, None, "notes_bio.txt")
    r.check("missing X-Device-Id -> 400", res.status_code == 400, f"{res.status_code}")

    res = await c.delete("/docs/notes_os.pdf", headers={"X-Device-Id": dev})
    remaining = {d["doc_name"] for d in (await list_docs(c, dev))["docs"]}
    r.check("DELETE /docs/notes_os.pdf removes only that doc",
            res.status_code == 200 and remaining == {"notes_bio.txt", "long_notes.txt"}, f"remaining={remaining}")
    async with connect(ctx, dev) as ws:
        answer = await ask(ws, "What is the default time quantum in round robin?")
    leaked = [s for s in answer.sources if s["doc_name"] == "notes_os.pdf"]
    r.check("deleted doc no longer retrieved", not leaked, f"sources={[s['doc_name'] for s in answer.sources]}")

    res = await c.delete("/docs", headers={"X-Device-Id": dev})
    r.check("DELETE /docs clears everything",
            res.status_code == 200 and (await list_docs(c, dev)) == {"docs": [], "total_chunks": 0})
