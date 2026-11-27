// The Automation Method's requests as the screens read them (owner 2026-11-27, round 5): what a click on a tracker stage
// or a summary card lists under the tracker, where each request stands now (HR's proposal -> the MD's decision -> HR's
// final -> the auditor's change), the remarks along the way, and the checks of HR's proposal at HR Review. Kept apart from
// the screens so they can be tested on their own; the server decides everything (service.py).

import type {
  SettlementBatch,
  SettlementBatchItem,
  SettlementDecision,
  SettlementRounding,
  SettlementStage,
  SettlementTrackerKey,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import type { ReviewState } from "@/lib/reviewOrder";
import { leaveFlagged } from "../leave";
import { REMARK_MIN, cleanRemark } from "../logic";
import { formatMoney, monthLabel } from "../shared";
import { STAGE_ORDER, auditorChanged, effectiveOf, finalMonthsOf, finalStartText, reached, termEmiOf } from "./logic";
import { baseOf, roundingChanged } from "./rounding";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── What a click lists: a tracker stage or a summary card ───────────────────────

/** The summary cards: every request, the approved / rejected / still open ones, and the ones with a leave flag. */
export const CARD_FILTERS = ["all", "approved", "rejected", "pending", "leave"] as const;
export type CardFilter = (typeof CARD_FILTERS)[number];

/** A tracker stage or a summary card. */
export type FocusKey = SettlementTrackerKey | CardFilter;

const TRACKER_KEYS: readonly SettlementTrackerKey[] = ["received", ...STAGE_ORDER];

/** The focus the address names, or null (nothing opened under the tracker). */
export function parseFocus(raw: string | null | undefined): FocusKey | null {
  const v = (raw ?? "").trim();
  if ((CARD_FILTERS as readonly string[]).includes(v)) return v as CardFilter;
  if ((TRACKER_KEYS as readonly string[]).includes(v)) return v as SettlementTrackerKey;
  return null;
}

export const isCardFilter = (key: FocusKey | null): key is CardFilter =>
  key != null && (CARD_FILTERS as readonly string[]).includes(key);

/** How a request stands in the batch's counts (batch_json's `outcome`): HR's final decision with the auditor's change
 *  once HR decided it, else the MD's decision (pre-filled from HR's proposal until the MD clicks); null = still open. */
export function outcomeOf(item: SettlementBatchItem): SettlementDecision | null {
  return item.final.decision ? effectiveOf(item).decision : item.md.decision;
}

/** The requests a summary card stands for. */
export function filterItems(items: SettlementBatchItem[], filter: CardFilter): SettlementBatchItem[] {
  switch (filter) {
    case "approved":
      return items.filter((i) => outcomeOf(i) === "approved");
    case "rejected":
      return items.filter((i) => outcomeOf(i) === "rejected");
    case "pending":
      return items.filter((i) => outcomeOf(i) === null);
    case "leave":
      return items.filter((i) => leaveFlagged(i.advance.leaveCheck));
    default:
      return items;
  }
}

/** Each card's count (the same as the server's batch counts, from the requests shown). */
export function filterCounts(items: SettlementBatchItem[]): Record<CardFilter, number> {
  return {
    all: items.length,
    approved: filterItems(items, "approved").length,
    rejected: filterItems(items, "rejected").length,
    pending: filterItems(items, "pending").length,
    leave: filterItems(items, "leave").length,
  };
}

export const FILTER_LABEL: Record<CardFilter, string> = {
  all: "All requests",
  approved: "Approved",
  rejected: "Rejected",
  pending: "Pending decision",
  leave: "Leave flags",
};

/** Which details a focus list shows for each request ("md_changes": HR's proposal, the MD's change and HR's answer). */
export type FocusKind = "requests" | "hr" | "md" | "md_changes" | "final" | "auditor" | "bank";

export type FocusView = {
  key: FocusKey;
  title: string;
  /** One line on what the list is. */
  hint: string;
  kind: FocusKind;
  items: SettlementBatchItem[];
  /** What to say when the list is empty. */
  empty: string;
};

/** What a click on a tracker stage or a summary card lists under the tracker: HR Review -> HR's proposals, MD Review ->
 *  the MD's decisions, HR Final Settlement -> the final decisions, Send to Auditor -> the finalized settlement, the
 *  auditor's stages -> the auditor's changes and remarks, Accounts / Completed -> the bank-file rows paid; a card -> its
 *  requests. A stage not reached yet lists nothing and says so. */
export function focusView(batch: SettlementBatch, key: FocusKey): FocusView {
  const items = batch.items;
  if (isCardFilter(key)) {
    const shown = filterItems(items, key);
    return {
      key,
      title: FILTER_LABEL[key],
      hint:
        key === "leave"
          ? "Requests with 3 days of leave (warning) or more (critical) in the days the earned salary counts."
          : key === "pending"
            ? "Requests with no decision yet (HR Review, or the MD still deciding)."
            : key === "all"
              ? `Every request in ${batch.label}.`
              : `As the settlement stands now: the final decision (with the auditor's change) once HR decided, else the MD's.`,
      kind: "requests",
      items: shown,
      empty: key === "leave" ? "No request has a leave flag." : `No ${FILTER_LABEL[key].toLowerCase()} requests.`,
    };
  }
  const not = (stage: Parameters<typeof reached>[1], text: string) => (reached(batch, stage) ? null : text);
  switch (key) {
    case "received":
      return {
        key,
        title: "Requests received",
        hint: `Every request in ${batch.label}, as the employees (or HR for them) asked.`,
        kind: "requests",
        items,
        empty: "No request in this batch yet.",
      };
    case "hr_review":
      return {
        key,
        title: "HR Review: HR's proposals",
        hint: "What HR proposes to the MD on each request (keep it as asked, reduce it or reject it) and HR's remark.",
        kind: "hr",
        items,
        empty: "No request to review.",
      };
    case "md_review": {
      const blocked = not("md_review", "Not forwarded to the MD yet.");
      return {
        key,
        title: "MD Review: the MD's decisions",
        hint: "The MD's decision on each request; a decision still marked “from HR” is HR's proposal the MD has not changed.",
        kind: "md",
        items: blocked ? [] : items,
        empty: blocked ?? "No request in this batch.",
      };
    }
    case "md_changes": {
      const flagged = items.filter(flaggedByMd);
      const returned = batch.stage === "md_changes" || (batch.flow?.mdCycles ?? 0) > 0 || flagged.length > 0;
      return {
        key,
        title: "HR Rework (MD Changes): the requests the MD flagged",
        hint: "Each request the MD changed (another amount, a rejection) or wrote a correction on, the MD's remark, and your answer: accept the MD's decision, keep yours or change it.",
        kind: "md_changes",
        items: returned ? flagged : [],
        empty: returned
          ? "The MD flagged no request: only their note for the whole batch."
          : reached(batch, "hr_final")
            ? "The MD approved it without returning it to HR: no rework was needed."
            : "The MD has not returned this batch to HR.",
      };
    }
    case "hr_final": {
      const blocked = not("hr_final", "The MD has not confirmed the decisions yet.");
      return {
        key,
        title:
          batch.finalizedVia === "md"
            ? "Final settlement (finalized by the MD)"
            : "HR Final Settlement: the final decisions",
        hint:
          batch.finalizedVia === "md"
            ? "Finalized directly by the MD (Direct to Auditor): the MD's decisions are the final settlement; HR Final Settlement was skipped."
            : "HR's final decision on each request, within the MD's, and what changed from the MD.",
        kind: "final",
        items: blocked ? [] : items,
        empty: blocked ?? "No request in this batch.",
      };
    }
    case "auditor_send": {
      const blocked = not("auditor_send", "The settlement is not finalized yet.");
      return {
        key,
        title: "Send to Auditor: the finalized settlement",
        hint: batch.auditor.sentAt
          ? `Sent to ${batch.auditor.recipients.join(", ") || "the auditor"}: every request with its final decision.`
          : "What the auditor will receive: every request with its final decision.",
        kind: "final",
        items: blocked ? [] : items,
        empty: blocked ?? "No request in this batch.",
      };
    }
    case "auditor_review":
    case "auditor_changes": {
      const rework = key === "auditor_changes";
      // the auditor's changes stay on the requests until HR resubmits; a later round keeps them in the request's trail
      const returned = batch.stage === "auditor_changes" || (batch.flow?.auditorCycles ?? 0) > 0;
      const blocked = rework
        ? returned
          ? null
          : reached(batch, "accounts_send")
            ? "The auditor approved it without returning it to HR: no rework was needed."
            : "The auditor has not returned this batch to HR."
        : not("auditor_review", "Not sent to the auditor yet.");
      const answered = !!batch.auditor.submittedAt || batch.stage === "auditor_changes";
      const changed = items.filter(
        (i) =>
          auditorChanged(i) ||
          !!(i.auditor?.remark ?? "").trim() ||
          (rework && (i.rework === "auditor" || (i.trail ?? []).some((t) => t.role === "auditor"))),
      );
      return {
        key,
        title: rework
          ? "HR Rework (Auditor Changes): the requests the auditor flagged"
          : "Auditor Review: the auditor's changes",
        hint: rework
          ? "Each request the auditor reduced, rejected or wrote a correction on, and your answer: accept the auditor's change, keep your settlement or change it."
          : "Every request the auditor reduced, rejected or wrote a remark on, and what is paid after it.",
        kind: "auditor",
        items: blocked ? [] : changed,
        empty:
          blocked ??
          (answered ? "The auditor changed nothing and left no remark." : "The auditor has not answered yet."),
      };
    }
    case "accounts_send":
    case "completed": {
      const blocked = not("accounts_send", "The audit is not through yet: no bank file.");
      const paid = items.filter((i) => effectiveOf(i).decision === "approved");
      return {
        key,
        title: key === "completed" ? "Completed: the requests paid" : "Bank file for Accounts: the rows paid",
        hint: batch.accounts.sentAt
          ? `The bank file went to ${batch.accounts.recipients.join(", ") || "Accounts"}: each approved request at the amount paid (rounded up to the rupee).`
          : "The bank file pays each approved request at the amount paid (after the auditor's changes, rounded up to the rupee).",
        kind: "bank",
        items: blocked ? [] : paid,
        empty: blocked ?? "Nothing was approved: no bank file.",
      };
    }
    default:
      return { key, title: "", hint: "", kind: "requests", items, empty: "" };
  }
}

// ─── Where a request stands now ──────────────────────────────────────────────────

export type StandingSource = "asked" | "hr" | "md" | "final" | "auditor";

export type Standing = {
  /** null: no decision yet (HR Review keeps it as asked, or nothing decided). */
  decision: SettlementDecision | null;
  /** The approved amount as it stands (null when rejected or undecided). */
  amount: number | null;
  source: StandingSource;
  /** "after the audit", "final", "MD", "HR proposes", "as asked". */
  label: string;
};

/** HR's proposal as a standing: reduced, rejected, or as asked (kept as asked, or not reviewed yet: the same amount; a
 *  Salary Advance's "as asked" is its rounded amount, 2026-11-27). */
function hrStanding(item: SettlementBatchItem, label: string): Standing {
  const hr = item.hr;
  if (hr?.action === "reject") return { decision: "rejected", amount: null, source: "hr", label };
  if (hr?.action === "reduce") return { decision: "approved", amount: hr.amount, source: "hr", label };
  return { decision: null, amount: baseOf(item), source: "asked", label: "as asked" };
}

/** The amount a request stands at now: after the auditor's change, else HR's final, else the MD's (pre-filled from
 *  HR), else HR's proposal at HR Review; as asked when HR keeps it. In a rework stage (2026-11-27) it is what HR sends
 *  back to the reviewer: HR's proposal in HR Rework (MD Changes), HR's final settlement in HR Rework (Auditor Changes);
 *  the reviewer's change is in the Status column beside it. */
export function standingOf(item: SettlementBatchItem, stage?: SettlementStage): Standing {
  if (stage === "md_changes") {
    // as asked (kept, or not reviewed) goes back as a full approval
    const s = hrStanding(item, "HR's proposal");
    return s.source === "asked" ? { ...s, decision: "approved", label: "HR's proposal" } : s;
  }
  if (stage === "auditor_changes" && item.final.decision) {
    return {
      decision: item.final.decision,
      amount: item.final.decision === "approved" ? item.final.amount : null,
      source: "final",
      label: "HR's final",
    };
  }
  if (item.final.decision) {
    const eff = effectiveOf(item);
    const audited = auditorChanged(item);
    return {
      decision: eff.decision,
      amount: eff.decision === "approved" ? (eff.amount ?? item.final.amount) : null,
      source: audited ? "auditor" : "final",
      label: audited ? "after the audit" : "final",
    };
  }
  if (item.md.decision) {
    return {
      decision: item.md.decision,
      amount: item.md.decision === "approved" ? item.md.amount : null,
      source: "md",
      label: item.md.fromHr ? "HR's proposal (MD to confirm)" : "MD",
    };
  }
  const hr = item.hr;
  if (hr?.action === "reject" || hr?.action === "reduce") return hrStanding(item, "HR proposes");
  return { decision: null, amount: baseOf(item), source: "asked", label: "as asked" };
}

/** HR's proposal in words: "Keep as asked", "Proposes ₹6,000", "Proposes reject"; at HR Review a request HR has not
 *  looked at yet is "Not reviewed yet" (2026-11-27: kept as asked is a review of its own; it goes to the MD as asked
 *  either way). A Salary Advance kept as asked keeps its rounded amount (2026-11-27): "Kept · rounded ₹11,500" (`short`:
 *  "Kept · rounded", where the amount stands beside it). */
export function hrProposalText(item: SettlementBatchItem, stage?: SettlementStage, short = false): string {
  const hr = item.hr;
  if (hr?.action === "reject") return "Proposes reject";
  if (hr?.action === "reduce") return `Proposes ${formatMoney(hr.amount)}`;
  if (!hr?.action && stage === "hr_review") return "Not reviewed yet";
  if (roundingChanged(item.rounding)) return short ? "Kept · rounded" : `Kept · rounded ${formatMoney(baseOf(item))}`;
  return "Keep as asked";
}

export type TrailStep = {
  step: "hr" | "md" | "final" | "auditor";
  /** "HR", "MD", "Final", "Auditor". */
  who: string;
  text: string;
  tone: "success" | "danger" | "warning" | "neutral" | "info";
  /** "from HR", "by the MD", "pays ₹5,000". */
  note?: string;
};

/** The decisions on a request so far, one per stage reached: HR's proposal, the MD's decision (marked when it is still
 *  HR's pre-filled proposal), HR's final decision (by the MD with Direct to Auditor) and the auditor's change. */
export function trailOf(
  item: SettlementBatchItem,
  batch: Pick<SettlementBatch, "stage" | "finalizedVia">,
): TrailStep[] {
  const out: TrailStep[] = [];
  const hr = item.hr;
  const notYet = !hr?.action && batch.stage === "hr_review";
  out.push({
    step: "hr",
    who: "HR",
    text: hrProposalText(item, batch.stage, true),
    tone: hr?.action === "reject" ? "danger" : hr?.action === "reduce" || notYet ? "warning" : "neutral",
  });
  if (reached(batch, "md_review")) {
    const md = item.md;
    out.push({
      step: "md",
      who: "MD",
      text:
        md.decision === "approved"
          ? `Approved ${formatMoney(md.amount)}`
          : md.decision === "rejected"
            ? "Rejected"
            : "Waiting",
      tone: md.decision === "approved" ? "success" : md.decision === "rejected" ? "danger" : "warning",
      note: md.decision && md.fromHr ? "from HR" : undefined,
    });
  }
  if (reached(batch, "hr_final")) {
    const f = item.final;
    out.push({
      step: "final",
      who: "Final",
      text:
        f.decision === "approved"
          ? `Approved ${formatMoney(f.amount)}`
          : f.decision === "rejected"
            ? "Rejected"
            : "Not decided",
      tone: f.decision === "approved" ? "success" : f.decision === "rejected" ? "danger" : "warning",
      note: batch.finalizedVia === "md" ? "by the MD" : undefined,
    });
  }
  if (reached(batch, "auditor_review")) {
    const a = item.auditor;
    const eff = effectiveOf(item);
    out.push({
      step: "auditor",
      who: "Auditor",
      text:
        a?.action === "reduce"
          ? `Reduced to ${formatMoney(a.amount)}`
          : a?.action === "reject"
            ? "Rejected by the auditor"
            : "No change",
      tone: a?.action === "reduce" ? "warning" : a?.action === "reject" ? "danger" : "neutral",
      // in HR's rework the change is a question to HR, not yet what is paid (HR may keep its own settlement)
      note:
        auditorChanged(item) && batch.stage !== "auditor_changes"
          ? `pays ${eff.decision === "approved" ? formatMoney(eff.amount) : "nothing"}`
          : undefined,
    });
  }
  return out;
}

// ─── The rework rounds (2026-11-27): where a request stands with the stage's reviewer, and HR's answers ──────────

/** Where a request stands with the reviewer of the batch's current stage (service.review_state): the server sends it as
 *  `review`; this works it out the same way for an older server that does not. */
export function reviewStateOf(item: SettlementBatchItem, stage: SettlementStage): ReviewState {
  if (item.review) return item.review;
  const as = (decision: SettlementDecision | null | undefined): ReviewState =>
    decision === "rejected" ? "rejected" : decision === "approved" ? "approved" : "pending";
  switch (stage) {
    case "hr_review":
      return !item.hr?.action ? "pending" : item.hr.action === "reject" ? "rejected" : "approved";
    case "md_review":
      return !item.md.decision || !item.md.decidedAt ? "pending" : as(item.md.decision);
    case "md_changes":
      return item.rework ? "pending" : item.hr?.action === "reject" ? "rejected" : "approved";
    case "hr_final":
    case "auditor_changes":
      return item.rework || !item.final.decision ? "pending" : as(item.final.decision);
    case "auditor_review":
      if (item.final.decision === "rejected" || item.auditor?.action === "reject") return "rejected";
      return item.auditor?.action === "approve" || item.auditor?.action === "reduce" ? "approved" : "pending";
    default:
      return as(effectiveOf(item).decision);
  }
}

/** The heading of the waiting group of a stage's list (the approved and rejected groups are named alike everywhere). */
export function pendingGroupLabel(stage: SettlementStage): string {
  switch (stage) {
    case "hr_review":
      return "Waiting for your review";
    case "md_review":
      return "Waiting for the MD";
    case "md_changes":
      return "Waiting for your answer to the MD";
    case "hr_final":
      return "Waiting for your final decision";
    case "auditor_review":
      return "Waiting for the auditor";
    case "auditor_changes":
      return "Waiting for your answer to the auditor";
    default:
      return "Not decided";
  }
}

/** The MD's own decision differs from HR's proposal (service.md_changed; the server sends it as `mdChanged`). */
export function mdDiffers(item: SettlementBatchItem): boolean {
  if (typeof item.mdChanged === "boolean") return item.mdChanged;
  const md = item.md;
  if (!md.decision || !md.decidedAt) return false;
  const hr = item.hr;
  const expected: SettlementDecision = hr?.action === "reject" ? "rejected" : "approved";
  if (md.decision !== expected) return true;
  if (expected === "rejected") return false;
  const amount = hr?.action === "reduce" && hr.amount != null ? hr.amount : baseOf(item);
  return round2(md.amount ?? 0) !== round2(amount);
}

const oneSpace = (text: string) => text.trim().split(/\s+/).join(" ");

/** The MD's own remark on the request (not HR's carried over): a correction for HR; "" when none. */
export function mdRemarkOf(item: SettlementBatchItem): string {
  const mine = oneSpace(item.md.remark ?? "");
  if (!mine || !item.md.decidedAt) return "";
  if (typeof item.mdRemarked === "boolean") return item.mdRemarked || mdDiffers(item) ? mine : "";
  return mine === oneSpace(item.hrNote ?? "") ? "" : mine;
}

/** The MD flagged the request in some round (a change or their own remark), or it waits for HR's answer to the MD. */
export function flaggedByMd(item: SettlementBatchItem): boolean {
  return item.rework === "md" || (item.trail ?? []).some((t) => t.role === "md");
}

/** HR's answer on a request: waiting (flagged and not answered), "accepted" (the reviewer's decision is HR's now),
 *  "kept" (HR stands by its own, which still differs) or null (nothing to answer). */
export type ReworkAnswer = "waiting" | "accepted" | "kept" | null;

/** HR's answer to the MD (HR Rework (MD Changes)). */
export function mdAnswerOf(item: SettlementBatchItem): ReworkAnswer {
  if (item.rework === "md") return "waiting";
  if (!item.md.decision || !item.md.decidedAt || item.md.fromHr) return null;
  if (mdDiffers(item)) return "kept";
  return mdRemarkOf(item) ? "accepted" : null;
}

/** HR's answer to the auditor (HR Rework (Auditor Changes)). */
export function auditorAnswerOf(item: SettlementBatchItem): ReworkAnswer {
  if (item.rework === "auditor") return "waiting";
  const a = item.auditor;
  if (!auditorChanged(item)) return (a?.remark ?? "").trim() && item.final.decision ? "accepted" : null;
  if (a.action === "reject") return item.final.decision === "rejected" ? "accepted" : "kept";
  return item.final.decision === "approved" && round2(item.final.amount ?? 0) === round2(a.amount ?? 0)
    ? "accepted"
    : "kept";
}

/** The answer in words, for the row and the focus list. */
export function answerText(answer: ReworkAnswer, who: "md" | "auditor"): string {
  if (answer === "waiting") return "Waiting for your answer";
  if (answer === "accepted")
    return who === "md" ? "You accepted the MD's decision" : "You accepted the auditor's change";
  if (answer === "kept") return who === "md" ? "You kept your proposal" : "You kept your settlement";
  return "";
}

/** What the reviewer flagged on a request, as the pill on its row: "MD changed this" / "MD's remark"; null when it does
 *  not wait for HR's answer. A request HR reopened itself (Rework) is "Reopened". */
export function reworkFlag(
  item: SettlementBatchItem,
  stage: SettlementStage,
): { text: string; tone: "caution" | "info" | "accent" } | null {
  if (stage === "md_changes" && item.rework === "md") {
    if (mdDiffers(item)) return { text: "MD changed this", tone: "caution" };
    if (mdRemarkOf(item)) return { text: "MD's remark", tone: "info" };
    return { text: "Reopened", tone: "accent" };
  }
  if (stage === "auditor_changes" && item.rework === "auditor") {
    if (auditorChanged(item)) return { text: "Auditor changed this", tone: "caution" };
    if ((item.auditor?.remark ?? "").trim()) return { text: "Auditor's remark", tone: "info" };
    return { text: "Reopened", tone: "accent" };
  }
  return null;
}

/** In a rework stage: how many requests still wait for HR's answer, and how many the reviewer flagged (with the ones HR
 *  reopened itself). */
export function reworkProgress(batch: Pick<SettlementBatch, "items" | "stage" | "counts">): {
  waiting: number;
  flagged: number;
} {
  const md = batch.stage === "md_changes";
  const waiting = batch.counts.rework ?? batch.items.filter((i) => i.rework === (md ? "md" : "auditor")).length;
  const flagged = batch.items.filter((i) =>
    md ? !!mdAnswerOf(i) : auditorChanged(i) || !!(i.auditor?.remark ?? "").trim() || i.rework === "auditor",
  ).length;
  return { waiting, flagged: Math.max(flagged, waiting) };
}

export type RemarkLine = { who: "HR" | "MD" | "Final" | "Auditor"; text: string };

/** Every remark on a request, in the order they were written (HR's, the MD's, HR's final, the auditor's). */
export function remarksOf(item: SettlementBatchItem): RemarkLine[] {
  const lines: RemarkLine[] = [
    { who: "HR", text: item.hrNote ?? item.hr?.remark ?? "" },
    { who: "MD", text: item.md.remark ?? "" },
    { who: "Final", text: item.final.remark ?? "" },
    { who: "Auditor", text: item.auditor?.remark ?? "" },
  ];
  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
}

// ─── A Term Loan's figures in the table ──────────────────────────────────────────

/** A Term Loan's months, monthly EMI and first EMI month as they stand (the final decision's once HR decided it, the
 *  request's own before). */
export function termFiguresOf(item: SettlementBatchItem): { months: number | null; emi: number | null; first: string } {
  const a = item.advance;
  const months = finalMonthsOf(item);
  const s = standingOf(item);
  if (s.decision === "rejected") return { months, emi: null, first: "" };
  // as asked: the request's own EMI; once an amount is proposed or decided: the EMI of that amount (the loan's own rule)
  const emi =
    s.source === "asked" && a.emiAmount > 0 ? a.emiAmount : termEmiOf(item, s.amount ?? item.requestedAmount, months);
  const first =
    finalStartText(item) ||
    (a.repaymentStartMonth && a.repaymentStartYear ? monthLabel(a.repaymentStartMonth, a.repaymentStartYear) : "");
  return { months, emi: emi > 0 ? emi : null, first };
}

// ─── The Requests table: one value per column ────────────────────────────────────

export type RequestColumnKey =
  | "select"
  | "employee"
  | "requested"
  | "fixedSalary"
  | "workingDays"
  | "earned"
  | "limit"
  | "rounded"
  | "months"
  | "emi"
  | "firstEmi"
  | "approved"
  | "leave"
  | "decision"
  | "remarks"
  | "actions";

export type RequestColumn = {
  key: RequestColumnKey;
  header: string;
  align: "left" | "right" | "center";
  /** Shown only from this screen width on (as All Employees hides Phone and Salary on a laptop), so the table fits its
   *  card without a sideways scroll; a phone has the cards, which show every value. "xl2": 1400 px, "wide": 1800 px,
   *  "full": 1880 px. */
  from?: "xl" | "xl2" | "2xl" | "wide" | "full";
};

const COLUMN: Record<RequestColumnKey, RequestColumn> = {
  select: { key: "select", header: "", align: "center" },
  employee: { key: "employee", header: "Employee", align: "left" },
  requested: { key: "requested", header: "Requested", align: "right" },
  fixedSalary: { key: "fixedSalary", header: "Fixed salary", align: "right", from: "2xl" },
  workingDays: { key: "workingDays", header: "Working days", align: "right", from: "2xl" },
  earned: { key: "earned", header: "Earned", align: "right", from: "xl" },
  limit: { key: "limit", header: "Eligible limit", align: "right" },
  // the Salary Advance rounding (2026-11-27): its own column on a full-HD screen; below that the rounded amount is a line
  // under the amount asked for (measured: the column does not fit beside the rest of the row on a laptop)
  rounded: { key: "rounded", header: "Rounded", align: "right", from: "full" },
  months: { key: "months", header: "Months", align: "right", from: "xl" },
  emi: { key: "emi", header: "Monthly EMI", align: "right", from: "xl" },
  firstEmi: { key: "firstEmi", header: "First EMI", align: "left", from: "2xl" },
  approved: { key: "approved", header: "Approved", align: "right" },
  leave: { key: "leave", header: "Leave", align: "center" },
  decision: { key: "decision", header: "Status", align: "left" },
  remarks: { key: "remarks", header: "Remarks", align: "left", from: "wide" },
  actions: { key: "actions", header: "Actions", align: "right" },
};

/** The table's columns, in order (owner 2026-11-27: every value under its own heading, numbers right-aligned), in the
 *  order of the owner's own report (fixed salary, working days, earned, requested, limit, approved): a Salary Advance
 *  shows the earned figures (and, once its requests carry the rounding, the rounded amount after the limit), a Term
 *  Loan its months, EMI and first EMI after the approved amount they follow; the checkbox and the actions only when this
 *  login may act at the stage. */
export function requestColumns(
  type: SettlementBatch["advanceType"],
  opts: { select: boolean; actions: boolean; rounding?: boolean },
): RequestColumn[] {
  const figures: RequestColumnKey[] =
    type === "term"
      ? ["fixedSalary", "requested", "limit", "approved", "months", "emi", "firstEmi"]
      : [
          "fixedSalary",
          "workingDays",
          "earned",
          "requested",
          "limit",
          ...(opts.rounding ? (["rounded"] as const) : []),
          "approved",
        ];
  const keys: RequestColumnKey[] = [
    ...(opts.select ? (["select"] as const) : []),
    "employee",
    ...figures,
    "leave",
    "decision",
    "remarks",
    ...(opts.actions ? (["actions"] as const) : []),
  ];
  // with the row actions (up to five icons since Rework, 2026-11-27) the xl columns show from 1400 px on, so the table
  // stays inside its card on a 1280 px laptop
  return keys.map((k) => (opts.actions && COLUMN[k].from === "xl" ? { ...COLUMN[k], from: "xl2" } : COLUMN[k]));
}

export type RequestFigures = {
  fixedSalary: number | null;
  workingDays: number | null;
  earned: number | null;
  /** The eligible limit: a Salary Advance's earned limit (earnings.limit), a Term Loan's limit (termLimit). */
  limit: number | null;
  /** Asked for more than the eligible limit. */
  overLimit: boolean;
  /** A Salary Advance's rounding (null: a Term Loan, an older batch). */
  rounding: SettlementRounding | null;
  months: number | null;
  emi: number | null;
  firstEmi: string;
  standing: Standing;
};

/** Every figure of a request's row (`stage`: a rework stage shows what HR sends back, see standingOf). */
export function requestFigures(item: SettlementBatchItem, stage?: SettlementStage): RequestFigures {
  const a = item.advance;
  const e = a.earnings ?? null;
  const term = a.advanceType === "term";
  const limit = term ? (a.termLimit ?? null) : (e?.limit ?? null);
  const t = term ? termFiguresOf(item) : { months: null, emi: null, first: "" };
  return {
    fixedSalary: term ? (a.salaryAtRequest ?? e?.fixedSalary ?? null) : (e?.fixedSalary ?? a.salaryAtRequest ?? null),
    workingDays: term ? null : (e?.workingDays ?? null),
    earned: term ? null : (e?.earnedAmount ?? null),
    limit,
    overLimit: limit != null && item.requestedAmount > limit,
    rounding: term ? null : (item.rounding ?? null),
    months: t.months,
    emi: t.emi,
    firstEmi: t.first,
    standing: standingOf(item, stage),
  };
}

// ─── HR Review: HR's proposal on one request ─────────────────────────────────────

export type HrProposalEdit = { action: "reduce" | "reject"; amount: string; remark: string };

const num = (text: string): number => (text.trim() === "" ? NaN : Number(text.replace(/,/g, "").trim()));

/** The most a reduced amount may be, in words: "less than the rounded ₹11,500" (a Salary Advance, 2026-11-27), else
 *  "less than the ₹8,000 asked for". */
export function reduceCeilingText(item: SettlementBatchItem): string {
  return item.rounding
    ? `less than the rounded ${formatMoney(baseOf(item))}`
    : `less than the ${formatMoney(baseOf(item))} asked for`;
}

/** What stops HR's proposal from being kept (the server's own checks: service.set_hr_review). */
export function hrProposalProblems(
  item: SettlementBatchItem,
  edit: HrProposalEdit,
): Partial<Record<"amount" | "remark", string>> {
  const out: Partial<Record<"amount" | "remark", string>> = {};
  if (edit.action === "reduce") {
    const text = edit.amount.trim();
    const amount = num(text);
    if (text === "") out.amount = "Enter the reduced amount.";
    else if (!Number.isFinite(amount) || amount <= 0) out.amount = "The amount must be more than ₹0.";
    else if (/\.\d{3,}$/.test(text)) out.amount = "Use at most 2 decimal places.";
    else if (round2(amount) >= round2(baseOf(item)))
      out.amount = `A reduced amount must be ${reduceCeilingText(item)}.`;
  }
  if (cleanRemark(edit.remark).length < REMARK_MIN)
    out.remark =
      edit.action === "reduce"
        ? "Write a remark for the reduced amount (at least 3 characters)."
        : "Write the reason for rejecting (at least 3 characters).";
  return out;
}

/** The PATCH body of HR's proposal. */
export const hrProposalPayload = (edit: HrProposalEdit) =>
  edit.action === "reduce"
    ? { hrNote: cleanRemark(edit.remark), action: "reduce" as const, amount: round2(num(edit.amount)) }
    : { hrNote: cleanRemark(edit.remark), action: "reject" as const };

// ─── The Requests tab: search and the filter ─────────────────────────────────────

/** The requests the Requests tab shows: the filter (a summary card's), then the words typed (name, code, department). */
export function requestsShown(items: SettlementBatchItem[], filter: CardFilter, search: string): SettlementBatchItem[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return filterItems(items, filter).filter((i) => {
    if (words.length === 0) return true;
    const a = i.advance;
    const hay = [a.employeeName, a.employeeCode, a.employeeDepartment ?? "", a.purpose ?? ""].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "3 requests". */
export const countText = (n: number): string => `${n} ${n === 1 ? "request" : "requests"}`;

/** The names of the requests a bulk step left out, with why ("Ravi Shankar: The MD rejected it."). */
export function skippedText(batch: Pick<SettlementBatch, "items">, skipped: { id: number; reason: string }[]): string {
  return skipped
    .map((s) => `${batch.items.find((i) => i.id === s.id)?.advance.employeeName ?? `Request ${s.id}`}: ${s.reason}`)
    .join(" ");
}
