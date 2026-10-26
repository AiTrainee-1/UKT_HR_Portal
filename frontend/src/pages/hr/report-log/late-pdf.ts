import type { jsPDF } from "jspdf";
import { pdfSafe } from "@/components/payroll/statement/export-statement-pdf";
import { downloadBlob } from "@/lib/exportUtils";
import { longDate } from "../leave/logic";
import type { LateReportInput } from "./late-excel";
import {
  LATE_COLUMNS,
  LATE_REPORT_TITLE,
  SEVERITY_BANDS,
  SEVERITY_COLORS,
  cellText,
  generatedStamp,
  lateFileStem,
  severityOf,
} from "./late";

// The Daily Late Report as a PDF: A4 landscape, a company header (logo, company, branch) with the title and the date, then the
// seven columns of the table with a header that repeats on every page, a tint per severity on the minutes, a small colour key
// under the table and a footer with the moment it was made and "Page x of y". Nothing else: no summary line, no explanation, no
// totals row (the page has those). Drawn with jsPDF's built-in Helvetica (text is made safe for it with pdfSafe, the same as the
// Salary Statement PDF) so the text stays selectable. jsPDF is imported on demand, so only a user who exports pays for it.

/** The colour key goes under the table, on the last page: room kept for it (millimetres). */
const LEGEND_ROOM = 10;

export const PDF = {
  width: 297,
  height: 210,
  margin: 12,
  /** Table top on the first page (under the header block) and on the pages after it. */
  firstTop: 38,
  nextTop: 22,
  headHeight: 10.5,
  rowHeight: 7.4,
  /** The table may not go below this: the footer has the rest. */
  bottom: 196,
  footerY: 203,
} as const;

type Rgb = [number, number, number];
const INK: Rgb = [15, 23, 42];
const MUTED: Rgb = [100, 116, 139];
const RULE: Rgb = [226, 232, 240];
const HEAD: Rgb = [30, 41, 59];
const ZEBRA: Rgb = [248, 250, 252];
const WHITE: Rgb = [255, 255, 255];
const ACCENT: Rgb = [49, 46, 129];

const rgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** How many table rows each page holds: the first page has the header block, the later ones a short one. */
export function pdfRowsPerPage(count: number): number[] {
  const cap = (top: number) => Math.floor((PDF.bottom - top - PDF.headHeight - LEGEND_ROOM) / PDF.rowHeight);
  const first = cap(PDF.firstTop);
  const next = cap(PDF.nextTop);
  const pages: number[] = [];
  let left = count;
  let capacity = first;
  while (left > 0) {
    const take = Math.min(left, capacity);
    pages.push(take);
    left -= take;
    capacity = next;
  }
  return pages.length > 0 ? pages : [0];
}

export async function buildLatePdf(input: LateReportInput): Promise<jsPDF> {
  const { jsPDF: JsPdf } = await import("jspdf");
  const doc = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4" });
  const now = input.now ?? new Date();
  const stamp = generatedStamp(now);
  const { width: pageW, margin, headHeight, rowHeight } = PDF;
  const tableW = pageW - 2 * margin;
  const pages = pdfRowsPerPage(input.entries.length);
  const dateText = pdfSafe(longDate(input.date));

  doc.setProperties({
    title: `${LATE_REPORT_TITLE} ${input.date}`,
    subject: dateText,
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

  const lefts = LATE_COLUMNS.map((_, i) => margin + LATE_COLUMNS.slice(0, i).reduce((a, c) => a + c.mm, 0));
  const logo = input.logoDataUrl;
  const logoFormat = /^data:image\/(png|jpe?g);base64,/i.exec(logo ?? "");

  /** The header block of the first page: company, title and date (and the note, when something narrows the list). */
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
    ink(MUTED);
    doc.text(pdfSafe(input.branchLabel), textX, 22);

    ink(ACCENT);
    font(true, 17);
    doc.text(LATE_REPORT_TITLE, pageW - margin, 16, { align: "right" });
    ink(INK);
    font(false, 10);
    doc.text(dateText, pageW - margin, 22, { align: "right" });

    stroke(RULE, 0.4);
    doc.line(margin, 28, pageW - margin, 28);

    // what narrows the list (a department, a search, "Selected: 2 of 18"), only when something does
    if (input.filter) {
      font(false, 8);
      ink(MUTED);
      doc.text(fit(pdfSafe(input.filter), tableW), margin, 33.5);
    }
  };

  /** The slim header of the later pages. */
  const drawNextHead = () => {
    ink(ACCENT);
    font(true, 10);
    doc.text(LATE_REPORT_TITLE, margin, 12);
    ink(MUTED);
    font(false, 9);
    doc.text(`${dateText}  -  ${pdfSafe(input.company)}`, margin + 40, 12);
    stroke(RULE, 0.3);
    doc.line(margin, 16, pageW - margin, 16);
  };

  const drawColumnHeads = (top: number) => {
    fill(HEAD);
    doc.rect(margin, top, tableW, headHeight, "F");
    font(true, 7.8);
    ink(WHITE);
    const pitch = 3.5;
    LATE_COLUMNS.forEach((col, i) => {
      // a long header ("Grace Period (minutes)") takes two lines instead of being cut
      const lines = (doc.splitTextToSize(pdfSafe(col.header), col.mm - 4) as string[]).slice(0, 2);
      const first = top + (headHeight - (lines.length - 1) * pitch) / 2 + 0.36 * 7.8 * 0.3528;
      lines.forEach((line, k) => {
        if (col.align === "center") doc.text(line, lefts[i] + col.mm / 2, first + k * pitch, { align: "center" });
        else doc.text(line, lefts[i] + 2.5, first + k * pitch);
      });
    });
  };

  const drawFooter = (page: number) => {
    font(false, 7.5);
    ink(MUTED);
    doc.text(`Generated ${stamp}  -  UKTextiles HRMS`, margin, PDF.footerY);
    doc.text(`Page ${page} of ${pages.length}`, pageW - margin, PDF.footerY, { align: "right" });
  };

  let next = 0;
  pages.forEach((count, pageIndex) => {
    if (pageIndex > 0) doc.addPage();
    const top = pageIndex === 0 ? PDF.firstTop : PDF.nextTop;
    if (pageIndex === 0) drawFirstHead();
    else drawNextHead();
    drawColumnHeads(top);
    let y = top + headHeight;

    for (let n = 0; n < count; n += 1) {
      const entry = input.entries[next];
      next += 1;
      if (next % 2 === 0) {
        fill(ZEBRA);
        doc.rect(margin, y, tableW, rowHeight, "F");
      }
      LATE_COLUMNS.forEach((col, i) => {
        const text = pdfSafe(cellText(entry, col.key));
        const ty = baseline(y, rowHeight, 8.6);
        if (col.key === "minutesLate") {
          const level = severityOf(entry.minutesLate);
          if (level) {
            const colors = SEVERITY_COLORS[level];
            fill(rgb(colors.bg));
            doc.roundedRect(lefts[i] + col.mm / 2 - 11, y + 1.1, 22, rowHeight - 2.2, 1.4, 1.4, "F");
            ink(rgb(colors.text));
            font(true, 8.6);
          } else {
            ink(INK);
            font(false, 8.6);
          }
          doc.text(text, lefts[i] + col.mm / 2, ty, { align: "center" });
          return;
        }
        font(col.key === "name", 8.6);
        ink(INK);
        if (col.align === "center") doc.text(fit(text, col.mm - 4), lefts[i] + col.mm / 2, ty, { align: "center" });
        else doc.text(fit(text, col.mm - 5), lefts[i] + 2.5, ty);
      });
      stroke(RULE, 0.15);
      doc.line(margin, y + rowHeight, margin + tableW, y + rowHeight);
      y += rowHeight;
    }

    // the colour key sits under the table, on the last page
    if (pageIndex === pages.length - 1) {
      font(false, 7.5);
      ink(MUTED);
      let lx = margin;
      const ly = y + 6;
      doc.text("Late by:", lx, ly);
      lx += doc.getTextWidth("Late by:") + 3;
      SEVERITY_BANDS.forEach((band) => {
        const colors = SEVERITY_COLORS[band.key];
        fill(rgb(colors.bg));
        doc.roundedRect(lx, ly - 3.2, 3.6, 3.6, 0.8, 0.8, "F");
        ink(MUTED);
        doc.text(band.label, lx + 5, ly);
        lx += 5 + doc.getTextWidth(band.label) + 6;
      });
    }

    stroke(RULE, 0.3);
    doc.rect(margin, top, tableW, y - top, "S");
    drawFooter(pageIndex + 1);
  });

  return doc;
}

export const latePdfName = (date: string) => `${lateFileStem(date)}.pdf`;

/** Builds the PDF and downloads it. */
export async function downloadLatePdf(input: LateReportInput): Promise<void> {
  const doc = await buildLatePdf(input);
  downloadBlob(doc.output("blob"), latePdfName(input.date));
}
