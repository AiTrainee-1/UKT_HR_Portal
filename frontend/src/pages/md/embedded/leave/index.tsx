import { useState } from "react";
import { pageQuestion, useBrief } from "@/components/md/embedded/brief";
import { kpiValueText, sortInsights } from "@/components/md/kit/dto";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { describeScope, scopeIsEveryone } from "@/lib/md/period";
import { whenMonth } from "../shared/filters";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { StripFigure, StripInsights, StripShell } from "../shared/InsightStrip";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import ApprovalsCard from "./ApprovalsCard";
import CasualCard from "./CasualCard";
import { AttentionCard, BriefingCard, KpiStrip, TrendCard } from "./cards";
import DrillSheet from "./DrillSheet";
import GroupsCard from "./GroupsCard";
import OutCard from "./OutCard";
import PermissionsCard from "./PermissionsCard";
import { DEFAULTS, PAGE, TITLE, askQuestions, assistantSummary } from "./logic";
import type {
  Drill,
  GroupBy,
  LvApprovals,
  LvAttention,
  LvBalances,
  LvBriefing,
  LvGroups,
  LvPermissions,
  LvSummary,
  LvToday,
  LvTrend,
} from "./types";

/**
 * Leave & Holiday, Insights & AI: how much leave was taken, by type, reason, department and unit, who is out, Casual
 * Leave's 12-day year (with what HR carried forward), permissions against the monthly cap, and why requests are rejected.
 * The MD only looks (the Operations tab is the HR page, view only). Every figure opens the people or requests behind it.
 */
export default function LeaveInsights() {
  const { filters, params, label, setWhen, setScope } = useInsightsFilters(DEFAULTS);
  const [by, setBy] = useState<GroupBy>("type");
  const [drill, setDrill] = useState<Drill | null>(null);
  const org = useMdOrg();
  const scopeOnly: Record<string, string> = { ...params };
  for (const key of ["period", "month", "from", "to"]) delete scopeOnly[key];
  // Casual Leave is a calendar year: the year of the month on screen
  const year = whenMonth(filters.when).slice(0, 4);

  const summary = useMdQuery<LvSummary>("leave/summary", params);
  const briefing = useMdQuery<LvBriefing>("leave/briefing", params);
  const attention = useMdQuery<LvAttention>("leave/attention", params);
  const trend = useMdQuery<LvTrend>("leave/trend", params);
  const groups = useMdQuery<LvGroups>("leave/groups", { ...params, by, limit: 25 });
  const today = useMdQuery<LvToday>("leave/today", { ...scopeOnly, limit: 10 });
  const balances = useMdQuery<LvBalances>("leave/balances", { ...scopeOnly, year, limit: 10 });
  const permissions = useMdQuery<LvPermissions>("leave/permissions", { ...params, limit: 10 });
  const approvals = useMdQuery<LvApprovals>("leave/approvals", { ...params, limit: 10 });

  const periodLabel = summary.data?.period?.label ?? label;
  const selection = summary.data?.scope?.description ?? describeScope(filters.scope);
  const ask = askQuestions(periodLabel, scopeIsEveryone(filters.scope) ? null : selection);

  usePublishAssistantContext({
    page: PAGE,
    title: TITLE,
    filters: { Period: periodLabel, Scope: selection },
    summary: assistantSummary(summary.data, permissions.data),
  });

  const open = (d: Drill) => setDrill({ ...d, ask: d.ask ?? `Tell me about this: ${d.title} (${periodLabel}).` });

  return (
    <div className="space-y-5" data-testid="md-leave-insights">
      <InsightsFilterBar filters={filters} onWhen={setWhen} onScope={setScope} org={org.data} showType={false} />

      {summary.isError && (
        <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
      )}

      <BriefingCard query={briefing} ask={ask.briefing} />
      <KpiStrip summary={summary} permissions={permissions} onDrill={open} />
      <AttentionCard query={attention} ask={ask.attention} />
      <TrendCard query={trend} ask={ask.trend} />

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <GroupsCard query={groups} by={by} onBy={setBy} ask={ask.groups} onDrill={open} />
        <OutCard query={today} ask={ask.out} onDrill={open} />
      </div>
      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <CasualCard query={balances} ask={ask.casual} onDrill={open} />
        <PermissionsCard query={permissions} ask={ask.permissions} onDrill={open} />
      </div>
      <ApprovalsCard query={approvals} ask={ask.approvals} onDrill={open} />

      {summary.data && summary.data.notes.length > 0 && (
        <NoteBanner>
          <div data-testid="md-leave-notes">
            <p className="font-semibold">About these figures</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {summary.data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </NoteBanner>
      )}

      <DrillSheet drill={drill} params={{ ...params, year }} onClose={() => setDrill(null)} />
    </div>
  );
}

const STRIP_KPIS = ["leave.out-today", "leave.pending", "leave.days-7d"];

/** The strip above the Leave & Holiday page: who is out today, what waits, last week's leave and the top exceptions. */
export function Strip() {
  const brief = useBrief(PAGE);
  const kpis = (brief.data?.kpis ?? []).filter((k) => STRIP_KPIS.includes(k.id));
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  if (brief.isError || (!brief.isLoading && kpis.length === 0 && insights.length === 0)) return null;
  return (
    <StripShell
      testId="md-leave-strip"
      question={pageQuestion(TITLE)}
      loading={brief.isLoading}
      below={<StripInsights items={insights} testId="md-leave-strip-insights" />}
    >
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}
