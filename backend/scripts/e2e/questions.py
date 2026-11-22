"""Evaluation questions with the expected doc, page and a fact that identifies the correct chunk."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Question:
    text: str
    doc: str
    page: int
    fact: str  # lowercase substring that must be in the correct chunk
    paraphrase: bool = False


QUESTIONS: list[Question] = [
    # OS scheduling (notes_os.pdf)
    Question("What is the default time quantum in round robin?", "notes_os.pdf", 2, "default time quantum in our lab is 4 ms"),
    Question("how long does each process get the CPU in RR", "notes_os.pdf", 2, "default time quantum in our lab is 4 ms", True),
    Question("What are the four Coffman conditions for deadlock?", "notes_os.pdf", 3, "mutual exclusion"),
    Question("Which scheduler gives the lowest average wait?", "notes_os.pdf", 1, "minimum average waiting time", True),
    # Photosynthesis (notes_bio.txt)
    Question("At which wavelengths does chlorophyll absorb light best?", "notes_bio.txt", 1, "430 nm"),
    Question("How much ATP and NADPH does the Calvin cycle need to make one glucose?", "notes_bio.txt", 1, "18 atp"),
    Question("Which color of light made the basil give off the most oxygen?", "notes_bio.txt", 1, "23 percent more oxygen", True),
    Question("What opens and closes the little holes on a leaf?", "notes_bio.txt", 1, "guard cells", True),
    # Networks (long_notes.txt, multi-chunk)
    Question("What are the steps of the TCP three-way handshake?", "long_notes.txt", 1, "the client sends syn"),
    Question("What is the IP address of the campus DNS resolver?", "long_notes.txt", 1, "10.20.0.53"),
    Question("What's the largest frame size allowed on the lab ethernet?", "long_notes.txt", 1, "mtu of 1500 bytes", True),
    Question("How many layers are in the OSI reference model?", "long_notes.txt", 1, "seven layers"),
]

GENERATION_INDEXES = [0, 1, 2, 4, 5, 7, 8, 9]  # 8 questions for section 3

LONG_ANSWER_QUESTION = (
    "Explain round robin scheduling in detail: the time quantum, what happens when it is too large or too small, "
    "context switch cost, and how it compares with SJF and FCFS."
)
