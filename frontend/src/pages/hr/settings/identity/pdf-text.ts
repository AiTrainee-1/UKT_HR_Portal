// How much room a line of text takes in the company document PDFs (letters and the single salary slip PDF), so the
// Settings page can say before saving whether a footer line still fits on the page. The footer lines are drawn with
// reportlab's drawCentredString (backend/api/document_pdf.py PremiumPageDecorator.draw): one line, centred, never
// wrapped, so a line wider than the paper is simply cut at both edges.

/**
 * Advance widths in 1/1000 em of the printable ASCII characters (space to ~) in the fonts the PDFs use. On a Windows
 * server reportlab registers Times New Roman Italic, Arial and Georgia from C:\Windows\Fonts; elsewhere it falls back to
 * its built-in Times / Helvetica. Each number is the wider of the two (taken from reportlab's pdfmetrics.stringWidth),
 * so a line that "fits" here fits on either kind of server.
 */
const WIDTHS = {
  // Footer tagline (Times New Roman Italic / Times-Italic).
  serifItalic: [
    250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500,
    500, 500, 500, 333, 333, 675, 675, 675, 500, 920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833,
    667, 722, 611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500, 333, 500, 500, 444, 500,
    444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400,
    275, 400, 541,
  ],
  // Footer contact line and footer note (Arial / Helvetica).
  body: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584,
  ],
  // Sans headings (Arial Bold / Helvetica-Bold).
  bodyBold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
    556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
    280, 389, 584,
  ],
  // Watermark and serif headings (Georgia Bold / Times-Bold).
  serifBold: [
    254, 376, 555, 703, 641, 1000, 833, 278, 447, 447, 500, 703, 328, 379, 328, 472, 701, 500, 626, 625, 649, 599, 648,
    554, 676, 648, 367, 367, 703, 703, 703, 548, 967, 758, 757, 722, 834, 721, 671, 807, 913, 446, 595, 817, 686, 1023,
    839, 820, 701, 820, 797, 649, 684, 833, 762, 1126, 809, 732, 689, 447, 472, 447, 703, 703, 500, 596, 646, 531, 663,
    572, 393, 577, 680, 354, 346, 632, 344, 1016, 690, 636, 658, 648, 520, 513, 397, 677, 567, 863, 588, 562, 525, 500,
    388, 500, 703,
  ],
} as const;

export type PdfFont = keyof typeof WIDTHS;

/** Width of one character in 1/1000 em. Outside printable ASCII: the bullet and the rupee sign are known; any other
 *  character is taken as a full em (wide on purpose, so an unknown script is never wrongly reported as fitting). */
function charWidth(ch: string, font: PdfFont): number {
  const code = ch.codePointAt(0) ?? 32;
  if (code >= 32 && code <= 126) return WIDTHS[font][code - 32];
  if (ch === "\u2022") return font === "serifBold" ? 438 : 350;
  if (ch === "\u20b9") return 556;
  return 1000;
}

/** Width of `text` in points when printed in `font` at `sizePt`. */
export function textWidthPt(text: string, font: PdfFont, sizePt: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch, font);
  return (units * sizePt) / 1000;
}

export const CM_PT = 72 / 2.54;
/** A4 portrait, the page every company document is printed on (reportlab's A4). */
export const A4_WIDTH_PT = 21 * CM_PT;
export const A4_HEIGHT_PT = 29.7 * CM_PT;
/** The decorative double border sits 0.9 cm in from each edge of the page. */
export const PAGE_BORDER_PT = 0.9 * CM_PT;
/** A centred footer line stays inside the page border when it is at most this wide. */
export const FOOTER_ROOM_PT = A4_WIDTH_PT - 2 * PAGE_BORDER_PT;

/** The three lines of the coloured footer band, as document_pdf.py draws them. */
export const FOOTER_LINES = {
  tagline: { font: "serifItalic", sizePt: 10.5 },
  contact: { font: "body", sizePt: 7.5 },
  note: { font: "body", sizePt: 6.5 },
} as const satisfies Record<string, { font: PdfFont; sizePt: number }>;

/** How the company address, phone, email and website are joined on the footer contact line. */
export const CONTACT_SEPARATOR = "   \u2022   ";

/** The footer contact line: the filled-in parts, in the order the PDF prints them. */
export const footerContactLine = (parts: (string | null | undefined)[]): string =>
  parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(CONTACT_SEPARATOR);

export type LineFit = {
  widthPt: number;
  /** Inside the page border (the comfortable limit). */
  fits: boolean;
  /** Wider than the paper itself: both ends are cut off. */
  offPaper: boolean;
  /** About how many characters would have to go for the line to fit inside the border (0 when it fits). */
  charsOver: number;
};

/** Does a centred, unwrapped line fit on an A4 page? */
export function lineFit(text: string, font: PdfFont, sizePt: number): LineFit {
  const widthPt = textWidthPt(text, font, sizePt);
  const chars = [...text].length;
  const perChar = chars > 0 ? widthPt / chars : 0;
  const overPt = widthPt - FOOTER_ROOM_PT;
  return {
    widthPt,
    fits: overPt <= 0,
    offPaper: widthPt > A4_WIDTH_PT,
    charsOver: overPt > 0 && perChar > 0 ? Math.ceil(overPt / perChar) : 0,
  };
}

/** The faint watermark: the company name in capitals, 66 pt bold serif, turned 35 degrees about the page centre. */
export const WATERMARK = { font: "serifBold", sizePt: 66, angleDeg: 35 } as const;

/** Does the watermark fit across the page, or are its ends cut off at the left and right edges? */
export function watermarkFits(companyName: string): boolean {
  const width = textWidthPt(companyName.toUpperCase(), WATERMARK.font, WATERMARK.sizePt);
  return width * Math.cos((WATERMARK.angleDeg * Math.PI) / 180) <= A4_WIDTH_PT;
}

/** Breaks `text` into lines no wider than `maxPt`, at spaces, the way a reportlab Paragraph wraps a heading. */
export function wrapText(text: string, font: PdfFont, sizePt: number, maxPt: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidthPt(next, font, sizePt) > maxPt) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** "140 of 544 pt": a width for the page to show. */
export const widthText = (fit: LineFit): string => `${Math.round(fit.widthPt)} of ${Math.round(FOOTER_ROOM_PT)} pt`;
