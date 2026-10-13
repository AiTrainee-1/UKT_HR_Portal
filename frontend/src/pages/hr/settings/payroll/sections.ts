import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { boxText, parseNumber, RANGES, sameValue, type NumberRule } from "./form";
import { formatPaise, MONTHS, toPaise } from "./preview";

/**
 * The Payroll tab's four saved groups, each with its own Save button: what the form starts from (the saved settings),
 * what it may send (only its own keys), and what is wrong with a value before it is sent. Number boxes hold text so a
 * cleared box is an error to fix, not a silent 0.
 */

export type RatesForm = {
  staffRulesEnabled: boolean;
  pfRate: string;
  esiRate: string;
  esiApplicableBelow: string;
  prodRulesEnabled: boolean;
  prodPfRate: string;
  prodEsiRate: string;
  prodEsiApplicableBelow: string;
  payDay: string;
  bonusFyStartMonth: string;
  defaultSalaryPerShift: string;
};

export type BonusForm = {
  bonusPercent: string;
  bonusWageCeiling: string;
  bonusEligibilityCeiling: string;
};

export type OtForm = {
  otDetectionEnabled: boolean;
  otThresholdMinutes: string;
};

export type BandRow = { label: string; minSalary: string; maxSalary: string; pfRate: string; efRate: string };

export type PfEfForm = {
  prodPfEfEnabled: boolean;
  prodPfEfRules: BandRow[];
};

export type PayrollForms = { rates: RatesForm; bonus: BonusForm; ot: OtForm; pfEf: PfEfForm };

const bandText = (value: unknown): string =>
  typeof value === "number" ? boxText(value) : typeof value === "string" ? value : "";

/** The saved settings as form values; the backend's own defaults while nothing has loaded. */
export function savedPayroll(s: PayrollSettingsItem | undefined): PayrollForms {
  return {
    rates: {
      staffRulesEnabled: s?.staffPayrollRulesEnabled ?? false,
      pfRate: boxText(s?.pfRate ?? 0),
      esiRate: boxText(s?.esiRate ?? 0),
      esiApplicableBelow: boxText(s?.esiApplicableBelow ?? 21000),
      prodRulesEnabled: s?.prodPayrollRulesEnabled ?? false,
      prodPfRate: boxText(s?.prodPfRate ?? 0),
      prodEsiRate: boxText(s?.prodEsiRate ?? 0),
      prodEsiApplicableBelow: boxText(s?.prodEsiApplicableBelow ?? 21000),
      payDay: boxText(s?.payDay ?? 5),
      bonusFyStartMonth: boxText(s?.bonusFyStartMonth ?? 4),
      defaultSalaryPerShift: boxText(s?.defaultSalaryPerShift ?? 0),
    },
    bonus: {
      bonusPercent: boxText(s?.bonusPercent ?? 8.33),
      bonusWageCeiling: boxText(s?.bonusWageCeiling ?? 7000),
      bonusEligibilityCeiling: boxText(s?.bonusEligibilityCeiling ?? 21000),
    },
    ot: {
      otDetectionEnabled: s?.otDetectionEnabled ?? false,
      otThresholdMinutes: boxText(s?.otThresholdMinutes ?? 60),
    },
    pfEf: {
      prodPfEfEnabled: s?.prodPfEfEnabled ?? false,
      prodPfEfRules: (s?.prodPfEfRules ?? []).map((r) => ({
        label: typeof r?.label === "string" ? r.label : "",
        minSalary: bandText(r?.minSalary),
        maxSalary: bandText(r?.maxSalary),
        pfRate: bandText(r?.pfRate),
        efRate: bandText(r?.efRate),
      })),
    },
  };
}

// ── what is wrong ──

export type Errors<T> = Partial<Record<keyof T, string>>;

export const FY_MONTH_RULE: NumberRule = { min: 1, max: 12, decimals: 0 };

const RATE_RULES: Partial<Record<keyof RatesForm, NumberRule>> = {
  pfRate: RANGES.percent,
  esiRate: RANGES.percent,
  esiApplicableBelow: RANGES.amount,
  prodPfRate: RANGES.percent,
  prodEsiRate: RANGES.percent,
  prodEsiApplicableBelow: RANGES.amount,
  payDay: RANGES.payDay,
  bonusFyStartMonth: FY_MONTH_RULE,
  defaultSalaryPerShift: RANGES.perShift,
};

const BONUS_RULES: Record<keyof BonusForm, NumberRule> = {
  bonusPercent: RANGES.percent,
  bonusWageCeiling: RANGES.amount,
  bonusEligibilityCeiling: RANGES.amount,
};

const OT_RULES: Partial<Record<keyof OtForm, NumberRule>> = { otThresholdMinutes: RANGES.otMinutes };

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
export const otErrors = (form: OtForm, saved: OtForm) => fieldErrors(form, saved, OT_RULES);

/** A bonus rate the Act does not allow: shown as a warning, not refused (some establishments are not covered). */
export function bonusPercentWarning(text: string): string | null {
  const value = parseNumber(text, RANGES.percent).value;
  if (value === null || (value >= 8.33 && value <= 20)) return null;
  return `${value}% is outside the Payment of Bonus Act's 8.33% to 20%. The Bonus page will still use it.`;
}

export type BandErrors = Partial<Record<keyof BandRow, string>>[];

/** The problem with each cell of the band table, once the table differs from the saved one. */
export function bandErrors(rows: BandRow[], saved: BandRow[]): BandErrors {
  if (sameValue(rows, saved)) return rows.map(() => ({}));
  return rows.map((row) => {
    const errors: Partial<Record<keyof BandRow, string>> = {};
    if (row.label.length > 80) errors.label = "Keep the name to 80 characters.";
    for (const key of ["minSalary", "maxSalary"] as const) {
      const error = parseNumber(row[key], RANGES.amount).error;
      if (error) errors[key] = error;
    }
    for (const key of ["pfRate", "efRate"] as const) {
      const error = parseNumber(row[key], RANGES.percent).error;
      if (error) errors[key] = error;
    }
    const low = parseNumber(row.minSalary, RANGES.amount).value;
    const high = parseNumber(row.maxSalary, RANGES.amount).value;
    if (!errors.maxSalary && low !== null && high !== null && high > 0 && high < low) {
      errors.maxSalary = "Must be 0 (no upper limit) or at least the Min.";
    }
    return errors;
  });
}

export const hasErrors = (errors: Record<string, unknown> | Record<string, unknown>[]): boolean =>
  Array.isArray(errors)
    ? errors.some((e) => Object.keys(e).length > 0)
    : Object.values(errors).some((v) => typeof v === "string" && v !== "");

// ── what is sent ──

const num = (text: string): number => Number(text.trim());

/** "Save Payroll Settings": the rates, both switches, the pay day, the financial year and the per-shift suggestion. */
export function ratesPayload(f: RatesForm): Partial<PayrollSettingsItem> {
  return {
    staffPayrollRulesEnabled: f.staffRulesEnabled,
    pfRate: num(f.pfRate),
    esiRate: num(f.esiRate),
    esiApplicableBelow: num(f.esiApplicableBelow),
    prodPayrollRulesEnabled: f.prodRulesEnabled,
    prodPfRate: num(f.prodPfRate),
    prodEsiRate: num(f.prodEsiRate),
    prodEsiApplicableBelow: num(f.prodEsiApplicableBelow),
    payDay: num(f.payDay),
    bonusFyStartMonth: num(f.bonusFyStartMonth),
    defaultSalaryPerShift: num(f.defaultSalaryPerShift),
  };
}

/** "Save Bonus Settings". */
export function bonusPayload(f: BonusForm): Partial<PayrollSettingsItem> {
  return {
    bonusPercent: num(f.bonusPercent),
    bonusWageCeiling: num(f.bonusWageCeiling),
    bonusEligibilityCeiling: num(f.bonusEligibilityCeiling),
  };
}

/**
 * "Save OT / Compensation Settings". The company-wide Compensation Type no longer has a box (the Compensation page asks
 * Pay or Relaxation on every announcement), but it is sent back exactly as saved, as this button always did.
 */
export function otPayload(f: OtForm, s: PayrollSettingsItem | undefined): Partial<PayrollSettingsItem> {
  return {
    otDetectionEnabled: f.otDetectionEnabled,
    otThresholdMinutes: num(f.otThresholdMinutes),
    otCompensationType: s?.otCompensationType ?? "pay",
  };
}

/**
 * "Save PF/EF Rules": the bands switch and the table. A table left as it was is sent back exactly as stored (an older
 * page may have stored values this form would rewrite).
 */
export function pfEfPayload(
  f: PfEfForm,
  saved: PfEfForm,
  s: PayrollSettingsItem | undefined,
): Partial<PayrollSettingsItem> {
  const rules = sameValue(f.prodPfEfRules, saved.prodPfEfRules)
    ? (s?.prodPfEfRules ?? [])
    : f.prodPfEfRules.map((r) => ({
        label: r.label.trim(),
        minSalary: num(r.minSalary),
        maxSalary: num(r.maxSalary),
        pfRate: num(r.pfRate),
        efRate: num(r.efRate),
      }));
  return { prodPfEfEnabled: f.prodPfEfEnabled, prodPfEfRules: rules };
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
  staffRulesEnabled: ["Staff PF and ESI deductions", "onoff"],
  pfRate: ["Staff PF rate", "percent"],
  esiRate: ["Staff ESI rate", "percent"],
  esiApplicableBelow: ["Staff ESI ceiling", "amount"],
  prodRulesEnabled: ["Production flat-rate PF and ESI", "onoff"],
  prodPfRate: ["Production PF rate", "percent"],
  prodEsiRate: ["Production ESI rate", "percent"],
  prodEsiApplicableBelow: ["Production ESI ceiling", "amount"],
  payDay: ["Salary pay day", "day"],
  bonusFyStartMonth: ["Financial year start month", "month"],
  defaultSalaryPerShift: ["Suggested rate per shift", "amount"],
};

export const BONUS_LABELS: Partial<Record<keyof BonusForm, [string, Kind]>> = {
  bonusPercent: ["Bonus rate", "percent"],
  bonusWageCeiling: ["Bonus wage ceiling", "amount"],
  bonusEligibilityCeiling: ["Bonus eligibility limit", "amount"],
};

/** Keys whose change moves money on payslips generated afterwards (these saves ask first). */
export const RATES_MONEY_KEYS: (keyof RatesForm)[] = [
  "staffRulesEnabled",
  "pfRate",
  "esiRate",
  "esiApplicableBelow",
  "prodRulesEnabled",
  "prodPfRate",
  "prodEsiRate",
  "prodEsiApplicableBelow",
];
