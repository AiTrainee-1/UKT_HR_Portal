// Speaking to the assistant. Two engines, chosen automatically:
//   1. the browser's own recogniser (Web Speech API): instant, live words, English/Tamil/Hindi;
//   2. recording with MediaRecorder and having the server (Gemini) transcribe it: used when the browser has no recogniser
//      (Firefox, some in-app browsers), when the MD picks "Auto-detect", or when the browser's recogniser fails to start.
// Half-duplex: speech output is stopped before listening (the microphone would otherwise hear the speaker).

import { useCallback, useEffect, useRef, useState } from "react";
import { transcribe } from "../api";
import {
  MAX_RECORDING_MS,
  NO_START_FALLBACK_MS,
  SILENCE_AFTER_SPEECH_MS,
  chooseRecorderMime,
  levelFromSamples,
  normalizeTranscript,
  recognitionLang,
  type VoiceLanguageChoice,
} from "@/lib/md/voice";

// The DOM typings do not include the Web Speech API: declare the small part this uses.
type SpeechAlternative = { transcript: string; confidence: number };
type SpeechResult = { isFinal: boolean; length: number; [index: number]: SpeechAlternative };
type SpeechResultEvent = { resultIndex: number; results: { length: number; [index: number]: SpeechResult } };
type SpeechErrorEvent = { error: string };
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

const recognitionCtor = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export type VoiceState = "idle" | "listening" | "processing";

export type VoiceInputOptions = {
  language: VoiceLanguageChoice;
  /** The server can transcribe (a key is set): enables the fallback and "Auto-detect". */
  serverTranscription: boolean;
  /** Called with the final words, the recogniser's confidence when it gives one, which engine heard them and the
   *  language they were in (the one asked for, or the one the server detected). */
  onResult: (text: string, confidence: number | null, source: "browser" | "server", language: string) => void;
  /** Called before listening starts (stop the speaker). */
  onBeforeListen?: () => void;
};

export function useVoiceInput({ language, serverTranscription, onResult, onBeforeListen }: VoiceInputOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [engine, setEngine] = useState<"browser" | "server" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const recognitionRef = useRef<Recognition | null>(null);
  const recorderRef = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  const timersRef = useRef<number[]>([]);
  const optionsRef = useRef({ language, serverTranscription, onResult, onBeforeListen });
  optionsRef.current = { language, serverTranscription, onResult, onBeforeListen };

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };

  const reset = useCallback(() => {
    clearTimers();
    setState("idle");
    setInterim("");
    setLevel(0);
    setEngine(null);
  }, []);

  // ─── engine 2: record, then transcribe on the server ──────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    const opts = optionsRef.current;
    if (!opts.serverTranscription) {
      setNotice("Voice input is not available in this browser.");
      reset();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setNotice("This browser cannot record audio. Please type your question.");
      reset();
      return;
    }
    const mime = chooseRecorderMime((m) => MediaRecorder.isTypeSupported(m));
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setNotice("The microphone is blocked. Allow it in the browser's address bar, then try again.");
      reset();
      return;
    }
    setEngine("server");
    setState("listening");

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const context = new AudioContext();
    void context.resume(); // Safari starts a context suspended when it was not created inside the click itself
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let spoke = false;
    let quietSince = 0;
    let cancelled = false;
    let frame = 0;

    const release = () => {
      cancelAnimationFrame(frame);
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    };
    const finish = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      const loudness = levelFromSamples(samples);
      setLevel(loudness);
      const now = performance.now();
      if (loudness > 0.1) {
        spoke = true;
        quietSince = 0;
      } else if (spoke && loudness < 0.05) {
        quietSince ||= now;
        if (now - quietSince > SILENCE_AFTER_SPEECH_MS) return finish(); // went quiet: done
      } else {
        quietSince = 0; // soft speech in between: not silence yet
      }
      frame = requestAnimationFrame(tick);
    };

    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = async () => {
      release();
      clearTimers();
      if (cancelled) return reset();
      setLevel(0);
      setState("processing");
      try {
        const audio = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
        const result = await transcribe(audio, opts.language === "auto" ? undefined : opts.language);
        const text = normalizeTranscript(result.text);
        if (text) opts.onResult(text, null, "server", result.language);
        else setNotice("I did not catch that. Please try again.");
      } catch (error) {
        const data = (error as { data?: { error?: string } }).data;
        setNotice(data?.error || "The recording could not be turned into text. Please type your question.");
      }
      reset();
    };

    recorderRef.current = {
      stop: finish,
      cancel: () => {
        cancelled = true;
        finish();
      },
    };
    recorder.start();
    frame = requestAnimationFrame(tick);
    timersRef.current.push(window.setTimeout(finish, MAX_RECORDING_MS));
  }, [reset]);

  // ─── engine 1: the browser's recogniser ───────────────────────────────────────────────────────────────────────
  const startBrowser = useCallback(
    (Ctor: RecognitionCtor) => {
      const opts = optionsRef.current;
      const recognition = new Ctor();
      recognition.lang = recognitionLang(opts.language);
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      recognitionRef.current = recognition;
      setEngine("browser");

      let transcript = "";
      let confidence: number | null = null;
      let started = false;
      let handedOver = false; // the fallback took over: ignore this recogniser's callbacks
      let pulse = 0;

      const fallBack = (why: string) => {
        if (handedOver) return;
        handedOver = true;
        recognition.abort();
        window.clearInterval(pulse);
        recognitionRef.current = null;
        if (optionsRef.current.serverTranscription) {
          setNotice(null);
          void startRecording();
        } else {
          setNotice(why);
          reset();
        }
      };

      recognition.onstart = () => {
        started = true;
        setState("listening");
      };
      recognition.onaudiostart = () => {
        started = true;
        clearTimers();
      };
      recognition.onspeechstart = () => {
        pulse ||= window.setInterval(() => setLevel(0.3 + Math.random() * 0.55), 90);
      };
      recognition.onspeechend = () => {
        window.clearInterval(pulse);
        pulse = 0;
        setLevel(0.05);
      };
      recognition.onresult = (event) => {
        let text = "";
        let best: number | null = null;
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          text += result[0].transcript;
          if (result.isFinal && result[0].confidence) best = result[0].confidence;
        }
        transcript = text;
        confidence = best ?? confidence;
        setInterim(normalizeTranscript(text));
      };
      recognition.onerror = (event) => {
        if (handedOver) return;
        switch (event.error) {
          case "aborted":
            return;
          case "no-speech":
            setNotice("I did not hear anything. Tap the microphone and try again.");
            return;
          case "not-allowed":
          case "service-not-allowed":
            setNotice("The microphone is blocked. Allow it in the browser's address bar, then try again.");
            return;
          case "audio-capture":
            setNotice("No microphone was found.");
            return;
          default: // network, language-not-supported, ...: record it and let the server do the listening
            fallBack("Voice recognition is not working in this browser. Please type your question.");
        }
      };
      recognition.onend = () => {
        if (handedOver) return;
        window.clearInterval(pulse);
        recognitionRef.current = null;
        const text = normalizeTranscript(transcript);
        clearTimers();
        reset();
        if (text)
          optionsRef.current.onResult(text, confidence, "browser", recognitionLang(optionsRef.current.language));
      };

      try {
        recognition.start();
      } catch {
        fallBack("Voice recognition could not start. Please type your question.");
        return;
      }
      // Some browsers (Edge) accept start() and then never listen: give it a moment, then use the recorder instead.
      timersRef.current.push(
        window.setTimeout(() => {
          if (!started) fallBack("Voice recognition did not start. Please type your question.");
        }, NO_START_FALLBACK_MS),
      );
    },
    [reset, startRecording],
  );

  const start = useCallback(() => {
    if (state !== "idle") return;
    const opts = optionsRef.current;
    setNotice(null);
    setInterim("");
    if (!window.isSecureContext) {
      setNotice("The microphone only works on a secure (HTTPS) connection or on localhost.");
      return;
    }
    opts.onBeforeListen?.();
    setState("listening");
    const Ctor = recognitionCtor();
    if (Ctor && opts.language !== "auto") startBrowser(Ctor);
    else void startRecording();
  }, [state, startBrowser, startRecording]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recorderRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    reset();
  }, [reset]);

  useEffect(() => () => cancel(), [cancel]);

  const supported = recognitionCtor() !== null || serverTranscription;
  return { state, interim, level, engine, notice, supported, start, stop, cancel, clearNotice: () => setNotice(null) };
}
