import type { PayrollRunItem } from "@/lib/api-client";
import type { AdjustTarget } from "./AdjustPayrollDialog";

/** What the Adjust dialog needs from a payroll record (staff or production alike). */
export function adjustTargetFromRun(run: PayrollRunItem, periodLabel: string): AdjustTarget {
  return {
    id: run.id,
    employeeName: run.employeeName,
    employeeCode: run.employeeCode,
    periodLabel,
    grossSalary: run.grossSalary,
    otAmount: run.otAmount,
    bonus: run.bonus,
    deductions: run.deductions,
    tdsDeduction: run.tdsDeduction,
    tdsPercent: run.tdsPercent,
    finalSalary: run.finalSalary,
    notes: run.notes,
  };
}
