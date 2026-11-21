import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { dayLong, dayShort, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { QueryError, refreshingClass } from "./cards";
import type { Drill, LvToday } from "./types";

/** Who is out today and on each day of this week (a snapshot, whatever the period). A day opens who is out on it. */
export default function OutCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<LvToday>;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  const top = Math.max(1, ...(data?.week ?? []).map((d) => d.out));
  return (
    <SectionCard
      title="Who is out"
      subtitle="Approved leave today and on each day of this week: click a day to see who"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-out"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <div className="space-y-4">
          <p className="text-[13px] text-md-ink" data-testid="md-leave-out-today">
            <b className="text-base">{num(data.outToday.people)}</b>{" "}
            {data.outToday.people === 1 ? "person is" : "people are"} on leave{" "}
            {data.isToday ? "today" : dayLong(data.date)}
            {data.outToday.halfDay ? ` (${num(data.outToday.halfDay)} on a half day)` : ""}
            {data.outToday.pct != null && data.outToday.people ? `, ${pct(data.outToday.pct, 0)} of staff` : ""}.{" "}
            {num(data.weekPeople)} out at some point this week · {num(data.startingSoon)} start leave in the next 7
            days.
            {data.holiday ? ` ${dayLong(data.date)} is a holiday (${data.holiday}).` : ""}
          </p>
          <div className="grid grid-cols-7 items-end gap-1.5" data-testid="md-leave-week">
            {data.week.map((d) => (
              <button
                key={d.date}
                type="button"
                onClick={() =>
                  onDrill({
                    title: `On leave on ${dayLong(d.date)}`,
                    subtitle: d.holiday ? `A holiday: ${d.holiday}` : undefined,
                    params: { what: "out", day: d.date },
                  })
                }
                className={cn(
                  "flex min-w-0 flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 text-[11px] font-semibold text-md-ink-soft transition-colors hover:bg-md-wine/5",
                  d.isTarget && "bg-md-wine/[0.06] text-md-ink",
                )}
                aria-label={`${d.weekday} ${dayShort(d.date)}: ${d.out} on leave`}
                data-testid={`md-leave-day-${d.date}`}
              >
                <span className="tabular-nums text-md-ink">{num(d.out)}</span>
                <span className="flex h-16 w-full items-end justify-center">
                  <span
                    className={cn("w-3/5 rounded-t-md", d.holiday || d.isSunday ? "bg-md-ink-400/30" : "bg-md-wine/70")}
                    style={{ height: `${Math.max(6, (d.out / top) * 100)}%` }}
                  />
                </span>
                <span>{d.weekday}</span>
                <span className="font-medium">{dayShort(d.date).slice(0, 2)}</span>
              </button>
            ))}
          </div>
          {data.byDepartment.length > 0 && (
            <ul className="space-y-1 text-xs text-md-ink-soft" data-testid="md-leave-out-departments">
              {data.byDepartment.slice(0, 4).map((d) => (
                <li key={d.label} className="flex justify-between gap-2">
                  <span className="truncate">{d.label}</span>
                  <span className="shrink-0 tabular-nums text-md-ink">
                    {num(d.out)}
                    {d.outPct != null ? ` (${pct(d.outPct, 0)})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </SectionCard>
  );
}
