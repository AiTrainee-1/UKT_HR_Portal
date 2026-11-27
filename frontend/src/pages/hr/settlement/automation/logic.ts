// The Loan & Advance Automation Method (owner 2026-11-26; the Settlement page renamed 2026-11-27) on the HRMS side: the
// rules behind the month-wise workflow pages (one per type: Salary Advance and Term Loan run their own workflows), kept
// apart from the screens so they can be tested on their own. The server decides every step (service.py); this mirrors
// its checks only to tell HR before a click is refused, and builds the files the page sends (the finalized report for
// the auditor in the Loan & Advance report's own format, the bank file in the Payroll bank-file format).

import type { BankFileLine } from "@/lib/bankFile";
import type {
  SettlementAuditorDecision,
  SettlementBatch,
  SettlementBatchItem,
  SettlementEffective,
  SettlementFinalInput,
  SettlementHistoryEntry,
  SettlementMonth,
  SettlementStage,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { LOAN_ADVANCE_TITLE } from "../routes";
import {
  DEFAULT_COLUMN_KEYS,
  REMARK_MIN,
  TYPE_LABEL,
  approvalEmi,
  termExportSummary,
  bankFileLines,
  cleanRemark,
  currentPeriod,
  exportColumns,
  exportSummary,
  missingBankDetails,
  serverError,
  type ExportCell,
  type ExportColumn,
  type SettlementExport,
  type SettlementRow,
} from "../logic";
import { MONTH_FULL, formatDateTime, formatMoney, monthLabel } from "../shared";
import { roundUpRupee } from "@/lib/round-up-rupee";

const round2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ─── Stages ─────────────────────────────────────────────────────────────────────

export const STAGE_ORDER: readonly SettlementStage[] = [
  "hr_review",
  "md_review",
  // the MD's rework loop (2026-11-27): after the MD's review, before HR Final Settlement
  "md_changes",
  "hr_final",
  "auditor_send",
  "auditor_review",
  "auditor_changes",
  "accounts_send",
  "completed",
];

/** 0 for HR Review ... 8 for Completed. */
export const stageIndex = (stage: SettlementStage): number => STAGE_ORDER.indexOf(stage);

/** The batch has reached `stage` (or gone past it). */
export const reached = (batch: Pick<SettlementBatch, "stage">, stage: SettlementStage): boolean =>
  stageIndex(batch.stage) >= stageIndex(stage);

/** The heading of the "what to do now" card for a stage. */
export const STAGE_TITLE: Record<SettlementStage, string> = {
  hr_review: "HR Review",
  md_review: "Waiting for the MD",
  md_changes: "HR Rework (MD Changes)",
  hr_final: "HR Final Settlement",
  auditor_send: "Send to Auditor",
  auditor_review: "Waiting for the Auditor's Review",
  auditor_changes: "HR Rework (Auditor Changes)",
  accounts_send: "Send Bank File to Accounts",
  completed: "Settlement Workflow Completed",
};

// ─── The month and the batch shown ──────────────────────────────────────────────

export type MonthRef = { month: number; year: number };

/** The month from the address; "" (or anything unusable) is this month in India. */
export function monthFromUrl(month: string, year: string, now = new Date()): MonthRef {
  const current = currentPeriod(now);
  const m = Number(month);
  const y = Number(year);
  if (!month || !Number.isInteger(m) || m < 1 || m > 12) return current;
  return { month: m, year: year && Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : current.year };
}

/** The address values of a month: "" for this month (a clean address). */
export function monthToUrl(p: MonthRef, now = new Date()): { month: string; year: string } {
  const current = currentPeriod(now);
  return p.month === current.month && p.year === current.year
    ? { month: "", year: "" }
    : { month: String(p.month), year: String(p.year) };
}

export const shiftMonth = (p: MonthRef, delta: number): MonthRef => {
  const index = p.year * 12 + (p.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

/** Later than this month in India: nothing can have been raised in it yet. */
export const isFutureMonth = (p: MonthRef, now = new Date()): boolean => {
  const c = currentPeriod(now);
  return p.year * 12 + p.month > c.year * 12 + c.month;
};

export const monthText = (p: MonthRef): string => `${MONTH_FULL[p.month - 1] ?? "?"} ${p.year}`;

/** The batch to show: the one the address names (when the month has it), else the month's current one, else the last. */
export function pickBatch(month: SettlementMonth | undefined, asked: string): SettlementBatch | null {
  if (!month || month.batches.length === 0) return null;
  const id = Number(asked);
  return (
    (asked ? month.batches.find((b) => b.id === id) : undefined) ??
    month.batches.find((b) => b.id === month.currentBatchId) ??
    month.batches[month.batches.length - 1]
  );
}

// ─── HR Final Settlement: one request's final decision, within the MD's ─────────

export type FinalEdit = {
  decision: "approved" | "rejected";
  amount: string;
  startMonth: number;
  startYear: number;
  remark: string;
  /** A Term Loan's repayment months ("" for a Salary Advance). */
  months: string;
};

/** The editor's starting values: the final decision as it stands (it starts as the MD's), the first deduction month of
 *  the request (next month when it has none). */
export function finalDefaults(item: SettlementBatchItem, now = new Date()): FinalEdit {
  const decision = item.final.decision ?? item.md.decision ?? "rejected";
  const amount = item.final.amount ?? item.md.amount ?? null;
  const fallback = shiftMonth(currentPeriod(now), 1);
  return {
    decision: item.md.decision === "approved" ? decision : "rejected",
    amount: amount != null ? String(amount) : "",
    startMonth: item.final.startMonth ?? item.advance.repaymentStartMonth ?? fallback.month,
    startYear: item.final.startYear ?? item.advance.repaymentStartYear ?? fallback.year,
    remark: item.final.remark ?? "",
    months: item.advance.advanceType === "term" ? String(item.final.months ?? item.advance.repaymentMonths ?? "") : "",
  };
}

/** A Term Loan's months as the final decision has them (the request's own until HR changes them). */
export const finalMonthsOf = (item: SettlementBatchItem): number | null =>
  item.final.months ?? item.advance.repaymentMonths ?? null;

/** The monthly EMI of a Term Loan for an amount over months, by the loan's own rule (whole rupees, the last smaller, for
 *  a request raised under the employee rules; to the paisa for an older one HR recorded). */
export function termEmiOf(item: SettlementBatchItem, amount: number, months: number | null): number {
  if (!months || months <= 0 || !(amount > 0)) return 0;
  return approvalEmi(item.advance as SettlementRow, amount, months);
}

/** "₹3,334 a month for 3 months (the last ₹3,332)" for an approved Term Loan's final amount and months; "" otherwise. */
export function finalEmiText(item: SettlementBatchItem, amount: number, months: number | null): string {
  if (item.advance.advanceType !== "term" || !months || !(amount > 0)) return "";
  const emi = termEmiOf(item, amount, months);
  const last = round2(amount - emi * (months - 1));
  return `${formatMoney(emi)} a month for ${months} ${months === 1 ? "month" : "months"}${
    months > 1 && last > 0 && last !== emi ? ` (the last ${formatMoney(last)})` : ""
  }`;
}

const num = (text: string): number => (text.trim() === "" ? NaN : Number(text.replace(/,/g, "").trim()));

/** The edit differs from the MD's decision (another decision, or another amount): a remark is then required. */
export function finalChanged(item: SettlementBatchItem, edit: Pick<FinalEdit, "decision" | "amount">): boolean {
  if (edit.decision !== item.md.decision) return true;
  if (edit.decision !== "approved") return false;
  const amount = num(edit.amount);
  return Number.isFinite(amount) && round2(amount) !== round2(item.md.amount ?? 0);
}

export type FinalProblems = Partial<Record<"decision" | "amount" | "months" | "start" | "remark", string>>;

/** What stops the final decision from being saved, field by field (the server's own checks: service.set_final). */
export function finalProblems(item: SettlementBatchItem, edit: FinalEdit, maxMonths?: number | null): FinalProblems {
  const out: FinalProblems = {};
  if (edit.decision === "approved" && item.md.decision !== "approved") {
    out.decision = "The MD rejected this request: it can only stay rejected.";
  }
  if (edit.decision === "approved" && !out.decision) {
    const text = edit.amount.trim();
    const amount = num(text);
    const md = item.md.amount ?? 0;
    if (text === "") out.amount = "Enter the final amount.";
    else if (!Number.isFinite(amount) || amount <= 0) out.amount = "The final amount must be more than ₹0.";
    else if (/\.\d{3,}$/.test(text)) out.amount = "Use at most 2 decimal places.";
    else if (round2(amount) > round2(md))
      out.amount = `The final amount cannot be more than the ${formatMoney(md)} the MD approved.`;
    if (item.advance.advanceType === "term") {
      const months = Number(edit.months.trim());
      // a change is checked against Settings' most like the server; the months the loan already has are kept as they are
      const kept = months === finalMonthsOf(item);
      if (
        edit.months.trim() === "" ||
        !Number.isInteger(months) ||
        months < 1 ||
        (!kept && maxMonths != null && months > maxMonths)
      )
        out.months =
          maxMonths != null
            ? `A Term Loan is repaid in 1 to ${maxMonths} months.`
            : "Enter the months as a whole number.";
    }
    if (!Number.isInteger(edit.startMonth) || edit.startMonth < 1 || edit.startMonth > 12)
      out.start = "Choose the first deduction month.";
    else if (!Number.isInteger(edit.startYear) || edit.startYear < 2000 || edit.startYear > 2100)
      out.start = "Enter a 4-digit year.";
  }
  if (!out.decision && !out.amount && finalChanged(item, edit) && cleanRemark(edit.remark).length < REMARK_MIN) {
    out.remark = "Write a remark for changing the MD's decision (at least 3 characters).";
  }
  return out;
}

export const hasProblems = (p: FinalProblems): boolean => Object.values(p).some(Boolean);

/** The PATCH body. The remark is always sent: the server keeps what it is given (an empty one clears it). */
export function finalPayload(edit: FinalEdit, item?: SettlementBatchItem): SettlementFinalInput {
  const body: SettlementFinalInput = { decision: edit.decision, remark: cleanRemark(edit.remark) };
  if (edit.decision === "approved") {
    body.amount = round2(num(edit.amount));
    body.startMonth = edit.startMonth;
    body.startYear = edit.startYear;
    // a Term Loan's repayment months when HR changed them (the server checks them against Settings' most)
    const months = Number(edit.months.trim());
    if (edit.months.trim() !== "" && (!item || months !== finalMonthsOf(item))) body.months = months;
  }
  return body;
}

/** "From Dec 2026" for an approved final decision; "" otherwise. */
export const finalStartText = (item: SettlementBatchItem): string =>
  item.final.decision === "approved" && item.final.startMonth && item.final.startYear
    ? monthLabel(item.final.startMonth, item.final.startYear)
    : "";

/** What HR changed from the MD on one request, in words ("Amount ₹10,000 -> ₹8,000"); [] when it is the MD's. */
export function changesFromMd(item: SettlementBatchItem): string[] {
  const f = item.final;
  const md = item.md;
  if (!f.decision) return [];
  if (f.decision !== md.decision) {
    return [
      f.decision === "rejected"
        ? `Rejected (the MD approved ${formatMoney(md.amount)})`
        : "Approved (the MD rejected it)",
    ];
  }
  if (f.decision === "approved" && round2(f.amount ?? 0) !== round2(md.amount ?? 0)) {
    return [`Amount ${formatMoney(md.amount)} -> ${formatMoney(f.amount)}`];
  }
  return [];
}

export type FinalReview = {
  lines: { item: SettlementBatchItem; changes: string[] }[];
  approved: number;
  rejected: number;
  undecided: number;
  changed: number;
  requested: number;
  mdApproved: number;
  finalApproved: number;
};

/** Everything Finalize will decide, the changes from the MD, and the totals. */
export function finalReview(batch: Pick<SettlementBatch, "items">): FinalReview {
  const lines = batch.items.map((item) => ({ item, changes: changesFromMd(item) }));
  const approvedItems = batch.items.filter((i) => i.final.decision === "approved");
  return {
    lines,
    approved: approvedItems.length,
    rejected: batch.items.filter((i) => i.final.decision === "rejected").length,
    undecided: batch.items.filter((i) => !i.final.decision).length,
    changed: lines.filter((l) => l.changes.length > 0).length,
    requested: round2(batch.items.reduce((s, i) => s + (i.requestedAmount || 0), 0)),
    mdApproved: round2(batch.items.reduce((s, i) => s + (i.md.decision === "approved" ? (i.md.amount ?? 0) : 0), 0)),
    finalApproved: round2(approvedItems.reduce((s, i) => s + (i.final.amount ?? 0), 0)),
  };
}

// ─── The finalized report for the auditor (the Settlement report's own format) ──

/** The settlement of a request as it will be paid (the server's `effective`: HR's final decision with the auditor's
 *  reduced amount or rejection on top); HR's final decision when an older server sends none. */
export const effectiveOf = (item: SettlementBatchItem): SettlementEffective =>
  item.effective ?? { decision: item.final.decision, amount: item.final.amount, remark: item.final.remark };

/** One request as the report reads it: its settlement as paid (effective: the FINAL decision with the auditor's change)
 *  as the status (approved / rejected) and its amount as the approved amount, the final first deduction month. */
export function finalRow(item: SettlementBatchItem): SettlementRow {
  const a = item.advance;
  const eff = effectiveOf(item);
  const approved = eff.decision === "approved";
  return {
    ...a,
    requestedAmount: item.requestedAmount,
    status: approved ? "approved" : "rejected",
    amount: approved ? (eff.amount ?? item.final.amount ?? a.amount) : a.amount,
    // a Term Loan's months and EMI as finalized (the request's until HR changed them)
    ...(a.advanceType === "term" && approved
      ? (() => {
          const months = finalMonthsOf(item);
          const paid = eff.amount ?? item.final.amount ?? a.amount;
          return { repaymentMonths: months, emiAmount: termEmiOf(item, paid, months) || a.emiAmount };
        })()
      : {}),
    repaymentStartMonth: approved ? (item.final.startMonth ?? a.repaymentStartMonth) : a.repaymentStartMonth,
    repaymentStartYear: approved ? (item.final.startYear ?? a.repaymentStartYear) : a.repaymentStartYear,
    decisionRemark: eff.remark || item.final.remark || item.md.remark || "",
  };
}

/** The type a batch is ("Salary Advance" | "Term Loan"), from the batch itself. */
export const batchTypeLabel = (batch: Pick<SettlementBatch, "advanceType">): string =>
  TYPE_LABEL[batch.advanceType] ?? TYPE_LABEL.general;

const fileWord = (text: string) => text.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");

/** "Loan_Advance_Salary_Advance_November_2026_Batch_1_Final". */
export const reportStem = (batch: Pick<SettlementBatch, "advanceType" | "month" | "year" | "number">): string =>
  `Loan_Advance_${fileWord(batchTypeLabel(batch))}_${MONTH_FULL[batch.month - 1]}_${batch.year}_Batch_${batch.number}_Final`;

/** The report's sheet: "Nov 2026 Batch 1". */
export const reportSheet = (batch: Pick<SettlementBatch, "month" | "year" | "number">): string =>
  `${MONTH_FULL[batch.month - 1].slice(0, 3)} ${batch.year} Batch ${batch.number}`;

/** The finalized report (owner 2026-11-26): the batch's requests with their FINAL decisions under the owner's 12 default
 *  columns, a totals row, the Final Summary and (drawn by export.ts) the signatures, exactly as the Loan & Advance page's
 *  own report; titled "Loan & Advance – Salary Advance – November 2026 – Batch 1 – Final" (owner 2026-11-27). */
export function buildFinalReport(batch: SettlementBatch): SettlementExport {
  const items = batch.items;
  const rows = items.map(finalRow);
  // the owner's columns exactly as the Loan & Advance report prints them (a Term Loan batch: the Term Loan report's own,
  // owner 2026-11-27); Remarks stays an empty cell (owner 2026-11-26)
  const term = batch.advanceType === "term";
  const columns: ExportColumn[] = term ? exportColumns(undefined, "term") : exportColumns(DEFAULT_COLUMN_KEYS);
  const lines = rows.map((a, i) => columns.map((c) => c.value(a, i)));
  const named = columns.findIndex((c) => c.key === "employee");
  const labelAt = named >= 0 ? named : columns.findIndex((c) => !c.money && !c.numeric);
  const totals = columns.map((c, i): ExportCell => {
    if (c.money) return round2(lines.reduce((sum, line) => sum + (typeof line[i] === "number" ? line[i] : 0), 0));
    return i === labelAt ? `Total (${plural(rows.length, "request")})` : "";
  });
  // the settlement as paid: HR's final decisions with the auditor's changes (the same before any change)
  const review = auditorReview(batch);
  const when = `${MONTH_FULL[batch.month - 1]} ${batch.year}`;
  const finalized = batch.finalizedAt
    ? ` · Finalized${batch.finalizedBy ? ` by ${batch.finalizedBy}` : ""} on ${formatDateTime(batch.finalizedAt)}`
    : "";
  return {
    title: `${LOAN_ADVANCE_TITLE} – ${batchTypeLabel(batch)} – ${when} – Batch ${batch.number} – Final`,
    subtitle: `${plural(rows.length, "request")} · ${review.approved} approved (${formatMoney(review.payable)}) · ${
      review.rejected
    } rejected${finalized}`,
    sheet: reportSheet(batch),
    fileStem: reportStem(batch),
    columns,
    rows: lines,
    totals,
    summary: term ? termExportSummary(rows) : exportSummary(rows),
  };
}

// ─── The bank file for Accounts (the Payroll bank-file format) ──────────────────

/** The requests the bank file pays: the batch's approved ones as paid (effective: after the auditor's changes), at the
 *  amount paid. */
export const batchBankRows = (batch: Pick<SettlementBatch, "items">): SettlementRow[] =>
  batch.items.filter((i) => effectiveOf(i).decision === "approved").map(finalRow);

/** One payment per approved request: the amount paid (after the auditor's changes) rounded UP to the rupee (like the
 *  Normal Method's own bank file and payroll's NET). */
export const batchBankLines = (batch: Pick<SettlementBatch, "items">): BankFileLine[] =>
  bankFileLines(batchBankRows(batch));

export const batchBankTotal = (batch: Pick<SettlementBatch, "items">): number =>
  round2(batchBankRows(batch).reduce((sum, a) => sum + roundUpRupee(a.amount), 0));

/** The approved requests the bank cannot pay as they are (no account number or no IFSC). */
export const batchMissingBank = (batch: Pick<SettlementBatch, "items">): SettlementRow[] =>
  missingBankDetails(batchBankRows(batch));

/** "Loan_Advance_Bank_File_Salary_Advance_November_2026_Batch_1.xlsx". */
export const batchBankFileName = (batch: Pick<SettlementBatch, "advanceType" | "month" | "year" | "number">): string =>
  `Loan_Advance_Bank_File_${fileWord(batchTypeLabel(batch))}_${MONTH_FULL[batch.month - 1]}_${batch.year}_Batch_${batch.number}.xlsx`;

// ─── History ─────────────────────────────────────────────────────────────────────

// The words of every history action are the branching tracker's own (components/settlement-flow/WorkflowFlow.tsx
// `historyLabel`), so the History tab and the tracker's approval history read the same.

/** The figures an entry carries, in words ("3 requests", "2 approved · 1 rejected · ₹18,000", "To a@x.com · CC b@x.com"). */
export function historyDetail(entry: SettlementHistoryEntry): string {
  const parts: string[] = [];
  if (typeof entry.count === "number") parts.push(plural(entry.count, "request"));
  if (typeof entry.changes === "number") parts.push(plural(entry.changes, "change"));
  if (typeof entry.remarks === "number" && entry.remarks > 0) parts.push(plural(entry.remarks, "remark"));
  if (entry.via === "approved_send_accounts") parts.push("Sent the bank file to Accounts");
  if (entry.via === "approved_forward_hr") parts.push("Left the bank file to HR");
  if (entry.via === "auditor") parts.push("Sent by the auditor");
  if (typeof entry.proposals === "number" && entry.proposals > 0)
    parts.push(`${plural(entry.proposals, "HR proposal")}`);
  if (typeof entry.approved === "number") parts.push(`${entry.approved} approved`);
  if (typeof entry.rejected === "number") parts.push(`${entry.rejected} rejected`);
  if (typeof entry.total === "number") parts.push(formatMoney(entry.total));
  if (entry.to && entry.to.length > 0) parts.push(`To ${entry.to.join(", ")}`);
  if (entry.cc && entry.cc.length > 0) parts.push(`CC ${entry.cc.join(", ")}`);
  return parts.join(" · ");
}

/** Newest first. */
export const historyNewestFirst = (history: SettlementHistoryEntry[]): SettlementHistoryEntry[] =>
  [...history].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

// ─── Refusals ────────────────────────────────────────────────────────────────────

/** The server's words for a refused step, and what to do about the e-mail ones. */
export function workflowRefusal(err: unknown, fallback: string): { text: string; code: string | null; hint?: string } {
  const said = serverError(err, fallback);
  const hint =
    said.code === "email_off"
      ? "Set up and switch on e-mail in Gmail Control, then try again."
      : said.code === "email_blocked"
        ? "The e-mail was held back (Gmail Control or this machine). Nothing moved on; try again once sending is allowed."
        : said.code === "email_failed"
          ? "The mail server did not take it. Nothing moved on; try again."
          : said.code === "no_recipient"
            ? "Add the addresses in Settings -> Loan & Advance (Automation Method)."
            : said.code === "approval_not_permitted"
              ? "Finalize decides the advances, so it needs the approval right of Salary Advances / Term Loans."
              : undefined;
  return { ...said, hint };
}

/** "3 requests", for the forward and finalize dialogs. */
export const requestsText = (n: number): string => plural(n, "request");

/** The advance ids HR is looking at (the forward sends them: the server refuses when the batch holds others now). */
export const advanceIdsOf = (batch: Pick<SettlementBatch, "items">): number[] => batch.items.map((i) => i.advance.id);

/** File size in words: "12 KB". */
export const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// ─── The Auditor Review Portal (2026-11-27): what the auditor changed ──────────────

/** The auditor's answer in words. */
export const AUDITOR_DECISION_LABEL: Record<SettlementAuditorDecision, string> = {
  approved_send_accounts: "Approved, bank file sent to Accounts by the auditor",
  approved_forward_hr: "Approved, forwarded to HR",
  changes_forward_hr: "Changes forwarded to HR",
};

/** The auditor changed this request (a reduced amount or a rejection; a remark alone is not a change). */
export const auditorChanged = (item: SettlementBatchItem): boolean =>
  item.auditor?.action === "reduce" || item.auditor?.action === "reject";

/** What the auditor did to one request, in words ("Reduced ₹8,000 -> ₹6,000", "Rejected (HR approved ₹5,000)"); null
 *  for no change. */
export function auditorChangeText(item: SettlementBatchItem): string | null {
  const a = item.auditor;
  if (!a) return null;
  if (a.action === "reduce") return `Reduced ${formatMoney(item.final.amount)} -> ${formatMoney(a.amount)}`;
  if (a.action === "reject")
    return item.final.decision === "approved" ? `Rejected (HR approved ${formatMoney(item.final.amount)})` : "Rejected";
  return null;
}

export type AuditorReview = {
  /** Every request the auditor changed or wrote a remark on. */
  lines: { item: SettlementBatchItem; change: string | null; remark: string }[];
  changes: number;
  remarks: number;
  /** HR's final approved total, and what is paid after the auditor's changes. */
  hrApproved: number;
  payable: number;
  approved: number;
  rejected: number;
};

/** The auditor's changes on a batch, for HR's review (HR Review of Auditor Changes) and the summaries. */
export function auditorReview(batch: Pick<SettlementBatch, "items">): AuditorReview {
  const lines = batch.items
    .map((item) => ({ item, change: auditorChangeText(item), remark: (item.auditor?.remark ?? "").trim() }))
    .filter((l) => l.change || l.remark);
  const paid = batch.items.filter((i) => effectiveOf(i).decision === "approved");
  return {
    lines,
    changes: batch.items.filter(auditorChanged).length,
    remarks: lines.filter((l) => l.remark).length,
    hrApproved: round2(
      batch.items.reduce((s, i) => s + (i.final.decision === "approved" ? (i.final.amount ?? 0) : 0), 0),
    ),
    payable: round2(paid.reduce((s, i) => s + (effectiveOf(i).amount ?? 0), 0)),
    approved: paid.length,
    rejected: batch.items.filter((i) => effectiveOf(i).decision === "rejected").length,
  };
}

/** "In 3 days" / "Expired" / "Replaced by a newer link": the review link's state for HR. */
export function linkStateText(link: NonNullable<SettlementBatch["auditor"]["link"]>): {
  text: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  if (link.submittedAt) return { text: "Answered", tone: "success" };
  if (link.revoked) return { text: "Closed (replaced or confirmed by hand)", tone: "neutral" };
  if (link.expired) return { text: "Expired", tone: "danger" };
  return { text: "Active", tone: "success" };
}
