// Settings -> Loan & Advance -> Salary Advance Rules / Term Loan Rules (owner 2026-11-27): the forms' rules, apart from
// the screen so they can be tested. They mirror the server's own checks (advance_rules.clean) to tell HR before saving;
// the server checks everything again and answers 400 {code: "rules", field} with its model field name, which is mapped
// back to the form's field here. Only what changed in a block is sent.

import type { SalaryAdvanceRules, TermLoanRules } from "@/lib/api-client/custom-hooks/settlement-automation";

export type Limits = Record<string, { min: number; max: number }>;

// ─── the forms ─────────────────────────────────────────────────────────────────

export type SaForm = {
  percent: string;
  windowFromDay: string;
  windowToDay: string;
  earnedThroughDay: string;
  perMonth: string;
  rejectedAllowsReapply: boolean;
};
export type TlForm = {
  limitPercent: string;
  allowAboveSalary: boolean;
  maxMonths: string;
  minAmount: string;
  perYear: string;
  minServiceMonths: string;
  reapplyNextMonth: boolean;
  oneOpenAtATime: boolean;
};

export type SaKey = keyof SaForm;
export type TlKey = keyof TlForm;

/** The server's model field of each form field (the 400's `field`, the limits' keys). */
export const SA_FIELD: Record<SaKey, string> = {
  percent: "sa_percent",
  windowFromDay: "sa_window_from",
  windowToDay: "sa_window_to",
  earnedThroughDay: "sa_earned_through",
  perMonth: "sa_per_month",
  rejectedAllowsReapply: "sa_rejected_allows_reapply",
};
export const TL_FIELD: Record<TlKey, string> = {
  limitPercent: "tl_limit_percent",
  allowAboveSalary: "tl_allow_above_salary",
  maxMonths: "tl_max_months",
  minAmount: "tl_min_amount",
  perYear: "tl_per_year",
  minServiceMonths: "tl_min_service_months",
  reapplyNextMonth: "tl_reapply_next_month",
  oneOpenAtATime: "tl_one_open",
};

const SA_NUMBERS = ["percent", "windowFromDay", "windowToDay", "earnedThroughDay", "perMonth"] as const;
const TL_NUMBERS = ["limitPercent", "maxMonths", "minAmount", "perYear", "minServiceMonths"] as const;

export const saFormOf = (r: SalaryAdvanceRules): SaForm => ({
  percent: String(r.percent),
  windowFromDay: String(r.windowFromDay),
  windowToDay: String(r.windowToDay),
  earnedThroughDay: String(r.earnedThroughDay),
  perMonth: String(r.perMonth),
  rejectedAllowsReapply: r.rejectedAllowsReapply,
});

export const tlFormOf = (r: TermLoanRules): TlForm => ({
  limitPercent: String(r.limitPercent),
  allowAboveSalary: r.allowAboveSalary,
  maxMonths: String(r.maxMonths),
  minAmount: String(r.minAmount),
  perYear: String(r.perYear),
  minServiceMonths: String(r.minServiceMonths),
  reapplyNextMonth: r.reapplyNextMonth,
  oneOpenAtATime: r.oneOpenAtATime,
});

/** A whole number from the text, or NaN. */
const whole = (text: string): number => {
  const t = text.trim();
  return /^-?\d+$/.test(t) ? Number(t) : NaN;
};

const rangeProblem = (text: string, limit: { min: number; max: number } | undefined): string | null => {
  const l = limit ?? { min: 0, max: Number.MAX_SAFE_INTEGER };
  const n = whole(text);
  return Number.isNaN(n) || n < l.min || n > l.max ? `Enter a whole number from ${l.min} to ${l.max}.` : null;
};

export type Problems<K extends string> = Partial<Record<K, string>>;

/** What stops the Salary Advance rules from being saved, field by field (advance_rules.clean). */
export function saProblems(f: SaForm, limits: Limits = {}): Problems<SaKey> {
  const out: Problems<SaKey> = {};
  for (const key of SA_NUMBERS) {
    const p = rangeProblem(f[key], limits[SA_FIELD[key]]);
    if (p) out[key] = p;
  }
  const from = whole(f.windowFromDay);
  const to = whole(f.windowToDay);
  const through = whole(f.earnedThroughDay);
  if (!out.windowFromDay && !out.windowToDay && from > to)
    out.windowToDay = "The window must start on or before the day it ends.";
  if (!out.earnedThroughDay && !out.windowFromDay && through >= from)
    out.earnedThroughDay =
      "Count the earned salary up to a day BEFORE the window opens, so the figure is complete when employees apply.";
  return out;
}

/** What stops the Term Loan rules from being saved, field by field (advance_rules.clean). */
export function tlProblems(f: TlForm, limits: Limits = {}): Problems<TlKey> {
  const out: Problems<TlKey> = {};
  for (const key of TL_NUMBERS) {
    const p = rangeProblem(f[key], limits[TL_FIELD[key]]);
    if (p) out[key] = p;
  }
  if (!out.limitPercent && whole(f.limitPercent) > 100 && !f.allowAboveSalary)
    out.limitPercent = "Above 100% of the monthly salary needs 'Allow loan above monthly salary' switched on.";
  return out;
}

export const hasProblems = (p: Record<string, string | undefined>): boolean => Object.values(p).some(Boolean);

/** The Salary Advance rules the form says (numbers parsed; a field not valid yet keeps the saved value). */
export function saRulesOf(f: SaForm, saved: SalaryAdvanceRules): SalaryAdvanceRules {
  const n = (key: (typeof SA_NUMBERS)[number]) => (Number.isNaN(whole(f[key])) ? saved[key] : whole(f[key]));
  return {
    percent: n("percent"),
    windowFromDay: n("windowFromDay"),
    windowToDay: n("windowToDay"),
    earnedThroughDay: n("earnedThroughDay"),
    perMonth: n("perMonth"),
    rejectedAllowsReapply: f.rejectedAllowsReapply,
  };
}

/** The Term Loan rules the form says (as saRulesOf). */
export function tlRulesOf(f: TlForm, saved: TermLoanRules): TermLoanRules {
  const n = (key: (typeof TL_NUMBERS)[number]) => (Number.isNaN(whole(f[key])) ? saved[key] : whole(f[key]));
  const limitPercent = n("limitPercent");
  return {
    limitPercent,
    effectivePercent: f.allowAboveSalary ? limitPercent : Math.min(limitPercent, 100),
    allowAboveSalary: f.allowAboveSalary,
    maxMonths: n("maxMonths"),
    minAmount: n("minAmount"),
    perYear: n("perYear"),
    minServiceMonths: n("minServiceMonths"),
    reapplyNextMonth: f.reapplyNextMonth,
    oneOpenAtATime: f.oneOpenAtATime,
  };
}

/** What changed in the Salary Advance block (what Save sends; {} when nothing). */
export function saChanges(saved: SalaryAdvanceRules, f: SaForm): Partial<SalaryAdvanceRules> {
  const now = saRulesOf(f, saved);
  const out: Partial<SalaryAdvanceRules> = {};
  for (const key of [...SA_NUMBERS, "rejectedAllowsReapply"] as const) {
    if (now[key] !== saved[key]) (out as Record<string, unknown>)[key] = now[key];
  }
  return out;
}

/** What changed in the Term Loan block. */
export function tlChanges(saved: TermLoanRules, f: TlForm): Partial<TermLoanRules> {
  const now = tlRulesOf(f, saved);
  const out: Partial<TermLoanRules> = {};
  for (const key of [...TL_NUMBERS, "allowAboveSalary", "reapplyNextMonth", "oneOpenAtATime"] as const) {
    if (now[key] !== saved[key]) (out as Record<string, unknown>)[key] = now[key];
  }
  return out;
}

/** The form field a server refusal's `field` is about (sa_window_to -> windowToDay), or null. */
export function fieldOfServer<K extends string>(map: Record<K, string>, field: string | null | undefined): K | null {
  if (!field) return null;
  const hit = (Object.entries(map) as [K, string][]).find(([, f]) => f === field);
  return hit ? hit[0] : null;
}
