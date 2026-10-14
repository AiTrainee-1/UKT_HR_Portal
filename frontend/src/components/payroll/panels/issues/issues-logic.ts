import type { TableColumn } from "@/components/payroll/kit/export-table";
import { dateLong, dateShort, dateTime, inr, inr2, plural } from "@/components/payroll/kit/format";
import { ISSUE_META, SEVERITY_META, issueLabel, severityRank } from "@/components/payroll/kit/issue-meta";
import type { IssueCode, IssueCodeCount, IssueSeverity, PayrollIssue } from "@/lib/api-client/custom-hooks";
import { classifySkipReason } from "../skipped/skipped-logic";
import type { SkippedItem } from "../skipped/skipped-types";
import { NO_DEPARTMENT, byText, departmentsOf } from "./lists";

export { NO_DEPARTMENT };

// Everything the Issues panel decides, kept free of React so it can be tested on its own: which issues the filters keep,
// how they are grouped (by day, by employee, by type), what a page of them holds, what an issue cost in words, and how
// the employees payroll skipped are added to the list.

// ── The filters (all strings, so a page can keep them in its address) ──────────

export type IssueGroupBy = "date" | "employee" | "type";

export const GROUP_BY_OPTIONS: { value: IssueGroupBy; label: string }[] = [
  { value: "date", label: "Date" },
  { value: "employee", label: "Employee" },
  { value: "type", label: "Type" },
];

export type IssueFilterState = {
  /** Search over the employee's name and code, the title and the detail. */
  q: string;
  /** An IssueCode, or "" for every type. */
  code: string;
  /** "critical" | "warning" | "info", or "" for every severity. */
  severity: string;
  /** A department name, NO_DEPARTMENT for issues of people with none, or "" for every department. */
  dept: string;
  /** The day the issue was detected on is from ... to ... (ISO days, both ends included); "" leaves that end open. */
  from: string;
  to: string;
  /** "date" | "employee" | "type": how the list is arranged (a view option, not a filter). */
  groupBy: string;
};

export const DEFAULT_ISSUE_FILTERS: IssueFilterState = {
  q: "",
  code: "",
  severity: "",
  dept: "",
  from: "",
  to: "",
  groupBy: "date",
};

/** Rows on a page: 30 issues (by date / by type) or 30 employees (by employee, whose accordions are never split). */
export const PAGE_SIZE = 30;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isSeverity = (value: string): value is IssueSeverity =>
  value === "critical" || value === "warning" || value === "info";

export const normalizeGroupBy = (value: string | undefined): IssueGroupBy =>
  value === "employee" || value === "type" ? value : "date";

/** The day part of an ISO date or datetime; null for a whole-period issue (or anything that is not a date). */
const dayOf = (iso: string | null | undefined): string | null => {
  const day = iso?.slice(0, 10) ?? "";
  return ISO_DAY.test(day) ? day : null;
};

/**
 * The filters as they are used: a page that keeps them in its address can hand over anything ("?severity=bogus",
 * "?from=yesterday"), so an unknown severity or grouping and a malformed date are dropped, and a range typed the wrong
 * way round is put the right way round.
 */
export function sanitizeFilters(f: Partial<IssueFilterState> | undefined): IssueFilterState {
  const base = { ...DEFAULT_ISSUE_FILTERS, ...f };
  let from = ISO_DAY.test(base.from) ? base.from : "";
  let to = ISO_DAY.test(base.to) ? base.to : "";
  if (from && to && from > to) [from, to] = [to, from];
  return {
    q: base.q,
    code: base.code,
    severity: isSeverity(base.severity) ? base.severity : "",
    dept: base.dept,
    from,
    to,
    groupBy: normalizeGroupBy(base.groupBy),
  };
}

/** How many filters narrow the list (a date range counts once; the grouping is not a filter). */
export function activeFilterCount(f: Partial<IssueFilterState> | undefined): number {
  const s = sanitizeFilters(f);
  return (s.q.trim() ? 1 : 0) + (s.code ? 1 : 0) + (s.severity ? 1 : 0) + (s.dept ? 1 : 0) + (s.from || s.to ? 1 : 0);
}

/**
 * The issues the filters keep. Every word typed in the search must appear somewhere in the employee's name or code, the
 * title or the detail. A date range keeps only issues detected on a day inside it: an issue about the whole period has
 * no day, so a range hides it.
 */
export function filterIssues(issues: PayrollIssue[], filters: Partial<IssueFilterState> | undefined): PayrollIssue[] {
  const f = sanitizeFilters(filters);
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const ranged = !!(f.from || f.to);
  return issues.filter((issue) => {
    if (f.code && issue.code !== f.code) return false;
    if (f.severity && issue.severity !== f.severity) return false;
    if (f.dept && (issue.department ?? NO_DEPARTMENT) !== f.dept) return false;
    if (ranged) {
      const day = dayOf(issue.date);
      if (!day) return false;
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
    }
    if (words.length > 0) {
      const hay = `${issue.employeeName} ${issue.employeeCode} ${issue.title} ${issue.detail}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** How many issues a date range hides only because they are about the whole period (so the screen can say so). */
export function wholePeriodHiddenByRange(
  issues: PayrollIssue[],
  filters: Partial<IssueFilterState> | undefined,
): number {
  const f = sanitizeFilters(filters);
  if (!f.from && !f.to) return 0;
  const withoutRange = filterIssues(issues, { ...f, from: "", to: "" });
  return withoutRange.filter((i) => dayOf(i.date) === null).length;
}

/** What the active filters are, in words (the line under an exported sheet's title). */
export function describeIssueFilters(
  filters: Partial<IssueFilterState> | undefined,
  labels: Record<string, string> = {},
) {
  const f = sanitizeFilters(filters);
  const out: string[] = [];
  if (f.q.trim()) out.push(`Search "${f.q.trim()}"`);
  if (f.severity) out.push(`Severity ${SEVERITY_META[f.severity as IssueSeverity].label}`);
  if (f.code) out.push(`Type ${labels[f.code] ?? issueLabel(f.code)}`);
  if (f.dept) out.push(`Department ${f.dept === NO_DEPARTMENT ? "none" : f.dept}`);
  if (f.from || f.to)
    out.push(`Detected ${f.from ? dateShort(f.from) : "from the start"} to ${f.to ? dateShort(f.to) : "the end"}`);
  return out;
}

// ── What an issue cost ────────────────────────────────────────────────────────

type ImpactLike = { days?: number | null; shifts?: number | null; amount?: number | null; label?: string | null };

export type ImpactTotals = { days: number; shifts: number; amount: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * An impact in words: "0.5 days · ₹567". Whatever is zero or missing is left out; a label the server sent ("Within the
 * free allowance") is added at the end, or stands alone when there are no numbers. An issue that cost nothing reads "".
 */
export function issueImpactText(impact: ImpactLike | null | undefined): string {
  if (!impact) return "";
  const parts: string[] = [];
  if (impact.days) parts.push(plural(round2(impact.days), "day"));
  if (impact.shifts) parts.push(plural(round2(impact.shifts), "shift"));
  if (impact.amount) parts.push(Number.isInteger(impact.amount) ? inr(impact.amount) : inr2(impact.amount));
  if (impact.label) parts.push(impact.label);
  return parts.join(" · ");
}

/**
 * What a set of issues cost together. Information-only issues (overtime pay, an advance recovered, a manual
 * adjustment) are left out unless asked for: they are not problems, and adding what was earned to what was lost would
 * make a meaningless total.
 */
export function sumImpact(issues: PayrollIssue[], opts: { includeInfo?: boolean } = {}): ImpactTotals {
  let days = 0;
  let shifts = 0;
  let amount = 0;
  for (const issue of issues) {
    if (!issue.impact) continue;
    if (issue.severity === "info" && !opts.includeInfo) continue;
    days += issue.impact.days ?? 0;
    shifts += issue.impact.shifts ?? 0;
    amount += issue.impact.amount ?? 0;
  }
  return { days: round2(days), shifts: round2(shifts), amount: round2(amount) };
}

// ── The skipped employees ─────────────────────────────────────────────────────

/** An employee payroll skipped, as an issue of its own (code "skipped"): critical, no payroll row, no day, the reason as the detail. */
export function skippedToIssue(item: SkippedItem): PayrollIssue {
  const info = classifySkipReason(item.reason, item.employeeId);
  return {
    id: `skipped:${item.employeeId}`,
    payrollId: null,
    employeeId: item.employeeId,
    employeeCode: item.employeeCode,
    employeeName: item.name,
    department: item.department ?? null,
    designation: null,
    code: "skipped",
    category: "generation",
    severity: "critical",
    title: ISSUE_META.skipped.label,
    detail: item.reason,
    date: null,
    detectedAt: null,
    impact: info.blocksPay ? { label: "Not paid until fixed" } : null,
    rule: null,
  };
}

/**
 * The issues payroll detected plus one "skipped" issue per skipped employee. Merging again changes nothing (an employee
 * already listed as skipped is not added twice), and with nobody skipped the same array comes back.
 */
export function mergeSkipped(issues: PayrollIssue[], skipped: SkippedItem[] | undefined): PayrollIssue[] {
  if (!skipped || skipped.length === 0) return issues;
  const have = new Set(issues.filter((i) => i.code === "skipped").map((i) => i.employeeId));
  const extra: PayrollIssue[] = [];
  for (const item of skipped) {
    if (have.has(item.employeeId)) continue;
    have.add(item.employeeId);
    extra.push(skippedToIssue(item));
  }
  return extra.length > 0 ? [...issues, ...extra] : issues;
}

// ── Counts for the strip, the quick filters and the selects ───────────────────

export type IssuesTotals = { total: number; bySeverity: Record<IssueSeverity, number>; employees: number };

export function summarizeIssues(issues: PayrollIssue[]): IssuesTotals {
  const bySeverity: Record<IssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
  const people = new Set<number>();
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    people.add(issue.employeeId);
  }
  return { total: issues.length, bySeverity, employees: people.size };
}

/** The names the server gave each code (summary.byCode); a code it did not name falls back to the kit's label. */
export function typeLabelMap(byCode: IssueCodeCount[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of byCode ?? []) if (entry.label) out[entry.code] = entry.label;
  return out;
}

export type IssueTypeCount = { code: IssueCode; label: string; severity: IssueSeverity; count: number };

/** The issue types that occur, worst severity first, then the most frequent. */
export function issueTypeCounts(issues: PayrollIssue[], byCode?: IssueCodeCount[]): IssueTypeCount[] {
  const labels = typeLabelMap(byCode);
  const severityOf = new Map<IssueCode, IssueSeverity>((byCode ?? []).map((c) => [c.code, c.severity]));
  const found = new Map<IssueCode, { count: number; severity: IssueSeverity }>();
  for (const issue of issues) {
    const entry = found.get(issue.code);
    if (entry) entry.count += 1;
    else found.set(issue.code, { count: 1, severity: severityOf.get(issue.code) ?? issue.severity });
  }
  return [...found]
    .map(([code, { count, severity }]) => ({ code, label: labels[code] ?? issueLabel(code), severity, count }))
    .sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.count - a.count || byText(a.label, b.label),
    );
}

/** "Absent, Late arrival +1 more": the names of the issue types of one severity, for the line under a figure. */
export function severityTypeNames(types: IssueTypeCount[], severity: IssueSeverity, max = 2): string | undefined {
  const names = types.filter((t) => t.severity === severity).map((t) => t.label);
  if (names.length === 0) return undefined;
  return names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max} more` : names.join(", ");
}

/** The departments that occur in the issues (sorted), and whether some issues belong to people with none. */
export const issueDepartments = (issues: PayrollIssue[]) => departmentsOf(issues);

// ── Grouping ──────────────────────────────────────────────────────────────────

const PERIOD_KEY = "period";

export type IssueGroup = {
  /** Stable within a list: the day, "period", the employee id or the issue code. */
  key: string;
  by: IssueGroupBy;
  /** The header: "Tue, 13 Oct 2026", "Whole period", the employee's name, the type's name. */
  label: string;
  /** Date groups: the day, or null for the whole-period group. Other groups: null. */
  date: string | null;
  employeeId: number | null;
  code: IssueCode | null;
  /** Every issue of the group, in the order they are listed. */
  issues: PayrollIssue[];
  severity: Record<IssueSeverity, number>;
  /** What the group's issues cost together (see sumImpact; by type the information-only ones count too). */
  impact: ImpactTotals;
};

const keyOf = (by: IssueGroupBy, issue: PayrollIssue): string =>
  by === "date" ? (dayOf(issue.date) ?? PERIOD_KEY) : by === "employee" ? String(issue.employeeId) : issue.code;

const dateRank = (issue: PayrollIssue) => dayOf(issue.date) ?? "9999-99-99"; // whole-period issues last
const bySeverityThenName = (a: PayrollIssue, b: PayrollIssue) =>
  severityRank(a.severity) - severityRank(b.severity) ||
  byText(a.employeeName, b.employeeName) ||
  byText(a.title, b.title);
const byDateThenSeverity = (a: PayrollIssue, b: PayrollIssue) =>
  dateRank(a).localeCompare(dateRank(b)) ||
  severityRank(a.severity) - severityRank(b.severity) ||
  byText(a.title, b.title);
const byDateThenName = (a: PayrollIssue, b: PayrollIssue) =>
  dateRank(a).localeCompare(dateRank(b)) || byText(a.employeeName, b.employeeName) || byText(a.title, b.title);

function makeGroup(by: IssueGroupBy, key: string, issues: PayrollIssue[], labels: Record<string, string>): IssueGroup {
  const first = issues[0];
  const severity: Record<IssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) severity[issue.severity] = (severity[issue.severity] ?? 0) + 1;
  const sorted = [...issues].sort(
    by === "date" ? bySeverityThenName : by === "employee" ? byDateThenSeverity : byDateThenName,
  );
  return {
    key,
    by,
    label:
      by === "date"
        ? key === PERIOD_KEY
          ? "Whole period"
          : dateLong(key)
        : by === "employee"
          ? first.employeeName
          : (labels[first.code] ?? issueLabel(first.code)),
    date: by === "date" && key !== PERIOD_KEY ? key : null,
    employeeId: by === "employee" ? first.employeeId : null,
    code: by === "type" ? first.code : null,
    issues: sorted,
    severity,
    impact: sumImpact(issues, { includeInfo: by === "type" }),
  };
}

/**
 * The issues arranged for reading, whole groups in the order they are listed:
 *  - by date: day by day from the start of the period, whole-period issues in a final group;
 *  - by employee: the people with the worst issues first (most critical, then most "needs a look"), then by name;
 *  - by type: the worst kinds first, then the most frequent.
 * Inside a group the issues are ordered for that view (worst first within a day, oldest first for a person or a type).
 */
export function groupIssues(
  issues: PayrollIssue[],
  by: IssueGroupBy,
  labels: Record<string, string> = {},
): IssueGroup[] {
  const buckets = new Map<string, PayrollIssue[]>();
  for (const issue of issues) {
    const key = keyOf(by, issue);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(issue);
    else buckets.set(key, [issue]);
  }
  const groups = [...buckets].map(([key, list]) => makeGroup(by, key, list, labels));
  if (by === "date") {
    return groups.sort((a, b) => (a.date === null ? 1 : b.date === null ? -1 : a.date.localeCompare(b.date)));
  }
  if (by === "employee") {
    return groups.sort(
      (a, b) =>
        b.severity.critical - a.severity.critical ||
        b.severity.warning - a.severity.warning ||
        b.severity.info - a.severity.info ||
        byText(a.label, b.label),
    );
  }
  const worst = (g: IssueGroup) => Math.min(...g.issues.map((i) => severityRank(i.severity)));
  return groups.sort((a, b) => worst(a) - worst(b) || b.issues.length - a.issues.length || byText(a.label, b.label));
}

// ── Pages ─────────────────────────────────────────────────────────────────────

/** A group as one page shows it: the rows of it that are on this page, and whether it started on an earlier page. */
export type PagedGroup = { group: IssueGroup; rows: PayrollIssue[]; continued: boolean };

export type IssuePage = {
  /** The page shown (the one asked for, kept inside 1..totalPages). */
  page: number;
  totalPages: number;
  /** Rows in all: issues (by date / by type) or employees (by employee). */
  total: number;
  /** The first and last row on this page, 1-based (0 and 0 when there are none). */
  from: number;
  to: number;
  groups: PagedGroup[];
};

/**
 * One page of grouped issues. By date and by type the page holds `size` issues and a group may carry on over the page
 * break (its header is repeated, marked continued). By employee the page holds `size` employees, each with all their
 * issues: an accordion is never cut in two.
 */
export function paginateGroups(groups: IssueGroup[], by: IssueGroupBy, page: number, size = PAGE_SIZE): IssuePage {
  const units = by === "employee" ? groups.length : groups.reduce((n, g) => n + g.issues.length, 0);
  const totalPages = Math.max(1, Math.ceil(units / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (current - 1) * size;
  const end = Math.min(start + size, units);
  const paged: PagedGroup[] = [];

  if (by === "employee") {
    for (const group of groups.slice(start, end)) paged.push({ group, rows: group.issues, continued: false });
  } else {
    let seen = 0;
    for (const group of groups) {
      const first = seen;
      seen += group.issues.length;
      if (seen <= start) continue;
      if (first >= end) break;
      paged.push({
        group,
        rows: group.issues.slice(Math.max(start, first) - first, Math.min(end, seen) - first),
        continued: first < start,
      });
    }
  }
  return { page: current, totalPages, total: units, from: units === 0 ? 0 : start + 1, to: end, groups: paged };
}

/** "Showing 1–30 of 120 issues" / "Showing employees 1–30 of 45 (120 issues)". */
export function showingText(page: IssuePage, by: IssueGroupBy, issueCount: number): string {
  if (page.total === 0) return "";
  const range = page.from === page.to ? `${page.from}` : `${page.from}–${page.to}`;
  return by === "employee"
    ? `Showing employees ${range} of ${page.total} (${plural(issueCount, "issue")})`
    : `Showing ${range} of ${plural(page.total, "issue")}`;
}

/** The issue an employee's "Open details" opens: the first one that has a payroll to open. */
export const detailsTarget = (issues: PayrollIssue[]): PayrollIssue | undefined =>
  issues.find((i) => i.payrollId !== null);

// ── Export ────────────────────────────────────────────────────────────────────

/** The sheet's columns, in the order the owner asked for. `labels` are the server's names for the issue codes. */
export function issueExportColumns(labels: Record<string, string> = {}): TableColumn<PayrollIssue>[] {
  return [
    { key: "date", label: "Date detected", width: 16, type: "date", value: (i) => dayOf(i.date) ?? "Whole period" },
    { key: "code", label: "Employee code", width: 14, value: (i) => i.employeeCode },
    { key: "employee", label: "Employee", width: 26, value: (i) => i.employeeName },
    { key: "department", label: "Department", width: 20, value: (i) => i.department ?? "" },
    { key: "type", label: "Type", width: 22, value: (i) => labels[i.code] ?? issueLabel(i.code) },
    { key: "severity", label: "Severity", width: 16, value: (i) => SEVERITY_META[i.severity]?.label ?? i.severity },
    { key: "title", label: "Title", width: 26, value: (i) => i.title },
    { key: "detail", label: "Details", width: 70, value: (i) => i.detail },
    { key: "impact", label: "Impact", width: 24, value: (i) => issueImpactText(i.impact) },
    { key: "rule", label: "Rule", width: 30, value: (i) => i.rule?.label ?? "" },
    { key: "flagged", label: "Flagged at", width: 20, value: (i) => (i.detectedAt ? dateTime(i.detectedAt) : "") },
  ];
}
