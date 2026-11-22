import llm
from rag import Chunk


def test_client_does_not_silently_retry(monkeypatch):
    # Regression: SDK retries on 429 caused 30-60 s of dead air before the first token.
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setattr(llm, "_client", None)
    assert llm.get_client().max_retries == 0
    assert llm.get_client() is llm.get_client()


def test_prompt_requires_multi_sentence_and_multi_topic_answers():
    # Regression: one-fact questions got 1-sentence answers; "compare X and Y" was refused
    # even though both topics were retrieved.
    prompt = llm.SYSTEM_PROMPT
    assert "always 2 to 5 short sentences" in prompt
    assert "several topics" in prompt and "do not refuse" in prompt
    assert "'I couldn't find that in your notes.'" in prompt


def test_build_messages_numbers_sources_with_page():
    sources = [(Chunk("a:2:0", "a.pdf", 2, "alpha"), 1.0), (Chunk("b:1:0", "b.txt", 1, "beta"), 0.5)]
    user = llm.build_messages("Q?", sources)[1]["content"]
    assert "[1] (a.pdf, p.2) alpha" in user and "[2] (b.txt, p.1) beta" in user
    assert user.endswith("Question: Q?")
