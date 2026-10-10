import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import Heatmap from "@/components/md/kit/Heatmap";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, num } from "@/lib/md/format";
import { calendarMatrix, gapText } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { RlGaps } from "./types";

/** The gap calendar: one cell per day, darker where more absences have no Informed / Not informed call, a dot where there
 *  was nothing to follow up, and the days nobody made the call named underneath. */
export default function GapsCard({ query, ask }: { query: UseQueryResult<RlGaps>; ask: string }) {
  const gaps = query.data;
  const matrix = gaps ? calendarMatrix(gaps.days) : null;
  const peak = matrix ? Math.max(1, ...matrix.values.flat().map((v) => v ?? 0)) : 1;
  return (
    <SectionCard
      title="Days nobody made the call"
      subtitle="Each cell is a day: the number of absences nobody has marked Informed or Not informed (a dot: no absences)"
      loading={query.isPending}
      provenance={gaps?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-reportlog-gaps"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : gaps && gaps.daysWithAbsences > 0 && matrix ? (
        <>
          <Heatmap
            rows={matrix.rows}
            cols={matrix.cols}
            values={matrix.values}
            domain={[0, peak]}
            rowHeaderWidth={110}
            testId="md-reportlog-gaps-grid"
          />
          <p className="mt-3 text-xs text-[#006496]/70" data-testid="md-reportlog-gaps-text">
            {gapText(gaps)}
          </p>
          {gaps.gapDays.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="md-reportlog-gap-days">
              {gaps.gapDays.slice(-12).map((d) => (
                <li
                  key={d.date}
                  className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-900"
                  data-testid={`md-reportlog-gap-${d.date}`}
                >
                  {d.weekday} {dayLong(d.date)}: {num(d.absences)} absences, none marked
                </li>
              ))}
            </ul>
          )}
          {gaps.truncated && (
            <p className="mt-1 text-[11px] text-[#006496]/55">Showing the latest days of the period only.</p>
          )}
        </>
      ) : gaps ? (
        <EmptyBlock title="No absences to follow up" testId="md-reportlog-gaps-empty">
          No day in this period had an absence on a scheduled day for this selection, so there is nothing for the Daily
          Report to mark.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
