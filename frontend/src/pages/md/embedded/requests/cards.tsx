import { useMemo, type ComponentType } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { CheckCircle2, Clock, Hourglass, Inbox, Send, Timer, UserCog, XCircle } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard from "@/components/md/kit/StatCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { dayShort, num } from "@/lib/md/format";
import BriefingList from "../shared/BriefingList";
import { hasTrend, kpiTiles, trendRows } from "./logic";
import type { Drill, RqAttention, RqSummary, RqTrend } from "./types";
import { drillClick } from "../shared/drill";

/** A card whose request failed: what the server said, and a retry. The other cards are unaffected. */
export function QueryError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** While a changed filter loads, the old figures stay on screen, dimmed, so nobody reads last month's numbers as this. */
export function refreshingClass(...queries: UseQueryResult<unknown>[]): string {
  return queries.some((q) => q.isFetching && !q.isPending) ? "opacity-60 transition-opacity" : "transition-opacity";
}

/** The page in a few plain sentences, written by the server from the very figures below (no AI until Explain). */
export function BriefingCard({ query, ask }: { query: UseQueryResult<RqSummary>; ask: string }) {
  const data = query.data;
  return (
    <SectionCard
      title="In plain words"
      subtitle="Written from the figures below by fixed rules: no AI is asked until you press Explain"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={data?.briefing.ask || ask} label="Explain with AI" />}
      bodyClassName={refreshingClass(query)}
      testId="md-requests-briefing"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <BriefingList sentences={data.briefing.sentences} testIdPrefix="md-requests-sentence" />
      ) : null}
    </SectionCard>
  );
}

const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  waiting: Inbox,
  aged: Hourglass,
  hod: UserCog,
  submitted: Send,
  decided: Clock,
  approval: CheckCircle2,
  rejected: XCircle,
  speed: Timer,
};

/** The eight headline figures; each but the speed opens the requests behind it. */
export function KpiStrip({ query, onDrill }: { query: UseQueryResult<RqSummary>; onDrill: (d: Drill) => void }) {
  const data = query.data;
  const tiles = data ? kpiTiles(data) : [];
  return (
    <div>
      <div
        className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 [&>*:last-child:nth-child(odd)]:col-span-2 @3xl:[&>*:last-child:nth-child(odd)]:col-span-1 ${refreshingClass(query)}`}
        data-testid="md-requests-kpis"
      >
        {data
          ? tiles.map((t) => (
              <StatCard
                key={t.id}
                testId={`md-requests-kpi-${t.id}`}
                label={t.label}
                value={t.value}
                sub={t.sub}
                icon={ICONS[t.id] ?? Inbox}
                tone={t.tone}
                delta={t.delta}
                provenance={data.provenance}
                provenanceIds={t.provenanceIds}
                onClick={t.drill ? drillClick(() => onDrill(t.drill as Drill)) : undefined}
              />
            ))
          : Object.keys(ICONS).map((id) => (
              <StatCard
                key={id}
                testId={`md-requests-kpi-${id}`}
                label=" "
                value="—"
                icon={ICONS[id]}
                loading={query.isPending}
              />
            ))}
      </div>
      {data && (
        <p className="md-analytics-note px-1" data-testid="md-requests-compare">
          Changes compare with {dayShort(data.previousPeriod.start)} to {dayShort(data.previousPeriod.end)}, the same
          number of days just before. Click a figure to see the requests behind it.
        </p>
      )}
    </div>
  );
}

/** "Needs your attention": what stands out, worst first, each with Explain. The page links point here, so they go. */
export function AttentionCard({ query, ask }: { query: UseQueryResult<RqAttention>; ask: string }) {
  const items = sortInsights(query.data?.items ?? []).map((dto) => toInsight({ ...dto, page: null }));
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="What stands out in this period, worst first"
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-requests-attention"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <InsightList items={items} emptyText="Nothing needs your attention in this period." />
      )}
    </SectionCard>
  );
}

const SUBMITTED: TrendSeries = { key: "submitted", label: "Submitted", kind: "bar", color: CHART.brand };
const DECIDED: TrendSeries = { key: "decided", label: "Decided", kind: "line", color: CHART.deep };
const PREVIOUS: TrendSeries = {
  key: "previousSubmitted",
  label: "Submitted, previous period",
  kind: "line",
  color: CHART.slate,
  dashed: true,
};

/** Requests coming in (bars) against requests decided (line), with the previous period's arrivals dashed beside them. */
export function TrendCard({ query, ask }: { query: UseQueryResult<RqTrend>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(() => (trend ? trendRows(trend) : []), [trend]);
  const weekly = trend?.granularity === "week";
  return (
    <SectionCard
      title="Coming in and going out"
      subtitle={
        trend
          ? `${weekly ? "Week by week" : "Day by day"}: requests submitted (bars) against requests decided (line); the dashed line is the period before`
          : undefined
      }
      loading={query.isPending}
      provenance={trend?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-requests-trend"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && hasTrend(trend) ? (
        <>
          <TrendChart
            data={rows}
            xKey="date"
            series={[SUBMITTED, DECIDED, PREVIOUS]}
            height={240}
            xFormat={dayShort}
            yFormat={(v) => num(v)}
          />
          <p className="md-analytics-note" data-testid="md-requests-trend-total">
            {num(trend.totals.submitted.value)} submitted ({num(trend.totals.submitted.previous)} in the period before)
            and {num(trend.totals.decided.value)} decided.
            {weekly ? " Each point is a week, labelled by its first day." : ""}
          </p>
        </>
      ) : trend ? (
        <EmptyBlock title="No requests in this period" testId="md-requests-trend-empty">
          Nothing was submitted or decided for this selection, so there is nothing to chart.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
