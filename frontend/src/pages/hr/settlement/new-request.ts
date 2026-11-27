// HR's New request (owner 2026-11-27): HR raises a Salary Advance or Term Loan request on an employee's behalf under
// EXACTLY the employee apps' rules. The server decides (POST /api/advances runs mobile_settlement_views.apply_for); this
// reads the employee's own eligibility (GET /api/advances/eligibility) to say beforehand what can be sent and why not,
// blocks what the server would refuse (above the limit, outside 1-12 months ...), and puts the server's refusal next to
// the field it is about. Both methods use it: the request then waits for approval (Normal) or joins the month's open
// batch of its type (Automation).

import type { Advance, AdvanceEligibility, CreateAdvanceInput } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { describeSchedule, schedulePreview } from "./logic";
import { ABSOLUTE_MAX_MONTHS, ordinal } from "./rules";
import { formatMoney } from "./shared";

export type RequestType = Advance["advanceType"];

export type RequestForm = {
  /** The employee's id as text (EmployeeSearchSelect holds ids as text). */
  employeeId: string;
  advanceType: RequestType;
  /** Whole rupees, as typed. */
  amount: string;
  /** Term Loan only: 1-12, as chosen. */
  months: string;
  purpose: string;
};

/** The purpose the server takes (mobile_settlement_views.MIN_PURPOSE / MAX_PURPOSE). */
export const PURPOSE_MIN = 3;
export const PURPOSE_MAX = 300;

export const emptyRequestForm = (advanceType: RequestType = "general"): RequestForm => ({
  employeeId: "",
  advanceType,
  amount: "",
  months: "",
  purpose: "",
});

export type RequestField = "employee" | "type" | "amount" | "months" | "purpose";
export type RequestErrors = Partial<Record<RequestField, string>>;

/** Whether the employee may apply for this type now, and the employee app's reason when not. */
export function typeEligibility(
  e: AdvanceEligibility,
  type: RequestType,
): { canApply: boolean; reason: string | null } {
  const side = type === "term" ? e.termLoan : e.salaryAdvance;
  return {
    canApply: side.canApply,
    reason: side.canApply ? null : side.reason || "This request cannot be raised now.",
  };
}

/** The Salary Advance limit (50 % of the 1st-20th earned salary): the most that can be asked for; null when unknown. */
export const salaryAdvanceLimit = (e: AdvanceEligibility | undefined): number | null => e?.salaryAdvance.limit ?? null;

const num = (text: string): number => (text.trim() === "" ? NaN : Number(text.trim()));

/** A Salary Advance asked above the limit (the server refuses it: there is no override any more). */
export function aboveLimit(f: Pick<RequestForm, "advanceType" | "amount">, e: AdvanceEligibility | undefined): boolean {
  const limit = salaryAdvanceLimit(e);
  const amount = num(f.amount);
  return f.advanceType === "general" && limit != null && Number.isFinite(amount) && amount > limit;
}

/** "The most that can be asked for is ₹8,060 (50% of the ₹16,120 earned from the 1st to the 20th)." (Settings' % and
 *  day, as the eligibility says them.) */
export function limitText(e: AdvanceEligibility): string {
  const sa = e.salaryAdvance;
  const earned = sa.earned?.earnedAmount;
  const through = sa.earned?.throughDay ?? sa.rules?.earnedThroughDay;
  return `The most that can be asked for is ${formatMoney(sa.limit)}${
    earned != null
      ? ` (${sa.percent}% of the ${formatMoney(earned)} earned from the 1st${through ? ` to the ${ordinal(through)}` : ""})`
      : ""
  }.`;
}

/** "The most is ₹30,000 (100% of the ₹30,000 fixed monthly salary)." (Settings' % of the salary.) */
export function termLimitText(e: AdvanceEligibility): string {
  const tl = e.termLoan;
  const salary = tl.monthlySalary ?? e.monthlySalary;
  return `The most is ${formatMoney(tl.limit)}${
    tl.limitPercent != null && salary != null
      ? ` (${tl.limitPercent}% of the ${formatMoney(salary)} fixed monthly salary)`
      : ""
  }.`;
}

/** The messages to show next to the fields; empty when the request can be sent. Mirrors apply_for's checks (the
 *  server's words where it has them); without the eligibility nothing past the basics is known, so nothing more is
 *  checked (the dialog does not let it be sent then anyway). */
export function validateRequest(f: RequestForm, e: AdvanceEligibility | undefined): RequestErrors {
  const errors: RequestErrors = {};
  if (!f.employeeId) errors.employee = "Choose the employee this request is for.";

  const term = f.advanceType === "term";
  const amount = num(f.amount);
  if (f.amount.trim() === "") errors.amount = "Enter the amount.";
  else if (!Number.isFinite(amount) || amount <= 0) errors.amount = "The amount must be more than ₹0.";
  else if (!Number.isInteger(amount)) errors.amount = "Enter the amount in whole rupees (no paise).";
  else if (e && !term && aboveLimit(f, e)) errors.amount = limitText(e);
  else if (e && term && amount < e.termLoan.minAmount)
    errors.amount = `A Term Loan starts from ${formatMoney(e.termLoan.minAmount)}.`;
  else if (e && term && e.termLoan.limit != null && amount > e.termLoan.limit) errors.amount = termLimitText(e);
  else if (e && term && e.termLoan.limit == null && e.termLoan.maxAmount > 0 && amount > e.termLoan.maxAmount)
    errors.amount = `The amount cannot be more than ${formatMoney(e.termLoan.maxAmount)}.`;

  if (term) {
    const min = e?.termLoan.minMonths ?? 1;
    const max = e?.termLoan.maxMonths ?? ABSOLUTE_MAX_MONTHS;
    const months = num(f.months);
    if (f.months.trim() === "") errors.months = `Choose how many months to repay in (${min} to ${max}).`;
    else if (!Number.isInteger(months) || months < min || months > max)
      errors.months = `A Term Loan is repaid in ${min} to ${max} months.`;
  }

  const purpose = f.purpose.trim();
  if (purpose.length < PURPOSE_MIN) errors.purpose = "Write briefly what the money is for (at least 3 characters).";
  else if (purpose.length > PURPOSE_MAX) errors.purpose = `Keep the purpose under ${PURPOSE_MAX} characters.`;
  return errors;
}

/** What the create call sends: the employee app's form (months only for a Term Loan). */
export function requestPayload(f: RequestForm): CreateAdvanceInput {
  return {
    employeeId: Number(f.employeeId),
    advanceType: f.advanceType,
    amount: Number(f.amount.trim()),
    purpose: f.purpose.trim(),
    ...(f.advanceType === "term" ? { repaymentMonths: Number(f.months) } : {}),
  };
}

/** The Term Loan EMI the server works out: the amount over the months rounded UP to whole rupees, the last EMI
 *  smaller (settlement_views.whole_rupee_emi). */
export const termEmi = (amount: number, months: number): number =>
  months > 0 && amount > 0 ? Math.ceil(amount / months) : 0;

/** What payroll will deduct once the request is approved as asked, or null while the form does not say enough:
 *  "Deducted once, in full, from the November 2026 salary." / "6 deductions of ₹2,000 from Dec 2026 to May 2027". */
export function requestSchedule(f: RequestForm, e: AdvanceEligibility | undefined): string | null {
  const amount = num(f.amount);
  if (!e || !Number.isFinite(amount) || amount <= 0) return null;
  if (f.advanceType === "general") return `Deducted once, in full, from the ${e.salaryAdvance.deductionLabel} salary.`;
  const months = num(f.months);
  if (!Number.isInteger(months) || months < 1) return null;
  const preview = schedulePreview({
    type: "term",
    amount,
    months,
    emi: termEmi(amount, months),
    startMonth: e.termLoan.firstDeductionMonth,
    startYear: e.termLoan.firstDeductionYear,
  });
  return preview.items.length > 0 ? describeSchedule(preview) : null;
}

// ─── The server's refusal ────────────────────────────────────────────────────────

/** The form field a refusal's `field` is about (the server names its own keys). */
const FIELD_OF: Record<string, RequestField> = {
  amount: "amount",
  repaymentMonths: "months",
  repayment_months: "months",
  purpose: "purpose",
  employeeId: "employee",
  advanceType: "type",
};

/** A short heading for the refusals that are about the rules rather than a field. */
export const REFUSAL_TITLE: Record<string, string> = {
  window_closed: "Outside the Salary Advance window",
  over_limit: "Above the Salary Advance limit",
  duplicate: "A request is already there",
  service: "Not enough service for a Term Loan",
  no_salary: "No monthly salary to take it from",
  inactive: "The employee is not active",
  workflow_disabled: "Requests are switched off",
};

/** Refusals that mean the eligibility shown has changed (the day, another request): it is read again. */
export const STALE_ELIGIBILITY_CODES: ReadonlySet<string> = new Set([
  "window_closed",
  "over_limit",
  "duplicate",
  "service",
  "no_salary",
  "inactive",
  "workflow_disabled",
]);

export type RequestRefusal = { text: string; code: string | null; field: RequestField | null; title: string | null };

/** The server's words for a refused request ({error, code, field}), and the form field they belong to. */
export function requestRefusal(err: unknown): RequestRefusal {
  if (err instanceof ApiError) {
    const data = (err.data ?? null) as { error?: unknown; code?: unknown; field?: unknown } | null;
    const text =
      data && typeof data.error === "string" && data.error.trim()
        ? data.error.trim()
        : err.message || "The request could not be raised.";
    const code = data && typeof data.code === "string" ? data.code : null;
    const field = data && typeof data.field === "string" ? (FIELD_OF[data.field] ?? null) : null;
    return { text, code, field, title: code ? (REFUSAL_TITLE[code] ?? null) : null };
  }
  const text = err instanceof Error && err.message ? err.message : "The request could not be raised.";
  return { text, code: null, field: null, title: null };
}
