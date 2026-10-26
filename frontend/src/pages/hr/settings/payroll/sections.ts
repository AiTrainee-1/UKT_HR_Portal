import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { boxText, parseNumber, RANGES, sameValue, type NumberRule } from "./form";
import { formatPaise, MONTHS, toPaise } from "./preview";

/**
 * The Staff Payroll tab's saved groups (Payroll Rules and Bonus), each with its own Save button: what the form starts from
 * (the saved settings), what it may send (only its own keys), and what is wrong with a value before it is sent. Number
 * boxes hold text so a cleared box is an error to fix, not a silent 0. The rate suggested for new production employees and
 * the production bonus are on Production Payroll (production-payroll/sections.ts).
 */

export type RatesForm = {
  payDay: string;
  bonusFyStartMonth: string;
};

export type BonusForm = {
  bonusPercent: string;
  bonusWageCeiling: string;
  bonusEligibilityCeiling: string;
};

export type PayrollForms = { rates: RatesForm; bonus: BonusForm };

/** The saved settings as form values; the backend's own defaults while nothing has loaded. */
export function savedPayroll(s: PayrollSettingsItem | undefined): PayrollForms {
  return {
    rates: {
      payDay: boxText(s?.payDay ?? 5),
      bonusFyStartMonth: boxText(s?.bonusFyStartMonth ?? 4),
    },
    bonus: {
      bonusPercent: boxText(s?.bonusPercent ?? 8.33),
      bonusWageCeiling: boxText(s?.bonusWageCeiling ?? 7000),
      bonusEligibilityCeiling: boxText(s?.bonusEligibilityCeiling ?? 21000),
    },
  };
}

// ── what is wrong ──

export type Errors<T> = Partial<Record<keyof T, string>>;

export const FY_MONTH_RULE: NumberRule = { min: 1, max: 12, decimals: 0 };

const RATE_RULES: Partial<Record<keyof RatesForm, NumberRule>> = {
  payDay: RANGES.payDay,
  bonusFyStartMonth: FY_MONTH_RULE,
};

const BONUS_RULES: Record<keyof BonusForm, NumberRule> = {
  bonusPercent: RANGES.percent,
  bonusWageCeiling: RANGES.amount,
  bonusEligibilityCeiling: RANGES.amount,
};

/**
 * The problem with each changed number box. A value left as it was saved is never judged (the server accepts an
 * unchanged value too), so a section can always be saved again even if an older page stored something odd.
 */
export function fieldErrors<T extends Record<string, unknown>>(
  form: T,
  saved: T,
  rules: Partial<Record<keyof T, NumberRule>>,
): Errors<T> {
  const errors: Errors<T> = {};
  for (const key of Object.keys(rules) as (keyof T)[]) {
    const rule = rules[key];
    if (!rule || sameValue(form[key], saved[key])) continue;
    const error = parseNumber(String(form[key] ?? ""), rule).error;
    if (error) errors[key] = error;
  }
  return errors;
}

export const ratesErrors = (form: RatesForm, saved: RatesForm) => fieldErrors(form, saved, RATE_RULES);
export const bonusErrors = (form: BonusForm, saved: BonusForm) => fieldErrors(form, saved, BONUS_RULES);

/** A bonus rate the Act does not allow: shown as a warning, not refused (some establishments are not covered). */
export function bonusPercentWarning(text: string): string | null {
  const value = parseNumber(text, RANGES.percent).value;
  if (value === null || (value >= 8.33 && value <= 20)) return null;
  return `${value}% is outside the Payment of Bonus Act's 8.33% to 20%. The Bonus page will still use it.`;
}

export const hasErrors = (errors: Record<string, unknown>): boolean =>
  Object.values(errors).some((v) => typeof v === "string" && v !== "");

// ── what is sent ──

const num = (text: string): number => Number(text.trim());

/** "Save Payroll Settings": the pay day and the financial year, both company-wide (PF and ESI are on their own tab). */
export function ratesPayload(f: RatesForm): Partial<PayrollSettingsItem> {
  return {
    payDay: num(f.payDay),
    bonusFyStartMonth: num(f.bonusFyStartMonth),
  };
}

/** "Save Staff Bonus Settings". */
export function bonusPayload(f: BonusForm): Partial<PayrollSettingsItem> {
  return {
    bonusPercent: num(f.bonusPercent),
    bonusWageCeiling: num(f.bonusWageCeiling),
    bonusEligibilityCeiling: num(f.bonusEligibilityCeiling),
  };
}

// ── what a save changes, in words (for the confirm dialogs) ──

export type Change = { label: string; from: string; to: string };

export type Kind = "percent" | "amount" | "onoff" | "day" | "month" | "minutes" | "text";

function say(kind: Kind, value: unknown): string {
  const text = String(value ?? "").trim();
  if (kind === "onoff") return value ? "On" : "Off";
  if (text === "") return "(blank)";
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  switch (kind) {
    case "percent":
      return `${n}%`;
    case "amount":
      return formatPaise(toPaise(n));
    case "month":
      return MONTHS[n - 1] ?? text;
    case "minutes":
      return `${n} minutes`;
    default:
      return text;
  }
}

/** The changed keys of a section as "label: from -> to" lines. */
export function describeChanges<T extends Record<string, unknown>>(
  changed: (keyof T)[],
  saved: T,
  form: T,
  labels: Partial<Record<keyof T, [string, Kind]>>,
): Change[] {
  return changed.flatMap((key) => {
    const entry = labels[key];
    if (!entry) return [];
    const [label, kind] = entry;
    return [{ label, from: say(kind, saved[key]), to: say(kind, form[key]) }];
  });
}

export const RATES_LABELS: Partial<Record<keyof RatesForm, [string, Kind]>> = {
  payDay: ["Salary pay day", "day"],
  bonusFyStartMonth: ["Financial year start month", "month"],
};

export const BONUS_LABELS: Partial<Record<keyof BonusForm, [string, Kind]>> = {
  bonusPercent: ["Staff bonus rate", "percent"],
  bonusWageCeiling: ["Staff bonus wage ceiling", "amount"],
  bonusEligibilityCeiling: ["Staff bonus eligibility limit", "amount"],
};
