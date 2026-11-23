// Settings -> Casual Leave: the form, its checks (the same as the server's, casual_leave_views._read_policy) and the
// worked examples the tab shows while HR types. The year example follows cl_balance.py's ledger: each month adds its days
// from the month the employee starts, unused days stay for later months only with carry forward, and at 31 December they
// lapse or move into the next year (at most the maximum).
import type {
  CasualLeavePolicy,
  CasualLeavePolicyInput,
  ClAllocation,
  ClEligibilityBasis,
  ClYearEnd,
} from "@/lib/api-client/custom-hooks";

export type ClPolicyForm = {
  eligibilityBasis: ClEligibilityBasis;
  eligibilityValue: string;
  allocation: ClAllocation;
  monthlyAllocation: string;
  yearlyAllocation: string;
  carryForward: boolean;
  yearEnd: ClYearEnd;
  /** "" = no limit */
  yearEndCarryMax: string;
  halfDayAllowed: boolean;
  /** YYYY-MM-DD */
  balanceSince: string;
};

export type ClPolicyField = keyof ClPolicyForm;
export type ClPolicyProblems = Partial<Record<ClPolicyField, string>>;

export const LIMITS = { monthsMax: 120, daysMax: 3650, monthlyMax: 31, yearlyMax: 366 };

/** What a policy that was never saved holds (the server's starting values). */
export const DEFAULT_FORM: ClPolicyForm = {
  eligibilityBasis: "months",
  eligibilityValue: "6",
  allocation: "monthly",
  monthlyAllocation: "1",
  yearlyAllocation: "12",
  carryForward: true,
  yearEnd: "lapse",
  yearEndCarryMax: "",
  halfDayAllowed: true,
  balanceSince: "2026-11-02",
};

export function formFromPolicy(p: CasualLeavePolicy | undefined): ClPolicyForm {
  if (!p) return DEFAULT_FORM;
  return {
    eligibilityBasis: p.eligibilityBasis,
    eligibilityValue: String(p.eligibilityValue),
    allocation: p.allocation,
    monthlyAllocation: String(p.monthlyAllocation),
    yearlyAllocation: String(p.yearlyAllocation),
    carryForward: p.carryForward,
    yearEnd: p.yearEnd,
    yearEndCarryMax: p.yearEndCarryMax == null ? "" : String(p.yearEndCarryMax),
    halfDayAllowed: p.halfDayAllowed,
    balanceSince: p.balanceSince,
  };
}

/** A whole or half number of days from `low` to `high`, or null. */
export function halfDays(text: string, low: number, high: number): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < low || n > high || !Number.isInteger(n * 2)) return null;
  return n;
}

function wholeNumber(text: string, low: number, high: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= low && n <= high ? n : null;
}

export function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}

/** Every problem with the form, by field (empty when it can be saved). The server checks the same things. */
export function validate(f: ClPolicyForm): ClPolicyProblems {
  const out: ClPolicyProblems = {};
  const top = f.eligibilityBasis === "days" ? LIMITS.daysMax : LIMITS.monthsMax;
  if (wholeNumber(f.eligibilityValue, 0, top) === null)
    out.eligibilityValue = `Enter a whole number of ${f.eligibilityBasis} from 0 to ${top}.`;
  const monthly = f.allocation === "monthly";
  const perMonth = halfDays(f.monthlyAllocation, 0.5, LIMITS.monthlyMax);
  const perYear = halfDays(f.yearlyAllocation, 0.5, LIMITS.yearlyMax);
  if (monthly && perMonth === null)
    out.monthlyAllocation = `Enter the days a month from 0.5 to ${LIMITS.monthlyMax} (whole or half days).`;
  if (!monthly && perYear === null)
    out.yearlyAllocation = `Enter the days a year from 0.5 to ${LIMITS.yearlyMax} (whole or half days).`;
  const cap = f.yearEndCarryMax.trim() === "" ? null : halfDays(f.yearEndCarryMax, 0.5, LIMITS.yearlyMax);
  if (f.yearEnd === "carry" && f.yearEndCarryMax.trim() !== "" && cap === null)
    out.yearEndCarryMax = `Enter the most days from 0.5 to ${LIMITS.yearlyMax}, or leave it empty for no limit.`;
  if (f.yearEnd === "carry" && monthly && !f.carryForward)
    out.yearEnd =
      "Unused days can move into the next year only when they carry forward from month to month. Turn on Carry forward, or let them lapse.";
  if (!f.halfDayAllowed) {
    if (monthly && perMonth !== null && !Number.isInteger(perMonth))
      out.monthlyAllocation = "Half days are switched off: give whole days.";
    if (!monthly && perYear !== null && !Number.isInteger(perYear))
      out.yearlyAllocation = "Half days are switched off: give whole days.";
    if (f.yearEnd === "carry" && cap !== null && !Number.isInteger(cap))
      out.yearEndCarryMax = "Half days are switched off: give whole days.";
  }
  if (!isRealDate(f.balanceSince)) out.balanceSince = "Enter a real date.";
  return out;
}

/** The save body. Only what the server needs for the chosen allocation is checked, but both amounts are kept: the one not
 *  in use is sent only when it is valid, so switching back later finds it as it was. */
export function toInput(f: ClPolicyForm): CasualLeavePolicyInput {
  const perMonth = halfDays(f.monthlyAllocation, 0.5, LIMITS.monthlyMax);
  const perYear = halfDays(f.yearlyAllocation, 0.5, LIMITS.yearlyMax);
  const cap = f.yearEndCarryMax.trim() === "" ? null : halfDays(f.yearEndCarryMax, 0.5, LIMITS.yearlyMax);
  return {
    eligibilityBasis: f.eligibilityBasis,
    eligibilityValue: Number(f.eligibilityValue.trim()),
    allocation: f.allocation,
    ...(perMonth !== null ? { monthlyAllocation: perMonth } : {}),
    ...(perYear !== null ? { yearlyAllocation: perYear } : {}),
    carryForward: f.carryForward,
    yearEnd: f.yearEnd,
    yearEndCarryMax: f.yearEnd === "carry" ? cap : null,
    halfDayAllowed: f.halfDayAllowed,
    balanceSince: f.balanceSince,
  };
}

// ── words ──────────────────────────────────────────────────────────────────

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

export const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const daysWord = (n: number): string => `${fmt(n)} day${n === 1 ? "" : "s"}`;

/** "15 Oct 2026" from YYYY-MM-DD. */
export function dayText(iso: string): string {
  if (!isRealDate(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
}

export function serviceText(f: ClPolicyForm): string {
  const n = Number(f.eligibilityValue) || 0;
  const unit = f.eligibilityBasis === "days" ? "day" : "month";
  return `${n} ${unit}${n === 1 ? "" : "s"} of service`;
}

export function allocationText(f: ClPolicyForm): string {
  if (f.allocation === "monthly") {
    const n = halfDays(f.monthlyAllocation, 0.5, LIMITS.monthlyMax) ?? 0;
    return `${daysWord(n)} a month`;
  }
  const n = halfDays(f.yearlyAllocation, 0.5, LIMITS.yearlyMax) ?? 0;
  return `${daysWord(n)} a year`;
}

// ── service: the day someone may start (cl_balance.eligible_from) ───────────────

const toIso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Completed months from `joined` to `on` (both YYYY-MM-DD). */
export function monthsBetween(joined: string, on: string): number {
  const [jy, jm, jd] = joined.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  let months = (y - jy) * 12 + (m - jm);
  if (d < jd) months -= 1;
  return Math.max(0, months);
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** The first day someone who joined on `joined` has `n` months (or days) of service: the server's own rule. */
export function eligibleFrom(joined: string, basis: ClEligibilityBasis, n: number): string {
  if (basis === "days") return addDays(joined, n);
  const [jy, jm, jd] = joined.split("-").map(Number);
  const total = jm - 1 + n;
  const y = jy + Math.floor(total / 12);
  const m = (total % 12) + 1;
  let on = toIso(y, m, Math.min(jd, daysIn(y, m)));
  while (monthsBetween(joined, on) < n) on = addDays(on, 1);
  return on;
}

// ── the year, month by month ──────────────────────────────────────────────────

export type YearMonth = {
  month: number;
  label: string;
  /** false before the employee's start month */
  counts: boolean;
  given: number;
  /** what may be asked for with a date in this month (before this month's own Casual Leave) */
  available: number;
  wanted: number;
  taken: number;
  /** wanted but not available */
  refused: number;
  left: number;
  /** without carry forward: what the month's end takes away */
  lapsed: number;
};

export type YearExample = {
  months: YearMonth[];
  carriedIn: number;
  given: number;
  taken: number;
  leftAtYearEnd: number;
  movesToNextYear: number;
  lapsesAtYearEnd: number;
};

/**
 * The example year the tab draws: someone with the service from `startMonth` (1-12) who would like `wants` days in some
 * months (month -> days). Days of a later month cannot be taken early; a request larger than what is there gets only what
 * is there (the apps and the server refuse the rest).
 */
export function exampleYear(
  f: ClPolicyForm,
  startMonth: number,
  wants: Record<number, number>,
  carriedIn = 0,
): YearExample {
  const monthly = f.allocation === "monthly";
  const perMonth = halfDays(f.monthlyAllocation, 0.5, LIMITS.monthlyMax) ?? 0;
  const perYear = halfDays(f.yearlyAllocation, 0.5, LIMITS.yearlyMax) ?? 0;
  const carries = !monthly || f.carryForward;
  const step = f.halfDayAllowed ? 0.5 : 1;
  let balance = carries ? carriedIn : 0;
  const months: YearMonth[] = [];
  let given = 0;
  let taken = 0;
  for (let m = 1; m <= 12; m += 1) {
    const label = MONTHS[m - 1];
    if (m < startMonth) {
      months.push({
        month: m,
        label,
        counts: false,
        given: 0,
        available: 0,
        wanted: 0,
        taken: 0,
        refused: 0,
        left: 0,
        lapsed: 0,
      });
      continue;
    }
    const add = monthly ? perMonth : m === startMonth ? perYear : 0;
    given += add;
    const available = (carries ? balance : 0) + add;
    const wanted = wants[m] ?? 0;
    // only whole (or half) days can be taken: round what is there down to the step
    const room = Math.floor(available / step) * step;
    const got = Math.min(wanted, room);
    taken += got;
    const left = available - got;
    const lapsed = carries ? 0 : left;
    balance = carries ? left : 0;
    months.push({
      month: m,
      label,
      counts: true,
      given: add,
      available,
      wanted,
      taken: got,
      refused: wanted - got,
      left,
      lapsed,
    });
  }
  const leftAtYearEnd = carries ? balance : 0;
  const cap = f.yearEndCarryMax.trim() === "" ? null : halfDays(f.yearEndCarryMax, 0.5, LIMITS.yearlyMax);
  const moves = f.yearEnd === "carry" && carries ? (cap === null ? leftAtYearEnd : Math.min(leftAtYearEnd, cap)) : 0;
  return {
    months,
    carriedIn: carries ? carriedIn : 0,
    given,
    taken,
    leftAtYearEnd,
    movesToNextYear: moves,
    lapsesAtYearEnd: leftAtYearEnd - moves,
  };
}

/** One plain sentence for the whole policy (the tab's summary at the top). */
export function summary(f: ClPolicyForm): string {
  const who = `Staff with ${serviceText(f)}`;
  let how: string;
  if (f.allocation === "monthly") {
    how = f.carryForward
      ? `earn ${allocationText(f)}; unused days carry forward to later months (a month's days cannot be used before it)`
      : `get ${allocationText(f)}, for that month only`;
  } else {
    how = `get ${allocationText(f)}, to use any time in the year`;
  }
  const half = f.halfDayAllowed ? "Half days count 0.5." : "Full days only.";
  const cap = halfDays(f.yearEndCarryMax, 0.5, LIMITS.yearlyMax);
  const end =
    f.yearEnd === "carry" && (f.allocation === "yearly" || f.carryForward)
      ? `Unused days move into the next year${cap !== null ? ` (at most ${daysWord(cap)})` : ""}.`
      : "Unused days lapse on 31 December.";
  return `${who} ${how}. ${half} ${end}`;
}

export const monthLong = (m: number) => MONTHS_LONG[m - 1];
