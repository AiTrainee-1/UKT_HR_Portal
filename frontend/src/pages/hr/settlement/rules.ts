// The Salary Advance and Term Loan rules in words (Settings -> Loan & Advance, owner 2026-11-27: every rule is HR's
// setting, nothing hard-coded). The numbers come from the server: Settings' rules (GET /api/settlement-settings), an
// employee's eligibility (its `rules`), or an advance's own kept figures (earnings.percent / throughDay, termLimit). These
// turn them into the sentences the pages, the New request dialog and the Settings preview show.

import type { SalaryAdvanceRules, TermLoanRules } from "@/lib/api-client/custom-hooks/settlement-automation";
import { useSettlementSettings } from "@/lib/api-client/custom-hooks/settlement-automation";
import { formatMoney } from "./shared";

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st, 22nd (advance_rules.ordinal). */
export function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** "1st–20th": the days the earned salary (and the leave check) count. */
export const earnedRange = (throughDay: number): string => `1st–${ordinal(throughDay)}`;

/** "the 21st and 22nd of each month" (advance_rules.window_text). */
export function windowText(sa: Pick<SalaryAdvanceRules, "windowFromDay" | "windowToDay" | "windowText">): string {
  if (sa.windowText) return sa.windowText;
  const a = sa.windowFromDay;
  const b = sa.windowToDay;
  if (a === b) return `the ${ordinal(a)} of each month`;
  if (b === a + 1) return `the ${ordinal(a)} and ${ordinal(b)} of each month`;
  return `the ${ordinal(a)} to the ${ordinal(b)} of each month`;
}

const times = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));

/** The Term Loan % in force (above 100 only when allowed). */
export const termPercent = (
  tl: Pick<TermLoanRules, "limitPercent" | "allowAboveSalary" | "effectivePercent">,
): number => tl.effectivePercent ?? (tl.allowAboveSalary ? tl.limitPercent : Math.min(tl.limitPercent, 100));

/** The Salary Advance rules as employees see them, one sentence each. */
export function salaryAdvanceRuleLines(sa: SalaryAdvanceRules): string[] {
  return [
    `Salary Advance: apply on ${windowText(sa)}; up to ${sa.percent}% of the salary earned from the 1st to the ${ordinal(
      sa.earnedThroughDay,
    )}, deducted in full from that month's salary.`,
    `${times(sa.perMonth, "One Salary Advance a month", "Up to {n} Salary Advances a month")}${
      sa.rejectedAllowsReapply ? " (a rejected request does not count)" : " (a rejected request counts too)"
    }.`,
  ];
}

/** The Term Loan rules as employees see them, one sentence each. */
export function termLoanRuleLines(tl: TermLoanRules): string[] {
  const lines = [
    `Term Loan: staff employees only, after ${tl.minServiceMonths} ${
      tl.minServiceMonths === 1 ? "month" : "months"
    } of service; apply on any day of the month.`,
    `Up to ${termPercent(tl)}% of the fixed monthly salary, from ${formatMoney(tl.minAmount)}, repaid in 1 to ${
      tl.maxMonths
    } monthly EMIs from the next month's salary.`,
    `${times(tl.perYear, "One Term Loan", "Up to {n} Term Loans")} approved per calendar year.`,
  ];
  if (tl.oneOpenAtATime) lines.push("One waiting or active Term Loan at a time.");
  if (tl.reapplyNextMonth) lines.push("After a rejection, apply again from the 1st of the next month.");
  return lines;
}

/** A page's line about the Salary Advance ("up to 50% of the salary earned from the 1st to the 20th; employees apply on
 *  the 21st and 22nd"); a line without numbers when the rules are not known. */
export function salaryAdvanceSummary(sa: SalaryAdvanceRules | null | undefined): string {
  if (!sa)
    return "up to the percentage of the salary earned so far in the month that Settings allows; employees apply in the Settings window";
  return `up to ${sa.percent}% of the salary earned from the 1st to the ${ordinal(sa.earnedThroughDay)}; employees apply on ${windowText(sa)}`;
}

/** A page's line about the Term Loan ("up to 100% of the fixed monthly salary, repaid in 1 to 6 monthly EMIs from
 *  ₹1,000, after 6 months of service; staff only"); without numbers when the rules are not known. */
export function termLoanSummary(tl: TermLoanRules | null | undefined): string {
  if (!tl) return "up to Settings' share of the fixed monthly salary, repaid in monthly EMIs; staff only";
  return `up to ${termPercent(tl)}% of the fixed monthly salary, repaid in 1 to ${tl.maxMonths} monthly EMIs from ${formatMoney(
    tl.minAmount,
  )}, after ${tl.minServiceMonths} ${tl.minServiceMonths === 1 ? "month" : "months"} of service; staff only`;
}

/** The absolute most months a Term Loan may run (the server's cap; Settings' Max repayment months is 1 to this). Only a
 *  fallback while an employee's eligibility is not read. */
export const ABSOLUTE_MAX_MONTHS = 12;

/** The rules in force, from Settings (null while loading or when this login may not read Settings: the pages then use
 *  each advance's own figures and words without numbers). */
export function useLoanAdvanceRules(): { sa: SalaryAdvanceRules; tl: TermLoanRules } | null {
  const { data } = useSettlementSettings();
  return data?.salaryAdvanceRules && data.termLoanRules
    ? { sa: data.salaryAdvanceRules, tl: data.termLoanRules }
    : null;
}
