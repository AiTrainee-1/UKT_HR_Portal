// The payroll filters as plain data: what a filter bar can ask for, how that is applied to a list of payroll rows, how it
// is kept in the address (?q=&dept=&status=&issue=&severity=&issues=1&sort=) and which issues belong to which payroll.
// Everything here is pure, so the same rules drive the staff page, the production pages and their tests.

import type { IssueCodeCount, IssueSeverity, PayrollIssue, PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { SEVERITY_META, issueLabel, severityRank } from "@/components/payroll/kit/issue-meta";

// ── The filter state ──────────────────────────────────────────────────────────

export type PayStatusFilter = "all" | "pending" | "paid";
export type PayrollSort = "name" | "net" | "issues";

export type PayrollFilterState = {
  /** The employee's name or code. Every word typed must be found. */
  q: string;
  /** "all", "none" (no department) or a department id. */
  dept: string;
  status: PayStatusFilter;
  /** "all" or one issue code ("late_in"). */
  issue: string;
  /** "all" or severities joined by commas, worst first ("critical,warning"). */
  severity: string;
  /** Only payrolls that have at least one issue. */
  onlyIssues: boolean;
  sort: PayrollSort;
};

export const ALL = "all";
export const NO_DEPARTMENT = "none";

export const DEFAULT_FILTERS: Readonly<PayrollFilterState> = Object.freeze({
  q: "",
  dept: ALL,
  status: ALL,
  issue: ALL,
  severity: ALL,
  onlyIssues: false,
  sort: "name",
});

export const STATUS_OPTIONS: readonly { value: PayStatusFilter; label: string }[] = [
  { value: "all", label: "All payments" },
  { value: "pending", label: "Pending" },
  { value: "paid", label: "Cleared" },
];

export const SORT_OPTIONS: readonly { value: PayrollSort; label: string }[] = [
  { value: "name", label: "Name (A to Z)" },
  { value: "net", label: "Net salary, high to low" },
  { value: "issues", label: "Most issues" },
];

/** Worst first: the order severity chips are drawn and joined in. */
export const SEVERITY_ORDER: readonly IssueSeverity[] = ["critical", "warning", "info"];

/** "critical,warning" -> ["critical", "warning"]; anything unknown is dropped, "all" and "" mean none chosen. */
export function parseSeverities(value: string | null | undefined): IssueSeverity[] {
  if (!value || value === ALL) return [];
  const wanted = new Set(value.split(",").map((s) => s.trim()));
  return SEVERITY_ORDER.filter((s) => wanted.has(s));
}

/** The reverse of parseSeverities: worst first, "all" when none is chosen. */
export function joinSeverities(list: readonly IssueSeverity[]): string {
  const ordered = SEVERITY_ORDER.filter((s) => list.includes(s));
  return ordered.length > 0 ? ordered.join(",") : ALL;
}

/** The severity filter after a chip is clicked: on becomes off, off becomes on. */
export function toggleSeverity(value: string, severity: IssueSeverity): string {
  const current = parseSeverities(value);
  return joinSeverities(current.includes(severity) ? current.filter((s) => s !== severity) : [...current, severity]);
}

/** How many filters narrow the list now (the sort is not one). Each chosen severity counts, like its chip does. */
export function activeFilterCount(state: PayrollFilterState): number {
  return (
    (state.q.trim() ? 1 : 0) +
    (state.dept !== ALL ? 1 : 0) +
    (state.status !== ALL ? 1 : 0) +
    (state.issue !== ALL ? 1 : 0) +
    parseSeverities(state.severity).length +
    (state.onlyIssues ? 1 : 0)
  );
}

/** True when Reset would change anything: a filter is on, or the sort is not the default. */
export const hasChanges = (state: PayrollFilterState): boolean =>
  activeFilterCount(state) > 0 || state.sort !== DEFAULT_FILTERS.sort;

export type DepartmentOption = { id: number | string; name: string };

/** The departments the rows belong to, for a page that has no department list of its own ("No department" last). */
export function departmentOptionsFromRuns(runs: readonly PayrollRunItem[] | null | undefined): DepartmentOption[] {
  const byId = new Map<string, string>();
  let missing = false;
  for (const run of runs ?? []) {
    if (run.departmentId === null || run.departmentId === undefined) {
      missing = true;
      continue;
    }
    byId.set(String(run.departmentId), (run.departmentName ?? "").trim() || `Department ${run.departmentId}`);
  }
  const options: DepartmentOption[] = [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (missing) options.push({ id: NO_DEPARTMENT, name: "No department" });
  return options;
}

export function departmentLabel(dept: string, departments: readonly DepartmentOption[] = []): string {
  if (dept === ALL) return "All departments";
  if (dept === NO_DEPARTMENT) return "No department";
  const found = departments.find((d) => String(d.id) === dept);
  return found ? found.name : `Department ${dept}`;
}

export function issueTypeLabel(code: string, issues: readonly IssueCodeCount[] = []): string {
  return issues.find((i) => i.code === code)?.label ?? issueLabel(code);
}

/** One removable chip of the filter bar: what it says, and the change that takes the filter off again. */
export type FilterChip = { key: string; label: string; clear: Partial<PayrollFilterState> };

export function filterChips(
  state: PayrollFilterState,
  lookup: { departments?: readonly DepartmentOption[]; issues?: readonly IssueCodeCount[] } = {},
): FilterChip[] {
  const chips: FilterChip[] = [];
  const q = state.q.trim();
  if (q) chips.push({ key: "q", label: `Search: "${q}"`, clear: { q: "" } });
  if (state.dept !== ALL)
    chips.push({
      key: "dept",
      label: `Department: ${departmentLabel(state.dept, lookup.departments)}`,
      clear: { dept: ALL },
    });
  if (state.status !== ALL) {
    const label = STATUS_OPTIONS.find((o) => o.value === state.status)?.label ?? state.status;
    chips.push({ key: "status", label: `Payment: ${label}`, clear: { status: ALL } });
  }
  if (state.issue !== ALL)
    chips.push({
      key: "issue",
      label: `Issue: ${issueTypeLabel(state.issue, lookup.issues)}`,
      clear: { issue: ALL },
    });
  for (const sev of parseSeverities(state.severity))
    chips.push({
      key: `severity-${sev}`,
      label: `Severity: ${SEVERITY_META[sev].label}`,
      clear: { severity: toggleSeverity(state.severity, sev) },
    });
  if (state.onlyIssues) chips.push({ key: "onlyIssues", label: "Only with issues", clear: { onlyIssues: false } });
  return chips;
}

// ── Which issues belong to which payroll ──────────────────────────────────────

/** What filtering needs to know about one payroll's issues. */
export type IssueIndexEntry = { total: number; codes: Set<string>; severities: Set<string> };
export type IssueIndex = ReadonlyMap<number, IssueIndexEntry>;

/** Issues grouped by payroll id (an issue with no payroll, like a skipped employee, belongs to no row). */
export function buildIssueIndex(issues: readonly PayrollIssue[] | null | undefined): Map<number, IssueIndexEntry> {
  const index = new Map<number, IssueIndexEntry>();
  for (const issue of issues ?? []) {
    if (issue.payrollId === null || issue.payrollId === undefined) continue;
    const entry = index.get(issue.payrollId) ?? { total: 0, codes: new Set<string>(), severities: new Set<string>() };
    entry.total += 1;
    entry.codes.add(issue.code);
    entry.severities.add(issue.severity);
    index.set(issue.payrollId, entry);
  }
  return index;
}

/** One payroll's issues as a record card shows them. `severity` and `label` are optional so a caller can send just counts. */
export type PayrollIssueSummary = {
  total: number;
  bySeverity: Record<IssueSeverity, number>;
  /** Issue types of this payroll, most frequent first. */
  codes: { code: string; count: number; severity?: IssueSeverity; label?: string }[];
};

/** Issues grouped by payroll id with the counts a record card draws: per severity and per type. */
export function buildIssueSummaries(
  issues: readonly PayrollIssue[] | null | undefined,
): Map<number, PayrollIssueSummary> {
  type Acc = {
    total: number;
    bySeverity: Record<IssueSeverity, number>;
    byCode: Map<string, { count: number; severity: IssueSeverity; label: string }>;
  };
  const groups = new Map<number, Acc>();
  for (const issue of issues ?? []) {
    if (issue.payrollId === null || issue.payrollId === undefined) continue;
    const acc = groups.get(issue.payrollId) ?? {
      total: 0,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      byCode: new Map(),
    };
    acc.total += 1;
    acc.bySeverity[issue.severity] += 1;
    const kind = acc.byCode.get(issue.code) ?? {
      count: 0,
      severity: issue.severity,
      label: issue.title || issueLabel(issue.code),
    };
    kind.count += 1;
    acc.byCode.set(issue.code, kind);
    groups.set(issue.payrollId, acc);
  }
  const out = new Map<number, PayrollIssueSummary>();
  for (const [payrollId, acc] of groups) {
    out.set(payrollId, {
      total: acc.total,
      bySeverity: acc.bySeverity,
      codes: [...acc.byCode.entries()]
        .map(([code, k]) => ({ code, ...k }))
        .sort(
          (a, b) =>
            b.count - a.count || severityRank(a.severity) - severityRank(b.severity) || a.label.localeCompare(b.label),
        ),
    });
  }
  return out;
}

/** The issue types a filter can offer: those with issues, worst severity first, then most frequent ("skipped" has no row to filter). */
export function issueFilterOptions(byCode: readonly IssueCodeCount[] | null | undefined): IssueCodeCount[] {
  return [...(byCode ?? [])]
    .filter((c) => c.count > 0 && c.code !== "skipped")
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) || b.count - a.count || a.label.localeCompare(b.label),
    );
}

// ── Applying the filters ──────────────────────────────────────────────────────

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const nameOf = (run: PayrollRunItem): string => (run.employeeName ?? run.employeeCode ?? "").trim();

const byName = (a: PayrollRunItem, b: PayrollRunItem): number =>
  collator.compare(nameOf(a), nameOf(b)) || collator.compare(a.employeeCode ?? "", b.employeeCode ?? "") || a.id - b.id;

const netOf = (run: PayrollRunItem): number => {
  const v = Number(run.finalSalary);
  return Number.isFinite(v) ? v : 0;
};

/** True when the row's text (name and code) holds every word of the query. */
function matchesQuery(run: PayrollRunItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${run.employeeName ?? ""} ${run.employeeCode ?? ""}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/**
 * The rows that pass every filter, sorted. Never changes `runs`.
 *
 * `issueIndex` says which issues each payroll has. Without it (the issues have not loaded yet) the issue filters are
 * left out rather than hiding every row; with it, a payroll the index does not list has no issues.
 */
export function applyPayrollFilters(
  runs: readonly PayrollRunItem[] | null | undefined,
  state: PayrollFilterState,
  issueIndex?: IssueIndex | null,
): PayrollRunItem[] {
  const severities = parseSeverities(state.severity);
  const known = issueIndex !== undefined && issueIndex !== null;
  const out = (runs ?? []).filter((run) => {
    if (!matchesQuery(run, state.q)) return false;
    if (state.dept === NO_DEPARTMENT) {
      if (run.departmentId !== null && run.departmentId !== undefined) return false;
    } else if (state.dept !== ALL && String(run.departmentId ?? "") !== state.dept) return false;
    if (state.status === "paid" && run.status !== "paid") return false;
    if (state.status === "pending" && run.status === "paid") return false;
    if (known) {
      const entry = issueIndex.get(run.id);
      if (state.onlyIssues && !(entry && entry.total > 0)) return false;
      if (state.issue !== ALL && !entry?.codes.has(state.issue)) return false;
      if (severities.length > 0 && !severities.some((s) => entry?.severities.has(s))) return false;
    }
    return true;
  });
  if (state.sort === "net") return out.sort((a, b) => netOf(b) - netOf(a) || byName(a, b));
  if (state.sort === "issues") {
    const count = (run: PayrollRunItem) => (known ? (issueIndex.get(run.id)?.total ?? 0) : 0);
    return out.sort((a, b) => count(b) - count(a) || byName(a, b));
  }
  return out.sort(byName);
}

// ── Keeping the filters in the address ────────────────────────────────────────

export type FilterUrlKey = "q" | "dept" | "status" | "issue" | "severity" | "issues" | "sort";

/** Defaults for `useUrlParams`: a filter left at its default stays out of the address. Spread into the page's own. */
export const FILTER_URL_DEFAULTS: Record<FilterUrlKey, string> = {
  q: "",
  dept: ALL,
  status: ALL,
  issue: ALL,
  severity: ALL,
  issues: "",
  sort: "name",
};

/** The filter state from address values; anything unknown or hand-edited falls back to its default. */
export function filtersFromUrl(values: Partial<Record<string, string | null | undefined>>): PayrollFilterState {
  const status = values.status === "pending" || values.status === "paid" ? values.status : ALL;
  const sort = values.sort === "net" || values.sort === "issues" ? values.sort : "name";
  return {
    q: values.q ?? "",
    dept: values.dept || ALL,
    status,
    issue: values.issue || ALL,
    severity: joinSeverities(parseSeverities(values.severity)),
    onlyIssues: values.issues === "1" || values.issues === "true",
    sort,
  };
}

/** A filter change as address values, for `useUrlParams`' setter (a value at its default is dropped from the address). */
export function filtersToUrl(state: Partial<PayrollFilterState>): Partial<Record<FilterUrlKey, string>> {
  const out: Partial<Record<FilterUrlKey, string>> = {};
  if (state.q !== undefined) out.q = state.q;
  if (state.dept !== undefined) out.dept = state.dept;
  if (state.status !== undefined) out.status = state.status;
  if (state.issue !== undefined) out.issue = state.issue;
  if (state.severity !== undefined) out.severity = joinSeverities(parseSeverities(state.severity));
  if (state.onlyIssues !== undefined) out.issues = state.onlyIssues ? "1" : "";
  if (state.sort !== undefined) out.sort = state.sort;
  return out;
}
