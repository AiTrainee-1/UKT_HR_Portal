import type ExcelJS from "exceljs";
import type { jsPDF } from "jspdf";
import { pdfSafe } from "@/components/payroll/statement/export-statement-pdf";
import type { HodCategory, HodRow } from "@/lib/api-client/custom-hooks";
import {
  addMergedTextRow,
  addTitleBlock,
  allBorders,
  downloadBlob,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";
import {
  DASH,
  DETAIL_HEADERS,
  boardHeaders,
  boardRows,
  boardTotals,
  dayText,
  detailRows,
  groupItems,
  hodFileStem,
  sortHods,
  stampText,
  waitingText,
} from "./logic";

// HoD's exports: the board (every head x category, with the totals) and the detail (every pending request, head by head) as an
// Excel workbook (two sheets) and an A4 PDF (the board, then the detail with a band per head), plus the plumbing to hand the
// PDF or the picture (HodImageSheet) to the phone's share sheet. Nothing here changes data: the page marks these view-safe.

export const BOARD_TITLE = "Pending approvals with HoDs";

export type HodReportInput = {
  rows: HodRow[];
  categories: HodCategory[];
  company: string;
  branchLabel: string;
  logoDataUrl?: string | null;
  /** What narrows the board ("Branch: Unit 1 · Only HoDs with pending"); "" for everything. */
  scope: string;
  now: Date;
};

// ─── Excel ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER_FILL = "FF1E3A5F";
const TOTAL_FILL = "FFE8EEF6";
const AMBER = "FFB45309";
const MUTED = "FF94A3B8";

function sheetTable(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  input: HodReportInput,
  title: string,
  headers: string[],
  rows: (string | number)[][],
  opts: { numericFrom: number; numericTo: number; totalsRow: boolean },
) {
  let last = addTitleBlock(wb, ws, {
    totalCols: headers.length,
    company: input.company,
    branchLabel: input.branchLabel,
    title,
    titleFill: "FFDCE8F5",
    logoDataUrl: input.logoDataUrl,
  });
  if (input.scope) {
    last += 1;
    addMergedTextRow(ws, last, headers.length, input.scope, { size: 9, bold: false, color: "FF64748B" });
  }
  const head = ws.getRow(last + 1);
  headers.forEach((h, i) => {
    const cell = head.getCell(i + 1);
    cell.value = h;
    styleHeaderCell(cell, { fill: HEADER_FILL, border: allBorders("thin", "FFBFC9D6") });
  });
  head.height = 30;
  ws.views = [{ state: "frozen", ySplit: last + 1 }];
  rows.forEach((values, r) => {
    const row = ws.getRow(last + 2 + r);
    const isTotal = opts.totalsRow && r === rows.length - 1;
    values.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      cell.value = v;
      const numeric = c >= opts.numericFrom && c <= opts.numericTo;
      cell.alignment = { vertical: "middle", wrapText: true, horizontal: numeric || c === 0 ? "center" : "left" };
      cell.border = allBorders("hair", "FFD0D7E2");
      if (isTotal) {
        cell.font = { bold: true };
        cell.fill = solidFill(TOTAL_FILL);
      } else {
        if (r % 2 === 1) cell.fill = solidFill("FFF7F9FC");
        if (numeric && v === DASH) cell.font = { color: { argb: MUTED } };
        else if (numeric && typeof v === "number" && v > 0 && c < opts.numericTo)
          cell.font = { bold: true, color: { argb: AMBER } };
      }
    });
  });
  return last;
}

/** The workbook: "HoD board" (heads x categories with the totals row) and "Pending requests" (every request, oldest first). */
export async function buildHodWorkbook(input: HodReportInput): Promise<ExcelJS.Workbook> {
  const wb = await newWorkbook();
  const rows = sortHods(input.rows);
  const date = dayText(input.now);

  const board = wb.addWorksheet("HoD board");
  const headers = boardHeaders(input.categories);
  board.columns = headers.map((h, i) => ({
    width: i === 0 ? 5 : i === 1 ? 26 : i === 4 ? 28 : i <= 5 ? 16 : Math.max(11, h.length + 2),
  }));
  const firstCat = 6;
  sheetTable(wb, board, input, `${BOARD_TITLE} - ${date}`, headers, boardRows(rows, input.categories), {
    numericFrom: firstCat,
    numericTo: firstCat + input.categories.length,
    totalsRow: true,
  });

  const detail = wb.addWorksheet("Pending requests");
  detail.columns = [26, 26, 16, 12, 24, 16, 22, 30, 14, 12].map((width) => ({ width }));
  sheetTable(
    wb,
    detail,
    input,
    `Pending requests with HoDs - ${date}`,
    DETAIL_HEADERS,
    detailRows(rows, input.categories),
    {
      numericFrom: 9,
      numericTo: 9,
      totalsRow: false,
    },
  );
  return wb;
}

// ─── PDF ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PDF = {
  width: 297,
  height: 210,
  margin: 12,
  /** Table top on the first page (under the header block) and on the pages after it. */
  firstTop: 36,
  nextTop: 22,
  headHeight: 10.5,
  rowHeight: 7.2,
  /** The table may not go below this: the footer has the rest. */
  bottom: 196,
  footerY: 203,
} as const;

type Rgb = [number, number, number];
const INK: Rgb = [15, 23, 42];
const GREY: Rgb = [100, 116, 139];
const FAINT: Rgb = [148, 163, 184];
const RULE: Rgb = [226, 232, 240];
const HEAD: Rgb = [30, 41, 59];
const ZEBRA: Rgb = [248, 250, 252];
const WHITE: Rgb = [255, 255, 255];
const ACCENT: Rgb = [146, 64, 14];
const BAND_BG: Rgb = [254, 243, 199];
const BAND_INK: Rgb = [120, 53, 15];
const TOTAL_BG: Rgb = [232, 238, 246];
const WARN: Rgb = [180, 83, 9];
const DANGER: Rgb = [185, 28, 28];

export type PdfColumn = { header: string; mm: number; align: "left" | "center" };

/** One line of a table: a head's band (`contd`: the head started on an earlier page) or a row of cells. */
export type PdfLine =
  | { kind: "band"; group: number; text: string; contd?: boolean }
  | { kind: "row"; group: number | null; cells: string[]; zebra: boolean; total?: boolean; tones?: (Rgb | null)[] };

/** How many lines a page of a table holds (its column heads included in the top). */
export const pageCapacity = (top: number) => Math.floor((PDF.bottom - top - PDF.headHeight) / PDF.rowHeight);

/**
 * The lines each page holds. A band is never the last line of a page (it moves on with its first row), and a page that
 * continues a head's requests opens with that head's "(contd.)" band. No lines still give one (empty) page.
 */
export function planPages(lines: PdfLine[], first: number, next: number): PdfLine[][] {
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let band: Extract<PdfLine, { kind: "band" }> | null = null;
  const capacity = () => (pages.length === 0 ? first : next);
  for (const line of lines) {
    if (line.kind === "band") band = line;
    const needed = line.kind === "band" ? 2 : 1;
    if (page.length > 0 && page.length + needed > capacity()) {
      pages.push(page);
      page = [];
    }
    if (line.kind === "row" && page.length === 0 && line.group !== null && band && band.group === line.group)
      page.push({ ...band, contd: true });
    page.push(line);
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

/** The board's columns on A4 landscape: the head's name and departments share what the categories leave. */
export function boardColumns(categories: HodCategory[]): PdfColumn[] {
  const tableW = PDF.width - 2 * PDF.margin;
  const fixed = 8 + 14 + 16;
  const each = Math.min(22, Math.max(13, (tableW - fixed - 80) / Math.max(1, categories.length)));
  const rest = tableW - fixed - each * categories.length;
  return [
    { header: "#", mm: 8, align: "center" },
    { header: "HoD", mm: rest * 0.58, align: "left" },
    { header: "Departments", mm: rest * 0.42, align: "left" },
    ...categories.map((c) => ({ header: c.label, mm: each, align: "center" as const })),
    { header: "Total", mm: 14, align: "center" },
    { header: "Oldest", mm: 16, align: "center" },
  ];
}

export const DETAIL_COLUMNS: PdfColumn[] = [
  { header: "Category", mm: 30, align: "left" },
  { header: "Employee", mm: 52, align: "left" },
  { header: "Department", mm: 32, align: "left" },
  { header: "For", mm: 42, align: "left" },
  { header: "What", mm: 75, align: "left" },
  { header: "Raised on", mm: 24, align: "center" },
  { header: "Waiting", mm: 18, align: "center" },
];

const waitTone = (days: number | null): Rgb | null =>
  days === null ? null : days >= 7 ? DANGER : days >= 3 ? WARN : null;

export function boardLines(rows: HodRow[], categories: HodCategory[]): PdfLine[] {
  const sorted = sortHods(rows);
  const lines: PdfLine[] = sorted.map((r, i) => {
    const cats = categories.map((c) => r.byCategory[c.key]);
    return {
      kind: "row",
      group: null,
      zebra: i % 2 === 1,
      cells: [
        String(i + 1),
        r.name,
        r.departments.join(", ") || r.designation || "",
        ...cats.map((v) => (typeof v === "number" ? String(v) : DASH)),
        String(r.pending),
        r.pending > 0 ? waitingText(r.oldestDays) : "",
      ],
      tones: [
        null,
        null,
        null,
        ...cats.map((v) => (typeof v === "number" && v > 0 ? WARN : FAINT)),
        r.pending > 0 ? INK : FAINT,
        r.pending > 0 ? waitTone(r.oldestDays) : null,
      ],
    };
  });
  const totals = boardTotals(sorted, categories);
  lines.push({
    kind: "row",
    group: null,
    zebra: false,
    total: true,
    cells: [
      "",
      "Total",
      `${sorted.length} HoD${sorted.length === 1 ? "" : "s"}`,
      ...categories.map((c) => {
        const v = totals.byCategory[c.key];
        return typeof v === "number" ? String(v) : DASH;
      }),
      String(totals.pending),
      "",
    ],
  });
  return lines;
}

export function detailLines(rows: HodRow[], categories: HodCategory[]): PdfLine[] {
  const lines: PdfLine[] = [];
  sortHods(rows)
    .filter((r) => r.items.length > 0)
    .forEach((r, g) => {
      const where = r.departments.length ? `  ·  ${r.departments.join(", ")}` : "";
      lines.push({ kind: "band", group: g, text: `${r.name}${where}  ·  ${r.pending} pending` });
      let i = 0;
      for (const group of groupItems(r.items, categories)) {
        for (const item of group.items) {
          lines.push({
            kind: "row",
            group: g,
            zebra: i++ % 2 === 1,
            cells: [
              group.label,
              `${item.employeeName}${item.employeeCode ? ` (${item.employeeCode})` : ""}`,
              item.department ?? "",
              item.forText,
              item.summary,
              item.raisedAt ? dayText(new Date(item.raisedAt)) : "",
              waitingText(item.waitingDays),
            ],
            tones: [null, null, null, null, null, null, waitTone(item.waitingDays)],
          });
        }
      }
    });
  return lines;
}

/** The PDF: the board first (with its totals), then the detail of every head with something pending. */
export async function buildHodPdf(input: HodReportInput): Promise<jsPDF> {
  const { jsPDF: JsPdf } = await import("jspdf");
  const doc = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4" });
  const { width: pageW, margin, headHeight, rowHeight } = PDF;
  const tableW = pageW - 2 * margin;
  const date = pdfSafe(dayText(input.now));
  const stamp = stampText(input.now);

  const boardCols = boardColumns(input.categories);
  const boardPages = planPages(
    boardLines(input.rows, input.categories),
    pageCapacity(PDF.firstTop),
    pageCapacity(PDF.nextTop),
  );
  const details = detailLines(input.rows, input.categories);
  const detailPages = details.length
    ? planPages(details, pageCapacity(PDF.nextTop + 8), pageCapacity(PDF.nextTop))
    : [];
  const total = boardPages.length + detailPages.length;

  doc.setProperties({
    title: `${BOARD_TITLE} ${date}`,
    subject: date,
    author: "UKTextiles HRMS",
    creator: "UKTextiles HRMS",
  });

  const font = (bold: boolean, pt: number) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(pt);
  };
  const ink = (c: Rgb) => doc.setTextColor(c[0], c[1], c[2]);
  const fill = (c: Rgb) => doc.setFillColor(c[0], c[1], c[2]);
  const stroke = (c: Rgb, w: number) => {
    doc.setDrawColor(c[0], c[1], c[2]);
    doc.setLineWidth(w);
  };
  const baseline = (top: number, h: number, pt: number) => top + h / 2 + 0.36 * pt * 0.3528;
  const fit = (text: string, maxW: number): string => {
    if (doc.getTextWidth(text) <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (doc.getTextWidth(`${text.slice(0, mid).trimEnd()}...`) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo === 0 ? "" : `${text.slice(0, lo).trimEnd()}...`;
  };
  const logo = input.logoDataUrl;
  const logoFormat = /^data:image\/(png|jpe?g);base64,/i.exec(logo ?? "");

  const drawFirstHead = () => {
    let textX = margin;
    if (logo && logoFormat) {
      try {
        doc.addImage(logo, logoFormat[1].toLowerCase().startsWith("jp") ? "JPEG" : "PNG", margin, 10, 14, 14);
        textX = margin + 18;
      } catch {
        // a broken logo never stops the report
      }
    }
    ink(INK);
    font(true, 14);
    doc.text(fit(pdfSafe(input.company), 120), textX, 16);
    font(false, 9);
    ink(GREY);
    doc.text(pdfSafe(input.branchLabel), textX, 22);
    ink(ACCENT);
    font(true, 16);
    doc.text(BOARD_TITLE, pageW - margin, 16, { align: "right" });
    ink(INK);
    font(false, 10);
    doc.text(date, pageW - margin, 22, { align: "right" });
    stroke(RULE, 0.4);
    doc.line(margin, 27, pageW - margin, 27);
    if (input.scope) {
      font(false, 8);
      ink(GREY);
      doc.text(fit(pdfSafe(input.scope), tableW), margin, 32);
    }
  };

  const drawNextHead = (title: string) => {
    ink(ACCENT);
    font(true, 10);
    doc.text(title, margin, 12);
    ink(GREY);
    font(false, 9);
    doc.text(`${date}  -  ${pdfSafe(input.company)}`, pageW - margin, 12, { align: "right" });
    stroke(RULE, 0.3);
    doc.line(margin, 16, pageW - margin, 16);
  };

  const lefts = (cols: PdfColumn[]) => cols.map((_, i) => margin + cols.slice(0, i).reduce((a, c) => a + c.mm, 0));

  const drawHeads = (cols: PdfColumn[], top: number) => {
    const xs = lefts(cols);
    fill(HEAD);
    doc.rect(margin, top, tableW, headHeight, "F");
    ink(WHITE);
    const pitch = 3.3;
    cols.forEach((col, i) => {
      const header = pdfSafe(col.header);
      const room = col.mm - 2.5;
      // a long single word ("Resignation") is drawn a little smaller rather than broken in the middle
      let pt = 7.4;
      font(true, pt);
      while (pt > 5.6 && header.split(/\s+/).some((w) => doc.getTextWidth(w) > room)) {
        pt -= 0.2;
        font(true, pt);
      }
      const lines = (doc.splitTextToSize(header, room) as string[]).slice(0, 2);
      const first = top + (headHeight - (lines.length - 1) * pitch) / 2 + 0.36 * pt * 0.3528;
      lines.forEach((line, k) => {
        if (col.align === "center") doc.text(line, xs[i] + col.mm / 2, first + k * pitch, { align: "center" });
        else doc.text(line, xs[i] + 2.2, first + k * pitch);
      });
    });
  };

  const drawFooter = (page: number) => {
    font(false, 7.5);
    ink(GREY);
    doc.text(`Generated ${stamp}  -  UKTextiles HRMS`, margin, PDF.footerY);
    doc.text(`Page ${page} of ${total}`, pageW - margin, PDF.footerY, { align: "right" });
  };

  const drawTable = (cols: PdfColumn[], lines: PdfLine[], top: number) => {
    const xs = lefts(cols);
    drawHeads(cols, top);
    let y = top + headHeight;
    for (const line of lines) {
      if (line.kind === "band") {
        fill(BAND_BG);
        doc.rect(margin, y, tableW, rowHeight, "F");
        font(true, 9);
        ink(BAND_INK);
        const text = line.contd ? `${line.text}  (contd.)` : line.text;
        doc.text(fit(pdfSafe(text), tableW - 5), margin + 2.5, baseline(y, rowHeight, 9));
        y += rowHeight;
        continue;
      }
      if (line.total || line.zebra) {
        fill(line.total ? TOTAL_BG : ZEBRA);
        doc.rect(margin, y, tableW, rowHeight, "F");
      }
      line.cells.forEach((raw, i) => {
        const col = cols[i];
        if (!col) return;
        const tone = line.tones?.[i] ?? null;
        font(!!line.total || i === 1 || (tone !== null && tone !== FAINT), 8.2);
        ink(tone ?? INK);
        const text = pdfSafe(raw);
        const ty = baseline(y, rowHeight, 8.2);
        if (col.align === "center") doc.text(fit(text, col.mm - 2), xs[i] + col.mm / 2, ty, { align: "center" });
        else doc.text(fit(text, col.mm - 4), xs[i] + 2.2, ty);
      });
      stroke(RULE, 0.15);
      doc.line(margin, y + rowHeight, margin + tableW, y + rowHeight);
      y += rowHeight;
    }
    stroke(RULE, 0.3);
    doc.rect(margin, top, tableW, y - top, "S");
    return y;
  };

  let page = 0;
  boardPages.forEach((lines, i) => {
    if (page > 0) doc.addPage();
    page += 1;
    if (i === 0) drawFirstHead();
    else drawNextHead(BOARD_TITLE);
    drawTable(boardCols, lines, i === 0 ? PDF.firstTop : PDF.nextTop);
    drawFooter(page);
  });
  detailPages.forEach((lines, i) => {
    doc.addPage();
    page += 1;
    drawNextHead(i === 0 ? "Pending requests, HoD by HoD (oldest first)" : "Pending requests (contd.)");
    drawTable(DETAIL_COLUMNS, lines, i === 0 ? PDF.nextTop + 8 : PDF.nextTop);
    if (i === 0) {
      font(false, 8);
      ink(GREY);
      doc.text("Each band is one HoD; under it, every request waiting for their approval.", margin, PDF.nextTop + 5);
    }
    drawFooter(page);
  });
  return doc;
}

// ─── files, the share sheet, the clipboard ─────────────────────────────────────────────────────────────────────────

export const hodFileName = (now: Date, ext: "xlsx" | "pdf" | "png") => `${hodFileStem(now)}.${ext}`;

export async function hodExcelBlob(input: HodReportInput): Promise<Blob> {
  const buffer = await (await buildHodWorkbook(input)).xlsx.writeBuffer();
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function hodPdfBlob(input: HodReportInput): Promise<Blob> {
  return (await buildHodPdf(input)).output("blob");
}

/** The picture of an element (the off-screen HodImageSheet), as a PNG. */
export async function elementPng(el: HTMLElement): Promise<Blob> {
  // loaded on demand, like lib/exportUtils: only a user who exports pays for it
  const { default: html2canvas } = await import("html2canvas-pro");
  const canvas = await html2canvas(el, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The picture could not be made.");
  return blob;
}

type ShareNavigator = Pick<Navigator, "share" | "canShare">;

/** Whether this browser can hand a file of this kind to the share sheet (a phone usually can, a desktop often cannot). */
export function canShareFile(file: File, nav: Partial<ShareNavigator> | undefined = globalThis.navigator): boolean {
  try {
    return typeof nav?.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export type ShareOutcome = "shared" | "cancelled" | "downloaded";

/**
 * The browser's share sheet with the file (WhatsApp, mail, Drive ... on a phone) when it allows files; otherwise the file
 * is downloaded, and the page offers the summary text to paste next to it.
 */
export async function shareOrDownload(
  blob: Blob,
  filename: string,
  meta: { title: string; text: string },
  nav: Partial<ShareNavigator> | undefined = globalThis.navigator,
): Promise<ShareOutcome> {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  if (canShareFile(file, nav)) {
    try {
      await nav!.share!({ files: [file], title: meta.title, text: meta.text });
      return "shared";
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return "cancelled";
      // a share sheet that refused the file: the download below still gets it to the user
    }
  }
  downloadBlob(blob, filename);
  return "downloaded";
}

/** Puts `text` on the clipboard; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // an insecure page (plain http on the LAN) has no clipboard API: the old way below still works there
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
