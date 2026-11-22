"""Groq clients: speech-to-text and streamed, citation-backed answers."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

from groq import AsyncGroq

from config import LLM_MAX_TOKENS, LLM_MODEL, LLM_TEMPERATURE, STT_MODEL
from rag import Chunk

SYSTEM_PROMPT = (
    "You are a voice study assistant. Answer ONLY using the numbered context from the user's notes. "
    "Cite sources inline like [1] or [2] right after the fact they support. "
    "Your answer will be read aloud: 2 to 5 short sentences, plain spoken English, "
    "no markdown, no bullet points, no headings, no code blocks. "
    "If the context does not contain the answer, say exactly: "
    "'I couldn't find that in your notes.' Do not use outside knowledge."
)

_client: AsyncGroq | None = None


def groq_configured() -> bool:
    return bool(os.getenv("GROQ_API_KEY"))


def get_client() -> AsyncGroq:
    """Create one AsyncGroq client lazily and reuse it."""
    global _client
    if _client is None:
        _client = AsyncGroq(api_key=os.getenv("GROQ_API_KEY"))
    return _client


async def transcribe(filename: str, data: bytes) -> str:
    result = await get_client().audio.transcriptions.create(
        file=(filename, data),
        model=STT_MODEL,
        response_format="json",
        language="en",
    )
    return (result.text or "").strip()


def build_messages(question: str, sources: list[tuple[Chunk, float]]) -> list[dict[str, str]]:
    context = "\n".join(
        f"[{n}] ({chunk.doc_name}, p.{chunk.page}) {chunk.text}"
        for n, (chunk, _score) in enumerate(sources, start=1)
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"},
    ]


async def stream_answer(question: str, sources: list[tuple[Chunk, float]]) -> AsyncIterator[str]:
    """Yield text deltas. Closes the HTTP stream if the consumer is cancelled."""
    stream = await get_client().chat.completions.create(
        model=LLM_MODEL,
        messages=build_messages(question, sources),
        stream=True,
        max_tokens=LLM_MAX_TOKENS,
        temperature=LLM_TEMPERATURE,
    )
    try:
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
    finally:
        await stream.close()
