import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ArrowUpRight, Check, Compass, Copy, Mic, RotateCcw, Square, Volume2 } from "lucide-react";
import { clockText } from "@/lib/md/format";
import { stripMarkdown } from "@/lib/md/markdown";
import { describeHeard } from "@/lib/md/voice";
import type { ChatMessage } from "./api";
import Explainer, { ConfidenceChip } from "./Explainer";
import Markdown from "./Markdown";
import { MascotFace, type MascotMood } from "./mascot";
import ProgressList from "./ProgressList";

/** The assistant's face (the radio character, see ./mascot.tsx); its expression follows what the assistant is doing. */
export function AssistantAvatar({
  size = 28,
  mood = "idle",
  className,
}: {
  size?: number;
  mood?: MascotMood;
  className?: string;
}) {
  return <MascotFace size={size} mood={mood} className={className} />;
}

/** Working on it while the answer is made, dizzy when it went wrong, asleep when the MD stopped it. */
function moodOf(message: ChatMessage): MascotMood {
  if (message.status === "pending" || message.status === "running") return "working";
  if (message.status === "error") return message.payload.errorKind === "cancelled" ? "stopped" : "error";
  return "idle";
}

export type MessageBubbleProps = {
  message: ChatMessage;
  /** The last assistant message: only it offers "Try again". */
  isLast: boolean;
  speakingId: string | number | null;
  speechSupported: boolean;
  onSpeak: (message: ChatMessage) => void;
  onStopSpeaking: () => void;
  onFollowUp: (text: string) => void;
  onOpenPage: (path: string) => void;
  onRetry: () => void;
};

/** Listen and copy (ghost glass buttons), the confidence chip and the time, under an answer. */
function Actions({
  message,
  speaking,
  speechSupported,
  onSpeak,
  onStop,
}: {
  message: ChatMessage;
  speaking: boolean;
  speechSupported: boolean;
  onSpeak: () => void;
  onStop: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stripMarkdown(message.content));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: nothing to do
    }
  };
  const btn = "md-btn md-btn-ghost md-btn-sm md-assistant-act";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {speechSupported && (
        <button
          type="button"
          onClick={speaking ? onStop : onSpeak}
          className={btn}
          data-active={speaking}
          data-testid="assistant-listen"
          aria-label={speaking ? "Stop reading" : "Read aloud"}
        >
          {speaking ? <Square size={12} className="fill-current" /> : <Volume2 size={13} />}
          {speaking ? "Stop" : "Listen"}
        </button>
      )}
      <button type="button" onClick={copy} className={btn} aria-label="Copy answer">
        {copied ? <Check size={13} className="text-md-success" /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <ConfidenceChip payload={message.payload} />
      {message.finishedAt && (
        <span className="ml-auto text-[11px] tabular-nums text-md-ink-soft">{clockText(message.finishedAt)}</span>
      )}
    </div>
  );
}

export default function MessageBubble(props: MessageBubbleProps) {
  const { message, isLast, speakingId, speechSupported, onSpeak, onStopSpeaking, onFollowUp, onOpenPage, onRetry } =
    props;
  const reduce = useReducedMotion();
  const enter = reduce
    ? {}
    : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.24 } };

  if (message.role === "user") {
    const heard = message.inputMode === "voice" ? describeHeard(message.payload.voice) : null;
    return (
      <motion.div {...enter} className="flex flex-col items-end gap-1.5" data-testid="assistant-user-message">
        {/* the MD's own words: a wine glass bubble, white text */}
        <div className="md-assistant-user max-w-[88%] whitespace-pre-wrap break-words px-4 py-2.5 text-[13.5px] leading-relaxed">
          {message.inputMode === "voice" && (
            <Mic size={12} className="mr-1.5 inline -translate-y-px opacity-85" aria-label="Asked by voice" />
          )}
          {message.content}
        </div>
        {heard && (
          <p className="max-w-[88%] text-right text-[11px] text-md-ink-soft" data-testid="assistant-heard">
            {heard}
          </p>
        )}
      </motion.div>
    );
  }

  const { payload } = message;
  const running = message.status === "pending" || message.status === "running";

  return (
    <motion.div {...enter} className="flex gap-2.5" data-testid="assistant-reply" data-status={message.status}>
      <AssistantAvatar className="mt-0.5" size={32} mood={moodOf(message)} />
      <div className="min-w-0 flex-1 space-y-2.5">
        {running && (
          <div className="md-card md-card-strong md-assistant-answer md-assistant-working px-4 py-3.5">
            <ProgressList lines={payload.progress ?? []} />
          </div>
        )}

        {message.status === "error" && payload.errorKind === "cancelled" && (
          <div className="flex items-center gap-2 px-1 text-[12.5px] text-md-ink-soft" data-testid="assistant-stopped">
            <Square size={11} className="fill-current" /> You stopped this answer.
            {isLast && (
              <button
                type="button"
                onClick={onRetry}
                className="md-btn md-btn-ghost md-btn-sm md-assistant-act md-assistant-act-wine"
              >
                Ask again
              </button>
            )}
          </div>
        )}

        {message.status === "error" && payload.errorKind !== "cancelled" && (
          <div className="md-assistant-error px-4 py-3.5" role="alert" data-testid="assistant-error">
            <p className="flex items-start gap-2 text-[13px] font-semibold leading-snug">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{message.error || "The assistant could not answer."}</span>
            </p>
            {isLast && payload.errorKind !== "disabled" && payload.errorKind !== "not_configured" && (
              <button
                type="button"
                onClick={onRetry}
                className="md-btn md-btn-danger md-btn-sm md-assistant-act mt-2.5"
              >
                <RotateCcw size={12} /> Try again
              </button>
            )}
          </div>
        )}

        {message.status === "done" && (
          <>
            <div className="md-card md-card-strong md-assistant-answer px-4 py-3.5">
              <Markdown text={message.content} />
            </div>
            <Actions
              message={message}
              speaking={speakingId === message.id}
              speechSupported={speechSupported}
              onSpeak={() => onSpeak(message)}
              onStop={onStopSpeaking}
            />
            {!!payload.suggestedPages?.length && (
              <div className="space-y-2" data-testid="assistant-pages">
                <p className="md-assistant-overline px-0.5">Related pages</p>
                {payload.suggestedPages.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => onOpenPage(page.path)}
                    className="md-assistant-page group"
                    data-testid={`assistant-page-${page.id}`}
                  >
                    <span className="md-icon-tile md-assistant-tile-sm h-8 w-8 shrink-0">
                      <Compass size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold leading-snug text-md-ink">{page.title}</span>
                      <span className="block truncate text-[12px] text-md-ink-soft">{page.reason}</span>
                    </span>
                    <ArrowUpRight
                      size={16}
                      className="shrink-0 text-md-wine-600 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                    />
                  </button>
                ))}
              </div>
            )}
            <Explainer payload={payload} />
            {isLast && !!payload.followUps?.length && (
              <div className="flex flex-wrap gap-2" data-testid="assistant-followups">
                {payload.followUps.map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => onFollowUp(text)}
                    className="md-chip md-assistant-chipbtn"
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
