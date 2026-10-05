// The AI assistant's side panel: always mounted for the MD while they are in the portal (so the conversation survives
// moving between pages) and slid in and out. Text and voice in, text and voice out, every answer with its explanation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  History,
  KeyRound,
  MessageSquarePlus,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMdMe } from "@/lib/api-client/custom-hooks";
import { clearPendingPrompt, closeAssistant, useAssistantState } from "@/lib/md/assistant-store";
import { greeting } from "@/lib/md/format";
import { shouldAutoSend, type VoiceLanguageChoice } from "@/lib/md/voice";
import { mdPageForPath } from "../md-nav";
import { getStatus, type ChatMessage, type HeardPayload } from "./api";
import Composer from "./Composer";
import MessageBubble, { AssistantAvatar } from "./MessageBubble";
import { suggestionsFor } from "./suggestions";
import { useAssistantChat } from "./useAssistantChat";
import { primeSpeech, useSpeechOutput } from "./voice/useSpeechOutput";
import { useVoiceInput } from "./voice/useVoiceInput";

const STORAGE_SPEAK = "md_assistant_speak";
const STORAGE_LANGUAGE = "md_assistant_voice_language";

function usePersisted<T extends string | boolean>(
  key: string,
  initial: T,
  valid: (v: unknown) => v is T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = typeof initial === "boolean" ? raw === "1" : raw;
      return valid(parsed) ? parsed : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, typeof next === "boolean" ? (next ? "1" : "0") : next);
      } catch {
        // storage blocked: the choice just does not survive a reload
      }
    },
    [key],
  );
  return [value, set];
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isLanguage = (v: unknown): v is VoiceLanguageChoice =>
  v === "en-IN" || v === "ta-IN" || v === "hi-IN" || v === "auto";

function GlowOrb() {
  return (
    <div className="relative flex h-20 w-20 items-center justify-center" aria-hidden>
      <span className="assistant-orb-glow absolute inset-0 rounded-full" />
      <span className="assistant-orb-ring absolute inset-1 rounded-full border border-[#e0a83a]/40" />
      <AssistantAvatar size={52} className="relative" />
    </div>
  );
}

function SetupNotice({ kind, resetsAt }: { kind: "not_configured" | "disabled" | "limit"; resetsAt?: string }) {
  const text =
    kind === "not_configured"
      ? "The assistant needs a Google Gemini API key. Ask your administrator to add GEMINI_API_KEY to the server settings; nothing else is needed."
      : kind === "disabled"
        ? "The assistant has been switched off by the administrator."
        : `Today's free Gemini allowance is used up. It resets at about ${resetsAt}. Everything else in the portal works as usual.`;
  const Icon = kind === "not_configured" ? KeyRound : AlertTriangle;
  return (
    <div
      className="mx-4 mt-4 flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-900"
      data-testid="assistant-setup"
      role="status"
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <p>{text}</p>
    </div>
  );
}

export default function AssistantPanel() {
  const { open, prompt } = useAssistantState();
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const reduce = useReducedMotion();
  const me = useMdMe();
  const status = useQuery({ queryKey: ["/api/md", "assistant", "status"], queryFn: getStatus, staleTime: 30_000 });
  const speech = useSpeechOutput();
  const [speakAnswers, setSpeakAnswers] = usePersisted<boolean>(STORAGE_SPEAK, false, isBool);
  const [language, setLanguage] = usePersisted<VoiceLanguageChoice>(STORAGE_LANGUAGE, "en-IN", isLanguage);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastQuestion = useRef("");

  const speakRef = useRef(speakAnswers);
  speakRef.current = speakAnswers;
  const speakFn = speech.speak;
  const chat = useAssistantChat({
    onAnswered: (message: ChatMessage) => {
      // read aloud the answers to spoken questions, and every answer when "Reading aloud" is on
      if (message.inputMode === "voice" || speakRef.current) {
        const spoken = message.payload.spokenSummary;
        void speakFn(message.id, spoken || message.content, { markdown: !spoken });
      }
    },
  });

  const ready = !!status.data?.ready;
  const send = chat.send;
  const submit = useCallback(
    (text: string, inputMode: "text" | "voice" = "text", voice?: HeardPayload) => {
      lastQuestion.current = text;
      primeSpeech(); // inside the user's gesture, so a later spoken answer is allowed on iOS
      speech.stop();
      void send(text, { inputMode, language, voice });
    },
    [send, speech, language],
  );

  const voice = useVoiceInput({
    language,
    serverTranscription: !!status.data?.voice.serverTranscription,
    onBeforeListen: speech.stop,
    onResult: (text, confidence, source, heardLanguage) => {
      if (shouldAutoSend(text, confidence)) {
        setDraft("");
        submit(text, "voice", {
          language: heardLanguage,
          engine: source,
          ...(confidence ? { confidence } : {}),
        });
      } else {
        setDraft(text); // not sure enough: let the MD check the words before sending
        inputRef.current?.focus();
      }
    },
  });

  // A question handed over by an "Ask AI" button elsewhere in the portal.
  useEffect(() => {
    if (!prompt || chat.busy || !status.data) return;
    clearPendingPrompt(prompt.nonce);
    if (status.data.ready) submit(prompt.text);
  }, [prompt, chat.busy, status.data, submit]);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "end" });
  }, [chat.messages, reduce]);

  // Focus the question box when the panel opens; stop listening and talking when it closes.
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 260);
      return () => window.clearTimeout(t);
    }
    voice.cancel();
    speech.stop();
    setHistoryOpen(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving a page ends any reading aloud.
  useEffect(() => {
    speech.stop();
  }, [location]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentPage = mdPageForPath(location)?.id;
  const suggestions = useMemo(() => suggestionsFor(currentPage), [currentPage]);
  const firstName = (me.data?.name || user?.name || "").split(" ")[0];
  const limitHit = !!status.data?.usage.limitHit;
  const lastAssistantId = [...chat.messages].reverse().find((m) => m.role === "assistant")?.id;

  const onSpeak = (message: ChatMessage) => {
    const spoken = message.payload.spokenSummary;
    void speech.speak(message.id, spoken || message.content, { markdown: !spoken });
  };

  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    submit(text);
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[54] bg-[#003c64]/25 backdrop-blur-[2px] xl:hidden print:hidden"
            onClick={closeAssistant}
            aria-hidden
          />
        )}
      </AnimatePresence>
      <motion.aside
        role="dialog"
        aria-label="AI assistant"
        aria-hidden={!open}
        inert={!open}
        data-testid="assistant-panel"
        data-open={open}
        initial={false}
        animate={open ? { x: 0, opacity: 1 } : { x: 48, opacity: 0, transitionEnd: { visibility: "hidden" } }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 32 }}
        style={{ visibility: open ? "visible" : undefined }}
        onKeyDown={(e) => e.key === "Escape" && closeAssistant()}
        className="fixed inset-y-0 right-0 z-[55] flex w-full flex-col overflow-hidden bg-[#f6fafe] shadow-[-24px_0_60px_rgba(0,60,100,0.18)] sm:w-[428px] print:hidden"
      >
        {/* header */}
        <header className="relative flex items-center gap-2.5 border-b border-[#006496]/10 bg-white px-4 py-3">
          <AssistantAvatar size={36} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-black leading-tight text-[#1a3a4a]">AI Assistant</h2>
            <p
              className="flex items-center gap-1 truncate text-[11px] text-[#006496]/65"
              data-testid="assistant-subtitle"
              title="Read-only, names protected, and every answer explains how it was reached"
            >
              {status.data?.privacyMode === false ? (
                <>
                  <ShieldOff size={11} className="text-amber-600" /> Names are not hidden from Gemini
                </>
              ) : (
                <>
                  <ShieldCheck size={11} className="shrink-0 text-green-600" /> Read-only · names protected
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setHistoryOpen((v) => !v);
              if (!historyOpen) void chat.refreshHistory();
            }}
            aria-label="Conversation history"
            aria-expanded={historyOpen}
            data-testid="assistant-history"
            className="rounded-full p-2 text-[#006496]/70 transition-colors hover:bg-[#006496]/[0.07] hover:text-[#006496]"
          >
            <History size={17} />
          </button>
          <button
            type="button"
            onClick={() => {
              chat.newChat();
              setHistoryOpen(false);
              inputRef.current?.focus();
            }}
            aria-label="New conversation"
            title="New conversation"
            data-testid="assistant-new"
            className="rounded-full p-2 text-[#006496]/70 transition-colors hover:bg-[#006496]/[0.07] hover:text-[#006496]"
          >
            <MessageSquarePlus size={17} />
          </button>
          <button
            type="button"
            onClick={closeAssistant}
            aria-label="Close assistant"
            data-testid="assistant-close"
            className="rounded-full p-2 text-[#006496]/70 transition-colors hover:bg-[#006496]/[0.07] hover:text-[#006496]"
          >
            <X size={18} />
          </button>

          <AnimatePresence>
            {historyOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16 }}
                className="absolute inset-x-3 top-full z-10 mt-1 max-h-[55vh] overflow-y-auto rounded-2xl border border-[#006496]/12 bg-white p-1.5 shadow-xl"
                data-testid="assistant-history-list"
              >
                {chat.history.length === 0 && (
                  <p className="px-3 py-4 text-center text-[12.5px] text-[#006496]/55">
                    {chat.historyLoading ? "Loading…" : "No earlier conversations."}
                  </p>
                )}
                {chat.history.map((c) => (
                  <div key={c.id} className="group flex items-center gap-1 rounded-xl hover:bg-[#006496]/[0.05]">
                    <button
                      type="button"
                      onClick={() => {
                        void chat.openConversation(c.id);
                        setHistoryOpen(false);
                      }}
                      className="min-w-0 flex-1 px-3 py-2 text-left"
                    >
                      <span className="block truncate text-[13px] font-semibold text-[#1a3a4a]">{c.title}</span>
                      <span className="block text-[10.5px] text-[#006496]/50">
                        {c.updatedAt?.replace("T", " ").slice(0, 16)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void chat.removeConversation(c.id)}
                      aria-label={`Delete conversation: ${c.title}`}
                      className="mr-1 rounded-full p-1.5 text-[#006496]/40 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {chat.history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void chat.clearAll()}
                    className="mt-1 w-full rounded-xl px-3 py-2 text-left text-[12px] font-semibold text-red-700 hover:bg-red-50"
                  >
                    Delete all conversations
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </header>

        {/* conversation */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="assistant-scroll">
          {status.data && !status.data.enabled && <SetupNotice kind="disabled" />}
          {status.data && status.data.enabled && !status.data.configured && <SetupNotice kind="not_configured" />}
          {limitHit && <SetupNotice kind="limit" resetsAt={status.data?.usage.resetsAt} />}

          {chat.messages.length === 0 ? (
            <div className="flex flex-col items-center px-5 pb-4 pt-8 text-center" data-testid="assistant-empty">
              <GlowOrb />
              <h3 className="mt-4 text-[19px] font-black text-[#1a3a4a]">
                {greeting(me.data?.serverTime)}
                {firstName ? `, ${firstName}` : ""}
              </h3>
              <p className="mt-1.5 max-w-[320px] text-[13px] leading-relaxed text-[#1a3a4a]/70">
                Ask me about your workforce, attendance, payroll, hiring or the gate. I read your live data, show how I
                worked it out, and never change anything.
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[10.5px] font-bold text-[#7a5410]">
                {["Type or speak", "English · தமிழ் · हिन्दी", "Explains its answers"].map((t) => (
                  <span key={t} className="rounded-full bg-[#fff1cc] px-2.5 py-1">
                    {t}
                  </span>
                ))}
              </div>
              <p className="mb-2 mt-6 flex items-center gap-1.5 self-start text-[10.5px] font-extrabold uppercase tracking-widest text-[#006496]/50">
                <Sparkles size={11} className="text-[#c18a1f]" /> Try asking
              </p>
              <ul className="w-full space-y-2">
                {suggestions.map((text, i) => (
                  <motion.li
                    key={text}
                    initial={reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 + i * 0.05 }}
                  >
                    <button
                      type="button"
                      disabled={!ready || chat.busy}
                      onClick={() => submit(text)}
                      data-testid="assistant-suggestion"
                      className="w-full rounded-xl border border-[#006496]/12 bg-white px-3.5 py-2.5 text-left text-[13px] font-medium text-[#1a3a4a] shadow-sm transition-all enabled:hover:-translate-y-px enabled:hover:border-[#e0a83a]/60 enabled:hover:shadow-md disabled:opacity-50"
                    >
                      {text}
                    </button>
                  </motion.li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-4 px-4 py-4" data-testid="assistant-messages">
              {chat.messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  isLast={message.id === lastAssistantId}
                  speakingId={speech.speakingId}
                  speechSupported={speech.supported}
                  onSpeak={onSpeak}
                  onStopSpeaking={speech.stop}
                  onFollowUp={(text) => submit(text)}
                  onOpenPage={(path) => {
                    speech.stop();
                    navigate(path);
                  }}
                  onRetry={() => lastQuestion.current && submit(lastQuestion.current)}
                />
              ))}
              {speech.notice && (
                <p
                  className="rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900"
                  role="status"
                  data-testid="assistant-speech-notice"
                >
                  {speech.notice}
                </p>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={sendDraft}
          onStop={() => void chat.stop()}
          busy={chat.busy}
          ready={ready}
          maxChars={status.data?.limits.questionChars ?? 2000}
          voice={voice}
          language={language}
          onLanguage={setLanguage}
          speakAnswers={speakAnswers}
          onSpeakAnswers={(on) => {
            setSpeakAnswers(on);
            if (!on) speech.stop();
            else primeSpeech();
          }}
          speechSupported={speech.supported}
          inputRef={inputRef}
        />
      </motion.aside>
    </>
  );
}
