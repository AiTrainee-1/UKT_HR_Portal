// What the two paper-style lists contain: the title and its colour, the columns and the unit blocks. The on-screen sheet
// (ReportSheet.tsx, also what the PDF and the image are taken from) and the Excel file (excel.ts) are both built from the same
// SheetSpec, so a column or a colour can never differ between them.

import {
  dash,
  groupByUnit,
  informedColor,
  informedLabel,
  formatClock12,
  lateTitle,
  leaveTitle,
  sortLate,
  type UnitBlock,
} from "./logic";
import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";

/** One cell of a sheet. `fill` is a #rrggbb background (none = white). */
export type SheetCell = { text: string; fill?: string; bold?: boolean };

export type SheetColumn = {
  key: string;
  header: string;
  /** Header text colour (the late list's "Late Hours" is red). */
  headerColor?: string;
  align: "left" | "center";
  /** Width on the picture (px) and in Excel (characters). */
  px: number;
  chars: number;
  cell: (row: ReportLogDailyRow, indexInBlock: number) => SheetCell;
};

export type SheetSpec = {
  kind: "leave" | "late";
  title: string;
  /** The title bar's colour, #rrggbb. */
  titleFill: string;
  columns: SheetColumn[];
  blocks: UnitBlock[];
};

/** The salmon of the title bars on the paper lists. */
export const TITLE_FILL = "#da9694";
export const LATE_FILL = "#ffff00";
export const LATE_HEAD_COLOR = "#ff0000";

const serial = (_row: ReportLogDailyRow, i: number): SheetCell => ({ text: String(i + 1) });
const code = (row: ReportLogDailyRow): SheetCell => ({ text: row.employeeCode });
const name = (row: ReportLogDailyRow): SheetCell => ({ text: row.employeeName });

export const LEAVE_COLUMNS: SheetColumn[] = [
  { key: "sno", header: "S.No", align: "center", px: 48, chars: 7, cell: serial },
  { key: "code", header: "Ticket No", align: "left", px: 84, chars: 12, cell: code },
  { key: "name", header: "Employee Name", align: "left", px: 190, chars: 28, cell: name },
  {
    key: "department",
    header: "Department",
    align: "left",
    px: 130,
    chars: 18,
    cell: (r) => ({ text: dash(r.department) }),
  },
  {
    key: "designation",
    header: "Designation",
    align: "left",
    px: 220,
    chars: 30,
    cell: (r) => ({ text: dash(r.designation) }),
  },
  {
    key: "remarks",
    header: "Remarks",
    align: "center",
    px: 110,
    chars: 15,
    cell: (r) => ({ text: informedLabel(r), fill: informedColor(r), bold: true }),
  },
];

export const LATE_COLUMNS: SheetColumn[] = [
  { key: "sno", header: "S.No", align: "center", px: 48, chars: 7, cell: serial },
  { key: "code", header: "Ticket No", align: "left", px: 84, chars: 12, cell: code },
  { key: "name", header: "Employee Name", align: "left", px: 190, chars: 28, cell: name },
  {
    key: "designation",
    header: "Designation",
    align: "left",
    px: 190,
    chars: 28,
    cell: (r) => ({ text: dash(r.designation) }),
  },
  {
    key: "lateHours",
    header: "Late Hours",
    headerColor: LATE_HEAD_COLOR,
    align: "center",
    px: 96,
    chars: 13,
    // the first punch of the day, in the factory's own clock ("09:06 AM")
    cell: (r) => ({ text: formatClock12(r.firstPunch) || "—", fill: LATE_FILL }),
  },
];

/** The Daily Leave Report: these rows (already the absent ones the user picked), in unit blocks. */
export const leaveSpec = (date: string, rows: ReportLogDailyRow[]): SheetSpec => ({
  kind: "leave",
  title: leaveTitle(date),
  titleFill: TITLE_FILL,
  columns: LEAVE_COLUMNS,
  blocks: groupByUnit(rows),
});

/** The Daily Late Report: these rows (already only the late ones), earliest first, in unit blocks. */
export const lateSpec = (date: string, rows: ReportLogDailyRow[]): SheetSpec => ({
  kind: "late",
  title: lateTitle(date),
  titleFill: TITLE_FILL,
  columns: LATE_COLUMNS,
  blocks: groupByUnit(sortLate(rows)),
});

/** The width of the table on a picture: the unit gutter plus the columns. */
export const GUTTER_PX = 46;
export const sheetWidth = (columns: SheetColumn[]) => GUTTER_PX + columns.reduce((sum, c) => sum + c.px, 0);
