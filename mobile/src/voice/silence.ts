/** Pure helpers for the voice recorder: level normalisation, end-of-utterance, silence guard. */

export const SPEECH_THRESHOLD_DB = -40; // a frame louder than this counts as speech
export const END_SILENCE_MS = 1200; // auto-stop after this much silence once speech was heard
export const MAX_RECORDING_MS = 30_000;
export const MIN_RECORDING_MS = 400;
const FLOOR_DB = -60;

/** Metering dB (about -60..0) -> 0..1. */
export function normalizeDb(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0;
  const clamped = Math.min(0, Math.max(FLOOR_DB, db));
  return (clamped - FLOOR_DB) / -FLOOR_DB;
}

export interface VadState {
  speechDetected: boolean;
  lastSpeechAt: number | null;
  peakDb: number;
}

export const initialVad: VadState = { speechDetected: false, lastSpeechAt: null, peakDb: -160 };

/** Feed one metering frame. Returns the new state and whether recording should stop now. */
export function vadStep(state: VadState, db: number | undefined, elapsedMs: number): { state: VadState; stop: boolean } {
  const level = db ?? -160;
  const loud = level > SPEECH_THRESHOLD_DB;
  const next: VadState = {
    speechDetected: state.speechDetected || loud,
    lastSpeechAt: loud ? elapsedMs : state.lastSpeechAt,
    peakDb: Math.max(state.peakDb, level),
  };
  const silentLongEnough =
    next.speechDetected && next.lastSpeechAt !== null && elapsedMs - next.lastSpeechAt >= END_SILENCE_MS;
  return { state: next, stop: silentLongEnough || elapsedMs >= MAX_RECORDING_MS };
}

/** Skip /stt entirely: nothing was ever loud enough, or the tap was too short. */
export function shouldDiscardRecording(durationMs: number, peakDb: number): boolean {
  return durationMs < MIN_RECORDING_MS || peakDb <= SPEECH_THRESHOLD_DB;
}

// Whisper hallucinates these on near-silent audio.
const FILLERS = new Set(["thank you", "thanks for watching", "thank you for watching", "you", "bye", "thanks"]);

/** Drop empty transcripts, and known filler phrases when the audio was quiet. */
export function isUselessTranscript(text: string, peakDb: number): boolean {
  const norm = text.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  if (!norm) return true;
  const quiet = peakDb < SPEECH_THRESHOLD_DB + 10;
  return quiet && FILLERS.has(norm);
}
