"""Generate e2e fixtures (PDFs, text notes, audio). Safe to re-run; skips existing files unless --force."""

from __future__ import annotations

import argparse
import subprocess
import sys
import wave
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"

OS_PAGES: list[tuple[str, list[str]]] = [
    ("Page 1 - CPU Scheduling: FCFS and SJF", [
        "CPU scheduling decides which process in the ready queue gets the processor next. The main goals are "
        "high CPU utilization, high throughput, low turnaround time, low waiting time and low response time.",
        "First-Come, First-Served (FCFS) is the simplest algorithm: processes run in the order they arrive and "
        "each one runs until it finishes or blocks. FCFS is non-preemptive and easy to implement with a FIFO queue. "
        "Its big weakness is the convoy effect, where short processes wait behind one long CPU-bound process. "
        "In our lab trace with bursts of 24, 3 and 3 ms, FCFS gave an average waiting time of 17 ms.",
        "Shortest Job First (SJF) always picks the process with the smallest next CPU burst. SJF is provably "
        "optimal: it gives the minimum average waiting time for a given set of processes. On the same lab trace "
        "SJF cut the average waiting time to 3 ms. The preemptive version is called Shortest Remaining Time First (SRTF).",
        "The catch is that the length of the next burst is unknown, so it is predicted with exponential averaging; "
        "our lab uses a smoothing factor alpha of 0.5. SJF can starve long processes, and the standard fix is aging, "
        "which slowly raises the priority of processes that have waited a long time.",
    ]),
    ("Page 2 - Round Robin (RR) Scheduling", [
        "Round Robin (RR) is designed for time-sharing systems. Every process gets the CPU for one fixed time slice, "
        "called the time quantum, and then goes to the back of the ready queue. RR is preemptive, and a timer "
        "interrupt fires when the quantum expires.",
        "The default time quantum in our lab is 4 ms. With n processes in the ready queue and quantum q, no process "
        "waits more than (n - 1) x q time units before its next turn, which gives RR good response time for "
        "interactive users.",
        "Choosing the quantum is a trade-off. If the quantum is very large, RR behaves exactly like FCFS. If it is "
        "very small, the CPU spends most of its time on context switches instead of useful work. A context switch "
        "on our lab machines costs about 0.1 ms. A common rule of thumb is that 80 percent of CPU bursts should be "
        "shorter than the time quantum.",
        "RR usually has a higher average turnaround time than SJF but much better response time. Many real "
        "operating systems combine RR with priorities in a multilevel feedback queue.",
    ]),
    ("Page 3 - Deadlocks and the Coffman Conditions", [
        "A deadlock happens when a set of processes are all blocked, each waiting for a resource held by another "
        "process in the set, so none of them can ever continue.",
        "Coffman identified four conditions that must all hold at the same time for a deadlock: mutual exclusion, "
        "hold and wait, no preemption, and circular wait. Breaking any one of the four Coffman conditions prevents deadlock.",
        "Deadlock avoidance uses the Banker's algorithm, proposed by Edsger Dijkstra, which only grants a request "
        "if the system stays in a safe state. In a resource allocation graph with single-instance resources, a "
        "cycle means a deadlock exists.",
        "For detection and recovery, our lab's deadlock detector runs every 30 seconds. Recovery options are "
        "terminating one or more processes or preempting resources and rolling a victim process back.",
    ]),
]

BIO_TEXT = """Photosynthesis Lab Notes (Biology 101)

Photosynthesis turns light energy, water and carbon dioxide into glucose and oxygen inside chloroplasts. The light-dependent reactions run on the thylakoid membranes and produce ATP, NADPH and oxygen. The oxygen released by plants comes from splitting water, not from carbon dioxide.

Pigments: chlorophyll a absorbs light most strongly at about 430 nm (blue) and 662 nm (red). Green light is mostly reflected, which is why leaves look green. Carotenoids are accessory pigments that absorb blue-green light and protect the leaf from excess light.

The Calvin cycle runs in the stroma. To build one molecule of glucose the Calvin cycle uses 18 ATP and 12 NADPH. The enzyme RuBisCO fixes carbon dioxide and is probably the most abundant protein on Earth.

Leaves exchange gases through tiny pores called stomata. Each stoma is surrounded by two guard cells, which swell to open the pore and shrink to close it, controlling water loss and carbon dioxide intake. Most stomata are on the underside of the leaf.

Greenhouse experiment: we grew basil plants under different LED colours for two weeks. Plants under blue LED light released 23 percent more oxygen than plants under green LED light. Red light gave the second highest oxygen output.

Limiting factors: light intensity, carbon dioxide concentration and temperature. In our experiment the rate stopped rising above 30 degrees Celsius.
"""

NET_SECTIONS = [
    "Computer Networks Study Guide. The OSI model has seven layers: physical, data link, network, transport, "
    "session, presentation and application. A handy mnemonic is Please Do Not Throw Sausage Pizza Away. "
    "The TCP/IP model squeezes these into four layers: link, internet, transport and application.",
    "TCP is connection-oriented and reliable. A TCP connection starts with the three-way handshake: the client "
    "sends SYN, the server answers with SYN-ACK, and the client replies with ACK. TCP uses sequence numbers, "
    "acknowledgements and retransmission timers, plus a sliding window for flow control.",
    "UDP is connectionless and has no handshake, no retransmission and no ordering. It has a tiny 8 byte header, "
    "which makes it a good fit for DNS queries, voice calls, live video and online games.",
    "DNS translates host names into IP addresses and normally listens on port 53. Our campus DNS resolver is at "
    "10.20.0.53. Common record types are A for IPv4, AAAA for IPv6, MX for mail servers and CNAME for aliases.",
    "Ethernet frames on our lab network have an MTU of 1500 bytes, so larger IP packets must be fragmented or "
    "the sender must use path MTU discovery to find the largest size that fits.",
    "Subnetting splits an address block into smaller networks. A /24 subnet has 256 addresses and 254 usable "
    "hosts, because the network address and the broadcast address are reserved.",
    "HTTP runs on top of TCP on port 80, while HTTPS wraps HTTP in TLS on port 443. HTTP/2 multiplexes many "
    "requests over one connection, and HTTP/3 runs over QUIC, which is built on UDP.",
    "Every IP packet carries a time to live field. Linux sets the initial TTL to 64, and each router decrements "
    "it by one; when it reaches zero the packet is dropped and an ICMP time exceeded message is sent back.",
]

LONG_TARGET_WORDS = 3000
JOURNAL_ENTRIES_PER_SECTION = 9
QUESTION_SPOKEN = "What is the default time quantum in round robin?"


def journal_entry(i: int) -> str:
    """Deliberately bland, repetitive filler so the long file needs many chunks."""
    return (
        f"Bench journal entry {i}: the study group met in room {100 + i % 9}, reviewed {3 + i % 5} practice "
        f"problems from chapter {1 + i % 12}, and spent {20 + i % 7} minutes summarising the readings on index "
        f"cards before the tutor collected the worksheets."
    )


def build_long_text() -> str:
    parts: list[str] = []
    i = 0
    for section in NET_SECTIONS:
        parts.append(section)
        for _ in range(JOURNAL_ENTRIES_PER_SECTION):
            i += 1
            parts.append(journal_entry(i))
    while len(" ".join(parts).split()) < LONG_TARGET_WORDS:
        i += 1
        parts.append(journal_entry(i))
    return "\n\n".join(parts) + "\n"


def build_os_pdf(path: Path) -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

    styles = getSampleStyleSheet()
    story = []
    for idx, (title, paras) in enumerate(OS_PAGES):
        story.append(Paragraph(title, styles["Heading1"]))
        for para in paras:
            story += [Paragraph(para, styles["BodyText"]), Spacer(1, 8)]
        if idx < len(OS_PAGES) - 1:
            story.append(PageBreak())
    SimpleDocTemplate(str(path), pagesize=letter).build(story)


def build_scanned_pdf(path: Path) -> None:
    from PIL import Image, ImageDraw
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    img = Image.new("RGB", (1224, 1584), "white")
    draw = ImageDraw.Draw(img)
    for row in range(20):
        draw.text((80, 80 + row * 60), f"Scanned lecture notes line {row + 1}: no text layer here.", fill="black")
    pdf = canvas.Canvas(str(path), pagesize=letter)
    pdf.drawImage(ImageReader(img), 0, 0, width=letter[0], height=letter[1])
    pdf.showPage()
    pdf.save()


def write_silence(path: Path, seconds: float = 1.0, rate: int = 16000) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x00\x00" * int(rate * seconds))


def write_tiny(path: Path) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(b"\x00\x00" * 200)  # ~444 bytes total, under the 1 KB threshold


def write_tts(path: Path, text: str) -> None:
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.SetOutputToWaveFile('{path}'); $s.Speak('{text}'); $s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True)


def ensure_fixtures(force: bool = False) -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    builders = {
        "notes_os.pdf": build_os_pdf,
        "notes_bio.txt": lambda p: p.write_text(BIO_TEXT, encoding="utf-8"),
        "long_notes.txt": lambda p: p.write_text(build_long_text(), encoding="utf-8"),
        "scanned.pdf": build_scanned_pdf,
        "silence.wav": write_silence,
        "tiny.wav": write_tiny,
        "question.wav": lambda p: write_tts(p, QUESTION_SPOKEN),
    }
    for name, build in builders.items():
        path = FIXTURES / name
        if path.exists() and not force:
            continue
        if name == "question.wav" and sys.platform != "win32":
            raise SystemExit("question.wav needs Windows TTS; generate it on Windows and commit it.")
        build(path)
        print(f"built {name} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    ensure_fixtures(parser.parse_args().force)
