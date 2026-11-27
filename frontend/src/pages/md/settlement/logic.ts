// MD portal -> Settlement: the page's rules, as plain functions (tested in logic.test.ts). The server applies the same
// decision rules (api/settlement_automation/service.py md_decide / md_confirm): a smaller amount needs a remark, a
// rejection needs a remark, every request must be decided before Confirm & Proceed. Checking them here first means the
// MD is told before anything is sent; the server's refusal is still shown if it disagrees.

import { monthKey, monthLabel, parseMonthKey, type MonthKey } from "@/components/md/kit/MonthPicker";
import { inr, num } from "@/lib/md/format";
import { cleanRejectRemark, REJECT_REMARK_MIN } from "@/lib/reject-remark";
import type {
  AdvanceType,
  DecideBody,
  HistoryEntry,
  LeaveCheck,
  MdDecision,
  MdSettlementWaiting,
  ReviewState,
  SettlementAdvance,
  SettlementBatch,
  SettlementItem,
  SettlementStage,
  TrailEntry,
} from "./types";

// ── time (the factory's clock: India, UTC+5:30, no daylight saving) ──────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
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
const two = (n: number) => String(n).padStart(2, "0");

/** This month in India ("2026-11"), whatever the computer's own time zone: the month the page opens on. */
export function istMonthKey(now: Date = new Date()): MonthKey {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `month=YYYY-MM` from the address when it is a real month not after `max`; null otherwise. */
export function monthFromQuery(raw: string | null | undefined, max: MonthKey): MonthKey | null {
  return raw && MONTH_RE.test(raw) && raw <= max ? raw : null;
}

function istParts(iso: string | null | undefined) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** A moment as its day in India: "26 Nov 2026" ("" when unknown). */
export function istDate(iso: string | null | undefined): string {
  const p = istParts(iso);
  return p ? `${two(p.day)} ${MONTHS[p.month - 1]} ${p.year}` : "";
}

/** A moment in India's time: "26 Nov 2026, 3:42 pm" ("" when unknown). */
export function istDateTime(iso: string | null | undefined): string {
  const p = istParts(iso);
  if (!p) return "";
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${two(p.day)} ${MONTHS[p.month - 1]} ${p.year}, ${hour12}:${two(p.minute)} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "November 2026". */
export const periodLabel = (month: number, year: number): string => `${MONTHS_LONG[month - 1] ?? ""} ${year}`.trim();

/** "Nov 2026" for a month / year pair (null when either is missing). */
export const shortMonth = (month: number | null | undefined, year: number | null | undefined): string | null =>
  month && year ? `${MONTHS[month - 1]} ${year}` : null;

// ── money ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rupees in Indian grouping, with paise only when there are some: "₹12,500", "₹12,500.50". */
export function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return inr(value, Math.round(value * 100) % 100 ? 2 : 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An amount as the field shows it: "6000", "6000.50". */
export const plainAmount = (value: number): string =>
  Math.round(value * 100) % 100 ? value.toFixed(2) : String(value);

// ── a request's decision ─────────────────────────────────────────────────────────────────────────────────────────────

/** approved = the full amount asked; reduced = approved for less; rejected; undecided = no decision yet. */
export type DecisionKind = "approved" | "reduced" | "rejected" | "undecided";

type Decided = { decision: "approved" | "rejected" | null; amount: number | null };

function kindOf(d: Decided, requested: number): DecisionKind {
  if (d.decision === "rejected") return "rejected";
  if (d.decision === "approved") return d.amount != null && d.amount < requested - 0.004 ? "reduced" : "approved";
  return "undecided";
}

/** The MD's decision on a request. */
export const decisionKind = (item: Pick<SettlementItem, "md" | "requestedAmount">): DecisionKind =>
  kindOf(item.md, item.requestedAmount);

/** HR's final decision on a request (after the MD confirmed; it starts as a copy of the MD's). */
export const finalKind = (item: Pick<SettlementItem, "final" | "requestedAmount">): DecisionKind =>
  kindOf(item.final, item.requestedAmount);

/** The decision in a few words: "Approved ₹10,000", "Reduced ₹10,000 → ₹6,000", "Rejected", "Not decided". */
export function decisionText(kind: DecisionKind, requested: number, amount: number | null): string {
  switch (kind) {
    case "approved":
      return `Approved ${money(amount ?? requested)}`;
    case "reduced":
      return `Reduced ${money(requested)} → ${money(amount)}`;
    case "rejected":
      return "Rejected";
    default:
      return "Not decided";
  }
}

// ── the decision form (Approve / Reduce / Reject) ────────────────────────────────────────────────────────────────────

export type DraftMode = "approve" | "reduce" | "reject";
export type Draft = { mode: DraftMode; amount: string; remark: string };
export type DraftProblems = { amount?: string; remark?: string };

export const REDUCE_REMARK_MESSAGE = `Write a remark for the reduced amount (at least ${REJECT_REMARK_MIN} characters).`;
export const REJECT_MESSAGE = `Write the reason for rejecting (at least ${REJECT_REMARK_MIN} characters).`;

/** The form as it opens: on `mode` when given, else on the request's current decision, with its amount and remark. */
export function draftFor(item: Pick<SettlementItem, "md" | "requestedAmount">, mode?: DraftMode): Draft {
  const kind = decisionKind(item);
  const current: DraftMode = kind === "reduced" ? "reduce" : kind === "rejected" ? "reject" : "approve";
  return {
    mode: mode ?? current,
    amount: kind === "reduced" && item.md.amount != null ? plainAmount(item.md.amount) : "",
    remark: kind === "undecided" ? "" : item.md.remark || "",
  };
}

export type AmountParse = { value: number; problem?: undefined } | { value?: undefined; problem: string };

/** What the MD typed as an amount: "6000", "6,000", "₹6,000.50". At most 2 decimal places, more than ₹0. */
export function parseAmount(text: string): AmountParse {
  const clean = text.replace(/[\s,₹]/g, "");
  if (!clean) return { problem: "Enter the reduced amount." };
  if (!/^\d+(\.\d+)?$/.test(clean)) return { problem: "Enter the amount in rupees, like 6000 or 6,000." };
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return { problem: "Use at most 2 decimal places." };
  const value = Number(clean);
  if (!(value > 0)) return { problem: "The amount must be more than ₹0." };
  return { value };
}

/** Why the form cannot be saved yet (empty when it can): a reduced amount must be below the amount asked and needs a
 *  remark; a rejection needs a remark; approving the full amount needs nothing. */
export function draftProblems(draft: Draft, requested: number): DraftProblems {
  const out: DraftProblems = {};
  const remark = cleanRejectRemark(draft.remark);
  if (draft.mode === "reduce") {
    const parsed = parseAmount(draft.amount);
    if (parsed.value === undefined) out.amount = parsed.problem;
    else if (parsed.value >= requested)
      out.amount = `A reduced amount must be less than the ${money(requested)} asked for. To give the full amount, choose Approve.`;
    if (remark.length < REJECT_REMARK_MIN) out.remark = REDUCE_REMARK_MESSAGE;
  } else if (draft.mode === "reject" && remark.length < REJECT_REMARK_MIN) {
    out.remark = REJECT_MESSAGE;
  }
  return out;
}

export const hasProblems = (p: DraftProblems): boolean => !!(p.amount || p.remark);

/** What is sent for a form without problems. Approve sends no amount: the server takes the full amount asked. */
export function draftBody(draft: Draft): DecideBody {
  const remark = cleanRejectRemark(draft.remark);
  if (draft.mode === "reject") return { decision: "rejected", remark };
  if (draft.mode === "reduce") return { decision: "approved", amount: parseAmount(draft.amount).value, remark };
  return remark ? { decision: "approved", remark } : { decision: "approved" };
}

// ── the review before Confirm & Proceed ──────────────────────────────────────────────────────────────────────────────

export type ReviewRow = {
  id: number;
  name: string;
  code: string | null;
  typeLabel: string;
  kind: DecisionKind;
  requested: number;
  /** What the MD approved (null: rejected or not decided). */
  approved: number | null;
  remark: string;
  leave: LeaveCheck | null;
  /** HR's proposal, pre-filled at Forward and not yet confirmed by the MD. */
  fromHr: boolean;
  /** The MD's own decision differs from HR's proposal (the settlement goes back to HR before the MD can approve). */
  changed: boolean;
};

export type ReviewSummary = {
  total: number;
  decided: number;
  undecided: number;
  /** approved for the full amount */
  approved: number;
  reduced: number;
  rejected: number;
  requestedTotal: number;
  /** full + reduced approvals */
  approvedTotal: number;
  /** what the reductions took off */
  reducedBy: number;
  /** what the rejected requests asked for */
  rejectedTotal: number;
  rows: ReviewRow[];
  undecidedIds: number[];
  /** Decisions that are still HR's proposals (pre-filled, not confirmed by the MD's own click). */
  fromHr: number;
  /** The MD's decisions that differ from HR's proposals (2026-11-27): approving is off, Return to HR is the way on. */
  changed: number;
  changedIds: number[];
  /** Requests the MD wrote their own remark on without changing HR's proposal (they go back to HR too). */
  remarked: number;
};

export const typeLabelOf = (adv: Pick<SettlementAdvance, "typeLabel" | "advanceType">): string =>
  adv.typeLabel || (adv.advanceType === "term" ? "Term Loan" : "Salary Advance");

/** Every decision of the batch, its counts and totals: what the MD reads before Confirm & Proceed. */
export function reviewSummary(items: SettlementItem[]): ReviewSummary {
  const s: ReviewSummary = {
    total: items.length,
    decided: 0,
    undecided: 0,
    approved: 0,
    reduced: 0,
    rejected: 0,
    requestedTotal: 0,
    approvedTotal: 0,
    reducedBy: 0,
    rejectedTotal: 0,
    rows: [],
    undecidedIds: [],
    fromHr: 0,
    changed: 0,
    changedIds: [],
    remarked: 0,
  };
  for (const item of items) {
    const kind = decisionKind(item);
    const changed = mdChangedOf(item);
    if (changed) {
      s.changed += 1;
      s.changedIds.push(item.id);
    } else if (item.mdRemarked) s.remarked += 1;
    const requested = item.requestedAmount;
    const approved = kind === "approved" || kind === "reduced" ? (item.md.amount ?? requested) : null;
    s.requestedTotal += requested;
    if (kind === "undecided") {
      s.undecided += 1;
      s.undecidedIds.push(item.id);
    } else s.decided += 1;
    if (kind === "approved") s.approved += 1;
    if (kind === "reduced") {
      s.reduced += 1;
      s.reducedBy += requested - (approved ?? requested);
    }
    if (kind === "rejected") {
      s.rejected += 1;
      s.rejectedTotal += requested;
    }
    if (approved != null) s.approvedTotal += approved;
    s.rows.push({
      id: item.id,
      name: item.advance.employeeName,
      code: item.advance.employeeCode,
      typeLabel: typeLabelOf(item.advance),
      kind,
      requested,
      approved,
      remark: kind === "undecided" ? "" : item.md.remark || "",
      leave: item.advance.leaveCheck,
      fromHr: kind !== "undecided" && !!item.md.fromHr,
      changed,
    });
    if (kind !== "undecided" && item.md.fromHr) s.fromHr += 1;
  }
  s.requestedTotal = round2(s.requestedTotal);
  s.approvedTotal = round2(s.approvedTotal);
  s.reducedBy = round2(s.reducedBy);
  s.rejectedTotal = round2(s.rejectedTotal);
  return s;
}

const REVIEW_ORDER: DecisionKind[] = ["undecided", "reduced", "rejected", "approved"];
export const REVIEW_GROUP_TITLE: Record<DecisionKind, string> = {
  undecided: "Still needs your decision",
  reduced: "Approved for a smaller amount",
  rejected: "Rejected",
  approved: "Approved in full",
};

/** The review's rows in groups, the ones that need attention first; empty groups are left out. */
export function reviewGroups(summary: Pick<ReviewSummary, "rows">): { kind: DecisionKind; rows: ReviewRow[] }[] {
  return REVIEW_ORDER.map((kind) => ({ kind, rows: summary.rows.filter((r) => r.kind === kind) })).filter(
    (g) => g.rows.length > 0,
  );
}

/** Why the MD cannot approve a settlement they changed (2026-11-27): it goes back to HR first. */
export const changesReason = (changed: number): string =>
  `You changed ${plural(changed, "request")} from HR's proposal — return the settlement to HR; you approve it once HR resubmits.`;

/** Whether the approve options (Forward to HR / Direct to Auditor) may be clicked, and if not, why (in words the MD can
 *  act on). A settlement the MD changed from HR's proposals is never approved as it is: it goes back to HR for rework. */
export function confirmState(
  batch: Pick<SettlementBatch, "stage" | "actions">,
  summary: Pick<ReviewSummary, "total" | "undecided" | "changed">,
): { enabled: boolean; reason: string | null } {
  if (batch.stage !== "md_review" || !batch.actions.canDecideMd)
    return { enabled: false, reason: "This batch is no longer waiting for your decision." };
  if (summary.total === 0) return { enabled: false, reason: "There are no requests in this batch." };
  if (summary.changed > 0) return { enabled: false, reason: changesReason(summary.changed) };
  if (summary.undecided > 0)
    return {
      enabled: false,
      reason: `Decide every request first: ${plural(summary.undecided, "request")} ${summary.undecided === 1 ? "still needs" : "still need"} your decision.`,
    };
  if (!batch.actions.canConfirmMd)
    return { enabled: false, reason: "The batch is being updated. Refresh the page, then confirm." };
  return { enabled: true, reason: null };
}

export const RETURN_NOTE_MESSAGE = `Write what HR should correct (at least ${REJECT_REMARK_MIN} characters).`;

/** Return to HR for rework: the instructions are optional when the MD changed a request or wrote a remark on one (HR
 *  answers those), required otherwise - the server refuses a return with nothing to rework (`no_changes`). */
export function returnState(
  summary: Pick<ReviewSummary, "changed" | "remarked">,
  note: string,
): { noteRequired: boolean; problem: string | null } {
  const noteRequired = summary.changed === 0 && summary.remarked === 0;
  const problem = noteRequired && cleanRejectRemark(note).length < REJECT_REMARK_MIN ? RETURN_NOTE_MESSAGE : null;
  return { noteRequired, problem };
}

// ── the leave check (1st-20th) ───────────────────────────────────────────────────────────────────────────────────────

export type LeaveTone = "critical" | "warning" | "ok" | "unknown";
export type LeaveChipInfo = { tone: LeaveTone; label: string; detail: string };

/** "1 day", "3 days", "2.5 days". */
export function daysText(days: number): string {
  const n = Number(days.toFixed(1));
  return `${num(n, n % 1 ? 1 : 0)} ${n === 1 ? "day" : "days"}`;
}

/** The leave check as a chip that reads without its colour: orange "Leave warning" (exactly 3 days in the 1st-20th), red
 *  "Frequent leave" (more than 3), plain "Leave" below that, and a quiet "Leave not checked" until it is worked out.
 *  `detail` is the full sentence (the chip's tooltip and its accessible name). */
export function leaveChip(check: LeaveCheck | null | undefined): LeaveChipInfo {
  if (!check || check.days == null)
    return {
      tone: "unknown",
      label: "Leave not checked",
      detail: "The leave taken from the 1st to the 20th has not been worked out for this request yet.",
    };
  const limit = check.warningAt ?? 3;
  const flag = check.flag ?? (check.days > limit ? "critical" : check.days === limit ? "warning" : "ok");
  const when = `between the 1st and the ${check.throughDay ?? 20}th of ${shortMonth(check.month, check.year) ?? "the month"}`;
  const days = daysText(check.days);
  if (flag === "critical")
    return {
      tone: "critical",
      label: `Frequent leave · ${days}`,
      detail: `Frequent leave: ${days} absent or on leave ${when} (more than ${daysText(limit)}).`,
    };
  if (flag === "warning")
    return {
      tone: "warning",
      label: `Leave warning · ${days}`,
      detail: `Leave warning: ${days} absent or on leave ${when} (exactly ${daysText(limit)}).`,
    };
  return {
    tone: "ok",
    label: `Leave · ${days}`,
    detail: `${days} absent or on leave ${when} (under ${daysText(limit)}).`,
  };
}

/** Whether a request's leave check is orange or red. */
export function hasLeaveAlert(item: Pick<SettlementItem, "advance">): boolean {
  const tone = leaveChip(item.advance.leaveCheck).tone;
  return tone === "warning" || tone === "critical";
}

/** A request asking for more than its limit: a Salary Advance above its % of the earned salary, a Term Loan above its
 *  Term Loan limit (HR may record one with a remark). */
export function overLimit(item: Pick<SettlementItem, "advance" | "requestedAmount">): boolean {
  const a = item.advance;
  const limit = a.advanceType === "term" ? a.termLimit : a.earnings?.limit;
  return limit != null && item.requestedAmount > limit + 0.004;
}

/** Confirming HR's pre-filled proposal as the MD's own decision: the same decision, amount and remark, sent again. */
export function confirmHrBody(item: Pick<SettlementItem, "md" | "requestedAmount">): DecideBody {
  if (item.md.decision === "rejected") return { decision: "rejected", remark: item.md.remark };
  const amount = item.md.amount;
  return amount != null && amount < item.requestedAmount - 0.004
    ? { decision: "approved", amount, remark: item.md.remark }
    : item.md.remark
      ? { decision: "approved", remark: item.md.remark }
      : { decision: "approved" };
}

// ── the batches ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The batch to show: the one asked for, else the first waiting for the MD, else the latest. */
export function pickBatch(batches: SettlementBatch[], wanted: number | null): SettlementBatch | undefined {
  return (
    (wanted != null ? batches.find((b) => b.id === wanted) : undefined) ??
    batches.find((b) => b.stage === "md_review") ??
    batches[batches.length - 1]
  );
}

/** HR has the batch back after the MD approved it (HR Final Settlement or later; not HR Rework, which is a return). */
export const sentBackToHr = (stage: SettlementStage): boolean =>
  stage !== "hr_review" && stage !== "md_review" && stage !== "md_changes";

/** HR has finalized the settlement: the final decisions are the real ones now. */
export const finalized = (stage: SettlementStage): boolean =>
  stage === "auditor_send" ||
  stage === "auditor_review" ||
  stage === "auditor_changes" ||
  stage === "accounts_send" ||
  stage === "completed";

// ── round 5 (2026-11-27): HR's proposal, the eligible limit, the status, bulk ───────────────────────────────────────

export type HrProposal = { kind: "none" | "reduce" | "reject"; text: string; remark: string };

/** What HR proposed at HR Review: "HR proposes ₹6,000" (a smaller amount), "HR proposes reject", or no change (HR kept
 *  the amount asked); with HR's remark (the request's HR note). */
export function hrProposal(item: Pick<SettlementItem, "hr" | "hrNote" | "requestedAmount">): HrProposal {
  const remark = (item.hr?.remark ?? item.hrNote ?? "").trim();
  const action = item.hr?.action ?? null;
  if (action === "reject") return { kind: "reject", text: "HR proposes reject", remark };
  if (action === "reduce" && item.hr?.amount != null)
    return { kind: "reduce", text: `HR proposes ${money(item.hr.amount)}`, remark };
  return { kind: "none", text: "No change proposed", remark };
}

export type EligibleLimit = { amount: number | null; label: string; detail: string };

/** The most the request may get: a Salary Advance's limit (the % of the salary earned in the 1st-20th) or a Term Loan's
 *  (the monthly salary x the Settings %), with how it was worked out. */
export function eligibleLimit(item: Pick<SettlementItem, "advance">): EligibleLimit {
  const a = item.advance;
  if (a.advanceType === "term") {
    const plan = [
      a.repaymentMonths ? plural(a.repaymentMonths, "month") : null,
      a.emiAmount ? `EMI ${money(a.emiAmount)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      amount: a.termLimit ?? null,
      label: "Term Loan limit",
      detail: [a.salaryAtRequest != null ? `salary ${money(a.salaryAtRequest)}` : null, plan || null]
        .filter(Boolean)
        .join(" · "),
    };
  }
  const e = a.earnings;
  if (!e) return { amount: null, label: "Salary Advance limit", detail: "no 1st–20th figures" };
  const days = Number(e.workingDays.toFixed(1));
  return {
    amount: e.limit,
    label: `${e.percent || 50}% of earned`,
    detail: `${money(e.earnedAmount)} earned in ${num(days, days % 1 ? 1 : 0)} ${days === 1 ? "day" : "days"} · fixed ${money(
      e.fixedSalary ?? a.salaryAtRequest,
    )}`,
  };
}

export type StatusTone = "warning" | "sand" | "success" | "danger" | "neutral" | "wine";
export type RequestStatus = { text: string; tone: StatusTone };

/** Where the request stands: to decide, HR's proposal still to confirm, decided by the MD, with HR, or (once finalized)
 *  its settlement as paid (the auditor's change on top) and whether it has been applied. */
export function requestStatus(item: SettlementItem, stage: SettlementStage): RequestStatus {
  const kind = decisionKind(item);
  if (stage === "md_review") {
    if (kind === "undecided") return { text: "To decide", tone: "warning" };
    if (item.md.fromHr)
      return {
        text: (item.trail ?? []).some((t) => t.role === "md")
          ? "HR's revised proposal — confirm it"
          : "HR's proposal — confirm it",
        tone: "sand",
      };
    return { text: "Decided by you", tone: "wine" };
  }
  if (stage === "md_changes")
    return item.rework ? { text: "Returned to HR", tone: "sand" } : { text: "No change asked", tone: "neutral" };
  if (stage === "hr_final") return { text: "With HR (final settlement)", tone: "neutral" };
  if (finalized(stage)) {
    const eff = item.effective ?? { decision: item.final.decision, amount: item.final.amount, remark: "" };
    const changed = !!item.auditor?.action;
    if (eff.decision === "approved")
      return {
        text: `${item.applied ? "Paid" : "Final"} ${money(eff.amount)}${changed ? " (auditor changed)" : ""}`,
        tone: "success",
      };
    if (eff.decision === "rejected")
      return { text: `Final: rejected${changed ? " (by the auditor)" : ""}`, tone: "danger" };
  }
  return { text: "Waiting", tone: "neutral" };
}

/** The ids "Select all" picks: every request on screen (the filter and search as they are). */
export const shownIds = (items: Pick<SettlementItem, "id">[]): number[] => items.map((i) => i.id);

/** Select all / clear: all of `ids` when not all are chosen yet, else none of them (the rest stays chosen). */
export function toggleAll(selected: ReadonlySet<number>, ids: number[]): Set<number> {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** The toast after a bulk decision: how many were saved, and who was left out and why. */
export function bulkResultText(
  decision: "approved" | "rejected",
  chosen: number,
  skipped: { id: number; reason: string }[],
  items: Pick<SettlementItem, "id" | "advance">[],
): { title: string; description?: string } {
  const done = chosen - skipped.length;
  const title = `${decision === "approved" ? "Approved" : "Rejected"} ${plural(done, "request")}`;
  if (!skipped.length) return { title };
  const names = skipped.map((s) => {
    const name = items.find((i) => i.id === s.id)?.advance.employeeName ?? `Request ${s.id}`;
    return `${name}: ${s.reason}`;
  });
  return { title: `${title}, ${plural(skipped.length, "request")} left out`, description: names.join(" · ") };
}

// ── the two types: Salary Advance and Term Loan (independent workflows since 2026-11-27) ───────────────────────────

export const ADVANCE_TYPES: readonly AdvanceType[] = ["general", "term"];
export const TYPE_LABEL: Record<AdvanceType, string> = { general: "Salary Advance", term: "Term Loan" };

/** `type=` from the address ("general" | "term", or the HRMS's own words "salary-advance" | "term-loan"); null otherwise. */
export function typeFromQuery(raw: string | null | undefined): AdvanceType | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "general" || t === "salary-advance") return "general";
  if (t === "term" || t === "term-loan") return "term";
  return null;
}

const ZERO: Record<AdvanceType, number> = { general: 0, term: 0 };

/** The requests of each type waiting for the MD in one month, from the waiting list (all months). */
export function waitingInMonth(waiting: MdSettlementWaiting | undefined, month: MonthKey): Record<AdvanceType, number> {
  const out = { ...ZERO };
  for (const b of waiting?.batches ?? []) {
    const t = b.advanceType ?? "general";
    if (monthKey(b.year, b.month) === month && t in out) out[t] += b.requests;
  }
  return out;
}

/** The type the page opens on when the address names none: the one with requests waiting for the MD in the month on
 *  screen, else the one waiting anywhere, else Salary Advance (Salary Advance first when both wait). */
export function defaultType(waiting: MdSettlementWaiting | undefined, month: MonthKey): AdvanceType {
  const here = waitingInMonth(waiting, month);
  const anywhere = waiting?.byType ?? ZERO;
  return ADVANCE_TYPES.find((t) => here[t] > 0) ?? ADVANCE_TYPES.find((t) => (anywhere[t] ?? 0) > 0) ?? "general";
}

/** The Type dropdown's choices with the requests waiting for the MD in the month: "Salary Advance · 2 waiting". */
export function typeOptions(counts: Record<AdvanceType, number>): { value: AdvanceType; label: string }[] {
  return ADVANCE_TYPES.map((value) => ({
    value,
    label: counts[value] > 0 ? `${TYPE_LABEL[value]} · ${num(counts[value])} waiting` : TYPE_LABEL[value],
  }));
}

/** A batch's name with its type: "Salary Advance · Batch 1" (the server's `title`, else made the same way). */
export function batchTitle(b: Pick<SettlementBatch, "title" | "typeLabel" | "advanceType" | "label">): string {
  if (b.title) return b.title;
  const type = b.typeLabel ?? (b.advanceType ? TYPE_LABEL[b.advanceType] : null);
  return type ? `${type} · ${b.label}` : b.label;
}

export type WaitingGroup = {
  key: MonthKey;
  type: AdvanceType;
  typeLabel: string;
  /** "Oct 2026" */
  label: string;
  /** "October 2026" */
  period: string;
  requests: number;
  batches: number[];
  firstBatchId: number;
};

/** Batches waiting for the MD anywhere but the month and type on screen (oldest month first, Salary Advance before Term
 *  Loan), for the "waiting elsewhere" banner. */
export function waitingElsewhere(
  waiting: MdSettlementWaiting | undefined,
  shown: MonthKey,
  shownType: AdvanceType | null,
): WaitingGroup[] {
  const groups = new Map<
    string,
    { key: MonthKey; type: AdvanceType; requests: number; batches: { number: number; id: number }[] }
  >();
  for (const b of waiting?.batches ?? []) {
    const key = monthKey(b.year, b.month);
    const type = b.advanceType ?? "general";
    if (key === shown && (shownType === null || type === shownType)) continue;
    const id = `${key}|${ADVANCE_TYPES.indexOf(type)}`;
    const row = groups.get(id) ?? { key, type, requests: 0, batches: [] };
    row.requests += b.requests;
    row.batches.push({ number: b.number, id: b.id });
    groups.set(id, row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => {
      const batches = [...row.batches].sort((x, y) => x.number - y.number);
      const { year, month } = parseMonthKey(row.key);
      return {
        key: row.key,
        type: row.type,
        typeLabel: TYPE_LABEL[row.type],
        label: monthLabel(row.key),
        period: periodLabel(month, year),
        requests: row.requests,
        batches: batches.map((x) => x.number),
        firstBatchId: batches[0].id,
      };
    });
}

/** "1 request", "3 requests". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** "Batch 1", "Batches 1 and 2", "Batches 1, 2 and 3". */
export function batchesText(numbers: number[]): string {
  if (numbers.length <= 1) return `Batch ${numbers[0] ?? ""}`.trim();
  return `Batches ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

/** The banner's line for a type and month with batches waiting: "Term Loan · Batch 1 waiting in October 2026 (4 requests)". */
export function waitingSentence(w: WaitingGroup): string {
  return `${w.typeLabel} · ${batchesText(w.batches)} waiting in ${w.period} (${plural(w.requests, "request")})`;
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ListFilter = "all" | "undecided" | "decided" | "leave";

export function matchesFilter(item: SettlementItem, filter: ListFilter): boolean {
  if (filter === "undecided") return decisionKind(item) === "undecided";
  if (filter === "decided") return decisionKind(item) !== "undecided";
  if (filter === "leave") return hasLeaveAlert(item);
  return true;
}

/** The requests that pass the filter and the search (name, code, department, designation, unit). */
export function filterItems(items: SettlementItem[], filter: ListFilter, q: string): SettlementItem[] {
  const needle = q.trim().toLowerCase();
  return items.filter((item) => {
    if (!matchesFilter(item, filter)) return false;
    if (!needle) return true;
    const a = item.advance;
    return [a.employeeName, a.employeeCode, a.employeeDepartment, a.employeeDesignation, a.employeeBranch]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle));
  });
}

export function filterCounts(items: SettlementItem[]): Record<ListFilter, number> {
  const out: Record<ListFilter, number> = { all: items.length, undecided: 0, decided: 0, leave: 0 };
  for (const item of items) {
    if (decisionKind(item) === "undecided") out.undecided += 1;
    else out.decided += 1;
    if (hasLeaveAlert(item)) out.leave += 1;
  }
  return out;
}

const FILTER_LABEL: Record<ListFilter, string> = {
  all: "All requests",
  undecided: "To decide",
  decided: "Decided",
  leave: "Leave alerts",
};

/** The "Show" dropdown's choices, each with its count: "To decide (3)". */
export function filterOptions(items: SettlementItem[]): { value: ListFilter; label: string }[] {
  const counts = filterCounts(items);
  return (Object.keys(FILTER_LABEL) as ListFilter[]).map((value) => ({
    value,
    label: `${FILTER_LABEL[value]} (${num(counts[value])})`,
  }));
}

export const isListFilter = (raw: string): raw is ListFilter => raw in FILTER_LABEL;

// ── the page's tabs, the batch dropdown, the history ────────────────────────────────────────────────────────────────

export type SettlementView = "requests" | "overview" | "history";
export const SETTLEMENT_VIEWS: readonly SettlementView[] = ["requests", "overview", "history"];

/** `view=` from the address; Requests when missing or unknown. */
export const viewFromQuery = (raw: string | null | undefined): SettlementView =>
  (SETTLEMENT_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as SettlementView) : "requests";

/** The batch dropdown's line: "Batch 1 · Waiting for you · 4 requests". */
export function batchOptionLabel(b: Pick<SettlementBatch, "label" | "stage" | "stageLabel" | "counts">): string {
  const stage = b.stage === "md_review" ? "Waiting for you" : b.stageLabel;
  return `${b.label} · ${stage} · ${plural(b.counts.total, "request")}`;
}

/** One history entry's figures ("4 requests", "3 approved · 1 rejected · ₹23,000", "2 changed · 1 with your remark");
 *  the words of the step itself are the shared tracker's (historyLabel in components/settlement-flow/WorkflowFlow). */
export function historyFacts(entry: HistoryEntry): string {
  const returned = entry.action === "md_returned";
  const count = (n: unknown) => (typeof n === "number" && n > 0 ? n : null);
  const changes = returned ? count(entry.changes) : null;
  const remarks = returned ? count(entry.remarks) : null;
  return [
    changes != null ? `${num(changes)} changed` : null,
    remarks != null ? `${num(remarks)} with your remark` : null,
    typeof entry.count === "number"
      ? entry.action === "md_resubmitted"
        ? `${plural(entry.count, "request")} to look at again`
        : plural(entry.count, "request")
      : null,
    typeof entry.approved === "number" ? `${num(entry.approved)} approved` : null,
    typeof entry.rejected === "number" ? `${num(entry.rejected)} rejected` : null,
    typeof entry.total === "number" ? money(entry.total) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── rework and re-approval (owner 2026-11-27) ──────────────────────────────────────────────────────────────────────
// The MD changes an amount, rejects a request or asks for corrections -> the settlement goes back to HR (HR Rework (MD
// Changes)); HR answers and resubmits; the MD approves the revised settlement (round 2, 3 ...). The server decides
// (service.py md_changed / review_state); these mirror it for an older reply and say it in words.

/** Where a request stands with the batch's reviewer (the server's `review`, else worked out the same way): waiting for
 *  the MD (undecided, or HR's proposal still to confirm), approved or rejected. Rework puts it back to waiting. */
export function reviewOf(item: SettlementItem, stage: SettlementStage): ReviewState {
  if (item.review) return item.review;
  if (stage === "md_review") {
    const kind = decisionKind(item);
    if (kind === "undecided" || item.md.fromHr) return "pending";
    return kind === "rejected" ? "rejected" : "approved";
  }
  if (stage === "md_changes" && item.rework) return "pending";
  const d = item.effective?.decision ?? item.final.decision ?? item.md.decision;
  return d === "rejected" ? "rejected" : d === "approved" ? "approved" : "pending";
}

const PENDING_LABEL: Partial<Record<SettlementStage, string>> = {
  md_review: "Waiting for your decision",
  md_changes: "Waiting for HR's answer",
  hr_final: "With HR",
  auditor_changes: "With HR",
  auditor_review: "With the auditor",
};

/** The heading of the waiting group of the list: who it waits for at the batch's stage. */
export const pendingLabel = (stage: SettlementStage): string => PENDING_LABEL[stage] ?? "Waiting";

/** The MD's review round: 1, then 2, 3 ... each time HR resubmits a returned settlement. */
export const mdRoundOf = (b: Pick<SettlementBatch, "flow" | "mdRound">): number => b.flow?.mdRound ?? b.mdRound ?? 1;

type Expected = { decision: MdDecision; amount: number | null };

/** HR's proposal as an MD decision (service.py hr_expected): rejected, approved for HR's smaller amount, or approved for
 *  the full amount asked (HR kept it, or did not review it). */
export function hrExpected(item: Pick<SettlementItem, "hr" | "requestedAmount">): Expected {
  if (item.hr?.action === "reject") return { decision: "rejected", amount: null };
  if (item.hr?.action === "reduce" && item.hr.amount != null) return { decision: "approved", amount: item.hr.amount };
  return { decision: "approved", amount: item.requestedAmount };
}

const sameDecision = (a: Expected, b: Expected) =>
  a.decision === b.decision && (a.decision === "rejected" || Math.abs((a.amount ?? 0) - (b.amount ?? 0)) < 0.005);

/** The MD's own decision differs from HR's proposal (the server's `mdChanged`, else worked out the same way). A decision
 *  pre-filled from HR and not touched by the MD is no change. */
export function mdChangedOf(item: SettlementItem): boolean {
  if (typeof item.mdChanged === "boolean") return item.mdChanged;
  if (!item.md.decision || item.md.fromHr || !item.md.decidedAt) return false;
  return !sameDecision(
    { decision: item.md.decision, amount: item.md.amount ?? item.requestedAmount },
    hrExpected(item),
  );
}

/** A decision in a few words: "₹6,000", "reject". */
const shortDecision = (e: Expected): string => (e.decision === "rejected" ? "reject" : money(e.amount));

/** The changed-from-HR chip's hover text: what HR proposed and what the MD decided. */
export function changeText(item: SettlementItem): string {
  const hr = hrExpected(item);
  const mine: Expected = { decision: item.md.decision ?? "approved", amount: item.md.amount ?? item.requestedAmount };
  return `HR proposed ${shortDecision(hr)}; you ${mine.decision === "rejected" ? "rejected it" : `set ${money(mine.amount)}`}. Return the settlement to HR for rework; you approve it once HR resubmits.`;
}

export type TrailLine = {
  round: number;
  /** "Round 1: you set ₹3,000" */
  you: string;
  /** "HR now proposes ₹4,000" | "HR accepted it" */
  hr: string;
  /** Every earlier round in full (the hover text), oldest first. */
  detail: string[];
};

const trailDecision = (t: TrailEntry, requested: number): Expected =>
  t.action === "rejected" || t.action === "reject"
    ? { decision: "rejected", amount: null }
    : { decision: "approved", amount: t.amount ?? requested };

/** A request the MD decided in an earlier round of a returned settlement: what the MD set then and what HR answers now
 *  ("Round 1: you set ₹3,000 · HR now proposes ₹4,000", or "· HR accepted it"). Null when it has no earlier round. */
export function trailLine(item: SettlementItem, mdRound: number): TrailLine | null {
  const trail = (item.trail ?? []).filter((t) => t.round < mdRound);
  const mine = trail.filter((t) => t.role === "md");
  if (!mine.length) return null;
  const last = mine.reduce((a, b) => (b.round > a.round ? b : a));
  const then = trailDecision(last, item.requestedAmount);
  const now = hrExpected(item);
  const rounds = [...new Set(trail.filter((t) => t.role === "hr" || t.role === "md").map((t) => t.round))].sort(
    (a, b) => a - b,
  );
  const detail = rounds.map((r) => {
    const parts = (["hr", "md"] as const).flatMap((role) => {
      const t = trail.find((x) => x.role === role && x.round === r);
      if (!t) return [];
      const d = trailDecision(t, item.requestedAmount);
      const what =
        role === "hr"
          ? `HR proposed ${shortDecision(d)}`
          : d.decision === "rejected"
            ? "you rejected it"
            : `you set ${money(d.amount)}`;
      return [t.remark?.trim() ? `${what} (“${t.remark.trim()}”)` : what];
    });
    return `Round ${r}: ${parts.join(" · ")}`;
  });
  return {
    round: last.round,
    you: `Round ${last.round}: ${then.decision === "rejected" ? "you rejected it" : `you set ${money(then.amount)}`}`,
    hr: sameDecision(then, now) ? "HR accepted it" : `HR now proposes ${shortDecision(now)}`,
    detail,
  };
}

/** The latest entry of a kind in the batch's history (the MD's return, HR's resubmission). */
export function lastHistory(b: Pick<SettlementBatch, "history">, action: string): HistoryEntry | null {
  const list = b.history ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].action === action) return list[i];
  return null;
}

/** A Term Loan's plan in a line: "Over 10 months · EMI ₹5,000 · from Dec 2026" (null for a Salary Advance). */
export function termText(adv: SettlementAdvance): string | null {
  if (adv.advanceType !== "term") return null;
  const parts = [
    adv.repaymentMonths ? `Over ${plural(adv.repaymentMonths, "month")}` : null,
    adv.emiAmount ? `EMI ${money(adv.emiAmount)}` : null,
    shortMonth(adv.repaymentStartMonth, adv.repaymentStartYear)
      ? `from ${shortMonth(adv.repaymentStartMonth, adv.repaymentStartYear)}`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
