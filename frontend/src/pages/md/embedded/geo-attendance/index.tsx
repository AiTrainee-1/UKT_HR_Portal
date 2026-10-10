import { useState } from "react";
import { Radio, Sparkles } from "lucide-react";
import { useBrief, pageQuestion } from "@/components/md/embedded/brief";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { kpiValueText, sortInsights } from "@/components/md/kit/dto";
import { PillTabs } from "@/components/ui/pill-tabs";
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
          <PillTabs
            size="sm"
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
    <div
      className="mb-4 rounded-2xl border border-[#e0a83a]/30 bg-gradient-to-r from-[#fffaf0] to-white p-3.5 shadow-sm"
      data-testid="md-geo-strip"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-widest text-[#b8801c]">
          <Sparkles size={13} /> MD insights
        </span>
        {(brief.isLoading || live.isLoading) && (
          <span className="text-xs text-muted-foreground">Working out the figures…</span>
        )}
        {now && (
          <span className="flex items-baseline gap-1.5 text-sm" data-testid="md-geo-strip-now">
            <Radio size={13} className={cn("self-center", now.onDutyNow > 0 ? "text-green-600" : "text-slate-400")} />
            <span className="text-xs text-muted-foreground">On duty now</span>
            <b className="font-black text-gray-900">{now.onDutyNow}</b>
            {now.awaitingApproval > 0 && (
              <span className="text-[11px] font-semibold text-amber-700">{now.awaitingApproval} awaiting approval</span>
            )}
            {now.leftOpen > 0 && (
              <span className="text-[11px] font-semibold text-red-700">{now.leftOpen} left open</span>
            )}
          </span>
        )}
        {kpis.map((kpi) => (
          <span key={kpi.id} className="flex items-baseline gap-1.5 text-sm" data-testid={`strip-kpi-${kpi.id}`}>
            <span className="text-xs text-muted-foreground">{kpi.label}</span>
            <b className="font-black text-gray-900">{kpiValueText(kpi)}</b>
          </span>
        ))}
        <span className="ml-auto">
          <AskAiButton question={pageQuestion("Geo Attendance")} label="Ask AI about this page" />
        </span>
      </div>
      {insights.length > 0 && (
        <ul className="mt-2.5 space-y-1" data-testid="md-geo-strip-insights">
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
    </div>
  );
}
