import type ExcelJS from "exceljs";
import type { jsPDF } from "jspdf";
import { pdfSafe } from "@/components/payroll/statement/export-statement-pdf";
import type { AttendanceDailyRecord, MonthlyAttendanceRow } from "@/lib/api-client/custom-hooks";
import {
  addMergedTextRow,
  addTitleBlock,
  allBorders,
  downloadWorkbook,
  fileSafe,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";
import { BOARD_META, STATUS_LABEL, boardStateOf, leaveFacts, punchText, shortDate } from "./logic";

// The Staff / Production Attendance exports, built in the browser from what the page already shows (the day) or from
// GET /api/attendance/monthly-summary (the month): an Excel workbook through the shared lazy ExcelJS (newWorkbook) and an A4
// landscape PDF drawn with jsPDF, as the other HR exports are. The page loads this module only when an export is asked for,
// so neither library is part of the page until then. Nothing here changes data.

export type ExportCompany = { company: string; branchLabel: string; logoDataUrl?: string | null };

export type DayExportInput = ExportCompany & {
  date: string;
  view: "staff" | "production";
  /** The rows to export (the list as filtered). */
  rows: AttendanceDailyRecord[];
  /** What narrows the list ("Status: Absent, Department: Cutting"); "" for everything. */
  scope: string;
  /** The size of the whole day's list, to say "34 of 140". */
  totalRows: number;
  now: Date;
};

export type MonthExportInput = ExportCompany & {
  year: number;
  month: number;
  view: "staff" | "production";
  asOf: string;
  rows: MonthlyAttendanceRow[];
  now: Date;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const viewTitle = (view: "staff" | "production") => (view === "staff" ? "Staff" : "Production");

export const dayTitle = (view: "staff" | "production", date: string) =>
  `${viewTitle(view)} attendance - ${shortDate(date)} ${date.slice(0, 4)}`;

export const monthTitle = (view: "staff" | "production", year: number, month: number) =>
  `${viewTitle(view)} monthly attendance - ${MONTHS[month - 1]} ${year}`;

export const dayFileStem = (view: "staff" | "production", date: string) =>
  fileSafe(`${viewTitle(view)}_Attendance_${date}`);

export const monthFileStem = (view: "staff" | "production", year: number, month: number) =>
  fileSafe(`${viewTitle(view)}_Monthly_Attendance_${year}-${String(month).padStart(2, "0")}`);

function stamp(now: Date): string {
  return now.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── the day ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DAY_HEADERS = [
  "#",
  "Emp code",
  "Employee",
  "Department",
  "Designation",
  "Status",
  "Leave / CL / On-Duty",
  "First in",
  "Last out",
  "Punches",
  "Every punch (time, source)",
  "Late / early",
  "Shifts",
];

function lateEarly(r: AttendanceDailyRecord): string {
  return [r.isLate ? "Late" : "", r.isEarlyOut ? "Early out" : ""].filter(Boolean).join(", ");
}

function statusText(r: AttendanceDailyRecord): string {
  const card = BOARD_META[boardStateOf(r)].label;
  const own = STATUS_LABEL[r.status];
  // the server's own word when it says more ("Manual" = present by hand)
  return own && own !== card && r.status === "manual" ? `${card} (by hand)` : card;
}

/** One line per row, as the workbook and the PDF both print it. */
export function dayCells(r: AttendanceDailyRecord, i: number, date: string, punchSep = "\n"): (string | number)[] {
  const punches = r.punches ?? [];
  return [
    i + 1,
    r.employeeCode,
    r.employeeName,
    r.department ?? "",
    r.designation ?? "",
    statusText(r),
    leaveFacts(r).join("; "),
    r.firstPunch ?? "",
    r.lastPunch ? `${r.lastPunch}${r.lastPunchNextDay ? " (+1)" : ""}` : "",
    punches.filter((p) => p.counted !== false).length,
    punches.map((p) => punchText(p, date)).join(punchSep),
    lateEarly(r),
    typeof r.shiftsEarned === "number" ? r.shiftsEarned.toFixed(2) : "",
  ];
}

export async function buildDayWorkbook(input: DayExportInput): Promise<ExcelJS.Workbook> {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet(`Attendance ${input.date}`);
  ws.columns = [5, 11, 24, 18, 18, 14, 30, 9, 10, 9, 42, 14, 8].map((width) => ({ width }));
  let last = addTitleBlock(wb, ws, {
    totalCols: DAY_HEADERS.length,
    company: input.company,
    branchLabel: input.branchLabel,
    title: dayTitle(input.view, input.date),
    titleFill: "FFDCE8F5",
    logoDataUrl: input.logoDataUrl,
  });
  last += 1;
  addMergedTextRow(
    ws,
    last,
    DAY_HEADERS.length,
    `${input.rows.length} of ${input.totalRows} employees${input.scope ? ` - ${input.scope}` : ""}. Generated ${stamp(input.now)}.`,
    { size: 9, bold: false, color: "FF64748B" },
  );
  const head = ws.getRow(last + 1);
  DAY_HEADERS.forEach((h, c) => {
    const cell = head.getCell(c + 1);
    cell.value = h;
    styleHeaderCell(cell, { fill: "FF1E3A5F", border: allBorders("thin", "FFBFC9D6") });
  });
  head.height = 30;
  ws.views = [{ state: "frozen", ySplit: last + 1 }];
  input.rows.forEach((r, i) => {
    const row = ws.getRow(last + 2 + i);
    const values = dayCells(r, i, input.date);
    values.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      cell.value = v;
      cell.alignment = {
        vertical: "top",
        wrapText: true,
        horizontal: c === 0 || c === 7 || c === 8 || c === 9 || c === 12 ? "center" : "left",
      };
      cell.border = allBorders("hair", "FFD0D7E2");
    });
    const status = row.getCell(6);
    status.fill = solidFill(BOARD_META[boardStateOf(r)].argbWash);
    status.font = { bold: true };
  });
  return wb;
}

// ── the month ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function monthHeaders(view: "staff" | "production"): string[] {
  return [
    "#",
    "Emp code",
    "Employee",
    "Department",
    "Working days",
    "Present",
    "Half day",
    "Absent",
    "On leave",
    "CL",
    "On duty",
    "Late",
    "Early out",
    view === "production" ? "Shifts" : "Effective days",
  ];
}

const num = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 100) / 100);

export function monthCells(r: MonthlyAttendanceRow, i: number, view: "staff" | "production"): (string | number)[] {
  return [
    i + 1,
    r.employeeCode,
    r.employeeName,
    r.department ?? "",
    r.workingDays,
    r.present,
    r.halfDay,
    r.absent,
    r.onLeave,
    num(r.cl),
    r.onDuty,
    r.late,
    r.earlyOut,
    num(view === "production" ? r.totalShifts : r.effectiveDays),
  ];
}

export function monthTotals(rows: MonthlyAttendanceRow[], view: "staff" | "production"): (string | number)[] {
  const sum = (pick: (r: MonthlyAttendanceRow) => number) => num(rows.reduce((a, r) => a + pick(r), 0));
  return [
    "",
    "",
    `Total (${rows.length})`,
    "",
    sum((r) => r.workingDays),
    sum((r) => r.present),
    sum((r) => r.halfDay),
    sum((r) => r.absent),
    sum((r) => r.onLeave),
    sum((r) => r.cl),
    sum((r) => r.onDuty),
    sum((r) => r.late),
    sum((r) => r.earlyOut),
    sum((r) => (view === "production" ? r.totalShifts : r.effectiveDays)),
  ];
}

export const MONTH_NOTES = [
  "Present, half day, absent, on leave and late are the attendance engine's day verdicts (the same ones payroll and the Report Log read).",
  "CL = approved casual leave days (a half day counts 0.5) and On duty = days an On-Duty request HR approved covers; both are also counted in Present when the day was paid as present.",
];

export async function buildMonthWorkbook(input: MonthExportInput): Promise<ExcelJS.Workbook> {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet(`${MONTHS[input.month - 1].slice(0, 3)} ${input.year}`);
  const headers = monthHeaders(input.view);
  ws.columns = [5, 11, 26, 20, 10, 9, 9, 9, 9, 7, 9, 7, 9, 11].map((width) => ({ width }));
  let last = addTitleBlock(wb, ws, {
    totalCols: headers.length,
    company: input.company,
    branchLabel: input.branchLabel,
    title: monthTitle(input.view, input.year, input.month),
    titleFill: "FFDCE8F5",
    logoDataUrl: input.logoDataUrl,
  });
  last += 1;
  addMergedTextRow(
    ws,
    last,
    headers.length,
    `${input.rows.length} employees, counted up to ${input.asOf}. Generated ${stamp(input.now)}.`,
    { size: 9, bold: false, color: "FF64748B" },
  );
  const head = ws.getRow(last + 1);
  headers.forEach((h, c) => {
    const cell = head.getCell(c + 1);
    cell.value = h;
    styleHeaderCell(cell, { fill: "FF1E3A5F", border: allBorders("thin", "FFBFC9D6") });
  });
  head.height = 30;
  ws.views = [{ state: "frozen", ySplit: last + 1 }];
  const lines = [...input.rows.map((r, i) => monthCells(r, i, input.view)), monthTotals(input.rows, input.view)];
  lines.forEach((values, i) => {
    const row = ws.getRow(last + 2 + i);
    const total = i === lines.length - 1;
    values.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      cell.value = v;
      cell.alignment = { vertical: "middle", horizontal: c >= 4 || c === 0 ? "center" : "left" };
      cell.border = allBorders("hair", "FFD0D7E2");
      if (total) {
        cell.font = { bold: true };
        cell.fill = solidFill("FFE8EEF6");
      } else if (i % 2 === 1) {
        cell.fill = solidFill("FFF7F9FC");
      }
    });
  });
  const notesAt = last + 2 + lines.length + 1;
  MONTH_NOTES.forEach((note, k) => {
    ws.mergeCells(notesAt + k, 1, notesAt + k, headers.length);
    const cell = ws.getCell(notesAt + k, 1);
    cell.value = note;
    cell.font = { size: 9, color: { argb: "FF64748B" } };
    cell.alignment = { wrapText: true, vertical: "top" };
    ws.getRow(notesAt + k).height = 26;
  });
  return wb;
}

// ── PDF: one A4 landscape table, rows as tall as their text ─────────────────────────────────────────────────────────

type Rgb = [number, number, number];
const INK: Rgb = [15, 23, 42];
const GREY: Rgb = [100, 116, 139];
const RULE: Rgb = [226, 232, 240];
const HEAD: Rgb = [30, 41, 59];
const ZEBRA: Rgb = [248, 250, 252];
const WHITE: Rgb = [255, 255, 255];
const ACCENT: Rgb = [0, 100, 150];
const TOTAL_BG: Rgb = [232, 238, 246];

export type PdfColumn = { header: string; mm: number; align: "left" | "center" };
export type PdfRow = { cells: string[]; total?: boolean; statusFill?: Rgb; statusCol?: number };

const PAGE = { width: 297, height: 210, margin: 10, top: 34, nextTop: 20, bottom: 196, footerY: 203 } as const;
const PT = 0.3528; // mm per point
const hexRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
/** The status colour as a light wash for the PDF's status cell. */
const washOf = (hex: string): Rgb => hexRgb(hex).map((v) => Math.round(v + (255 - v) * 0.82)) as Rgb;

async function renderTablePdf(opts: {
  title: string;
  subtitle: string;
  company: ExportCompany;
  columns: PdfColumn[];
  rows: PdfRow[];
  notes?: string[];
  now: Date;
}): Promise<jsPDF> {
  const { jsPDF: JsPdf } = await import("jspdf");
  const doc = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4" });
  const { width: pageW, margin } = PAGE;
  const tableW = opts.columns.reduce((a, c) => a + c.mm, 0);
  const xs = opts.columns.map((_, i) => margin + opts.columns.slice(0, i).reduce((a, c) => a + c.mm, 0));
  const bodyPt = 7.2;
  const lineH = bodyPt * PT * 1.25;
  const padY = 1.6;
  doc.setProperties({ title: pdfSafe(opts.title), author: "UKTextiles HRMS", creator: "UKTextiles HRMS" });

  const font = (bold: boolean, pt: number) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(pt);
  };
  const ink = (c: Rgb) => doc.setTextColor(c[0], c[1], c[2]);
  const fill = (c: Rgb) => doc.setFillColor(c[0], c[1], c[2]);

  const logo = opts.company.logoDataUrl;
  const logoFormat = /^data:image\/(png|jpe?g);base64,/i.exec(logo ?? "");
  const drawFirstHead = () => {
    let textX = margin;
    if (logo && logoFormat) {
      try {
        doc.addImage(logo, logoFormat[1].toLowerCase().startsWith("jp") ? "JPEG" : "PNG", margin, 9, 13, 13);
        textX = margin + 16;
      } catch {
        // a broken logo never stops the report
      }
    }
    ink(INK);
    font(true, 13);
    doc.text(pdfSafe(opts.company.company), textX, 15);
    font(false, 8.5);
    ink(GREY);
    doc.text(pdfSafe(opts.company.branchLabel), textX, 20.5);
    ink(ACCENT);
    font(true, 13);
    doc.text(pdfSafe(opts.title), pageW - margin, 15, { align: "right" });
    ink(GREY);
    font(false, 8.5);
    doc.text(pdfSafe(opts.subtitle), pageW - margin, 20.5, { align: "right" });
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.4);
    doc.line(margin, 25, pageW - margin, 25);
  };
  const drawNextHead = () => {
    ink(ACCENT);
    font(true, 9.5);
    doc.text(pdfSafe(opts.title), margin, 12);
    ink(GREY);
    font(false, 8);
    doc.text(pdfSafe(opts.company.company), pageW - margin, 12, { align: "right" });
  };
  const headH = 9;
  const drawHeads = (top: number) => {
    fill(HEAD);
    doc.rect(margin, top, tableW, headH, "F");
    ink(WHITE);
    font(true, 7.2);
    opts.columns.forEach((col, i) => {
      const lines = (doc.splitTextToSize(pdfSafe(col.header), col.mm - 2.4) as string[]).slice(0, 2);
      const first = top + headH / 2 - ((lines.length - 1) * 3) / 2 + 0.9;
      lines.forEach((line, k) => {
        if (col.align === "center") doc.text(line, xs[i] + col.mm / 2, first + k * 3, { align: "center" });
        else doc.text(line, xs[i] + 1.4, first + k * 3);
      });
    });
    return top + headH;
  };

  // lay every row out first (its lines per cell), so the pages can be cut where a row ends
  font(false, bodyPt);
  const laid = opts.rows.map((row) => {
    const cells = row.cells.map((text, i) =>
      (doc.splitTextToSize(pdfSafe(text), opts.columns[i].mm - 2.4) as string[]).slice(0, 14),
    );
    const lines = Math.max(1, ...cells.map((c) => c.length));
    return { row, cells, height: lines * lineH + padY * 2 };
  });

  const pages: (typeof laid)[] = [];
  let current: typeof laid = [];
  let room = PAGE.bottom - PAGE.top - headH;
  for (const item of laid) {
    if (current.length > 0 && item.height > room) {
      pages.push(current);
      current = [];
      room = PAGE.bottom - PAGE.nextTop - headH;
    }
    current.push(item);
    room -= item.height;
  }
  pages.push(current);

  pages.forEach((page, p) => {
    if (p > 0) doc.addPage();
    if (p === 0) drawFirstHead();
    else drawNextHead();
    let y = drawHeads(p === 0 ? PAGE.top : PAGE.nextTop);
    page.forEach((item, k) => {
      const { row, cells, height } = item;
      if (row.total) {
        fill(TOTAL_BG);
        doc.rect(margin, y, tableW, height, "F");
      } else if (k % 2 === 1) {
        fill(ZEBRA);
        doc.rect(margin, y, tableW, height, "F");
      }
      if (row.statusFill && row.statusCol !== undefined) {
        fill(row.statusFill);
        doc.rect(xs[row.statusCol], y, opts.columns[row.statusCol].mm, height, "F");
      }
      font(!!row.total, bodyPt);
      ink(INK);
      cells.forEach((lines, i) => {
        const col = opts.columns[i];
        lines.forEach((line, n) => {
          const by = y + padY + lineH * n + bodyPt * PT * 0.95;
          if (col.align === "center") doc.text(line, xs[i] + col.mm / 2, by, { align: "center" });
          else doc.text(line, xs[i] + 1.4, by);
        });
      });
      doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
      doc.setLineWidth(0.15);
      doc.line(margin, y + height, margin + tableW, y + height);
      y += height;
    });
    if (p === pages.length - 1 && opts.notes?.length) {
      font(false, 7);
      ink(GREY);
      let ny = y + 5;
      for (const note of opts.notes) {
        const lines = doc.splitTextToSize(pdfSafe(note), tableW) as string[];
        if (ny + lines.length * 3.2 > PAGE.bottom + 4) break;
        doc.text(lines, margin, ny);
        ny += lines.length * 3.2 + 1;
      }
    }
    font(false, 7);
    ink(GREY);
    doc.text(`Generated ${pdfSafe(stamp(opts.now))} - UKTextiles HRMS`, margin, PAGE.footerY);
    doc.text(`Page ${p + 1} of ${pages.length}`, pageW - margin, PAGE.footerY, { align: "right" });
  });
  return doc;
}

export const DAY_PDF_COLUMNS: PdfColumn[] = [
  { header: "#", mm: 8, align: "center" },
  { header: "Code", mm: 15, align: "left" },
  { header: "Employee", mm: 38, align: "left" },
  { header: "Department", mm: 28, align: "left" },
  { header: "Status", mm: 20, align: "left" },
  { header: "Leave / CL / On-Duty", mm: 40, align: "left" },
  { header: "In", mm: 12, align: "center" },
  { header: "Out", mm: 14, align: "center" },
  { header: "Every punch (time, source)", mm: 70, align: "left" },
  { header: "Late / early", mm: 16, align: "left" },
  { header: "Shifts", mm: 16, align: "center" },
];

export async function buildDayPdf(input: DayExportInput): Promise<jsPDF> {
  const rows: PdfRow[] = input.rows.map((r, i) => {
    const c = dayCells(r, i, input.date, "; ");
    return {
      cells: [c[0], c[1], c[2], c[3], c[5], c[6], c[7], c[8], c[10], c[11], c[12]].map(String),
      statusFill: washOf(BOARD_META[boardStateOf(r)].hex),
      statusCol: 4,
    };
  });
  return renderTablePdf({
    title: dayTitle(input.view, input.date),
    subtitle: `${input.rows.length} of ${input.totalRows} employees${input.scope ? ` - ${input.scope}` : ""}`,
    company: input,
    columns: DAY_PDF_COLUMNS,
    rows,
    notes: [
      "Every punch is listed with its source. 'waiting for HR' = an On-Duty punch not verified yet; 'previous night' = the punch that closed the night shift before; 'double tap' = a second tap the attendance engine ignores. These are not counted on this day.",
    ],
    now: input.now,
  });
}

export function monthPdfColumns(view: "staff" | "production"): PdfColumn[] {
  const headers = monthHeaders(view);
  const mm = [9, 18, 52, 40, 16, 15, 15, 15, 15, 13, 15, 13, 15, 26];
  return headers.map((header, i) => ({ header, mm: mm[i], align: i === 2 || i === 3 || i === 1 ? "left" : "center" }));
}

export async function buildMonthPdf(input: MonthExportInput): Promise<jsPDF> {
  const rows: PdfRow[] = [
    ...input.rows.map((r, i) => ({ cells: monthCells(r, i, input.view).map(String) })),
    { cells: monthTotals(input.rows, input.view).map(String), total: true },
  ];
  return renderTablePdf({
    title: monthTitle(input.view, input.year, input.month),
    subtitle: `${input.rows.length} employees, counted up to ${input.asOf}`,
    company: input,
    columns: monthPdfColumns(input.view),
    rows,
    notes: MONTH_NOTES,
    now: input.now,
  });
}

// ── the downloads ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function downloadDayExcel(input: DayExportInput) {
  await downloadWorkbook(await buildDayWorkbook(input), `${dayFileStem(input.view, input.date)}.xlsx`);
}

export async function downloadDayPdf(input: DayExportInput) {
  (await buildDayPdf(input)).save(`${dayFileStem(input.view, input.date)}.pdf`);
}

export async function downloadMonthExcel(input: MonthExportInput) {
  await downloadWorkbook(await buildMonthWorkbook(input), `${monthFileStem(input.view, input.year, input.month)}.xlsx`);
}

export async function downloadMonthPdf(input: MonthExportInput) {
  (await buildMonthPdf(input)).save(`${monthFileStem(input.view, input.year, input.month)}.pdf`);
}
