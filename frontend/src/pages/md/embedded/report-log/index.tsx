import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useBrief, pageQuestion } from "@/components/md/embedded/brief";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { kpiDelta, kpiValueText, sortInsights } from "@/components/md/kit/dto";
import { PillTabs } from "@/components/ui/pill-tabs";
import { describeMdError, useMdOrg } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import {
  EVERYONE,
  periodParams,
  scopeIsEveryone,
  scopeParams,
  type PeriodChoice,
  type ScopeChoice,
} from "@/lib/md/period";
import { cn } from "@/lib/utils";
import AttentionCard from "./AttentionCard";
import BriefingCard from "./BriefingCard";
import CompareCard from "./CompareCard";
import ExportsCard from "./ExportsCard";
import FollowUpCard from "./FollowUpCard";
import GapsCard from "./GapsCard";
import GroupsCard from "./GroupsCard";
import KpiStrip from "./KpiStrip";
import LimitsCard from "./LimitsCard";
import { useReportLogData } from "./hooks";
import { GROUP_TABS, askQuestions, assistantSummary, focusScope, periodText, scopeText } from "./logic";
import type { GroupBy, RlGroupRow } from "./types";

const PAGE = "report-log";

/**
 * Report Log, Insights & AI: are absences being followed up on the Daily Report (Informed / Not informed), on which days
 * nobody made the call, where, and who produces the attendance reports. The HR page itself (the monthly attendance
 * register, the late-penalty breakdown and the Daily Report with its Excel / PDF / image export) is the Operations tab.
 * What the data cannot say (reports sent, late or failed, who marked an absence) is stated at the foot, not guessed.
 */
export default function ReportLogInsights() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days" });
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const [by, setBy] = useState<GroupBy>("department");
  const org = useMdOrg();
  const data = useReportLogData({ ...periodParams(period), ...scopeParams(scope) }, periodParams(period), by);
  const { summary } = data;

  const periodLabel = summary.data?.period?.label ?? periodText(period);
  const selection = scopeText(scope, summary.data?.scope?.description);
  const ask = askQuestions(periodLabel, scopeIsEveryone(scope) ? null : selection);

  usePublishAssistantContext({
    page: PAGE,
    title: "Report Log",
    filters: { Period: periodLabel, Scope: selection },
    summary: assistantSummary(summary.data),
  });

  const focus = (row: RlGroupRow) => {
    const next = focusScope(scope, by, row, org.data);
    if (next) setScope(next);
  };

  return (
    <div className="space-y-5" data-testid="md-reportlog-insights">
      <FilterBar>
        <PeriodBar value={period} onChange={setPeriod} />
        <ScopeBar value={scope} onChange={setScope} org={org.data} />
      </FilterBar>

      {summary.isError && (
        <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
      )}

      <BriefingCard query={data.briefing} ask={ask.briefing} />

      <KpiStrip summary={summary} trend={data.trend} />

      <AttentionCard query={data.attention} ask={ask.attention} />

      <FollowUpCard query={data.trend} ask={ask.trend} />

      <GapsCard query={data.gaps} ask={ask.gaps} />

      <GroupsCard
        query={data.groups}
        ask={ask.groups}
        nameHeader={GROUP_TABS.find((t) => t.value === by)?.header ?? "Group"}
        tabs={
          <PillTabs
            size="sm"
            items={GROUP_TABS.map((t) => ({ value: t.value, label: t.label }))}
            value={by}
            onChange={(v) => setBy(v as GroupBy)}
          />
        }
        onFocus={focus}
      />

      <ExportsCard query={data.exports} trend={data.trend} ask={ask.exports} />

      <CompareCard query={summary} ask={ask.compare} />

      <LimitsCard query={summary} ask={ask.limits} />

      {summary.data && summary.data.notes.length > 0 && (
        <NoteBanner>
          <div data-testid="md-reportlog-notes">
            <p className="font-semibold">About these figures</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {summary.data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </NoteBanner>
      )}
    </div>
  );
}

const TONE: Record<string, string> = { good: "text-green-700", bad: "text-red-700", neutral: "text-[#006496]/70" };

/**
 * The strip above the Report Log page, always visible: how much of the last week's absences were followed up, how many were
 * not informed, the attendance report exports on record, the top exceptions with Explain, and the one thing to remember
 * when reading them: exports from this page are not recorded.
 */
export function Strip() {
  const brief = useBrief(PAGE);
  const kpis = brief.data?.kpis ?? [];
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);

  if (brief.isError || (!brief.isLoading && kpis.length === 0 && insights.length === 0)) return null;
  return (
    <div
      className="mb-4 rounded-2xl border border-[#e0a83a]/30 bg-gradient-to-r from-[#fffaf0] to-white p-3.5 shadow-sm"
      data-testid="md-reportlog-strip"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-widest text-[#b8801c]">
          <Sparkles size={13} /> MD insights
        </span>
        {brief.isLoading && <span className="text-xs text-muted-foreground">Working out the figures…</span>}
        {kpis.map((kpi) => {
          const delta = kpiDelta(kpi);
          return (
            <span key={kpi.id} className="flex items-baseline gap-1.5 text-sm" data-testid={`strip-kpi-${kpi.id}`}>
              <span className="text-xs text-muted-foreground">{kpi.label}</span>
              <b className="font-black text-gray-900">{kpiValueText(kpi)}</b>
              {delta && (
                <span className={cn("text-[11px] font-semibold", TONE[delta.tone] ?? TONE.neutral)}>{delta.text}</span>
              )}
            </span>
          );
        })}
        <span className="ml-auto">
          <AskAiButton question={pageQuestion("Report Log")} label="Ask AI about this page" />
        </span>
      </div>
      {insights.length > 0 && (
        <ul className="mt-2.5 space-y-1" data-testid="md-reportlog-strip-insights">
          {insights.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-[13px] text-gray-800">
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  item.severity === "critical"
                    ? "bg-red-500"
                    : item.severity === "warning"
                      ? "bg-amber-500"
                      : "bg-blue-500",
                )}
              />
              <span className="min-w-0 flex-1">
                <b className="font-semibold">{item.title}</b>
                {item.detail && <span className="text-muted-foreground"> — {item.detail}</span>}
              </span>
              {item.ask && <AskAiButton question={item.ask} label="Explain" />}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-[#006496]/60" data-testid="md-reportlog-strip-caveat">
        Exports made from this page (Excel, PDF, image) are produced in the browser and are not recorded, so the export
        figures cover Report Center and Attendance Search exports only.
      </p>
    </div>
  );
}
