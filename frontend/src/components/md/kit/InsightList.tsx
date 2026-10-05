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

const STYLE: Record<Severity, { box: string; icon: typeof Info; iconClass: string; label: string }> = {
  critical: { box: "border-red-200 bg-red-50/70", icon: AlertOctagon, iconClass: "text-red-600", label: "Critical" },
  warning: {
    box: "border-amber-200 bg-amber-50/70",
    icon: AlertTriangle,
    iconClass: "text-amber-600",
    label: "Needs attention",
  },
  info: { box: "border-blue-200 bg-blue-50/60", icon: Info, iconClass: "text-blue-600", label: "For your information" },
  good: { box: "border-green-200 bg-green-50/70", icon: CheckCircle2, iconClass: "text-green-600", label: "Good news" },
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
        className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
        data-testid="insights-empty"
      >
        <CheckCircle2 size={16} className="text-green-600" /> {emptyText}
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="insight-list">
      {items.map((item) => {
        const s = STYLE[item.severity];
        const Icon = s.icon;
        return (
          <li
            key={item.id}
            className={cn("flex items-start gap-3 rounded-xl border p-3", s.box)}
            data-testid={`insight-${item.id}`}
            data-severity={item.severity}
          >
            <Icon size={18} className={cn("mt-0.5 shrink-0", s.iconClass)} aria-label={s.label} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <p className="text-[13px] font-bold text-gray-900">{item.title}</p>
                {item.metric && (
                  <span className="text-[13px] font-black tabular-nums text-gray-900">{item.metric}</span>
                )}
              </div>
              {item.detail && <p className="mt-0.5 text-xs text-gray-600">{item.detail}</p>}
              {(item.page || item.ask) && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {item.page && (
                    <Link
                      href={item.page.path}
                      className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-[#006496] shadow-sm hover:bg-[#006496]/[0.06]"
                    >
                      {item.page.label} <ArrowUpRight size={12} />
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
