import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { inr, plural } from "@/components/payroll/kit/format";
import { SEVERITY_META } from "@/components/payroll/kit/issue-meta";
import { BusyIcon, Chip, PayStatusChip } from "@/components/payroll/kit/parts";
import { anyTds, hasTds, percentText, sumTds, tdsAmount, tdsRate } from "@/components/payroll/kit/statutory";
import { cn } from "@/lib/utils";
import { summarizeRuns } from "../dashboard/dashboard-logic";
import type { PayrollIssueSummary } from "../filters/filter-logic";
import {
  cycleLabelOf,
  displayName,
  isProductionRun,
  issueBadges,
  issuesOf,
  markPaidTitle,
  metricText,
  periodText,
} from "./records-logic";

type TableProps = {
  /** The rows of the page shown. */
  rows: PayrollRunItem[];
  /** Every row of the list: the footer adds these up, not only the page. */
  allRows: PayrollRunItem[];
  accent: "indigo" | "amber";
  issuesByPayroll?: ReadonlyMap<number, PayrollIssueSummary>;
  issuesLoading?: boolean;
  onOpenDetails: (run: PayrollRunItem) => void;
  onOpenIssues?: (run: PayrollRunItem) => void;
  onMarkPaid: (run: PayrollRunItem) => void;
  markingId?: number | null;
};

const ACCENT_LINK = { indigo: "text-indigo-700", amber: "text-amber-700" } as const;

/** The issues of one row in a few characters: a dot and a count per severity, in words for assistive technology. */
function IssuesCell({
  run,
  summary,
  loading,
  onOpenIssues,
}: {
  run: PayrollRunItem;
  summary: PayrollIssueSummary | undefined;
  loading: boolean;
  onOpenIssues?: (run: PayrollRunItem) => void;
}) {
  if (!summary)
    return loading ? <Skeleton className="h-5 w-16 rounded-full" /> : <span className="text-gray-400">—</span>;
  if (summary.total === 0) return <span className="text-xs text-gray-400">None</span>;
  const { severities } = issueBadges(summary);
  const words = severities.map((s) => `${s.count} ${SEVERITY_META[s.severity].label.toLowerCase()}`).join(", ");
  const body = severities.map(({ severity, count }) => (
    <Chip key={severity} tone={SEVERITY_META[severity].tone}>
      <span className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_META[severity].dot)} aria-hidden="true" />
      {count}
    </Chip>
  ));
  return onOpenIssues ? (
    <button
      type="button"
      onClick={() => onOpenIssues(run)}
      aria-label={`Open the issues of ${displayName(run)}: ${words}`}
      title={words}
      className="inline-flex items-center gap-1 rounded-lg px-1 py-0.5 hover:bg-slate-50"
      data-testid={`payroll-record-issues-${run.id}`}
    >
      {body}
    </button>
  ) : (
    <span className="inline-flex items-center gap-1" title={words}>
      {body}
    </span>
  );
}

/** The payroll rows as a compact register: one line per row, the same figures as the cards, a Details link and a footer of totals. */
export function PayrollRecordTable({
  rows,
  allRows,
  accent,
  issuesByPayroll,
  issuesLoading = false,
  onOpenDetails,
  onOpenIssues,
  onMarkPaid,
  markingId,
}: TableProps) {
  const totals = summarizeRuns(allRows);
  const production = rows.some(isProductionRun);
  // The TDS column exists only while some row of the list has TDS (PF and ESI sit inside Deductions as they always did).
  const showTds = anyTds(allRows);
  return (
    <div className="overflow-x-auto rounded-2xl border bg-white" data-testid="payroll-record-table">
      <table className={cn("w-full min-w-[900px] text-sm", showTds && "min-w-[980px]")} aria-label="Payroll register">
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2.5">Employee</th>
            <th className="px-3 py-2.5">Department</th>
            <th className="px-3 py-2.5">{production ? "Cycle / period" : "Period"}</th>
            <th className="px-3 py-2.5">Attendance</th>
            <th className="px-3 py-2.5 text-right">Gross</th>
            {showTds && (
              <th className="px-3 py-2.5 text-right" title="Tax deducted at source (already part of Deductions)">
                TDS
              </th>
            )}
            <th className="px-3 py-2.5 text-right">Deductions</th>
            <th className="px-3 py-2.5 text-right">Net</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Issues</th>
            <th className="px-3 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((run) => {
            const cycle = cycleLabelOf(run);
            const pending = run.status !== "paid";
            return (
              <tr
                key={run.id}
                className="hover:bg-gray-50/60"
                data-testid={`payroll-record-row-${run.id}`}
                data-status={run.status}
              >
                <td className="px-3 py-2.5 align-middle">
                  <p className="font-semibold text-gray-900">{displayName(run)}</p>
                  <p className="font-mono text-xs text-muted-foreground">{run.employeeCode ?? `#${run.employeeId}`}</p>
                </td>
                <td className="px-3 py-2.5 align-middle text-gray-700">
                  {run.departmentName ?? <span className="text-gray-400">—</span>}
                </td>
                <td className="px-3 py-2.5 align-middle text-xs text-gray-700">
                  {cycle && <span className="mr-1.5 font-semibold text-orange-700">{cycle}</span>}
                  {periodText(run)}
                </td>
                <td className="px-3 py-2.5 align-middle text-gray-700">{metricText(run)}</td>
                <td className="px-3 py-2.5 text-right align-middle tabular-nums">{inr(run.grossSalary)}</td>
                {showTds && (
                  <td
                    className={cn(
                      "px-3 py-2.5 text-right align-middle tabular-nums",
                      hasTds(run) ? "text-red-600" : "text-gray-400",
                    )}
                    data-testid={`payroll-record-tds-${run.id}`}
                  >
                    {hasTds(run) ? (
                      <>
                        {inr(tdsAmount(run))}
                        {tdsRate(run) !== null && (
                          <span className="block text-[11px] font-normal text-muted-foreground">
                            {percentText(tdsRate(run))}
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                <td
                  className={cn(
                    "px-3 py-2.5 text-right align-middle tabular-nums",
                    run.deductions > 0 ? "text-red-600" : "text-gray-500",
                  )}
                >
                  {inr(run.deductions)}
                </td>
                <td className="px-3 py-2.5 text-right align-middle font-bold tabular-nums text-green-700">
                  {inr(run.finalSalary)}
                </td>
                <td className="px-3 py-2.5 align-middle">
                  <PayStatusChip status={run.status} />
                </td>
                <td className="px-3 py-2.5 align-middle">
                  <IssuesCell
                    run={run}
                    summary={issuesOf(issuesByPayroll, run.id, issuesLoading)}
                    loading={issuesLoading}
                    onOpenIssues={onOpenIssues}
                  />
                </td>
                <td className="px-3 py-2.5 text-right align-middle">
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenDetails(run)}
                      className={cn(
                        "inline-flex items-center gap-1 text-xs font-semibold hover:underline",
                        ACCENT_LINK[accent],
                      )}
                      title="Open the full details of this payroll"
                      data-testid={`payroll-record-details-${run.id}`}
                    >
                      Details <ArrowRight size={12} />
                    </button>
                    {pending && (
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 gap-1 border-0 bg-none bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700"
                        disabled={markingId === run.id}
                        onClick={() => onMarkPaid(run)}
                        title={markPaidTitle(run)}
                        data-testid={`payroll-record-markpaid-${run.id}`}
                      >
                        <BusyIcon busy={markingId === run.id} icon={CheckCircle2} size={12} /> Mark as Cleared
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t-2 bg-gray-50 text-sm font-bold">
          <tr data-testid="payroll-record-totals">
            <td className="px-3 py-2.5" colSpan={4}>
              Total of all {plural(totals.records, "record")}
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums">{inr(totals.gross)}</td>
            {showTds && (
              <td className="px-3 py-2.5 text-right tabular-nums text-red-600" data-testid="payroll-record-totals-tds">
                {inr(sumTds(allRows))}
              </td>
            )}
            <td className="px-3 py-2.5 text-right tabular-nums text-red-600">{inr(totals.deductions)}</td>
            <td className="px-3 py-2.5 text-right tabular-nums text-green-700">{inr(totals.net)}</td>
            <td className="px-3 py-2.5" colSpan={3} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
