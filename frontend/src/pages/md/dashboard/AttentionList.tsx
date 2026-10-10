import { AlertOctagon, AlertTriangle, ArrowUpRight, CheckCircle2, Info } from "lucide-react";
import { Link } from "wouter";
import AskAiButton from "@/components/md/kit/AskAiButton";
import type { Insight, Severity } from "@/components/md/kit/InsightList";
import { cn } from "@/lib/utils";

/** What each severity looks like: an icon and a chip that says it in words (crimson, ochre, periwinkle, sage: the colours
 *  keep their meanings, and the label means nobody has to read the colour). */
const LOOK: Record<Severity, { icon: typeof Info; label: string; chip: string }> = {
  critical: { icon: AlertOctagon, label: "Critical", chip: "md-chip-danger" },
  warning: { icon: AlertTriangle, label: "Needs attention", chip: "md-chip-warning" },
  info: { icon: Info, label: "For your information", chip: "md-dashboard-chip-info" },
  good: { icon: CheckCircle2, label: "Good news", chip: "md-chip-success" },
};

/**
 * The dashboard's "Needs your attention" list: the same findings as the kit's InsightList (severity, what and how much,
 * where to look, an "Explain" shortcut to the assistant) drawn as glass rows with a severity bar, an icon tile and a chip.
 * It keeps the testids the pages' tests read (insight-list, insight-<id>, data-severity, insights-empty).
 */
export default function AttentionList({
  items,
  emptyText = "Nothing needs your attention right now.",
}: {
  items: Insight[];
  emptyText?: string;
}) {
  if (items.length === 0) {
    return (
      <p
        className="md-panel-wine flex items-center justify-center gap-2 px-4 py-8 text-center text-sm font-medium text-md-ink-soft"
        data-testid="insights-empty"
      >
        <CheckCircle2 size={17} className="shrink-0 text-md-success" aria-hidden /> {emptyText}
      </p>
    );
  }
  return (
    <ul className="space-y-2.5" data-testid="insight-list">
      {items.map((item) => {
        const look = LOOK[item.severity];
        const Icon = look.icon;
        return (
          <li
            key={item.id}
            className="md-dashboard-insight"
            data-testid={`insight-${item.id}`}
            data-severity={item.severity}
          >
            <span className="md-dashboard-insight-icon">
              <Icon size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className={cn("md-chip", look.chip)}>{look.label}</span>
                {item.metric && (
                  <span className="md-dashboard-figure ml-auto text-sm font-black text-md-ink">{item.metric}</span>
                )}
              </div>
              <p className="mt-1.5 text-[14px] font-bold leading-snug text-md-ink">{item.title}</p>
              {item.detail && <p className="mt-0.5 text-xs leading-relaxed text-md-ink-soft">{item.detail}</p>}
              {(item.page || item.ask) && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {item.page && (
                    <Link href={item.page.path} className="md-btn md-btn-soft md-btn-sm">
                      {item.page.label} <ArrowUpRight size={12} aria-hidden />
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
