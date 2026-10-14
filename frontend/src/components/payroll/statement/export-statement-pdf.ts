import type { jsPDF } from "jspdf";
import type { SalaryStatement, StatementRow } from "@/lib/api-client/custom-hooks";
import { downloadBlob } from "@/lib/exportUtils";
import { PAPER, PT_MM, layoutPaperColumns, notesReserveLines, wrapsOnPaper } from "./paper-layout";
import {
  GRAND_TOTAL_LABEL,
  cellValue,
  columnBands,
  formatCell,
  formatStamp,
  leadingIdentityCount,
  paginateStatement,
  statementFileStem,
  statementHeadline,
  statementTitle,
  type ColumnGroupKey,
  type StatementLine,
  type StatementPage,
} from "./statement-model";

// The Salary Statement as a PDF: A4 landscape, laid out like the printed statement but clean. It is drawn with jsPDF's
// built-in Helvetica (the only font it has without embedding one), so text is sanitised to what Helvetica can show - the
// rupee sign is never drawn - and cut with an ellipsis where it would not fit its column. jsPDF is imported on demand so
// only a user who exports pays for it.

/** The page, in millimetres. */
export const PDF_PAGE = {
  width: PAPER.widthMm,
  height: PAPER.heightMm,
  margin: PAPER.marginMm,
  /** Top of the table: under the company and title block. */
  tableTop: 20,
  bandHeight: 4.4,
  headHeight: 8.2,
  rowHeight: 5.9,
  /** The table (and the notes under it) may not go below this: the footer has the rest. */
  bottom: 201,
  footerY: 206,
  notesPt: 5.5,
  notesLineMm: 2.5,
} as const;

const BODY_TOP = PDF_PAGE.tableTop + PDF_PAGE.bandHeight + PDF_PAGE.headHeight;

/** Table lines (bands, rows, subtotals) that fit on one page. */
export const PDF_LINES_PER_PAGE = Math.floor((PDF_PAGE.bottom - BODY_TOP) / PDF_PAGE.rowHeight);

type Rgb = [number, number, number];

const INK: Rgb = [15, 23, 42];
const MUTED: Rgb = [148, 163, 184];
const RULE: Rgb = [203, 213, 225];
const FRAME: Rgb = [71, 85, 105];
const BAND: Rgb = [232, 238, 247];
const SUBTOTAL: Rgb = [238, 242, 249];
const HEAD: Rgb = [241, 245, 249];
const WHITE: Rgb = [255, 255, 255];

const GROUP_FILL: Record<ColumnGroupKey, Rgb> = {
  identity: [226, 232, 240],
  attendance: [219, 234, 254],
  earnings: [209, 250, 229],
  deductions: [255, 228, 230],
  result: [224, 231, 255],
};

/** Staff Payroll is indigo, Production Payroll amber: the grand total and the "Net pay" band. */
const ACCENT: Record<SalaryStatement["kind"], { total: Rgb; result: Rgb }> = {
  staff: { total: [55, 48, 163], result: [224, 231, 255] },
  production: { total: [146, 64, 14], result: [254, 243, 199] },
};

/** What Helvetica has no glyph for, as something it can draw (by code point, so this file stays plain ASCII). */
const PDF_REPLACEMENTS = new Map<number, string>([
  [0x20b9, "Rs "], // the rupee sign is never drawn
  [0x2010, "-"],
  [0x2011, "-"],
  [0x2012, "-"],
  [0x2013, "-"],
  [0x2014, "-"],
  [0x2015, "-"],
  [0x2212, "-"],
  [0x2018, "'"],
  [0x2019, "'"],
  [0x201a, "'"],
  [0x201c, '"'],
  [0x201d, '"'],
  [0x201e, '"'],
  [0x2026, "..."],
  [0x00a0, " "],
  [0x2007, " "],
  [0x202f, " "],
]);

/**
 * Text that Helvetica can draw: the rupee sign becomes "Rs", typographic dashes and quotes their plain forms, line breaks
 * become spaces, and a letter outside Latin-1 (which the built-in font has no glyph for) becomes "?", so the page never
 * shows garbage.
 */
export function pdfSafe(text: string): string {
  let out = "";
  let afterRupee = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (afterRupee && (code === 0x20 || code === 0xa0)) continue; // "Rs " already has its space
    afterRupee = code === 0x20b9;
    const mapped = PDF_REPLACEMENTS.get(code);
    if (mapped !== undefined) out += mapped;
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff)) out += ch;
    else if (code === 0x09 || code === 0x0a || code === 0x0d) out += " ";
    else out += "?";
  }
  return out;
}

export type StatementPdfOptions = {
  /** "data:image/png;base64,..." / "data:image/jpeg;base64,...": drawn top-left of every page (anything else is ignored). */
  logoDataUrl?: string | null;
  /** The "Generated" time when the statement has none of its own. */
  now?: Date;
};

/** The pages the PDF will have, so the caller (and the tests) can know before drawing. */
export function pdfPages(statement: SalaryStatement): StatementPage[] {
  const reserve = notesReserveLines(statement.notes, {
    lineMm: PDF_PAGE.rowHeight,
    notesPt: PDF_PAGE.notesPt,
    notesLineMm: PDF_PAGE.notesLineMm,
  });
  return paginateStatement(statement, PDF_LINES_PER_PAGE, { reserveLastPage: reserve });
}

export async function buildStatementPdf(statement: SalaryStatement, options: StatementPdfOptions = {}): Promise<jsPDF> {
  const { jsPDF: JsPdf } = await import("jspdf");
  const doc = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4" });
  const { width: pageW, margin, tableTop, bandHeight, headHeight, rowHeight, bottom, footerY } = PDF_PAGE;
  const title = pdfSafe(statementTitle(statement));
  const headline = pdfSafe(statementHeadline(statement));
  const accent = ACCENT[statement.kind] ?? ACCENT.staff;
  const stamp = formatStamp(statement.generatedAt, options.now);

  doc.setProperties({ title, subject: headline, author: "UKTextiles HRMS", creator: "UKTextiles HRMS" });

  const columns = statement.columns;
  const layout = layoutPaperColumns(statement, { widthMm: pageW - 2 * margin });
  const widths = layout.widthsMm;
  const lefts = widths.map((_, i) => margin + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const tableW = layout.totalMm;
  const bodyPt = layout.fontPt;
  const headPt = Math.max(5, bodyPt - 0.5);
  const identity = Math.max(1, leadingIdentityCount(columns));
  const pad = layout.padMm;
  const pages = pdfPages(statement);

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
  /** Baseline that centres capitals and digits of `pt` in a box of height `h` starting at `top`. */
  const baseline = (top: number, h: number, pt: number) => top + h / 2 + 0.36 * pt * PT_MM;

  /** `text` cut with an ellipsis so it fits `maxW` at the current font. */
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

  /**
   * `text` wrapped by hand, word by word, into at most `maxLines` lines no wider than `maxW` at the current font; what does
   * not fit on the last line is cut with an ellipsis (jsPDF has no wrapping of its own for a single cell).
   */
  const wrap = (text: string, maxW: number, maxLines: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (let i = 0; i < words.length; i += 1) {
      const trial = current ? `${current} ${words[i]}` : words[i];
      if (!current || doc.getTextWidth(trial) <= maxW) {
        current = trial;
      } else {
        lines.push(current);
        current = words[i];
        if (lines.length === maxLines - 1) {
          current = words.slice(i).join(" ");
          break;
        }
      }
    }
    if (current) lines.push(current);
    return lines.map((l) => fit(l, maxW));
  };

  /** A header label (and its second line) in at most three lines that fit `maxW`; the font must already be the header's. */
  const headerLines = (label: string, sub: string | null | undefined, maxW: number): string[] =>
    [label, sub ?? ""].flatMap((part) => wrap(pdfSafe(part), maxW, 2)).slice(0, 3);

  const logo = options.logoDataUrl;
  const logoFormat = /^data:image\/(png|jpe?g);base64,/i.exec(logo ?? "");

  const drawHead = () => {
    ink(INK);
    font(true, 12);
    doc.text(headline, pageW / 2, 11.5, { align: "center" });
    font(false, 9);
    doc.text(title, pageW / 2, 16.6, { align: "center" });
    if (logo && logoFormat) {
      try {
        doc.addImage(logo, logoFormat[1].toLowerCase().startsWith("jp") ? "JPEG" : "PNG", margin, 5, 11, 11);
      } catch {
        // a broken logo never stops the statement
      }
    }
    // group bands
    for (const band of columnBands(columns)) {
      const x = lefts[band.start];
      const w = widths.slice(band.start, band.start + band.span).reduce((a, b) => a + b, 0);
      fill(band.group === "result" ? accent.result : GROUP_FILL[band.group]);
      doc.rect(x, tableTop, w, bandHeight, "F");
      font(true, Math.max(4.8, headPt - 1));
      ink([51, 65, 85]);
      doc.text(band.label.toUpperCase(), x + w / 2, baseline(tableTop, bandHeight, headPt - 1), { align: "center" });
    }
    // labels
    fill(HEAD);
    doc.rect(margin, tableTop + bandHeight, tableW, headHeight, "F");
    font(true, headPt);
    ink(INK);
    columns.forEach((col, i) => {
      const lines = headerLines(col.label, col.sub, widths[i] - 2 * pad);
      const lineH = headPt * PT_MM * 1.18;
      const top = tableTop + bandHeight + (headHeight - lines.length * lineH) / 2;
      lines.forEach((text, k) => {
        doc.text(text, lefts[i] + widths[i] / 2, top + k * lineH + headPt * PT_MM * 0.85, { align: "center" });
      });
    });
    stroke(FRAME, 0.3);
    doc.line(margin, tableTop + bandHeight + headHeight, margin + tableW, tableTop + bandHeight + headHeight);
  };

  /** One figure, never cut: if it does not fit its column at the body size it shrinks until it does. */
  const figure = (text: string, right: number, y: number, maxW: number) => {
    let pt = doc.getFontSize();
    while (pt > 4 && doc.getTextWidth(text) > maxW) {
      pt -= 0.25;
      doc.setFontSize(pt);
    }
    doc.text(text, right, y, { align: "right" });
  };

  const drawCells = (row: StatementRow, y: number, bold: boolean, color: Rgb, summary: boolean, from: number) => {
    columns.forEach((col, i) => {
      if (i < from) return;
      const cell = formatCell(col, cellValue(row, col), summary ? { blankNull: true } : {});
      if (cell.text === "") return;
      const text = pdfSafe(cell.text);
      font(bold, bodyPt);
      ink(cell.zero && !summary ? MUTED : color);
      const ty = baseline(y, rowHeight, bodyPt);
      const w = widths[i] - 2 * pad;
      if (col.format !== "text") {
        figure(text, lefts[i] + widths[i] - pad, ty, w);
      } else if (wrapsOnPaper(col)) {
        // a designation takes two lines, as on the printed page
        const lines = wrap(text, w, 2);
        const pitch = bodyPt * PT_MM * 1.1;
        const top = y + (rowHeight - lines.length * pitch) / 2;
        const x = col.align === "center" ? lefts[i] + widths[i] / 2 : lefts[i] + pad;
        lines.forEach((t, k) => {
          const by = top + k * pitch + pitch / 2 + 0.36 * bodyPt * PT_MM;
          if (col.align === "center") doc.text(t, x, by, { align: "center" });
          else doc.text(t, x, by);
        });
      } else if (col.align === "center") {
        doc.text(fit(text, w), lefts[i] + widths[i] / 2, ty, { align: "center" });
      } else {
        doc.text(fit(text, w), lefts[i] + pad, ty);
      }
    });
  };

  const drawLine = (line: StatementLine, y: number) => {
    const span = widths.slice(0, identity).reduce((a, b) => a + b, 0);
    switch (line.kind) {
      case "band": {
        fill(BAND);
        doc.rect(margin, y, tableW, rowHeight, "F");
        font(true, bodyPt + 0.5);
        ink(INK);
        const label = pdfSafe(`${line.label}${line.continued ? " (contd.)" : ""}`);
        const ty = baseline(y, rowHeight, bodyPt);
        doc.text(label, margin + pad + 0.6, ty);
        if (!line.continued) {
          const x = margin + pad + 0.6 + doc.getTextWidth(label) + 2.5;
          font(false, bodyPt);
          ink(FRAME);
          doc.text(`${line.count} ${line.count === 1 ? "employee" : "employees"}`, x, ty);
        }
        stroke(RULE, 0.1);
        doc.line(margin, y + rowHeight, margin + tableW, y + rowHeight);
        break;
      }
      case "row": {
        drawCells(line.row, y, false, INK, false, 0);
        stroke(RULE, 0.1);
        doc.line(margin, y + rowHeight, margin + tableW, y + rowHeight);
        break;
      }
      case "subtotal": {
        fill(SUBTOTAL);
        doc.rect(margin, y, tableW, rowHeight, "F");
        stroke(FRAME, 0.15);
        doc.line(margin, y, margin + tableW, y);
        font(true, bodyPt);
        ink(INK);
        doc.text(fit(pdfSafe(line.label), span - 2 * pad), margin + pad + 0.6, baseline(y, rowHeight, bodyPt));
        drawCells(line.row, y, true, INK, true, identity);
        break;
      }
      case "total": {
        fill(accent.total);
        doc.rect(margin, y, tableW, rowHeight, "F");
        font(true, bodyPt + 0.5);
        ink(WHITE);
        doc.text(GRAND_TOTAL_LABEL, margin + pad + 0.6, baseline(y, rowHeight, bodyPt));
        drawCells(line.row, y, true, WHITE, true, identity);
        break;
      }
    }
  };

  const drawNotes = (y: number) => {
    if (statement.notes.length === 0) return;
    let ty = y + 4;
    font(true, PDF_PAGE.notesPt + 0.5);
    ink(INK);
    doc.text("Notes", margin, ty);
    ty += PDF_PAGE.notesLineMm;
    font(false, PDF_PAGE.notesPt);
    ink(FRAME);
    for (const note of statement.notes) {
      const wrapped = doc.splitTextToSize(pdfSafe(note), tableW) as string[];
      for (const text of wrapped) {
        if (ty > bottom + 3) return;
        doc.text(text, margin, ty);
        ty += PDF_PAGE.notesLineMm;
      }
    }
  };

  const drawFooter = (page: number) => {
    font(false, 7);
    ink(FRAME);
    doc.text(`Generated ${stamp}`, margin, footerY);
    doc.text(`Page ${page} of ${pages.length}`, pageW - margin, footerY, { align: "right" });
  };

  pages.forEach((page, index) => {
    if (index > 0) doc.addPage();
    drawHead();
    let y = BODY_TOP;
    for (const line of page.lines) {
      drawLine(line, y);
      y += rowHeight;
    }
    stroke(FRAME, 0.3);
    doc.rect(margin, tableTop, tableW, y - tableTop, "S");
    if (page.last) drawNotes(y);
    drawFooter(page.number);
  });

  return doc;
}

export const statementPdfFilename = (statement: SalaryStatement): string => `${statementFileStem(statement)}.pdf`;

/** Builds the PDF and downloads it as `Salary_Statement_<period>.pdf`. */
export async function downloadStatementPdf(
  statement: SalaryStatement,
  options: StatementPdfOptions = {},
): Promise<void> {
  const doc = await buildStatementPdf(statement, options);
  downloadBlob(doc.output("blob"), statementPdfFilename(statement));
}
