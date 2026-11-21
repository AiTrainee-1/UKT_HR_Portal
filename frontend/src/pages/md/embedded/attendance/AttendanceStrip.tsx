import { useBrief, pageQuestion } from "@/components/md/embedded/brief";
import { sortInsights } from "@/components/md/kit/dto";
import { useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { num, pct } from "@/lib/md/format";
import { StripFigure, StripInsights, StripNote, StripShell } from "../shared/InsightStrip";
import { whenParams, thisMonth } from "../shared/filters";
import { PAGE_OF, type AttendanceKind } from "./logic";
import type { InsightsSummary } from "./types";

/** How often the strip's "today" asks again: people keep arriving all morning. */
export const STRIP_REFRESH_MS = 120_000;

/**
 * The strip above the Staff / Production Attendance page: today so far (as HR's six cards count it), this month's
 * attendance and the top exceptions, with Ask AI. It asks for the same month as the Insights tab opens on, so the two
 * share one answer.
 */
export default function AttendanceStrip({ kind }: { kind: AttendanceKind }) {
  const page = PAGE_OF[kind];
  const brief = useBrief(page.id);
  const summary = useMdQuery<InsightsSummary>(
    "attendance/summary",
    { ...whenParams(thisMonth()), type: kind },
    { refetchInterval: STRIP_REFRESH_MS },
  );
  const data = summary.data;
  const live = data?.live;
  const board = live?.board;
  const attendance = data?.metrics.attendancePct?.value;
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);

  if (
    (summary.isError && brief.isError) ||
    (!summary.isLoading && !brief.isLoading && !board && attendance == null && insights.length === 0)
  ) {
    return null;
  }
  return (
    <StripShell
      testId="md-att-strip"
      question={pageQuestion(page.title)}
      loading={summary.isLoading}
      below={<StripInsights items={insights} testId="md-att-strip-insights" />}
    >
      {board && live && live.isWorkingDay && (
        <StripFigure
          testId="md-att-strip-today"
          label="Working today"
          value={`${num(board.present + board.onDuty)} of ${num(live.expected)}`}
        >
          {board.absent > 0 && <StripNote tone="bad">{num(board.absent)} not in yet</StripNote>}
          {board.leaveApplied > 0 && <StripNote tone="watch">{num(board.leaveApplied)} leave waiting</StripNote>}
        </StripFigure>
      )}
      {attendance != null && (
        <StripFigure testId="md-att-strip-month" label="Attendance this month" value={pct(attendance)} />
      )}
    </StripShell>
  );
}
