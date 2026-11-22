"""End-to-end verification of the VoiceNotes RAG pipeline against a running server.

Usage (from app1/backend):
    python scripts/e2e/run_all.py [--base http://localhost:8000] [--server-log path/to/uvicorn.log] [--only 1,3]
    python scripts/e2e/run_all.py --base https://<domain> --quick   # < 1 min smoke test (~2 LLM calls)

Needs the server to have a real GROQ_API_KEY. Exit code 0 only if every check passes.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import traceback
from pathlib import Path

import httpx

import checks_bargein
import checks_generation
import checks_ingest
import checks_quick
import checks_retrieval
import checks_voice
from common import RATE_LIMIT_HITS, Ctx, Report, build_local_chunks
from make_fixtures import ensure_fixtures

SECTIONS = [
    ("1", "Ingestion", checks_ingest.run),
    ("2", "Retrieval quality", checks_retrieval.run),
    ("3", "Generation + citations", checks_generation.run),
    ("4", "Barge-in / concurrency", checks_bargein.run),
    ("5", "Voice loop", checks_voice.run_voice),
    ("6", "Latency", checks_voice.run_latency),
]
QUICK_SECTIONS = [("Q", "Quick smoke test", checks_quick.run)]


def print_summary(report: Report, sections: list) -> bool:
    print("\n" + "=" * 100)
    print(f"{'section':<28}{'passed/total':>13}   issues")
    print("-" * 100)
    all_ok = True
    for num, title, _ in sections:
        name = f"{num} {title}"
        rows = [row for row in report.results if row[0] == name]
        if not rows:
            continue
        passed = sum(1 for row in rows if row[2])
        failed = [row[1] for row in rows if not row[2]]
        notes = report.notes.get(name, [])
        all_ok &= not failed
        issues = "; ".join(failed + [f"note: {n}" for n in notes]) or "none"
        print(f"{name:<28}{f'{passed}/{len(rows)}':>13}   {issues[:200]}")
    total = len(report.results)
    passed = sum(1 for row in report.results if row[2])
    print("-" * 100)
    print(f"{'TOTAL':<28}{f'{passed}/{total}':>13}   {'ALL PASS' if all_ok else 'FAILURES'}")
    return all_ok


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--server-log", type=Path, default=None, help="uvicorn log file (enables traceback check)")
    parser.add_argument("--quick", action="store_true", help="smoke test only: health, upload, 2 asks, cancel, STT")
    parser.add_argument("--only", default="", help="comma-separated section numbers, e.g. 1,3")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    def quiet_resets(loop, context):  # Windows proactor noise from our own deliberate transport.abort()
        if not isinstance(context.get("exception"), ConnectionResetError):
            loop.default_exception_handler(context)

    asyncio.get_running_loop().set_exception_handler(quiet_resets)

    ensure_fixtures()
    base = args.base.rstrip("/")
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    report = Report()
    async with httpx.AsyncClient(base_url=base, timeout=120) as client:
        health = (await client.get("/health")).json()
        print(f"server {base}: {health}")
        if not health.get("groq_configured"):
            print("WARNING: server has no GROQ_API_KEY; generation checks will fail")
        ctx = Ctx(base=base, client=client, report=report, server_log=args.server_log, local_chunks=build_local_chunks())
        sections = QUICK_SECTIONS if args.quick else SECTIONS
        for num, title, fn in sections:
            if only and not args.quick and num not in only:
                continue
            report.section = f"{num} {title}"
            print(f"\n== {report.section} ==", flush=True)
            hits_before = len(RATE_LIMIT_HITS)
            try:
                result = fn(ctx)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:  # a crash is a failed check, keep going
                report.check("section ran without crashing", False, f"{type(exc).__name__}: {exc}")
                traceback.print_exc()
            if len(RATE_LIMIT_HITS) > hits_before:
                report.note(f"{len(RATE_LIMIT_HITS) - hits_before} Groq rate-limit backoffs (TPM quota)")
    return 0 if print_summary(report, sections) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
