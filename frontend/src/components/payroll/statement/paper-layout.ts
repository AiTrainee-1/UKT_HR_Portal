import type { SalaryStatement, StatementColumn, StatementRow } from "@/lib/api-client/custom-hooks";
import {
  DEFAULT_ROWS_PER_PAGE,
  cellValue,
  formatCell,
  paginateStatement,
  type FormattedCell,
  type StatementPage,
} from "./statement-model";

// How a printed statement lays its columns out. The server gives every column a relative `weight`, but a printed A4
// landscape sheet has 281 mm for up to ~25 columns, and a figure that does not fit its column is either cut (a wrong
// amount on paper) or spills into its neighbour. So the sheet is laid out from the CONTENT: every figure gets the width
// it needs at a font size small enough for them all, and what is left over is shared out by weight. The PDF and the
// print / preview sheets use the same layout, so what you preview is what prints.

/** Helvetica / Arial advance widths in 1/1000 em for the printable ASCII range (code 32..126), regular and bold. */
// prettier-ignore
const REGULAR = [280,280,350,550,550,890,660,190,330,330,390,580,280,330,280,280,550,550,550,550,550,550,550,550,550,550,280,280,580,580,580,550,1010,660,660,720,720,660,610,780,720,280,500,660,550,830,720,780,660,780,720,660,610,720,660,940,660,660,610,280,280,280,470,550,330,550,550,500,550,550,280,550,550,220,220,500,220,830,550,550,550,550,330,500,280,550,500,720,500,500,500,330,260,330,580];
// prettier-ignore
const BOLD = [280,330,470,550,550,890,720,240,330,330,390,580,280,330,280,280,550,550,550,550,550,550,550,550,550,550,330,330,580,580,580,610,970,720,720,720,720,660,610,780,720,280,550,720,610,830,720,780,660,780,720,660,610,720,660,940,660,660,610,330,280,330,580,550,330,550,610,550,610,550,330,610,610,280,280,550,280,890,610,610,610,610,390,550,330,550,550,780,550,550,500,390,280,390,580];

/** A glyph we have no width for (a letter outside ASCII): a generous average, so the layout errs on the wide side. */
const UNKNOWN_GLYPH = 640;

/** The width of `text` in ems (multiply by the font size for the real width). */
export function textWidthEm(text: string, bold = false): number {
  const table = bold ? BOLD : REGULAR;
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    units += code >= 32 && code <= 126 ? table[code - 32] : UNKNOWN_GLYPH;
  }
  return units / 1000;
}

/** One point in millimetres. */
export const PT_MM = 25.4 / 72;

/** The printed sheet: A4 landscape with an 8 mm margin all round, a line (band / row / subtotal) is 8.5 mm tall. */
export const PAPER = {
  widthMm: 297,
  heightMm: 210,
  marginMm: 8,
  contentWidthMm: 281,
  contentHeightMm: 194,
  lineMm: 8.5,
  /** The table's own border (and the collapsed borders at its edges) take this much of the width: the columns get the rest. */
  tableBorderMm: 0.6,
  /** The small print under the last page's table. */
  notesPt: 6,
  notesLineMm: 2.9,
} as const;

/** Columns whose text may wrap onto a second line on paper (the rest are cut with an ellipsis). */
export const WRAP_KEYS = ["designation"];
export const wrapsOnPaper = (column: StatementColumn): boolean =>
  column.format === "text" && WRAP_KEYS.includes(column.key);

export type PaperLayout = {
  /** The body font size that lets every figure fit its column (the header and the bands use sizes derived from it). */
  fontPt: number;
  /** One width per column, in millimetres; they add up to `totalMm`. */
  widthsMm: number[];
  totalMm: number;
  /** Space kept free on each side of a cell's text. */
  padMm: number;
};

type Line = { row: StatementRow; bold: boolean };

const allLines = (statement: SalaryStatement): Line[] => [
  ...statement.groups.flatMap((g) => [...g.rows.map((row) => ({ row, bold: false })), { row: g.subtotal, bold: true }]),
  { row: statement.total, bold: true },
];

const longestWordEm = (text: string, bold: boolean): number =>
  text.split(/\s+/).reduce((max, word) => (word ? Math.max(max, textWidthEm(word, bold)) : max), 0);

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Rendering is never exactly what the table predicts (kerning, a substituted font): keep a few percent in hand. */
const SAFETY = 1.04;
const MAX_WANT_EM = 24;

export function layoutPaperColumns(
  statement: SalaryStatement,
  options: { widthMm?: number; maxFontPt?: number; minFontPt?: number; padMm?: number } = {},
): PaperLayout {
  const available = options.widthMm ?? PAPER.contentWidthMm;
  const maxPt = options.maxFontPt ?? 7;
  const minPt = options.minFontPt ?? 5.5;
  /** Below this the print gets hard to read: only a very wide statement is allowed to go lower. */
  const comfortPt = Math.min(maxPt, 6);
  const pad = options.padMm ?? 0.8;
  const cols = statement.columns;
  if (cols.length === 0) return { fontPt: maxPt, widthsMm: [], totalMm: 0, padMm: pad };

  const lines = allLines(statement);
  const text = (col: StatementColumn, row: StatementRow): FormattedCell =>
    formatCell(col, cellValue(row, col), { blankNull: true });

  // What each column must hold (`mustEm`: a figure whole, a word whole) and would like to hold (`wantEm`: a whole name).
  const mustEm: number[] = [];
  const wantEm: number[] = [];
  for (const col of cols) {
    const numeric = col.format !== "text";
    let must = 0;
    let want = 0;
    for (const { row, bold } of lines) {
      const cell = text(col, row).text;
      if (numeric) {
        must = Math.max(must, textWidthEm(cell, bold));
      } else {
        must = Math.max(must, longestWordEm(cell, bold));
        const full = textWidthEm(cell, bold);
        want = Math.max(want, wrapsOnPaper(col) ? full / 2 + 0.6 : full);
      }
    }
    const head = Math.max(longestWordEm(col.label, true), col.sub ? longestWordEm(col.sub, true) : 0);
    mustEm.push(Math.max(must, head));
    wantEm.push(Math.min(Math.max(want, must, head), MAX_WANT_EM));
  }

  // The biggest font at which the sheet works: first choice is one where every column also gets what it WANTS (a whole name),
  // as long as that is still comfortable to read; failing that, the biggest where every figure fits whole.
  const needAt = (pt: number, em: number[]): number[] => em.map((e) => e * pt * PT_MM * SAFETY + 2 * pad);
  let fontPt = minPt;
  let base = needAt(minPt, mustEm);
  let fits = false;
  let wantFits = false;
  for (let pt = maxPt; pt >= minPt - 1e-9; pt -= 0.25) {
    const mustMm = needAt(pt, mustEm);
    if (sum(mustMm) > available) continue; // the figures do not fit at this size: go smaller
    const wantsFit = pt >= comfortPt - 1e-9 && sum(needAt(pt, wantEm)) <= available;
    if (!fits || wantsFit) {
      // the first size where the figures fit is the fallback; a size where the wants fit too replaces it
      fontPt = pt;
      base = mustMm;
      fits = true;
      wantFits = wantsFit;
    }
    if (wantFits) break;
  }

  let widths: number[];
  if (!fits) {
    // Even the smallest font does not make room (an absurd number of columns): squeeze all of them evenly.
    const scale = available / sum(base);
    widths = base.map((w) => w * scale);
  } else {
    widths = base.slice();
    const emMm = fontPt * PT_MM * SAFETY;
    let extra = available - sum(widths);
    // first let the columns that want more (names, remarks) have what they ask for ...
    const needs = cols.map((_, i) => Math.max(0, wantEm[i] * emMm + 2 * pad - base[i]));
    const needTotal = sum(needs);
    if (needTotal > 0 && extra > 0) {
      const give = Math.min(extra, needTotal);
      needs.forEach((need, i) => (widths[i] += (need * give) / needTotal));
      extra -= give;
    }
    // ... then share what is left by weight
    if (extra > 1e-9) {
      const weights = cols.map((c) => (Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 1));
      const total = sum(weights);
      weights.forEach((w, i) => (widths[i] += (extra * w) / total));
    }
  }

  const rounded = widths.map((w) => Math.round(w * 100) / 100);
  // Rounding must not move the total: the last column takes the difference.
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + available - sum(rounded)) * 100) / 100;
  return { fontPt, widthsMm: rounded, totalMm: available, padMm: pad };
}

/**
 * How many table lines the notes under the table take on the last page (to keep that room free when paginating):
 * a heading, the notes wrapped to the page width, and a little air, in units of `lineMm`.
 */
export function notesReserveLines(
  notes: string[],
  options: { widthMm?: number; lineMm?: number; notesPt?: number; notesLineMm?: number } = {},
): number {
  if (notes.length === 0) return 0;
  const widthMm = options.widthMm ?? PAPER.contentWidthMm;
  const lineMm = options.lineMm ?? PAPER.lineMm;
  const pt = options.notesPt ?? PAPER.notesPt;
  const noteLineMm = options.notesLineMm ?? PAPER.notesLineMm;
  let noteLines = 0;
  for (const note of notes) {
    noteLines += Math.max(1, Math.ceil((textWidthEm(note) * pt * PT_MM * SAFETY) / widthMm));
  }
  return Math.ceil((noteLines * noteLineMm + 2 * noteLineMm + 2) / lineMm);
}

/** The printed pages of a statement: the model's pagination at the sheet's size, with room kept free for the notes. */
export function paperPages(statement: SalaryStatement, rowsPerPage: number = DEFAULT_ROWS_PER_PAGE): StatementPage[] {
  return paginateStatement(statement, rowsPerPage, { reserveLastPage: notesReserveLines(statement.notes) });
}
