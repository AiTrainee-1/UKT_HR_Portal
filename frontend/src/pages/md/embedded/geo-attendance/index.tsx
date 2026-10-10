import { useState } from "react";
import { Radio } from "lucide-react";
import { useBrief, pageQuestion } from "@/components/md/embedded/brief";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { kpiValueText, sortInsights } from "@/components/md/kit/dto";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
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
import { StripFigure, StripInsights, StripNote, StripShell } from "../shared/InsightStrip";
import SegTabs from "../shared/SegTabs";
import AttentionCard from "./AttentionCard";
import BriefingCard from "./BriefingCard";
import CompareCard from "./CompareCard";
import GroupsCard from "./GroupsCard";
import KpiStrip from "./KpiStrip";
import LiveCard from "./LiveCard";
import PeopleCard from "./PeopleCard";
import ReachCard from "./ReachCard";
import TrendCard from "./TrendCard";
import UnusualCard from "./UnusualCard";
import VerificationCard from "./VerificationCard";
import { LIVE_REFRESH_MS, useGeoData } from "./hooks";
import { GROUP_TABS, askQuestions, assistantSummary, focusScope, periodText, scopeText } from "./logic";
import type { GeoLive, GroupBy, GeoGroupRow } from "./types";

const PAGE = "geo-attendance";

/**
 * Geo Attendance, Insights & AI: who works away from the premises, how often, whether HR is verifying it, what looks
 * unusual and who is out right now. The HR page itself (approvals, punch verifications, the live and on-duty maps, tracking
 * settings) is the Operations tab next to this one.
 */
export default function GeoInsights() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days" });
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const [by, setBy] = useState<GroupBy>("department");
  const org = useMdOrg();
  const data = useGeoData({ ...periodParams(period), ...scopeParams(scope) }, scopeParams(scope), by);
  const { summary } = data;

  const periodLabel = summary.data?.period?.label ?? periodText(period);
  const selection = scopeText(scope, summary.data?.scope?.description);
  const ask = askQuestions(periodLabel, scopeIsEveryone(scope) ? null : selection);

  usePublishAssistantContext({
    page: PAGE,
    title: "Geo Attendance",
    filters: { Period: periodLabel, Scope: selection },
    summary: assistantSummary(summary.data, data.verification.data),
  });

  const focus = (row: GeoGroupRow) => {
    const next = focusScope(scope, by, row, org.data);
    if (next) setScope(next);
  };

  return (
    <div className="space-y-5" data-testid="md-geo-insights">
      <FilterBar>
        <PeriodBar value={period} onChange={setPeriod} />
        <ScopeBar value={scope} onChange={setScope} org={org.data} />
      </FilterBar>

      {summary.isError && (
        <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
      )}

      <BriefingCard query={data.briefing} ask={ask.briefing} />

      <KpiStrip summary={summary} trend={data.trend} verification={data.verification} />

      <AttentionCard query={data.attention} ask={ask.attention} />

      <TrendCard query={data.trend} ask={ask.trend} />

      <LiveCard query={data.live} ask={ask.live} />

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <VerificationCard query={data.verification} ask={ask.verification} />
        <ReachCard query={data.reach} ask={ask.reach} />
      </div>

      <GroupsCard
        query={data.groups}
        ask={ask.groups}
        nameHeader={GROUP_TABS.find((t) => t.value === by)?.header ?? "Group"}
        tabs={
          <SegTabs
            label="Group by"
            items={GROUP_TABS.map((t) => ({ value: t.value, label: t.label }))}
            value={by}
            onChange={(v) => setBy(v as GroupBy)}
          />
        }
        onFocus={focus}
      />

      <UnusualCard query={data.unusual} ask={ask.unusual} />

      <PeopleCard query={data.people} ask={ask.people} />

      <CompareCard query={summary} ask={ask.compare} />

      {summary.data && summary.data.notes.length > 0 && (
        <NoteBanner>
          <div data-testid="md-geo-notes">
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

const STRIP_KPIS = ["geo.sessions", "geo.awaiting-hr"];

/**
 * The strip above the Geo Attendance page, always visible: who is on duty right now (live), the on-duty sessions of the last
 * week, what is waiting for HR, and the top exceptions, each with Explain.
 */
export function Strip() {
  const brief = useBrief(PAGE);
  const live = useMdQuery<GeoLive>("geo/live", undefined, { refetchInterval: LIVE_REFRESH_MS });
  const kpis = (brief.data?.kpis ?? []).filter((k) => STRIP_KPIS.includes(k.id));
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  const now = live.data;

  if (
    (brief.isError && live.isError) ||
    (!brief.isLoading && !live.isLoading && !now?.rows.length && kpis.length === 0 && insights.length === 0)
  ) {
    // nothing to say is a state, not an error banner on top of a working page
    return null;
  }
  return (
    <StripShell
      testId="md-geo-strip"
      question={pageQuestion("Geo Attendance")}
      loading={brief.isLoading || live.isLoading}
      below={<StripInsights items={insights} testId="md-geo-strip-insights" />}
    >
      {now && (
        <StripFigure
          testId="md-geo-strip-now"
          label="On duty now"
          value={now.onDutyNow}
          icon={
            <Radio size={14} className={cn("self-center", now.onDutyNow > 0 ? "text-md-success" : "text-md-ink-400")} />
          }
        >
          {now.awaitingApproval > 0 && <StripNote tone="watch">{now.awaitingApproval} awaiting approval</StripNote>}
          {now.leftOpen > 0 && <StripNote tone="bad">{now.leftOpen} left open</StripNote>}
        </StripFigure>
      )}
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}
