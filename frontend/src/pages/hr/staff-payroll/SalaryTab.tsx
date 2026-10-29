import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Pencil, Users } from "lucide-react";
import { useLocation } from "wouter";
import { AdjustPayrollDialog, type AdjustTarget } from "@/components/payroll/AdjustPayrollDialog";
import { adjustTargetFromRun } from "@/components/payroll/adjust-target";
import { BranchFilter, branchIdOf } from "@/components/payroll/kit/BranchFilter";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { statementUiFromUrl, statementUiToUrl } from "@/components/payroll/kit/statement-url";
import { useMarkPaid, useRefreshPayroll } from "@/components/payroll/kit/use-payroll-actions";
import { openPayrollDetails } from "@/components/payroll/kit/url-state";
import { SalaryStatementPanel } from "@/components/payroll/statement";
import { Button } from "@/components/ui/button";
import { useListPayrollRuns } from "@/lib/api-client";
import { onlyStaff, staffPeriodLabel, staffScope } from "./logic";

/**
 * Salary tab of the Staff Payroll page: the month's Salary Statement in the printed statement's format (departments, running
 * serial numbers, totals), with Excel / PDF / Print. Every row opens the payroll's details page, can be adjusted (bonus and
 * deductions) and, while pending, marked paid.
 */
export function SalaryTab({
  month,
  year,
  url,
  setUrl,
}: {
  month: number;
  year: number;
  url: Record<string, string>;
  setUrl: (patch: Record<string, string>) => void;
}) {
  const [, navigate] = useLocation();
  const [adjust, setAdjust] = useState<AdjustTarget | null>(null);
  const { markPaid, markingId } = useMarkPaid();
  const refresh = useRefreshPayroll();

  const scope = useMemo(() => staffScope({ month, year }), [month, year]);
  const periodLabel = staffPeriodLabel({ month, year });
  const runsQuery = useListPayrollRuns({ month, year });
  const runs = useMemo(() => onlyStaff(runsQuery.data), [runsQuery.data]);
  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const uiState = useMemo(() => statementUiFromUrl(url), [url]);
  const branchId = branchIdOf(url.sbranch);
  const filters = useMemo(() => (branchId ? { branchId } : undefined), [branchId]);

  if (runsQuery.isSuccess && runs.length === 0) {
    return (
      <EmptyNote
        icon={Users}
        title={`No payroll to show for ${periodLabel}`}
        hint="The salary statement is built from the month's payroll records. Generate the payroll first."
        testId="staff-salary-empty"
        action={
          <Button
            variant="outline"
            className="mt-2"
            onClick={() => setUrl({ tab: "payroll" })}
            data-testid="staff-salary-open-payroll"
          >
            Open the Payroll tab
          </Button>
        }
      />
    );
  }

  return (
    <div data-testid="staff-salary-tab">
      <SalaryStatementPanel
        scope={scope}
        filters={filters}
        accent="indigo"
        extraFilters={
          <BranchFilter value={url.sbranch} onChange={(v) => setUrl({ sbranch: v })} testId="statement-branch" />
        }
        uiState={uiState}
        onUiStateChange={(patch) => setUrl(statementUiToUrl(patch) as Record<string, string>)}
        onOpenDetails={(row) => {
          if (row.payrollId) openPayrollDetails(navigate, "staff", row.payrollId);
        }}
        renderRowActions={(row) => {
          const run = row.payrollId ? runById.get(row.payrollId) : undefined;
          if (!run) return null;
          const name = run.employeeName ?? run.employeeCode ?? "employee";
          return (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-indigo-600 hover:text-indigo-800"
                aria-label={`Edit the bonus and deductions of ${name}`}
                title="Edit bonus and deductions"
                onClick={() => setAdjust(adjustTargetFromRun(run, periodLabel))}
                data-testid={`staff-salary-adjust-${run.id}`}
              >
                <Pencil size={13} />
              </Button>
              {run.status === "pending" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                  aria-label={`Update the status of ${name}'s payroll to Cleared`}
                  title="Update the status to Cleared"
                  disabled={markingId === run.id}
                  onClick={() => void markPaid(run)}
                  data-testid={`staff-salary-pay-${run.id}`}
                >
                  {markingId === run.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  Mark as Cleared
                </Button>
              )}
            </>
          );
        }}
      />
      <AdjustPayrollDialog
        target={adjust}
        accent="indigo"
        onClose={() => setAdjust(null)}
        onApplied={() => void refresh({ skipCheck: false })}
      />
    </div>
  );
}
