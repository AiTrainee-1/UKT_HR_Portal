import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { QueryError, refreshingClass } from "./cards";
import { daysText } from "./logic";
import type { Drill, LvBalances } from "./types";

/** Casual Leave's own year: 12 days each from the cut-over (a half day 0.5), used / waiting / left, who has used it up or is
 *  close, and the days HR turned into Casual Leave on the Carry Forward tab. Each figure opens the people behind it. */
export default function CasualCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<LvBalances>;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  const c = data?.casual;
  const year = data?.year;
  const tiles = c
    ? [
        { id: "used", label: "Used", value: daysText(c.used), tone: "md-analytics-tone-info", filter: "used" },
        {
          id: "exhausted",
          label: "Used it all",
          value: num(c.exhausted),
          tone: "md-analytics-tone-bad",
          filter: "exhausted",
        },
        {
          id: "low",
          label: `${num(c.lowDays)} days or less left`,
          value: num(c.low),
          tone: "md-analytics-tone-watch",
          filter: "low",
        },
        {
          id: "carry",
          label: "Carry forward",
          value: daysText(c.carryForward.days),
          tone: "md-analytics-tone-good",
          filter: "carry_forward",
        },
      ]
    : [];
  return (
    <SectionCard
      title={`Casual Leave ${year ?? ""}`.trim()}
      subtitle={
        c
          ? `${c.allocationText ?? `${num(c.entitlement)} days a year`} for each of ${num(c.employees)} staff, from ${dayLong(c.since ?? c.cutOver)}; waiting requests hold days too`
          : undefined
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-casual"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : c && c.employees > 0 ? (
        <div className="space-y-4">
          <p className="text-[13px] text-md-ink" data-testid="md-leave-casual-line">
            <b>{daysText(c.used)}</b> used ({pct(c.usedPct)} of the year's days), {daysText(c.pending)} waiting,{" "}
            {num(c.halfDays)} half {c.halfDays === 1 ? "day" : "days"}; {num(c.carryForward.employees)}{" "}
            {c.carryForward.employees === 1 ? "person" : "people"} given Casual Leave by HR for absent days.
          </p>
          <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
            {tiles.map((t) => (
              <button
                key={t.id}
                type="button"
                className={cn("md-analytics-stat text-left", t.tone)}
                onClick={() =>
                  onDrill({
                    title: `Casual Leave: ${t.label.toLowerCase()}`,
                    subtitle: "Used, waiting and left this year",
                    params: { what: "cl", filter: t.filter },
                  })
                }
                data-testid={`md-leave-casual-${t.id}`}
              >
                <p className="md-analytics-stat-value">{t.value}</p>
                <p className="md-analytics-stat-label">{t.label}</p>
              </button>
            ))}
          </div>
          {c.byDepartment.some((d) => d.used > 0) && (
            <div>
              <h4 className="md-analytics-subhead">Used per head, by department</h4>
              <BarList
                testId="md-leave-casual-departments"
                items={c.byDepartment
                  .filter((d) => d.used > 0)
                  .slice(0, 6)
                  .map((d) => ({
                    key: d.label,
                    label: d.label,
                    value: d.usedPerEmployee ?? 0,
                    display: num(d.usedPerEmployee, 2),
                    color: CHART.leave,
                    sub: `${daysText(d.used)} by ${num(d.employees)} staff · ${pct(d.usedPct)} of their days`,
                  }))}
                onSelect={(item) =>
                  onDrill({
                    title: `Casual Leave: ${item.key}`,
                    params: { what: "cl", filter: "used", dept: item.key },
                  })
                }
              />
            </div>
          )}
        </div>
      ) : data ? (
        <EmptyBlock title="No staff in this selection" testId="md-leave-casual-empty">
          Casual Leave is for staff; this selection has none.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
