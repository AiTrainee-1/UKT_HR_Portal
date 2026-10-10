import { useState, type FormEvent } from "react";
import { ArrowUp, Search, Sparkles } from "lucide-react";
import { suggestionsFor } from "@/components/md/assistant/suggestions";
import { openAssistant } from "@/lib/md/assistant-store";
import { cn } from "@/lib/utils";
import { greetingLine, longDate } from "../dashboard/logic";

/** How the header sums the day up: the requests waiting (for HR or a Department Head; the MD looks at them) and the things
 *  that want a look. */
export function pulseSentence(attention: number, waiting: number): { text: string; calm: boolean } {
  if (attention === 0 && waiting === 0) return { text: "All quiet: nothing needs you right now.", calm: true };
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} request${waiting === 1 ? "" : "s"} waiting`);
  if (attention > 0) parts.push(`${attention} thing${attention === 1 ? "" : "s"} to look at`);
  return { text: parts.join(" · "), calm: false };
}

/**
 * The welcome card under the dashboard's title row: a frosted glass sheet floating over a slow aurora of wine, indigo and
 * sand (the shared md-hero-* classes, md-theme/glass.css). On the sheet, in three layers with room between them: the date
 * and the greeting (by the factory's clock) with what wants attention today; the Ask bar, the focal point; and a few
 * suggested questions. A question typed here, or a suggestion, opens the assistant with it. (The title row, with "Brief
 * me" and Refresh, is the same one every MD page has: see index.tsx.)
 */
export default function CommandHeader({
  name,
  serverTime,
  attention,
  waiting,
}: {
  name: string | undefined;
  serverTime: string | undefined;
  /** Exceptions across the company (the dashboard's total). */
  attention: number;
  /** Leave, permission and outpass requests still pending. */
  waiting: number;
}) {
  const [question, setQuestion] = useState("");
  const pulse = pulseSentence(attention, waiting);
  const suggestions = suggestionsFor("dashboard").slice(0, 4);
  const date = longDate(serverTime);

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    openAssistant(text);
    setQuestion("");
  };

  return (
    <section className="md-hero-glass" data-testid="md-home-header">
      <span aria-hidden className="md-hero-orb md-hero-orb-wine" />
      <span aria-hidden className="md-hero-orb md-hero-orb-indigo" />
      <span aria-hidden className="md-hero-orb md-hero-orb-sand" />

      <div className="md-hero-sheet md-dashboard-hero-sheet space-y-7 sm:space-y-8">
        <div className="min-w-0 space-y-3.5">
          {date && <p className="md-dashboard-overline">{date}</p>}
          <h1
            className="md-hero-title md-dashboard-greeting text-[2rem] sm:text-4xl lg:text-5xl"
            data-testid="md-home-greeting"
          >
            {serverTime ? greetingLine(serverTime, name) : "Welcome back"}
          </h1>
          <p className={cn("md-hero-chip", !pulse.calm && "md-hero-chip-wine")} data-testid="md-home-pulse">
            <span aria-hidden className="relative flex h-2 w-2">
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping",
                  pulse.calm ? "bg-md-success-500" : "bg-md-wine",
                )}
              />
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full",
                  pulse.calm ? "bg-md-success-500" : "bg-md-wine",
                )}
              />
            </span>
            {pulse.text}
          </p>
        </div>

        <form onSubmit={ask} className="space-y-4" role="search" data-testid="md-home-ask">
          <label className="md-hero-ask">
            <Search size={20} className="shrink-0 text-md-wine" aria-hidden />
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask anything about the company… for example: why is absenteeism up this week?"
              aria-label="Ask the AI assistant"
              data-testid="md-home-ask-input"
              className="md-dashboard-ask-input min-w-0 flex-1 truncate border-0 bg-transparent py-1.5 text-base text-md-ink outline-none"
            />
            <button
              type="submit"
              disabled={!question.trim()}
              data-testid="md-home-ask-send"
              className="md-btn md-btn-primary md-btn-lg shrink-0"
            >
              Ask <ArrowUp size={15} aria-hidden />
            </button>
          </label>
          <div className="flex flex-wrap gap-2.5" data-testid="md-home-suggestions">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => openAssistant(text)}
                className="md-hero-suggestion inline-flex min-h-9 items-center gap-1.5 text-left"
              >
                <Sparkles size={12} className="shrink-0 text-md-wine" aria-hidden />
                {text}
              </button>
            ))}
          </div>
        </form>
      </div>
    </section>
  );
}
