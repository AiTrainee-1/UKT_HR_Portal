import { RefreshCw, Sparkles } from "lucide-react";
import { MD_GOLD_GRADIENT } from "@/components/md/MdSidebar";
import { openAssistant } from "@/lib/md/assistant-store";
import { clockText } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { BRIEFING_QUESTION, greetingLine, longDate } from "./logic";

/**
 * The first thing the MD sees: a greeting by the factory's clock, today's date, when the numbers were made (with a
 * refresh) and the gold "Brief me" button, which opens the assistant with the briefing question.
 */
export default function Hero({
  name,
  serverTime,
  today,
  generatedAt,
  refreshing,
  onRefresh,
}: {
  /** The MD's name from /api/md/me; undefined while that loads. */
  name: string | undefined;
  serverTime: string | undefined;
  /** The factory's date, "2026-10-05". */
  today: string | undefined;
  /** When the numbers were made, "2026-10-05T10:42:10"; undefined until the first answer. */
  generatedAt: string | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const date = longDate(today ?? serverTime);
  return (
    <section
      className="relative overflow-hidden rounded-3xl px-5 py-5 text-white shadow-[0_14px_34px_rgba(0,100,150,0.22)] sm:px-7 sm:py-6"
      style={{ background: "linear-gradient(125deg, #0a5a82 0%, #0b78a8 55%, #2a9fcd 100%)" }}
      data-testid="md-dashboard-hero"
    >
      <span aria-hidden className="pointer-events-none absolute -right-14 -top-20 h-60 w-60 rounded-full bg-white/10" />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-24 right-24 h-48 w-48 rounded-full bg-white/5"
      />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {date && (
            <p
              className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/80"
              data-testid="md-dashboard-date"
            >
              {date}
            </p>
          )}
          <h2 className="mt-1 text-2xl font-black leading-tight sm:text-3xl" data-testid="md-page-title">
            {serverTime ? greetingLine(serverTime, name) : "Welcome back"}
          </h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-white/90">
            <span>Here is how the company is doing.</span>
            <span className="inline-flex items-center gap-1.5 text-white/85" data-testid="md-updated">
              {generatedAt ? `Numbers as of ${clockText(generatedAt)}` : "Getting the numbers…"}
              <button
                type="button"
                onClick={onRefresh}
                aria-label="Refresh the numbers"
                title="Refresh the numbers"
                data-testid="md-dashboard-refresh"
                className="rounded-full p-1 text-white/85 transition-colors hover:bg-white/15 hover:text-white"
              >
                <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
              </button>
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => openAssistant(BRIEFING_QUESTION)}
          data-testid="md-brief-me"
          className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-2xl px-6 py-3 text-sm font-black text-[#5b3d00] shadow-lg transition-transform hover:scale-[1.03] active:scale-100 sm:w-auto"
          style={{ background: MD_GOLD_GRADIENT }}
        >
          <Sparkles size={16} />
          Brief me
        </button>
      </div>
    </section>
  );
}
