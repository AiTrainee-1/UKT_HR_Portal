// Small helpers the Settlement and Missing Punch pages share: dates and money as the portal writes them, and the one
// place a table becomes an Excel download (the workbook plumbing itself is lib/exportUtils).

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_FULL = [
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

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day ("YYYY-MM-DD") of a timestamp, or of a day that is already one. "" when there is none. */
export function localDay(input: string | null | undefined): string {
  if (!input) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "9 Oct 2026" from a day or a timestamp; "-" when there is none. */
export function formatDate(input: string | null | undefined): string {
  const day = localDay(input);
  if (!day) return "-";
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "9 Oct 2026, 10:15 am" from a timestamp; "-" when there is none. */
export function formatDateTime(input: string | null | undefined): string {
  if (!input) return "-";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "-";
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  return `${formatDate(input)}, ${time}`;
}

/** "₹12,500" (paise only when there are some). */
export const formatMoney = (n: number | null | undefined): string =>
  `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** "Apr 2026" from a 1-based month and a year. */
export const monthLabel = (month: number, year: number): string => `${MONTHS[month - 1] ?? "?"} ${year}`;

/** One or two capital letters for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Every word typed must appear somewhere in the haystack (case-insensitive). */
export const matchesWords = (query: string, haystack: string): boolean => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack.toLowerCase();
  return words.every((w) => text.includes(w));
};

/** True when the day is inside [from, to]; an empty bound is open. Days are "YYYY-MM-DD", so text order is date order. */
export const inDayRange = (day: string, from: string, to: string): boolean => {
  if (!from && !to) return true;
  if (!day) return false;
  return (!from || day >= from) && (!to || day <= to);
};

/** "The first day is after the last day", or null when the range is fine. */
export const rangeProblem = (from: string, to: string): string | null =>
  from && to && from > to ? "The start date is after the end date." : null;

/** Distinct non-empty values, sorted, for a filter's options. */
export const distinct = (values: (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));

export type ExportTable = {
  sheet: string;
  title: string;
  headers: string[];
  rows: (string | number | null)[][];
};

/** Writes the table to an .xlsx and downloads it. The workbook library loads only when someone exports. */
export async function downloadTable(table: ExportTable, filenameBase: string): Promise<void> {
  const { addMergedTextRow, downloadWorkbook, fileSafe, newWorkbook, styleHeaderCell, todayStamp } =
    await import("@/lib/exportUtils");
  const wb = newWorkbook();
  const ws = wb.addWorksheet(table.sheet.slice(0, 31));
  const cols = table.headers.length;
  addMergedTextRow(ws, 1, cols, `UKTextiles: ${table.title}`, { size: 14 });
  addMergedTextRow(ws, 2, cols, `Exported ${formatDateTime(new Date().toISOString())}`, {
    size: 10,
    bold: false,
    color: "FF666666",
  });
  const header = ws.addRow(table.headers);
  header.eachCell((cell) => styleHeaderCell(cell, { fill: "FF1B4B6E" }));
  for (const row of table.rows) ws.addRow(row);
  table.headers.forEach((h, i) => {
    const longest = table.rows.reduce((n, r) => Math.max(n, String(r[i] ?? "").length), h.length);
    ws.getColumn(i + 1).width = Math.min(48, Math.max(10, longest + 2));
  });
  await downloadWorkbook(wb, `${fileSafe(filenameBase)}_${todayStamp()}.xlsx`);
}
