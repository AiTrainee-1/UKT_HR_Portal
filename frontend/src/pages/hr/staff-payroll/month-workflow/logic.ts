import type { PayrollMonthStatus, PayrollRunItem, PayrollSkipReason } from "@/lib/api-client/custom-hooks";
import { dateShort, dateTime, plural } from "@/components/payroll/kit/format";
import { statementQuery } from "../logic";

// The Staff Payroll month workflow (owner 2026-11-10) as the page shows it: the header button (Payroll Done -> Payment
// Pending with a live timer -> Paid), its confirmation popups, the month's timeline and the grouped Skipped Employees.
// Pure functions only: the components in this folder draw what these say.

/** The owner's own words for the Payroll Done confirmation. */
export const FINALIZE_QUESTION =
  "Are you sure you want to finalize this month's payroll? Once confirmed, payroll generation and recomputation will be permanently locked for this month.";

export const MARK_PAID_QUESTION =
  "Confirm that this month's salaries have been paid. Every employee in the payroll will be marked Paid with today's date and told on their phone that their salary has been paid (the message never shows the amount).";

// ── the live timer ────────────────────────────────────────────────────────────

export type Elapsed = { days: number; hours: number; minutes: number };

/** Whole days, hours and minutes from `fromIso` to `now` (never negative). */
export function elapsedSince(fromIso: string | null | undefined, now: Date = new Date()): Elapsed | null {
  if (!fromIso) return null;
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return null;
  const total = Math.max(0, Math.floor((now.getTime() - from) / 60000));
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}

/** "2 days 4 h 12 min", "4 h 12 min", "12 min", "under a minute". */
export function elapsedLabel(fromIso: string | null | undefined, now: Date = new Date()): string {
  const e = elapsedSince(fromIso, now);
  if (!e) return "—";
  const parts: string[] = [];
  if (e.days > 0) parts.push(plural(e.days, "day"));
  if (e.days > 0 || e.hours > 0) parts.push(`${e.hours} h`);
  parts.push(`${e.minutes} min`);
  if (e.days === 0 && e.hours === 0 && e.minutes === 0) return "under a minute";
  return parts.join(" ");
}

/** "2d 4h 12m": the timer on the button itself. */
export function elapsedShort(fromIso: string | null | undefined, now: Date = new Date()): string {
  const e = elapsedSince(fromIso, now);
  if (!e) return "";
  return e.days > 0 ? `${e.days}d ${e.hours}h ${e.minutes}m` : `${e.hours}h ${e.minutes}m`;
}

/** "the same day as finalizing" / "1 day after finalizing" / "3 days after finalizing". */
export function daysAfterFinalizing(days: number | null | undefined): string {
  if (days === null || days === undefined) return "";
  if (days <= 0) return "the same day as finalizing";
  return `${plural(days, "day")} after finalizing`;
}

// ── the header button ─────────────────────────────────────────────────────────

export type MonthButton = {
  kind: "done" | "pending" | "paid";
  label: string;
  /** A short second line (the timer, or the paid date). */
  detail: string;
  /** Why the button cannot be pressed for this login (empty = it can). */
  blockedReason: string;
};

export const WHOLE_COMPANY_ONLY =
  "Only a whole-company login with payroll edit rights can do this. A unit login sees the status but cannot change it.";

export function monthButton(status: PayrollMonthStatus | undefined, now: Date = new Date()): MonthButton | null {
  if (!status) return null;
  if (status.state === "paid") {
    return {
      kind: "paid",
      label: "Paid",
      detail: `${dateShort(status.paidAt?.slice(0, 10))} · ${daysAfterFinalizing(status.daysToPay)}`,
      blockedReason: "",
    };
  }
  if (status.state === "finalized") {
    return {
      kind: "pending",
      label: "Payment Pending",
      detail: elapsedShort(status.finalizedAt, now),
      blockedReason: "",
    };
  }
  let blockedReason = "";
  if (!status.can.finalize) {
    blockedReason = !status.wholeCompany
      ? WHOLE_COMPANY_ONLY
      : status.counts.inPayroll + status.counts.onHold === 0
        ? `There is no payroll for ${status.label} yet: generate it first.`
        : "Your role cannot finalize payroll (it needs payroll edit rights).";
  }
  return { kind: "done", label: "Payroll Done", detail: "", blockedReason };
}

/** What the Payroll Done popup points out before HR confirms (it never blocks). */
export function finalizeWarnings(status: PayrollMonthStatus): string[] {
  const c = status.counts;
  const out: string[] = [];
  if (!status.monthEnded) out.push(`${status.label} has not ended yet: days still to come are counted as absent.`);
  if (c.notCleared > 0)
    out.push(
      `${plural(c.notCleared, "employee")} in the payroll ${c.notCleared === 1 ? "is" : "are"} not Cleared yet.`,
    );
  if (c.onHold > 0)
    out.push(
      `${plural(c.onHold, "salary", "salaries")} ${c.onHold === 1 ? "is" : "are"} on hold: not in the bank file, paid later one by one with Release & pay.`,
    );
  if (c.newJoiners > 0)
    out.push(
      `${plural(c.newJoiners, "new joiner")} ${c.newJoiners === 1 ? "is" : "are"} not added to the payroll: after finalizing they can only be paid one by one with Release & pay.`,
    );
  return out;
}

// ── the timeline ──────────────────────────────────────────────────────────────

export type TimelineStep = {
  key: "generated" | "finalized" | "paid";
  title: string;
  /** "13 Oct 2026, 10:42" or null while the step has not happened. */
  when: string | null;
  detail: string;
  done: boolean;
};

export function timelineSteps(status: PayrollMonthStatus | undefined, now: Date = new Date()): TimelineStep[] {
  const s = status;
  const generated = !!s?.firstGeneratedAt;
  const regenerated = !!s?.lastComputedAt && s.lastComputedAt !== s.firstGeneratedAt;
  const steps: TimelineStep[] = [
    {
      key: "generated",
      title: "Generated",
      when: generated ? dateTime(s!.firstGeneratedAt) : null,
      detail: generated
        ? regenerated
          ? `Last computed ${dateTime(s!.lastComputedAt)}`
          : "Computed once"
        : "Not generated yet",
      done: generated,
    },
    {
      key: "finalized",
      title: "Finalized (Payroll Done)",
      when: s?.finalizedAt ? dateTime(s.finalizedAt) : null,
      detail: s?.finalizedAt ? `By ${s.finalizedBy || "HR"} · locked for good` : "Not finalized yet",
      done: !!s?.finalizedAt,
    },
    {
      key: "paid",
      title: "Paid",
      when: s?.paidAt ? dateTime(s.paidAt) : null,
      detail: s?.paidAt
        ? `By ${s.paidBy || "HR"} · ${daysAfterFinalizing(s.daysToPay)}`
        : s?.finalizedAt
          ? `Waiting for payment: ${elapsedLabel(s.finalizedAt, now)} so far`
          : "Not paid yet",
      done: !!s?.paidAt,
    },
  ];
  return steps;
}

// ── Skipped Employees, grouped ───────────────────────────────────────────────

export type SkippedGroupKey = "not_generated" | "on_hold" | "new_joiner" | "paid_separately";

export const SKIPPED_GROUP_LABEL: Record<SkippedGroupKey, string> = {
  not_generated: "Not generated",
  on_hold: "On hold",
  new_joiner: "New joiners",
  paid_separately: "Paid separately",
};

export type StaffSkippedRow = {
  group: SkippedGroupKey;
  employeeId: number;
  employeeCode: string;
  name: string;
  department: string;
  reason: string;
  joinDate: string;
  /** The payroll of a held / new / paid-separately employee (null for one that was not generated). */
  payrollId: number | null;
  gross: number | null;
  deductions: number | null;
  net: number | null;
  /** The payroll row itself (bank details: the one-person bank file). */
  run: PayrollRunItem | null;
};

function fromRun(group: SkippedGroupKey, run: PayrollRunItem, reason: string): StaffSkippedRow {
  return {
    group,
    employeeId: run.employeeId,
    employeeCode: run.employeeCode ?? "",
    name: run.employeeName ?? "",
    department: run.departmentName ?? "",
    reason,
    joinDate: run.joinDate ?? "",
    payrollId: run.id,
    gross: run.grossSalary + (run.otAmount ?? 0) + (run.bonus ?? 0),
    deductions: run.deductions,
    net: run.finalSalary,
    run,
  };
}

/** Why a held / new / paid-separately employee is listed, in plain words. */
export function workflowReason(group: SkippedGroupKey, run: PayrollRunItem): string {
  if (group === "on_hold") {
    const by = run.holdChangedBy ? ` by ${run.holdChangedBy}` : "";
    return `Salary on hold${by}${run.holdChangedAt ? ` on ${dateShort(run.holdChangedAt.slice(0, 10))}` : ""}`;
  }
  if (group === "new_joiner") {
    return `New joiner${run.joinDate ? ` (joined ${run.joinDate})` : ""}: calculated, kept out of the payroll until added`;
  }
  const was = run.releasedFrom === "new_joiner" ? "a new joiner" : "on hold";
  const when = run.paymentPaidAt ? ` on ${dateShort(run.paymentPaidAt.slice(0, 10))}` : "";
  return `Was ${was}; released and paid separately${when}`;
}

export function staffSkippedRows(
  notGenerated: PayrollSkipReason[] | undefined,
  lists: { onHold: PayrollRunItem[]; newJoiners: PayrollRunItem[]; paidSeparately: PayrollRunItem[] } | undefined,
): StaffSkippedRow[] {
  const rows: StaffSkippedRow[] = (notGenerated ?? []).map((s) => ({
    group: "not_generated",
    employeeId: s.employeeId,
    employeeCode: s.employeeCode ?? "",
    name: s.name,
    department: "",
    reason: s.reason,
    joinDate: "",
    payrollId: null,
    gross: null,
    deductions: null,
    net: null,
    run: null,
  }));
  for (const run of lists?.onHold ?? []) rows.push(fromRun("on_hold", run, workflowReason("on_hold", run)));
  for (const run of lists?.newJoiners ?? []) rows.push(fromRun("new_joiner", run, workflowReason("new_joiner", run)));
  for (const run of lists?.paidSeparately ?? [])
    rows.push(fromRun("paid_separately", run, workflowReason("paid_separately", run)));
  return rows;
}

/** The Skipped Employees' own statement: the Report Center's Salary Statement with `section=skipped` (same files). */
export const skippedStatementQuery = (p: { month: number; year: number }): URLSearchParams => {
  const query = statementQuery(p);
  query.set("section", "skipped");
  return query;
};

/** The rows of one group. */
export const rowsOf = (rows: StaffSkippedRow[], group: SkippedGroupKey) => rows.filter((r) => r.group === group);

/** "Skipped" on the view switch: everyone not in the month's payroll and not paid (paid-separately rows are paid). */
export const skippedCount = (rows: StaffSkippedRow[]) => rows.filter((r) => r.group !== "paid_separately").length;
