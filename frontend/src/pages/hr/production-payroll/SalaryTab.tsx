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
import { useListProductionPayroll, type CyclePeriod, type PayCycle } from "@/lib/api-client/custom-hooks";
import { formatPeriod, productionScope, type UrlSetter } from "./logic";

/**
 * Salary tab of a cycle page: the period's Production Salary Statement in the printed statement's format (departments,
 * running serial numbers, shift columns, totals), with Excel / PDF / Print. Every row opens the payroll's details page,
 * can be adjusted (bonus and deductions) and, while pending, marked paid.
 */
export function SalaryTab({
  cycle,
  period,
  url,
  setUrl,
}: {
  cycle: PayCycle;
  period: CyclePeriod;
  url: Record<string, string>;
  setUrl: UrlSetter;
}) {
  const [, navigate] = useLocation();
  const [adjust, setAdjust] = useState<AdjustTarget | null>(null);
  const { markPaid, markingId } = useMarkPaid();
  const refresh = useRefreshPayroll();

  const scope = useMemo(() => productionScope(cycle, period), [cycle, period]);
  const periodLabel = formatPeriod(period);
  // The same request as the Payroll tab's records: it tells which rows can be adjusted or paid, and whether there is anything yet.
  const runsQuery = useListProductionPayroll({
    cycle,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    limit: 500,
  });
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const uiState = useMemo(() => statementUiFromUrl(url), [url]);
  const branchId = branchIdOf(url.sbranch);
  const filters = useMemo(() => (branchId ? { branchId } : undefined), [branchId]);

  if (runsQuery.isSuccess && runs.length === 0) {
    return (
      <EmptyNote
        icon={Users}
        title={`No payroll to show for ${periodLabel}`}
        hint="The salary statement is built from the period's payroll records. Generate the payroll first."
        testId="pcp-salary-empty"
        action={
          <Button
            variant="outline"
            className="mt-2"
            onClick={() => setUrl({ tab: "payroll" })}
            data-testid="pcp-salary-open-payroll"
          >
            Open the Payroll tab
          </Button>
        }
      />
    );
  }

  return (
    <div data-testid="pcp-salary-tab">
      <SalaryStatementPanel
        scope={scope}
        filters={filters}
        accent="amber"
        extraFilters={
          <BranchFilter value={url.sbranch} onChange={(v) => setUrl({ sbranch: v })} testId="statement-branch" />
        }
        uiState={uiState}
        onUiStateChange={(patch) => setUrl(statementUiToUrl(patch) as Record<string, string>)}
        onOpenDetails={(row) => {
          if (row.payrollId) openPayrollDetails(navigate, "production", row.payrollId);
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
                className="h-7 w-7 text-amber-600 hover:text-amber-800"
                aria-label={`Edit the bonus and deductions of ${name}`}
                title="Edit bonus and deductions"
                onClick={() => setAdjust(adjustTargetFromRun(run, periodLabel))}
                data-testid={`pcp-salary-adjust-${run.id}`}
              >
                <Pencil size={13} />
              </Button>
              {run.status === "pending" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                  aria-label={`Update the status of ${name}'s payroll to Paid`}
                  title="Update the status to Paid"
                  disabled={markingId === run.id}
                  onClick={() => void markPaid(run)}
                  data-testid={`pcp-salary-pay-${run.id}`}
                >
                  {markingId === run.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  Pay
                </Button>
              )}
            </>
          );
        }}
      />
      <AdjustPayrollDialog
        target={adjust}
        accent="amber"
        onClose={() => setAdjust(null)}
        onApplied={() => void refresh({ skipCheck: false })}
      />
    </div>
  );
}
