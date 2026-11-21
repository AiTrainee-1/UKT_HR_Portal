import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  Lightbulb,
  ShieldAlert,
  TrendingUp,
  Users,
} from "lucide-react";
import { KpiTile, SectionCard } from "@/components/payroll/kit/parts";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { pct, plural, type Insight, type InsightAction, type LevelFilter } from "./logic";
import type { AnalyticsTab, Totals } from "./types";

/** In scope, with records, needing attention, high: the last three narrow the list below when clicked. */
export function SummaryBand({
  totals,
  tab,
  loading,
  levelFilter,
  onLevel,
}: {
  totals: Totals | undefined;
  tab: AnalyticsTab;
  loading: boolean;
  levelFilter: LevelFilter;
  onLevel: (level: LevelFilter) => void;
}) {
  const t = totals ?? { employeesInScope: 0, employeesWithIssues: 0, needingAttention: 0, high: 0 };
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="analytics-kpis">
      <KpiTile
        label="Employees in scope"
        value={t.employeesInScope}
        sub={`${tab === "staff" ? "Staff" : "Production"} employees for these filters`}
        icon={Users}
        tone="bg-slate-100 text-slate-800"
        loading={loading}
        testId="kpi-scope"
      />
      <KpiTile
        label="With records"
        value={t.employeesWithIssues}
        sub={
          t.employeesInScope
            ? `${pct(t.employeesWithIssues / t.employeesInScope)} of those in scope`
            : "in any category"
        }
        icon={Activity}
        tone="bg-blue-50 text-blue-800"
        loading={loading}
        onClick={() => onLevel("all")}
        active={levelFilter === "all"}
        testId="kpi-issues"
      />
      <KpiTile
        label="Needing attention"
        value={t.needingAttention}
        sub="At or over a limit"
        icon={AlertTriangle}
        tone="bg-amber-50 text-amber-800"
        loading={loading}
        onClick={() => onLevel("needs")}
        active={levelFilter === "needs"}
        testId="kpi-attention"
      />
      <KpiTile
        label="High"
        value={t.high}
        sub="Twice a limit, or 3+ categories"
        icon={ShieldAlert}
        tone="bg-red-50 text-red-800"
        loading={loading}
        onClick={() => onLevel("high")}
        active={levelFilter === "high"}
        testId="kpi-high"
      />
    </div>
  );
}

const INSIGHT_LOOK: Record<Insight["tone"], { icon: typeof Info; box: string; word: string }> = {
  danger: { icon: ShieldAlert, box: "bg-red-50 text-red-700 ring-red-100", word: "Act now" },
  warning: { icon: AlertTriangle, box: "bg-amber-50 text-amber-700 ring-amber-100", word: "Look at" },
  info: { icon: TrendingUp, box: "bg-indigo-50 text-indigo-700 ring-indigo-100", word: "Worth knowing" },
  success: { icon: CheckCircle2, box: "bg-emerald-50 text-emerald-700 ring-emerald-100", word: "Good news" },
};

/** What stands out, in words: each line says why, and its button opens the detail behind it. */
export function Insights({
  insights,
  loading,
  onAction,
}: {
  insights: Insight[];
  loading: boolean;
  onAction: (action: InsightAction) => void;
}) {
  return (
    <SectionCard
      title="What stands out"
      description="The few things to look at first, worked out from every record in the period."
      icon={Lightbulb}
      testId="analytics-insights"
    >
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {insights.map((ins) => {
            const look = INSIGHT_LOOK[ins.tone];
            const Icon = look.icon;
            return (
              <li
                key={ins.id}
                className="flex items-start gap-3 rounded-xl border border-slate-100 bg-white/80 p-3"
                data-testid={`insight-${ins.id}`}
              >
                <span className={cn("mt-0.5 shrink-0 rounded-lg p-1.5 ring-1", look.box)}>
                  <Icon size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{look.word}</p>
                  <p className="text-sm font-semibold leading-snug text-slate-900">{ins.title}</p>
                  {ins.detail && <p className="mt-0.5 text-xs leading-snug text-slate-600">{ins.detail}</p>}
                </div>
                {ins.action && (
                  <button
                    type="button"
                    onClick={() => onAction(ins.action!)}
                    className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                    aria-label={`${ins.actionLabel ?? "Open"}: ${ins.title}`}
                    data-testid={`insight-${ins.id}-action`}
                  >
                    {ins.actionLabel ?? "Open"} <ArrowRight size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/** "12 employees with records, 4 need attention": said once per answer for a screen reader. */
export const resultSentence = (t: Totals): string =>
  `${plural(t.employeesWithIssues, "employee")} with records, ${t.needingAttention} needing attention, ${t.high} high, of ${t.employeesInScope} in scope.`;
