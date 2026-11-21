import { useState } from "react";
import { CheckCircle2, Clock3, DoorOpen, Footprints, Hourglass, LogOut, Timer, XCircle } from "lucide-react";
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
import { DurationsAndScansCard, FunnelCard, OutpassGroupsCard, OutpassTrendCard } from "./OutpassCards";
import PassSheet, { type PassDrill } from "./PassSheet";
import { deltaOf, forWhom, inWhen, previousText } from "./logic";
import { AttentionCard, BriefCard, Notes, TileGrid, refreshingClass } from "./parts";
import type {
  ExceptionsResponse,
  OutpassResponse,
  PassList,
  StoryResponse,
  SummaryResponse,
  TrendResponse,
} from "./types";

const PAGE = "outpass";
const TITLE = "Gate Pass";
/** Month by default; module level so the address only carries what the MD changed. */
const DEFAULTS: InsightsDefaults = {};

/**
 * Gate Pass, Insights & AI: who leaves during the shift, for how long, whether they come back and whether approvals and
 * the gates keep it under control. The HR page itself (requests, In/Out, Manage Gates) is the Operations tab next to it.
 * Every figure follows the month / range and unit / department filters; a tile, a group or a step opens its passes.
 */
export default function GatePassInsights() {
  const { filters, params, label, setWhen, setScope } = useInsightsFilters(DEFAULTS);
  const org = useMdOrg();
  const [drill, setDrill] = useState<PassDrill | null>(null);

  const story = useMdQuery<StoryResponse>("visitors/story", { ...params, focus: PAGE });
  const summary = useMdQuery<SummaryResponse>("visitors/summary", params);
  const trend = useMdQuery<TrendResponse>("visitors/trend", params);
  const breakdown = useMdQuery<OutpassResponse>("visitors/outpass", { ...params, limit: 25 });
  const exceptions = useMdQuery<ExceptionsResponse>("visitors/exceptions", { ...params, limit: 25 });

  const o = summary.data?.outpass;
  const when = inWhen(summary.data?.period?.label ?? label);
  const who = forWhom(summary.data?.scope?.description, scopeIsEveryone(filters.scope));
  const ask = {
    page: `Explain the gate passes ${when}${who}: who left, for how long, and what should I look at first?`,
    attention: `What needs my attention on gate passes ${when}${who}?`,
    trend: `How did gate passes change ${when}${who}, and why?`,
    groups: `Which departments and gates account for most time out on gate passes ${when}${who}?`,
    funnel: `How many gate passes ${when}${who} were approved, used and returned, and where did the rest stop?`,
    durations: `How long are people out on gate passes ${when}${who}, and how often did a gate refuse a pass?`,
  };

  usePublishAssistantContext({
    page: PAGE,
    title: TITLE,
    filters: { Period: summary.data?.period?.label ?? label, Scope: summary.data?.scope?.description ?? "" },
    summary: o
      ? {
          "Passes requested": num(o.requests.value),
          "Went out": num(o.left.value),
          "Came back": num(o.returned.value),
          "Never returned": num(o.notReturned.value),
          "Hours out": num(o.hoursOut.value, 1),
          "Outside now": num(o.outsideNow),
          "Waiting for approval": num(o.waitingNow.waiting),
        }
      : {},
  });

  const tile = (outcome: string, title: string) => drillClick(() => setDrill({ title, filter: { outcome } }));
  const attention = (exceptions.data?.attention ?? []).filter((i) => i.page === PAGE);

  return (
    <div className="space-y-5" data-testid="md-gate-pass-insights">
      <InsightsFilterBar
        filters={filters}
        onWhen={setWhen}
        onScope={setScope}
        org={org.data}
        testId="md-gate-pass-filters"
      />

      <BriefCard
        query={story}
        ask={ask.page}
        testId="md-gate-pass-briefing"
        empty="There are no gate passes for this selection."
      />

      <TileGrid testId="md-gate-pass-kpis" className={refreshingClass(summary)}>
        <StatCard
          testId="md-gate-pass-kpi-requests"
          label="Passes requested"
          value={num(o?.requests.value)}
          sub={previousText(o?.requests)}
          icon={DoorOpen}
          tone="blue"
          delta={deltaOf(o?.requests, null)}
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["passes"]}
          onClick={drillClick(() => setDrill({ title: "Gate passes requested", filter: {} }))}
        />
        <StatCard
          testId="md-gate-pass-kpi-returned"
          label="Came back"
          value={num(o?.returned.value)}
          sub={o ? `${pct(o.returnRatePct.value)} of passes that left` : undefined}
          icon={CheckCircle2}
          tone="green"
          delta={deltaOf(o?.returned, null)}
          loading={summary.isPending}
          onClick={tile("returned", "Passes that came back")}
        />
        <StatCard
          testId="md-gate-pass-kpi-not-returned"
          label="Never scanned back"
          value={num(o?.notReturned.value)}
          sub={o ? `${num(o.left.value)} went out in all` : undefined}
          icon={LogOut}
          tone="red"
          delta={deltaOf(o?.notReturned, false)}
          loading={summary.isPending}
          onClick={tile("not_returned", "Passes never scanned back")}
        />
        <StatCard
          testId="md-gate-pass-kpi-hours"
          label="Hours out"
          value={o?.hoursOut.value == null ? "—" : `${num(o.hoursOut.value, 1)} h`}
          sub={o ? `Average ${minutesText(o.avgMinutesOut.value)} a pass` : undefined}
          icon={Timer}
          tone="indigo"
          delta={deltaOf(o?.hoursOut, false)}
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["hours-out"]}
          onClick={tile("returned", "Passes that came back")}
        />
        <StatCard
          testId="md-gate-pass-kpi-outside"
          label="Outside now"
          value={num(o?.outsideNow)}
          sub={o ? `${num(o.overdueNow ?? 0)} past their return time` : undefined}
          icon={Footprints}
          tone="amber"
          loading={summary.isPending}
          onClick={tile("outside_now", "Outside now")}
        />
        <StatCard
          testId="md-gate-pass-kpi-waiting"
          label="Waiting for approval"
          value={num(o?.waitingNow.waiting)}
          sub={o ? `${num(o.waitingNow.overOneDay)} over a day` : undefined}
          icon={Hourglass}
          tone="purple"
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["waiting"]}
          onClick={tile("waiting", "Waiting for approval")}
        />
        <StatCard
          testId="md-gate-pass-kpi-rejected"
          label="Rejected"
          value={num(o?.rejected.value)}
          sub={o ? `${pct(o.rejectionRatePct.value)} of decisions` : undefined}
          icon={XCircle}
          tone="slate"
          delta={deltaOf(o?.rejected, null)}
          loading={summary.isPending}
          onClick={tile("rejected", "Rejected passes")}
        />
        <StatCard
          testId="md-gate-pass-kpi-approval"
          label="Typical approval time"
          value={minutesText(o?.turnaroundMedianMinutes.value)}
          sub={o ? `Average ${minutesText(o.turnaroundAvgMinutes.value)}` : undefined}
          icon={Clock3}
          tone="teal"
          delta={deltaOf(o?.turnaroundMedianMinutes, false, "minutes")}
          loading={summary.isPending}
          provenance={summary.data?.provenance}
          provenanceIds={["turnaround"]}
        />
      </TileGrid>

      <AttentionCard items={attention} query={exceptions} ask={ask.attention} testId="md-gate-pass-attention" />

      <OutpassTrendCard query={trend} ask={ask.trend} />

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <OutpassGroupsCard query={breakdown} ask={ask.groups} onDrill={setDrill} />
        <FunnelCard query={breakdown} ask={ask.funnel} onDrill={setDrill} />
      </div>

      <DurationsAndScansCard query={breakdown} ask={ask.durations} />

      <Notes notes={summary.data?.notes.filter((n) => !/check-out|company/i.test(n))} testId="md-gate-pass-notes" />

      <PassSheet drill={drill} params={params} onClose={() => setDrill(null)} />
    </div>
  );
}

/** The strip above the Gate Pass page: who is outside on a pass right now, the gate-pass figures of the brief, and the top
 *  exceptions, each with Explain. */
export function Strip() {
  const brief = useBrief(PAGE);
  const outside = useMdQuery<PassList>(
    "visitors/pass-list",
    { period: "today", outcome: "outside_now", pageSize: 1 },
    { refetchInterval: 60_000 },
  );
  const kpis = (brief.data?.kpis ?? []).filter((k) => !k.page || k.page === PAGE);
  const insights = sortInsights(brief.data?.insights ?? [])
    .filter((i) => !i.page || i.page === PAGE)
    .slice(0, 2);
  const now = outside.data?.total;
  if (
    (brief.isError && outside.isError) ||
    (!brief.isLoading && !outside.isLoading && !now && kpis.length === 0 && insights.length === 0)
  ) {
    return null;
  }
  return (
    <StripShell
      testId="md-gate-pass-strip"
      question={pageQuestion(TITLE)}
      loading={brief.isLoading}
      below={<StripInsights items={insights} testId="md-gate-pass-strip-insights" />}
    >
      {now !== undefined && (
        <StripFigure testId="md-gate-pass-strip-outside" label="Outside now" value={num(now)}>
          {now > 0 && <StripNote tone="watch">on a pass today</StripNote>}
        </StripFigure>
      )}
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}
