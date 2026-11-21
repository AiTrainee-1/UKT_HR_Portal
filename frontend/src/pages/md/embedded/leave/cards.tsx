import { useMemo, type ComponentType } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { BadgePercent, CalendarClock, CalendarX2, FileText, Hourglass, Percent, Timer, UsersRound } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard from "@/components/md/kit/StatCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { dayLong, dayShort, num } from "@/lib/md/format";
import BriefingList from "../shared/BriefingList";
import { daysText, hasTrend, kpiTiles, trendRows } from "./logic";
import type { Drill, LvAttention, LvBriefing, LvPermissions, LvSummary, LvTrend } from "./types";
import { drillClick } from "../shared/drill";

/** A card whose request failed: what the server said, and a retry. The other cards are unaffected. */
export function QueryError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** While a changed filter loads, the old figures stay on screen, dimmed, so nobody reads last month's numbers as this. */
export function refreshingClass(...queries: UseQueryResult<unknown>[]): string {
  return queries.some((q) => q.isFetching && !q.isPending) ? "opacity-60 transition-opacity" : "transition-opacity";
}

/** Leave in a few plain sentences, written by the server from the very figures below (no AI until Explain). */
export function BriefingCard({ query, ask }: { query: UseQueryResult<LvBriefing>; ask: string }) {
  const data = query.data;
  return (
    <SectionCard
      title="In plain words"
      subtitle="Written from the figures below by fixed rules: no AI is asked until you press Explain"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={data?.ask || ask} label="Explain with AI" />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-briefing"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <BriefingList sentences={data.sentences} testIdPrefix="md-leave-sentence" />
      ) : null}
    </SectionCard>
  );
}

const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  days: CalendarX2,
  rate: Percent,
  "per-head": UsersRound,
  applied: FileText,
  rejected: BadgePercent,
  short: Timer,
  waiting: Hourglass,
  permissions: CalendarClock,
};

/** The headline figures; most open the requests, days or permissions behind them. */
export function KpiStrip({
  summary,
  permissions,
  onDrill,
}: {
  summary: UseQueryResult<LvSummary>;
  permissions: UseQueryResult<LvPermissions>;
  onDrill: (d: Drill) => void;
}) {
  const data = summary.data;
  const tiles = data ? kpiTiles(data, permissions.data) : [];
  const provenance = [...(data?.provenance ?? []), ...(permissions.data?.provenance ?? [])];
  return (
    <div>
      <div
        className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 [&>*:last-child:nth-child(odd)]:col-span-2 @3xl:[&>*:last-child:nth-child(odd)]:col-span-1 ${refreshingClass(summary)}`}
        data-testid="md-leave-kpis"
      >
        {data
          ? tiles.map((t) => (
              <StatCard
                key={t.id}
                testId={`md-leave-kpi-${t.id}`}
                label={t.label}
                value={t.value}
                sub={t.sub}
                icon={ICONS[t.id] ?? CalendarX2}
                tone={t.tone}
                delta={t.delta}
                provenance={provenance}
                provenanceIds={t.provenanceIds}
                onClick={t.drill ? drillClick(() => onDrill(t.drill as Drill)) : undefined}
              />
            ))
          : Object.keys(ICONS).map((id) => (
              <StatCard
                key={id}
                testId={`md-leave-kpi-${id}`}
                label=" "
                value="—"
                icon={ICONS[id]}
                loading={summary.isPending}
              />
            ))}
      </div>
      {data && (
        <p className="md-analytics-note px-1" data-testid="md-leave-compare">
          Changes compare with {dayShort(data.previousPeriod.start)} to {dayShort(data.previousPeriod.end)}, the same
          number of days just before. Click a figure to see who or what is behind it.
        </p>
      )}
    </div>
  );
}

/** "Needs your attention": what stands out, worst first, each with Explain. */
export function AttentionCard({ query, ask }: { query: UseQueryResult<LvAttention>; ask: string }) {
  const items = sortInsights(query.data?.items ?? []).map((dto) => toInsight({ ...dto, page: null }));
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="What stands out in this period, worst first"
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-attention"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <InsightList items={items} emptyText="Nothing needs your attention in this period." />
      )}
    </SectionCard>
  );
}

const PREVIOUS: TrendSeries = {
  key: "previous",
  label: "Previous period",
  kind: "line",
  color: CHART.slate,
  dashed: true,
};

/** Leave days over time by type (stacked), with the period before dashed beside them, and whether leave is rising. */
export function TrendCard({ query, ask }: { query: UseQueryResult<LvTrend>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(() => (trend ? trendRows(trend) : []), [trend]);
  const series = useMemo<TrendSeries[]>(
    () => [
      ...(trend?.types ?? []).map((t, i) => ({
        key: t.key,
        label: t.label,
        kind: "bar" as const,
        stackId: "leave",
        color: CHART.series[i % CHART.series.length],
      })),
      PREVIOUS,
    ],
    [trend],
  );
  const step =
    trend?.granularity === "month" ? "Month by month" : trend?.granularity === "week" ? "Week by week" : "Day by day";
  return (
    <SectionCard
      title="Is leave rising or falling?"
      subtitle={trend ? `${step}: approved leave days by type; the dashed line is the period before` : undefined}
      loading={query.isPending}
      provenance={trend?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-trend"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && hasTrend(trend) ? (
        <>
          <p className="md-analytics-note mb-2" data-testid="md-leave-momentum" data-verdict={trend.momentum.verdict}>
            {trend.momentum.text}
          </p>
          <TrendChart
            data={rows}
            xKey="date"
            series={series}
            height={240}
            xFormat={dayShort}
            yFormat={(v) => num(v, 1)}
          />
          <p className="md-analytics-note" data-testid="md-leave-trend-total">
            {daysText(trend.totalDays)} in all
            {trend.busiestDay
              ? `; the busiest day was ${dayLong(trend.busiestDay.date)} with ${num(trend.busiestDay.onLeave)} on leave`
              : ""}
            .
          </p>
        </>
      ) : trend ? (
        <EmptyBlock title="No leave in this period" testId="md-leave-trend-empty">
          No approved leave falls in this period for this selection, so there is nothing to chart.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
