// The Auditor Review Portal's rules (owner 2026-11-27), apart from the screens so they can be tested: what a row shows,
// what a change may be (the server's own checks: service.auditor_change), the totals before and after the audit, what
// the auditor's answer may be, and the bank file built here from the settlement as paid (the HRMS Settlement bank file's
// rule: the effective approved amount rounded UP to the rupee, the Payroll bank-file format). Also: a Term Loan batch's
// own figures, finding and choosing requests for the bulk actions, and how long the link still works.

import type { BankFileLine } from "@/lib/bankFile";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { ReviewState } from "@/lib/reviewOrder";
import { roundUpRupee } from "@/lib/round-up-rupee";
import { batchBankFileName, reportSheet } from "@/pages/hr/settlement/automation/logic";
import { REMARK_MAX, REMARK_MIN, cleanRemark } from "@/pages/hr/settlement/logic";
import { formatMoney, monthLabel } from "@/pages/hr/settlement/shared";
import type {
  PortalBulkInput,
  PortalChangeInput,
  PortalData,
  PortalDecision,
  PortalItem,
  TimeCard,
  TimeCardDay,
} from "./api";

const round2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ─── When the link does not open ────────────────────────────────────────────────

export type PortalProblem = {
  kind: "invalid" | "revoked" | "expired" | "unavailable";
  title: string;
  text: string;
  /** A second line that says what to do (a replaced link: each review round has a link of its own). */
  hint?: string;
};

/** Why the portal cannot be shown, in the server's words where it has them. */
export function portalProblem(err: unknown): PortalProblem {
  const data = err instanceof ApiError ? ((err.data ?? null) as { error?: unknown; code?: unknown } | null) : null;
  const said = data && typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;
  const code = data && typeof data.code === "string" ? data.code : null;
  if (code === "link_invalid" || (err instanceof ApiError && err.status === 404))
    return {
      kind: "invalid",
      title: "This review link is not valid",
      // the server only says the same as the title: say what to do instead
      text: "Check that the whole address from the e-mail was opened, or ask HR to send the review link again.",
    };
  if (code === "link_revoked")
    return {
      kind: "revoked",
      title: "This review link is no longer in use",
      text: said ?? "It was replaced by a newer link or closed by HR. Please use the latest e-mail.",
      hint: "When HR reworks a settlement and sends it back to you, the revised settlement comes with a new link: open the latest review e-mail.",
    };
  if (code === "link_expired" || (err instanceof ApiError && err.status === 410))
    return {
      kind: "expired",
      title: "This review link has expired",
      text: said ?? "Please ask HR to send the review link again.",
    };
  return {
    kind: "unavailable",
    title: "The review could not be loaded",
    text: "Check your connection and try again in a moment.",
  };
}

/** A refusal that means the portal changed (answered, no longer under review, closed, expired): it is read again. */
export const refusalReloads = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 410);

/** The server's own words for a refused change or answer. */
export function refusalText(err: unknown, fallback: string): { text: string; code: string | null } {
  if (err instanceof ApiError) {
    const data = (err.data ?? null) as { error?: unknown; code?: unknown } | null;
    const said = data && typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;
    return { text: said ?? fallback, code: data && typeof data.code === "string" ? data.code : null };
  }
  return { text: err instanceof Error && err.message ? err.message : fallback, code: null };
}

// ─── The status of the review ───────────────────────────────────────────────────

export const DECISION_LABEL: Record<PortalDecision, string> = {
  approved_send_accounts: "Approved and sent to Accounts",
  approved_forward_hr: "Approved and forwarded to HR",
  changes_forward_hr: "Returned to HR for rework",
};

export function reviewStatus(data: PortalData): { text: string; tone: "info" | "success" | "neutral" } {
  if (data.link.submittedAt) return { text: "Review submitted", tone: "success" };
  if (data.canReview) return { text: "Awaiting your review", tone: "info" };
  return { text: "Read-only", tone: "neutral" };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long the link still works, for the header: "4 days left", "1 day left", "Expires today", "Expired". */
export function linkValidity(expiresAt: string | null | undefined, now = new Date()): string {
  const end = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(end)) return "";
  const left = end - now.getTime();
  if (left <= 0) return "Expired";
  const days = Math.floor(left / DAY_MS);
  return days < 1 ? "Expires today" : `${plural(days, "day")} left`;
}

// ─── One row ─────────────────────────────────────────────────────────────────────

export type RowStatus = "approved" | "reduced" | "rejected_by_auditor" | "rejected_by_hr";

export const hrApproved = (item: PortalItem): boolean => item.final.decision === "approved";

export function rowStatus(item: PortalItem): RowStatus {
  if (!hrApproved(item)) return "rejected_by_hr";
  if (item.auditor.action === "reject") return "rejected_by_auditor";
  if (item.auditor.action === "reduce") return "reduced";
  return "approved";
}

/** The auditor changed this request (a remark alone is not a change). */
export const isChanged = (item: PortalItem): boolean =>
  item.auditor.action === "reduce" || item.auditor.action === "reject";

/** What the auditor did, in words: "Reduced ₹8,000 → ₹6,000", "Rejected (HR approved ₹5,000)"; null for no change. */
export function changeText(item: PortalItem): string | null {
  if (item.auditor.action === "reduce")
    return `Reduced ${formatMoney(item.final.amount)} → ${formatMoney(item.auditor.amount)}`;
  if (item.auditor.action === "reject") return `Rejected (HR approved ${formatMoney(item.final.amount)})`;
  return null;
}

// ─── Where a request stands with the auditor (owner 2026-11-27) ─────────────────
// Waiting ones at the top, approved ones below, rejected ones below those (lib/reviewOrder); a request reopened with
// Rework waits again.

/** service.review_state for the auditor's stage: the server's own `review` when it sends one (an older server does
 *  not): rejected by HR or by the auditor, approved by the auditor (as HR settled it, or reduced), else waiting. */
export function reviewOf(item: PortalItem): ReviewState {
  if (item.review) return item.review;
  if (!hrApproved(item) || item.auditor.action === "reject") return "rejected";
  return item.auditor.action === "approve" || item.auditor.action === "reduce" ? "approved" : "pending";
}

/** The requests not reviewed yet (the server's count when it sends one). */
export const pendingCount = (data: Pick<PortalData, "items" | "totals">): number =>
  data.totals.pending ?? data.items.filter((i) => reviewOf(i) === "pending").length;

/** A row's state in one word for its pill: waiting, or the row's status once reviewed. */
export type RowState = "pending" | RowStatus;

export const rowState = (item: PortalItem): RowState => (reviewOf(item) === "pending" ? "pending" : rowStatus(item));

/** The auditor answered this request (approve, reject; a reduction from before 2026-11-27): Rework can reopen it. HR's own rejection cannot be
 *  reopened (it only takes a remark). */
export const canRework = (item: PortalItem): boolean =>
  hrApproved(item) &&
  (item.auditor.action === "approve" || item.auditor.action === "reduce" || item.auditor.action === "reject");

/** Approve, as HR settled it (the remark the request has stays). */
export const approveBody = (item: PortalItem): PortalChangeInput => ({
  action: "approve",
  remark: item.auditor.remark ?? "",
});

/** Rework: the request waits for the auditor's review again (an empty action); the remark stays. */
export const reworkBody = (item: PortalItem): PortalChangeInput => ({ action: "", remark: item.auditor.remark ?? "" });

// ─── The earlier rounds (a settlement HR reworked and resubmitted) ───────────────

/** What HR did with the auditor's earlier change: took it, kept its own amount, settled it at another amount, rejected
 *  it, or settled it (no earlier figure to compare with). */
export type TrailOutcome = "accepted" | "kept" | "changed" | "rejected" | "settled";

export type TrailLine = {
  round: number;
  /** "Round 1: you reduced it to ₹3,000 · HR accepted". */
  text: string;
  /** "Round 1 · HR accepted" (the table's chip: the round over HR's answer). */
  short: string;
  /** HR's answer in a few words, for the chip: "HR accepted", "HR kept ₹6,000", "HR changed to ₹4,000". */
  answer: string;
  outcome: TrailOutcome;
  yourRemark: string;
  /** HR's remark with its answer, when it says more than the auditor's own. */
  hrRemark: string;
  /** false: a request the auditor did not flag that HR changed on its own in the rework (2026-11-27). */
  flagged: boolean;
};

const sameMoney = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && Math.abs(a - b) < 0.005;

/**
 * The auditor's earlier changes on a request and HR's answer to each (from `trail`): the auditor's answer of a round
 * against HR's settlement before it (that round's "hr_final") and after it (the next round's "hr_final", else the
 * settlement now). Only a change or a remark is listed (a plain approval is not news).
 */
export function trailLines(item: PortalItem): TrailLine[] {
  const trail = item.trail ?? [];
  const finals = trail.filter((t) => t.role === "hr_final").sort((a, b) => a.round - b.round);
  const lines = trail
    .filter(
      (t) => t.role === "auditor" && (t.action === "reduce" || t.action === "reject" || (t.remark ?? "").trim() !== ""),
    )
    .sort((a, b) => a.round - b.round)
    .map((a) => {
      const before = finals.find((f) => f.round === a.round) ?? null;
      const next = finals.find((f) => f.round > a.round);
      const after = next
        ? { decision: next.action, amount: next.amount, remark: next.remark ?? "" }
        : { decision: item.final.decision ?? "", amount: item.final.amount, remark: item.final.remark ?? "" };
      const you =
        a.action === "reduce"
          ? `you reduced it to ${formatMoney(a.amount)}`
          : a.action === "reject"
            ? "you rejected it"
            : "you left a remark";
      let outcome: TrailOutcome;
      let hr: string;
      let answer: string;
      const amount = formatMoney(after.amount);
      if (after.decision === "rejected") {
        outcome = a.action === "reject" ? "accepted" : "rejected";
        hr = answer = a.action === "reject" ? "HR accepted" : "HR rejected it";
      } else if (after.decision === "approved") {
        if (a.action === "reduce" && sameMoney(after.amount, a.amount)) {
          outcome = "accepted";
          hr = answer = "HR accepted";
        } else if (before && sameMoney(after.amount, before.amount)) {
          outcome = "kept";
          hr = answer = `HR kept ${amount}`;
        } else if (before) {
          outcome = "changed";
          hr = `HR changed it to ${amount}`;
          answer = `HR changed to ${amount}`;
        } else {
          outcome = "settled";
          hr = `HR settled it at ${amount}`;
          answer = `HR settled at ${amount}`;
        }
      } else {
        outcome = "settled";
        hr = answer = "HR settled it";
      }
      const yourRemark = (a.remark ?? "").trim();
      const hrRemark = after.remark.trim();
      return {
        round: a.round,
        text: `Round ${a.round}: ${you} · ${hr}`,
        short: `Round ${a.round} · ${answer}`,
        answer,
        outcome,
        yourRemark,
        hrRemark: hrRemark && hrRemark !== yourRemark ? hrRemark : "",
        flagged: true,
      };
    });
  // a request the auditor did not flag in a round, but HR changed in that round's rework (the server keeps HR's
  // settlement of every request when the auditor returns it)
  const flaggedRounds = new Set(
    trail
      .filter(
        (t) =>
          t.role === "auditor" && (t.action === "reduce" || t.action === "reject" || (t.remark ?? "").trim() !== ""),
      )
      .map((t) => t.round),
  );
  const unflagged = finals
    .filter((f) => !flaggedRounds.has(f.round))
    .flatMap((f): TrailLine[] => {
      const next = finals.find((n) => n.round > f.round);
      const after = next
        ? { decision: next.action, amount: next.amount, remark: next.remark ?? "" }
        : { decision: item.final.decision ?? "", amount: item.final.amount, remark: item.final.remark ?? "" };
      const same = after.decision === f.action && (after.decision === "rejected" || sameMoney(after.amount, f.amount));
      if (same) return [];
      const answer = after.decision === "rejected" ? "HR rejected it" : `HR changed to ${formatMoney(after.amount)}`;
      const hr =
        after.decision === "rejected"
          ? "HR rejected it"
          : `HR changed it from ${formatMoney(f.amount)} to ${formatMoney(after.amount)}`;
      return [
        {
          round: f.round,
          text: `Round ${f.round}: not flagged by you · ${hr}`,
          short: `Round ${f.round} · ${answer}`,
          answer,
          outcome: after.decision === "rejected" ? "rejected" : "changed",
          yourRemark: "",
          hrRemark: after.remark.trim(),
          flagged: false,
        },
      ];
    });
  return [...lines, ...unflagged].sort((a, b) => a.round - b.round);
}

/** The review round (1 = the first review; 2+ = HR reworked it and resubmitted it). */
export const reviewRound = (data: Pick<PortalData, "settlement">): number => Math.max(1, data.settlement.round ?? 1);

/** HR's answers to the auditor's changes of the round before this one, counted: "HR accepted 1, kept 1 and changed 1."
 *  ("" when there were none). */
export function lastRoundSummary(data: PortalData): string {
  const round = reviewRound(data) - 1;
  if (round < 1) return "";
  const all = data.items.flatMap((i) => trailLines(i).filter((l) => l.round === round));
  const lines = all.filter((l) => l.flagged);
  const own = all.length - lines.length;
  const also = own > 0 ? ` HR also changed ${requestsWord(own)} you did not flag.` : "";
  if (lines.length === 0) return also.trim();
  const count = (o: TrailOutcome) => lines.filter((l) => l.outcome === o).length;
  const parts = (
    [
      ["accepted", "accepted"],
      ["kept", "kept"],
      ["changed", "changed"],
      ["rejected", "rejected"],
      ["settled", "settled"],
    ] as const
  )
    .filter(([o]) => count(o) > 0)
    .map(([o, word]) => `${word} ${count(o)}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `You flagged ${requestsWord(lines.length)} in round ${round}: HR ${list}.${also}`;
}

// ─── A Term Loan's own figures (owner 2026-11-27) ───────────────────────────────
// A Term Loan batch is never read in the Salary Advance columns (Working Days, Earned Salary, a 50 %-earned Limit): it
// has its fixed monthly salary, the eligible limit kept when it was raised, the months, the monthly EMI and the first
// EMI month, as the HRMS Term Loan report (TERM_EXPORT_COLUMNS) prints them.

export const isTermSettlement = (data: Pick<PortalData, "settlement">): boolean =>
  data.settlement.advanceType === "term";

/** The fixed monthly salary when the loan was raised (kept on it), else the earned figures'. */
export const termFixedSalary = (item: PortalItem): number | null =>
  item.advance.salaryAtRequest ?? item.advance.earnings?.fixedSalary ?? null;

/** The months as HR finalized them (the request's own until HR changed them). */
export const termMonths = (item: PortalItem): number | null =>
  item.final.months ?? item.advance.repaymentMonths ?? null;

/** The monthly EMI of an amount over months: whole rupees rounded UP, the last one smaller and absorbing the rest
 *  (settlement_views.whole_rupee_emi: 10,000 over 3 months = 3,334 + 3,334 + 3,332). Null when it cannot be worked
 *  out. */
export function termEmi(
  amount: number | null | undefined,
  months: number | null | undefined,
): { emi: number; last: number } | null {
  if (amount == null || !(amount > 0) || !months || months <= 0) return null;
  const emi = Math.ceil(round2(amount) / months);
  const last = round2(amount - emi * (months - 1));
  return { emi, last: last > 0 ? last : emi };
}

/** "₹3,334 a month (the last ₹3,332)"; "" when there is no EMI. */
export function termEmiText(amount: number | null | undefined, months: number | null | undefined): string {
  const e = termEmi(amount, months);
  if (!e) return "";
  const last = months && months > 1 && e.last !== e.emi ? ` (the last ${formatMoney(e.last)})` : "";
  return `${formatMoney(e.emi)} a month${last}`;
}

/** The first EMI month ("Dec 2026"): HR's final first month, else the one the request asked for. */
export function firstEmiMonth(item: PortalItem): string | null {
  const month = item.final.startMonth ?? item.advance.repaymentStartMonth ?? null;
  const year = item.final.startYear ?? item.advance.repaymentStartYear ?? null;
  return month && year ? monthLabel(month, year) : null;
}

// ─── Finding and choosing requests ──────────────────────────────────────────────

export type RowFilter = "all" | "pending" | "approved" | "changed" | "rejected" | "leave" | "remarks";

export const ROW_FILTERS: { value: RowFilter; label: string }[] = [
  { value: "all", label: "All requests" },
  { value: "pending", label: "Waiting for your review" },
  { value: "approved", label: "Approved, unchanged" },
  { value: "changed", label: "Changed by you" },
  { value: "rejected", label: "Rejected" },
  { value: "leave", label: "Leave flagged" },
  { value: "remarks", label: "With your remark" },
];

export const asRowFilter = (raw: string): RowFilter =>
  ROW_FILTERS.some((f) => f.value === raw) ? (raw as RowFilter) : "all";

function rowMatches(item: PortalItem, filter: RowFilter): boolean {
  switch (filter) {
    case "pending":
      return reviewOf(item) === "pending";
    case "approved":
      return rowStatus(item) === "approved";
    case "changed":
      return isChanged(item);
    case "rejected":
      return item.effective.decision !== "approved";
    case "leave":
      return item.advance.leaveCheck?.flag === "warning" || item.advance.leaveCheck?.flag === "critical";
    case "remarks":
      return !!(item.auditor.remark ?? "").trim();
    default:
      return true;
  }
}

/** The requests a search (name, code, department, designation) and a filter leave. */
export function filterItems(items: PortalItem[], filter: RowFilter, query: string): PortalItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (!rowMatches(item, filter)) return false;
    if (words.length === 0) return true;
    const a = item.advance;
    const hay = [a.employeeName, a.employeeCode, a.employeeDepartment, a.employeeDesignation]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A request the bulk actions apply to: one HR approved (HR's rejection can only get a remark). */
export const bulkSelectable = (item: PortalItem): boolean => hrApproved(item);

/** The Select All box: none, some or all of the requests shown that can be chosen are chosen. */
export function selectionState(shown: PortalItem[], chosen: ReadonlySet<number>): "none" | "some" | "all" {
  const ids = shown.filter(bulkSelectable).map((i) => i.id);
  const n = ids.filter((id) => chosen.has(id)).length;
  if (n === 0) return "none";
  return n === ids.length ? "all" : "some";
}

/** Select All: chooses every request shown that can be chosen, or (when all of them are) clears them. */
export function toggleAll(shown: PortalItem[], chosen: ReadonlySet<number>): Set<number> {
  const ids = shown.filter(bulkSelectable).map((i) => i.id);
  const next = new Set(chosen);
  if (selectionState(shown, chosen) === "all") ids.forEach((id) => next.delete(id));
  else ids.forEach((id) => next.add(id));
  return next;
}

/** The chosen requests that are shown and can be chosen, in the settlement's order (a request hidden by the search or
 *  the filter is never acted on unseen). */
export const chosenItems = (shown: PortalItem[], chosen: ReadonlySet<number>): PortalItem[] =>
  shown.filter((i) => chosen.has(i.id) && bulkSelectable(i));

export type BulkAction = PortalBulkInput["action"];

/** What stops a bulk action: Reject needs one reason for all (at least 3 characters); Approve's remark is optional. */
export function bulkProblem(action: BulkAction, remark: string): string | null {
  const clean = cleanRemark(remark);
  if (action === "reject" && clean.length < REMARK_MIN)
    return "Write the reason for rejecting (at least 3 characters).";
  if (clean.length > REMARK_MAX) return `Keep the remark under ${REMARK_MAX} characters.`;
  return null;
}

export const bulkBody = (items: PortalItem[], action: BulkAction, remark: string): PortalBulkInput => ({
  itemIds: items.map((i) => i.id),
  action,
  remark: cleanRemark(remark),
});

/** The chosen requests in figures: how many, HR's approved total, and how many of them the auditor already changed
 *  (Approve puts those back as HR approved them). */
export function bulkSummary(items: PortalItem[]): { count: number; amount: number; changed: number } {
  return {
    count: items.length,
    amount: round2(items.reduce((s, i) => s + (i.final.amount ?? 0), 0)),
    changed: items.filter(isChanged).length,
  };
}

// ─── A change ────────────────────────────────────────────────────────────────────

/** Reject (a remark), or a Remark alone (no change to the amount; how the auditor asks HR for a change). The auditor
 *  does not reduce amounts (owner 2026-11-27). */
export type ChangeMode = "reject" | "remark";

export type ChangeProblems = Partial<Record<"amount" | "remark", string>>;

/** What stops a change from being saved (service.auditor_change's checks), field by field. */
export function changeProblems(item: PortalItem, mode: ChangeMode, amountText: string, remark: string): ChangeProblems {
  const out: ChangeProblems = {};
  const clean = cleanRemark(remark);
  if (mode === "reject" && clean.length < REMARK_MIN)
    out.remark = "Write the reason for rejecting (at least 3 characters).";
  if (clean.length > REMARK_MAX) out.remark = `Keep the remark under ${REMARK_MAX} characters.`;
  return out;
}

/** The PATCH body of a change. A remark alone keeps the answer the row already has (an approval or a reduced amount
 *  stays; a request waiting for review keeps waiting). */
export function changeBody(item: PortalItem, mode: ChangeMode, amountText: string, remark: string): PortalChangeInput {
  const clean = cleanRemark(remark);
  if (mode === "reject") return { action: "reject", remark: clean };
  // a reduction made before the auditor's Reduce was removed (2026-11-27) cannot be saved again: the remark reopens it
  const action = item.auditor.action === "reduce" ? "" : (item.auditor.action ?? "");
  return { action, remark: clean };
}

// ─── The totals and the changes ─────────────────────────────────────────────────

export type PortalTotals = {
  requests: number;
  requested: number;
  hrApprovedCount: number;
  hrApproved: number;
  approved: number;
  afterAudit: number;
  rejected: number;
  changes: number;
  remarks: number;
  /** HR's total minus what is paid after the audit. */
  difference: number;
};

export function portalTotals(data: PortalData): PortalTotals {
  const hrApprovedItems = data.items.filter(hrApproved);
  const paid = data.items.filter((i) => i.effective.decision === "approved");
  const hr = round2(hrApprovedItems.reduce((s, i) => s + (i.final.amount ?? 0), 0));
  const after = round2(paid.reduce((s, i) => s + (i.effective.amount ?? 0), 0));
  return {
    requests: data.items.length,
    requested: round2(data.items.reduce((s, i) => s + (i.requestedAmount || 0), 0)),
    hrApprovedCount: hrApprovedItems.length,
    hrApproved: hr,
    approved: paid.length,
    afterAudit: after,
    rejected: data.items.length - paid.length,
    changes: data.items.filter(isChanged).length,
    remarks: data.items.filter((i) => (i.auditor.remark ?? "").trim()).length,
    difference: round2(hr - after),
  };
}

/** Every request the auditor changed or wrote a remark on, for the Approval tab. */
export function modifications(data: PortalData): { item: PortalItem; change: string | null; remark: string }[] {
  return data.items
    .map((item) => ({ item, change: changeText(item), remark: (item.auditor.remark ?? "").trim() }))
    .filter((m) => m.change || m.remark);
}

// ─── The answer ─────────────────────────────────────────────────────────────────

/** Why the approvals are closed: the auditor rejected a request. */
export const CHANGED_TEXT = "You changed the settlement: return it to HR for rework.";

/** Why "Approve & Send to Accounts" cannot be used (the server's own refusals), or null. */
export function sendBlocked(data: PortalData): string | null {
  if (data.hasChanges) return CHANGED_TEXT;
  if (!data.items.some((i) => i.effective.decision === "approved"))
    return "Nothing is approved, so there is no bank file for Accounts.";
  if (data.accounts.to.length === 0)
    return "No Accounts e-mail address is set in the HRMS. Approve and forward to HR instead.";
  return null;
}

/** Why "Return to HR for rework" cannot be used (service.auditor_submit's `no_changes`): there is nothing for HR to
 *  rework without a change, a remark or a note (at least 3 characters) saying what to correct. */
export function returnBlocked(data: PortalData, note = ""): string | null {
  if (data.hasChanges || portalTotals(data).remarks > 0 || cleanRemark(note).length >= REMARK_MIN) return null;
  return "You made no change and wrote no remark: approve the settlement, or write in the note what HR should correct.";
}

/** The decisions open now: with changes only returning it to HR for rework; without, both approvals, and returning it
 *  too when there is a remark or a note for HR. */
export function openDecisions(data: PortalData, note = ""): PortalDecision[] {
  if (data.hasChanges) return ["changes_forward_hr"];
  const approvals: PortalDecision[] = ["approved_send_accounts", "approved_forward_hr"];
  return returnBlocked(data, note) ? approvals : [...approvals, "changes_forward_hr"];
}

/** "2 requests you have not marked will be approved as HR settled them." ("" when every request is marked). */
export function pendingApprovalText(data: PortalData): string {
  const n = pendingCount(data);
  if (n === 0) return "";
  return n === 1
    ? "1 request you have not marked will be approved as HR settled it."
    : `${n} requests you have not marked will be approved as HR settled them.`;
}

// ─── The bank file (the Payroll bank-file format, built here) ───────────────────

/** One payment per request paid (effective approved): the effective amount rounded UP to the rupee. */
export function bankLines(data: PortalData): BankFileLine[] {
  return data.items
    .filter((i) => i.effective.decision === "approved")
    .map((i) => ({
      employeeCode: i.advance.employeeCode,
      employeeName: i.advance.employeeName,
      bankAccount: i.advance.bankAccount ?? "",
      bankIfsc: i.advance.bankIfsc ?? "",
      bankName: i.advance.bankName ?? "",
      amount: roundUpRupee(i.effective.amount ?? 0),
    }));
}

export const bankTotal = (lines: BankFileLine[]): number => round2(lines.reduce((s, l) => s + l.amount, 0));

/** The lines the bank cannot pay as they are (no account number or no IFSC). */
export const bankMissing = (lines: BankFileLine[]): BankFileLine[] =>
  lines.filter((l) => !(l.bankAccount ?? "").trim() || !(l.bankIfsc ?? "").trim());

/** "Loan_Advance_Bank_File_Salary_Advance_November_2026_Batch_1.xlsx" (the HRMS's own name for the batch's file). */
export const portalBankFileName = (s: PortalData["settlement"]): string => batchBankFileName(s);
export const portalBankSheet = (s: PortalData["settlement"]): string => reportSheet(s);

// ─── The time card ──────────────────────────────────────────────────────────────

export const DAY_STATUS_LABEL: Record<string, string> = {
  present: "Present",
  absent: "Absent",
  half_shift: "Half Day",
  on_leave: "On Leave",
  holiday: "Holiday",
};

export const dayStatusLabel = (day: Pick<TimeCardDay, "status" | "inProgress">): string =>
  day.inProgress ? "In progress" : (DAY_STATUS_LABEL[day.status] ?? day.status.replace(/_/g, " "));

/** The marks of a day, in words: Late, Early out, Half shift, permissions, a compensation day. */
export function dayMarks(day: TimeCardDay): string[] {
  const out: string[] = [];
  if (day.isLate) out.push("Late");
  if (day.lateAfternoon) out.push("Late after lunch");
  if (day.earlyLeave) out.push("Early out");
  if (day.isHalfShift && day.status !== "half_shift") out.push("Half shift");
  if (day.morningPermissionApplied) out.push("Permission (morning)");
  if (day.eveningPermissionApplied) out.push("Permission (evening)");
  if (day.middlePermissionToday) out.push("Permission (mid-day)");
  if (day.isCompensationDay) out.push("Compensation day");
  return out;
}

/** A day the earned salary and the leave check count: the 1st to `throughDay` (Settings' day, kept on the request);
 *  every day when it is not known. */
export const inCountedDays = (day: Pick<TimeCardDay, "date">, throughDay: number | null | undefined): boolean =>
  !throughDay || Number(day.date.slice(8, 10)) <= throughDay;

/** The day the earned salary is counted to, for the settlement's requests (the first one that says it). */
export const settlementThroughDay = (data: PortalData): number | null =>
  data.items.find((i) => i.advance.earnings?.throughDay)?.advance.earnings?.throughDay ??
  data.items.find((i) => i.advance.leaveCheck?.throughDay)?.advance.leaveCheck?.throughDay ??
  null;

/** The month's counts as tiles. */
export function summaryTiles(card: TimeCard): { label: string; value: string }[] {
  const s = card.summary;
  return [
    { label: "Present", value: String(s.present) },
    { label: "Half days", value: String(s.halfShift) },
    { label: "Absent", value: String(s.absent) },
    { label: "On leave", value: String(s.onLeave) },
    { label: "Holidays", value: String(s.holidays) },
    { label: "Late", value: String(s.late) },
    { label: "Shifts earned", value: s.totalShifts },
    { label: "Working days", value: String(s.workingDays) },
  ];
}

export const requestsWord = (n: number): string => plural(n, "request");
