// Pure helpers behind the payroll dashboard: the figures of a set of payroll rows, how the net payable is spread over
// the departments, how much of it is paid, and which issue types to draw. Nothing here touches the DOM or the network.

import type {
  IssueCodeCount,
  IssueSeverity,
  PayrollIssuesSummary,
  PayrollRunItem,
} from "@/lib/api-client/custom-hooks";
import { severityRank } from "@/components/payroll/kit/issue-meta";

/** A number from the API, whatever shape it arrives in (a decimal sent as text must not turn a sum into a string). */
const n = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Money without floating-point dust: 0.1 + 0.2 reads 0.3. */
const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** A payroll row is paid once HR marked it so; every other status ("pending") still has to be released. */
export const isPaidRun = (run: Pick<PayrollRunItem, "status">): boolean => run.status === "paid";

/** Rows, people and rupees of one group of payroll rows. */
export type RunBucket = { records: number; employees: number; net: number };

export type RunsSummary = {
  /** Payroll rows (payslips) in the set. */
  records: number;
  /** Distinct employees: a production period can hold several rows for one person. */
  employees: number;
  gross: number;
  deductions: number;
  bonus: number;
  net: number;
  paid: RunBucket;
  pending: RunBucket;
};

/** The figures of the dashboard's tiles for a set of payroll rows (the whole period, not a filtered view). */
export function summarizeRuns(runs: readonly PayrollRunItem[] | null | undefined): RunsSummary {
  const everyone = new Set<number>();
  const paidPeople = new Set<number>();
  const pendingPeople = new Set<number>();
  const out: RunsSummary = {
    records: 0,
    employees: 0,
    gross: 0,
    deductions: 0,
    bonus: 0,
    net: 0,
    paid: { records: 0, employees: 0, net: 0 },
    pending: { records: 0, employees: 0, net: 0 },
  };
  for (const run of runs ?? []) {
    const net = n(run.finalSalary);
    out.records += 1;
    everyone.add(run.employeeId);
    out.gross += n(run.grossSalary);
    out.deductions += n(run.deductions);
    out.bonus += n(run.bonus);
    out.net += net;
    const bucket = isPaidRun(run) ? out.paid : out.pending;
    (isPaidRun(run) ? paidPeople : pendingPeople).add(run.employeeId);
    bucket.records += 1;
    bucket.net += net;
  }
  out.employees = everyone.size;
  out.paid.employees = paidPeople.size;
  out.pending.employees = pendingPeople.size;
  out.gross = money(out.gross);
  out.deductions = money(out.deductions);
  out.bonus = money(out.bonus);
  out.net = money(out.net);
  out.paid.net = money(out.paid.net);
  out.pending.net = money(out.pending.net);
  return out;
}

// ── Net payable by department ─────────────────────────────────────────────────

export type DepartmentShare = {
  /** Stable key for React and tests: "id:4", "name:weaving", "none" or "others". */
  key: string;
  label: string;
  net: number;
  employees: number;
  records: number;
  /** This department's part of the whole net payable (0 to 1). */
  share: number;
  /** The row that folds the departments below the top ones. */
  others?: boolean;
  /** How many departments an "Others" row holds. */
  departments?: number;
};

export const NO_DEPARTMENT_LABEL = "No department";
export const OTHERS_LABEL = "Others";

type DepartmentAccumulator = { key: string; label: string; net: number; records: number; people: Set<number> };

const departmentKey = (run: PayrollRunItem): { key: string; label: string } => {
  const name = (run.departmentName ?? "").trim();
  if (run.departmentId !== null && run.departmentId !== undefined)
    return { key: `id:${run.departmentId}`, label: name || NO_DEPARTMENT_LABEL };
  return name ? { key: `name:${name.toLowerCase()}`, label: name } : { key: "none", label: NO_DEPARTMENT_LABEL };
};

/** Every department's net payable, biggest first (ties by name so the order never flickers). */
export function departmentTotals(runs: readonly PayrollRunItem[] | null | undefined): DepartmentShare[] {
  const groups = new Map<string, DepartmentAccumulator>();
  let total = 0;
  for (const run of runs ?? []) {
    const { key, label } = departmentKey(run);
    const group = groups.get(key) ?? { key, label, net: 0, records: 0, people: new Set<number>() };
    const net = n(run.finalSalary);
    group.net += net;
    group.records += 1;
    group.people.add(run.employeeId);
    groups.set(key, group);
    total += net;
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      label: g.label,
      net: money(g.net),
      employees: g.people.size,
      records: g.records,
      share: total > 0 ? g.net / total : 0,
    }))
    .sort((a, b) => b.net - a.net || a.label.localeCompare(b.label));
}

/**
 * The dashboard's department bars: the `limit` biggest departments, and the rest folded into one "Others" row. One
 * leftover department is shown by name instead (an "Others" of one is no saving).
 */
export function byDepartment(runs: readonly PayrollRunItem[] | null | undefined, limit = 6): DepartmentShare[] {
  const all = departmentTotals(runs);
  if (all.length <= limit + 1) return all;
  const top = all.slice(0, limit);
  const rest = all.slice(limit);
  const people = new Set<number>();
  for (const run of runs ?? []) {
    const { key } = departmentKey(run);
    if (rest.some((r) => r.key === key)) people.add(run.employeeId);
  }
  return [
    ...top,
    {
      key: "others",
      label: OTHERS_LABEL,
      net: money(rest.reduce((sum, r) => sum + r.net, 0)),
      employees: people.size,
      records: rest.reduce((sum, r) => sum + r.records, 0),
      share: rest.reduce((sum, r) => sum + r.share, 0),
      others: true,
      departments: rest.length,
    },
  ];
}

// ── Payment status ────────────────────────────────────────────────────────────

export type PaymentSplit = {
  records: number;
  employees: number;
  net: number;
  paid: RunBucket & { share: number };
  pending: RunBucket & { share: number };
  /** Whole percent of the net payable that is paid. Never shows 100 while something is pending, nor 0 once something is paid. */
  paidPercent: number;
};

/** Paid against pending, sized by rupees (what is left to release); by rows when there are no rupees at all. */
export function paymentSplit(runs: readonly PayrollRunItem[] | null | undefined): PaymentSplit {
  const s = summarizeRuns(runs);
  const share = (bucket: RunBucket): number =>
    s.net > 0 ? bucket.net / s.net : s.records > 0 ? bucket.records / s.records : 0;
  const paidShare = share(s.paid);
  let paidPercent = Math.round(paidShare * 100);
  if (paidPercent >= 100 && s.pending.records > 0) paidPercent = 99;
  if (paidPercent <= 0 && s.paid.records > 0) paidPercent = 1;
  return {
    records: s.records,
    employees: s.employees,
    net: s.net,
    paid: { ...s.paid, share: paidShare },
    pending: { ...s.pending, share: share(s.pending) },
    paidPercent,
  };
}

// ── Issues ────────────────────────────────────────────────────────────────────

export type IssueBar = IssueCodeCount & {
  /** This type's count against the biggest one (0 to 1): the bar's length. */
  share: number;
};

/** The issue types to draw as bars: most frequent first, worse severity first on a tie. */
export function issueBars(
  summary: Pick<PayrollIssuesSummary, "byCode"> | null | undefined,
  limit = 6,
): { bars: IssueBar[]; hidden: number } {
  const sorted = [...(summary?.byCode ?? [])]
    .filter((c) => c.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count || severityRank(a.severity) - severityRank(b.severity) || a.label.localeCompare(b.label),
    );
  const max = sorted[0]?.count ?? 0;
  return {
    bars: sorted.slice(0, limit).map((c) => ({ ...c, share: max > 0 ? c.count / max : 0 })),
    hidden: Math.max(0, sorted.length - limit),
  };
}

/** "3 critical · 12 need a look · 5 info": the tile's one-line split, zeros left out. */
export function issueSplitText(bySeverity: Partial<Record<IssueSeverity, number>> | null | undefined): string {
  const parts: string[] = [];
  const critical = n(bySeverity?.critical);
  const warning = n(bySeverity?.warning);
  const info = n(bySeverity?.info);
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0) parts.push(`${warning} need a look`);
  if (info > 0) parts.push(`${info} info`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing flagged";
}

/** The worst severity present, which decides the Issues tile's colour; null when nothing was flagged. */
export function worstSeverity(
  bySeverity: Partial<Record<IssueSeverity, number>> | null | undefined,
): IssueSeverity | null {
  if (n(bySeverity?.critical) > 0) return "critical";
  if (n(bySeverity?.warning) > 0) return "warning";
  if (n(bySeverity?.info) > 0) return "info";
  return null;
}

/** "18%": a share for a label; under half a percent reads "<1%" so a real department never shows 0%. */
export function percentText(share: number): string {
  if (!(share > 0)) return "0%";
  const pct = share * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}
