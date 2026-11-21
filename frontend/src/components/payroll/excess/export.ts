import { fileStem } from "@/components/payroll/kit/format";
import type { ExcessDepartment, PayrollKind } from "@/lib/api-client/custom-hooks";
import {
  addMergedTextRow,
  allBorders,
  downloadWorkbook,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";
import { EXPORT_HEADER, exportRows } from "./logic";

// The month's (period's) Excess / Detection breakdown as an Excel file: one line per employee (with the entries and their
// remarks), a total line per department and a grand total. The figures are exactly the ones on screen (the filters apply).

const MONEY_COLUMNS = [6, 7, 8, 9, 10, 11]; // Excess .. NET pay (1-based)
const WIDTHS = [22, 8, 10, 26, 22, 12, 12, 12, 16, 16, 12, 18, 60];

export async function exportExcessBreakdown(
  departments: readonly ExcessDepartment[],
  periodLabel: string,
  note?: string,
  kind: PayrollKind = "staff",
): Promise<void> {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet("Excess & Detection", { views: [{ state: "frozen", ySplit: note ? 3 : 2 }] });
  const cols = EXPORT_HEADER.length;
  addMergedTextRow(ws, 1, cols, `Excess & Detection - ${periodLabel}`, {
    size: 13,
    fill: kind === "production" ? "FFFEF3C7" : "FFE0E7FF",
    height: 24,
  });
  let headerRow = 2;
  if (note) {
    addMergedTextRow(ws, 2, cols, note, { size: 10, bold: false, color: "FF555555" });
    headerRow = 3;
  }
  ws.getRow(headerRow).values = [...EXPORT_HEADER];
  ws.getRow(headerRow).eachCell((cell) =>
    styleHeaderCell(cell, { fill: kind === "production" ? "FFD97706" : "FF4F46E5", border: allBorders("thin") }),
  );
  ws.getRow(headerRow).height = 30;
  WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const { rows, totalRowIndexes } = exportRows(departments, kind);
  const totals = new Set(totalRowIndexes);
  rows.forEach((values, i) => {
    const row = ws.getRow(headerRow + 1 + i);
    row.values = values;
    MONEY_COLUMNS.forEach((c) => (row.getCell(c).numFmt = "#,##0.00"));
    row.getCell(cols).alignment = { wrapText: true, vertical: "top" };
    row.eachCell({ includeEmpty: true }, (cell) => (cell.border = allBorders("thin", "FFD4D4D8")));
    if (totals.has(i)) {
      row.font = { bold: true };
      row.eachCell({ includeEmpty: true }, (cell) => (cell.fill = solidFill("FFF1F5F9")));
    }
  });

  await downloadWorkbook(wb, `${fileStem("Excess_Detection", periodLabel)}.xlsx`);
}
