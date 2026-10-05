import { CheckCircle2 } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { NoteBanner } from "@/components/md/kit/states";
import { ask, coverageText, worstDaysText, type AskContext } from "./logic";
import type { Coverage } from "./types";

/**
 * How much of the period the figures stand on. Day records are created when HR opens Attendance or runs payroll, so a day
 * nobody opened has no record: the page says so instead of guessing, and names the dates to open first.
 */
export default function CoverageNote({
  coverage,
  context,
}: {
  coverage: Coverage | null | undefined;
  context: AskContext;
}) {
  if (!coverage || coverage.expectedDays === 0) return null;
  if (!coverage.partial) {
    return (
      <p
        className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-xs text-green-900"
        data-testid="md-attendance-coverage"
      >
        <CheckCircle2 size={14} className="shrink-0" /> {coverageText(coverage)} Every figure on this page covers the
        whole period.
      </p>
    );
  }
  const worst = worstDaysText(coverage);
  return (
    <NoteBanner>
      <div className="flex flex-wrap items-center justify-between gap-2" data-testid="md-attendance-coverage">
        <p>
          <b>Data coverage.</b> {coverageText(coverage)} The figures cover the days HR has processed and nothing is
          estimated.
          {worst && <> Open these dates in Attendance to complete them: {worst}.</>}
        </p>
        <AskAiButton question={ask.coverage(context)} />
      </div>
    </NoteBanner>
  );
}
