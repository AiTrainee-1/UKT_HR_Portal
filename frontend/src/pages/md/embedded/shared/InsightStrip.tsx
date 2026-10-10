import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import type { Tone } from "@/lib/md/format";
import type { MdInsightDto } from "@/lib/md/types";
import { cn } from "@/lib/utils";

// The pieces of the "MD insights" strip that sits above an embedded HR page (Geo Attendance, Report Log): a glass bar with
// the page's headline figures, its top exceptions and "Ask AI about this page". One look, so every strip reads the same.

const SEVERITY: Record<MdInsightDto["severity"], { tone: string; label: string }> = {
  critical: { tone: "md-analytics-tone-bad", label: "Critical" },
  warning: { tone: "md-analytics-tone-watch", label: "Needs attention" },
  info: { tone: "md-analytics-tone-info", label: "For your information" },
  good: { tone: "md-analytics-tone-good", label: "Good news" },
};

const DELTA_TONE: Record<Tone, string> = {
  good: "md-analytics-tone-good",
  bad: "md-analytics-tone-bad",
  neutral: "md-analytics-tone-neutral",
};

/** The strip itself: the "MD insights" overline, what goes in the bar (figures, as children), then Ask AI. The exceptions
 *  list and any footnote follow as `below`. */
export function StripShell({
  testId,
  question,
  loading,
  children,
  below,
}: {
  testId: string;
  question: string;
  loading?: boolean;
  children?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="md-card md-analytics-strip" data-testid={testId}>
      <div className="md-analytics-strip-head">
        <span className="md-analytics-overline">
          <span className="md-icon-tile md-icon-tile-solid md-analytics-overline-icon" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          MD insights
        </span>
        {loading && <span className="md-analytics-figure-label">Working out the figures…</span>}
        {children}
        <span className="md-analytics-strip-ask">
          <AskAiButton question={question} label="Ask AI about this page" />
        </span>
      </div>
      {below}
    </div>
  );
}

/** One headline figure: its label, the value straight after it, and (optionally) a small note in a tone. */
export function StripFigure({
  testId,
  label,
  value,
  icon,
  children,
}: {
  testId?: string;
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  /** Notes after the value: StripNote pills. */
  children?: ReactNode;
}) {
  return (
    <span className="md-analytics-figure" data-testid={testId}>
      {icon}
      <span className="md-analytics-figure-label">{label}</span>
      <b className="md-analytics-figure-value">{value}</b>
      {children}
    </span>
  );
}

/** "-22.3 pts", "2 left open": a small tinted pill beside a figure. `tone` is a delta's tone (good / bad / neutral) or a
 *  tone class for anything else (watch). */
export function StripNote({ tone = "neutral", children }: { tone?: Tone | "watch"; children: ReactNode }) {
  const toneClass = tone === "watch" ? "md-analytics-tone-watch" : DELTA_TONE[tone];
  return <span className={cn("md-analytics-figure-note", toneClass)}>{children}</span>;
}

/** The top exceptions under the figures, each with its severity dot (named for a screen reader) and an Explain button. */
export function StripInsights({ items, testId }: { items: MdInsightDto[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="md-analytics-strip-list" data-testid={testId}>
      {items.map((item) => {
        const s = SEVERITY[item.severity];
        return (
          <li key={item.id} className="md-analytics-strip-item">
            <span role="img" aria-label={s.label} className={cn("md-analytics-dot", s.tone)} />
            <span className="md-analytics-strip-text">
              <b>{item.title}</b>
              {item.detail && <span> — {item.detail}</span>}
            </span>
            {item.ask && <AskAiButton question={item.ask} label="Explain" />}
          </li>
        );
      })}
    </ul>
  );
}
