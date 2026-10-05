import type { UseQueryResult } from "@tanstack/react-query";
import { Timer } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { changeTone, num, pct, signed } from "@/lib/md/format";
import CardBody from "./CardBody";
import { ask, trendTick, type AskContext } from "./logic";
import type { AttendanceOvertime } from "./types";

const DECISIONS: { key: keyof NonNullable<AttendanceOvertime["decisions"]>; label: string; tone: string }[] = [
  { key: "announcedPay", label: "Pay", tone: "bg-green-50 text-green-800" },
  { key: "announcedRelaxation", label: "Day off", tone: "bg-blue-50 text-blue-800" },
  { key: "detected", label: "Not decided", tone: "bg-amber-50 text-amber-800" },
  { key: "rejected", label: "Rejected", tone: "bg-slate-100 text-slate-600" },
];

function notTrackedText(d: AttendanceOvertime): string {
  if (!d.tracking.featureEnabled)
    return "The Compensation feature is switched off in Settings, so overtime is not detected or paid.";
  if (!d.tracking.detectionEnabled)
    return "Overtime detection is switched off in Settings, and nothing is on record for this period.";
  return "No overtime is on record for this period.";
}

/** Overtime hours (informational: payroll pays one day's pay per announced Pay day), where it comes from, and who. */
export default function OvertimeCard({
  query,
  context,
  className,
}: {
  query: UseQueryResult<AttendanceOvertime>;
  context: AskContext;
  className?: string;
}) {
  return (
    <SectionCard
      testId="md-attendance-overtime"
      className={className}
      title="Overtime"
      subtitle="Staff, on days HR detected or announced it: hours, not rupees (see Payroll Analysis for cost)"
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={ask.overtimeByDepartment(context)} />}
    >
      <CardBody query={query}>
        {(d) => {
          if (d.totalHours == null || (d.totalHours === 0 && d.byDepartment.length === 0)) {
            return (
              <EmptyBlock
                icon={Timer}
                title={d.totalHours == null ? "Overtime is not tracked" : "No overtime"}
                testId="md-attendance-overtime-empty"
              >
                {notTrackedText(d)}
              </EmptyBlock>
            );
          }
          const change = d.delta?.abs;
          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
                <p className="text-3xl font-black text-[#1a3a4a]" data-testid="md-attendance-overtime-total">
                  {num(d.totalHours, 1)} h
                </p>
                {change != null && (
                  <DeltaChip
                    text={`${signed(change, 1)} h`}
                    tone={changeTone(change, false)}
                    direction={change > 0 ? "up" : change < 0 ? "down" : "flat"}
                  />
                )}
                <p className="text-xs text-[#006496]/65">
                  {d.pctOfScheduledHours != null ? `${pct(d.pctOfScheduledHours)} of scheduled hours · ` : ""}
                  {num(d.days ?? 0)} staff days · {num(d.employees ?? 0)} people
                </p>
              </div>
              {d.decisions && (
                <div className="flex flex-wrap gap-1.5" data-testid="md-attendance-overtime-decisions">
                  {DECISIONS.map(({ key, label, tone }) => (
                    <span key={key} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
                      {label}: {num(d.decisions![key].days)} {d.decisions![key].days === 1 ? "day" : "days"} ·{" "}
                      {num(d.decisions![key].hours, 1)} h
                    </span>
                  ))}
                </div>
              )}
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">By department</p>
                <BarList
                  items={d.byDepartment.slice(0, 6).map((r) => ({
                    key: r.name,
                    label: r.name,
                    value: r.hours,
                    display: `${num(r.hours, 1)} h`,
                    sub: `${num(r.employees)} ${r.employees === 1 ? "person" : "people"} · ${num(r.days)} days`,
                  }))}
                  color={CHART.series[4]}
                />
              </div>
              {d.topEarners.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                    Most overtime
                  </p>
                  <ul className="divide-y text-sm" data-testid="md-attendance-overtime-people">
                    {d.topEarners.slice(0, 5).map((p) => (
                      <li key={p.employeeId} className="flex items-baseline justify-between gap-2 py-1.5">
                        <span className="min-w-0 truncate">
                          <b className="font-semibold text-[#1a3a4a]">{p.name}</b>{" "}
                          <span className="text-[11px] text-[#006496]/55">{p.department}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-[#1a3a4a]">
                          {num(p.hours, 1)} h{" "}
                          <span className="text-[11px] text-[#006496]/55">
                            · {p.days} {p.days === 1 ? "day" : "days"}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {d.trend.points.length > 1 && (
                <TrendChart
                  data={d.trend.points.map((p) => ({ date: p.date, hours: p.hours }))}
                  xKey="date"
                  xFormat={trendTick(d.trend.granularity)}
                  height={120}
                  legend={false}
                  series={[{ key: "hours", label: "Overtime hours", kind: "bar", color: CHART.series[4] }]}
                  yFormat={(v) => `${v} h`}
                />
              )}
            </div>
          );
        }}
      </CardBody>
    </SectionCard>
  );
}
