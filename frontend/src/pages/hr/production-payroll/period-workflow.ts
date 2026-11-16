/**
 * The Production Payroll period workflow as the cycle pages show it (owner 2026-11-16, backend
 * production_period_workflow.py): the status of a pay period (Not generated / Generated / Payroll Done / Paid), the
 * header button (Payroll Done -> Payment pending with a live timer -> Paid), the timeline, the New Joiners rows (workers
 * who joined during the period or moved here from another cycle) and the Moved out rows, in plain words. Pure functions
 * only: the components draw what these say, and logic tests cover them.
 */

import { dateShort, dateTime, inr, plural } from "@/components/payroll/kit/format";
import type { Tone } from "@/lib/statusTones";
import type {
  CycleMove,
  DraftPayslip,
  MovedOutRow,
  NewJoinerRow,
  PeriodState,
  ProductionPayrollItem,
  ProductionPeriodWorkflow,
} from "@/lib/api-client/custom-hooks";
import { daysAfterFinalizing, elapsedLabel, elapsedShort } from "../staff-payroll/month-workflow/logic";

// ── the period's state ─────────────────────────────────────────────────────────

export const PERIOD_STATE_META: Record<PeriodState, { label: string; tone: Tone; hint: string }> = {
  not_generated: {
    label: "Not generated",
    tone: "neutral",
    hint: "No payroll has been generated for this period yet.",
  },
  generated: {
    label: "Generated",
    tone: "info",
    hint: "Generated and still open: it can be generated again, adjusted and cleared until Payroll Done.",
  },
  finalized: {
    label: "Payroll Done",
    tone: "warning",
    hint: "Finalized and locked for good: waiting for the wages to be marked as paid.",
  },
  paid: { label: "Paid", tone: "success", hint: "Finalized and marked as paid." },
};

export const periodStateOf = (state: string | null | undefined): PeriodState =>
  state === "generated" || state === "finalized" || state === "paid" ? state : "not_generated";

/** The owner's question for Payroll Done, for a pay period. */
export const FINALIZE_QUESTION =
  "Are you sure you want to finalize this pay period's payroll? Once confirmed, payroll generation and recomputation will be permanently locked for this period.";

export const MARK_PAID_QUESTION =
  "Confirm that this pay period's wages have been paid. Every worker in the period's payroll will be marked Paid with the date you enter below. No message is sent to the workers.";

export const WHOLE_COMPANY_ONLY =
  "Only a whole-company login can do this: a pay period is one schedule for every unit. A unit login sees the status but cannot change it.";

// ── the header button ──────────────────────────────────────────────────────────

export type PeriodButton = {
  kind: "done" | "pending" | "paid";
  label: string;
  /** The second line: the timer, or the paid day. */
  detail: string;
  /** Why Payroll Done cannot be pressed for this login / now ("" = it can). */
  blockedReason: string;
};

export function periodButton(wf: ProductionPeriodWorkflow | undefined, now: Date = new Date()): PeriodButton | null {
  if (!wf) return null;
  if (wf.state === "paid") {
    const day = wf.paidOn ?? wf.paidAt?.slice(0, 10) ?? null;
    return {
      kind: "paid",
      label: "Paid",
      detail: `${dateShort(day)}${wf.daysToPay !== null ? ` · ${daysAfterFinalizing(wf.daysToPay)}` : ""}`,
      blockedReason: "",
    };
  }
  if (wf.state === "finalized") {
    return { kind: "pending", label: "Payment Pending", detail: elapsedShort(wf.finalizedAt, now), blockedReason: "" };
  }
  let blockedReason = "";
  if (!wf.can.finalize) {
    blockedReason = !wf.wholeCompany
      ? WHOLE_COMPANY_ONLY
      : wf.finalizeBlockers.length > 0
        ? wf.finalizeBlockers.join(" ")
        : "Your role cannot finalize production payroll (Production Payroll -> Payroll Done needs Edit).";
  }
  return { kind: "done", label: "Payroll Done", detail: "", blockedReason };
}

/** What the Payroll Done popup says will happen, before HR confirms. */
export function finalizeSummary(wf: ProductionPeriodWorkflow): string {
  const c = wf.counts;
  const parts = [`${plural(c.inPayroll, "worker")} in the payroll, total NET ${inr(c.mainNet)}`];
  if (c.notCleared > 0) parts.push(`${c.notCleared} not marked Cleared yet`);
  return `${parts.join(", ")}. After this nothing in ${wf.periodLabel} can be generated, recomputed, adjusted or cleared, and no move between cycles changes it.`;
}

// ── the timeline ───────────────────────────────────────────────────────────────

export type TimelineStep = {
  key: "generated" | "finalized" | "paid";
  title: string;
  when: string | null;
  detail: string;
  done: boolean;
};

export function periodTimeline(wf: ProductionPeriodWorkflow | undefined, now: Date = new Date()): TimelineStep[] {
  const generated = !!wf?.firstGeneratedAt;
  const regenerated = !!wf?.lastComputedAt && wf.lastComputedAt !== wf.firstGeneratedAt;
  const backfill = !!wf?.snapshot?.backfill;
  return [
    {
      key: "generated",
      title: "Generated",
      when: generated ? dateTime(wf!.firstGeneratedAt) : null,
      detail: generated
        ? regenerated
          ? `Last computed ${dateTime(wf!.lastComputedAt)}`
          : "Computed once"
        : "Not generated yet",
      done: generated || !!wf?.finalizedAt,
    },
    {
      key: "finalized",
      title: "Payroll Done",
      when: wf?.finalizedAt ? dateTime(wf.finalizedAt) : null,
      detail: wf?.finalizedAt
        ? backfill
          ? "Every payroll was Cleared before the period workflow existed"
          : `By ${wf.finalizedBy || "HR"} · locked for good`
        : "Not finalized yet",
      done: !!wf?.finalizedAt,
    },
    {
      key: "paid",
      title: "Paid",
      when: wf?.paidOn ? dateShort(wf.paidOn) : wf?.paidAt ? dateTime(wf.paidAt) : null,
      detail: wf?.paidAt
        ? backfill
          ? "Counted as paid: Cleared before the period workflow"
          : `Recorded by ${wf.paidBy || "HR"} ${dateTime(wf.paidAt)} · ${daysAfterFinalizing(wf.daysToPay)}`
        : wf?.finalizedAt
          ? `Waiting for payment: ${elapsedLabel(wf.finalizedAt, now)} so far`
          : "Not paid yet",
      done: !!wf?.paidAt,
    },
  ];
}

/** Today in the browser's calendar as YYYY-MM-DD (the default "paid on" day). */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Why a "paid on" day cannot be used (null = it can): not empty, not in the future, not before the period's last day. */
export function paidOnProblem(value: string, periodEnd: string, today: string = todayIso()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Enter the date the wages were paid.";
  if (value > today) return "The paid date cannot be in the future.";
  if (value < periodEnd) return `The paid date cannot be before the period's last day (${dateShort(periodEnd)}).`;
  return null;
}

// ── New Joiners ────────────────────────────────────────────────────────────────

/** "Weekly → BiWeekly" (Unassigned in between named when the worker came that way). */
export function moveRoute(move: Pick<CycleMove, "fromCycle" | "fromLabel" | "cameFromLabel" | "toLabel">): string {
  const from = move.fromCycle
    ? move.fromLabel
    : move.cameFromLabel !== "Unassigned"
      ? move.cameFromLabel
      : "Unassigned";
  return `${from} → ${move.toLabel}`;
}

/** Why a worker is in New Joiners: "Joined on 21 Jan 2026" or "Moved from Weekly → BiWeekly on 10 Nov 2026". */
export function newJoinerReason(row: Pick<NewJoinerRow, "parkedReason" | "joinedOn" | "move">): string {
  if (row.move && (row.parkedReason === "transfer" || !row.joinedOn)) {
    return `Moved from ${moveRoute(row.move)} on ${dateShort(row.move.changedOn)}`;
  }
  if (row.joinedOn) return `Joined on ${dateShort(row.joinedOn)}`;
  return row.parkedReason === "transfer" ? "Moved here from another pay cycle" : "Joined during this period";
}

/** "7 of 14 days paid here · 7 already paid on Weekly · 3 catch-up days" (only the parts that apply). */
export function newJoinerDays(days: NewJoinerRow["days"]): string {
  const paidHere = days.eligibleDays - days.catchUpDays;
  const parts = [`${plural(days.eligibleDays, "eligible day")}`];
  if (paidHere !== days.periodDays) parts[0] = `${plural(paidHere, "day")} of ${days.periodDays} in the period`;
  if (days.excludedDays > 0) {
    const where = [...new Set(days.alreadyPaid.map((p) => p.label).filter(Boolean))].join(", ") || "another payroll";
    parts.push(`${plural(days.excludedDays, "day")} already paid on ${where}, left out`);
  }
  if (days.catchUpDays > 0) parts.push(`+ ${plural(days.catchUpDays, "catch-up day")} no cycle had paid`);
  return parts.join(" · ");
}

// ── Moved out ──────────────────────────────────────────────────────────────────

/** "Moved to BiWeekly on 10 Nov 2026 by Priya" / "Taken off the cycle on ..." */
export function movedOutHeadline(row: Pick<MovedOutRow, "toCycle" | "toLabel" | "changedOn" | "changedBy">): string {
  const where = row.toCycle ? `Moved to ${row.toLabel}` : "Taken off the pay cycle (Unassigned)";
  return `${where} on ${dateShort(row.changedOn)}${row.changedBy ? ` by ${row.changedBy}` : ""}`;
}

/** "Paid here up to 8 Nov 2026: 6 pay periods, ₹12,345 net" (or "Nothing was paid on this cycle"). */
export function movedOutPaid(row: Pick<MovedOutRow, "lastPaidThrough" | "paidPeriods" | "paidNet">): string {
  if (!row.paidPeriods) return "Nothing was paid on this cycle before the move";
  const upTo = row.lastPaidThrough ? ` up to ${dateShort(row.lastPaidThrough)}` : "";
  return `Paid here${upTo}: ${plural(row.paidPeriods, "pay period")}, ${inr(row.paidNet)} net`;
}

// ── the bank file ──────────────────────────────────────────────────────────────

/**
 * The rows the period's bank file pays (owner 2026-11-16, staff's rules): every row in the period's payroll, whatever
 * the filters on screen show, never a worker waiting in New Joiners.
 */
export const periodBankRows = <T extends Pick<ProductionPayrollItem, "newJoinerParked">>(runs: readonly T[]): T[] =>
  runs.filter((r) => !r.newJoinerParked);

// ── draft payslips of other periods (owner 2026-11-16: a Generated payslip is a draft) ──

export type DraftGroup = {
  key: string;
  periodStart: string;
  periodLabel: string;
  /** "BiWeekly" (the cycle the draft was generated on). */
  label: string;
  workers: number;
  cleared: number;
};

/**
 * The draft payslips a run would replace, grouped by their period (and cycle), oldest first, with how many workers have
 * one there and how many of those are marked Cleared.
 */
export function draftGroups(people: readonly { drafts?: DraftPayslip[] | null }[]): DraftGroup[] {
  const groups = new Map<string, DraftGroup>();
  for (const person of people) {
    for (const d of person.drafts ?? []) {
      const key = `${d.periodStart}|${d.periodEnd}|${d.cycle ?? ""}`;
      const g = groups.get(key) ?? {
        key,
        periodStart: d.periodStart,
        periodLabel: d.periodLabel,
        label: d.label,
        workers: 0,
        cleared: 0,
      };
      g.workers += 1;
      if (d.cleared) g.cleared += 1;
      groups.set(key, g);
    }
  }
  return [...groups.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.key.localeCompare(b.key));
}
