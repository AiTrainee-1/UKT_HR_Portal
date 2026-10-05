// The assistant's voice rules, as plain functions (the browser APIs themselves are wrapped in components/md/assistant/voice/).
// English (India), Tamil and Hindi are supported for speaking and listening.

export type SpeechLang = "en-IN" | "ta-IN" | "hi-IN";
/** What the MD can pick for listening. "auto" has the server (Gemini) detect the language: browsers cannot. */
export type VoiceLanguageChoice = SpeechLang | "auto";

export const VOICE_LANGUAGES: { value: VoiceLanguageChoice; label: string; short: string }[] = [
  { value: "en-IN", label: "English", short: "EN" },
  { value: "ta-IN", label: "தமிழ் (Tamil)", short: "த" },
  { value: "hi-IN", label: "हिन्दी (Hindi)", short: "हि" },
  { value: "auto", label: "Auto-detect", short: "Auto" },
];

/** A recording is cut off here, whatever happens. */
export const MAX_RECORDING_MS = 30_000;
/** Recording stops this long after the MD went quiet (once they have spoken). */
export const SILENCE_AFTER_SPEECH_MS = 1800;
/** If the browser's recogniser has not started listening by now, switch to recording and server transcription. */
export const NO_START_FALLBACK_MS = 3000;
/** Below this recogniser confidence a transcript is shown for review instead of being sent at once. */
export const AUTO_SEND_CONFIDENCE = 0.6;

// ─── which language is this text in ───────────────────────────────────────────────────────────────────────────

const TAMIL = /[஀-௿]/g;
const DEVANAGARI = /[ऀ-ॿ]/g;
const LETTER = /\p{L}/gu;

/** The language to speak a piece of text in: by script, because the model answers in the language it was asked in. */
export function languageForText(text: string): SpeechLang {
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return "en-IN";
  const tamil = text.match(TAMIL)?.length ?? 0;
  const hindi = text.match(DEVANAGARI)?.length ?? 0;
  if (tamil / letters >= 0.3 && tamil >= hindi) return "ta-IN";
  if (hindi / letters >= 0.3) return "hi-IN";
  return "en-IN";
}

/** The language for the browser's speech recogniser: it takes exactly one, so "auto" falls back to English. */
export function recognitionLang(choice: VoiceLanguageChoice): SpeechLang {
  return choice === "auto" ? "en-IN" : choice;
}

// ─── text for the speaker ──────────────────────────────────────────────────────────────────────────────────────

const SENTENCE_END = /(?<=[.!?।॥;])\s+/u;

/** Split text into pieces a speech engine handles reliably: whole sentences, none longer than `maxLen` (long ones are
 *  broken at a comma or space). Chrome cuts long utterances off after about 15 seconds, so short pieces are spoken in turn. */
export function chunkForSpeech(text: string, maxLen = 180): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen);
      const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "));
      const at = cut > maxLen * 0.4 ? cut + 1 : maxLen;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  // merge very short neighbours ("Yes." + "It was 14.") so the voice does not stutter
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.length < 24 && last.length + piece.length + 1 <= maxLen)
      merged[merged.length - 1] = `${last} ${piece}`;
    else merged.push(piece);
  }
  return merged;
}

// ─── choosing a voice ──────────────────────────────────────────────────────────────────────────────────────────

export type VoiceInfo = { name: string; lang: string; localService: boolean };

const norm = (lang: string) => lang.replace("_", "-").toLowerCase();

/** The best installed voice for a language, or null (then the answer is shown but not spoken). Chrome on Android reports
 *  "ta_IN"; Samsung sometimes a three-letter code ("tam"); both are understood. */
export function pickVoice<T extends VoiceInfo>(voices: T[], lang: SpeechLang): T | null {
  const primary = lang.slice(0, 2);
  const longPrimary = { en: "eng", ta: "tam", hi: "hin" }[primary as "en" | "ta" | "hi"];
  const score = (voice: T): number => {
    const l = norm(voice.lang);
    let s = 0;
    if (l === norm(lang)) s += 100;
    else if (l.startsWith(`${primary}-`) || l === primary) s += 60;
    else if (longPrimary && l.startsWith(longPrimary)) s += 50;
    else return -1;
    if (primary === "en") {
      if (l === "en-in") s += 10;
      else if (l === "en-gb") s += 6;
      else if (l === "en-us") s += 3;
    }
    if (/natural|neural|online/i.test(voice.name)) s += 8; // the engines' high-quality voices
    if (voice.localService) s += 4; // works offline and is not cut off after 15 s
    return s;
  };
  let best: T | null = null;
  let bestScore = -1;
  for (const voice of voices) {
    const s = score(voice);
    if (s > bestScore) {
      best = voice;
      bestScore = s;
    }
  }
  return best;
}

// ─── listening ─────────────────────────────────────────────────────────────────────────────────────────────────

/** How a spoken question was heard (shown under the question, and stored with it). */
export type HeardInfo = { language?: string; engine?: "browser" | "server"; confidence?: number };

const LANGUAGE_NAMES: Record<string, string> = {
  "en-IN": "English",
  "ta-IN": "Tamil",
  "hi-IN": "Hindi",
  other: "another language",
};

/** "Heard in Tamil · 93% sure · browser speech recognition": the voice analysis behind a spoken question. */
export function describeHeard(heard: HeardInfo | null | undefined): string | null {
  if (!heard) return null;
  const parts: string[] = [];
  if (heard.language) parts.push(`Heard in ${LANGUAGE_NAMES[heard.language] ?? heard.language}`);
  if (typeof heard.confidence === "number" && heard.confidence > 0)
    parts.push(`${Math.round(heard.confidence * 100)}% sure`);
  if (heard.engine) parts.push(heard.engine === "server" ? "transcribed by Gemini" : "browser speech recognition");
  return parts.length ? parts.join(" · ") : null;
}

/** Tidy a recognised phrase: single spaces, no leading/trailing space. */
export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Send at once when the recogniser is sure enough; otherwise let the MD check the words (names and numbers are where
 *  Tamil and Hindi recognition slips). */
export function shouldAutoSend(transcript: string, confidence: number | null | undefined): boolean {
  const text = normalizeTranscript(transcript);
  if (text.length < 3) return false;
  return confidence == null || confidence === 0 || confidence >= AUTO_SEND_CONFIDENCE;
}

/** Loudness 0..1 from the analyser's byte samples (128 is silence): drives the listening animation. */
export function levelFromSamples(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3); // gain: speech is quiet next to full scale
}

/** The first recording format the browser can make: WebM/Opus on Chrome, Edge and Firefox, MP4 on Safari. */
export function chooseRecorderMime(isSupported: (mime: string) => boolean): string | null {
  const preferred = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
  return preferred.find((mime) => isSupported(mime)) ?? null;
}
