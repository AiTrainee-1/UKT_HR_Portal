// The three charts under "Trends". Each reads its own section of GET /api/md/dashboard/trends, so a chart whose page
// could not be read shows its own error with a Retry while the other two stay on screen.

import { Activity, ArrowLeftRight, IndianRupee } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { dayShort, inrCompact, num, pct } from "@/lib/md/format";
import {
  attendanceDomain,
  attendanceRows,
  movementRows,
  movementSummary,
  payrollRows,
  tickLabel,
  tickMonth,
} from "./logic";
import { Chip, trendError } from "./parts";
import { isSectionError, type DashboardTrends } from "./types";

type TrendsQuery = UseQueryResult<DashboardTrends>;

/** Attendance over the last 30 days: the share of scheduled people in, day by day, against its own average. */
export function AttendanceTrendCard({ query }: { query: TrendsQuery }) {
  const section = query.data?.attendance;
  const trend = section && !isSectionError(section) ? section : undefined;
  const rows = trend ? attendanceRows(trend) : [];
  const average = trend?.average;
  return (
    <SectionCard
      title="Attendance, last 30 days"
      subtitle="Share of scheduled people who were in (complete days)"
      provenance={trend?.provenance}
      loading={query.isPending}
      actions={
        <AskAiButton question="Is attendance improving or slipping over the last 30 days, and when did it dip?" />
      }
      className="md-dashboard-card min-w-0"
      testId="md-dashboard-trend-attendance"
    >
      {trendError(query, section) ??
        (rows.length === 0 ? (
          <EmptyBlock icon={Activity} title="No attendance to chart yet">
            {trend?.notes[0] ?? "The chart appears once HR's attendance records exist for some days in this period."}
          </EmptyBlock>
        ) : (
          <div className="space-y-2">
            <TrendChart
              data={rows}
              xKey="date"
              xFormat={dayShort}
              yFormat={(v) => `${v}%`}
              yDomain={attendanceDomain(rows)}
              legend={false}
              height={210}
              series={[{ key: "attendance", label: "Attendance", kind: "area", color: CHART.brand }]}
              references={
                average?.attendancePct != null
                  ? [{ y: average.attendancePct, label: `Average ${pct(average.attendancePct)}`, color: CHART.gold }]
                  : undefined
              }
            />
            <div className="flex flex-wrap gap-2" data-testid="md-dashboard-trend-attendance-chips">
              <Chip className="md-chip-sand">Average {pct(average?.attendancePct)}</Chip>
              <Chip>Absent {pct(average?.absentPct)}</Chip>
              <Chip>Late {pct(average?.latePct)}</Chip>
            </div>
            {trend?.notes[0] && <p className="text-[11px] leading-snug text-md-ink-soft">{trend.notes[0]}</p>}
          </div>
        ))}
    </SectionCard>
  );
}

/** Payroll for twelve months: gross pay as bars (lighter where the month is provisional) and people paid as a line. */
export function PayrollTrendCard({ query }: { query: TrendsQuery }) {
  const section = query.data?.payroll;
  const trend = section && !isSectionError(section) ? section : undefined;
  const rows = trend?.hasData ? payrollRows(trend) : [];
  const latest = trend?.months.filter((m) => m.hasData && m.grossPay != null).at(-1);
  return (
    <SectionCard
      title="Payroll, last 12 months"
      subtitle="Gross pay (bars) and people paid (line)"
      provenance={trend?.provenance}
      loading={query.isPending}
      actions={<AskAiButton question="How has payroll cost moved over the last 12 months, and is overtime rising?" />}
      className="md-dashboard-card min-w-0"
      testId="md-dashboard-trend-payroll"
    >
      {trendError(query, section) ??
        (rows.length === 0 ? (
          <EmptyBlock icon={IndianRupee} title="No payroll to chart yet">
            The chart appears once HR has generated payroll for at least one month.
          </EmptyBlock>
        ) : (
          <div className="space-y-2">
            <TrendChart
              data={rows}
              xKey="month"
              xFormat={tickMonth}
              yFormat={inrCompact}
              rightFormat={num}
              height={210}
              series={[
                { key: "gross", label: "Gross pay", kind: "bar", color: CHART.brand, stackId: "gross" },
                {
                  key: "grossProvisional",
                  label: "Gross pay (provisional)",
                  kind: "bar",
                  color: CHART.light,
                  stackId: "gross",
                },
                { key: "headcount", label: "People paid", kind: "line", color: CHART.deep, rightAxis: true },
              ]}
            />
            <div className="flex flex-wrap gap-2" data-testid="md-dashboard-trend-payroll-chips">
              {latest && (
                <Chip className="md-chip-wine">
                  {latest.label}: {inrCompact(latest.grossPay)}
                </Chip>
              )}
              {trend?.average != null && <Chip>Average month {inrCompact(trend.average)}</Chip>}
            </div>
            {rows.some((r) => r.grossProvisional != null) && (
              <p className="text-[11px] leading-snug text-md-ink-soft">
                Lighter bars are months still running, or with slips made before month end: they understate pay.
              </p>
            )}
          </div>
        ))}
    </SectionCard>
  );
}

/** Joiners against leavers for twelve months: is the workforce growing or shrinking? */
export function MovementTrendCard({ query }: { query: TrendsQuery }) {
  const section = query.data?.movement;
  const trend = section && !isSectionError(section) ? section : undefined;
  const rows = trend ? movementRows(trend) : [];
  const anyMovement = !!trend && trend.points.some((p) => p.joiners > 0 || p.leavers > 0);
  return (
    <SectionCard
      title="Joiners and leavers, last 12 months"
      subtitle="People who joined and people who left, month by month"
      provenance={trend?.provenance}
      loading={query.isPending}
      actions={<AskAiButton question="Are we gaining or losing people, and which months were the worst for leavers?" />}
      className="md-dashboard-card min-w-0"
      testId="md-dashboard-trend-movement"
    >
      {trendError(query, section) ??
        (!trend || !anyMovement ? (
          <EmptyBlock icon={ArrowLeftRight} title="No joiners or leavers yet">
            Nobody joined or left in the last 12 months, or their dates are not recorded.
          </EmptyBlock>
        ) : (
          <div className="space-y-2">
            <TrendChart
              data={rows}
              xKey="label"
              xFormat={tickLabel}
              yFormat={(v) => num(v)}
              height={210}
              series={[
                { key: "joiners", label: "Joiners", kind: "bar", color: CHART.good },
                { key: "leavers", label: "Leavers", kind: "bar", color: CHART.bad },
              ]}
            />
            <div className="flex flex-wrap gap-2" data-testid="md-dashboard-trend-movement-chips">
              <Chip>{movementSummary(trend.totals)}</Chip>
              {trend.totals.closing != null && (
                <Chip className="md-chip-ink">Headcount now {num(trend.totals.closing)}</Chip>
              )}
            </div>
            <p className="text-[11px] leading-snug text-md-ink-soft">
              Past headcount is rebuilt from join and exit dates: the system keeps no headcount history.
            </p>
          </div>
        ))}
    </SectionCard>
  );
}
