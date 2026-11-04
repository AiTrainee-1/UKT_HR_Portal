// Carry Forward (owner 2026-11-04): the yearly Casual Leave balance stays a fixed 12. "Deduct days": HR enters how many days
// at most, the system detects the employee's ABSENT and ON LEAVE days of a month, and HR picks that many of them (or fewer);
// only the picked dates become Casual Leave and the balance goes down by their number (the number is a limit, never a
// deduction of its own). Every round is kept in a log with the balance before and after. The rules live in
// backend/api/cl_adjustment_views.py (this year up to today, staff with 6 months, a reason always, all or nothing); this
// only reads back what the API says and words it. HR portal only for now: the employee apps just show the new balance.

import type { CasualLeaveBalance } from "@/lib/api-client/custom-hooks";
import { ALL, matchesPerson, matchesQuery, type PersonFields, type PersonFilters } from "../leave/logic";
import type { BoardRow } from "./logic";

/** One round of the log: some absent / leave dates of one employee given as Casual Leave. `days` = minus their number. */
export type ClAdjustment = {
  id: number;
  employeeId: number;
  employeeCode: string | null;
  employeeName: string | null;
  department: string | null;
  branch: string | null;
  year: number;
  days: number;
  dates: string[];
  reason: string;
  balanceBefore: number;
  balanceAfter: number;
  createdBy: string | null;
  createdAt: string | null;
};

export type ClAdjustmentLog = {
  year: number;
  items: ClAdjustment[];
  total: number;
  page: number;
  pageSize: number;
  summary: { changes: number; employees: number; days: number };
};

/** A refused save: nothing was changed, and why for each employee that needs a look. */
export type ClAdjustProblem = { employeeId: number; employeeName?: string | null; error: string };

/** One employee on the Carry Forward list: a staff row of the board that has a balance for the year. */
export type CarryRow = BoardRow & { balance: CasualLeaveBalance };

/** A day that can be given as Casual Leave: marked Absent, or On Leave ("On Leave · Sick Leave"). */
export type DetectedDay = { date: string; weekday: string; status: "absent" | "on_leave"; label: string };

/** Every day of the month as the attendance has it (`selectable` = absent / on leave and no Casual Leave on it yet). */
export type CalendarStatus = "absent" | "on_leave" | "present" | "half_shift" | "holiday" | "cl" | "none" | "future";
export type CalendarDay = { date: string; weekday: string; status: CalendarStatus; selectable: boolean; label: string };

/** GET /api/casual-leaves/absent-dates. */
export type Detection = {
  year: number;
  month: number;
  monthLabel: string;
  monthStart: string;
  monthEnd: string;
  lastDay: string | null;
  /** false for a month of another year, or one still to come */
  assignable: boolean;
  employees: {
    employeeId: number;
    balance: CasualLeaveBalance | null;
    absent: DetectedDay[];
    onLeave: DetectedDay[];
    dates: DetectedDay[];
    calendar: CalendarDay[];
  }[];
};

/** POST /api/casual-leaves/assign answer: one log line per employee. */
export type ClAssignSaved = { count: number; days: number; items: ClAdjustment[] };

export const MAX_LIMIT = 31;
export const REASON_MIN = 3;
export const REASON_MAX = 300;

const round = (n: number) => Math.round(n * 100) / 100;

/** 3 -> "3", 1.5 -> "1.5". */
export const daysNumber = (n: number): string => String(round(n));

/** "1 day", "2.5 days". */
export const daysWord = (n: number): string => `${daysNumber(Math.abs(n))} day${Math.abs(n) === 1 ? "" : "s"}`;

/** The staff who have a balance for the year, in the board's order. */
export function carryRows(board: BoardRow[]): CarryRow[] {
  return board.filter((r): r is CarryRow => !!r.balance && r.balance.tracked);
}

/** The quick filter of the list. */
export type CarryView = "all" | "left" | "none-left";

export function matchesView(r: CarryRow, view: string): boolean {
  if (view === "left") return r.balance.remaining > 0;
  if (view === "none-left") return r.balance.remaining <= 0;
  return true;
}

export function filterCarry(rows: CarryRow[], f: PersonFilters, view: string = ALL): CarryRow[] {
  return rows.filter((r) => matchesView(r, view) && matchesPerson(r, f));
}

export function carryCounts(rows: CarryRow[]): Record<CarryView, number> {
  return {
    all: rows.length,
    left: rows.filter((r) => matchesView(r, "left")).length,
    "none-left": rows.filter((r) => matchesView(r, "none-left")).length,
  };
}

/** The most days HR allows for an employee: a whole number from 1 to 31 (null with no error while blank). */
export function parseLimit(input: string): { limit: number | null; error: string | null } {
  const text = input.trim();
  if (text === "") return { limit: null, error: null };
  if (!/^\d+$/.test(text)) return { limit: null, error: "Whole days only, e.g. 3" };
  const n = Number(text);
  if (n < 1) return { limit: null, error: "At least 1 day" };
  if (n > MAX_LIMIT) return { limit: null, error: `At most ${MAX_LIMIT} days` };
  return { limit: n, error: null };
}

/** One employee's line: the most days, the detected days on offer, the ones picked, what is left after. */
export type PickLine = {
  row: CarryRow;
  input: string;
  limit: number | null;
  available: DetectedDay[];
  picked: string[];
  before: number;
  after: number;
  /** Why it cannot be saved yet (null = ready). */
  error: string | null;
};

export function pickLines(
  rows: CarryRow[],
  inputs: (row: CarryRow) => string,
  available: (row: CarryRow) => DetectedDay[],
  picked: (row: CarryRow) => string[],
  monthLabel: string,
): PickLine[] {
  return rows.map((row) => {
    const input = inputs(row);
    const parsed = parseLimit(input);
    const days = available(row);
    const chosen = picked(row);
    const before = row.balance.remaining;
    let error = parsed.error;
    if (!error && parsed.limit === null) error = "Enter the days";
    else if (!error && parsed.limit !== null && parsed.limit > before)
      error =
        before <= 0 ? "No Casual Leave left" : `Only ${daysWord(before)} left: enter ${daysNumber(before)} at most`;
    else if (!error && days.length === 0) error = `No absent or leave days in ${monthLabel}`;
    else if (!error && chosen.length === 0) error = "Pick at least one date";
    return {
      row,
      input,
      limit: parsed.limit,
      available: days,
      picked: chosen,
      before,
      after: Math.max(0, before - chosen.length),
      error,
    };
  });
}

/** Tick or untick a date, never past the limit; a tick beyond it does nothing. */
export function togglePick(picked: string[], date: string, limit: number | null): string[] {
  if (picked.includes(date)) return picked.filter((d) => d !== date);
  if (limit === null || picked.length >= limit) return picked;
  return [...picked, date];
}

/** "2 of 3 picked". */
export const pickedText = (picked: number, limit: number | null): string =>
  limit === null ? `${picked} picked` : `${picked} of ${limit} picked`;

const monthShort = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { month: "short" });
};

/** "Tue 7 Oct" from "2026-10-07". */
export function chipDate(iso: string, weekday?: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = weekday ?? new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short" });
  return `${wd} ${d} ${monthShort(iso)}`;
}

/** "07 Oct, 13 Oct" for a log line. */
export const datesText = (dates: string[]): string =>
  dates.map((iso) => `${iso.slice(8, 10)} ${monthShort(iso)}`).join(", ");

/** The save button's words: "Assign CL to 2 dates", "Assign CL for 3 employees". */
export function assignLabel(lines: PickLine[]): string {
  if (lines.length === 1) {
    const n = lines[0].picked.length;
    return n ? `Assign CL to ${n} date${n === 1 ? "" : "s"}` : "Pick the dates";
  }
  return `Assign CL for ${lines.length} employees`;
}

/** The toast after the dates were given as Casual Leave. */
export function assignedText(saved: ClAssignSaved): string {
  if (saved.items.length === 1) {
    const a = saved.items[0];
    const n = a.dates.length;
    return `${a.employeeName ?? a.employeeCode}: ${n} day${n === 1 ? "" : "s"} (${datesText(a.dates)}) now Casual Leave. ${daysNumber(a.balanceBefore)} → ${daysNumber(a.balanceAfter)} left.`;
  }
  return `${saved.days} days of ${saved.items.length} employees are now Casual Leave. Each is in the Change log.`;
}

/** The month the detection opens on: the page's month when it is of this year and not still to come, else this month. */
export function pickerMonth(
  year: number,
  month: number,
  today: { year: number; month: number },
): { year: number; month: number } {
  if (year === today.year && month <= today.month) return { year, month };
  return { year: today.year, month: today.month };
}

export const reasonError = (reason: string): string | null => {
  const n = reason.trim().length;
  if (n < REASON_MIN) return `Write a reason (at least ${REASON_MIN} characters): it is kept with every change`;
  if (n > REASON_MAX) return `At most ${REASON_MAX} characters`;
  return null;
};

/**
 * The 12 days of the year as segments: used, waiting, picked now, left. Each segment is one day; a half day fills half of
 * one. Returns, per segment, the share of each kind (they add up to 1).
 */
export type SegmentPart = "used" | "pending" | "picked" | "left";
export function balanceSegments(
  balance: Pick<CasualLeaveBalance, "total" | "used" | "pending">,
  picked: number,
): { part: SegmentPart; share: number }[][] {
  const edges: [SegmentPart, number][] = [
    ["used", balance.used],
    ["pending", balance.used + balance.pending],
    ["picked", balance.used + balance.pending + picked],
    ["left", balance.total],
  ];
  return Array.from({ length: balance.total }, (_, i) => {
    const parts: { part: SegmentPart; share: number }[] = [];
    let from = i;
    for (const [part, upTo] of edges) {
      const share = Math.max(0, Math.min(i + 1, upTo) - from);
      if (share > 0) {
        parts.push({ part, share: round(share) });
        from += share;
      }
    }
    return parts;
  });
}

/** Mon-first weeks of the month for the calendar: leading blanks (null) then the days. */
export function calendarWeeks(days: CalendarDay[]): (CalendarDay | null)[][] {
  if (days.length === 0) return [];
  const [y, m, d] = days[0].date.split("-").map(Number);
  const lead = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday = 0
  const cells: (CalendarDay | null)[] = [...Array(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

// ─── the change log ───

export function filterLog(items: ClAdjustment[], query: string): ClAdjustment[] {
  return items.filter((a) =>
    matchesQuery(query, a.employeeName, a.employeeCode, a.department, a.branch, a.reason, a.createdBy),
  );
}

/** "04 Nov 2026, 3:15 pm" in the browser's clock (IST in the factory). */
export function whenText(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── exports ───

export const CARRY_EXPORT_HEADERS = [
  "Employee code",
  "Employee",
  "Branch",
  "Department",
  "Days a year",
  "Used",
  "Waiting",
  "Left now",
];

export function carryExportRows(rows: CarryRow[]): (string | number)[][] {
  return rows.map((r) => [
    r.employeeCode ?? "",
    r.employeeName ?? "",
    r.branch ?? "",
    r.department ?? "",
    r.balance.total,
    r.balance.used,
    r.balance.pending,
    r.balance.remaining,
  ]);
}

export const LOG_EXPORT_HEADERS = [
  "When",
  "Employee code",
  "Employee",
  "Branch",
  "Department",
  "Dates given as Casual Leave",
  "Days",
  "Left before",
  "Left after",
  "Reason",
  "By",
];

export function logExportRows(items: ClAdjustment[]): (string | number)[][] {
  return items.map((a) => [
    whenText(a.createdAt),
    a.employeeCode ?? "",
    a.employeeName ?? "",
    a.branch ?? "",
    a.department ?? "",
    datesText(a.dates),
    a.dates.length,
    a.balanceBefore,
    a.balanceAfter,
    a.reason,
    a.createdBy ?? "",
  ]);
}

/** Who a log line is about, as PersonCell wants it. */
export const logPerson = (a: ClAdjustment): PersonFields => ({
  employeeId: a.employeeId,
  employeeName: a.employeeName,
  employeeCode: a.employeeCode,
  department: a.department,
  branch: a.branch,
});
