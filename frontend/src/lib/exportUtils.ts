import ExcelJS from "exceljs";

// One place for the export plumbing every page used to hand-roll: workbook
// creation, cell/header styling, the company title block, and the
// blob -> file download dance. Page-specific SHEET LAYOUTS (which columns,
// which totals) still live in each page -only the mechanics are shared, so a
// fix to (say) how a download is triggered lands everywhere at once.

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** YYYY-MM-DD for filenames. */
export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Collapses anything that isn't a letter/digit to "_" so a title is safe as a filename. */
export function fileSafe(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "_");
}

/** Saves a Blob as a file. The anchor is attached to the DOM first because
 *  Firefox ignores .click() on a detached one. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UKTextiles HRMS";
  return wb;
}

export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  const buffer = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: XLSX_MIME }), filename);
}

export const solidFill = (argb: string): ExcelJS.Fill => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb },
});

export const allBorders = (style: ExcelJS.BorderStyle, argb?: string): Partial<ExcelJS.Borders> => {
  const side = argb ? { style, color: { argb } } : { style };
  return { top: side, bottom: side, left: side, right: side };
};

/** Bold, filled, centred header cell -the look every table header shares. */
export function styleHeaderCell(
  cell: ExcelJS.Cell,
  opts: {
    fill: string;
    color?: string; // font colour, default white
    size?: number;
    wrapText?: boolean; // default true
    border?: Partial<ExcelJS.Borders>;
  },
): void {
  cell.fill = solidFill(opts.fill);
  cell.font = { bold: true, color: { argb: opts.color ?? "FFFFFFFF" }, ...(opts.size ? { size: opts.size } : {}) };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: opts.wrapText ?? true };
  if (opts.border) cell.border = opts.border;
}

/** Merges row `row` across `totalCols` and writes centred text into it. */
export function addMergedTextRow(
  ws: ExcelJS.Worksheet,
  row: number,
  totalCols: number,
  text: string,
  opts: { size?: number; bold?: boolean; color?: string; fill?: string; height?: number } = {},
): ExcelJS.Cell {
  ws.mergeCells(row, 1, row, totalCols);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = {
    bold: opts.bold ?? true,
    size: opts.size ?? 12,
    ...(opts.color ? { color: { argb: opts.color } } : {}),
  };
  cell.alignment = { horizontal: "center", vertical: "middle" };
  if (opts.fill) cell.fill = solidFill(opts.fill);
  if (opts.height) ws.getRow(row).height = opts.height;
  return cell;
}

/**
 * Company / branch / report-title banner across rows 1-3, with an optional
 * company logo pinned top-left -the header the Attendance Sheet and Daily
 * Report exports both use. Returns the last row it used (3), so callers
 * start their table below it.
 */
export function addTitleBlock(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  opts: {
    totalCols: number;
    company: string;
    branchLabel: string;
    title: string;
    titleFill?: string; // ARGB, default the soft red used on the attendance reports
    logoDataUrl?: string | null; // "data:image/png|jpeg;base64,..." -anything else is ignored
  },
): number {
  addMergedTextRow(ws, 1, opts.totalCols, opts.company, { size: 14 });
  addMergedTextRow(ws, 2, opts.totalCols, opts.branchLabel, { size: 10, bold: false, color: "FF666666" });

  const logo = opts.logoDataUrl;
  if (logo?.startsWith("data:image")) {
    try {
      const match = logo.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
      if (match) {
        const ext = match[1].toLowerCase().startsWith("jp") ? "jpeg" : "png";
        const imageId = wb.addImage({ base64: logo, extension: ext });
        ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 50, height: 50 } });
      }
    } catch {
      // Non-critical -the export continues without the logo.
    }
  }

  addMergedTextRow(ws, 3, opts.totalCols, opts.title, {
    size: 13,
    fill: opts.titleFill ?? "FFE8A9A3",
    height: 24,
  });
  return 3;
}

/** Renders a DOM element to a PDF or PNG and downloads it. */
export async function exportElementToFile(el: HTMLElement, filenameBase: string, format: "pdf" | "png"): Promise<void> {
  // Loaded on demand -only the pages that export a picture/PDF pay for these.
  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import("html2canvas-pro"),
    import("jspdf"),
  ]);
  const canvas = await html2canvas(el, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
  if (format === "png") {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Failed to render image");
    downloadBlob(blob, `${filenameBase}.png`);
    return;
  }
  const pdf = new jsPDF({
    orientation: canvas.width > canvas.height ? "landscape" : "portrait",
    unit: "px",
    format: [canvas.width, canvas.height],
  });
  pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, canvas.width, canvas.height);
  pdf.save(`${filenameBase}.pdf`);
}
