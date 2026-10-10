// The AI assistant's side panel: always mounted for the MD while they are in the portal (so the conversation survives
// moving between pages) and slid in and out. Text and voice in, text and voice out, every answer with its explanation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  ArrowUp,
  History,
  KeyRound,
  Languages,
  ListChecks,
  MessageSquarePlus,
  Mic,
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
import { RadioMascot } from "./mascot";
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

/** The welcome: the radio character (it follows the pointer and can be poked) on a frosted disc in a soft wine glow. */
function GlowOrb() {
  return (
    <div className="relative flex h-36 w-36 items-center justify-center">
      <span className="md-assistant-orb-glow absolute -inset-5 rounded-full" aria-hidden />
      <span className="md-assistant-orb-disc absolute inset-3 rounded-full" aria-hidden />
      <span className="md-assistant-orb-ring absolute inset-1 rounded-full" aria-hidden />
      <RadioMascot size={108} label="AI assistant" className="relative" />
    </div>
  );
}

const SETUP_TITLE = {
  not_configured: "Setup needed",
  disabled: "Switched off",
  limit: "Daily allowance used",
} as const;

/** A notice about the assistant itself (no key, switched off, out of allowance): a sand panel with an ochre tile. */
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
      className="md-panel-sand mx-4 mt-4 flex gap-3 p-3.5 text-[12.5px] leading-relaxed text-md-warning-800"
      data-testid="assistant-setup"
      role="status"
    >
      <span className="md-icon-tile md-assistant-notice-icon h-8 w-8 shrink-0">
        <Icon size={15} />
      </span>
      <div className="min-w-0">
        <p className="font-extrabold text-md-warning-900">{SETUP_TITLE[kind]}</p>
        <p className="mt-0.5">{text}</p>
      </div>
    </div>
  );
}

const CAPABILITIES = [
  { icon: Mic, text: "Type or speak" },
  { icon: Languages, text: "English · தமிழ் · हिन्दी" },
  { icon: ListChecks, text: "Explains its answers" },
];

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
            className="fixed inset-0 z-[54] bg-md-ink/30 backdrop-blur-[3px] xl:hidden print:hidden"
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
        className="md-assistant-panel fixed inset-y-0 right-0 z-[55] flex w-full flex-col overflow-hidden sm:w-[428px] print:hidden"
      >
        {/* header: the face, the title, and three round ghost buttons */}
        <header className="md-assistant-header relative flex items-center gap-2.5 px-4 py-3">
          <AssistantAvatar size={42} mood={chat.busy ? "working" : "idle"} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15.5px] font-black leading-tight tracking-tight text-md-ink">AI Assistant</h2>
            <p
              className="mt-1 flex min-w-0"
              data-testid="assistant-subtitle"
              title="Read-only, names protected, and every answer explains how it was reached"
            >
              {status.data?.privacyMode === false ? (
                <span className="md-chip md-chip-warning min-w-0 max-w-full">
                  <ShieldOff size={11} className="shrink-0" />
                  <span className="truncate">Names are not hidden from Gemini</span>
                </span>
              ) : (
                <span className="md-chip md-chip-success min-w-0 max-w-full">
                  <ShieldCheck size={11} className="shrink-0" />
                  <span className="truncate">Read-only · names protected</span>
                </span>
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
            className="md-btn md-btn-ghost md-btn-icon md-assistant-iconbtn"
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
            className="md-btn md-btn-ghost md-btn-icon md-assistant-iconbtn"
          >
            <MessageSquarePlus size={17} />
          </button>
          <button
            type="button"
            onClick={closeAssistant}
            aria-label="Close assistant"
            data-testid="assistant-close"
            className="md-btn md-btn-ghost md-btn-icon md-assistant-iconbtn"
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
                className="md-assistant-menu absolute inset-x-3 top-full z-10 mt-2 max-h-[55vh] overflow-y-auto p-1.5"
                data-testid="assistant-history-list"
              >
                {chat.history.length === 0 && (
                  <p className="px-3 py-5 text-center text-[13px] text-md-ink-soft">
                    {chat.historyLoading ? "Loading…" : "No earlier conversations."}
                  </p>
                )}
                {chat.history.map((c) => (
                  <div key={c.id} className="md-assistant-menu-row group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        void chat.openConversation(c.id);
                        setHistoryOpen(false);
                      }}
                      className="min-w-0 flex-1 rounded-xl px-3 py-2 text-left"
                    >
                      <span className="block truncate text-[13px] font-semibold text-md-ink">{c.title}</span>
                      <span className="block text-[11px] tabular-nums text-md-ink-soft">
                        {c.updatedAt?.replace("T", " ").slice(0, 16)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void chat.removeConversation(c.id)}
                      aria-label={`Delete conversation: ${c.title}`}
                      className="md-btn md-btn-ghost md-btn-icon md-assistant-iconbtn md-assistant-iconbtn-danger mr-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                {chat.history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void chat.clearAll()}
                    className="md-btn md-btn-danger md-btn-sm mt-1.5 w-full"
                  >
                    Delete all conversations
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </header>

        {/* conversation */}
        <div
          className="md-assistant-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-testid="assistant-scroll"
        >
          {status.data && !status.data.enabled && <SetupNotice kind="disabled" />}
          {status.data && status.data.enabled && !status.data.configured && <SetupNotice kind="not_configured" />}
          {limitHit && <SetupNotice kind="limit" resetsAt={status.data?.usage.resetsAt} />}

          {chat.messages.length === 0 ? (
            <div className="flex flex-col items-center px-5 pb-6 pt-7 text-center" data-testid="assistant-empty">
              <GlowOrb />
              <h3 className="mt-3 text-[22px] font-black leading-tight tracking-tight text-md-ink">
                {greeting(me.data?.serverTime)}
                {firstName ? `, ${firstName}` : ""}
              </h3>
              <p className="mt-2 max-w-[330px] text-[13.5px] leading-relaxed text-md-ink-soft">
                Ask me about your workforce, attendance, payroll, hiring or the gate. I read your live data, show how I
                worked it out, and never change anything.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {CAPABILITIES.map(({ icon: Icon, text }) => (
                  <span key={text} className="md-chip md-chip-sand">
                    <Icon size={12} aria-hidden />
                    {text}
                  </span>
                ))}
              </div>
              <div className="mb-3 mt-7 flex items-center gap-2.5 self-stretch">
                <p className="md-assistant-overline">
                  <Sparkles size={12} className="text-md-wine" aria-hidden /> Try asking
                </p>
                <span className="h-px flex-1 bg-md-line" aria-hidden />
              </div>
              <ul className="w-full space-y-2.5">
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
                      className="md-assistant-suggest"
                    >
                      <span className="md-icon-tile md-assistant-tile-sm h-8 w-8 shrink-0">
                        <Sparkles size={14} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">{text}</span>
                      <ArrowUp size={16} className="md-assistant-suggest-go" aria-hidden />
                    </button>
                  </motion.li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-5 px-4 py-5" data-testid="assistant-messages">
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
                  className="md-panel-sand px-3 py-2 text-[12px] leading-snug text-md-warning-800"
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
