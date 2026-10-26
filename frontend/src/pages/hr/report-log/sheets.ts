// What the paper-style STAFF LEAVE LIST contains: the title and its colour, the columns and the unit blocks. The on-screen
// export sheet (ReportSheet.tsx, which the PDF and the image are taken from) and the Excel file (excel.ts) are both built from
// the same SheetSpec, so a column or a colour can never differ between them. (The Daily Late Report is not a paper sheet: it
// has its own modern table and exports, see late.ts.)

import { dash, groupByUnit, informedColor, informedLabel, leaveTitle, type UnitBlock } from "./logic";
import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";

/** One cell of a sheet. `fill` is a #rrggbb background (none = white). */
export type SheetCell = { text: string; fill?: string; bold?: boolean };

export type SheetColumn = {
  key: string;
  header: string;
  align: "left" | "center";
  /** Width on the picture (px) and in Excel (characters). */
  px: number;
  chars: number;
  cell: (row: ReportLogDailyRow, indexInBlock: number) => SheetCell;
};

export type SheetSpec = {
  title: string;
  /** The title bar's colour, #rrggbb. */
  titleFill: string;
  columns: SheetColumn[];
  blocks: UnitBlock[];
};

/** The salmon of the title bar on the paper list. */
export const TITLE_FILL = "#da9694";

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

/** The Daily Leave Report: these rows (already the absent ones the user picked), in unit blocks. */
export const leaveSpec = (date: string, rows: ReportLogDailyRow[]): SheetSpec => ({
  title: leaveTitle(date),
  titleFill: TITLE_FILL,
  columns: LEAVE_COLUMNS,
  blocks: groupByUnit(rows),
});

/** The width of the table on a picture: the unit gutter plus the columns. */
export const GUTTER_PX = 46;
export const sheetWidth = (columns: SheetColumn[]) => GUTTER_PX + columns.reduce((sum, c) => sum + c.px, 0);
