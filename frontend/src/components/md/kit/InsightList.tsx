import { AlertOctagon, AlertTriangle, ArrowUpRight, CheckCircle2, Info } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import AskAiButton from "./AskAiButton";

export type Severity = "critical" | "warning" | "info" | "good";

export type Insight = {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** A figure to show beside the title ("12 people", "₹4.2 L"). */
  metric?: string;
  /** The MD page that shows the detail. */
  page?: { path: string; label: string };
  /** A ready-made question for the assistant. */
  ask?: string;
};

/** Crimson is bad, ochre is watch, periwinkle is information, sage is good; each also has its own icon shape, so the
 *  severity is never carried by colour alone. */
const STYLE: Record<Severity, { tone: string; icon: typeof Info; label: string }> = {
  critical: { tone: "md-shell-sev-critical", icon: AlertOctagon, label: "Critical" },
  warning: { tone: "md-shell-sev-warning", icon: AlertTriangle, label: "Needs attention" },
  info: { tone: "md-shell-sev-info", icon: Info, label: "For your information" },
  good: { tone: "md-shell-sev-good", icon: CheckCircle2, label: "Good news" },
};

/** Findings the MD should read first (exceptions, risks, wins): severity, what and how much, where to look, and an
 *  "Ask AI" shortcut that explains it. */
export default function InsightList({
  items,
  emptyText = "Nothing needs your attention right now.",
}: {
  items: Insight[];
  emptyText?: string;
}) {
  if (items.length === 0) {
    return (
      <p
        className="md-panel-sand flex items-center justify-center gap-2 px-4 py-6 text-sm font-medium text-md-ink-soft"
        data-testid="insights-empty"
      >
        <CheckCircle2 size={16} className="text-md-success" /> {emptyText}
      </p>
    );
  }
  return (
    <ul className="space-y-2.5" data-testid="insight-list">
      {items.map((item) => {
        const s = STYLE[item.severity];
        const Icon = s.icon;
        return (
          <li
            key={item.id}
            className={cn("md-shell-insight", s.tone)}
            data-testid={`insight-${item.id}`}
            data-severity={item.severity}
          >
            <span className="md-shell-insight-icon">
              <Icon size={16} aria-label={s.label} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-[13px] font-bold leading-snug text-md-ink">{item.title}</p>
                {item.metric && <span className="text-[13px] font-black tabular-nums text-md-ink">{item.metric}</span>}
              </div>
              {item.detail && <p className="mt-0.5 text-xs leading-relaxed text-md-ink-soft">{item.detail}</p>}
              {(item.page || item.ask) && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {item.page && (
                    <Link href={item.page.path} className="md-chip md-chip-wine md-shell-link">
                      {item.page.label} <ArrowUpRight size={12} strokeWidth={2.4} />
                    </Link>
                  )}
                  {item.ask && <AskAiButton question={item.ask} label="Explain" />}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
