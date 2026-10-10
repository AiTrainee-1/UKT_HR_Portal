import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUp, Check, Languages, Loader2, Lock, Mic, Square, Volume2, VolumeX } from "lucide-react";
import { VOICE_LANGUAGES, type VoiceLanguageChoice } from "@/lib/md/voice";
import { cn } from "@/lib/utils";
import type { useVoiceInput } from "./voice/useVoiceInput";
import Waveform from "./Waveform";

type Voice = ReturnType<typeof useVoiceInput>;

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Stop the answer being prepared (shown instead of Send while it works). */
  onStop: () => void;
  busy: boolean;
  ready: boolean;
  maxChars: number;
  voice: Voice;
  language: VoiceLanguageChoice;
  onLanguage: (language: VoiceLanguageChoice) => void;
  speakAnswers: boolean;
  onSpeakAnswers: (on: boolean) => void;
  speechSupported: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

/** A small menu (not a portal popover: the panel sits above those) to choose the listening language. */
function LanguageMenu({ value, onChange }: { value: VoiceLanguageChoice; onChange: (v: VoiceLanguageChoice) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const current = VOICE_LANGUAGES.find((l) => l.value === value) ?? VOICE_LANGUAGES[0];
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Language for voice input"
        data-testid="assistant-language"
        className="md-chip md-assistant-tool"
      >
        <Languages size={13} />
        {current.short}
      </button>
      {open && (
        <ul
          role="listbox"
          className="md-assistant-menu absolute bottom-full left-0 z-10 mb-2 w-52 overflow-hidden p-1.5"
        >
          {VOICE_LANGUAGES.map((l) => (
            <li key={l.value}>
              <button
                type="button"
                role="option"
                aria-selected={l.value === value}
                onClick={() => {
                  onChange(l.value);
                  setOpen(false);
                }}
                data-testid={`assistant-language-${l.value}`}
                className="md-assistant-option flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[13px] text-md-ink"
              >
                <span className="flex-1">{l.label}</span>
                {l.value === value && <Check size={14} strokeWidth={2.6} className="text-md-wine" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  ready,
  maxChars,
  voice,
  language,
  onLanguage,
  speakAnswers,
  onSpeakAnswers,
  speechSupported,
  inputRef,
}: Props) {
  const listening = voice.state === "listening";
  const processing = voice.state === "processing";
  const canSend = ready && !busy && value.trim().length > 0 && !listening && !processing;

  // grow with the text, up to about five lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value, inputRef, listening]);

  const micLabel = listening ? "Stop listening" : processing ? "Working on your recording" : "Ask by voice";

  return (
    <div className="md-assistant-dock px-3 pt-3">
      {voice.notice && (
        <p
          className="md-panel-sand mb-2.5 px-3 py-2 text-[12px] leading-snug text-md-warning-800"
          role="status"
          data-testid="assistant-voice-notice"
        >
          {voice.notice}
        </p>
      )}
      <div className="md-field md-assistant-box" data-listening={listening}>
        {listening || processing ? (
          <div className="px-3.5 pb-1 pt-3" data-testid="assistant-listening">
            <Waveform level={voice.level} active={listening} />
            <p className="mt-1 min-h-[2.4em] text-center text-[13.5px] leading-snug text-md-ink">
              {processing ? (
                <span className="text-md-ink-soft">Turning your voice into text…</span>
              ) : voice.interim ? (
                voice.interim
              ) : (
                <span className="text-md-ink-soft">
                  Listening… speak your question
                  {voice.engine === "server" ? " (it is sent for transcription when you stop)" : ""}
                </span>
              )}
            </p>
          </div>
        ) : (
          <textarea
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value.slice(0, maxChars))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) onSend();
              }
            }}
            rows={1}
            placeholder={
              ready ? "Ask about attendance, payroll, hiring, anything…" : "The assistant is not available right now"
            }
            disabled={!ready}
            aria-label="Your question"
            data-testid="assistant-input"
            className="block max-h-[120px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-snug text-md-ink outline-none placeholder:text-md-ink-500 disabled:opacity-60"
          />
        )}
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <LanguageMenu value={language} onChange={onLanguage} />
          {speechSupported && (
            <button
              type="button"
              onClick={() => onSpeakAnswers(!speakAnswers)}
              aria-pressed={speakAnswers}
              title={speakAnswers ? "Answers are read aloud" : "Read answers aloud"}
              data-testid="assistant-speak-toggle"
              className="md-chip md-assistant-tool"
            >
              {speakAnswers ? <Volume2 size={13} /> : <VolumeX size={13} />}
              {speakAnswers ? "Reading aloud" : "Silent"}
            </button>
          )}
          <span className="flex-1" />
          {voice.supported && (
            <button
              type="button"
              onClick={listening ? voice.stop : voice.start}
              disabled={!ready || processing || busy}
              aria-label={micLabel}
              title={micLabel}
              data-testid="assistant-mic"
              className={cn("md-btn md-btn-icon", listening ? "md-btn-primary" : "md-btn-soft md-assistant-mic")}
            >
              {listening && (
                <span
                  className="absolute inset-0 rounded-full bg-md-wine-400/45 motion-safe:animate-ping"
                  aria-hidden
                />
              )}
              {processing ? (
                <Loader2 size={16} className="motion-safe:animate-spin" />
              ) : listening ? (
                <Square size={13} className="relative fill-current" />
              ) : (
                <Mic size={16} />
              )}
            </button>
          )}
          {busy && !listening && !processing ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop this answer"
              data-testid="assistant-stop"
              className="md-btn md-btn-ink md-btn-icon"
            >
              <Square size={13} className="fill-current" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label="Send"
            data-testid="assistant-send"
            className="md-btn md-btn-primary md-btn-icon disabled:cursor-not-allowed"
          >
            <ArrowUp size={17} strokeWidth={2.6} />
          </button>
        </div>
      </div>
      <p className="md-assistant-hint mt-2 flex items-center justify-center gap-1.5 text-center">
        <Lock size={11} className="shrink-0" aria-hidden />
        <span>Read-only: I can look at your company data but never change it.</span>
        {value.length > maxChars * 0.85 && (
          <span className="ml-1 tabular-nums">
            {value.length}/{maxChars}
          </span>
        )}
      </p>
    </div>
  );
}
