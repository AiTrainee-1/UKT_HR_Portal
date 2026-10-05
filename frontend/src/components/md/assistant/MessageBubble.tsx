import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ArrowUpRight, Check, Copy, Mic, RotateCcw, Sparkles, Square, Volume2 } from "lucide-react";
import { clockText } from "@/lib/md/format";
import { stripMarkdown } from "@/lib/md/markdown";
import { describeHeard } from "@/lib/md/voice";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "./api";
import Explainer, { ConfidenceChip } from "./Explainer";
import Markdown from "./Markdown";
import ProgressList from "./ProgressList";

export function AssistantAvatar({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-[#5b3d00] shadow-sm ring-2 ring-white",
        className,
      )}
      style={{ width: size, height: size, background: "linear-gradient(135deg, #f6d27a 0%, #e0a83a 100%)" }}
      aria-hidden
    >
      <Sparkles size={Math.round(size * 0.52)} strokeWidth={2.2} />
    </span>
  );
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
  const btn =
    "flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold text-[#006496]/70 transition-colors hover:bg-[#006496]/[0.07] hover:text-[#006496]";
  return (
    <div className="flex flex-wrap items-center gap-1">
      {speechSupported && (
        <button
          type="button"
          onClick={speaking ? onStop : onSpeak}
          className={btn}
          data-testid="assistant-listen"
          aria-label={speaking ? "Stop reading" : "Read aloud"}
        >
          {speaking ? <Square size={12} className="fill-current" /> : <Volume2 size={13} />}
          {speaking ? "Stop" : "Listen"}
        </button>
      )}
      <button type="button" onClick={copy} className={btn} aria-label="Copy answer">
        {copied ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <ConfidenceChip payload={message.payload} />
      {message.finishedAt && (
        <span className="ml-auto text-[10.5px] text-[#006496]/45">{clockText(message.finishedAt)}</span>
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
      <motion.div {...enter} className="flex flex-col items-end gap-1" data-testid="assistant-user-message">
        <div
          className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm"
          style={{ background: "linear-gradient(135deg, #006496 0%, #0888b8 100%)" }}
        >
          {message.inputMode === "voice" && (
            <Mic size={11} className="mr-1.5 inline -translate-y-px opacity-80" aria-label="Asked by voice" />
          )}
          {message.content}
        </div>
        {heard && (
          <p className="max-w-[88%] text-right text-[10.5px] text-[#006496]/55" data-testid="assistant-heard">
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
      <AssistantAvatar className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        {running && (
          <div className="rounded-2xl rounded-tl-md border border-[#006496]/10 bg-white px-3.5 py-3 shadow-sm">
            <ProgressList lines={payload.progress ?? []} />
          </div>
        )}

        {message.status === "error" && payload.errorKind === "cancelled" && (
          <div className="flex items-center gap-2 px-1 text-[12px] text-[#006496]/65" data-testid="assistant-stopped">
            <Square size={11} className="fill-current" /> You stopped this answer.
            {isLast && (
              <button type="button" onClick={onRetry} className="font-bold text-[#006496] hover:underline">
                Ask again
              </button>
            )}
          </div>
        )}

        {message.status === "error" && payload.errorKind !== "cancelled" && (
          <div
            className="rounded-2xl rounded-tl-md border border-red-200 bg-red-50 px-3.5 py-3 text-red-900"
            role="alert"
            data-testid="assistant-error"
          >
            <p className="flex items-start gap-2 text-[13px]">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{message.error || "The assistant could not answer."}</span>
            </p>
            {isLast && payload.errorKind !== "disabled" && payload.errorKind !== "not_configured" && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11.5px] font-bold text-red-800 shadow-sm hover:bg-red-100"
              >
                <RotateCcw size={12} /> Try again
              </button>
            )}
          </div>
        )}

        {message.status === "done" && (
          <>
            <div className="rounded-2xl rounded-tl-md border border-[#006496]/10 bg-white px-3.5 py-3 shadow-sm">
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
              <div className="space-y-1.5" data-testid="assistant-pages">
                {payload.suggestedPages.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => onOpenPage(page.path)}
                    className="group flex w-full items-center gap-2.5 rounded-xl border border-[#e0a83a]/35 bg-gradient-to-r from-[#fff8e6] to-white px-3 py-2 text-left transition-all hover:border-[#e0a83a]/70 hover:shadow-sm"
                    data-testid={`assistant-page-${page.id}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-bold text-[#7a5410]">{page.title}</span>
                      <span className="block truncate text-[11.5px] text-[#7a5410]/75">{page.reason}</span>
                    </span>
                    <ArrowUpRight
                      size={15}
                      className="shrink-0 text-[#c18a1f] transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                    />
                  </button>
                ))}
              </div>
            )}
            <Explainer payload={payload} />
            {isLast && !!payload.followUps?.length && (
              <div className="flex flex-wrap gap-1.5" data-testid="assistant-followups">
                {payload.followUps.map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => onFollowUp(text)}
                    className="rounded-full border border-[#006496]/20 bg-white px-2.5 py-1 text-left text-[11.5px] font-semibold text-[#006496] transition-colors hover:border-[#006496]/45 hover:bg-[#006496]/[0.05]"
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
