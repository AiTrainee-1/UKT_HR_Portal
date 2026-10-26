// The Daily Late Report as an Excel file, made unit by unit: the company block (name, branch, logo) like every other export, the
// report title, the date and the moment it was made, then the seven columns with a frozen header, minutes as real numbers and
// times as real times, a colour step per severity, and for each unit a full-width band ("HO   19 late") followed by its rows,
// the longest delay first. Nothing else: no summary line, no explanation, no totals row (the page has those).
//
// Filters: the table has a Unit column (an 8th, narrow one) and the auto-filter covers the header and every row below it, bands
// included. A band is one merged cell, so its Unit cell is empty: filtering a column to a value (a unit in the Unit column, a
// department, a number of minutes) hides the bands and leaves a clean list, and clearing the filter brings them back. (Sorting a
// range that holds merged cells is refused by Excel: filter, do not sort.) The header stays frozen either way.

import type { Workbook } from "exceljs";
import {
  addMergedTextRow,
  addTitleBlock,
  allBorders,
  downloadWorkbook,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";
import { longDate } from "../leave/logic";
import {
  LATE_COLUMNS,
  LATE_REPORT_TITLE,
  SEVERITY_COLORS,
  UNIT_BAND_COLORS,
  bandText,
  generatedStamp,
  groupEntriesByUnit,
  lateFileStem,
  severityOf,
  type LateEntry,
} from "./late";
import { minutesOf } from "./logic";

export type LateReportInput = {
  /** The report's date, YYYY-MM-DD. */
  date: string;
  /** The rows to put in the report, in any order: the files group them by unit and order each unit longest delay first. */
  entries: LateEntry[];
  company: string;
  branchLabel: string;
  logoDataUrl?: string | null;
  /** What narrows the list ("Department: Admin"), "" for nothing. */
  filter?: string;
  now?: Date;
};

const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;
const INK = "FF0F172A";
const MUTED = "FF64748B";
const RULE = "FFE2E8F0";
const HEAD_FILL = "FF1E293B";
const TITLE_FILL = "FF312E81";
const ZEBRA = "FFF8FAFC";

/** First row of the table: the title block, the date and (when something narrows the list) one note line come before it. */
export const HEADER_ROW = 6;

/** The columns of the sheet: the report's seven and the narrow Unit one for filtering. */
export const EXCEL_UNIT_COLUMN = LATE_COLUMNS.length + 1;

export function buildLateWorkbook(input: LateReportInput): Workbook {
  const now = input.now ?? new Date();
  const cols = EXCEL_UNIT_COLUMN;
  const groups = groupEntriesByUnit(input.entries);
  const wb = newWorkbook();
  const ws = wb.addWorksheet("Daily Late Report", {
    views: [{ state: "frozen", ySplit: HEADER_ROW }],
    pageSetup: {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: "&LDaily Late Report&RPage &P of &N" },
  });
  ws.columns = [...LATE_COLUMNS.map((c) => ({ width: c.chars })), { width: 11 }];

  // company, branch, logo and the title bar (the soft red of the attendance reports is restyled to the indigo of the page)
  addTitleBlock(wb, ws, {
    totalCols: cols,
    company: input.company,
    branchLabel: input.branchLabel,
    title: LATE_REPORT_TITLE,
    logoDataUrl: input.logoDataUrl,
  });
  const title = ws.getCell(3, 1);
  title.fill = solidFill(TITLE_FILL);
  title.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };

  addMergedTextRow(ws, 4, cols, `Date: ${longDate(input.date)}   |   Generated: ${generatedStamp(now)}`, {
    size: 10,
    bold: false,
    color: INK,
  });
  // what narrows the list (a department, a search, "Selected: 2 of 18"), only when something does
  if (input.filter) addMergedTextRow(ws, 5, cols, input.filter, { size: 9, bold: false, color: MUTED });

  const head = ws.getRow(HEADER_ROW);
  head.height = 28;
  [
    ...LATE_COLUMNS.map((c) => ({ header: c.header, align: c.align })),
    { header: "Unit", align: "center" as const },
  ].forEach((col, i) => {
    const cell = head.getCell(i + 1);
    cell.value = col.header;
    styleHeaderCell(cell, { fill: HEAD_FILL, border: allBorders("thin", HEAD_FILL) });
    cell.alignment = { horizontal: col.align, vertical: "middle", wrapText: true };
  });

  let rowIdx = HEADER_ROW + 1;
  for (const group of groups) {
    // the unit's band: one merged, filled row across the table
    ws.mergeCells(rowIdx, 1, rowIdx, cols);
    const band = ws.getCell(rowIdx, 1);
    band.value = bandText(group);
    band.font = { bold: true, size: 11, color: { argb: argb(UNIT_BAND_COLORS.text) } };
    band.fill = solidFill(argb(UNIT_BAND_COLORS.bg));
    band.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
    band.border = { top: { style: "thin", color: { argb: argb(UNIT_BAND_COLORS.text) } } };
    ws.getRow(rowIdx).height = 22;
    rowIdx += 1;

    group.entries.forEach((entry, i) => {
      const row = ws.getRow(rowIdx);
      row.height = 20;
      const time = (hhmm: string | null) => (hhmm && Number.isFinite(minutesOf(hhmm)) ? minutesOf(hhmm) / 1440 : "—");
      const values: Record<string, string | number | null> = {
        name: entry.name,
        code: entry.code,
        department: entry.department?.trim() || "—",
        shiftStart: time(entry.shiftStart),
        grace: entry.grace ?? "—",
        punchIn: time(entry.punchIn),
        minutesLate: entry.minutesLate ?? "—",
      };
      LATE_COLUMNS.forEach((col, c) => {
        const cell = row.getCell(c + 1);
        cell.value = values[col.key];
        cell.alignment = { horizontal: col.align, vertical: "middle" };
        cell.font = { size: 10, color: { argb: INK }, bold: col.key === "name" };
        cell.border = { bottom: { style: "thin", color: { argb: RULE } } };
        if (i % 2 === 1) cell.fill = solidFill(ZEBRA);
        if (col.key === "shiftStart" || col.key === "punchIn") cell.numFmt = "hh:mm AM/PM";
        if (col.key === "grace") cell.numFmt = "0";
        if (col.key === "minutesLate") {
          cell.numFmt = '0" min"';
          const level = severityOf(entry.minutesLate);
          if (level) {
            cell.fill = solidFill(argb(SEVERITY_COLORS[level].bg));
            cell.font = { size: 10, bold: true, color: { argb: argb(SEVERITY_COLORS[level].text) } };
          }
        }
      });
      const unit = row.getCell(EXCEL_UNIT_COLUMN);
      unit.value = group.label;
      unit.alignment = { horizontal: "center", vertical: "middle" };
      unit.font = { size: 10, bold: true, color: { argb: argb(UNIT_BAND_COLORS.text) } };
      unit.border = { bottom: { style: "thin", color: { argb: RULE } } };
      if (i % 2 === 1) unit.fill = solidFill(ZEBRA);
      rowIdx += 1;
    });
  }
  const lastRow = rowIdx - 1;

  if (lastRow > HEADER_ROW) {
    ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastRow, column: cols } };
  }
  return wb;
}

export const lateExcelName = (date: string) => `${lateFileStem(date)}.xlsx`;

/** Builds the workbook and downloads it. */
export async function downloadLateExcel(input: LateReportInput): Promise<void> {
  await downloadWorkbook(buildLateWorkbook(input), lateExcelName(input.date));
}
