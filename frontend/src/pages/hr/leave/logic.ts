// Leave & Holiday: the rules behind the page (search, filters, summaries, the who-is-on-leave calendar, holiday and
// balance maths), kept apart from the screens so they can be tested on their own.

import type { ApprovalProgress } from "@/lib/approval-workflow";

// ─── Shapes: what the lists carry beyond the generated client types (branch / department ids and the employee's
//     type were added to the API for these filters; an older backend leaves them out, which every rule tolerates) ───

export type LeaveRow = {
  id: number;
  employeeId: number;
  employeeName?: string | null;
  employeeCode?: string | null;
  department?: string | null;
  designation?: string | null;
  departmentId?: number | null;
  branchId?: number | null;
  branch?: string | null;
  employmentType?: string | null;
  type: string;
  startDate: string;
  endDate: string;
  totalDays?: number | null;
  isHalfDay?: boolean;
  halfDaySlot?: "morning" | "afternoon" | null;
  reason?: string | null;
  status: string;
  hrComment?: string | null;
  approvedBy?: string | null;
  approverRole?: string | null;
  createdAt?: string | null;
  approval?: ApprovalProgress | null;
};

/** The employee fields every list carries, whichever kind of request it is. */
export type PersonFields = {
  employeeId: number;
  employeeName?: string | null;
  employeeCode?: string | null;
  department?: string | null;
  designation?: string | null;
  departmentId?: number | null;
  branchId?: number | null;
  branch?: string | null;
  employmentType?: string | null;
};

// ─── Dates (plain "YYYY-MM-DD" strings; never through the browser's timezone) ───

const pad = (n: number) => String(n).padStart(2, "0");

export const isoDate = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** The first ten characters when they look like a date, else null (a blank, a time-stamped value, junk). */
export function dateOnly(value: string | null | undefined): string | null {
  const head = (value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
}

const toUtc = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Whole days from `a` to `b` (b - a). */
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / 86_400_000);

export function addDays(iso: string, n: number): string {
  const d = new Date(toUtc(iso) + n * 86_400_000);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(iso: string): number {
  return (new Date(toUtc(iso)).getUTCDay() + 6) % 7;
}

export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export const MONTHS = [
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
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
export const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function shiftMonth(year: number, month: number, delta: number) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** "Mon, 5 Oct 2026". */
export function longDate(iso: string | null | undefined): string {
  const d = dateOnly(iso);
  if (!d) return "-";
  const [y, m, day] = d.split("-").map(Number);
  return `${WEEKDAYS_SHORT[weekdayIndex(d)]}, ${day} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/** "5 Oct" (same year as `ref`) or "5 Oct 2026". */
export function shortDate(iso: string | null | undefined, refYear?: number): string {
  const d = dateOnly(iso);
  if (!d) return "-";
  const [y, m, day] = d.split("-").map(Number);
  return y === refYear ? `${day} ${MONTHS_SHORT[m - 1]}` : `${day} ${MONTHS_SHORT[m - 1]} ${y}`;
}

// ─── Search: every word must appear somewhere ───

export function matchesQuery(query: string, ...fields: (string | number | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields
    .filter((f) => f !== null && f !== undefined)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const ALL = "all";

export type PersonFilters = {
  query: string;
  /** "all" or an id (as text) of a branch. */
  branch: string;
  department: string;
  /** "all", "staff" or "production". */
  employeeType: string;
};

export const NO_PERSON_FILTERS: PersonFilters = { query: "", branch: ALL, department: ALL, employeeType: ALL };

export function matchesPerson(p: PersonFields, f: PersonFilters): boolean {
  if (f.branch !== ALL && String(p.branchId ?? "") !== f.branch) return false;
  if (f.department !== ALL && String(p.departmentId ?? "") !== f.department) return false;
  if (f.employeeType !== ALL && (p.employmentType ?? "") !== f.employeeType) return false;
  return matchesQuery(f.query, p.employeeName, p.employeeCode, p.department, p.designation, p.branch, p.employmentType);
}

export type Option = { value: string; label: string };

/** The distinct branches / departments among some rows, as filter options (A to Z). Only ones that actually occur. */
export function branchOptions(rows: PersonFields[]): Option[] {
  const seen = new Map<string, string>();
  for (const r of rows) if (r.branchId != null && r.branch) seen.set(String(r.branchId), r.branch);
  return sortedOptions(seen);
}

export function departmentOptions(rows: PersonFields[]): Option[] {
  const seen = new Map<string, string>();
  for (const r of rows) if (r.departmentId != null && r.department) seen.set(String(r.departmentId), r.department);
  return sortedOptions(seen);
}

const sortedOptions = (seen: Map<string, string>): Option[] =>
  [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));

// ─── Leave requests ───

export type LeaveFilters = PersonFilters & {
  status: string;
  /** "all" or a leave type (sick, casual, ...). */
  type: string;
  /** Requests whose dates touch [from, to]; either end may be blank. */
  from: string;
  to: string;
};

export const NO_LEAVE_FILTERS: LeaveFilters = { ...NO_PERSON_FILTERS, status: ALL, type: ALL, from: "", to: "" };

/** Do [start, end] and [from, to] share a day? A blank `from` / `to` is open-ended. */
export function overlapsRange(start: string, end: string, from: string, to: string): boolean {
  const s = dateOnly(start);
  const e = dateOnly(end) ?? s;
  if (!s || !e) return !from && !to;
  if (from && e < from) return false;
  if (to && s > to) return false;
  return true;
}

/** Days a request covers: the server's count when it sent one, else the calendar span; a half day is 0.5. */
export function leaveDays(l: Pick<LeaveRow, "totalDays" | "startDate" | "endDate" | "isHalfDay">): number {
  if (l.isHalfDay) return l.totalDays ?? 0.5;
  if (l.totalDays != null) return l.totalDays;
  const s = dateOnly(l.startDate);
  const e = dateOnly(l.endDate);
  return s && e ? Math.max(1, daysBetween(s, e) + 1) : 1;
}

export function filterLeaves(rows: LeaveRow[], f: LeaveFilters): LeaveRow[] {
  return rows.filter(
    (l) =>
      (f.status === ALL || l.status === f.status) &&
      (f.type === ALL || l.type === f.type) &&
      overlapsRange(l.startDate, l.endDate, f.from, f.to) &&
      matchesPerson(l, f),
  );
}

export const leaveFiltersActive = (f: LeaveFilters) =>
  f.query.trim() !== "" ||
  f.status !== ALL ||
  f.type !== ALL ||
  f.from !== "" ||
  f.to !== "" ||
  f.branch !== ALL ||
  f.department !== ALL ||
  f.employeeType !== ALL;

export const personFiltersActive = (f: PersonFilters) =>
  f.query.trim() !== "" || f.branch !== ALL || f.department !== ALL || f.employeeType !== ALL;

/** What needs a decision comes first (oldest request first: it has waited longest), then the newest leave. */
export function sortLeaves(rows: LeaveRow[]): LeaveRow[] {
  return [...rows].sort((a, b) => {
    const pa = a.status === "pending" ? 0 : 1;
    const pb = b.status === "pending" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (pa === 0) return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id;
    return (dateOnly(b.startDate) ?? "").localeCompare(dateOnly(a.startDate) ?? "") || b.id - a.id;
  });
}

export function leaveTypesOf(rows: LeaveRow[]): string[] {
  return [...new Set(rows.map((r) => r.type).filter(Boolean))].sort();
}

export type LeaveSummary = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  /** Days of approved leave among these rows. */
  approvedDays: number;
  /** Employees with approved leave covering today. */
  onLeaveToday: number;
};

export function summarizeLeaves(rows: LeaveRow[], today: string): LeaveSummary {
  const away = new Set<number>();
  let approvedDays = 0;
  for (const l of rows) {
    if (l.status !== "approved") continue;
    approvedDays += leaveDays(l);
    if (overlapsRange(l.startDate, l.endDate, today, today)) away.add(l.employeeId);
  }
  return {
    total: rows.length,
    pending: rows.filter((l) => l.status === "pending").length,
    approved: rows.filter((l) => l.status === "approved").length,
    rejected: rows.filter((l) => l.status === "rejected").length,
    approvedDays,
    onLeaveToday: away.size,
  };
}

/** "Morning (First Half)" and "Afternoon (Second Half)". */
export const HALF_DAY_LABEL: Record<string, string> = {
  morning: "Morning (First Half)",
  afternoon: "Afternoon (Second Half)",
};

/** "Approved by Suresh (Dept Head)" / "Rejected by Meena (HR)", or null while nobody has decided. */
export function decidedByLine(
  l: Pick<LeaveRow, "status" | "approvedBy" | "approverRole">,
  long = false,
): string | null {
  if (!l.approvedBy) return null;
  const role = l.approverRole === "dept_head" ? (long ? "Department Head" : "Dept Head") : "HR";
  return `${l.status === "rejected" ? "Rejected" : "Approved"} by ${l.approvedBy} (${role})`;
}

// ─── Permissions ───

export type PermissionRow = PersonFields & {
  id: number;
  date: string;
  permissionTime?: string | null;
  reason?: string | null;
  type?: string | null;
  typeKey?: string | null;
  status: string;
  capStatus?: string | null;
};

export type PermissionFilters = PersonFilters & {
  /** "all", pending, approved, excess (approved beyond the monthly cap) or rejected. */
  status: string;
  /** "all", a type key, or "none" (not yet typed). */
  type: string;
  from: string;
  to: string;
};

export const NO_PERMISSION_FILTERS: PermissionFilters = {
  ...NO_PERSON_FILTERS,
  status: ALL,
  type: ALL,
  from: "",
  to: "",
};

export function filterPermissions(rows: PermissionRow[], f: PermissionFilters): PermissionRow[] {
  return rows.filter((p) => {
    if (f.status === "excess") {
      if (!(p.status === "approved" && p.capStatus === "excess")) return false;
    } else if (f.status !== ALL && p.status !== f.status) return false;
    if (f.type === "none") {
      if (p.typeKey) return false;
    } else if (f.type !== ALL && p.typeKey !== f.type) return false;
    const d = dateOnly(p.date);
    if (f.from && (!d || d < f.from)) return false;
    if (f.to && (!d || d > f.to)) return false;
    return matchesPerson(p, f);
  });
}

export const permissionFiltersActive = (f: PermissionFilters) =>
  personFiltersActive(f) || f.status !== ALL || f.type !== ALL || f.from !== "" || f.to !== "";

// ─── Who is on leave: the month calendar ───

export type CalendarKind = "leave" | "half" | "casual";

export type CalendarEntry = PersonFields & {
  key: string;
  kind: CalendarKind;
  status: string;
  start: string;
  end: string;
  /** "Sick", "Half day (morning)", "Casual leave (CL)". */
  label: string;
};

export function entryFromLeave(l: LeaveRow): CalendarEntry | null {
  const start = dateOnly(l.startDate);
  if (!start) return null;
  const end = dateOnly(l.endDate) ?? start;
  const type = l.type ? l.type.charAt(0).toUpperCase() + l.type.slice(1) : "Leave";
  return {
    ...l,
    key: `leave-${l.id}`,
    kind: l.isHalfDay ? "half" : "leave",
    status: l.status,
    start,
    end: end < start ? start : end,
    label: l.isHalfDay ? `Half day (${l.halfDaySlot === "afternoon" ? "afternoon" : "morning"})` : type,
  };
}

export type CasualRow = PersonFields & { id: number; date: string; status: string };

export function entryFromCasual(c: CasualRow): CalendarEntry | null {
  const day = dateOnly(c.date);
  if (!day) return null;
  return {
    ...c,
    key: `casual-${c.id}`,
    kind: "casual",
    status: c.status,
    start: day,
    end: day,
    label: "Casual leave (CL)",
  };
}

/** Rejected requests are not leave. */
export const countsAsLeave = (e: Pick<CalendarEntry, "status">) => e.status === "approved" || e.status === "pending";

/** Each day of the month to the entries that cover it (one entry per person per day: a person with two requests the
 *  same day counts once, the approved one winning). */
export function entriesByDay(entries: CalendarEntry[], year: number, month: number): Map<string, CalendarEntry[]> {
  const first = isoDate(year, month, 1);
  const last = isoDate(year, month, daysInMonth(year, month));
  const days = new Map<string, Map<number, CalendarEntry>>();
  for (const e of entries) {
    if (!countsAsLeave(e) || e.end < first || e.start > last) continue;
    const from = e.start < first ? first : e.start;
    const to = e.end > last ? last : e.end;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const people = days.get(d) ?? new Map<number, CalendarEntry>();
      const held = people.get(e.employeeId);
      if (!held || (held.status !== "approved" && e.status === "approved")) people.set(e.employeeId, e);
      days.set(d, people);
    }
  }
  const out = new Map<string, CalendarEntry[]>();
  for (const [d, people] of days) {
    out.set(
      d,
      [...people.values()].sort(
        (a, b) => (a.employeeName ?? "").localeCompare(b.employeeName ?? "") || a.employeeId - b.employeeId,
      ),
    );
  }
  return out;
}

export type GridCell = { iso: string; day: number; inMonth: boolean; weekday: number };

/** The month as whole weeks, Monday first; days of the neighbouring months pad the first and last week. */
export function monthGrid(year: number, month: number): GridCell[][] {
  const first = isoDate(year, month, 1);
  let cursor = addDays(first, -weekdayIndex(first));
  const last = isoDate(year, month, daysInMonth(year, month));
  const weeks: GridCell[][] = [];
  while (cursor <= last) {
    const week: GridCell[] = [];
    for (let i = 0; i < 7; i++) {
      const [y, m, d] = cursor.split("-").map(Number);
      week.push({ iso: cursor, day: d, inMonth: y === year && m === month, weekday: i });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** 0 (nobody) to 4 (the busiest day of the month): how dark a day's cell is. */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const share = count / max;
  return share > 0.75 ? 4 : share > 0.5 ? 3 : share > 0.25 ? 2 : 1;
}

export type CalendarSummary = {
  /** Different people on leave on at least one day of the month. */
  people: number;
  /** Person-days of leave in the month. */
  personDays: number;
  busiest: { iso: string; count: number } | null;
};

export function summarizeCalendar(byDay: Map<string, CalendarEntry[]>): CalendarSummary {
  const people = new Set<number>();
  let personDays = 0;
  let busiest: CalendarSummary["busiest"] = null;
  for (const [iso, list] of byDay) {
    personDays += list.length;
    for (const e of list) people.add(e.employeeId);
    if (!busiest || list.length > busiest.count || (list.length === busiest.count && iso < busiest.iso)) {
      busiest = { iso, count: list.length };
    }
  }
  return { people: people.size, personDays, busiest };
}

export type AwayPerson = {
  employeeId: number;
  name: string;
  code: string | null;
  /** Days of the month they are away. */
  days: number;
  entries: CalendarEntry[];
};

/** Each person who is away in the month, with their days there and the requests behind them (most days first). */
export function awayPeople(byDay: Map<string, CalendarEntry[]>): AwayPerson[] {
  const people = new Map<number, AwayPerson>();
  for (const list of byDay.values()) {
    for (const e of list) {
      const held = people.get(e.employeeId) ?? {
        employeeId: e.employeeId,
        name: e.employeeName ?? e.employeeCode ?? `#${e.employeeId}`,
        code: e.employeeCode ?? null,
        days: 0,
        entries: [],
      };
      held.days += 1;
      if (!held.entries.some((x) => x.key === e.key)) held.entries.push(e);
      people.set(e.employeeId, held);
    }
  }
  return [...people.values()].sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
}

// ─── Holidays ───

export type HolidayRow = {
  id: number;
  name: string;
  date: string;
  holidayType: string;
  branchId?: number | null;
  branchName?: string | null;
  departmentName?: string | null;
  isRecurring: boolean;
  description?: string | null;
};

export type HolidayFilters = {
  query: string;
  /** "all", national, regional or company. */
  type: string;
  /** "all" or 1-12. */
  month: string;
  /** "all", "none" (every branch) or a branch id. */
  branch: string;
};

export const NO_HOLIDAY_FILTERS: HolidayFilters = { query: "", type: ALL, month: ALL, branch: ALL };

export const holidayFiltersActive = (f: HolidayFilters) =>
  f.query.trim() !== "" || f.type !== ALL || f.month !== ALL || f.branch !== ALL;

export function filterHolidays(rows: HolidayRow[], f: HolidayFilters): HolidayRow[] {
  return rows
    .filter((h) => {
      if (f.type !== ALL && h.holidayType !== f.type) return false;
      if (f.month !== ALL && Number((dateOnly(h.date) ?? "0000-00").slice(5, 7)) !== Number(f.month)) return false;
      if (f.branch === "none" ? h.branchId != null : f.branch !== ALL && String(h.branchId ?? "") !== f.branch) {
        return false;
      }
      return matchesQuery(f.query, h.name, h.description, h.holidayType, h.branchName, h.departmentName);
    })
    .sort((a, b) => (dateOnly(a.date) ?? "").localeCompare(dateOnly(b.date) ?? "") || a.id - b.id);
}

/** Holidays grouped under their month, in calendar order (months with none are left out). */
export function groupHolidaysByMonth(rows: HolidayRow[]): { month: number; rows: HolidayRow[] }[] {
  const groups = new Map<number, HolidayRow[]>();
  for (const h of rows) {
    const d = dateOnly(h.date);
    if (!d) continue;
    const month = Number(d.slice(5, 7));
    groups.set(month, [...(groups.get(month) ?? []), h]);
  }
  return [...groups].sort((a, b) => a[0] - b[0]).map(([month, list]) => ({ month, rows: list }));
}

/** The first holiday today or later (rows may be in any order), with how many days away it is. */
export function nextHoliday(rows: HolidayRow[], today: string): { holiday: HolidayRow; inDays: number } | null {
  let best: HolidayRow | null = null;
  for (const h of rows) {
    const d = dateOnly(h.date);
    if (!d || d < today) continue;
    if (!best || d < (dateOnly(best.date) as string)) best = h;
  }
  return best ? { holiday: best, inDays: daysBetween(today, dateOnly(best.date) as string) } : null;
}

/** "Today", "Tomorrow", "In 12 days", or "3 days ago". */
export function relativeDays(inDays: number): string {
  if (inDays === 0) return "Today";
  if (inDays === 1) return "Tomorrow";
  if (inDays === -1) return "Yesterday";
  return inDays > 0 ? `In ${inDays} days` : `${-inDays} days ago`;
}

/** A holiday that lands on a Sunday gives nobody an extra day off: the page says so. */
export const fallsOnSunday = (h: Pick<HolidayRow, "date">) => {
  const d = dateOnly(h.date);
  return d !== null && weekdayIndex(d) === 6;
};

export type HolidaySummary = { total: number; national: number; regional: number; company: number; onSunday: number };

export function summarizeHolidays(rows: HolidayRow[]): HolidaySummary {
  return {
    total: rows.length,
    national: rows.filter((h) => h.holidayType === "national").length,
    regional: rows.filter((h) => h.holidayType === "regional").length,
    company: rows.filter((h) => h.holidayType === "company").length,
    onSunday: rows.filter(fallsOnSunday).length,
  };
}

/** Day of month to the holidays on it, for a month's calendar. */
export function holidaysByDay(rows: HolidayRow[], year: number, month: number): Map<string, HolidayRow[]> {
  const out = new Map<string, HolidayRow[]>();
  const prefix = `${year}-${pad(month)}-`;
  for (const h of rows) {
    const d = dateOnly(h.date);
    if (d?.startsWith(prefix)) out.set(d, [...(out.get(d) ?? []), h]);
  }
  return out;
}

// ─── Balances ───

export type LeaveBalanceRow = {
  id: number;
  employeeId: number;
  leaveTypeId: number;
  leaveTypeName?: string | null;
  leaveTypeCode?: string | null;
  year: number;
  allocated: number;
  used: number;
  remaining: number;
  carriedForward: number;
};

export type BalanceFlag = "ok" | "low" | "exhausted";

/** What an employee can take in the year: the allocation plus anything carried forward. */
export const entitlementOf = (b: Pick<LeaveBalanceRow, "allocated" | "carriedForward">) =>
  (b.allocated ?? 0) + (b.carriedForward ?? 0);

/** Nothing left is "exhausted"; a fifth or less of the entitlement (or a single day) is "low". Without an entitlement
 *  there is nothing to run out of. */
export function balanceFlag(b: Pick<LeaveBalanceRow, "allocated" | "carriedForward" | "remaining">): BalanceFlag {
  const total = entitlementOf(b);
  if (total <= 0) return "ok";
  if (b.remaining <= 0) return "exhausted";
  return b.remaining <= 1 || b.remaining / total <= 0.2 ? "low" : "ok";
}

/** Share of the entitlement used, 0 to 100. */
export function usedPercent(b: Pick<LeaveBalanceRow, "allocated" | "carriedForward" | "used">): number {
  const total = entitlementOf(b);
  return total <= 0 ? 0 : Math.min(100, Math.round((b.used / total) * 100));
}

export type BalanceView = LeaveBalanceRow & PersonFields & { flag: BalanceFlag };

/** Balances with their employee's name, branch and department joined on; a balance whose employee is not in the list
 *  (inactive, or another branch's) is dropped. */
export function joinBalances(balances: LeaveBalanceRow[], people: Map<number, PersonFields>): BalanceView[] {
  const out: BalanceView[] = [];
  for (const b of balances) {
    const p = people.get(b.employeeId);
    if (p) out.push({ ...b, ...p, flag: balanceFlag(b) });
  }
  return out;
}

export type BalanceFilters = PersonFilters & {
  /** "all" or a leave type id. */
  leaveType: string;
  /** "all", "low" (low or exhausted), "exhausted". */
  flag: string;
};

export const NO_BALANCE_FILTERS: BalanceFilters = { ...NO_PERSON_FILTERS, leaveType: ALL, flag: ALL };

export const balanceFiltersActive = (f: BalanceFilters) =>
  personFiltersActive(f) || f.leaveType !== ALL || f.flag !== ALL;

export function filterBalances(rows: BalanceView[], f: BalanceFilters): BalanceView[] {
  return rows
    .filter(
      (b) =>
        (f.leaveType === ALL || String(b.leaveTypeId) === f.leaveType) &&
        (f.flag === ALL || (f.flag === "exhausted" ? b.flag === "exhausted" : b.flag !== "ok")) &&
        matchesPerson(b, f),
    )
    .sort(
      (a, b) =>
        (a.employeeName ?? "").localeCompare(b.employeeName ?? "") ||
        (a.leaveTypeName ?? "").localeCompare(b.leaveTypeName ?? ""),
    );
}

export type BalanceSummary = { rows: number; people: number; low: number; exhausted: number; daysLeft: number };

export function summarizeBalances(rows: BalanceView[]): BalanceSummary {
  return {
    rows: rows.length,
    people: new Set(rows.map((r) => r.employeeId)).size,
    low: rows.filter((r) => r.flag === "low").length,
    exhausted: rows.filter((r) => r.flag === "exhausted").length,
    daysLeft: rows.reduce((n, r) => n + Math.max(0, r.remaining), 0),
  };
}

/** Days as a short number: 12, 7.5. */
export const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));

// ─── Export ───

export const LEAVE_EXPORT_HEADERS = [
  "Employee code",
  "Employee",
  "Branch",
  "Department",
  "Type",
  "From",
  "To",
  "Days",
  "Status",
  "Decided by",
  "Reason",
];

export function leaveExportRows(rows: LeaveRow[]): (string | number)[][] {
  return rows.map((l) => [
    l.employeeCode ?? "",
    l.employeeName ?? "",
    l.branch ?? "",
    l.department ?? "",
    l.isHalfDay ? `Half day (${l.halfDaySlot === "afternoon" ? "afternoon" : "morning"})` : l.type,
    dateOnly(l.startDate) ?? "",
    dateOnly(l.endDate) ?? "",
    leaveDays(l),
    l.status,
    l.approvedBy ?? "",
    l.reason ?? "",
  ]);
}

export const BALANCE_EXPORT_HEADERS = [
  "Employee code",
  "Employee",
  "Branch",
  "Department",
  "Leave type",
  "Year",
  "Allocated",
  "Carried forward",
  "Used",
  "Remaining",
  "Flag",
];

export function balanceExportRows(rows: BalanceView[]): (string | number)[][] {
  return rows.map((b) => [
    b.employeeCode ?? "",
    b.employeeName ?? "",
    b.branch ?? "",
    b.department ?? "",
    b.leaveTypeName ?? "",
    b.year,
    b.allocated,
    b.carriedForward,
    b.used,
    b.remaining,
    b.flag === "ok" ? "OK" : b.flag === "low" ? "Low" : "Exhausted",
  ]);
}
