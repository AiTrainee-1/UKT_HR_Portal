import type ExcelJS from "exceljs";
import type { SalaryStatement, StatementColumn, StatementRow } from "@/lib/api-client/custom-hooks";
import {
  addTitleBlock,
  allBorders,
  downloadWorkbook,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";
import {
  GRAND_TOTAL_LABEL,
  cellValue,
  columnBands,
  formatStamp,
  statementFileStem,
  statementTitle,
  stickyCount,
  subtotalLabel,
  toNumber,
  type ColumnGroupKey,
} from "./statement-model";

// The Salary Statement as an Excel workbook: one sheet laid out like the printed statement (company, branch and title on
// top, a two-row header, a band per department with its employees and a subtotal, the grand total, the notes), with REAL
// numbers so it can be sorted, summed and pasted into other sheets, and set up to print on A4 landscape, one page wide.

const NAVY = "FF1E3A5F";
const BORDER = "FFD0D7E2";
const ZEBRA = "FFF7F9FC";
const BAND_FILL = "FFE8EEF7";
const SUBTOTAL_FILL = "FFEEF2F9";
const TITLE_FILL = "FFDCE8F5";

const GROUP_FILL: Record<ColumnGroupKey, string> = {
  identity: "FFE2E8F0",
  attendance: "FFDBEAFE",
  earnings: "FFD1FAE5",
  deductions: "FFFFE4E6",
  result: "FFE0E7FF",
};

/** The page accent: Staff Payroll is indigo, Production Payroll amber (grand total, tab colour, the "Net pay" band). */
const ACCENT = {
  staff: { total: "FF3730A3", tab: "FF4F46E5", result: "FFE0E7FF" },
  production: { total: "FF92400E", tab: "FFD97706", result: "FFFEF3C7" },
} as const;

export const NUMBER_FORMAT: Record<StatementColumn["format"], string | null> = {
  money: "#,##0.00",
  days: "0.00",
  int: "0",
  text: null,
};

/** Excel column width in characters: the weight, but wide enough for the header's longest word. */
export function excelColumnWidth(column: StatementColumn): number {
  const weight = Number.isFinite(column.weight) && column.weight > 0 ? column.weight : 1;
  const words = [column.label, column.sub ?? ""].flatMap((t) => t.split(/\s+/));
  const header = words.reduce((max, w) => Math.max(max, w.length), 0) + 2;
  return Math.min(44, Math.max(6, Math.round(weight * 11), header));
}

const thin = allBorders("thin", BORDER);
const hair = allBorders("hair", BORDER);

function writeCell(cell: ExcelJS.Cell, column: StatementColumn, row: StatementRow): void {
  const v = cellValue(row, column);
  if (column.format === "text") {
    cell.value = v === null || v === "" ? null : String(v);
    return;
  }
  const n = toNumber(v);
  if (n === null) {
    cell.value = typeof v === "string" && v !== "" ? v : null;
    return;
  }
  cell.value = n;
  cell.numFmt = NUMBER_FORMAT[column.format] ?? "General";
}

export type StatementWorkbookOptions = {
  /** "data:image/png;base64,..." of the company logo, pinned top-left (anything else is ignored). */
  logoDataUrl?: string | null;
};

export function buildStatementWorkbook(
  statement: SalaryStatement,
  options: StatementWorkbookOptions = {},
): ExcelJS.Workbook {
  const columns = statement.columns;
  const n = Math.max(1, columns.length);
  const accent = ACCENT[statement.kind] ?? ACCENT.staff;
  const title = statementTitle(statement);

  const wb = newWorkbook();
  wb.title = title;
  wb.subject = `${statement.company.name} payroll`;
  const created = new Date(statement.generatedAt);
  if (!Number.isNaN(created.getTime())) wb.created = created;
  const ws = wb.addWorksheet("Salary Statement", { properties: { tabColor: { argb: accent.tab } } });
  ws.columns = columns.map((c) => ({ key: c.key, width: excelColumnWidth(c) }));

  // Rows 1-3: company, branch, the title.
  const last = addTitleBlock(wb, ws, {
    totalCols: n,
    company: statement.company.name,
    branchLabel: statement.company.branchLabel ?? "",
    title,
    titleFill: TITLE_FILL,
    logoDataUrl: options.logoDataUrl,
  });

  // The two-row header: the column-group bands, then the labels with their second lines.
  const bandRow = last + 1;
  const labelRow = last + 2;
  for (const band of columnBands(columns)) {
    const from = band.start + 1;
    const to = band.start + band.span;
    const fill = band.group === "result" ? accent.result : GROUP_FILL[band.group];
    for (let c = from; c <= to; c += 1) {
      const cell = ws.getCell(bandRow, c);
      cell.fill = solidFill(fill);
      cell.border = thin;
      cell.font = { bold: true, size: 9, color: { argb: "FF334155" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    }
    ws.getCell(bandRow, from).value = band.label.toUpperCase();
    // merging last: the merged cells take the first cell's style, edges and all
    if (band.span > 1) ws.mergeCells(bandRow, from, bandRow, to);
  }
  columns.forEach((col, i) => {
    const cell = ws.getCell(labelRow, i + 1);
    cell.value = col.sub ? `${col.label}\n${col.sub}` : col.label;
    styleHeaderCell(cell, { fill: NAVY, size: 10, border: thin });
  });
  ws.getRow(bandRow).height = 16;
  ws.getRow(labelRow).height = 30;

  // SNO / ID NO / Name stay in view when the sheet is scrolled sideways; the header stays when it is scrolled down.
  const sticky = stickyCount(columns);
  ws.views = [{ state: "frozen", xSplit: sticky, ySplit: labelRow }];

  let r = labelRow + 1;

  const labelSpan = Math.max(1, sticky);
  const summary = (row: StatementRow, label: string, kind: "subtotal" | "total") => {
    const total = kind === "total";
    const fill = solidFill(total ? accent.total : SUBTOTAL_FILL);
    const color = total ? "FFFFFFFF" : "FF0F172A";
    columns.forEach((col, i) => {
      const cell = ws.getCell(r, i + 1);
      if (i >= labelSpan) writeCell(cell, col, row);
      cell.fill = fill;
      cell.font = { bold: true, color: { argb: color } };
      cell.border = { ...thin, top: { style: total ? "medium" : "thin", color: { argb: total ? NAVY : BORDER } } };
      cell.alignment = { vertical: "middle", horizontal: col.align };
    });
    // the label spans SNO .. Name (the columns that stay in view)
    const labelCell = ws.getCell(r, 1);
    labelCell.value = label;
    labelCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    if (labelSpan > 1) ws.mergeCells(r, 1, r, labelSpan);
    ws.getRow(r).height = 20;
    r += 1;
  };

  for (const group of statement.groups) {
    // the department's band, merged across the sheet
    const count = group.rows.length;
    for (let c = 1; c <= n; c += 1) {
      const cell = ws.getCell(r, c);
      cell.fill = solidFill(BAND_FILL);
      cell.border = thin;
    }
    const band = ws.getCell(r, 1);
    band.value = `${group.label}  (${count} ${count === 1 ? "employee" : "employees"})`;
    band.font = { bold: true, size: 11, color: { argb: "FF0F172A" } };
    band.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    if (n > 1) ws.mergeCells(r, 1, r, n);
    ws.getRow(r).height = 20;
    r += 1;

    group.rows.forEach((row, ri) => {
      columns.forEach((col, i) => {
        const cell = ws.getCell(r, i + 1);
        writeCell(cell, col, row);
        cell.border = hair;
        cell.alignment = { vertical: "middle", horizontal: col.align, wrapText: col.key === "designation" };
        if (col.group === "result" && col.format === "money") cell.font = { bold: true };
        if (ri % 2 === 1) cell.fill = solidFill(ZEBRA);
      });
      r += 1;
    });
    summary(group.subtotal, subtotalLabel(group.label), "subtotal");
  }
  summary(statement.total, GRAND_TOTAL_LABEL, "total");

  // Under the table: how the figures were worked out, then who and when.
  r += 1;
  const note = (text: string, options: { bold?: boolean; size?: number; color?: string } = {}) => {
    const cell = ws.getCell(r, 1);
    cell.value = text;
    cell.font = { bold: options.bold ?? false, size: options.size ?? 9, color: { argb: options.color ?? "FF64748B" } };
    cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
    if (n > 1) ws.mergeCells(r, 1, r, n);
    const widthChars = columns.reduce((sum, c) => sum + excelColumnWidth(c), 0);
    ws.getRow(r).height = 13 * Math.max(1, Math.ceil(text.length / Math.max(40, widthChars)));
    r += 1;
  };
  if (statement.notes.length > 0) {
    note("Notes", { bold: true, size: 10, color: "FF334155" });
    for (const text of statement.notes) note(text);
  }
  const { employees, departments, paid, pending } = statement.counts;
  note(
    `${employees} employees  -  ${departments} departments  -  ${paid} paid  -  ${pending} pending  -  Generated ${formatStamp(statement.generatedAt)}`,
  );

  // Printing: A4 landscape, one page wide, the title and header repeated on every page, "Page 1 of 9" in the footer.
  ws.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `1:${labelRow}`,
    horizontalCentered: true,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.55, header: 0.2, footer: 0.25 },
  };
  ws.headerFooter.oddFooter = `&L&8${statement.company.name} - Salary Statement&R&8Page &P of &N`;
  return wb;
}

export const statementXlsxFilename = (statement: SalaryStatement): string => `${statementFileStem(statement)}.xlsx`;

/** Builds the workbook and downloads it as `Salary_Statement_<period>.xlsx`. */
export async function downloadStatementXlsx(
  statement: SalaryStatement,
  options: StatementWorkbookOptions = {},
): Promise<void> {
  await downloadWorkbook(buildStatementWorkbook(statement, options), statementXlsxFilename(statement));
}
