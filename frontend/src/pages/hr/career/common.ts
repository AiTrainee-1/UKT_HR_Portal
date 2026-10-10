// Rules shared by the career pages (Promotion, Increment, Documents), kept apart from the screens so they can be tested.

/** Every word typed must appear somewhere in one of the fields (case-insensitive). An empty query matches everything. */
export function matchesWords(query: string, ...fields: (string | number | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields
    .filter((f) => f != null && f !== "")
    .join(" ")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** "₹1,23,456.5": Indian digit grouping, at most two decimals. */
export const formatMoney = (n: number): string => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The distinct, sorted values of one field: the choices of a filter. */
export function distinct(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => compareText(a, b));
}

export type SortDir = "asc" | "desc";

export const compareText = (a: string | null | undefined, b: string | null | undefined): number =>
  (a ?? "").localeCompare(b ?? "", undefined, { sensitivity: "base", numeric: true });

export const compareNumber = (a: number | null | undefined, b: number | null | undefined): number =>
  (a ?? Number.NEGATIVE_INFINITY) - (b ?? Number.NEGATIVE_INFINITY);

/** Sorts a copy by a comparator and applies the direction. The sort is stable, so ties keep their incoming order. */
export function sortBy<T>(rows: T[], compare: (a: T, b: T) => number, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => sign * compare(a.row, b.row) || a.index - b.index)
    .map((x) => x.row);
}

/** One page of a list. A page past the end (after a filter shrank the list) falls back to the last real page. */
export function pageOf<T>(rows: T[], page: number, size: number): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), totalPages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, totalPages };
}

// ─── Percentage -> new salary, exactly as the server works it out ───────────────────────────────────────────────────

/** Rounds num/den (both positive) to a whole number, ties to the even neighbour: what Python's Decimal.quantize does. */
function divideHalfEven(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den) return q + 1n;
  if (r2 === den) return q % 2n === 0n ? q : q + 1n;
  return q;
}

export type PercentCheck = { ok: true; value: number } | { ok: false; message: string };

export const MAX_INCREMENT_PERCENT = 500;
/** A rise this large is allowed but worth a second look. */
export const HIGH_INCREMENT_PERCENT = 30;

/** Checks what was typed in the percentage box. Empty is "not entered yet", not an error to shout about. */
export function checkPercent(text: string): PercentCheck {
  const t = text.trim().replace(/^\+/, "");
  if (t === "") return { ok: false, message: "Enter the increment percentage." };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return { ok: false, message: "Enter a number, for example 7.5." };
  const value = Number(t);
  if (value <= 0) return { ok: false, message: "The percentage must be more than 0." };
  if (value > MAX_INCREMENT_PERCENT)
    return { ok: false, message: `The percentage cannot be more than ${MAX_INCREMENT_PERCENT}.` };
  const decimals = t.split(".")[1]?.length ?? 0;
  if (decimals > 4) return { ok: false, message: "Use at most 4 decimal places." };
  return { ok: true, value };
}

/**
 * The salary after a percentage increment: current x (1 + percent/100) rounded to the paisa, ties to even. This is the
 * server's own arithmetic (growth_views.add_increment) done in whole paise, so the preview shows the figure that will
 * be saved, to the paisa. Returns null for a percentage that does not pass `checkPercent`.
 */
export function projectSalary(
  currentSalary: number,
  percentText: string,
): { newSalary: number; increase: number } | null {
  const check = checkPercent(percentText);
  if (!check.ok || !Number.isFinite(currentSalary) || currentSalary < 0) return null;
  const text = percentText.trim().replace(/^\+/, "");
  const [whole, frac = ""] = text.split(".");
  const scale = 10n ** BigInt(frac.length);
  const pct = BigInt(`${whole || "0"}${frac}`);
  const currentPaise = BigInt(Math.round(currentSalary * 100));
  const newPaise = divideHalfEven(currentPaise * (100n * scale + pct), 100n * scale);
  return { newSalary: Number(newPaise) / 100, increase: Number(newPaise - currentPaise) / 100 };
}

// ─── Excel export ───────────────────────────────────────────────────────────────────────────────────────────────────

export type SheetCell = string | number | null | undefined;

/** Downloads rows as an .xlsx with a title line and a styled header row. The Excel library loads only when this is called. */
export async function exportSheet(opts: {
  filename: string;
  title: string;
  headers: string[];
  rows: SheetCell[][];
  widths?: number[];
}): Promise<void> {
  const { downloadWorkbook, newWorkbook, styleHeaderCell, addMergedTextRow, todayStamp } =
    await import("@/lib/exportUtils");
  const wb = newWorkbook();
  const ws = wb.addWorksheet(opts.title.slice(0, 31));
  addMergedTextRow(ws, 1, opts.headers.length, opts.title, { size: 14 });
  const header = ws.getRow(3);
  opts.headers.forEach((h, i) => {
    const cell = header.getCell(i + 1);
    cell.value = h;
    styleHeaderCell(cell, { fill: "FF1E40AF" });
  });
  opts.rows.forEach((row) => ws.addRow(row.map((c) => c ?? "")));
  opts.headers.forEach((_, i) => {
    ws.getColumn(i + 1).width = opts.widths?.[i] ?? 18;
  });
  await downloadWorkbook(wb, `${opts.filename}-${todayStamp()}.xlsx`);
}
