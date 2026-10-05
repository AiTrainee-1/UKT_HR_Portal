import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { pct } from "@/lib/md/format";
import CardBody from "./CardBody";
import TabStrip from "./TabStrip";
import { ask, attendanceDomain, trendRows, trendTick, type AskContext } from "./logic";
import type { AttendanceTrend } from "./types";

type View = "attendance" | "absence" | "people";

const VIEWS = [
  { value: "attendance", label: "Attendance %" },
  { value: "absence", label: "Absent and late %" },
  { value: "people", label: "People" },
];

const PEOPLE_SERIES: TrendSeries[] = [
  { key: "present", label: "Present", kind: "bar", stackId: "people", color: CHART.good },
  { key: "absent", label: "Absent", kind: "bar", stackId: "people", color: CHART.bad },
  { key: "leave", label: "On leave", kind: "bar", stackId: "people", color: CHART.leave },
];

/** Attendance, absence and lateness over the period: a point per working day (per week for a long period). */
export default function TrendCard({
  query,
  context,
  className,
}: {
  query: UseQueryResult<AttendanceTrend>;
  context: AskContext;
  className?: string;
}) {
  const [view, setView] = useState<View>("attendance");
  const data = query.data;
  const rows = useMemo(() => trendRows(data?.points ?? []), [data]);
  const domain = useMemo(() => attendanceDomain(data?.points ?? []), [data]);
  const average = data?.average?.attendancePct;

  return (
    <SectionCard
      testId="md-attendance-trend"
      className={className}
      title="Trend"
      subtitle={
        data
          ? data.granularity === "week"
            ? "One point per week, Monday to Sunday"
            : "One point per working day"
          : undefined
      }
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={
        view === "attendance"
          ? ["attendance-pct", "coverage"]
          : view === "absence"
            ? ["absenteeism-pct", "late-pct"]
            : undefined
      }
      actions={<AskAiButton question={ask.trend(context)} />}
    >
      <TabStrip items={VIEWS} value={view} onChange={(v) => setView(v as View)} />
      <CardBody query={query}>
        {(d) =>
          d.points.length === 0 ? (
            <EmptyBlock title="Nothing to chart yet" testId="md-attendance-trend-empty">
              No working day in this period has an attendance record. Records are created when HR opens Attendance or
              runs payroll.
            </EmptyBlock>
          ) : (
            <TrendChart
              data={rows}
              xKey="date"
              xFormat={trendTick(d.granularity)}
              height={260}
              series={
                view === "attendance"
                  ? [{ key: "attendancePct", label: "Attendance %", kind: "area", color: CHART.brand }]
                  : view === "absence"
                    ? [
                        { key: "absentPct", label: "Absent %", kind: "line", color: CHART.bad },
                        { key: "latePct", label: "Late %", kind: "line", color: CHART.warn },
                      ]
                    : PEOPLE_SERIES
              }
              yFormat={view === "people" ? (v) => String(v) : (v) => `${v}%`}
              yDomain={view === "attendance" ? domain : view === "absence" ? [0, "auto"] : undefined}
              references={
                view === "attendance" && average != null
                  ? [{ y: average, label: `Average ${pct(average)}`, color: CHART.slate }]
                  : undefined
              }
            />
          )
        }
      </CardBody>
    </SectionCard>
  );
}
