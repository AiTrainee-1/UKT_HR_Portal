import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Landmark, Loader2, X } from "lucide-react";
import { inr } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { employeeCount, leftOutByReason } from "./logic";
import { Panel } from "./parts";
import type { BankReview, JobProgress, SkipReport } from "./useSlipJobs";

/** "Generating 40 slips ... 20 of 40" with a bar, or a spinner for a single step (a file being made). */
export function ProgressPanel({ progress }: { progress: JobProgress }) {
  const counted = progress.total > 0;
  const percent = counted ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <Panel tone="indigo" className="bg-indigo-50/95 shadow-sm backdrop-blur" testId="ssc-progress">
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        <Loader2 size={15} className="shrink-0 animate-spin text-indigo-600" />
        <p className="min-w-0 flex-1 text-sm font-semibold text-indigo-950">{progress.title}</p>
        {counted && (
          <span
            className="shrink-0 text-xs font-semibold tabular-nums text-indigo-700"
            data-testid="ssc-progress-count"
          >
            {progress.done} of {progress.total}
          </span>
        )}
      </div>
      {counted && (
        <Progress
          value={percent}
          className="mt-2 h-2 bg-indigo-100"
          aria-label={`${progress.done} of ${progress.total} done`}
        />
      )}
      <p className="mt-1.5 text-[11px] text-indigo-700/80">Keep this page open until it is done.</p>
    </Panel>
  );
}

/** Who a Generate run skipped and why (no salary on the profile ...), and whether it stopped early. */
export function SkippedPanel({ report, onClose }: { report: SkipReport; onClose: () => void }) {
  return (
    <Panel tone="amber" testId="ssc-skipped">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {report.skipped.length > 0 && (
            <p className="text-sm font-semibold text-amber-950">
              {employeeCount(report.skipped.length)} skipped: no slip could be worked out
            </p>
          )}
          {report.failed && (
            <p className="text-sm text-red-800" data-testid="ssc-skipped-failed">
              Stopped early{report.notRun > 0 ? ` (${employeeCount(report.notRun)} not done)` : ""}: {report.failed}
            </p>
          )}
          {report.skipped.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1 text-xs text-amber-950">
              {report.skipped.map((s) => (
                <li key={s.employeeId} className="flex flex-wrap gap-x-2">
                  <span className="font-mono text-amber-800">{s.code}</span>
                  <span className="font-semibold">{s.name}</span>
                  <span className="text-amber-800">— {s.reason}</span>
                </li>
              ))}
            </ul>
          )}
          {report.skipped.length > 0 && (
            <p className="text-[11px] text-amber-800">
              Fix it on the employee&apos;s profile, then generate them again.
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Close the skipped list"
        >
          <X size={14} />
        </Button>
      </div>
    </Panel>
  );
}

/**
 * The bank check, in the page: who is in the bank file and its total, and who is left out and why. Nothing is downloaded
 * until "Download bank file" is pressed.
 */
export function BankReviewPanel({
  review,
  period,
  busy,
  onConfirm,
  onCancel,
}: {
  review: BankReview;
  period: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { check } = review;
  const ref = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  const reasons = leftOutByReason(check);
  const included = check.included.length;
  const listed = showAll ? check.leftOut : check.leftOut.slice(0, 8);

  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div ref={ref}>
      <Panel tone={included > 0 ? "emerald" : "red"} testId="ssc-bank-review">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-xl bg-white/70 p-2 text-emerald-700">
            <Landmark size={16} />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className="text-sm font-bold text-gray-900">Bank file for {period}</p>
              {included > 0 ? (
                <p className="text-sm text-gray-700" data-testid="ssc-bank-included">
                  <CheckCircle2 size={13} className="mr-1 inline text-emerald-600" />
                  {employeeCount(included)} will be paid by bank transfer, total{" "}
                  <span className="font-bold tabular-nums text-gray-900">{inr(check.total, 2)}</span>.
                </p>
              ) : (
                <p className="text-sm font-semibold text-red-800" data-testid="ssc-bank-none">
                  Nobody in this selection can be paid by bank transfer.
                </p>
              )}
            </div>

            {check.leftOut.length > 0 && (
              <div className="space-y-1.5 rounded-xl bg-white/70 p-2.5" data-testid="ssc-bank-left-out">
                <p className="text-xs font-semibold text-gray-800">
                  {employeeCount(check.leftOut.length)} left out:{" "}
                  <span className="font-normal text-gray-600">
                    {reasons.map((r) => `${r.reason} (${r.count})`).join(" · ")}
                  </span>
                </p>
                <ul className="max-h-48 space-y-0.5 overflow-y-auto pr-1 text-xs text-gray-700">
                  {listed.map((row) => (
                    <li key={row.employeeId} className="flex flex-wrap gap-x-2">
                      <span className="font-mono text-gray-500">{row.code}</span>
                      <span className="font-medium">{row.name}</span>
                      <span className="text-gray-500">— {row.reason}</span>
                    </li>
                  ))}
                </ul>
                {check.leftOut.length > listed.length && (
                  <button
                    type="button"
                    className="text-xs font-semibold text-indigo-600 hover:underline"
                    onClick={() => setShowAll(true)}
                  >
                    Show all {check.leftOut.length}
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={busy || included === 0}
                onClick={onConfirm}
                data-testid="ssc-bank-confirm"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Landmark size={14} />}
                Download bank file ({employeeCount(included)})
              </Button>
              <Button size="sm" variant="outline" className="bg-white" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
