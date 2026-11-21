import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import DonutChart from "@/components/md/kit/DonutChart";
import SectionCard from "@/components/md/kit/SectionCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, dayShort, num, pct } from "@/lib/md/format";
import SegTabs from "../shared/SegTabs";
import { anyOf, mins, trendRows } from "../outpass/logic";
import { QueryError, refreshingClass } from "../outpass/parts";
import type { TrendResponse, VisitorsResponse } from "../outpass/types";
import type { VisitDrill } from "./VisitSheet";

const VISITS: TrendSeries = { key: "visits", label: "Visits", kind: "bar", color: CHART.brand };

/** Visits per day (or week). */
export function VisitTrendCard({ query, ask }: { query: UseQueryResult<TrendResponse>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(() => (trend ? trendRows(trend.points) : []), [trend]);
  const weekly = trend?.granularity === "week";
  return (
    <SectionCard
      title="Visitors over time"
      subtitle={`${weekly ? "Week by week" : "Day by day"}: check-ins at the gate and the reception desks`}
      loading={query.isPending}
      provenance={trend?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-visitors-trend"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && anyOf(trend.points, "visits") ? (
        <TrendChart data={rows} xKey="date" series={[VISITS]} height={220} xFormat={dayShort} yFormat={(v) => num(v)} />
      ) : trend ? (
        <EmptyBlock title="No visitors in this period" testId="md-visitors-trend-empty">
          Nobody checked in for this selection, so there is nothing to chart.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

/** Check-out and time inside (from 18 Nov 2026): how long visits lasted and how each way in is checked out. */
export function StayCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<VisitorsResponse>;
  ask: string;
  onDrill: (drill: VisitDrill) => void;
}) {
  const data = query.data;
  const c = data?.checkout;
  const sources = data?.sources ?? [];
  return (
    <SectionCard
      title="Check-out and time inside"
      subtitle={
        c
          ? `${num(c.checkedOut)} of ${num(c.checkoutEligible)} visits since ${dayLong(c.since)} checked out (${pct(c.checkedOutPct)}) · typical stay ${mins(c.medianMinutesInside)}`
          : "Check-out is recorded from 18 Nov 2026"
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-visitors-stay"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : c && c.checkoutEligible > 0 ? (
        <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-2">
          <div>
            <h4 className="md-analytics-subhead mb-2">How long visits lasted</h4>
            <BarList
              items={c.stayBands.map((b) => ({
                key: b.key,
                label: b.label,
                value: b.visits,
                display: `${num(b.visits)} (${pct(b.sharePct, 0)})`,
              }))}
              color={CHART.deep}
              emptyText="No visit was checked out yet."
              testId="md-visitors-stay-bars"
            />
          </div>
          <div>
            <h4 className="md-analytics-subhead mb-2">How visitors came in</h4>
            <BarList
              items={sources.map((s) => ({
                key: s.key,
                label: s.label,
                value: s.visits,
                sub: `${num(s.checkedOut)} checked out · average stay ${mins(s.avgMinutesInside)}`,
              }))}
              onSelect={(item) => {
                const s = sources.find((x) => x.key === item.key);
                if (s) onDrill({ title: s.label, filter: { source: s.key } });
              }}
              testId="md-visitors-source-bars"
            />
          </div>
        </div>
      ) : data ? (
        <EmptyBlock title="No check-outs to measure" testId="md-visitors-stay-empty">
          Check-out is recorded from 18 Nov 2026, by HR or a reception desk. No visit in this period could have one.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

type GroupBy = "purpose" | "host" | "desk" | "company";
const GROUP_TABS: { value: GroupBy; label: string }[] = [
  { value: "purpose", label: "Purposes" },
  { value: "host", label: "People visited" },
  { value: "desk", label: "Desks" },
  { value: "company", label: "Companies" },
];

/** Why visitors come, whom they see, which desk takes them and which companies they come from. A row opens its visits. */
export function VisitGroupsCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<VisitorsResponse>;
  ask: string;
  onDrill: (drill: VisitDrill) => void;
}) {
  const [by, setBy] = useState<GroupBy>("purpose");
  const data = query.data;
  const rows: { key: string; label: string; value: number; sub?: string; drill?: VisitDrill }[] =
    by === "purpose"
      ? (data?.purposes.categories ?? []).map((p) => ({
          key: p.key,
          label: p.label,
          value: p.visits,
          sub: `${pct(p.sharePct)} of visits`,
          drill: { title: p.label, filter: { purpose: p.key } },
        }))
      : by === "host"
        ? (data?.topHosts ?? []).map((h) => ({
            key: `${h.employeeId ?? "free"}-${h.name}`,
            label: h.name,
            value: h.visits,
            sub: `${h.department ?? "Typed by the visitor"} · ${num(h.uniqueVisitors)} different ${h.uniqueVisitors === 1 ? "visitor" : "visitors"}`,
            drill: h.employeeId ? { title: `Visitors for ${h.name}`, filter: { host: h.employeeId } } : undefined,
          }))
        : by === "desk"
          ? (data?.desks ?? []).map((d) => ({
              key: String(d.deskId),
              label: d.desk ?? "Desk",
              value: d.checkIns,
              sub: `${num(d.checkOuts)} check-outs`,
              drill: { title: `${d.desk ?? "Desk"}: visits`, filter: { desk: d.deskId } },
            }))
          : (data?.companies?.rows ?? []).map((c) => ({
              key: c.company ?? "-",
              label: c.company ?? "—",
              value: c.visits,
              sub: `${num(c.uniqueVisitors)} different ${c.uniqueVisitors === 1 ? "visitor" : "visitors"}`,
              drill: c.company ? { title: `From ${c.company}`, filter: { company: c.company } } : undefined,
            }));
  const empty = {
    purpose: "No visits in this period.",
    host: "No visits in this period.",
    desk: "No visit went through a reception desk in this period.",
    company: "No visit with a company in this period (only HR and the desks ask for one).",
  }[by];
  return (
    <SectionCard
      title="Who comes, and why"
      subtitle="Visits per group. Click a row for its visits."
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-visitors-groups"
    >
      <div className="mb-3">
        <SegTabs
          label="Group by"
          items={GROUP_TABS}
          value={by}
          onChange={(v) => setBy(v as GroupBy)}
          testId="md-visitors-group-tabs"
        />
      </div>
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <BarList
          items={rows.map(({ key, label, value, sub }) => ({ key, label, value, sub }))}
          format={(n) => num(n)}
          onSelect={(item) => {
            const row = rows.find((r) => r.key === item.key);
            if (row?.drill) onDrill(row.drill);
          }}
          emptyText={empty}
          testId="md-visitors-group-bars"
        />
      )}
    </SectionCard>
  );
}

/** The host departments as a donut, and the visits nobody could match to an employee. */
export function HostDepartmentsCard({ query, ask }: { query: UseQueryResult<VisitorsResponse>; ask: string }) {
  const data = query.data;
  const slices: { name: string; value: number; color: string }[] = (data?.hostDepartments ?? [])
    .slice(0, 6)
    .map((d, i) => ({
      name: d.department,
      value: d.visits,
      color: CHART.series[i % CHART.series.length],
    }));
  const rest = (data?.hostDepartments ?? []).slice(6).reduce((sum, d) => sum + d.visits, 0);
  if (rest > 0) slices.push({ name: "Other departments", value: rest, color: CHART.slate });
  if (data && data.hostsNotLinked.visits > 0) {
    slices.push({ name: "Host typed by the visitor", value: data.hostsNotLinked.visits, color: CHART.light });
  }
  return (
    <SectionCard
      title="Departments visited"
      subtitle="Visits by the department of the person visited"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-visitors-departments"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : slices.length > 0 ? (
        <DonutChart data={slices} center={num(data?.visits)} format={(n) => num(n)} testId="md-visitors-donut" />
      ) : data ? (
        <EmptyBlock title="No visits in this period">Nobody checked in for this selection.</EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
