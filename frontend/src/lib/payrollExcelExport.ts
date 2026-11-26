import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { downloadBankFile } from "@/lib/bankFile";
import { roundUpRupee } from "@/lib/round-up-rupee";

// Shared by both the Payroll page and the Salary page -one implementation,
// so "same Excel format" is a fact of the code, not a rule someone has to
// remember to keep in sync by hand.

// The amount paid is the NET rounded UP to the next whole rupee - exactly the NET the Salary Statement prints (owner
// 2026-11-10: the two files must match to the rupee). Payroll generated since then already stores a whole rupee; an older
// payroll with paise is paid as the statement shows it. Float noise never adds a rupee (round-up-rupee.ts).

/**
 * May this payroll be paid through a bank file? Never a salary On Hold, never a new joiner not yet added to the payroll
 * (owner 2026-11-10): the server already leaves them out of the month's list, and the file leaves them out again even if
 * it is handed them. A held / new employee released and paid on their own has neither flag any more, so their own
 * one-person file still works. Never a payroll added from the Missed Payroll page (2026-11-23): that page pays it with its
 * own bank file, so it is never paid twice.
 */
export const isBankFileEligible = (run: Pick<PayrollRunItem, "onHold" | "newJoinerParked" | "source">): boolean =>
  !run.onHold && !run.newJoinerParked && run.source !== "missed_payroll";

/** Which payroll's bank file: the month's ("payroll") or the Skipped Employees' own ("skipped"). */
export type BankFileSection = "payroll" | "skipped";

/**
 * The rows a bank file pays. The month's file: everyone handed over but a held salary or a parked new joiner. The Skipped
 * Employees' file (owner 2026-11-10): ONLY a held salary or a parked new joiner that is not paid yet - never anybody from
 * the month's payroll, never someone already paid (released and paid separately), so nobody is paid twice.
 */
export function bankFileRows(runs: PayrollRunItem[], section: BankFileSection = "payroll"): PayrollRunItem[] {
  if (section === "skipped")
    return runs.filter((r) => (r.onHold || r.newJoinerParked) && r.paymentStatus !== "paid" && !r.releasedFrom);
  return runs.filter(isBankFileEligible);
}

export async function exportPayrollToExcel(
  allRuns: PayrollRunItem[],
  sheetLabel: string,
  monthYear: string,
  section: BankFileSection = "payroll",
) {
  const runs = bankFileRows(allRuns, section);
  // the shared bank file writer (bankFile.ts): same 10 columns, headers, M / O row, colours and widths as always
  await downloadBankFile(
    runs.map((r) => ({
      employeeCode: r.employeeCode,
      employeeName: r.employeeName,
      bankAccount: r.bankAccount,
      bankIfsc: r.bankIfsc,
      bankName: r.bankName,
      amount: roundUpRupee(r.finalSalary), // the NET up to the next whole rupee, as the Salary Statement prints it
    })),
    sheetLabel,
    `Payroll_${sheetLabel.replace(/[^a-zA-Z0-9]/g, "_")}_${monthYear.replace(/\s/g, "_")}.xlsx`,
  );
}
