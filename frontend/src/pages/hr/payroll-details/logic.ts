import {
  PAY_CYCLE_INFO,
  type DayMark,
  type IssueCode,
  type IssueSeverity,
  type PayrollDay,
  type PayrollDetails,
  type PayrollIssue,
  type PayrollKind,
  type RuleGroup,
  type RuleItem,
} from "@/lib/api-client/custom-hooks";
import { dateLong, inr2, parseIso, periodLabel, plural } from "@/components/payroll/kit/format";
import { ISSUE_META, issueLabel, severityRank } from "@/components/payroll/kit/issue-meta";

// The pure logic behind the payroll details page: what the sections are, how issues are filtered and grouped, how the
// calendar is laid out, which rules changed, and the small formatting rules. Nothing here touches React or the network,
// so every rule can be tested on its own (logic.test.ts).

// ── Sections ──────────────────────────────────────────────────────────────────

/** The sections of the page, in the order they are shown: the days first, then what was flagged, then the money. */
export const SECTIONS = [
  { id: "attendance", label: "Attendance" },
  { id: "issues", label: "Issues" },
  { id: "pay", label: "Pay & deductions" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export const SECTION_IDS: SectionId[] = SECTIONS.map((s) => s.id);

/** The anchor id of a section on the page (prefixed so it can never collide with another element of the app). */
export const sectionDomId = (id: string): string => `pd-${id}`;

// A link to a section the page no longer has (overview, rules, employee, history) simply opens the page at its top.
const SECTION_ALIASES: Record<string, SectionId> = {
  days: "attendance",
  calendar: "attendance",
  deductions: "pay",
  advances: "pay",
};

/** `?section=issues` (or an alias such as `days`) -> the section it names; null for anything else. */
export function parseSectionParam(value: string | null | undefined): SectionId | null {
  const key = (value ?? "").trim().toLowerCase();
  if (!key) return null;
  if ((SECTION_IDS as string[]).includes(key)) return key as SectionId;
  return SECTION_ALIASES[key] ?? null;
}

/**
 * Scroll spy: which section is being read. `line` is the y position (in the same coordinates as the tops) just under
 * the sticky bar: the active section is the last one whose top has passed it. At the very bottom of the page the last
 * section wins (a short last section could otherwise never reach the line).
 */
export function pickActiveSection(
  sections: { id: string; top: number }[],
  line: number,
  atBottom: boolean,
): string | null {
  if (sections.length === 0) return null;
  if (atBottom) return sections[sections.length - 1].id;
  let active = sections[0].id;
  for (const section of sections) {
    if (section.top <= line) active = section.id;
    else break;
  }
  return active;
}

/** "Back to Payroll · October 2026" / "Back to Production Payroll · Weekly"; plain while the payroll is still loading. */
export function backLabelFor(kind: PayrollKind, details: Pick<PayrollDetails, "period" | "context"> | null): string {
  if (kind === "production") {
    const cycle =
      details?.period.cycleLabel ?? (details?.context.cycle ? PAY_CYCLE_INFO[details.context.cycle]?.label : null);
    return cycle ? `Back to Production Payroll · ${cycle}` : "Back to Production Payroll";
  }
  return details?.period.label ? `Back to Payroll · ${details.period.label}` : "Back to Payroll";
}

/** Where Back goes when there is no payroll to take the address from (the bare list page of the kind). */
export const fallbackListPath = (kind: PayrollKind): string =>
  kind === "production" ? "/hr/production-payroll" : "/hr/payroll";

/** The route's `:id` as a payroll id; null when it is not a positive whole number. */
export function parsePayrollId(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ── Dates ─────────────────────────────────────────────────────────────────────

function toUtc(iso: string | null | undefined): Date | null {
  const p = parseIso(iso);
  return p ? new Date(Date.UTC(p.year, p.month - 1, p.day)) : null;
}

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);

/** The day `n` days after `iso` (before it for a negative `n`). */
export function addDaysIso(iso: string, n: number): string {
  const d = toUtc(iso);
  if (!d) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}

/** Position of a day in a Monday-first week: Monday 0 ... Sunday 6; -1 for something that is not a date. */
export function weekdayOffset(iso: string | null | undefined): number {
  const d = toUtc(iso);
  return d ? (d.getUTCDay() + 6) % 7 : -1;
}

/** The Monday of the week a day is in. */
export function weekStartIso(iso: string | null | undefined): string | null {
  const offset = weekdayOffset(iso);
  return offset < 0 ? null : addDaysIso(iso as string, -offset);
}

/** Every day from `from` to `to`, inclusive (at most `limit`, so a bad range can never run away). */
export function eachDay(from: string, to: string, limit = 400): string[] {
  const out: string[] = [];
  if (!toUtc(from) || !toUtc(to)) return out;
  for (let day = from; day <= to && out.length < limit; day = addDaysIso(day, 1)) out.push(day);
  return out;
}

// ── Issues: filtering ─────────────────────────────────────────────────────────

export type IssueGroupBy = "date" | "type";

export type IssueFilters = {
  severities: IssueSeverity[];
  /** "all" or an issue code. */
  code: string;
  /** ISO days, "" for open-ended. */
  from: string;
  to: string;
  query: string;
};

export const NO_ISSUE_FILTERS: IssueFilters = { severities: [], code: "all", from: "", to: "", query: "" };

/** How many of the filters are narrowing the list (the number on the Reset button). */
export function activeFilterCount(f: IssueFilters): number {
  return (
    (f.severities.length > 0 ? 1 : 0) + (f.code !== "all" ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.query.trim() ? 1 : 0)
  );
}

/** The date range with its ends the right way round (a From later than the To is read as the other way about). */
export function dateRangeOf(f: Pick<IssueFilters, "from" | "to">): { from: string; to: string } | null {
  if (!f.from && !f.to) return null;
  if (f.from && f.to && f.from > f.to) return { from: f.to, to: f.from };
  return { from: f.from, to: f.to };
}

/** "Late detection" -> "late-detection": a name that is safe in a test id. */
export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

export function factValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  return value;
}

/** Everything a search can match on one issue, lower-cased: its words, its type, its rule, its date and its facts. */
export function issueSearchText(issue: PayrollIssue): string {
  const facts = Object.entries(issue.facts ?? {}).map(([k, v]) => `${humanizeKey(k)} ${factValue(v)}`);
  return [
    issue.title,
    issue.detail,
    issueLabel(issue.code),
    issue.rule?.label,
    issue.date ? dateLong(issue.date) : "whole period",
    ...facts,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * The issues that pass every filter. An issue about the whole period has no date, so it is left out as soon as a date
 * range is set (the range asks "what happened on these days").
 */
export function filterIssues(issues: PayrollIssue[], f: IssueFilters): PayrollIssue[] {
  const range = dateRangeOf(f);
  const query = f.query.trim().toLowerCase();
  return issues.filter((issue) => {
    if (f.severities.length > 0 && !f.severities.includes(issue.severity)) return false;
    if (f.code !== "all" && issue.code !== f.code) return false;
    if (range) {
      if (!issue.date) return false;
      if (range.from && issue.date < range.from) return false;
      if (range.to && issue.date > range.to) return false;
    }
    if (query && !issueSearchText(issue).includes(query)) return false;
    return true;
  });
}

export function severityCounts(issues: PayrollIssue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) if (issue.severity in counts) counts[issue.severity] += 1;
  return counts;
}

export type TypeOption = { code: string; label: string; count: number; severity: IssueSeverity };

/** The choices of the type filter: every kind of issue present, worst first, each with how many there are. */
export function typeOptions(byCode: Record<string, number> | null | undefined, issues: PayrollIssue[]): TypeOption[] {
  const counts: Record<string, number> = {};
  for (const [code, n] of Object.entries(byCode ?? {})) if (n > 0) counts[code] = n;
  // without the server's counts (or with an empty answer) they are worked out from the issues themselves
  if (Object.keys(counts).length === 0) {
    for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  }
  const worst: Record<string, IssueSeverity> = {};
  for (const issue of issues) {
    const seen = worst[issue.code];
    if (!seen || severityRank(issue.severity) < severityRank(seen)) worst[issue.code] = issue.severity;
  }
  return Object.entries(counts)
    .map(([code, count]) => ({
      code,
      label: issueLabel(code),
      count,
      severity: worst[code] ?? ISSUE_META[code as keyof typeof ISSUE_META]?.severity ?? "info",
    }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.label.localeCompare(b.label));
}

// ── Issues: ordering and grouping ─────────────────────────────────────────────

/** Date first (the whole-period issues, which have none, come before the first day), then worst, then kind. */
export function compareIssues(a: PayrollIssue, b: PayrollIssue): number {
  return (
    (a.date ?? "").localeCompare(b.date ?? "") ||
    severityRank(a.severity) - severityRank(b.severity) ||
    issueLabel(a.code).localeCompare(issueLabel(b.code)) ||
    a.id.localeCompare(b.id)
  );
}

export type ImpactTotals = { days: number; shifts: number; amount: number };

export function impactTotals(issues: PayrollIssue[]): ImpactTotals {
  const totals: ImpactTotals = { days: 0, shifts: 0, amount: 0 };
  for (const issue of issues) {
    totals.days += issue.impact?.days ?? 0;
    totals.shifts += issue.impact?.shifts ?? 0;
    totals.amount += issue.impact?.amount ?? 0;
  }
  return totals;
}

/** "0.5 days", "₹567.31": the cost of one issue in words. */
export function impactParts(impact: PayrollIssue["impact"] | undefined): string[] {
  if (!impact) return [];
  const parts: string[] = [];
  if (impact.days) parts.push(plural(impact.days, "day"));
  if (impact.shifts) parts.push(plural(impact.shifts, "shift"));
  if (impact.amount) parts.push(inr2(impact.amount));
  if (impact.label) parts.push(impact.label);
  return parts;
}

export function impactTotalsText(t: ImpactTotals): string {
  const parts: string[] = [];
  if (t.days) parts.push(plural(Math.round(t.days * 100) / 100, "day"));
  if (t.shifts) parts.push(plural(Math.round(t.shifts * 100) / 100, "shift"));
  if (t.amount) parts.push(inr2(t.amount));
  return parts.join(" · ");
}

export type IssueDayGroup = { key: string; date: string | null; label: string; issues: PayrollIssue[] };
export type IssueWeekBand = { key: string; label: string; start: string | null; days: IssueDayGroup[]; count: number };

/**
 * The by-date view: the whole-period issues first (they sum the month up), then one band per week (Monday to Sunday)
 * with a header per day inside it. Nothing is dropped: every issue lands in exactly one day group.
 */
export function groupIssuesByDate(issues: PayrollIssue[]): IssueWeekBand[] {
  const sorted = [...issues].sort(compareIssues);
  const bands: IssueWeekBand[] = [];
  const wholePeriod = sorted.filter((i) => !i.date);
  if (wholePeriod.length > 0) {
    bands.push({
      key: "period",
      label: "Whole period",
      start: null,
      count: wholePeriod.length,
      days: [{ key: "period", date: null, label: "Not tied to a single day", issues: wholePeriod }],
    });
  }
  let band: IssueWeekBand | null = null;
  let day: IssueDayGroup | null = null;
  for (const issue of sorted) {
    if (!issue.date) continue;
    const start = weekStartIso(issue.date) ?? issue.date;
    if (!band || band.key !== start) {
      band = { key: start, label: `Week of ${periodLabel(start, addDaysIso(start, 6))}`, start, days: [], count: 0 };
      bands.push(band);
      day = null;
    }
    if (!day || day.date !== issue.date) {
      day = { key: issue.date, date: issue.date, label: dateLong(issue.date), issues: [] };
      band.days.push(day);
    }
    day.issues.push(issue);
    band.count += 1;
  }
  return bands;
}

export type IssueTypeGroup = {
  code: string;
  label: string;
  severity: IssueSeverity;
  issues: PayrollIssue[];
  totals: ImpactTotals;
};

/** The by-type view: one group per kind of issue, worst first, with what the kind cost altogether. */
export function groupIssuesByType(issues: PayrollIssue[]): IssueTypeGroup[] {
  const groups = new Map<string, IssueTypeGroup>();
  for (const issue of [...issues].sort(compareIssues)) {
    let group = groups.get(issue.code);
    if (!group) {
      group = {
        code: issue.code,
        label: issueLabel(issue.code),
        severity: issue.severity,
        issues: [],
        totals: impactTotals([]),
      };
      groups.set(issue.code, group);
    }
    if (severityRank(issue.severity) < severityRank(group.severity)) group.severity = issue.severity;
    group.issues.push(issue);
  }
  const list = [...groups.values()];
  for (const group of list) group.totals = impactTotals(group.issues);
  return list.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.issues.length - a.issues.length ||
      a.label.localeCompare(b.label),
  );
}

// ── The days: calendar and table ──────────────────────────────────────────────

export type DayKind = "present" | "late" | "half" | "absent" | "unpaid" | "leave" | "onleave" | "holiday" | "other";

export const DAY_KINDS: DayKind[] = [
  "present",
  "late",
  "half",
  "absent",
  "unpaid",
  "leave",
  "onleave",
  "holiday",
  "other",
];

/** One look per kind of day: its words, a one-letter code (so colour is never the only signal), and its colours. */
export const DAY_KIND_META: Record<DayKind, { label: string; short: string; cell: string; swatch: string }> = {
  present: {
    label: "Present",
    short: "P",
    cell: "border-emerald-200 bg-emerald-50 text-emerald-900",
    swatch: "bg-emerald-400",
  },
  late: { label: "Late", short: "L", cell: "border-amber-200 bg-amber-50 text-amber-900", swatch: "bg-amber-400" },
  half: {
    label: "Half day",
    short: "½",
    cell: "border-orange-200 bg-orange-50 text-orange-900",
    swatch: "bg-orange-400",
  },
  absent: { label: "Absent", short: "A", cell: "border-red-200 bg-red-50 text-red-900", swatch: "bg-red-400" },
  unpaid: {
    label: "Unpaid leave",
    short: "UL",
    cell: "border-purple-200 bg-purple-50 text-purple-900",
    swatch: "bg-purple-400",
  },
  leave: { label: "Paid leave", short: "PL", cell: "border-sky-200 bg-sky-50 text-sky-900", swatch: "bg-sky-400" },
  onleave: { label: "On leave", short: "LV", cell: "border-cyan-200 bg-cyan-50 text-cyan-900", swatch: "bg-cyan-400" },
  holiday: {
    label: "Holiday / not worked",
    short: "–",
    cell: "border-slate-200 bg-slate-100 text-slate-600",
    swatch: "bg-slate-300",
  },
  other: {
    label: "Other",
    short: "?",
    cell: "border-dashed border-slate-300 bg-white text-slate-600",
    swatch: "bg-white ring-1 ring-slate-300",
  },
};

const HOLIDAY_STATUSES = new Set(["holiday", "week_off", "weekly_off", "weekoff", "off", "not_worked", "no_shift"]);
const PAID_LEAVE_STATUSES = new Set(["paid_leave", "casual_leave"]);
const ON_LEAVE_STATUSES = new Set(["on_leave", "leave"]);

/**
 * What kind of day a day was: its status, made more specific by what was flagged on it (half beats late beats present).
 * Staff payroll records a half day as a present day with 0.5 shifts and a half-day issue, so those count too.
 */
export function dayKind(day: Pick<PayrollDay, "status" | "flags"> & { shifts?: number | null }): DayKind {
  const status = (day.status ?? "").toLowerCase();
  const flags = day.flags ?? [];
  if (status === "absent") return "absent";
  if (status === "unpaid_leave") return "unpaid";
  if (PAID_LEAVE_STATUSES.has(status)) return "leave";
  if (ON_LEAVE_STATUSES.has(status)) return "onleave";
  if (HOLIDAY_STATUSES.has(status)) return "holiday";
  if (status === "half_shift" || status === "half_day" || flags.includes("half_day")) return "half";
  if (status === "present") {
    if (day.shifts === 0.5) return "half";
    return flags.includes("late_in") ? "late" : "present";
  }
  return "other";
}

// ── The attendance categories of a day ────────────────────────────────────────

/** The six categories HR looks for on a day, in the order they are listed everywhere. */
export const MARK_KEYS: DayMark[] = [
  "late",
  "permission",
  "excess_permission",
  "on_duty",
  "on_duty_punch",
  "missed_punch",
];

/**
 * One look per category: its words, a short word for the calendar cell, what it means, and a colour of its own in three
 * strengths: `cell` fills the whole day when this is the day's main category, `bar` is the solid edge of that cell, `pill` is
 * the solid tag every category a day carries is shown with, `swatch` is the solid dot of the legend.
 */
export const MARK_META: Record<
  DayMark,
  { label: string; short: string; hint: string; cell: string; bar: string; pill: string; swatch: string }
> = {
  late: {
    label: "Late attendance",
    short: "Late",
    hint: "Arrived after the shift start and its grace time.",
    cell: "border-amber-300 bg-amber-100 text-amber-950",
    bar: "border-l-amber-500",
    pill: "bg-amber-500 text-white",
    swatch: "bg-amber-500",
  },
  permission: {
    label: "Permission",
    short: "Permission",
    hint: "An approved permission (Morning Late-In, Evening Early-Out or Middle One-Hour) within the monthly cap.",
    cell: "border-blue-300 bg-blue-100 text-blue-950",
    bar: "border-l-blue-600",
    pill: "bg-blue-600 text-white",
    swatch: "bg-blue-600",
  },
  excess_permission: {
    label: "Excess permission",
    short: "Excess",
    hint: "An approved permission beyond the monthly cap: it did not excuse the day.",
    cell: "border-rose-400 bg-rose-200 text-rose-950",
    bar: "border-l-rose-600",
    pill: "bg-rose-600 text-white",
    swatch: "bg-rose-600",
  },
  on_duty: {
    label: "On-Duty",
    short: "On-Duty",
    hint: "The day was inside an approved On-Duty (field visit) request.",
    cell: "border-teal-300 bg-teal-100 text-teal-950",
    bar: "border-l-teal-600",
    pill: "bg-teal-600 text-white",
    swatch: "bg-teal-600",
  },
  on_duty_punch: {
    label: "On-Duty punch",
    short: "OD punch",
    hint: "A geo-punch taken during an On-Duty request was approved and counted as a punch of the day.",
    cell: "border-indigo-300 bg-indigo-100 text-indigo-950",
    bar: "border-l-indigo-600",
    pill: "bg-indigo-600 text-white",
    swatch: "bg-indigo-600",
  },
  missed_punch: {
    label: "Missed punch",
    short: "Missed",
    hint: "A punch was missing, or was added by an approved Missing Punch request.",
    cell: "border-fuchsia-300 bg-fuchsia-100 text-fuchsia-950",
    bar: "border-l-fuchsia-600",
    pill: "bg-fuchsia-600 text-white",
    swatch: "bg-fuchsia-600",
  },
};

// What the payroll's own issues already say about a day, for a server that does not send `marks` (or sends fewer).
const FLAG_MARKS: Partial<Record<IssueCode, DayMark>> = {
  late_in: "late",
  excess_permission: "excess_permission",
  missing_punch: "missed_punch",
};

/** The categories a day carries, in the fixed order of MARK_KEYS: what the server marked plus what payroll flagged on it. */
export function marksOf(day: Pick<PayrollDay, "marks" | "flags">): DayMark[] {
  const found = new Set<DayMark>(day.marks ?? []);
  for (const flag of day.flags ?? []) {
    const mark = FLAG_MARKS[flag];
    if (mark) found.add(mark);
  }
  return MARK_KEYS.filter((k) => found.has(k));
}

/** Which category fills a day's cell when it carries several: the one that needs the most attention first. */
export const MARK_FILL_ORDER: DayMark[] = [
  "excess_permission",
  "permission",
  "missed_punch",
  "on_duty_punch",
  "on_duty",
  "late",
];

// A day that was not worked (absent, a leave, a holiday) or was cut to half keeps the colour of that status: it is what the
// pay follows. The categories it carries are still shown on it as tags.
const STATUS_FILLS: DayKind[] = ["half", "absent", "unpaid", "leave", "onleave", "holiday", "other"];

/** The category that fills the cell of a day, or null when the cell shows the day's status (a plain day, or a status that wins). */
export function fillMark(day: Pick<PayrollDay, "status" | "flags" | "marks" | "shifts">): DayMark | null {
  if (STATUS_FILLS.includes(dayKind(day))) return null;
  const marks = marksOf(day);
  return MARK_FILL_ORDER.find((m) => marks.includes(m)) ?? null;
}

/** How many days each status colours on the calendar (the days a category fills are counted under that category). */
export function fillKindCounts(days: PayrollDay[]): Record<DayKind, number> {
  const counts = Object.fromEntries(DAY_KINDS.map((k) => [k, 0])) as Record<DayKind, number>;
  for (const day of days) if (fillMark(day) === null) counts[dayKind(day)] += 1;
  return counts;
}

export function markCounts(days: PayrollDay[]): Record<DayMark, number> {
  const counts = Object.fromEntries(MARK_KEYS.map((k) => [k, 0])) as Record<DayMark, number>;
  for (const day of days) for (const mark of marksOf(day)) counts[mark] += 1;
  return counts;
}

/** "paid_leave" -> "Paid leave": a status the server sent, in words. */
export function statusLabel(status: string | null | undefined): string {
  const text = (status ?? "").replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}

export function kindCounts(days: PayrollDay[]): Record<DayKind, number> {
  const counts = Object.fromEntries(DAY_KINDS.map((k) => [k, 0])) as Record<DayKind, number>;
  for (const day of days) counts[dayKind(day)] += 1;
  return counts;
}

export function filterDays(
  days: PayrollDay[],
  opts: { kind: DayKind | "all"; flaggedOnly: boolean; mark?: DayMark | "all"; plainOnly?: boolean },
): PayrollDay[] {
  const mark = opts.mark ?? "all";
  return days.filter(
    (d) =>
      (opts.kind === "all" || (dayKind(d) === opts.kind && (!opts.plainOnly || fillMark(d) === null))) &&
      (!opts.flaggedOnly || (d.flags ?? []).length > 0) &&
      (mark === "all" || marksOf(d).includes(mark)),
  );
}

export type CalendarCell =
  | { type: "blank"; key: string }
  | { type: "day"; key: string; date: string; dayNumber: number; day: PayrollDay | null; kind: DayKind | null };

export const CALENDAR_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The calendar grid, Monday first: blank cells before the first day (as many as its weekday needs) and after the last
 * one, so every row has seven cells. It covers the period and any day the payroll has a record for; a day with no
 * record is a cell with no data.
 */
export function buildCalendar(days: PayrollDay[], start?: string | null, end?: string | null): CalendarCell[][] {
  const dates = days.map((d) => d.date).sort();
  const first = [start, dates[0]].filter((d): d is string => !!parseIso(d)).sort()[0];
  const last = [end, dates[dates.length - 1]]
    .filter((d): d is string => !!parseIso(d))
    .sort()
    .at(-1);
  if (!first || !last) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cells: CalendarCell[] = [];
  for (let i = 0; i < weekdayOffset(first); i += 1) cells.push({ type: "blank", key: `lead-${i}` });
  for (const date of eachDay(first, last)) {
    const day = byDate.get(date) ?? null;
    cells.push({
      type: "day",
      key: date,
      date,
      dayNumber: parseIso(date)?.day ?? 0,
      day,
      kind: day ? dayKind(day) : null,
    });
  }
  for (let i = 0; cells.length % 7 !== 0; i += 1) cells.push({ type: "blank", key: `trail-${i}` });
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export const countRules = (groups: RuleGroup[]): number => groups.reduce((n, g) => n + g.items.length, 0);

/** True when the rule is not what the payroll was generated with: regenerating would price it differently. */
export function isRuleChanged(item: RuleItem): boolean {
  if (item.changed !== undefined && item.changed !== null) return item.changed;
  return !!item.applied && item.applied !== item.value;
}

export function changedRules(groups: RuleGroup[]): { group: string; item: RuleItem }[] {
  return groups.flatMap((g) => g.items.filter(isRuleChanged).map((item) => ({ group: g.group, item })));
}

// ── Money and the dashboard ───────────────────────────────────────────────────

export function summaryNumber(summary: PayrollDetails["summary"] | null | undefined, key: string): number | null {
  const v = summary?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A number with at most two decimals and no trailing zeros: 23.5, 26, 0.25. */
export const trimNumber = (n: number): string => String(Math.round(n * 100) / 100);

/** The "Days worked" (staff) or "Shifts" (production) tile: one big figure and a line that explains it. */
export function workTile(
  details: Pick<PayrollDetails, "summary">,
  kind: PayrollKind,
): { label: string; value: string; outOf: string | null; sub: string } {
  const s = details.summary ?? {};
  const n = (key: string) => summaryNumber(s, key);
  if (kind === "production") {
    const shifts = n("totalShifts") ?? n("totalSessions");
    const worked = n("daysWorked");
    const absent = n("daysAbsent");
    return {
      label: "Shifts",
      value: shifts === null ? "—" : trimNumber(shifts),
      outOf: null,
      sub: [worked !== null ? `${plural(worked, "day")} worked` : "", absent ? `${absent} absent` : ""]
        .filter(Boolean)
        .join(" · "),
    };
  }
  const effective = n("effectivePaidDays") ?? n("presentDays");
  const working = n("totalWorkingDays");
  const present = n("presentDays");
  const leave = n("paidLeaveDays");
  const lop = (n("absentDays") ?? 0) + (n("unpaidLeaveDays") ?? 0);
  const parts = [
    present !== null ? `${trimNumber(present)} present` : "",
    leave ? `${trimNumber(leave)} paid leave` : "",
    n("halfShiftDays") ? `${trimNumber(n("halfShiftDays")!)} half` : "",
    lop ? `${trimNumber(lop)} LOP` : "",
  ].filter(Boolean);
  return {
    label: "Days worked",
    value: effective === null ? "—" : trimNumber(effective),
    outOf: effective !== null && working !== null ? trimNumber(working) : null,
    sub: parts.join(" · "),
  };
}

/** The Gross -> Deductions -> Net bar: how much of the gross went on deductions, and what the figures add up to. */
export function netBridge(money: PayrollDetails["money"]): {
  deductionsPct: number;
  netPct: number;
  bonus: number;
  other: number;
  otherIsOvertime: boolean;
} {
  const gross = money.gross ?? 0;
  const deductions = money.deductions ?? 0;
  const bonus = money.bonus ?? 0;
  const deductionsPct = gross > 0 ? Math.min(100, Math.max(0, (deductions / gross) * 100)) : 0;
  const residual = (money.net ?? 0) - (gross - deductions + bonus);
  const other = Math.abs(residual) >= 0.5 ? Math.round(residual * 100) / 100 : 0;
  return {
    deductionsPct,
    netPct: 100 - deductionsPct,
    bonus,
    other,
    otherIsOvertime: other !== 0 && !!money.otAmount && Math.abs(other - money.otAmount) < 0.5,
  };
}

/**
 * True when the payroll has no day-by-day breakdown behind it (an older session-based production payroll, or one with no
 * stored salary slip): its days, rules and issues cannot be shown, and the page says so instead of looking merely empty.
 */
export function isDegraded(details: Pick<PayrollDetails, "kind" | "days" | "rules">): boolean {
  return details.kind === "legacy_session" || (details.days.length === 0 && details.rules.length === 0);
}

// ── A safe shape ──────────────────────────────────────────────────────────────

/**
 * The payload with every list and object guaranteed to be there, so a section of a half-filled response (or an older
 * server) shows "nothing here" instead of crashing the whole page.
 */
export function normalizeDetails(raw: PayrollDetails): PayrollDetails {
  const issues = raw.issues ?? [];
  const counts = severityCounts(issues);
  return {
    ...raw,
    earnings: raw.earnings ?? [],
    deductions: raw.deductions ?? [],
    rules: raw.rules ?? [],
    issues,
    days: raw.days ?? [],
    advances: raw.advances ?? [],
    history: raw.history ?? [],
    summary: raw.summary ?? {},
    money: {
      gross: 0,
      deductions: 0,
      bonus: 0,
      otAmount: 0,
      net: 0,
      monthlySalary: null,
      dailyRate: null,
      ...(raw.money as Partial<PayrollDetails["money"]> | undefined),
    },
    issueCounts: raw.issueCounts ?? { total: issues.length, bySeverity: counts, byCode: {} },
    neighbours: {
      previousId: null,
      nextId: null,
      position: 1,
      total: 1,
      ...(raw.neighbours as Partial<PayrollDetails["neighbours"]> | undefined),
    },
    employee: {
      ...raw.employee,
      bank: {
        hasAccount: false,
        bankName: null,
        hasIfsc: false,
        accountLast4: null,
        ...(raw.employee?.bank as Partial<PayrollDetails["employee"]["bank"]> | undefined),
      },
    },
  };
}
