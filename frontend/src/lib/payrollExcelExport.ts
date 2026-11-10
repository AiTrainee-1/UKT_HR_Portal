import type ExcelJS from "exceljs";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { downloadWorkbook, newWorkbook, styleHeaderCell } from "@/lib/exportUtils";
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
 * one-person file still works.
 */
export const isBankFileEligible = (run: Pick<PayrollRunItem, "onHold" | "newJoinerParked">): boolean =>
  !run.onHold && !run.newJoinerParked;

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
  const wb = await newWorkbook();
  const ws = wb.addWorksheet(sheetLabel.substring(0, 31));

  // Column definitions -widths match the bank template
  ws.columns = [
    { key: "A", width: 18 }, // Txn type
    { key: "B", width: 22 }, // Beneficiary Code
    { key: "C", width: 16 }, // Employee Code (owner 2026-11-06: right after Beneficiary Code)
    { key: "D", width: 24 }, // Bene A/c No
    { key: "E", width: 14 }, // Amount
    { key: "F", width: 32 }, // Beneficiary Name
    { key: "G", width: 16 }, // IFSC code
    { key: "H", width: 30 }, // Bene Bank Name
    { key: "I", width: 30 }, // Bene Bank Branch Name
    { key: "J", width: 32 }, // Bene Email ID
  ];
  const AMOUNT_COLUMN = 5;
  // Whole-rupee salaries show as whole rupees, genuine paise still show —
  // never a raw float's stray decimal tail.
  ws.getColumn(AMOUNT_COLUMN).numFmt = "#,##0.00";

  const GREEN = "FF5B8C00"; // olive-green matching the image
  const WHITE = "FFFFFFFF";
  const RED = "FFFF0000"; // Amount header is red in the template

  const styleHeader = (cell: ExcelJS.Cell, isAmount = false) =>
    styleHeaderCell(cell, { fill: GREEN, color: isAmount ? RED : WHITE });
  const styleData = (cell: ExcelJS.Cell) => {
    cell.alignment = { horizontal: "center", vertical: "middle" };
  };

  // ── Row 1: Header labels ─────────────────────────────────────────────────
  const HEADERS = [
    "TXN TYPE\nRTGS-R\nNEFT-N\nHDFC TRF-I\nIMPS - M(1)",
    'BENEFICIARY CODE\n(MANDATORY ONLY FOR\nTXN TYPE "I")\n(13)',
    "EMPLOYEE CODE",
    "BENE A/C NO\n(25)",
    "AMOUNT\n(20)",
    "BENEFICIARY NAME\n(35)",
    "IFSC CODE\n(11)",
    "BENE BANK NAME\n(40)",
    "BENE BANK BRANCH NAME\n(40)",
    "BENE EMAIL ID\n(100)",
  ];

  const hRow = ws.addRow(HEADERS);
  hRow.height = 72;
  hRow.eachCell((cell, col) => styleHeader(cell, col === AMOUNT_COLUMN));

  // ── Row 2: M / O indicators ──────────────────────────────────────────────
  const INDICATORS = ["M", "M / O", "", "M", "M", "M", "M", "M", "O", "M"];
  const mRow = ws.addRow(INDICATORS);
  mRow.height = 18;
  mRow.eachCell({ includeEmpty: true }, (cell) => styleHeader(cell));

  // ── Data rows ────────────────────────────────────────────────────────────
  for (const r of runs) {
    const dataRow = ws.addRow([
      "", // Txn type -blank
      "", // Beneficiary Code -blank
      r.employeeCode || "", // Employee Code (as text, so a code like 0123 keeps its zero)
      (r.bankAccount || "").toUpperCase(), // Bene A/c No
      roundUpRupee(r.finalSalary), // Amount: the NET up to the next whole rupee, as the Salary Statement prints it
      (r.employeeName || "").toUpperCase(), // Beneficiary Name
      (r.bankIfsc || "").toUpperCase(), // IFSC code
      (r.bankName || "").toUpperCase(), // Bene Bank Name
      "", // Branch Name -blank
      "", // Email -blank
    ]);
    dataRow.height = 16;
    dataRow.eachCell({ includeEmpty: true }, (cell) => styleData(cell));
  }

  // ── Download ─────────────────────────────────────────────────────────────
  await downloadWorkbook(
    wb,
    `Payroll_${sheetLabel.replace(/[^a-zA-Z0-9]/g, "_")}_${monthYear.replace(/\s/g, "_")}.xlsx`,
  );
}
