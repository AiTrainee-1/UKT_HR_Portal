import { useState } from "react";
import { DoorClosed, LogIn, MoonStar, Repeat2, Timer, UserCheck, Users, UserX } from "lucide-react";
import { pageQuestion, useBrief } from "@/components/md/embedded/brief";
import StatCard from "@/components/md/kit/StatCard";
import { kpiValueText, sortInsights } from "@/components/md/kit/dto";
import { useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { minutesText, num, pct } from "@/lib/md/format";
import { scopeIsEveryone } from "@/lib/md/period";
import type { InsightsDefaults } from "../shared/filters";
import { drillClick } from "../shared/drill";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { StripFigure, StripInsights, StripNote, StripShell } from "../shared/InsightStrip";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import { deltaOf, forWhom, inWhen, previousText } from "../outpass/logic";
import { AttentionCard, BriefCard, Notes, TileGrid, refreshingClass } from "../outpass/parts";
import type {
  ExceptionsResponse,
  StoryResponse,
  SummaryResponse,
  TrendResponse,
  VisitList,
  VisitorsResponse,
} from "../outpass/types";
import { HostDepartmentsCard, StayCard, VisitGroupsCard, VisitTrendCard } from "./VisitorCards";
import VisitSheet, { type VisitDrill } from "./VisitSheet";

const PAGE = "visitors";
const TITLE = "Visitors";
const DEFAULTS: InsightsDefaults = {};

/**
 * Visitors, Insights & AI: who comes in, why, whom they see, how long they stay (check-out exists from 18 Nov 2026) and
 * whether the desks record check-outs. The HR page itself (register, check-out, Manage Reception) is the Operations tab.
 * Every figure follows the month / range and unit / department filters; a tile, a group or a host opens its visits.
 */
export default function VisitorsInsights() {
  const { filters, params, label, setWhen, setScope } = useInsightsFilters(DEFAULTS);
  const org = useMdOrg();
  const [drill, setDrill] = useState<VisitDrill | null>(null);

  const story = useMdQuery<StoryResponse>("visitors/story", { ...params, focus: PAGE });
  const summary = useMdQuery<SummaryResponse>("visitors/summary", params);
  const trend = useMdQuery<TrendResponse>("visitors/trend", params);
  const breakdown = useMdQuery<VisitorsResponse>("visitors/visitors", { ...params, limit: 25 });
  const exceptions = useMdQuery<ExceptionsResponse>("visitors/exceptions", { ...params, limit: 25 });

  const v = summary.data?.visitors;
  const when = inWhen(summary.data?.period?.label ?? label);
  const who = forWhom(summary.data?.scope?.description, scopeIsEveryone(filters.scope));
  const ask = {
    page: `Explain visitor traffic ${when}${who}: who came, why, how long they stayed, and what should I look at?`,
    attention: `What needs my attention on visitors ${when}${who}?`,
    trend: `How did the number of visitors change ${when}${who}, and why?`,
    stay: `How long do visitors stay ${when}${who}, and are check-outs being recorded?`,
    groups: `Why do visitors come ${when}${who}, whom do they see and from which companies?`,
    departments: `Which departments get the most visitors ${when}${who}?`,
  };

  usePublishAssistantContext({
    page: PAGE,
    title: TITLE,
    filters: { Period: summary.data?.period?.label ?? label, Scope: summary.data?.scope?.description ?? "" },
    summary: v
      ? {
          Visits: num(v.visits.value),
          "Different visitors": num(v.uniqueVisitors.value),
          "Inside now": num(v.insideNow ?? 0),
          "Checked out": pct(v.checkedOutPct?.value ?? null),
          "Average time inside": minutesText(v.avgMinutesInside?.value ?? null),
          "After hours": num(v.afterHours.value),
        }
      : {},
  });

  const attention = (exceptions.data?.attention ?? []).filter((i) => i.page === PAGE);

  return (
    <div className="space-y-5" data-testid="md-visitors-insights">
      <InsightsFilterBar
        filters={filters}
        onWhen={setWhen}
        onScope={setScope}
        org={org.data}
        testId="md-visitors-filters"
      />

      <BriefCard
        query={story}
        ask={ask.page}
        testId="md-visitors-briefing"
        empty="Nobody checked in for this selection."
      />

      <TileGrid testId="md-visitors-kpis" className={refreshingClass(summary)}>
        <StatCard
          testId="md-visitors-kpi-visits"
          label="Visits"
          value={num(v?.visits.value)}
          sub={previousText(v?.visits)}
          icon={LogIn}
          tone="blue"
          delta={deltaOf(v?.visits, null)}
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["visits"]}
          onClick={drillClick(() => setDrill({ title: "Every visit", filter: {} }))}
        />
        <StatCard
          testId="md-visitors-kpi-unique"
          label="Different visitors"
          value={num(v?.uniqueVisitors.value)}
          sub={v ? `About ${num(v.avgPerDay.value, 1)} visits a day` : undefined}
          icon={Users}
          tone="indigo"
          delta={deltaOf(v?.uniqueVisitors, null)}
          loading={summary.isPending}
        />
        <StatCard
          testId="md-visitors-kpi-inside"
          label="Inside now"
          value={num(v?.insideNow ?? 0)}
          sub={v ? `${num(v.longStayNow ?? 0)} for over 2 hours · ${num(v.visitsToday ?? 0)} came today` : undefined}
          icon={UserCheck}
          tone="amber"
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["visits-checkout"]}
          onClick={drillClick(() =>
            setDrill({
              title: "Inside now",
              filter: { status: "inside", period: "today", month: "", from: "", to: "" },
            }),
          )}
        />
        <StatCard
          testId="md-visitors-kpi-checked-out"
          label="Checked out"
          value={pct(v?.checkedOutPct?.value ?? null)}
          sub={
            v ? `${num(v.checkedOut?.value ?? 0)} of ${num(v.checkoutEligible ?? 0)} visits since 18 Nov` : undefined
          }
          icon={DoorClosed}
          tone="green"
          delta={deltaOf(v?.checkedOutPct, true, "pct")}
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["visits-checkout"]}
          onClick={drillClick(() => setDrill({ title: "Checked out", filter: { status: "checked_out" } }))}
        />
        <StatCard
          testId="md-visitors-kpi-stay"
          label="Average time inside"
          value={minutesText(v?.avgMinutesInside?.value ?? null)}
          sub={v ? `Typical visit ${minutesText(v.medianMinutesInside ?? null)}` : undefined}
          icon={Timer}
          tone="purple"
          delta={deltaOf(v?.avgMinutesInside, null, "minutes")}
          loading={summary.isPending}
        />
        <StatCard
          testId="md-visitors-kpi-no-checkout"
          label="Left without check-out"
          value={num(v?.leftWithoutCheckout ?? 0)}
          sub="Earlier days, never checked out"
          icon={UserX}
          tone="red"
          loading={summary.isPending}
          onClick={drillClick(() =>
            setDrill({ title: "Left without check-out", filter: { status: "not_checked_out" } }),
          )}
        />
        <StatCard
          testId="md-visitors-kpi-after-hours"
          label="After hours"
          value={num(v?.afterHours.value)}
          sub="Before 8 am or from 6 pm"
          icon={MoonStar}
          tone="slate"
          delta={deltaOf(v?.afterHours, false)}
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["after-hours"]}
          onClick={drillClick(() => setDrill({ title: "After-hours visits", filter: { afterHours: 1 } }))}
        />
        <StatCard
          testId="md-visitors-kpi-repeat"
          label="Came more than once"
          value={num(v?.repeatVisitors.value)}
          sub={v?.peakHour ? `Busiest hour ${v.peakHour.label}` : undefined}
          icon={Repeat2}
          tone="teal"
          delta={deltaOf(v?.repeatVisitors, null)}
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["repeat-visitors"]}
        />
      </TileGrid>

      <AttentionCard items={attention} query={exceptions} ask={ask.attention} testId="md-visitors-attention" />

      <VisitTrendCard query={trend} ask={ask.trend} />

      <StayCard query={breakdown} ask={ask.stay} onDrill={setDrill} />

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <VisitGroupsCard query={breakdown} ask={ask.groups} onDrill={setDrill} />
        <HostDepartmentsCard query={breakdown} ask={ask.departments} />
      </div>

      <Notes notes={breakdown.data?.notes} testId="md-visitors-notes" />

      <VisitSheet drill={drill} params={params} onClose={() => setDrill(null)} />
    </div>
  );
}

/** The strip above the Visitors page: who is inside right now, the visitor figures of the brief and the top exceptions. */
export function Strip() {
  const brief = useBrief(PAGE);
  const inside = useMdQuery<VisitList>(
    "visitors/visit-list",
    { period: "today", status: "inside", pageSize: 1 },
    { refetchInterval: 60_000 },
  );
  const kpis = (brief.data?.kpis ?? []).filter((k) => !k.page || k.page === PAGE);
  const insights = sortInsights(brief.data?.insights ?? [])
    .filter((i) => !i.page || i.page === PAGE)
    .slice(0, 2);
  const now = inside.data?.total;
  if (
    (brief.isError && inside.isError) ||
    (!brief.isLoading && !inside.isLoading && !now && kpis.length === 0 && insights.length === 0)
  ) {
    return null;
  }
  return (
    <StripShell
      testId="md-visitors-strip"
      question={pageQuestion(TITLE)}
      loading={brief.isLoading}
      below={<StripInsights items={insights} testId="md-visitors-strip-insights" />}
    >
      {now !== undefined && (
        <StripFigure testId="md-visitors-strip-inside" label="Inside now" value={num(now)}>
          {now > 0 && <StripNote tone="watch">not checked out yet</StripNote>}
        </StripFigure>
      )}
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}
