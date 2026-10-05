import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUp, Check, Languages, Loader2, Mic, Square, Volume2, VolumeX } from "lucide-react";
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
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold text-[#006496]/75 transition-colors hover:bg-[#006496]/[0.07]"
      >
        <Languages size={13} />
        {current.short}
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute bottom-full left-0 z-10 mb-1.5 w-44 overflow-hidden rounded-xl border border-[#006496]/12 bg-white py-1 shadow-lg"
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
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[#1a3a4a] hover:bg-[#006496]/[0.06]"
              >
                <span className="flex-1">{l.label}</span>
                {l.value === value && <Check size={13} className="text-[#006496]" />}
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
    <div className="border-t border-[#006496]/10 bg-white/90 px-3 pb-3 pt-2.5">
      {voice.notice && (
        <p
          className="mb-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900"
          role="status"
          data-testid="assistant-voice-notice"
        >
          {voice.notice}
        </p>
      )}
      <div className="rounded-2xl border border-[#006496]/15 bg-white shadow-sm transition-shadow focus-within:border-[#006496]/40 focus-within:ring-2 focus-within:ring-[#006496]/10">
        {listening || processing ? (
          <div className="px-3.5 pb-1 pt-3" data-testid="assistant-listening">
            <Waveform level={voice.level} active={listening} />
            <p className="mt-1 min-h-[2.4em] text-center text-[13px] text-[#1a3a4a]">
              {processing ? (
                <span className="text-[#006496]/70">Turning your voice into text…</span>
              ) : voice.interim ? (
                voice.interim
              ) : (
                <span className="text-[#006496]/55">
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
            className="block max-h-[120px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-snug text-[#1a3a4a] outline-none placeholder:text-[#006496]/40 disabled:opacity-60"
          />
        )}
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <LanguageMenu value={language} onChange={onLanguage} />
          {speechSupported && (
            <button
              type="button"
              onClick={() => onSpeakAnswers(!speakAnswers)}
              aria-pressed={speakAnswers}
              title={speakAnswers ? "Answers are read aloud" : "Read answers aloud"}
              data-testid="assistant-speak-toggle"
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold transition-colors",
                speakAnswers ? "bg-[#fff1cc] text-[#7a5410]" : "text-[#006496]/70 hover:bg-[#006496]/[0.07]",
              )}
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
              className={cn(
                "relative mr-1 flex h-9 w-9 items-center justify-center rounded-full border transition-all disabled:opacity-50",
                listening
                  ? "border-red-300 bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-md"
                  : "border-[#006496]/20 bg-white text-[#006496] hover:border-[#e0a83a] hover:bg-[#fff8e6] hover:text-[#7a5410]",
              )}
            >
              {listening && <span className="absolute inset-0 animate-ping rounded-full bg-red-400/40" aria-hidden />}
              {processing ? (
                <Loader2 size={16} className="animate-spin" />
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
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[#006496]/25 bg-white text-[#006496] shadow-sm transition-all hover:scale-105 hover:border-red-300 hover:text-red-600"
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
            className="flex h-9 w-9 items-center justify-center rounded-full text-white shadow-sm transition-all enabled:hover:scale-105 enabled:hover:shadow-md disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: "linear-gradient(135deg, #006496 0%, #0096c7 100%)" }}
          >
            <ArrowUp size={17} strokeWidth={2.6} />
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-center text-[10.5px] text-[#006496]/50">
        Read-only: I can look at your company data but never change it.
        {value.length > maxChars * 0.85 && (
          <span className="ml-1 tabular-nums">
            {value.length}/{maxChars}
          </span>
        )}
      </p>
    </div>
  );
}
