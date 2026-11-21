import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayShort, num, pct } from "@/lib/md/format";
import SegTabs from "../shared/SegTabs";
import { anyOf, mins, trendRows } from "./logic";
import type { PassDrill } from "./PassSheet";
import { QueryError, refreshingClass } from "./parts";
import type { OutpassResponse, TrendResponse } from "./types";

const PASSES: TrendSeries = { key: "passes", label: "Passes requested", kind: "bar", color: CHART.brand };
const RETURNED: TrendSeries = { key: "returned", label: "Came back", kind: "line", color: CHART.good };
const HOURS: TrendSeries = { key: "hoursOut", label: "Hours out", kind: "line", color: CHART.deep, rightAxis: true };

/** Passes requested per day (or week), how many came back, and the hours spent out on the right-hand scale. */
export function OutpassTrendCard({ query, ask }: { query: UseQueryResult<TrendResponse>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(() => (trend ? trendRows(trend.points) : []), [trend]);
  const weekly = trend?.granularity === "week";
  return (
    <SectionCard
      title="Gate passes over time"
      subtitle={`${weekly ? "Week by week" : "Day by day"}: passes requested, how many came back, and hours out (right-hand scale)`}
      loading={query.isPending}
      provenance={trend?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-gate-pass-trend"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && anyOf(trend.points, "passes") ? (
        <TrendChart
          data={rows}
          xKey="date"
          series={[PASSES, RETURNED, HOURS]}
          height={240}
          xFormat={dayShort}
          yFormat={(v) => num(v)}
          rightFormat={(v) => `${num(v, 1)} h`}
        />
      ) : trend ? (
        <EmptyBlock title="No gate passes in this period" testId="md-gate-pass-trend-empty">
          Nobody asked for a gate pass for this selection, so there is nothing to chart.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

type GroupBy = "department" | "reason" | "gate";
const GROUP_TABS: { value: GroupBy; label: string }[] = [
  { value: "department", label: "Departments" },
  { value: "reason", label: "Reasons" },
  { value: "gate", label: "Gates" },
];

/** Where the time goes: hours out by department, by kind of pass, or by the gate people left through. A row opens its passes. */
export function OutpassGroupsCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<OutpassResponse>;
  ask: string;
  onDrill: (drill: PassDrill) => void;
}) {
  const [by, setBy] = useState<GroupBy>("department");
  const data = query.data;
  const items =
    by === "department"
      ? (data?.byDepartment ?? []).map((d) => ({
          key: d.department,
          label: d.department,
          value: d.requests,
          display: `${num(d.requests)} · ${mins(d.minutesOut)}`,
          sub: `${num(d.employees)} ${d.employees === 1 ? "person" : "people"}${d.requestsPer100 != null ? ` · ${num(d.requestsPer100, 1)} per 100 staff` : ""}${d.notReturned ? ` · ${num(d.notReturned)} never returned` : ""}`,
          drill: { title: `${d.department}: gate passes`, filter: { departmentName: d.department } },
        }))
      : by === "reason"
        ? (data?.byReason ?? []).map((r) => ({
            key: r.key,
            label: r.label,
            value: r.requests,
            display: `${num(r.requests)} · ${mins(r.minutesOut)}`,
            sub: `${pct(r.sharePct)} of passes · average ${mins(r.avgMinutes)} out`,
            drill: { title: `${r.label}: gate passes`, filter: { reason: r.key } },
          }))
        : (data?.byGate ?? []).map((g) => ({
            key: g.gate,
            label: g.gate,
            value: g.wentOut,
            display: `${num(g.wentOut)} out`,
            sub: `${num(g.cameBack)} back · ${num(g.stillOut)} still out · ${num(g.notReturned)} never returned · average ${mins(g.avgMinutesOut)}`,
            drill: { title: `Out through ${g.gate}`, filter: { gate: g.gate } },
          }));
  return (
    <SectionCard
      title="Where the time goes"
      subtitle="Passes and time out per group (passes · hours out). Click a row for its passes."
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-gate-pass-groups"
    >
      <div className="mb-3">
        <SegTabs
          label="Group by"
          items={GROUP_TABS}
          value={by}
          onChange={(v) => setBy(v as GroupBy)}
          testId="md-gate-pass-group-tabs"
        />
      </div>
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <BarList
          items={items}
          format={(n) => num(n)}
          onSelect={(item) => {
            const row = items.find((i) => i.key === item.key);
            if (row) onDrill(row.drill);
          }}
          emptyText={
            by === "gate" ? "No pass went out through a gate in this period." : "No gate passes in this period."
          }
          testId="md-gate-pass-group-bars"
        />
      )}
    </SectionCard>
  );
}

/** From request to return: how many were approved, left and came back, and where the rest stopped. Each step opens its passes. */
export function FunnelCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<OutpassResponse>;
  ask: string;
  onDrill: (drill: PassDrill) => void;
}) {
  const f = query.data?.funnel;
  const steps = f
    ? [
        { key: "returned", label: "Came back", value: f.returned, outcome: "returned" },
        { key: "outside_now", label: "Outside now", value: f.dropOffs.outsideNow, outcome: "outside_now" },
        { key: "not_returned", label: "Never scanned back", value: f.dropOffs.notReturned, outcome: "not_returned" },
        { key: "early", label: "Left early (dismissal)", value: f.dropOffs.earlyDismissal, outcome: "early_dismissal" },
        { key: "unused", label: "Approved, not used", value: f.dropOffs.approvedNotUsed, outcome: "approved_unused" },
        { key: "waiting", label: "Waiting for approval", value: f.dropOffs.waiting, outcome: "waiting" },
        { key: "rejected", label: "Rejected", value: f.dropOffs.rejected, outcome: "rejected" },
      ]
    : [];
  return (
    <SectionCard
      title="From request to return"
      subtitle={
        f
          ? `${num(f.requested)} requested · ${num(f.approved)} approved · ${num(f.left)} left · ${num(f.returned)} came back`
          : undefined
      }
      loading={query.isPending}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-gate-pass-funnel"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <BarList
          items={steps.filter((s) => s.value > 0).map((s) => ({ key: s.key, label: s.label, value: s.value }))}
          format={(n) => num(n)}
          max={f?.requested || undefined}
          onSelect={(item) => {
            const step = steps.find((s) => s.key === item.key);
            if (step) onDrill({ title: step.label, filter: { outcome: step.outcome } });
          }}
          emptyText="No gate passes in this period."
          testId="md-gate-pass-funnel-bars"
        />
      )}
      {f && f.onDutyTrips > 0 && (
        <p className="md-analytics-note mt-3">
          {num(f.onDutyTrips)} On-Duty {f.onDutyTrips === 1 ? "trip is" : "trips are"} official work and not counted
          here.
        </p>
      )}
    </SectionCard>
  );
}

/** How long people stay out (passes that came back) and how often a gate refused a pass. */
export function DurationsAndScansCard({ query, ask }: { query: UseQueryResult<OutpassResponse>; ask: string }) {
  const data = query.data;
  const d = data?.durations;
  const scans = data?.gateScans;
  return (
    <SectionCard
      title="Time out and gate refusals"
      subtitle={
        d
          ? `Typical pass ${mins(d.medianMinutes)} (average ${mins(d.avgMinutes)}, longest ${mins(d.longestMinutes)})`
          : undefined
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-gate-pass-durations"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-2">
          <div>
            <h4 className="md-analytics-subhead mb-2">How long passes lasted</h4>
            <BarList
              items={(d?.buckets ?? []).map((b) => ({
                key: b.key,
                label: b.label,
                value: b.passes,
                display: `${num(b.passes)} (${pct(b.sharePct, 0)})`,
              }))}
              color={CHART.deep}
              emptyText="No pass came back yet."
              testId="md-gate-pass-duration-bars"
            />
          </div>
          <div>
            <h4 className="md-analytics-subhead mb-2">
              Refused at the gate: {num(scans?.refused ?? 0)} of {num(scans?.attempts ?? 0)} scans
            </h4>
            <BarList
              items={(scans?.byReason ?? []).map((r) => ({ key: r.key, label: r.label, value: r.count }))}
              color={CHART.bad}
              emptyText="No scan was refused."
              testId="md-gate-pass-refusal-bars"
            />
            {(scans?.byGate.length ?? 0) > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-md-ink-soft" data-testid="md-gate-pass-scan-gates">
                {scans?.byGate.map((g) => (
                  <li key={g.gate}>
                    <b className="text-md-ink">{g.gate}</b>: {num(g.exits)} out, {num(g.returns)} back, {num(g.refused)}{" "}
                    refused
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
