// What a payroll record says about itself, as plain text and counts: the attendance line, the period or pay cycle, the
// issue badges, and the page a long list shows. Pure, so the card, the table and the tests all read the same wording.

import type { IssueSeverity, PayCycle, PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { PAY_CYCLE_INFO } from "@/lib/api-client/custom-hooks";
import { monthYear, periodLabel, plural } from "@/components/payroll/kit/format";
import { ISSUE_META, issueLabel, severityRank } from "@/components/payroll/kit/issue-meta";
import { SEVERITY_ORDER, type PayrollIssueSummary } from "../filters/filter-logic";

/** "22", "22.5": a day count without a trailing ".0" or floating-point dust. */
export function formatCount(value: number | null | undefined): string {
  const v = Number(value);
  if (!Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** The name a row is listed under: the employee's name, else the code, else the id. */
export const displayName = (run: Pick<PayrollRunItem, "employeeName" | "employeeCode" | "employeeId">): string =>
  run.employeeName || run.employeeCode || `#${run.employeeId}`;

/** Whether the row is production pay (a shift or an old session row) rather than a staff month. */
export const isProductionRun = (run: Pick<PayrollRunItem, "salaryMode">): boolean =>
  run.salaryMode === "shift" || run.salaryMode === "session";

/** "22 / 26 days" for staff, "6.5 shifts" for production, "3 sessions" for an old session-based row. */
export function metricText(
  run: Pick<PayrollRunItem, "salaryMode" | "presentDays" | "totalWorkingDays" | "completedSessions">,
): string {
  if (run.salaryMode === "shift") return plural(Number(run.presentDays) || 0, "shift");
  if (run.salaryMode === "session") return plural(Number(run.completedSessions) || 0, "session");
  return `${formatCount(run.presentDays)} / ${formatCount(run.totalWorkingDays)} days`;
}

/** What the metric is called in a column header or a tooltip: "Days present", "Shifts". */
export const metricLabel = (run: Pick<PayrollRunItem, "salaryMode">): string =>
  run.salaryMode === "shift" ? "Shifts" : run.salaryMode === "session" ? "Sessions" : "Attendance";

/** "October 2026" for a staff month, "2 Feb - 8 Feb 2026" for a production period, "Week 3 · Feb 2026" for an old week. */
export function periodText(
  run: Pick<PayrollRunItem, "periodStart" | "periodEnd" | "weekNumber" | "month" | "year">,
): string {
  if (run.periodStart && run.periodEnd) return periodLabel(run.periodStart, run.periodEnd);
  if (run.weekNumber) return `Week ${run.weekNumber} · ${monthYear(run.month, run.year)}`;
  return monthYear(run.month, run.year);
}

/** The pay cycle a production row was generated on ("Weekly"), or null for a staff row and a row from before the cycles. */
export function cycleLabelOf(run: Pick<PayrollRunItem, "payCycle">): string | null {
  const cycle = run.payCycle as PayCycle | null | undefined;
  return cycle && cycle in PAY_CYCLE_INFO ? PAY_CYCLE_INFO[cycle].label : null;
}

/** The button's tooltip. It says "Update ..." on purpose: the view-only lock reads a button's title, and that is what
 *  turns this one off for a View Only role (the words "Mark as Cleared" alone are not on its list). */
export const markPaidTitle = (run: Parameters<typeof displayName>[0]): string =>
  `Update the status of ${displayName(run)}'s payroll to Cleared`;

// ── Issue badges ──────────────────────────────────────────────────────────────

/** A payroll with nothing flagged. */
export const NO_ISSUES: PayrollIssueSummary = { total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, codes: [] };

/**
 * One payroll's issues out of the page's map. Once the issues are loaded a payroll the map does not list simply has
 * none; until then (no map, or `loading`) its issues are unknown, so the card shows a placeholder, not a false "No issues".
 */
export function issuesOf(
  byPayroll: ReadonlyMap<number, PayrollIssueSummary> | null | undefined,
  payrollId: number,
  loading = false,
): PayrollIssueSummary | undefined {
  const found = byPayroll?.get(payrollId);
  if (found) return found;
  return byPayroll && !loading ? NO_ISSUES : undefined;
}

export type IssueBadges = {
  /** Severity counts that are not zero, worst first. */
  severities: { severity: IssueSeverity; count: number }[];
  /** The most frequent issue types, ready to draw. */
  types: { code: string; count: number; severity: IssueSeverity; label: string }[];
  /** How many more types there are than are listed. */
  more: number;
};

/** What a record card shows of its issues: the severity counts and its two most frequent types. */
export function issueBadges(summary: PayrollIssueSummary | null | undefined, topTypes = 2): IssueBadges {
  const severities = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: Number(summary?.bySeverity?.[severity]) || 0,
  })).filter((s) => s.count > 0);
  const all = (summary?.codes ?? [])
    .map((c) => ({
      code: c.code,
      count: c.count,
      severity: c.severity ?? ISSUE_META[c.code as keyof typeof ISSUE_META]?.severity ?? "info",
      label: c.label ?? issueLabel(c.code),
    }))
    .filter((c) => c.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count || severityRank(a.severity) - severityRank(b.severity) || a.label.localeCompare(b.label),
    );
  return { severities, types: all.slice(0, topTypes), more: Math.max(0, all.length - topTypes) };
}

// ── Pages ─────────────────────────────────────────────────────────────────────

export type Page<T> = {
  items: T[];
  /** The page shown (1-based), kept inside the list after it shrinks. */
  page: number;
  totalPages: number;
  total: number;
  /** 1-based position of the first and last row shown ("21-40 of 126"); 0 when there is nothing. */
  from: number;
  to: number;
};

export function pageSlice<T>(items: readonly T[], page: number, size: number): Page<T> {
  const total = items.length;
  const perPage = Math.max(1, Math.floor(size) || 1);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (current - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return {
    items: slice,
    page: current,
    totalPages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + slice.length,
  };
}

/** Which rows are listed, in order: the list goes back to page 1 when this changes (a new filter or sort), not when one row's status does. */
export const listSignature = (runs: readonly Pick<PayrollRunItem, "id">[]): string => runs.map((r) => r.id).join(",");
