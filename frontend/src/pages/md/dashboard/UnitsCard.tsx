import { CalendarOff } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { clockText, num, pct } from "@/lib/md/format";
import { unitCaption, unitSegments, type SegmentKey } from "./logic";
import { Unavailable } from "./parts";
import { isSectionError, type DashboardOverview, type UnitsToday } from "./types";

const SEGMENT_COLOR: Record<SegmentKey, string> = {
  in: CHART.good,
  late: CHART.warn,
  leave: CHART.leave,
  notIn: "#fca5a5",
};

const SEGMENT_LABEL: Record<SegmentKey, string> = { in: "In", late: "Late", leave: "On leave", notIn: "Not in yet" };

function Legend({ keys }: { keys: SegmentKey[] }) {
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#006496]/70"
      data-testid="md-dashboard-units-legend"
    >
      {keys.map((key) => (
        <li key={key} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: SEGMENT_COLOR[key] }} />
          {SEGMENT_LABEL[key]}
        </li>
      ))}
    </ul>
  );
}

function Body({ units, settled }: { units: UnitsToday; settled: boolean }) {
  if (!units.isWorkingDay) {
    return (
      <EmptyBlock icon={CalendarOff} title="Nobody is scheduled today" testId="md-dashboard-units-off">
        Today is a weekly off or a holiday, so there is no one to count.
      </EmptyBlock>
    );
  }
  const seen = new Set<SegmentKey>();
  for (const row of units.rows) for (const s of unitSegments(row)) seen.add(s.key);
  const order: SegmentKey[] = ["in", "late", "leave", "notIn"];
  // before the morning rush is over, "weakest" only means "arrived last": the server says when it is settled
  const weak = settled ? units.weakestDepartment : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-3">
        <p className="text-3xl font-black leading-none text-[#1a3a4a]" data-testid="md-dashboard-units-total">
          {pct(units.total.attendancePct)}
        </p>
        <p className="text-xs text-[#006496]/65">
          {num(units.total.present)} of {num(units.total.expected)} scheduled people in so far
        </p>
      </div>
      <ul className="space-y-4">
        {units.rows.map((row) => {
          const segments = unitSegments(row);
          return (
            <li key={row.id ?? row.name} data-testid={`md-dashboard-unit-${row.id ?? "none"}`}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[13px] font-semibold text-[#1a3a4a]">{row.name}</span>
                <span className="shrink-0 text-[13px] font-bold tabular-nums text-[#1a3a4a]">
                  {pct(row.attendancePct)}
                </span>
              </div>
              <div
                className="flex h-2.5 w-full overflow-hidden rounded-full bg-[#006496]/[0.07]"
                role="img"
                aria-label={unitCaption(row)}
              >
                {segments.map((s) => (
                  <div
                    key={s.key}
                    title={`${s.label}: ${num(s.value)}`}
                    style={{ width: `${s.widthPct}%`, background: SEGMENT_COLOR[s.key] }}
                  />
                ))}
              </div>
              <p className="mt-1 text-[11px] text-[#006496]/60">{unitCaption(row)}</p>
            </li>
          );
        })}
      </ul>
      <Legend keys={order.filter((k) => seen.has(k))} />
      {weak && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="md-dashboard-units-weakest">
          Weakest department so far: <b>{weak.name}</b>, {pct(weak.attendancePct)} ({num(weak.present)} of{" "}
          {num(weak.expected)} in).
        </p>
      )}
      {!units.lateKnown && (
        <p className="text-[11px] text-[#006496]/55">
          Late arrivals are shown once HR's attendance records for today are ready.
        </p>
      )}
    </div>
  );
}

/** Today by unit: who has punched in so far, stacked per unit. Provisional all day: "not in yet" is not "absent". */
export default function UnitsCard({
  overview,
  failed,
  onRetry,
}: {
  overview: DashboardOverview | undefined;
  failed?: boolean;
  onRetry: () => void;
}) {
  const units = overview?.units;
  return (
    <SectionCard
      title="Today by unit"
      subtitle={
        units && !isSectionError(units)
          ? `Provisional${units.asOf ? ` · as of ${clockText(units.asOf)}` : ""} · ${
              overview?.settled === false ? "people are still arriving" : "the day is still running"
            }`
          : "People in so far, by unit"
      }
      provenance={overview?.provenance}
      provenanceIds={["dashboard-units"]}
      loading={!overview && !failed}
      actions={<AskAiButton question="Which units and departments are short of people today, and who is not in yet?" />}
      testId="md-dashboard-units"
    >
      {!units ? (
        <Unavailable />
      ) : isSectionError(units) ? (
        <ErrorBanner message={units.error} onRetry={onRetry} />
      ) : (
        <Body units={units} settled={overview?.settled !== false} />
      )}
    </SectionCard>
  );
}
