// Dates for the career pages (Promotion, Increment, Documents). Every date here is a plain "YYYY-MM-DD" string, the way
// the API sends it, so comparing two of them as text is the same as comparing the days. Nothing goes through
// `new Date("2026-03-01")`, which reads as UTC and shifts a day in some time zones.

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Today as YYYY-MM-DD in the browser's own time zone (toISOString() would give the UTC day: yesterday after midnight in India). */
export function todayYmd(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export type Ymd = { y: number; m: number; d: number };

/** "2026-03-01" (or an ISO timestamp starting with it) -> parts. Anything else, or a day that does not exist, is null. */
export function parseYmd(value: string | null | undefined): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(y, m - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Whole months from one day to a later one (a month counts once its day-of-month has been reached). Negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number | null {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (!a || !b) return null;
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  return months;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-01" -> "1 Mar 2026". Unreadable input is shown as a dash. */
export function formatDate(value: string | null | undefined): string {
  const p = parseYmd(value);
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : "-";
}

/** "2026-03-01" -> "Mar 2026" (axis labels, month groups). */
export function formatMonth(value: string | null | undefined): string {
  const p = parseYmd(value);
  return p ? `${MONTHS[p.m - 1]} ${p.y}` : "-";
}

/** A whole number of months as people say it: 12 -> "1 year", 24 -> "2 years", 18 -> "18 months". */
export const monthsLabel = (m: number): string =>
  m > 0 && m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`;

/** 0 -> "under a month", 5 -> "5 months", 14 -> "1 yr 2 mo", 24 -> "2 yrs". */
export function tenureLabel(months: number | null | undefined): string {
  if (months == null || Number.isNaN(months)) return "-";
  if (months < 1) return "under a month";
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const y = `${years} ${years === 1 ? "yr" : "yrs"}`;
  return rest ? `${y} ${rest} mo` : y;
}

export type Period = "all" | "this_month" | "last_3_months" | "this_year" | "last_year" | "custom";

export const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "this_month", label: "This month" },
  { value: "last_3_months", label: "Last 3 months" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom range" },
];

export type DateRange = { from: string | null; to: string | null };

/** The first and last day a period covers, as YYYY-MM-DD (null = no limit on that side). Years are calendar years. */
export function periodRange(period: Period, today: string, custom?: DateRange): DateRange {
  const t = parseYmd(today);
  if (!t) return { from: null, to: null };
  switch (period) {
    case "this_month":
      return { from: `${t.y}-${pad2(t.m)}-01`, to: `${t.y}-${pad2(t.m)}-31` };
    case "last_3_months": {
      // today and the two calendar months before it, from the 1st
      const total = t.y * 12 + (t.m - 1) - 2;
      return { from: `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}-01`, to: `${t.y}-${pad2(t.m)}-31` };
    }
    case "this_year":
      return { from: `${t.y}-01-01`, to: `${t.y}-12-31` };
    case "last_year":
      return { from: `${t.y - 1}-01-01`, to: `${t.y - 1}-12-31` };
    case "custom":
      return { from: custom?.from || null, to: custom?.to || null };
    default:
      return { from: null, to: null };
  }
}

/** Is the day inside the range? A missing side is open. Unreadable days are never inside a bounded range. */
export function inRange(value: string | null | undefined, range: DateRange): boolean {
  if (!range.from && !range.to) return true;
  const p = parseYmd(value);
  if (!p) return false;
  const day = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

export const yearOf = (value: string | null | undefined): number | null => parseYmd(value)?.y ?? null;
/** "2026-03" for grouping by month. */
export const monthKey = (value: string | null | undefined): string | null => {
  const p = parseYmd(value);
  return p ? `${p.y}-${pad2(p.m)}` : null;
};
