// Formatting shared by every payroll screen. Dates arrive as plain ISO days ("2026-10-13") and are never run through
// `new Date("2026-10-13")` (that is UTC midnight, which is the day before in some zones): they are split by hand.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
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
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Ymd = { year: number; month: number; day: number };

export function parseIso(iso: string | null | undefined): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

/** Rupees, whole: "₹24,000". Null / NaN read as a dash. */
export function inr(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}

/** Rupees with paise: "₹24,000.50". */
export const inr2 = (value: number | null | undefined): string => inr(value, 2);

/** A plain number with Indian grouping and fixed decimals, no currency sign (the statement's columns). */
export function num(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** "13 Oct 2026". */
export function dateShort(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${d.day} ${MONTHS[d.month - 1]} ${d.year}` : "—";
}

/** "13 Oct". */
export function dayMonth(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${d.day} ${MONTHS[d.month - 1]}` : "—";
}

/** "Tue, 13 Oct 2026". */
export function dateLong(iso: string | null | undefined): string {
  const d = parseIso(iso);
  if (!d) return "—";
  const weekday = WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()];
  return `${weekday}, ${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}

/** "Tue". */
export function weekdayShort(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()] : "";
}

/** "01-09-2026": the printed statement's date format. */
export function ddmmyyyy(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${String(d.day).padStart(2, "0")}-${String(d.month).padStart(2, "0")}-${d.year}` : "—";
}

/** "2 Feb - 8 Feb 2026" / "29 Dec 2026 - 4 Jan 2027". */
export function periodLabel(start: string | null | undefined, end: string | null | undefined): string {
  const a = parseIso(start);
  const b = parseIso(end);
  if (!a || !b) return "—";
  const from = a.year === b.year ? `${a.day} ${MONTHS[a.month - 1]}` : `${a.day} ${MONTHS[a.month - 1]} ${a.year}`;
  return `${from} - ${b.day} ${MONTHS[b.month - 1]} ${b.year}`;
}

/** "October 2026". */
export function monthYear(month: number, year: number): string {
  return `${MONTHS_LONG[month - 1] ?? ""} ${year}`.trim();
}

/** "13 Oct 2026, 10:42" from an ISO datetime, in the viewer's own time zone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`;
}

/** "3 days ago" style, for "flagged by payroll ..." lines. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const minutes = Math.round((now.getTime() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** "1 day" / "2 days"; halves read as "1.5 days". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} ${n === 1 ? one : many}`;
}

/** A file name stem that is safe on every system: "Salary_Statement_Oct_2026". */
export const fileStem = (...parts: (string | number | null | undefined)[]): string =>
  parts
    .filter((p) => p !== null && p !== undefined && String(p).length > 0)
    .join("_")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
