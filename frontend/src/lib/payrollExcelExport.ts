import ExcelJS from "exceljs";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";

// Shared by both the Payroll page and the Salary page — one implementation,
// so "same Excel format" is a fact of the code, not a rule someone has to
// remember to keep in sync by hand.

// Bank transfer amounts must never carry stray floating-point noise (e.g. a
// stored 8000 rupee salary surfacing as 7999.9999999998 after Decimal→float
// JSON conversion). Round to the nearest paisa — real paise are preserved,
// noise is not.
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function exportPayrollToExcel(
  runs: PayrollRunItem[],
  sheetLabel: string,
  monthYear: string,
) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UKTextiles HRMS";
  const ws = wb.addWorksheet(sheetLabel.substring(0, 31));

  // Column definitions — widths match the bank template
  ws.columns = [
    { key: "A", width: 18 },  // Txn type
    { key: "B", width: 22 },  // Beneficiary Code
    { key: "C", width: 24 },  // Bene A/c No
    { key: "D", width: 14 },  // Amount
    { key: "E", width: 32 },  // Beneficiary Name
    { key: "F", width: 16 },  // IFSC code
    { key: "G", width: 30 },  // Bene Bank Name
    { key: "H", width: 30 },  // Bene Bank Branch Name
    { key: "I", width: 32 },  // Bene Email ID
  ];
  // Whole-rupee salaries show as whole rupees, genuine paise still show —
  // never a raw float's stray decimal tail.
  ws.getColumn(4).numFmt = "#,##0.00";

  const GREEN  = "FF5B8C00";   // olive-green matching the image
  const WHITE  = "FFFFFFFF";
  const RED    = "FFFF0000";   // Amount header is red in the template

  const styleHeader = (cell: ExcelJS.Cell, isAmount = false) => {
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    cell.font      = { bold: true, color: { argb: isAmount ? RED : WHITE } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  };
  const styleData = (cell: ExcelJS.Cell) => {
    cell.alignment = { horizontal: "center", vertical: "middle" };
  };

  // ── Row 1: Header labels ─────────────────────────────────────────────────
  const HEADERS = [
    "TXN TYPE\nRTGS-R\nNEFT-N\nHDFC TRF-I\nIMPS - M(1)",
    "BENEFICIARY CODE\n(MANDATORY ONLY FOR\nTXN TYPE \"I\")\n(13)",
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
  hRow.eachCell((cell, col) => styleHeader(cell, col === 4));

  // ── Row 2: M / O indicators ──────────────────────────────────────────────
  const INDICATORS = ["M", "M / O", "M", "M", "M", "M", "M", "O", "M"];
  const mRow = ws.addRow(INDICATORS);
  mRow.height = 18;
  mRow.eachCell(cell => styleHeader(cell));

  // ── Data rows ────────────────────────────────────────────────────────────
  for (const r of runs) {
    const dataRow = ws.addRow([
      "",                                       // Txn type — blank
      "",                                       // Beneficiary Code — blank
      (r.bankAccount || "").toUpperCase(),      // Bene A/c No
      roundMoney(r.finalSalary),                // Amount (numeric, exact — no float noise)
      (r.employeeName || "").toUpperCase(),     // Beneficiary Name
      (r.bankIfsc || "").toUpperCase(),         // IFSC code
      (r.bankName || "").toUpperCase(),         // Bene Bank Name
      "",                                       // Branch Name — blank
      "",                                       // Email — blank
    ]);
    dataRow.height = 16;
    dataRow.eachCell({ includeEmpty: true }, cell => styleData(cell));
  }

  // ── Download ─────────────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Payroll_${sheetLabel.replace(/[^a-zA-Z0-9]/g, "_")}_${monthYear.replace(/\s/g, "_")}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
