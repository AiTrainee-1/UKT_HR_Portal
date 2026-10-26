// The Daily Late Report as an Excel file: the company block (name, branch, logo) like every other export, the report title, the
// date and the moment it was made, then the seven columns with a frozen header and filters, minutes as real numbers and times as
// real times, and a colour step per severity. Nothing else: no summary line, no explanation, no totals row (the page has those).
// Built from the same model as the table on the page (late.ts).

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
  generatedStamp,
  lateFileStem,
  severityOf,
  type LateEntry,
} from "./late";
import { minutesOf } from "./logic";

export type LateReportInput = {
  /** The report's date, YYYY-MM-DD. */
  date: string;
  /** The rows in the order they are shown. */
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

export function buildLateWorkbook(input: LateReportInput): Workbook {
  const now = input.now ?? new Date();
  const cols = LATE_COLUMNS.length;
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
  ws.columns = LATE_COLUMNS.map((c) => ({ width: c.chars }));

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
  LATE_COLUMNS.forEach((col, i) => {
    const cell = head.getCell(i + 1);
    cell.value = col.header;
    styleHeaderCell(cell, { fill: HEAD_FILL, border: allBorders("thin", HEAD_FILL) });
    cell.alignment = { horizontal: col.align, vertical: "middle", wrapText: true };
  });

  let rowIdx = HEADER_ROW + 1;
  const firstData = rowIdx;
  input.entries.forEach((entry, i) => {
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
    rowIdx += 1;
  });
  const lastData = rowIdx - 1;

  if (lastData >= firstData) {
    ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastData, column: cols } };
  }
  return wb;
}

export const lateExcelName = (date: string) => `${lateFileStem(date)}.xlsx`;

/** Builds the workbook and downloads it. */
export async function downloadLateExcel(input: LateReportInput): Promise<void> {
  await downloadWorkbook(buildLateWorkbook(input), lateExcelName(input.date));
}
