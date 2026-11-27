// The Automation Method's requests as the screens read them (owner 2026-11-27, round 5): what a click on a tracker stage
// or a summary card lists under the tracker, where each request stands now (HR's proposal -> the MD's decision -> HR's
// final -> the auditor's change), the remarks along the way, and the checks of HR's proposal at HR Review. Kept apart from
// the screens so they can be tested on their own; the server decides everything (service.py).

import type {
  SettlementBatch,
  SettlementBatchItem,
  SettlementDecision,
  SettlementTrackerKey,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { leaveFlagged } from "../leave";
import { REMARK_MIN, cleanRemark } from "../logic";
import { formatMoney, monthLabel } from "../shared";
import { STAGE_ORDER, auditorChanged, effectiveOf, finalMonthsOf, finalStartText, reached, termEmiOf } from "./logic";

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

/** Which details a focus list shows for each request. */
export type FocusKind = "requests" | "hr" | "md" | "final" | "auditor" | "bank";

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
      const blocked = not("auditor_review", "Not sent to the auditor yet.");
      const answered = !!batch.auditor.submittedAt || reached(batch, "auditor_changes");
      const changed = items.filter((i) => auditorChanged(i) || !!(i.auditor?.remark ?? "").trim());
      return {
        key,
        title: key === "auditor_changes" ? "HR Review of Auditor Changes" : "Auditor Review: the auditor's changes",
        hint: "Every request the auditor reduced, rejected or wrote a remark on, and what is paid after it.",
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

/** The amount a request stands at now: after the auditor's change, else HR's final, else the MD's (pre-filled from
 *  HR), else HR's proposal at HR Review; as asked when HR keeps it. */
export function standingOf(item: SettlementBatchItem): Standing {
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
  if (hr?.action === "reject") return { decision: "rejected", amount: null, source: "hr", label: "HR proposes" };
  if (hr?.action === "reduce") return { decision: "approved", amount: hr.amount, source: "hr", label: "HR proposes" };
  return { decision: null, amount: item.requestedAmount, source: "asked", label: "as asked" };
}

/** HR's proposal in words: "Keep as asked", "Proposes ₹6,000", "Proposes reject". */
export function hrProposalText(item: SettlementBatchItem): string {
  const hr = item.hr;
  if (hr?.action === "reject") return "Proposes reject";
  if (hr?.action === "reduce") return `Proposes ${formatMoney(hr.amount)}`;
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
  out.push({
    step: "hr",
    who: "HR",
    text: hrProposalText(item),
    tone: hr?.action === "reject" ? "danger" : hr?.action === "reduce" ? "warning" : "neutral",
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
      note: auditorChanged(item)
        ? `pays ${eff.decision === "approved" ? formatMoney(eff.amount) : "nothing"}`
        : undefined,
    });
  }
  return out;
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
   *  card without a sideways scroll; a phone has the cards, which show every value. */
  from?: "xl" | "2xl" | "wide";
};

const COLUMN: Record<RequestColumnKey, RequestColumn> = {
  select: { key: "select", header: "", align: "center" },
  employee: { key: "employee", header: "Employee", align: "left" },
  requested: { key: "requested", header: "Requested", align: "right" },
  fixedSalary: { key: "fixedSalary", header: "Fixed salary", align: "right", from: "2xl" },
  workingDays: { key: "workingDays", header: "Working days", align: "right", from: "2xl" },
  earned: { key: "earned", header: "Earned", align: "right", from: "xl" },
  limit: { key: "limit", header: "Eligible limit", align: "right" },
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
 *  shows the earned figures, a Term Loan its months, EMI and first EMI after the approved amount they follow; the
 *  checkbox and the actions only when this login may act at the stage. */
export function requestColumns(
  type: SettlementBatch["advanceType"],
  opts: { select: boolean; actions: boolean },
): RequestColumn[] {
  const figures: RequestColumnKey[] =
    type === "term"
      ? ["fixedSalary", "requested", "limit", "approved", "months", "emi", "firstEmi"]
      : ["fixedSalary", "workingDays", "earned", "requested", "limit", "approved"];
  const keys: RequestColumnKey[] = [
    ...(opts.select ? (["select"] as const) : []),
    "employee",
    ...figures,
    "leave",
    "decision",
    "remarks",
    ...(opts.actions ? (["actions"] as const) : []),
  ];
  return keys.map((k) => COLUMN[k]);
}

export type RequestFigures = {
  fixedSalary: number | null;
  workingDays: number | null;
  earned: number | null;
  /** The eligible limit: a Salary Advance's earned limit (earnings.limit), a Term Loan's limit (termLimit). */
  limit: number | null;
  /** Asked for more than the eligible limit. */
  overLimit: boolean;
  months: number | null;
  emi: number | null;
  firstEmi: string;
  standing: Standing;
};

/** Every figure of a request's row. */
export function requestFigures(item: SettlementBatchItem): RequestFigures {
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
    months: t.months,
    emi: t.emi,
    firstEmi: t.first,
    standing: standingOf(item),
  };
}

// ─── HR Review: HR's proposal on one request ─────────────────────────────────────

export type HrProposalEdit = { action: "reduce" | "reject"; amount: string; remark: string };

const num = (text: string): number => (text.trim() === "" ? NaN : Number(text.replace(/,/g, "").trim()));

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
    else if (round2(amount) >= round2(item.requestedAmount))
      out.amount = `A reduced amount must be less than the ${formatMoney(item.requestedAmount)} asked for.`;
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
