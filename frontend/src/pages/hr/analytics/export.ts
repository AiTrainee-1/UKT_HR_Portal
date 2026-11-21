import type ExcelJS from "exceljs";
import type { jsPDF } from "jspdf";
import { pdfSafe } from "@/components/payroll/statement/export-statement-pdf";
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
import type { ExportCompany } from "../attendance/export";
import {
  LEVEL_META,
  TAB_LABEL,
  dateShort,
  dateTimeText,
  flagChips,
  hoursText,
  inLevel,
  LEVEL_FILTERS,
  num1,
  patternExtras,
  patternNote,
  pct,
  shortLabel,
  statusLabel,
  thresholdText,
  type LevelFilter,
} from "./logic";
import type {
  AnalyticsRecord,
  AnalyticsSummary,
  AnalyticsTab,
  CategoryDetail,
  CategoryMeta,
  EmployeeDetail,
  EmployeeHit,
  HodRow,
} from "./types";

// The HR Analytics exports (owner 2026-11-21). The page: an Excel workbook (Summary = employees x category counts with
// the level, one sheet per category with every employee's records, HODs on Staff) and an A4 landscape PDF (the figures,
// the attention list, then each category's top list). One employee: their own workbook and PDF. Every filter of the page
// is respected: the server already answered for them, and the list's level choice narrows the Summary and the PDF list.
// The rows are built by plain functions (tested); the page loads this module only when an export is asked for.

export type ExportCell = string | number;
export type ExportColumn = { header: string; width: number; numeric?: boolean };
export type ExportSheet = { name: string; columns: ExportColumn[]; rows: ExportCell[][]; note?: string };

export type PageExportInput = ExportCompany & {
  summary: AnalyticsSummary;
  /** The filters in words (filterWords): "Department: IT". */
  filterText: string[];
  levelFilter: LevelFilter;
  /** Every category's drill-down for the same filters (GET .../category/<key>). */
  categories: CategoryDetail[];
  now: Date;
};

export type EmployeeExportInput = ExportCompany & { detail: EmployeeDetail; now: Date };

// ── names ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const pageTitle = (tab: AnalyticsTab) => `HR Analytics - ${TAB_LABEL[tab]}`;

/** "1 Nov - 21 Nov 2026 · Department: IT · High only". */
export function pageSubtitle(input: Pick<PageExportInput, "summary" | "filterText" | "levelFilter">): string {
  const level =
    input.levelFilter === "all" ? null : (LEVEL_FILTERS.find((l) => l.value === input.levelFilter)?.label ?? null);
  return [input.summary.period.label, ...input.filterText, level && `List: ${level}`].filter(Boolean).join(" · ");
}

/** "HR_Analytics_Staff_1_Nov_21_Nov_2026_2026-11-21.xlsx". */
export const pageFileName = (summary: AnalyticsSummary, ext: "xlsx" | "pdf") =>
  `${fileSafe(`HR Analytics ${TAB_LABEL[summary.type]} ${summary.period.label}`)}_${todayStamp()}.${ext}`;

export const employeeFileName = (detail: EmployeeDetail, ext: "xlsx" | "pdf") =>
  `${fileSafe(`HR Analytics ${detail.employee.code} ${detail.employee.name} ${detail.period.label}`)}_${todayStamp()}.${ext}`;

/** A sheet name Excel accepts (31 characters, none of []:*?/\) and not used yet in the workbook. */
export function sheetName(name: string, used: Set<string>): string {
  const base =
    name
      .replace(/[[\]:*?/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 31) || "Sheet";
  let out = base;
  for (let n = 2; used.has(out.toLowerCase()); n += 1) out = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(out.toLowerCase());
  return out;
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const levelWord = (l: string) => LEVEL_META[l as keyof typeof LEVEL_META]?.label ?? l;
const recordCells = (r: AnalyticsRecord): ExportCell[] => [
  r.date,
  r.endDate ?? "",
  r.title,
  r.detail ?? "",
  r.reason ?? "",
  statusLabel(r.status),
  r.by ?? "",
  dateTimeText(r.at),
];
const RECORD_COLUMNS: ExportColumn[] = [
  { header: "Date", width: 12 },
  { header: "Until", width: 12 },
  { header: "What happened", width: 34 },
  { header: "Detail", width: 30 },
  { header: "Reason", width: 30 },
  { header: "Status", width: 14 },
  { header: "By", width: 18 },
  { header: "At", width: 20 },
];

/** The employees the Summary sheet and the PDF list carry: the server's list, narrowed by the list's level choice. */
export const exportEmployees = (summary: AnalyticsSummary, levelFilter: LevelFilter): EmployeeHit[] =>
  summary.employees.filter((e) => inLevel(e, levelFilter));

export function summarySheet(summary: AnalyticsSummary, levelFilter: LevelFilter): ExportSheet {
  const cats = summary.categories;
  return {
    name: "Summary",
    note: `Counts per category for the period; a category's limit for the period is in brackets. Level: High = twice a limit or over in 3+ categories, Attention = at or over a limit, Watch = under every limit.`,
    columns: [
      { header: "#", width: 5, numeric: true },
      { header: "Code", width: 10 },
      { header: "Name", width: 24 },
      { header: "Department", width: 18 },
      { header: "Designation", width: 22 },
      { header: "Level", width: 11 },
      { header: "Score", width: 8, numeric: true },
      ...cats.map((c) => ({
        header: `${shortLabel(c.label)} (${c.informational ? "info" : num1(c.threshold)})`,
        width: 13,
        numeric: true,
      })),
      { header: "Over the limit in", width: 34 },
      { header: "Last record", width: 12 },
    ],
    rows: exportEmployees(summary, levelFilter).map((e, i) => [
      i + 1,
      e.code,
      e.name,
      e.department ?? "",
      e.designation ?? "",
      levelWord(e.level),
      e.score,
      ...cats.map((c) => e.counts[c.key] ?? 0),
      e.flags.map((k) => shortLabel(cats.find((c) => c.key === k)?.label ?? k)).join(", "),
      e.lastDate ?? "",
    ]),
  };
}

/** One row per record, the employee repeated on each (so the sheet sorts and filters in Excel), newest first. */
export function categorySheet(detail: CategoryDetail): Omit<ExportSheet, "name"> {
  const c = detail.category;
  return {
    note: `${c.label}: ${thresholdText(c)}. ${c.description}`,
    columns: [
      { header: "Code", width: 10 },
      { header: "Name", width: 22 },
      { header: "Department", width: 16 },
      { header: `Count (${c.unit})`, width: 10, numeric: true },
      { header: "Limit", width: 8 },
      { header: "Over the limit", width: 10 },
      { header: "Level", width: 10 },
      { header: "Pattern", width: 22 },
      ...RECORD_COLUMNS,
    ],
    rows: detail.employees.flatMap((e) => {
      const head: ExportCell[] = [
        e.code,
        e.name,
        e.department ?? "",
        e.count,
        c.informational ? "info" : num1(c.threshold),
        c.informational ? "" : e.flagged ? "Yes" : "No",
        levelWord(e.level),
        patternNote(e.pattern) ?? "",
      ];
      const records = [...e.records].sort((a, b) => b.date.localeCompare(a.date));
      return records.length
        ? records.map((r) => [...head, ...recordCells(r)])
        : [[...head, ...recordCells(EMPTY_RECORD)]];
    }),
  };
}

const EMPTY_RECORD: AnalyticsRecord = {
  date: "",
  endDate: null,
  title: "",
  detail: null,
  reason: null,
  status: null,
  by: null,
  at: null,
};

export function hodSheet(hods: HodRow[]): ExportSheet {
  return {
    name: "HODs",
    note: "Requests each Department Head decided in the period, how fast, and what is waiting with them now.",
    columns: [
      { header: "Code", width: 10 },
      { header: "Department Head", width: 24 },
      { header: "Department", width: 18 },
      { header: "Decided", width: 10, numeric: true },
      { header: "Rejected", width: 10, numeric: true },
      { header: "Rejection rate", width: 12 },
      { header: "Average response", width: 14 },
      { header: "Waiting now", width: 11, numeric: true },
      { header: "Waiting over 2 days", width: 12, numeric: true },
      { header: "Oldest waiting", width: 14 },
    ],
    rows: hods.map((h) => [
      h.code,
      h.name,
      h.department ?? "",
      h.decided,
      h.rejected,
      pct(h.rejectionRate),
      hoursText(h.avgResponseHours),
      h.waitingNow,
      h.waitingLong,
      hoursText(h.oldestWaitingHours),
    ]),
  };
}

/** Every sheet of the page's workbook, in order, with names Excel accepts. */
export function pageSheets(input: PageExportInput): ExportSheet[] {
  const used = new Set<string>();
  const sheets: ExportSheet[] = [];
  const summary = summarySheet(input.summary, input.levelFilter);
  sheets.push({ ...summary, name: sheetName(summary.name, used) });
  for (const meta of input.summary.categories) {
    const detail = input.categories.find((d) => d.category?.key === meta.key);
    if (!detail) continue;
    sheets.push({ ...categorySheet(detail), name: sheetName(shortLabel(meta.label), used) });
  }
  if (input.summary.type === "staff") {
    const hods = hodSheet(input.summary.hods);
    sheets.push({ ...hods, name: sheetName(hods.name, used) });
  }
  return sheets;
}

/** The person's own workbook: their counts against each limit with the patterns, and every record. */
export function employeeSheets(detail: EmployeeDetail): ExportSheet[] {
  const cats = Object.values(detail.categories);
  return [
    {
      name: "Summary",
      note: `Level ${levelWord(detail.level)}, score ${num1(detail.score)}.`,
      columns: [
        { header: "Category", width: 30 },
        { header: "Count", width: 9, numeric: true },
        { header: "Limit for the period", width: 14 },
        { header: "Over the limit", width: 10 },
        { header: "Busiest weekday", width: 14 },
        { header: "Longest run (days)", width: 12, numeric: true },
        { header: "Last date", width: 12 },
        { header: "Pattern", width: 26 },
        { header: "More", width: 34 },
      ],
      rows: cats.map((c) => {
        const days = Object.entries(c.pattern.byWeekday ?? {}).sort((a, b) => b[1] - a[1]);
        return [
          c.category.label,
          c.count,
          c.category.informational ? "info" : num1(c.category.threshold),
          c.category.informational ? "" : c.flagged ? "Yes" : "No",
          c.count > 0 && days[0]?.[1] ? `${days[0][0]} (${days[0][1]})` : "",
          c.pattern.longestStreak ?? 0,
          c.pattern.lastDate ?? "",
          patternNote(c.pattern) ?? "",
          patternExtras(c.pattern)
            .map((x) => `${x.label}: ${x.value}`)
            .join("; "),
        ];
      }),
    },
    {
      name: "Timeline",
      columns: [{ header: "Category", width: 24 }, ...RECORD_COLUMNS],
      rows: detail.timeline.map((r) => [
        detail.categories[r.category]?.category.label ?? r.category,
        ...recordCells(r),
      ]),
    },
  ];
}

// ── Excel ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const stamp = (now: Date) =>
  now.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

async function buildWorkbook(
  sheets: ExportSheet[],
  head: ExportCompany & { title: string; subtitle: string; now: Date },
): Promise<ExcelJS.Workbook> {
  const wb = await newWorkbook();
  for (const sheet of sheets) {
    const cols = Math.max(sheet.columns.length, 3);
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.columns.map((c) => ({ width: c.width }));
    let last = addTitleBlock(wb, ws, {
      totalCols: cols,
      company: head.company,
      branchLabel: head.branchLabel,
      title: `${head.title} - ${sheet.name}`,
      titleFill: "FFE0E7FF",
      logoDataUrl: head.logoDataUrl,
    });
    last += 1;
    addMergedTextRow(ws, last, cols, `${head.subtitle}. Generated ${stamp(head.now)}.`, {
      size: 9,
      bold: false,
      color: "FF64748B",
    });
    if (sheet.note) {
      last += 1;
      const cell = addMergedTextRow(ws, last, cols, sheet.note, { size: 9, bold: false, color: "FF475569" });
      cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      ws.getRow(last).height = 28;
    }
    const headRow = ws.getRow(last + 1);
    sheet.columns.forEach((c, i) => {
      const cell = headRow.getCell(i + 1);
      cell.value = c.header;
      styleHeaderCell(cell, { fill: "FF312E81", border: allBorders("thin", "FFC7D2FE") });
    });
    headRow.height = 30;
    ws.views = [{ state: "frozen", ySplit: last + 1 }];
    if (sheet.rows.length)
      ws.autoFilter = { from: { row: last + 1, column: 1 }, to: { row: last + 1, column: sheet.columns.length } };
    sheet.rows.forEach((values, r) => {
      const row = ws.getRow(last + 2 + r);
      values.forEach((v, i) => {
        const cell = row.getCell(i + 1);
        cell.value = v === "" ? null : v;
        cell.alignment = {
          vertical: "top",
          wrapText: true,
          horizontal: sheet.columns[i]?.numeric ? "right" : "left",
        };
        cell.border = allBorders("hair", "FFD0D7E2");
        if (r % 2 === 1) cell.fill = solidFill("FFF7F8FC");
      });
    });
    if (sheet.rows.length === 0)
      addMergedTextRow(ws, last + 2, cols, "Nothing in this period.", { size: 10, bold: false });
  }
  return wb;
}

export async function buildPageWorkbook(input: PageExportInput): Promise<ExcelJS.Workbook> {
  return buildWorkbook(pageSheets(input), {
    ...input,
    title: pageTitle(input.summary.type),
    subtitle: pageSubtitle(input),
  });
}

export async function buildEmployeeWorkbook(input: EmployeeExportInput): Promise<ExcelJS.Workbook> {
  const e = input.detail.employee;
  return buildWorkbook(employeeSheets(input.detail), {
    ...input,
    title: `${e.name} (${e.code})`,
    subtitle: [pageTitle(e.type), input.detail.period.label, e.department, e.designation].filter(Boolean).join(" · "),
  });
}

// ── PDF: A4 landscape, a heading, figure boxes and tables that break across pages with their heading row ───────────────

type Rgb = [number, number, number];
const INK: Rgb = [15, 23, 42];
const GREY: Rgb = [100, 116, 139];
const RULE: Rgb = [226, 232, 240];
const HEAD: Rgb = [49, 46, 129];
const ZEBRA: Rgb = [248, 250, 252];
const WHITE: Rgb = [255, 255, 255];
const ACCENT: Rgb = [67, 56, 202];
const PAGE = { w: 297, h: 210, margin: 10, top: 30, bottom: 196, footerY: 203 } as const;
const PT = 0.3528;

export type PdfColumn = { header: string; weight: number; align?: "left" | "center" };

/** A small writer over jsPDF: the cursor moves down, a table or a section starts a new page when it does not fit. */
async function pdfWriter(title: string, subtitle: string, company: ExportCompany) {
  const { jsPDF: JsPdf } = await import("jspdf");
  const doc = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4" });
  doc.setProperties({ title: pdfSafe(title), author: "UK Textiles HRMS", creator: "UK Textiles HRMS" });
  const width = PAGE.w - PAGE.margin * 2;
  const font = (bold: boolean, pt: number) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(pt);
  };
  const ink = (c: Rgb) => doc.setTextColor(c[0], c[1], c[2]);
  const fill = (c: Rgb) => doc.setFillColor(c[0], c[1], c[2]);
  let y: number = PAGE.top;

  const firstHead = () => {
    let x = PAGE.margin;
    const logo = company.logoDataUrl;
    const fmt = /^data:image\/(png|jpe?g);base64,/i.exec(logo ?? "");
    if (logo && fmt) {
      try {
        doc.addImage(logo, fmt[1].toLowerCase().startsWith("jp") ? "JPEG" : "PNG", PAGE.margin, 8, 12, 12);
        x += 15;
      } catch {
        // a broken logo never stops the report
      }
    }
    ink(INK);
    font(true, 13);
    doc.text(pdfSafe(company.company), x, 14);
    font(false, 8.5);
    ink(GREY);
    doc.text(pdfSafe(company.branchLabel), x, 19.5);
    ink(ACCENT);
    font(true, 13);
    doc.text(pdfSafe(title), PAGE.w - PAGE.margin, 14, { align: "right" });
    ink(GREY);
    font(false, 8.5);
    const sub = doc.splitTextToSize(pdfSafe(subtitle), 150) as string[];
    doc.text(sub.slice(0, 2), PAGE.w - PAGE.margin, 19.5, { align: "right" });
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.4);
    doc.line(PAGE.margin, 25, PAGE.w - PAGE.margin, 25);
  };
  const nextHead = () => {
    ink(ACCENT);
    font(true, 9.5);
    doc.text(pdfSafe(title), PAGE.margin, 12);
    ink(GREY);
    font(false, 8);
    doc.text(pdfSafe(company.company), PAGE.w - PAGE.margin, 12, { align: "right" });
  };
  firstHead();

  const newPage = () => {
    doc.addPage();
    nextHead();
    y = 18;
  };
  const ensure = (h: number) => {
    if (y + h > PAGE.bottom) newPage();
  };

  const section = (text: string, note?: string) => {
    ensure(note ? 22 : 16);
    y += 3;
    ink(INK);
    font(true, 10.5);
    doc.text(pdfSafe(text), PAGE.margin, y + 3);
    y += 5;
    if (note) {
      ink(GREY);
      font(false, 7.5);
      const lines = doc.splitTextToSize(pdfSafe(note), width) as string[];
      doc.text(lines, PAGE.margin, y + 2.5);
      y += lines.length * 3.2 + 1;
    }
    y += 1;
  };

  const figures = (items: { label: string; value: string; sub?: string }[]) => {
    ensure(20);
    const gap = 4;
    const w = (width - gap * (items.length - 1)) / items.length;
    items.forEach((f, i) => {
      const x = PAGE.margin + i * (w + gap);
      fill(ZEBRA);
      doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
      doc.roundedRect(x, y, w, 16, 2, 2, "FD");
      ink(GREY);
      font(false, 7.5);
      doc.text(pdfSafe(f.label), x + 3, y + 5);
      ink(INK);
      font(true, 13);
      doc.text(pdfSafe(f.value), x + 3, y + 11.5);
      if (f.sub) {
        ink(GREY);
        font(false, 7);
        doc.text(pdfSafe(f.sub), x + w - 3, y + 11.5, { align: "right" });
      }
    });
    y += 20;
  };

  const table = (columns: PdfColumn[], rows: string[][]) => {
    const sum = columns.reduce((a, c) => a + c.weight, 0);
    const mm = columns.map((c) => (c.weight / sum) * width);
    const xs = mm.map((_, i) => PAGE.margin + mm.slice(0, i).reduce((a, b) => a + b, 0));
    const bodyPt = 7.2;
    const lineH = bodyPt * PT * 1.25;
    // a heading may take two lines ("Waiting over / 2 days"); the band is as tall as the tallest
    font(true, 7);
    const heads = columns.map((c, i) => (doc.splitTextToSize(pdfSafe(c.header), mm[i] - 2.4) as string[]).slice(0, 2));
    const headLines = Math.max(1, ...heads.map((h) => h.length));
    const headH = headLines > 1 ? 10 : 8;
    const drawHead = () => {
      fill(HEAD);
      doc.rect(PAGE.margin, y, width, headH, "F");
      ink(WHITE);
      font(true, 7);
      heads.forEach((lines, i) => {
        const first = y + headH / 2 - ((lines.length - 1) * 2.9) / 2 + 0.9;
        lines.forEach((line, k) => {
          if (columns[i].align === "center") doc.text(line, xs[i] + mm[i] / 2, first + k * 2.9, { align: "center" });
          else doc.text(line, xs[i] + 1.4, first + k * 2.9);
        });
      });
      y += headH;
    };
    font(false, bodyPt);
    const laid = rows.map((cells) => {
      const lines = cells.map((t, i) => (doc.splitTextToSize(pdfSafe(t), mm[i] - 2.4) as string[]).slice(0, 8));
      return { lines, h: Math.max(1, ...lines.map((l) => l.length)) * lineH + 3.2 };
    });
    ensure(headH + (laid[0]?.h ?? 8));
    drawHead();
    laid.forEach((row, k) => {
      if (y + row.h > PAGE.bottom) {
        newPage();
        drawHead();
      }
      if (k % 2 === 1) {
        fill(ZEBRA);
        doc.rect(PAGE.margin, y, width, row.h, "F");
      }
      font(false, bodyPt);
      ink(INK);
      row.lines.forEach((lines, i) => {
        lines.forEach((line, n) => {
          const by = y + 1.6 + lineH * n + bodyPt * PT * 0.95;
          if (columns[i].align === "center") doc.text(line, xs[i] + mm[i] / 2, by, { align: "center" });
          else doc.text(line, xs[i] + 1.4, by);
        });
      });
      doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
      doc.setLineWidth(0.15);
      doc.line(PAGE.margin, y + row.h, PAGE.margin + width, y + row.h);
      y += row.h;
    });
    if (rows.length === 0) {
      ink(GREY);
      font(false, 8);
      doc.text("Nothing in this period.", PAGE.margin + 1.4, y + 5);
      y += 8;
    }
    y += 3;
  };

  const finish = (now: Date) => {
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p += 1) {
      doc.setPage(p);
      font(false, 7);
      ink(GREY);
      doc.text(`Generated ${pdfSafe(stamp(now))} - UK Textiles HRMS`, PAGE.margin, PAGE.footerY);
      doc.text(`Page ${p} of ${pages}`, PAGE.w - PAGE.margin, PAGE.footerY, { align: "right" });
    }
    return doc;
  };

  return { doc, section, figures, table, finish };
}

/** The PDF's attention list: one line per employee, their categories with counts. */
export function attentionPdfRows(employees: EmployeeHit[], categories: CategoryMeta[]): string[][] {
  return employees.map((e, i) => [
    String(i + 1),
    e.code,
    e.name,
    e.department ?? "",
    levelWord(e.level),
    num1(e.score),
    flagChips(e, categories)
      .map((c) => `${shortLabel(c.label)} ${c.count}${c.flagged ? "*" : ""}`)
      .join(", "),
    dateShort(e.lastDate),
  ]);
}

export const ATTENTION_PDF_COLUMNS: PdfColumn[] = [
  { header: "#", weight: 4, align: "center" },
  { header: "Code", weight: 7 },
  { header: "Name", weight: 16 },
  { header: "Department", weight: 13 },
  { header: "Level", weight: 7, align: "center" },
  { header: "Score", weight: 6, align: "center" },
  { header: "Categories (count, * = over the limit)", weight: 38 },
  { header: "Last record", weight: 9, align: "center" },
];

/** A category's top list in the PDF: the first `limit` employees by count. */
export function categoryTopRows(detail: CategoryDetail, limit = 10): string[][] {
  return detail.employees
    .slice(0, limit)
    .map((e, i) => [
      String(i + 1),
      e.code,
      e.name,
      e.department ?? "",
      String(e.count),
      levelWord(e.level),
      patternNote(e.pattern) ?? "",
      dateShort(e.lastDate),
    ]);
}

const TOP_COLUMNS: PdfColumn[] = [
  { header: "#", weight: 4, align: "center" },
  { header: "Code", weight: 7 },
  { header: "Name", weight: 18 },
  { header: "Department", weight: 15 },
  { header: "Count", weight: 6, align: "center" },
  { header: "Level", weight: 8, align: "center" },
  { header: "Pattern", weight: 22 },
  { header: "Last date", weight: 9, align: "center" },
];

export async function buildPagePdf(input: PageExportInput): Promise<jsPDF> {
  const { summary } = input;
  const w = await pdfWriter(pageTitle(summary.type), pageSubtitle(input), input);
  const t = summary.totals;
  w.figures([
    { label: "Employees in scope", value: String(t.employeesInScope) },
    { label: "With records", value: String(t.employeesWithIssues) },
    { label: "Needing attention", value: String(t.needingAttention), sub: "at or over a limit" },
    { label: "High", value: String(t.high), sub: "twice a limit or 3+ categories" },
  ]);
  const list = exportEmployees(summary, input.levelFilter);
  w.section(
    `Employees (${list.length})`,
    "Sorted by score: the sum of each category's count over its limit. High = twice a limit or over in 3+ categories; Attention = at or over a limit; Watch = under every limit.",
  );
  w.table(ATTENTION_PDF_COLUMNS, attentionPdfRows(list, summary.categories));
  for (const meta of summary.categories) {
    const detail = input.categories.find((d) => d.category?.key === meta.key);
    if (!detail || detail.employees.length === 0) continue;
    w.section(
      `${meta.label}: ${meta.flagged} over the limit, ${meta.affected} with records`,
      `${thresholdText(meta)}. Top ${Math.min(10, detail.employees.length)} of ${detail.employees.length} by count.`,
    );
    w.table(TOP_COLUMNS, categoryTopRows(detail));
  }
  if (summary.type === "staff" && summary.hods.length) {
    const sheet = hodSheet(summary.hods);
    w.section("Department Heads", sheet.note);
    w.table(
      sheet.columns.map((c, i) => ({ header: c.header, weight: c.width, align: i >= 3 ? "center" : "left" })),
      sheet.rows.map((r) => r.map(String)),
    );
  }
  return w.finish(input.now);
}

export async function buildEmployeePdf(input: EmployeeExportInput): Promise<jsPDF> {
  const { detail } = input;
  const e = detail.employee;
  const w = await pdfWriter(
    `${e.name} (${e.code})`,
    [pageTitle(e.type), detail.period.label, e.department, e.designation].filter(Boolean).join(" · "),
    input,
  );
  const cats = Object.values(detail.categories);
  w.figures([
    { label: "Level", value: levelWord(detail.level) },
    { label: "Score", value: num1(detail.score) },
    { label: "Over the limit in", value: String(detail.flags.length), sub: "categories" },
    { label: "Records", value: String(detail.timeline.length) },
  ]);
  const [summary, timeline] = employeeSheets(detail);
  w.section("Against each limit", "Count in the period against the category's limit for the period, with the pattern.");
  w.table(
    summary.columns.map((c, i) => ({ header: c.header, weight: c.width, align: i >= 1 && i <= 6 ? "center" : "left" })),
    summary.rows.filter((_, i) => cats[i].count > 0).map((r) => r.map(String)),
  );
  w.section(`Every record (${detail.timeline.length})`, "Newest first.");
  w.table(
    timeline.columns.map((c) => ({ header: c.header, weight: c.width })),
    timeline.rows.map((r) => r.map(String)),
  );
  return w.finish(input.now);
}

// ── the downloads ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function downloadPageExcel(input: PageExportInput) {
  await downloadWorkbook(await buildPageWorkbook(input), pageFileName(input.summary, "xlsx"));
}

export async function downloadPagePdf(input: PageExportInput) {
  (await buildPagePdf(input)).save(pageFileName(input.summary, "pdf"));
}

export async function downloadEmployeeExcel(input: EmployeeExportInput) {
  await downloadWorkbook(await buildEmployeeWorkbook(input), employeeFileName(input.detail, "xlsx"));
}

export async function downloadEmployeePdf(input: EmployeeExportInput) {
  (await buildEmployeePdf(input)).save(employeeFileName(input.detail, "pdf"));
}
