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
import { renderTablePdf, type ExportCompany, type PdfColumn, type PdfRow } from "../attendance/export";
import { EXPORT_SIGNATURES, type ExportCell, type SettlementExport, type SummaryCard } from "./logic";

// The Settlement report (owner 2026-11-20, columns, Final Summary and signatures 2026-11-26): the rows the Export dialog
// chose, as an Excel workbook through the shared lazy ExcelJS and as an A4 landscape PDF drawn by the same table renderer
// as the attendance exports. Under the totals: the Final Summary (five large cards) and the five signatures, drawn like
// the Salary Statement's (backend reporting/definitions/hr_reports_salary_statement_files.py: _cards / _signatures and
// its Excel writer's cards() / signatures()). No explanatory notes in the files. The page loads this module only when an
// export is asked for. Nothing here changes data.

export type SettlementExportInput = ExportCompany & { table: SettlementExport; now: Date };

const MONEY_FMT = "#,##0.00";
/** Indian digit grouping for the Final Summary's figures (the Salary Statement's X_MONEY). */
const INDIAN_MONEY_FMT = "[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00";
const COUNT_FMT = "#,##0";
export const SUMMARY_TITLE = "Final Summary";

// the Salary Statement's colours (reporting/export_pdf.py, export_xlsx.py)
const BRAND = "1E3A5F";
const BRAND_SOFT = "E8EEF6";
const GRID = "D5DBE3";
const SIGN_INK = "111827";

const stamp = (now: Date) =>
  now.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** "Settlement_Term_Loan_Pending_November_2026_2026-11-20.xlsx". */
export const exportFileName = (table: SettlementExport, ext: "xlsx" | "pdf") =>
  `${fileSafe(table.fileStem)}_${todayStamp()}.${ext}`;

/** `count` columns shared out into `parts` runs, the first ones a column wider: [(first, last)], 1-based (the Salary
 *  Statement's _spans). */
export function spans(count: number, parts: number): [number, number][] {
  const out: [number, number][] = [];
  let start = 1;
  for (let i = 0; i < parts; i += 1) {
    const size = Math.floor(count / parts) + (i < count % parts ? 1 : 0);
    out.push([start, start + size - 1]);
    start += size;
  }
  return out;
}

/** The signature titles' columns: five runs of equal width with an empty column between two of them, over at least 9
 *  columns (narrower tables lend the columns to the right). */
export function signatureSpans(cols: number): [number, number][] {
  const count = Math.max(cols, EXPORT_SIGNATURES.length * 2 - 1);
  const gaps = EXPORT_SIGNATURES.length - 1;
  const runs = spans(count - gaps, EXPORT_SIGNATURES.length);
  return runs.map(([first, last], i) => [first + i, last + i]);
}

/** The Final Summary in Excel (the Salary Statement's cards()): its title, then a labels row and a large figures row, each
 *  card merged across its columns, framed and tinted. Returns the last row written. */
function excelSummary(ws: ExcelJS.Worksheet, row: number, cols: number, cards: SummaryCard[]): number {
  const title = ws.getCell(row, 1);
  title.value = SUMMARY_TITLE;
  title.font = { name: "Calibri", size: 14, bold: true, color: { argb: `FF${BRAND}` } };
  ws.getRow(row).height = 24;
  const thin: Partial<ExcelJS.Border> = { style: "thin", color: { argb: `FF${GRID}` } };
  const labels = row + 1;
  const values = row + 2;
  spans(Math.max(cols, cards.length), cards.length).forEach(([first, last], i) => {
    const card = cards[i];
    for (const r of [labels, values]) {
      for (let c = first; c <= last; c += 1) {
        const piece = ws.getCell(r, c);
        piece.fill = solidFill(`FF${BRAND_SOFT}`);
        piece.border = {
          ...(c === first ? { left: thin } : {}),
          ...(c === last ? { right: thin } : {}),
          ...(r === labels ? { top: thin } : { bottom: thin }),
        };
      }
      const cell = ws.getCell(r, first);
      if (r === labels) {
        cell.value = card.label;
        cell.font = { name: "Calibri", size: 10, color: { argb: "FF666666" } };
      } else {
        cell.value = card.value;
        cell.numFmt = card.kind === "count" ? COUNT_FMT : INDIAN_MONEY_FMT;
        cell.font = { name: "Calibri", size: 15, bold: true, color: { argb: `FF${BRAND}` } };
      }
      cell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
      if (last > first) ws.mergeCells(r, first, r, last);
    }
  });
  ws.getRow(labels).height = 18;
  ws.getRow(values).height = 30;
  return values;
}

/** The signatures in Excel (the Salary Statement's signatures()): a tall empty row to sign in, then each title, bold and
 *  centred, under a medium line across its own columns. Returns the titles' row. */
function excelSignatures(ws: ExcelJS.Worksheet, row: number, cols: number): number {
  ws.getRow(row - 1).height = 52;
  const line: Partial<ExcelJS.Border> = { style: "medium", color: { argb: `FF${SIGN_INK}` } };
  signatureSpans(cols).forEach(([first, last], i) => {
    for (let c = first; c <= last; c += 1) ws.getCell(row, c).border = { top: line };
    const cell = ws.getCell(row, first);
    cell.value = EXPORT_SIGNATURES[i];
    cell.font = { name: "Calibri", size: 11, bold: true };
    cell.alignment = { horizontal: "center", vertical: "top" };
    if (last > first) ws.mergeCells(row, first, row, last);
  });
  ws.getRow(row).height = 20;
  return row;
}

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
  const totalsRow = last + 1 + lines.length;
  // two empty rows, the Final Summary, two empty rows and the room to sign, then the signatures
  const summaryEnd = excelSummary(ws, totalsRow + 3, cols, table.summary);
  excelSignatures(ws, summaryEnd + 4, cols);
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

/** A Final Summary figure as the PDF prints it: "Rs. 1,23,456.00", a count without currency. */
export const summaryText = (card: SummaryCard): string =>
  card.kind === "count"
    ? card.value.toLocaleString("en-IN", { maximumFractionDigits: 0 })
    : `Rs. ${card.value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const PT = 0.3528; // mm per point
const SUMMARY_PDF = { title: 8, gap: 3, cards: 19, room: 22, signTitle: 7, beforeSign: 6 } as const;
/** The height the Final Summary and the signatures take in the PDF (mm): kept together on one page. */
export const PDF_TAIL_HEIGHT =
  SUMMARY_PDF.title +
  SUMMARY_PDF.gap +
  SUMMARY_PDF.cards +
  SUMMARY_PDF.beforeSign +
  SUMMARY_PDF.room +
  SUMMARY_PDF.signTitle;

/** The Final Summary (the Salary Statement's _cards: a framed, tinted row of cards, a small muted label over a large bold
 *  figure) and the signatures (its _signatures: 2.2 cm of room, a line, the bold title centred under it, a gap between
 *  them), from `top` down. */
function drawPdfTail(doc: jsPDF, cards: SummaryCard[], top: number, left: number, width: number) {
  const brand = rgb(BRAND);
  const muted = rgb("5B6573");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...brand);
  doc.text(SUMMARY_TITLE, left, top + 5);
  const boxTop = top + SUMMARY_PDF.title + SUMMARY_PDF.gap;
  const cardW = width / cards.length;
  doc.setFillColor(...rgb(BRAND_SOFT));
  doc.rect(left, boxTop, width, SUMMARY_PDF.cards, "F");
  doc.setDrawColor(...rgb(GRID));
  doc.setLineWidth(0.6 * PT);
  for (let i = 1; i < cards.length; i += 1)
    doc.line(left + cardW * i, boxTop, left + cardW * i, boxTop + SUMMARY_PDF.cards);
  doc.setDrawColor(...brand);
  doc.setLineWidth(0.8 * PT);
  doc.rect(left, boxTop, width, SUMMARY_PDF.cards, "S");
  cards.forEach((card, i) => {
    const x = left + cardW * i + 3.2;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...muted);
    doc.text(pdfSafe(card.label), x, boxTop + 6);
    // a large bold figure, a little smaller when a very large sum would not fit its card
    const figure = pdfSafe(summaryText(card));
    doc.setFont("helvetica", "bold");
    let size = 15;
    doc.setFontSize(size);
    while (size > 9 && doc.getTextWidth(figure) > cardW - 6.4) {
      size -= 0.5;
      doc.setFontSize(size);
    }
    doc.setTextColor(...brand);
    doc.text(figure, x, boxTop + 14);
  });

  const lineY = boxTop + SUMMARY_PDF.cards + SUMMARY_PDF.beforeSign + SUMMARY_PDF.room;
  const gap = 14; // 1.4 cm between two lines
  const signW = (width - gap * (EXPORT_SIGNATURES.length - 1)) / EXPORT_SIGNATURES.length;
  doc.setDrawColor(...rgb(SIGN_INK));
  doc.setLineWidth(0.9 * PT);
  doc.setTextColor(...rgb(SIGN_INK));
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  EXPORT_SIGNATURES.forEach((title, i) => {
    const x = left + (signW + gap) * i;
    doc.line(x, lineY, x + signW, lineY);
    doc.text(title, x + signW / 2, lineY + 4.8, { align: "center" });
  });
}

export async function buildSettlementPdf(input: SettlementExportInput): Promise<jsPDF> {
  const { table } = input;
  return renderTablePdf({
    title: table.title,
    subtitle: table.subtitle,
    company: input,
    columns: settlementPdfColumns(table),
    rows: settlementPdfRows(table),
    now: input.now,
    tail: {
      height: PDF_TAIL_HEIGHT,
      draw: (doc, top, left, width) => drawPdfTail(doc, table.summary, top, left, width),
    },
  });
}

export async function downloadSettlementExcel(input: SettlementExportInput) {
  await downloadWorkbook(await buildSettlementWorkbook(input), exportFileName(input.table, "xlsx"));
}

export async function downloadSettlementPdf(input: SettlementExportInput) {
  (await buildSettlementPdf(input)).save(exportFileName(input.table, "pdf"));
}
