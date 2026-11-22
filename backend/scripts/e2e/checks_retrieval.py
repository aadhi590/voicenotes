"""Section 2: retrieval quality, run in-process with the server's own rag module on the same fixtures."""

from __future__ import annotations

from common import FIXTURES, DOC_FILES, Ctx, rag
from config import TOP_K
from questions import QUESTIONS, Question

EVAL_DEVICE = "local-retrieval-eval"
TOP1_TARGET = 8
TOPK_TARGET = 11


def load_fixtures(device: str = EVAL_DEVICE) -> None:
    rag.clear_device(device)
    for name in DOC_FILES:
        pages = rag.extract_pages(name, (FIXTURES / name).read_bytes())
        rag.add_document(device, name, rag.chunk_pages(name, pages))


def rank_of(question: Question, device: str = EVAL_DEVICE) -> tuple[int | None, float | None, str]:
    results = rag.retrieve(device, question.text)
    for i, (chunk, score) in enumerate(results, start=1):
        if chunk.doc_name == question.doc and chunk.page == question.page and question.fact in chunk.text.lower():
            return i, score, chunk.id
    top = results[0][0].id if results else "-"
    return None, None, f"top={top}"


def evaluate(device: str = EVAL_DEVICE) -> list[tuple[Question, int | None, float | None, str]]:
    load_fixtures(device)
    rows = [(q, *rank_of(q, device)) for q in QUESTIONS]
    rag.clear_device(device)
    return rows


def run(ctx: Ctx) -> None:
    r = ctx.report
    rows = evaluate()
    r.info(f"{'#':>2} {'rank':>4} {'score':>6}  {'para':4}  question -> chunk")
    for i, (q, rank, score, chunk_id) in enumerate(rows, start=1):
        rank_s = str(rank) if rank else "MISS"
        score_s = f"{score:.2f}" if score is not None else "-"
        r.info(f"{i:>2} {rank_s:>4} {score_s:>6}  {'yes' if q.paraphrase else '':4}  {q.text} -> {chunk_id}")
    top1 = sum(1 for _, rank, _, _ in rows if rank == 1)
    topk = sum(1 for _, rank, _, _ in rows if rank)
    r.check(f"correct chunk ranked #1 for >= {TOP1_TARGET}/12", top1 >= TOP1_TARGET, f"{top1}/12")
    r.check(f"correct chunk in top {TOP_K} for >= {TOPK_TARGET}/12", topk >= TOPK_TARGET, f"{topk}/12")
