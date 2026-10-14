import type ExcelJS from "exceljs";
import type { TableColumn } from "@/components/payroll/kit/export-table";
import type { CompensationReport, ReportRow, ReportSection } from "@/lib/api-client/custom-hooks";
import {
  addMergedTextRow,
  addTitleBlock,
  allBorders,
  downloadWorkbook,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";
import { dateLong } from "../logic";
import {
  IDENTITY_COLUMNS,
  REDEMPTION_COLUMNS,
  TYPE_COLUMNS,
  TYPE_META,
  reportFileStem,
  reportSubtitle,
  summaryTiles,
  tilesText,
} from "./history-logic";

// The History & Reports workbook: one Excel file with a Summary sheet (the period, the filters, and what each type gave) and
// one sheet for every type with its real columns, so the file is the report as it is on screen. Loaded only when the export
// is chosen (exceljs is large).

const HEADER_FILL = "FF1E3A5F";
const TITLE_FILL = "FFDCE8F5";
const BAND_FILL = "FFF7F9FC";
const HAIR = allBorders("hair", "FFD0D7E2");

type Kind = NonNullable<TableColumn<ReportRow>["type"]>;

function write(cell: ExcelJS.Cell, value: string | number | null, kind: Kind | undefined, banded: boolean) {
  if (kind === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split("-").map(Number);
    cell.value = new Date(Date.UTC(y, m - 1, d));
    cell.numFmt = "dd-mmm-yyyy";
  } else {
    cell.value = value;
    if (kind === "money") cell.numFmt = "#,##0.00";
    if (kind === "int") cell.numFmt = "0";
  }
  cell.border = HAIR;
  cell.alignment = {
    vertical: "middle",
    wrapText: true,
    horizontal: kind === "money" || kind === "int" ? "right" : "left",
  };
  if (banded) cell.fill = solidFill(BAND_FILL);
}

const read = (col: TableColumn<ReportRow>, row: ReportRow): string | number | null => {
  const v = col.value ? col.value(row) : (row as unknown as Record<string, unknown>)[col.key];
  return v === undefined || v === null ? null : (v as string | number);
};

/** The columns of a type's sheet: who, then the type's own. */
export const sheetColumns = (type: ReportSection["type"]): TableColumn<ReportRow>[] => [
  ...IDENTITY_COLUMNS(),
  ...TYPE_COLUMNS[type](),
];

function headerRow(ws: ExcelJS.Worksheet, rowNumber: number, columns: { label: string }[]) {
  const header = ws.getRow(rowNumber);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    styleHeaderCell(cell, { fill: HEADER_FILL, border: allBorders("thin", "FFBFC9D6") });
  });
  header.height = 24;
}

function addRows(ws: ExcelJS.Worksheet, from: number, columns: TableColumn<ReportRow>[], rows: ReportRow[]): number {
  rows.forEach((row, r) => {
    const excelRow = ws.getRow(from + r);
    columns.forEach((c, i) => write(excelRow.getCell(i + 1), read(c, row), c.type, r % 2 === 1));
  });
  return from + rows.length;
}

function typeSheet(wb: ExcelJS.Workbook, report: CompensationReport, section: ReportSection, company: string) {
  const meta = TYPE_META[section.type];
  const columns = sheetColumns(section.type);
  const ws = wb.addWorksheet(meta.sheet.slice(0, 31));
  ws.columns = columns.map((c) => ({ width: c.width ?? 16 }));
  const last = addTitleBlock(wb, ws, {
    totalCols: columns.length,
    company,
    branchLabel: reportSubtitle(report),
    title: meta.label,
    titleFill: TITLE_FILL,
  });
  headerRow(ws, last + 1, columns);
  ws.views = [{ state: "frozen", ySplit: last + 1 }];

  let next = last + 2;
  if (section.rows.length === 0) {
    ws.getCell(next, 1).value = "Nobody in this period.";
    ws.getCell(next, 1).font = { italic: true, color: { argb: "FF666666" } };
    next += 1;
  } else {
    next = addRows(ws, next, columns, section.rows);
  }

  // The balance redeemed in the period belongs to the same sheet: a second small table under the claims.
  if (section.type === "holiday_work" && (section.redemptions?.length ?? 0) > 0) {
    next += 1;
    addMergedTextRow(ws, next, Math.min(columns.length, 6), "Balance redeemed as days off in this period", {
      size: 11,
      fill: TITLE_FILL,
    });
    const redemption: TableColumn<ReportRow>[] = [...IDENTITY_COLUMNS(), ...REDEMPTION_COLUMNS()];
    headerRow(ws, next + 1, redemption);
    addRows(ws, next + 2, redemption, section.redemptions ?? []);
  }
}

function summarySheet(wb: ExcelJS.Workbook, report: CompensationReport, company: string, filters: ExportFilters) {
  const ws = wb.addWorksheet("Summary");
  const widths = [34, 70, 12, 12, 70];
  ws.columns = widths.map((width) => ({ width }));
  const last = addTitleBlock(wb, ws, {
    totalCols: widths.length,
    company,
    branchLabel: reportSubtitle(report),
    title: "Compensation: who benefited",
    titleFill: TITLE_FILL,
  });

  // The period and the filters, as label / value pairs
  const facts: [string, string][] = [
    ["Period", report.period === "today" ? "Today" : report.period === "week" ? "Week" : "Month"],
    ["From", dateLong(report.from)],
    ["To", dateLong(report.to)],
    ["Department", filters.department || "All departments"],
    ["Branch", filters.branch || "All branches"],
    ["Types", report.types.map((t) => TYPE_META[t].label).join(", ")],
    ["Records", String(report.totals.rows)],
    ["Employees who benefited", String(report.totals.employees)],
  ];
  facts.forEach(([name, value], i) => {
    const row = ws.getRow(last + 2 + i);
    row.getCell(1).value = name;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = value;
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  });

  const tableTop = last + 2 + facts.length + 1;
  const columns = [
    { label: "Type" },
    { label: "Who benefits" },
    { label: "Employees" },
    { label: "Records" },
    { label: "Totals" },
  ];
  headerRow(ws, tableTop, columns);
  report.sections.forEach((section, r) => {
    const row = ws.getRow(tableTop + 1 + r);
    const banded = r % 2 === 1;
    write(
      row.getCell(1),
      TYPE_META[section.type].label + (section.enabled ? "" : " (switched off in Settings)"),
      undefined,
      banded,
    );
    write(row.getCell(2), TYPE_META[section.type].who, undefined, banded);
    write(row.getCell(3), section.summary.employees ?? 0, "int", banded);
    write(row.getCell(4), section.rows.length, "int", banded);
    write(row.getCell(5), tilesText(summaryTiles(section.type, section.summary)), undefined, banded);
  });
  ws.views = [{ state: "frozen", ySplit: last + 1 }];
}

export type ExportFilters = { department?: string | null; branch?: string | null };

/** The whole report as a workbook (built for real; the caller downloads it). */
export function buildReportWorkbook(
  report: CompensationReport,
  company: string,
  filters: ExportFilters = {},
): ExcelJS.Workbook {
  const wb = newWorkbook();
  summarySheet(wb, report, company, filters);
  for (const section of report.sections) typeSheet(wb, report, section, company);
  return wb;
}

export async function exportReportWorkbook(
  report: CompensationReport,
  company: string,
  filters: ExportFilters = {},
): Promise<void> {
  await downloadWorkbook(buildReportWorkbook(report, company, filters), `${reportFileStem(report)}.xlsx`);
}
