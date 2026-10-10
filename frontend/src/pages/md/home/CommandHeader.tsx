import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { suggestionsFor } from "@/components/md/assistant/suggestions";
import { MD_GOLD_GRADIENT } from "@/components/md/MdSidebar";
import { openAssistant } from "@/lib/md/assistant-store";
import { cn } from "@/lib/utils";
import { greetingLine } from "../dashboard/logic";

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
 * The hero under the dashboard's title row: the greeting (by the factory's clock), what wants attention today, and the Ask
 * bar. A question typed here, or one of the suggestions, opens the assistant with it. (The title row, with the date, "Brief
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

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    openAssistant(text);
    setQuestion("");
  };

  return (
    <section
      className="relative overflow-hidden rounded-3xl px-5 py-6 text-white shadow-[0_18px_40px_rgba(4,50,74,0.28)] sm:px-8 sm:py-7"
      style={{ background: "linear-gradient(130deg, #04324a 0%, #07577d 52%, #0f86b6 100%)" }}
      data-testid="md-home-header"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-[#e0a83a]/20 blur-2xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-28 left-1/3 h-56 w-56 rounded-full bg-white/10 blur-2xl"
      />
      <div className="relative space-y-5">
        <div className="min-w-0">
          <h3 className="text-2xl font-black leading-tight sm:text-4xl" data-testid="md-home-greeting">
            {serverTime ? greetingLine(serverTime, name) : "Welcome back"}
          </h3>
          <p
            className={cn(
              "mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-semibold",
              pulse.calm ? "bg-green-400/20 text-green-100" : "bg-[#e0a83a]/25 text-[#ffe9b0]",
            )}
            data-testid="md-home-pulse"
          >
            <span className={cn("h-2 w-2 rounded-full", pulse.calm ? "bg-green-300" : "bg-[#f6d27a]")} />
            {pulse.text}
          </p>
        </div>

        <form onSubmit={ask} className="space-y-2.5" role="search" data-testid="md-home-ask">
          <label className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-[#1a3a4a] shadow-lg ring-1 ring-white/40 focus-within:ring-2 focus-within:ring-[#e0a83a]">
            <Search size={18} className="shrink-0 text-[#006496]/60" />
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask anything about the company… for example: why is absenteeism up this week?"
              aria-label="Ask the AI assistant"
              data-testid="md-home-ask-input"
              className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[#006496]/40"
            />
            <button
              type="submit"
              disabled={!question.trim()}
              data-testid="md-home-ask-send"
              className="shrink-0 rounded-xl px-4 py-1.5 text-sm font-black text-[#5b3d00] transition disabled:opacity-40"
              style={{ background: MD_GOLD_GRADIENT }}
            >
              Ask
            </button>
          </label>
          <div className="flex flex-wrap gap-2" data-testid="md-home-suggestions">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => openAssistant(text)}
                className="rounded-full bg-white/12 px-3 py-1 text-[12px] font-medium text-white/90 ring-1 ring-white/20 transition hover:bg-white/20"
              >
                {text}
              </button>
            ))}
          </div>
        </form>
      </div>
    </section>
  );
}
