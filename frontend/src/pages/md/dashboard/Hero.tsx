import { RefreshCw, Sparkles } from "lucide-react";
import { openAssistant } from "@/lib/md/assistant-store";
import { clockText } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { BRIEFING_QUESTION, greetingLine, longDate } from "./logic";

/**
 * The first thing the MD sees on the older single-column dashboard: a greeting by the factory's clock, today's date, when
 * the numbers were made (with a refresh) and the "Brief me" button, which opens the assistant with the briefing question.
 * The same aurora glass as the routed dashboard's welcome card (the shared md-hero-* classes, md-theme/glass.css).
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
    <section className="md-hero-glass" data-testid="md-dashboard-hero">
      <span aria-hidden className="md-hero-orb md-hero-orb-wine" />
      <span aria-hidden className="md-hero-orb md-hero-orb-indigo" />
      <span aria-hidden className="md-hero-orb md-hero-orb-sand" />
      <div className="md-hero-sheet flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {date && (
            <p className="md-dashboard-overline" data-testid="md-dashboard-date">
              {date}
            </p>
          )}
          <h2 className="md-hero-title md-dashboard-greeting mt-2 text-2xl sm:text-3xl" data-testid="md-page-title">
            {serverTime ? greetingLine(serverTime, name) : "Welcome back"}
          </h2>
          <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm font-medium text-md-ink-soft">
            <span>Here is how the company is doing.</span>
            <span className="inline-flex items-center gap-1.5" data-testid="md-updated">
              {generatedAt ? `Numbers as of ${clockText(generatedAt)}` : "Getting the numbers…"}
              <button
                type="button"
                onClick={onRefresh}
                aria-label="Refresh the numbers"
                title="Refresh the numbers"
                data-testid="md-dashboard-refresh"
                className="md-btn md-btn-ghost md-btn-icon"
              >
                <RefreshCw size={14} aria-hidden className={cn(refreshing && "animate-spin")} />
              </button>
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => openAssistant(BRIEFING_QUESTION)}
          data-testid="md-brief-me"
          className="md-btn md-btn-primary md-btn-lg w-full shrink-0 sm:w-auto"
        >
          <Sparkles size={16} aria-hidden />
          Brief me
        </button>
      </div>
    </section>
  );
}
