import type { Branch } from "@/lib/api-client/custom-hooks";
import type { BranchSummaryRow } from "./api";
import { EXPORT_HEADERS, exportRows } from "./logic";

/** Downloads the branches as an Excel sheet, in the order shown. The workbook library is loaded only when this runs. */
export async function exportBranchesXlsx(branches: Branch[], figures: Map<number, BranchSummaryRow>): Promise<void> {
  const { newWorkbook, downloadWorkbook, styleHeaderCell, todayStamp } = await import("@/lib/exportUtils");
  const wb = newWorkbook();
  const ws = wb.addWorksheet("Branches");
  ws.addRow(EXPORT_HEADERS);
  ws.getRow(1).eachCell((cell) => styleHeaderCell(cell, { fill: "FF0F766E" }));
  for (const row of exportRows(branches, figures)) ws.addRow(row);
  ws.columns.forEach((col, i) => {
    col.width = [24, 10, 12, 18, 40, 16, 14, 18, 10, 12, 12, 12, 12, 11][i] ?? 14;
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  await downloadWorkbook(wb, `Branches-${todayStamp()}.xlsx`);
}
