// Display formatting for Report Center cells. Pure functions, mirrored by the PDF/Excel writers
// on the server (api/reporting/export_*.py) so the screen, the printout and the spreadsheet agree.

export type ColumnType =
  | "text"
  | "integer"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "time"
  | "datetime"
  | "badge"
  | "hours"
  | "minutes"
  | "duration";

export const NUMERIC_TYPES: ColumnType[] = ["integer", "number", "currency", "percent", "hours", "minutes", "duration"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 1234567.891 -> "12,34,567.89" (lakh / crore grouping). */
export function indianNumber(value: number, places = 2): string {
  if (!Number.isFinite(value)) return "";
  const negative = value < 0;
  const [whole, frac] = Math.abs(value).toFixed(places).split(".");
  let head = whole;
  if (whole.length > 3) {
    const tail = whole.slice(-3);
    let rest = whole.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest) parts.unshift(rest);
    head = `${parts.join(",")},${tail}`;
  }
  const text = places > 0 ? `${head}.${frac}` : head;
  return negative ? `-${text}` : text;
}

/** 125 -> "2h 05m", 45 -> "45m". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return "";
  const total = Math.round(minutes);
  const sign = total < 0 ? "-" : "";
  const abs = Math.abs(total);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h ? `${sign}${h}h ${String(m).padStart(2, "0")}m` : `${sign}${m}m`;
}

/** "2026-09-05" -> "05-Sep-2026". Anything that is not an ISO date is returned unchanged. */
export function formatDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${m[3]}-${month}-${m[1]}` : value;
}

/** "2026-09-05 14:30" -> "05-Sep-2026 14:30". */
export function formatDateTime(value: string): string {
  const date = formatDate(value);
  const time = /[ T](\d{2}:\d{2})/.exec(value);
  return time ? `${date} ${time[1]}` : date;
}

/** The text shown in a table cell (empty values render as an em dash). */
export function formatCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number" || (typeof value === "string" && NUMERIC_TYPES.includes(type))) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      switch (type) {
        case "currency":
          return `₹${indianNumber(n)}`;
        case "number":
          return indianNumber(n);
        case "integer":
        case "minutes":
          return indianNumber(n, 0);
        case "percent":
          return `${n.toFixed(1)}%`;
        case "hours":
          return n.toFixed(2);
        case "duration":
          return formatDuration(n);
        default:
          break;
      }
    }
  }
  switch (type) {
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    case "time":
      return String(value).slice(0, 5);
    default:
      return String(value);
  }
}

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_WORDS: Record<Tone, string[]> = {
  success: [
    "approved",
    "present",
    "active",
    "paid",
    "returned",
    "closed",
    "completed",
    "done",
    "on time",
    "confirmed",
    "verified",
    "yes",
    "sent",
    "processed",
    "eligible",
  ],
  warning: [
    "pending",
    "late",
    "half day",
    "half-day",
    "partial",
    "hold",
    "on hold",
    "in progress",
    "not returned",
    "inside",
    "probation",
    "draft",
    "expired",
    "overdue",
    "outside now",
    "provisional",
    "in progress",
  ],
  danger: [
    "rejected",
    "absent",
    "cancelled",
    "failed",
    "denied",
    "lop",
    "terminated",
    "missing",
    "no",
    "overtime",
    "long break",
    "left open",
    "not sent",
    "deactivated",
    "lockout triggered",
  ],
  info: [
    "on duty",
    "on-duty",
    "holiday",
    "weekly off",
    "week off",
    "leave",
    "casual leave",
    "sick leave",
    "permission",
    "info",
    "first visit",
    "repeat",
    "employee",
    "free text",
  ],
  neutral: [],
};

/** Picks a colour tone for a status word. Unknown words are neutral. */
export function badgeTone(text: string): Tone {
  const t = text.trim().toLowerCase();
  for (const tone of ["danger", "warning", "success", "info"] as Tone[]) {
    if (TONE_WORDS[tone].includes(t)) return tone;
  }
  return "neutral";
}

export function isNumericType(type: ColumnType): boolean {
  return NUMERIC_TYPES.includes(type);
}

export type SortDir = "asc" | "desc";

/** Sorts data rows by a column; structural rows (subtotal/total) keep their place after their group,
 *  so sorting is applied to runs of data rows between them. Nulls always sort last. */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  key: string,
  dir: SortDir,
  type: ColumnType,
): T[] {
  const numeric = isNumericType(type);
  const cmp = (a: T, b: T): number => {
    const av = a[key];
    const bv = b[key];
    const aNull = av === null || av === undefined || av === "";
    const bNull = bv === null || bv === undefined || bv === "";
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    const r = numeric
      ? Number(av) - Number(bv)
      : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
    return dir === "asc" ? r : -r;
  };
  const out: T[] = [];
  let run: T[] = [];
  const flush = () => {
    out.push(...[...run].sort(cmp));
    run = [];
  };
  for (const r of rows) {
    if (r._kind === "subtotal" || r._kind === "total") {
      flush();
      out.push(r);
    } else run.push(r);
  }
  flush();
  return out;
}

/** Case-insensitive "contains" match across the visible text of a row. */
export function rowMatches(row: Record<string, unknown>, keys: string[], needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return keys.some((k) => {
    const v = row[k];
    return v !== null && v !== undefined && String(v).toLowerCase().includes(n);
  });
}
