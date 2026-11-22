"""Tunable constants for the VoiceNotes backend."""

# llama-3.3-70b-versatile was retired on Groq; qwen3.8-27b had the lowest TTFT
# (~180ms) and best citation/voice formatting in a 2026-11-22 comparison.
LLM_MODEL = "qwen/qwen3.8-27b"  # easy to swap
STT_MODEL = "whisper-large-v3-turbo"

CHUNK_WORDS = 500
CHUNK_OVERLAP = 80
TOP_K = 3
SNIPPET_CHARS = 200

MAX_UPLOAD_MB = 15
MAX_AUDIO_MB = 20
MAX_QUESTION_CHARS = 1000

# Memory guards for the in-memory store (public URL, no auth). ~9 KB per chunk incl. index,
# so the global budget caps the store at roughly 450 MB. Over budget, least-recently-used
# devices are evicted.
MAX_DOCS_PER_DEVICE = 20
MAX_CHUNKS_PER_DEVICE = 1000  # ~420k words, ~800 pages
MAX_TOTAL_CHUNKS = 50_000
MIN_AUDIO_BYTES = 1024

LLM_MAX_TOKENS = 250
LLM_TEMPERATURE = 0.2

# BM25Okapi gives negative IDF to terms present in most chunks of a tiny corpus
# (e.g. a single uploaded page). Flooring IDF keeps any term match scoring > 0.
BM25_IDF_FLOOR = 0.01

TEXT_EXTENSIONS = {".txt", ".md"}
DOC_EXTENSIONS = {".pdf"} | TEXT_EXTENSIONS
AUDIO_EXTENSIONS = {".m4a", ".mp4", ".aac", ".wav", ".webm", ".mp3", ".ogg"}

NO_DOCS_MESSAGE = "You haven't uploaded any notes yet. Upload a PDF or text file first."
NOT_FOUND_MESSAGE = "I couldn't find that in your notes."
MISSING_KEY_MESSAGE = "Server is missing GROQ_API_KEY"
RATE_LIMIT_MESSAGE = "The AI service is busy (rate limit reached). Please try again in a few seconds."
