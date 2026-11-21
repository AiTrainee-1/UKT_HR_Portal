import { addDays, mondayOf, weekdayOf, WEEKDAYS } from "./logic";
import type {
  AnalyticsRecord,
  AnalyticsSummary,
  AnalyticsTab,
  CategoryDetail,
  CategoryEmployee,
  CategoryMeta,
  DepartmentOption,
  EmployeeDetail,
  EmployeeHit,
  EmployeeRef,
  HodRow,
  Level,
  Pattern,
  Period,
} from "./types";

// Fixture answers of the three HR Analytics endpoints, built by the contract's own rules from a small cast (12 staff,
// 10 production employees, 1-21 Nov 2026): counts, flags, levels, scores, weekly counts, departments, HOD figures and
// the drill-downs all agree with each other. The tests serve them through `fixtureServer`; the page never imports this.

export const FIXTURE_TODAY = "2026-11-21";

const PERIOD: Period = { from: "2026-11-01", to: "2026-11-21", days: 21, months: 0.69, label: "1 Nov - 21 Nov 2026" };

type CatSeed = [
  key: string,
  label: string,
  unit: string,
  perMonth: number,
  description: string,
  informational?: boolean,
];

const STAFF_CATS: CatSeed[] = [
  ["leave", "Frequent leave", "days", 3, "Approved leave days taken in the period."],
  ["late", "Frequent late arrival", "days", 4, "Days the first punch came after the shift's grace time."],
  ["missing_punch", "Missing punches", "days", 3, "Days with an in or out punch missing."],
  ["on_duty", "Frequent On-Duty requests", "requests", 4, "On-Duty requests raised in the period."],
  ["on_duty_no_punch", "On-Duty without punches", "days", 1, "Approved On-Duty days with no geo punch at all."],
  ["absent_on_leave", "Absent despite approved leave", "days", 1, "Absent on a working day next to an approved leave."],
  ["attendance_edits", "Frequent attendance edits", "edits", 3, "Days HR edited the attendance by hand."],
  ["hod_rejected", "Requests the HOD rejected", "requests", 2, "Requests the Department Head turned down."],
  ["hod_waiting", "Waiting long with the HOD", "requests", 1, "Requests waiting more than 2 days for the HOD."],
  ["hod_corrections", "Corrections through the HOD", "requests", 3, "Attendance corrections the HOD approved."],
  ["permissions", "Excessive permission requests", "requests", 3, "Permission requests raised in the period."],
];

const PRODUCTION_CATS: CatSeed[] = [
  ["leave", "Frequent days off", "days", 4, "Approved leave plus absent working days (Sundays and holidays skipped)."],
  ["late", "Frequent late arrival", "days", 4, "Days the first punch came after the shift's grace time."],
  ["night_work", "Night work", "nights", 4, "Nights with 1 h or more worked between 22:00 and 06:00."],
  ["continuous_leave", "Continuous leave", "runs", 1, "Runs of 3 or more days off in a row."],
  ["late_details", "Late attendance details", "days", 1, "Everyone late at least once, with their pattern.", true],
];

const DEPARTMENTS: (DepartmentOption & { headcount: number })[] = [
  { id: 3, name: "IT", category: "staff", headcount: 18 },
  { id: 4, name: "Accounts", category: "staff", headcount: 24 },
  { id: 5, name: "HR", category: "staff", headcount: 9 },
  { id: 6, name: "Merchandising", category: "staff", headcount: 31 },
  { id: 7, name: "Quality", category: "staff", headcount: 22 },
  { id: 11, name: "Stitching", category: "production", headcount: 46 },
  { id: 12, name: "Cutting", category: "production", headcount: 21 },
  { id: 13, name: "Packing", category: "production", headcount: 18 },
  { id: 14, name: "Ironing", category: "production", headcount: 14 },
];

type PersonSeed = {
  id: number;
  code: string;
  name: string;
  dept: number;
  designation: string;
  /** category -> days as "MM-DD", or "MM-DD>MM-DD" for a run. */
  recs: Record<string, string[]>;
};

const STAFF: PersonSeed[] = [
  {
    id: 5,
    code: "30020",
    name: "SURYA M",
    dept: 3,
    designation: "AI Engineer",
    recs: {
      late: ["11-02", "11-03", "11-09", "11-10", "11-16", "11-20"],
      permissions: ["11-05", "11-18"],
    },
  },
  {
    id: 6,
    code: "30031",
    name: "ANITHA R",
    dept: 4,
    designation: "Senior Accountant",
    recs: {
      leave: ["11-03", "11-04", "11-12", "11-13"],
      missing_punch: ["11-06", "11-11", "11-19"],
      attendance_edits: ["11-06", "11-11", "11-19"],
    },
  },
  {
    id: 7,
    code: "30044",
    name: "KARTHIK S",
    dept: 6,
    designation: "Merchandiser",
    recs: { on_duty: ["11-02", "11-05", "11-10", "11-13", "11-17"], on_duty_no_punch: ["11-13"] },
  },
  { id: 8, code: "30052", name: "PRIYA D", dept: 5, designation: "HR Executive", recs: { absent_on_leave: ["11-10"] } },
  {
    id: 9,
    code: "30063",
    name: "VIJAY K",
    dept: 7,
    designation: "Quality Inspector",
    recs: { hod_rejected: ["11-04", "11-14"], hod_waiting: ["11-17"] },
  },
  {
    id: 10,
    code: "30071",
    name: "MEENA L",
    dept: 4,
    designation: "Accounts Assistant",
    recs: { hod_corrections: ["11-03", "11-10", "11-17"], late: ["11-03", "11-17"] },
  },
  {
    id: 11,
    code: "30085",
    name: "ARUN P",
    dept: 3,
    designation: "System Administrator",
    recs: { late: ["11-12"], permissions: ["11-06", "11-19"] },
  },
  { id: 12, code: "30090", name: "DIVYA N", dept: 6, designation: "Merchandiser", recs: { leave: ["11-07", "11-14"] } },
  {
    id: 13,
    code: "30102",
    name: "RAHUL V",
    dept: 7,
    designation: "Lab Technician",
    recs: { missing_punch: ["11-09"], on_duty: ["11-18"] },
  },
  {
    id: 14,
    code: "30117",
    name: "SANGEETHA B",
    dept: 5,
    designation: "Payroll Executive",
    recs: { permissions: ["11-02", "11-09", "11-12", "11-16"], late: ["11-02", "11-09", "11-16"] },
  },
  {
    id: 15,
    code: "30128",
    name: "GOKUL T",
    dept: 6,
    designation: "Senior Merchandiser",
    recs: { late: ["11-02", "11-04", "11-09", "11-11", "11-16", "11-18", "11-20"] },
  },
  {
    id: 16,
    code: "30133",
    name: "LAKSHMI J",
    dept: 7,
    designation: "Quality Auditor",
    recs: { attendance_edits: ["11-15"] },
  },
];

const PRODUCTION: PersonSeed[] = [
  {
    id: 101,
    code: "50011",
    name: "MURUGAN A",
    dept: 11,
    designation: "Tailor",
    recs: {
      leave: ["11-03", "11-04", "11-05", "11-06", "11-10", "11-11", "11-12", "11-13", "11-17"],
      continuous_leave: ["11-03>11-06"],
    },
  },
  {
    id: 102,
    code: "50024",
    name: "SELVI K",
    dept: 11,
    designation: "Tailor",
    recs: { late: ["11-02", "11-09", "11-16", "11-19"], late_details: ["11-02", "11-09", "11-16", "11-19"] },
  },
  {
    id: 103,
    code: "50037",
    name: "RAJA M",
    dept: 12,
    designation: "Cutting Master",
    recs: { night_work: ["11-02", "11-03", "11-04", "11-09", "11-10", "11-11", "11-16", "11-17"] },
  },
  {
    id: 104,
    code: "50045",
    name: "KAVITHA S",
    dept: 13,
    designation: "Packer",
    recs: {
      leave: ["11-04", "11-05", "11-06", "11-12", "11-13", "11-14"],
      continuous_leave: ["11-04>11-06", "11-12>11-14"],
    },
  },
  {
    id: 105,
    code: "50058",
    name: "BALU R",
    dept: 14,
    designation: "Ironing Operator",
    recs: { late: ["11-10"], late_details: ["11-10"] },
  },
  { id: 106, code: "50062", name: "PONNI V", dept: 11, designation: "Checker", recs: { leave: ["11-07", "11-19"] } },
  {
    id: 107,
    code: "50079",
    name: "SURESH G",
    dept: 12,
    designation: "Cutter",
    recs: { night_work: ["11-05", "11-12", "11-19"] },
  },
  {
    id: 108,
    code: "50083",
    name: "AMUDHA P",
    dept: 13,
    designation: "Packer",
    recs: {
      late: ["11-03", "11-11", "11-18"],
      leave: ["11-09", "11-14", "11-20"],
      late_details: ["11-03", "11-11", "11-18"],
    },
  },
  {
    id: 109,
    code: "50091",
    name: "DINESH K",
    dept: 14,
    designation: "Ironing Operator",
    recs: { late: ["11-04", "11-13"], late_details: ["11-04", "11-13"] },
  },
  {
    id: 110,
    code: "50104",
    name: "JOTHI L",
    dept: 11,
    designation: "Tailor",
    recs: { night_work: ["11-08"], late: ["11-17"], late_details: ["11-17"] },
  },
];

export const FIXTURE_HODS: HodRow[] = [
  {
    employeeId: 21,
    code: "20004",
    name: "R KUMAR",
    department: "Accounts",
    decided: 14,
    rejected: 3,
    rejectionRate: 0.21,
    avgResponseHours: 19.5,
    waitingNow: 2,
    waitingLong: 1,
    oldestWaitingHours: 70.2,
  },
  {
    employeeId: 22,
    code: "20009",
    name: "S PRAKASH",
    department: "IT",
    decided: 9,
    rejected: 1,
    rejectionRate: 0.11,
    avgResponseHours: 6.2,
    waitingNow: 0,
    waitingLong: 0,
    oldestWaitingHours: null,
  },
  {
    employeeId: 23,
    code: "20015",
    name: "M DEVI",
    department: "Merchandising",
    decided: 11,
    rejected: 5,
    rejectionRate: 0.45,
    avgResponseHours: 31,
    waitingNow: 3,
    waitingLong: 2,
    oldestWaitingHours: 96.4,
  },
  {
    employeeId: 24,
    code: "20021",
    name: "K RAMESH",
    department: "Quality",
    decided: 4,
    rejected: 0,
    rejectionRate: 0,
    avgResponseHours: 2.5,
    waitingNow: 1,
    waitingLong: 0,
    oldestWaitingHours: 20,
  },
];

/** The production days the devices sent nothing (the absence checks leave them out). */
export const FIXTURE_PRODUCTION_GAPS = ["2026-11-03", "2026-11-04", "2026-11-11"];

// ── building the answers ────────────────────────────────────────────────────────────────────────────────────────────

const catsOf = (type: AnalyticsTab) => (type === "staff" ? STAFF_CATS : PRODUCTION_CATS);
const peopleOf = (type: AnalyticsTab) => (type === "staff" ? STAFF : PRODUCTION);
const dept = (id: number) => DEPARTMENTS.find((d) => d.id === id)!;
const day = (mmdd: string) => `2026-${mmdd}`;

function metaBase(seed: CatSeed): Omit<CategoryMeta, "flagged" | "high" | "affected" | "total"> {
  const [key, label, unit, perMonth, description, informational = false] = seed;
  return {
    key,
    label,
    description,
    unit,
    thresholdPerMonth: perMonth,
    threshold: Math.max(1, Math.ceil(perMonth * PERIOD.months)),
    informational,
  };
}

function refOf(p: PersonSeed, type: AnalyticsTab): EmployeeRef {
  const d = dept(p.dept);
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    department: d.name,
    departmentId: d.id,
    designation: p.designation,
    branch: "Head Office",
    photoUrl: null,
    type,
  };
}

function recordOf(key: string, raw: string, i: number): AnalyticsRecord {
  const [a, b] = raw.split(">");
  const date = day(a);
  const endDate = b ? day(b) : null;
  const at = `${date}T10:${String(10 + i).padStart(2, "0")}:00+05:30`;
  const base: AnalyticsRecord = {
    date,
    endDate,
    title: "",
    detail: null,
    reason: null,
    status: null,
    by: null,
    at: null,
  };
  switch (key) {
    case "leave":
      return {
        ...base,
        title: "Leave: casual leave",
        reason: i % 2 ? "Family function" : "Fever",
        status: "approved",
        by: "R KUMAR",
        at,
      };
    case "late":
    case "late_details":
      return {
        ...base,
        title: `Late by first punch 09:${String(12 + i * 7).padStart(2, "0")}`,
        detail: "Shift starts 09:00, grace 10 min",
      };
    case "missing_punch":
      return { ...base, title: "Out punch missing", detail: "Only one punch that day: 09:02" };
    case "on_duty":
      return {
        ...base,
        title: "On-Duty request",
        reason: "Client visit, Tiruppur",
        status: i === 4 ? "pending" : "approved",
        by: "M DEVI",
        at,
      };
    case "on_duty_no_punch":
      return { ...base, title: "On-Duty without a punch", detail: "No geo punch during the approved On-Duty" };
    case "absent_on_leave":
      return {
        ...base,
        title: "Absent after an approved leave",
        detail: "Leave on 7 Nov approved, no punch on 10 Nov",
      };
    case "attendance_edits":
      return { ...base, title: "Attendance edited by HR", detail: "Absent changed to Present", by: "HR Admin", at };
    case "hod_rejected":
      return {
        ...base,
        title: "Permission rejected by the HOD",
        reason: "Personal work",
        status: "rejected",
        by: "K RAMESH",
        at,
      };
    case "hod_waiting":
      return {
        ...base,
        title: "Leave request waiting with the HOD",
        detail: "Waiting 3.4 days",
        status: "pending_hod",
      };
    case "hod_corrections":
      return {
        ...base,
        title: "Attendance correction approved by the HOD",
        reason: "Forgot to punch out",
        status: "approved",
        by: "R KUMAR",
        at,
      };
    case "permissions":
      return {
        ...base,
        title: "Permission 10:00 - 11:00",
        reason: "Bank work",
        status: "approved",
        by: "HR Admin",
        at,
      };
    case "night_work":
      return { ...base, title: "Worked 21:40 - 05:55", detail: "7.9 h between 22:00 and 06:00" };
    case "continuous_leave":
      return { ...base, title: "Off 3 or more days in a row", detail: "No punch and no approved leave in between" };
    default:
      return { ...base, title: key };
  }
}

function longestStreak(dates: string[]): number {
  const sorted = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  sorted.forEach((d, i) => {
    run = i > 0 && addDays(sorted[i - 1], 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

function patternOf(key: string, records: AnalyticsRecord[]): Pattern {
  const byWeekday: Record<string, number> = Object.fromEntries(WEEKDAYS.map((d) => [d, 0]));
  for (const r of records) byWeekday[weekdayOf(r.date)] += 1;
  const total = records.length;
  const peak = WEEKDAYS.reduce((a, b) => (byWeekday[b] > byWeekday[a] ? b : a), "Mon" as string);
  const days: Record<string, string> = {
    Mon: "Mondays",
    Tue: "Tuesdays",
    Wed: "Wednesdays",
    Thu: "Thursdays",
    Fri: "Fridays",
    Sat: "Saturdays",
    Sun: "Sundays",
  };
  const pattern: Pattern = {
    byWeekday,
    longestStreak: longestStreak(records.map((r) => r.date)),
    lastDate: records.length
      ? records
          .map((r) => r.date)
          .sort()
          .slice(-1)[0]
      : null,
    note: total >= 3 && byWeekday[peak] / total >= 0.5 ? `Mostly on ${days[peak]}` : null,
  };
  if ((key === "late" || key === "late_details") && total > 0) {
    pattern.avgFirstPunch = "09:21";
    pattern.latestFirstPunch = `09:${String(12 + (total - 1) * 7).padStart(2, "0")}`;
  }
  if (key === "night_work" && total > 0) pattern.nightHours = Math.round(total * 7.9 * 10) / 10;
  return pattern;
}

type Built = EmployeeHit & { records: Record<string, AnalyticsRecord[]> };

function build(p: PersonSeed, type: AnalyticsTab): Built {
  const metas = catsOf(type).map(metaBase);
  const records: Record<string, AnalyticsRecord[]> = {};
  const counts: Record<string, number> = {};
  for (const [key, raws] of Object.entries(p.recs)) {
    records[key] = raws.map((r, i) => recordOf(key, r, i));
    counts[key] = raws.length;
  }
  const counted = metas.filter((m) => !m.informational);
  const flags = counted.filter((m) => (counts[m.key] ?? 0) >= m.threshold).map((m) => m.key);
  const double = counted.some((m) => (counts[m.key] ?? 0) >= m.threshold * 2);
  const anyHit = counted.some((m) => (counts[m.key] ?? 0) > 0);
  const level: Level = double || flags.length >= 3 ? "high" : flags.length ? "attention" : anyHit ? "watch" : "ok";
  const score = Math.round(counted.reduce((s, m) => s + (counts[m.key] ?? 0) / m.threshold, 0) * 100) / 100;
  const all = Object.values(records).flat();
  const lastDate = all.length
    ? all
        .map((r) => r.endDate ?? r.date)
        .sort()
        .slice(-1)[0]
    : null;
  return { ...refOf(p, type), counts, flags, level, score, lastDate, records };
}

export type FixtureFilter = { departmentId?: number | null; employeeId?: number | null; q?: string | null };

function inScope(type: AnalyticsTab, f: FixtureFilter): PersonSeed[] {
  const words = (f.q ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return peopleOf(type).filter((p) => {
    if (f.departmentId && p.dept !== f.departmentId) return false;
    if (f.employeeId && p.id !== f.employeeId) return false;
    const hay = [p.name, p.code, p.designation, dept(p.dept).name].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const WEEKS = ["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"];

function periodOf(type: AnalyticsTab): Period {
  return type === "production" ? { ...PERIOD, dataGaps: FIXTURE_PRODUCTION_GAPS } : { ...PERIOD, dataGaps: [] };
}

export function fixtureSummary(type: AnalyticsTab, f: FixtureFilter = {}): AnalyticsSummary {
  const metas = catsOf(type).map(metaBase);
  const built = inScope(type, f).map((p) => build(p, type));
  const categories: CategoryMeta[] = metas.map((m) => {
    const hit = built.filter((b) => (b.counts[m.key] ?? 0) > 0);
    return {
      ...m,
      flagged: m.informational ? 0 : hit.filter((b) => b.counts[m.key] >= m.threshold).length,
      high: m.informational ? 0 : hit.filter((b) => b.counts[m.key] >= m.threshold * 2).length,
      affected: hit.length,
      total: hit.reduce((n, b) => n + b.counts[m.key], 0),
    };
  });
  const employees: EmployeeHit[] = built
    .filter((b) => Object.values(b.counts).some((n) => n > 0))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map(({ records: _records, ...e }) => e);
  const weekly = WEEKS.map((weekStart) => {
    const weekEnd = addDays(weekStart, 6);
    const counts: Record<string, number> = {};
    for (const b of built)
      for (const [key, recs] of Object.entries(b.records))
        counts[key] = (counts[key] ?? 0) + recs.filter((r) => mondayOf(r.date) === weekStart).length;
    return { weekStart, weekEnd, counts };
  });
  const deptIds = [...new Set(peopleOf(type).map((p) => p.dept))].filter(
    (id) => !f.departmentId || id === f.departmentId,
  );
  const narrowed = Boolean(f.employeeId || (f.q ?? "").trim());
  const departments = deptIds.map((id) => {
    const mine = built.filter((b) => b.departmentId === id);
    const counts: Record<string, number> = {};
    for (const b of mine) for (const [k, n] of Object.entries(b.counts)) counts[k] = (counts[k] ?? 0) + n;
    return {
      id,
      name: dept(id).name,
      employees: narrowed ? mine.length : dept(id).headcount,
      flagged: mine.filter((b) => b.level === "high" || b.level === "attention").length,
      counts,
    };
  });
  return {
    type,
    period: periodOf(type),
    categories,
    employees,
    weekly,
    departments,
    hods: type === "staff" ? FIXTURE_HODS.map((h) => ({ ...h })) : [],
    totals: {
      employeesInScope: departments.reduce((n, d) => n + d.employees, 0),
      employeesWithIssues: employees.length,
      needingAttention: employees.filter((e) => e.level === "high" || e.level === "attention").length,
      high: employees.filter((e) => e.level === "high").length,
    },
    options: { departments: DEPARTMENTS.map(({ headcount: _h, ...d }) => d) },
  };
}

function categoryLevel(count: number, m: { threshold: number; informational: boolean }): Level {
  if (count <= 0 || m.informational) return count > 0 ? "watch" : "ok";
  return count >= m.threshold * 2 ? "high" : count >= m.threshold ? "attention" : "watch";
}

export function fixtureCategory(type: AnalyticsTab, key: string, f: FixtureFilter = {}): CategoryDetail | null {
  const summary = fixtureSummary(type, f);
  const category = summary.categories.find((c) => c.key === key);
  if (!category) return null;
  const employees: CategoryEmployee[] = inScope(type, f)
    .map((p) => build(p, type))
    .filter((b) => (b.counts[key] ?? 0) > 0)
    .map((b) => {
      const records = [...(b.records[key] ?? [])].sort((x, y) => y.date.localeCompare(x.date));
      const pattern = patternOf(key, records);
      return {
        ...refOf(
          peopleOf(type).find((p) => p.id === b.id)!,
          type,
        ),
        count: b.counts[key],
        flagged: !category.informational && b.counts[key] >= category.threshold,
        level: categoryLevel(b.counts[key], category),
        lastDate: pattern.lastDate,
        pattern,
        records,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { category, period: summary.period, employees };
}

export function fixtureEmployee(type: AnalyticsTab, id: number): EmployeeDetail | null {
  const seed = peopleOf(type).find((p) => p.id === id);
  if (!seed) return null;
  const b = build(seed, type);
  const summary = fixtureSummary(type);
  const categories: EmployeeDetail["categories"] = {};
  for (const c of summary.categories) {
    const records = [...(b.records[c.key] ?? [])].sort((x, y) => y.date.localeCompare(x.date));
    categories[c.key] = {
      category: c,
      count: b.counts[c.key] ?? 0,
      flagged: b.flags.includes(c.key),
      records,
      pattern: patternOf(c.key, records),
    };
  }
  const timeline = Object.entries(b.records)
    .flatMap(([category, recs]) => recs.map((r) => ({ ...r, category })))
    .sort((x, y) => y.date.localeCompare(x.date) || x.category.localeCompare(y.category));
  return {
    employee: refOf(seed, type),
    period: summary.period,
    level: b.level,
    score: b.score,
    counts: b.counts,
    flags: b.flags,
    categories,
    timeline,
  };
}

/** A fake of the three endpoints for the page tests: what customFetch would get back for a URL (404 -> throws). */
export function fixtureServer(url: string): unknown {
  const [path, qs = ""] = url.split("?");
  const params = new URLSearchParams(qs);
  const type: AnalyticsTab = params.get("type") === "production" ? "production" : "staff";
  const filter: FixtureFilter = {
    departmentId: Number(params.get("departmentId")) || null,
    employeeId: Number(params.get("employeeId")) || null,
    q: params.get("q"),
  };
  if (path === "/api/hr-analytics/summary") return fixtureSummary(type, filter);
  const cat = /^\/api\/hr-analytics\/category\/([a-z_]+)$/.exec(path);
  if (cat) {
    const found = fixtureCategory(type, cat[1], filter);
    if (!found) throw new Error("Not found");
    return found;
  }
  const emp = /^\/api\/hr-analytics\/employee\/(\d+)$/.exec(path);
  if (emp) {
    const found = fixtureEmployee(type, Number(emp[1]));
    if (!found) throw new Error("Not found");
    return found;
  }
  return undefined;
}

/** Every employee of the cast as the lite employee list returns them (for the employee picker). */
export const FIXTURE_EMPLOYEES_LITE = [...STAFF, ...PRODUCTION].map((p) => ({
  id: p.id,
  employeeCode: p.code,
  firstName: p.name,
  lastName: "",
  employmentType: STAFF.includes(p) ? "staff" : "production",
  departmentName: dept(p.dept).name,
  designationTitle: p.designation,
}));
