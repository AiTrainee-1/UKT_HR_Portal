import { useMemo, useState } from "react";
import { AlarmClock, Ban, Coffee, Gauge, Hourglass, ShieldCheck, Timer, UserX } from "lucide-react";
import { pageQuestion, useBrief } from "@/components/md/embedded/brief";
import StatCard from "@/components/md/kit/StatCard";
import { kpiValueText, sortInsights } from "@/components/md/kit/dto";
import { useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { num, pct } from "@/lib/md/format";
import { scopeIsEveryone } from "@/lib/md/period";
import type { InsightsDefaults } from "../shared/filters";
import { drillClick } from "../shared/drill";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { StripFigure, StripInsights, StripNote, StripShell } from "../shared/InsightStrip";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import { deltaOf, forWhom, inWhen, previousText } from "../outpass/logic";
import { AttentionCard, BriefCard, Notes, TileGrid, refreshingClass } from "../outpass/parts";
import RecordsSheet, { type TeaDrill } from "./RecordsSheet";
import { OffendersCard, TeaGroupsCard, TeaTrendCard } from "./TeaCards";
import type {
  TeaAttention,
  TeaGroupBy,
  TeaGroups,
  TeaOffenders,
  TeaRecords,
  TeaStory,
  TeaSummary,
  TeaTrend,
} from "./types";

const PAGE = "tea-break";
const TITLE = "Tea Break";
const DEFAULTS: InsightsDefaults = { extra: { by: "department" } };

/**
 * Tea Break, Insights & AI: is break discipline costing production time? Overruns, minutes lost, where and who, breaks
 * that cannot be measured, and the tea-break codes a gate refused (Manage Gates). The HR page itself (records, the rule)
 * is the Operations tab. Every figure follows the month / range and unit / department filters; a tile, group or person
 * opens the breaks behind it.
 */
export default function TeaBreakInsights() {
  const { filters, params, label, setWhen, setScope, setExtra } = useInsightsFilters(DEFAULTS);
  const org = useMdOrg();
  const [drill, setDrill] = useState<TeaDrill | null>(null);
  const by = (filters.extra.by || "department") as TeaGroupBy;
  // the group-by choice is the page's own filter: it rides in the address but is not a filter of the other figures
  const base = useMemo(() => Object.fromEntries(Object.entries(params).filter(([key]) => key !== "by")), [params]);

  const story = useMdQuery<TeaStory>("tea-break/story", base);
  const summary = useMdQuery<TeaSummary>("tea-break/summary", base);
  const trend = useMdQuery<TeaTrend>("tea-break/trend", base);
  const groups = useMdQuery<TeaGroups>("tea-break/departments", { ...base, by, limit: 25 });
  const offenders = useMdQuery<TeaOffenders>("tea-break/offenders", { ...base, limit: 10 });
  const attention = useMdQuery<TeaAttention>("tea-break/attention", base);

  const s = summary.data;
  const m = s?.metrics;
  const when = inWhen(s?.period?.label ?? label);
  const who = forWhom(s?.scope?.description, scopeIsEveryone(filters.scope));
  const ask = {
    page: `Explain tea-break discipline ${when}${who}: what changed, why, and what should I look at first?`,
    attention: `What needs my attention on tea breaks ${when}${who}?`,
    trend: `Is tea-break discipline getting better or worse ${when}${who}?`,
    groups: `Which ${by === "type" ? "group (staff or production)" : by} loses the most minutes to tea-break overruns ${when}${who}?`,
    offenders: `Who overran their tea break most often ${when}${who}, and by how much?`,
  };

  usePublishAssistantContext({
    page: PAGE,
    title: TITLE,
    filters: { Period: s?.period?.label ?? label, Scope: s?.scope?.description ?? "", "Group by": by },
    summary: m
      ? {
          Breaks: num(m.breaks.value),
          "Overrun rate": pct(m.overrunPct.value),
          "Minutes lost": num(m.minutesLost.value),
          "Average break": `${num(m.avgMinutes.value, 1)} min`,
          "Refused at a gate": num(s?.refused?.value ?? 0),
        }
      : {},
  });

  const status = (key: string, title: string) => drillClick(() => setDrill({ title, filter: { status: key } }));

  return (
    <div className="space-y-5" data-testid="md-tea-insights">
      <InsightsFilterBar filters={filters} onWhen={setWhen} onScope={setScope} org={org.data} testId="md-tea-filters" />

      <BriefCard
        query={story}
        ask={ask.page}
        testId="md-tea-briefing"
        empty="Nobody scanned a tea break for this selection."
      />

      <TileGrid testId="md-tea-kpis" className={refreshingClass(summary)}>
        <StatCard
          testId="md-tea-kpi-breaks"
          label="Breaks taken"
          value={num(m?.breaks.value)}
          sub={s ? `${num(m?.employees.value)} people · ${pct(s.coverage.participationPct)} of staff scan` : undefined}
          icon={Coffee}
          tone="blue"
          delta={deltaOf(m?.breaks, null)}
          loading={summary.isPending}
          provenance={s?.provenance}
          provenanceIds={["tea-breaks", "tea-coverage"]}
          onClick={drillClick(() => setDrill({ title: "Every tea break", filter: {} }))}
        />
        <StatCard
          testId="md-tea-kpi-overrun"
          label="Over the allowance"
          value={pct(m?.overrunPct.value)}
          sub={s ? `${num(m?.overruns.value)} of ${num(m?.measured.value)} measured breaks` : undefined}
          icon={AlarmClock}
          tone="red"
          delta={deltaOf(m?.overrunPct, false, "pct")}
          loading={summary.isPending}
          provenance={s?.provenance}
          provenanceIds={["tea-overrun"]}
          onClick={status("overrun", "Breaks over the allowance")}
        />
        <StatCard
          testId="md-tea-kpi-lost"
          label="Minutes lost"
          value={num(m?.minutesLost.value)}
          sub={s?.hoursLost != null ? `${num(s.hoursLost, 1)} hours beyond the allowance` : undefined}
          icon={Hourglass}
          tone="amber"
          delta={deltaOf(m?.minutesLost, false)}
          loading={summary.isPending}
          provenance={s?.provenance}
          provenanceIds={["tea-minutes-lost"]}
          onClick={status("overrun", "Breaks over the allowance")}
        />
        <StatCard
          testId="md-tea-kpi-average"
          label="Average break"
          value={m?.avgMinutes.value == null ? "—" : `${num(m.avgMinutes.value, 1)} min`}
          sub={s ? `${num(s.allowedMinutes)} minutes allowed` : undefined}
          icon={Timer}
          tone="indigo"
          delta={deltaOf(m?.avgMinutes, false)}
          loading={summary.isPending}
          provenance={s?.provenance}
          provenanceIds={["tea-average"]}
        />
        <StatCard
          testId="md-tea-kpi-within"
          label="Within the allowance"
          value={pct(m?.compliancePct.value)}
          sub={s?.withinAllowance != null ? `${num(s.withinAllowance)} breaks` : undefined}
          icon={ShieldCheck}
          tone="green"
          delta={deltaOf(m?.compliancePct, true, "pct")}
          loading={summary.isPending}
          provenance={s?.provenance}
          provenanceIds={["tea-compliance"]}
          onClick={status("within", "Breaks within the allowance")}
        />
        <StatCard
          testId="md-tea-kpi-long"
          label="Over 60 minutes"
          value={num(s?.coverage.longCompleted)}
          sub="Probably a missed scan: left out of the rates"
          icon={Gauge}
          tone="purple"
          loading={summary.isPending}
          provenance={s?.provenance}
          provenanceIds={["tea-unmeasured"]}
          onClick={status("long", "Breaks over 60 minutes")}
        />
        <StatCard
          testId="md-tea-kpi-no-return"
          label="No return scan"
          value={num(s?.coverage.noReturn)}
          sub={s ? `${num(s.coverage.inProgress)} on a break right now` : undefined}
          icon={UserX}
          tone="slate"
          loading={summary.isPending}
          onClick={status("no_return", "Breaks with no return scan")}
        />
        <StatCard
          testId="md-tea-kpi-refused"
          label="Refused at a gate"
          value={num(s?.refused?.value ?? 0)}
          sub={s?.refused ? previousText(s.refused) : "A gate that does not take tea breaks"}
          icon={Ban}
          tone="teal"
          delta={deltaOf(s?.refused, false)}
          loading={summary.isPending}
          provenance={s?.provenance}
          provenanceIds={["tea-refused"]}
          onClick={status("refused", "Tea-break codes refused at a gate")}
        />
      </TileGrid>

      <AttentionCard
        items={attention.data?.items ?? []}
        query={attention}
        ask={ask.attention}
        testId="md-tea-attention"
      />

      <TeaTrendCard query={trend} ask={ask.trend} />

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <TeaGroupsCard
          query={groups}
          by={by}
          onBy={(next) => setExtra("by", next)}
          ask={ask.groups}
          onDrill={setDrill}
        />
        <OffendersCard query={offenders} ask={ask.offenders} onDrill={setDrill} />
      </div>

      <Notes notes={s?.notes} testId="md-tea-notes" />

      <RecordsSheet drill={drill} params={base} onClose={() => setDrill(null)} />
    </div>
  );
}

/** The strip above the Tea Break page: who is on a break right now, the tea figures of the brief and the top exceptions. */
export function Strip() {
  const brief = useBrief(PAGE);
  const now = useMdQuery<TeaRecords>(
    "tea-break/records",
    { period: "today", status: "in_progress", pageSize: 1 },
    { refetchInterval: 60_000 },
  );
  const kpis = brief.data?.kpis ?? [];
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  const onBreak = now.data?.total;
  if (
    (brief.isError && now.isError) ||
    (!brief.isLoading && !now.isLoading && !onBreak && kpis.length === 0 && insights.length === 0)
  ) {
    return null;
  }
  return (
    <StripShell
      testId="md-tea-strip"
      question={pageQuestion(TITLE)}
      loading={brief.isLoading}
      below={<StripInsights items={insights} testId="md-tea-strip-insights" />}
    >
      {onBreak !== undefined && (
        <StripFigure testId="md-tea-strip-now" label="On a break now" value={num(onBreak)}>
          {onBreak > 0 && <StripNote tone="watch">scanned out</StripNote>}
        </StripFigure>
      )}
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}
