import type ExcelJS from "exceljs";
import type { jsPDF } from "jspdf";
import {
  addMergedTextRow,
  addTitleBlock,
  allBorders,
  downloadWorkbook,
  fileSafe,
  newWorkbook,
  solidFill,
  styleHeaderCell,
  todayStamp,
} from "@/lib/exportUtils";
import { renderTablePdf, type ExportCompany, type PdfColumn, type PdfRow } from "../attendance/export";
import type { ExportCell, SettlementExport } from "./logic";

// The Settlement exports (owner 2026-11-20, columns 2026-11-26): one tab's list as the page shows it (tab, month, every
// filter, the search and the sort) in the status chosen in the Export menu, as an Excel workbook through the shared lazy
// ExcelJS, and as an A4 landscape PDF drawn by the same table renderer as the attendance exports. The page loads this
// module only when an export is asked for. Nothing here changes data.

export type SettlementExportInput = ExportCompany & { table: SettlementExport; now: Date };

const MONEY_FMT = "#,##0.00";

const stamp = (now: Date) =>
  now.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** "Settlement_Term_Loan_Pending_November_2026_2026-11-20.xlsx". */
export const exportFileName = (table: SettlementExport, ext: "xlsx" | "pdf") =>
  `${fileSafe(table.fileStem)}_${todayStamp()}.${ext}`;

export async function buildSettlementWorkbook(input: SettlementExportInput): Promise<ExcelJS.Workbook> {
  const { table } = input;
  const cols = table.columns.length;
  const wb = await newWorkbook();
  const ws = wb.addWorksheet(table.sheet.slice(0, 31));
  ws.columns = table.columns.map((c) => ({ width: c.width }));
  let last = addTitleBlock(wb, ws, {
    totalCols: cols,
    company: input.company,
    branchLabel: input.branchLabel,
    title: table.title,
    titleFill: "FFDCE8F5",
    logoDataUrl: input.logoDataUrl,
  });
  last += 1;
  addMergedTextRow(ws, last, cols, `${table.subtitle}. Amounts in rupees. Generated ${stamp(input.now)}.`, {
    size: 9,
    bold: false,
    color: "FF64748B",
  });
  const head = ws.getRow(last + 1);
  table.columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    styleHeaderCell(cell, { fill: "FF1E3A5F", border: allBorders("thin", "FFBFC9D6") });
  });
  head.height = 30;
  ws.views = [{ state: "frozen", ySplit: last + 1 }];
  const lines: ExportCell[][] = [...table.rows, table.totals];
  lines.forEach((values, r) => {
    const row = ws.getRow(last + 2 + r);
    const total = r === lines.length - 1;
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      const { money, numeric } = table.columns[i];
      cell.value = v === "" ? null : v;
      if (money && typeof v === "number") cell.numFmt = MONEY_FMT;
      cell.alignment = { vertical: "top", wrapText: true, horizontal: money || numeric ? "right" : "left" };
      cell.border = allBorders("hair", "FFD0D7E2");
      if (total) {
        cell.font = { bold: true };
        cell.fill = solidFill("FFE8EEF6");
      } else if (r % 2 === 1) {
        cell.fill = solidFill("FFF7F9FC");
      }
    });
  });
  return wb;
}

/** The PDF's columns: the table's width shared by each column's weight. */
export function settlementPdfColumns(table: SettlementExport, width = 277): PdfColumn[] {
  const sum = table.columns.reduce((a, c) => a + c.weight, 0);
  return table.columns.map((c) => ({
    header: c.money ? `${c.header} (Rs)` : c.header,
    mm: (c.weight / sum) * width,
    align: c.money || c.numeric ? "center" : "left",
  }));
}

/** A rupee figure as the PDF prints it ("12,34,567.5"); the column heading says "(Rs)". */
const pdfCell = (v: ExportCell): string =>
  typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : v;

export function settlementPdfRows(table: SettlementExport): PdfRow[] {
  const line = (values: ExportCell[]) => values.map(pdfCell);
  return [...table.rows.map((values) => ({ cells: line(values) })), { cells: line(table.totals), total: true }];
}

export async function buildSettlementPdf(input: SettlementExportInput): Promise<jsPDF> {
  const { table } = input;
  return renderTablePdf({
    title: table.title,
    subtitle: table.subtitle,
    company: input,
    columns: settlementPdfColumns(table),
    rows: settlementPdfRows(table),
    notes: [
      "Fixed Salary = the monthly fixed salary. Working Days, Earned Salary and Limit are for the 1st to the 20th of the month the advance was raised in; Limit = 50% of the Earned Salary (blank for production employees).",
      "Requested = what was asked for; Approved = what HR approved (active and completed advances only), the amount payroll deducts.",
    ],
    now: input.now,
  });
}

export async function downloadSettlementExcel(input: SettlementExportInput) {
  await downloadWorkbook(await buildSettlementWorkbook(input), exportFileName(input.table, "xlsx"));
}

export async function downloadSettlementPdf(input: SettlementExportInput) {
  (await buildSettlementPdf(input)).save(exportFileName(input.table, "pdf"));
}
