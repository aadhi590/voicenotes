"""Tunable constants for the VoiceNotes backend."""

LLM_MODEL = "llama-3.3-70b-versatile"  # easy to swap
STT_MODEL = "whisper-large-v3-turbo"

CHUNK_WORDS = 500
CHUNK_OVERLAP = 80
TOP_K = 5
SNIPPET_CHARS = 200

MAX_UPLOAD_MB = 15
MAX_AUDIO_MB = 20
MAX_QUESTION_CHARS = 1000
MIN_AUDIO_BYTES = 1024

LLM_MAX_TOKENS = 400
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
