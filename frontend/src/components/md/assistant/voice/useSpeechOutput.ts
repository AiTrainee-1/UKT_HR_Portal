// Reading answers aloud with the browser's text-to-speech. Only the short "spoken summary" is read by default; long
// text is spoken in sentence-sized pieces because Chrome cuts a single utterance off after ~15 seconds. Voices load
// asynchronously, and many devices have no Tamil or Hindi voice: then the answer is shown but not spoken, and we say so.

import { useCallback, useEffect, useRef, useState } from "react";
import { stripMarkdown } from "@/lib/md/markdown";
import { chunkForSpeech, languageForText, pickVoice, type SpeechLang } from "@/lib/md/voice";

const LANGUAGE_NAME: Record<SpeechLang, string> = { "en-IN": "English", "ta-IN": "Tamil", "hi-IN": "Hindi" };

const synth = (): SpeechSynthesis | null =>
  typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      s.removeEventListener("voiceschanged", done);
      resolve(s.getVoices());
    };
    s.addEventListener("voiceschanged", done);
    setTimeout(done, 1500); // Safari and some builds never fire the event
  });
}

/** Say something once from a user gesture so iOS lets later (asynchronous) speech through. */
export function primeSpeech() {
  const s = synth();
  if (!s) return;
  try {
    s.speak(new SpeechSynthesisUtterance(""));
  } catch {
    // not available: nothing to prime
  }
}

export function useSpeechOutput() {
  const supported = synth() !== null;
  const [speakingId, setSpeakingId] = useState<string | number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runRef = useRef(0); // which speak() call is current, so a stale callback cannot clear a newer one
  const keepAlive = useRef<SpeechSynthesisUtterance[]>([]); // utterances must stay referenced or Chrome may drop them

  const stop = useCallback(() => {
    runRef.current += 1;
    keepAlive.current = [];
    synth()?.cancel();
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    async (id: string | number, text: string, options: { markdown?: boolean } = {}): Promise<boolean> => {
      const s = synth();
      if (!s) {
        setNotice("This browser cannot read aloud.");
        return false;
      }
      stop();
      const run = runRef.current;
      const plain = options.markdown ? stripMarkdown(text) : text;
      const pieces = chunkForSpeech(plain);
      if (pieces.length === 0) return false;

      const lang = languageForText(plain);
      const voices = await loadVoices();
      if (run !== runRef.current) return false; // stopped or replaced while the voices loaded
      const voice = pickVoice(voices, lang);
      if (!voice && lang !== "en-IN") {
        setNotice(
          `This device has no ${LANGUAGE_NAME[lang]} voice installed, so the answer is shown but not read aloud.`,
        );
        return false;
      }
      setNotice(null);

      keepAlive.current = pieces.map((piece, index) => {
        const utterance = new SpeechSynthesisUtterance(piece);
        utterance.lang = voice?.lang ?? lang;
        if (voice) utterance.voice = voice;
        utterance.rate = 0.98;
        utterance.onend = () => {
          if (index === pieces.length - 1 && run === runRef.current) setSpeakingId(null);
        };
        utterance.onerror = (event) => {
          if (event.error === "canceled" || event.error === "interrupted") return; // we stopped it ourselves
          if (run === runRef.current) {
            setSpeakingId(null);
            setNotice(
              event.error === "not-allowed"
                ? "Tap the speaker button to let the browser play audio."
                : "The voice stopped unexpectedly.",
            );
          }
        };
        return utterance;
      });
      setSpeakingId(id);
      // A speak() straight after cancel() is dropped on some platforms: let the cancel settle first.
      setTimeout(() => {
        if (run !== runRef.current) return;
        try {
          s.resume(); // some browsers stay "paused" after a cancel and would say nothing
        } catch {
          // not supported: speak anyway
        }
        for (const utterance of keepAlive.current) s.speak(utterance);
      }, 60);
      return true;
    },
    [stop],
  );

  // Never keep talking after leaving the page or closing the tab.
  useEffect(() => {
    const onHide = () => stop();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      stop();
    };
  }, [stop]);

  return { supported, speakingId, notice, speak, stop, clearNotice: () => setNotice(null) };
}
