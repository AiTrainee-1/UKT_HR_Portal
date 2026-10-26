import type { PfEsiBasis } from "@/lib/api-client/custom-hooks";
import { defaultSplit, FIRST_PORTION, fromPaise, toPaise as splitPaise } from "@/lib/salary-split";
import { divRoundHalfUp, percentOf, toPaise } from "../payroll/preview";

/**
 * The live example on the PF & ESI tab, worked out the way the engine does it (backend/api/pf_esi.py, payroll_views.py):
 *   - an employee is judged on the FULL MONTHLY amount of a rule's basis (Basic, Basic + DA + Retaining Allowance, or the
 *     whole monthly salary), never on the attendance-prorated pay;
 *   - the first rule (list order) whose range holds that amount applies, both ends included, a Maximum of 0 meaning no
 *     upper limit; no match means no deduction;
 *   - the deduction is the rule's percentage of the FIRST portion (Basic + DA + Retaining Allowance) of the period's pay,
 *     prorated like Basic: for staff the salary's first half x days paid / working days, for production half of the pay
 *     earned in the period.
 * The example uses the automatic 50% split (Basic, DA and Retaining Allowance share the first half equally); an
 * employee's recorded split can differ. Money is whole paise, rounded half up like the engine.
 */

/** A rule as the example reads it: amounts in rupees (as typed), `max` 0 = no upper limit. */
export type PreviewRule = { label: string; basis: PfEsiBasis; min: number; max: number; rate: number };

/** What each basis measures for one employee, in paise. */
export type SampleAmounts = Record<PfEsiBasis, number>;

/** The monthly amounts of a salary with the automatic split: Basic is a third of the first half, so 1/6 of the salary. */
export function staffAmounts(monthlyPaise: number): SampleAmounts {
  const split = monthlyPaise > 0 ? defaultSplit(fromPaise(monthlyPaise)) : null;
  if (!split) return { basic: 0, first_portion: 0, total: Math.max(0, monthlyPaise) };
  const paise = (key: keyof typeof split) => splitPaise(split[key]) ?? 0;
  const first = FIRST_PORTION.reduce((sum, field) => sum + paise(field.key), 0);
  return { basic: paise("basic"), first_portion: first, total: monthlyPaise };
}

/** A production worker's amounts: the monthly-equivalent earnings, and the automatic split's shares of them (Basic 1/6, first portion 1/2). */
export function productionAmounts(monthlyEquivalentPaise: number): SampleAmounts {
  return {
    basic: divRoundHalfUp(monthlyEquivalentPaise, 6),
    first_portion: divRoundHalfUp(monthlyEquivalentPaise, 2),
    total: monthlyEquivalentPaise,
  };
}

export type RuleMatch = { index: number; rule: PreviewRule; tested: number };

/** True when `amountPaise` is inside the rule's range (both ends included; Maximum 0 = no upper limit). */
export function ruleHolds(rule: PreviewRule, amountPaise: number): boolean {
  return amountPaise >= toPaise(rule.min) && (rule.max <= 0 || amountPaise <= toPaise(rule.max));
}

/** The first rule whose range holds the employee's amount on that rule's own basis, or null. */
export function matchRule(rules: PreviewRule[], amounts: SampleAmounts): RuleMatch | null {
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    const tested = amounts[rule.basis];
    if (ruleHolds(rule, tested)) return { index, rule, tested };
  }
  return null;
}

/** What one deduction (PF or ESI) comes to for the example employee. */
export type Deduction = {
  match: RuleMatch | null;
  /** The percentage of the matching rule (0 with no match). */
  rate: number;
  /** In paise. */
  amount: number;
};

function deduct(rules: PreviewRule[], amounts: SampleAmounts, basePaise: number): Deduction {
  const match = matchRule(rules, amounts);
  const rate = match?.rule.rate ?? 0;
  return { match, rate, amount: match && rate > 0 ? percentOf(basePaise, rate) : 0 };
}

export type Example = {
  amounts: SampleAmounts;
  /** What PF and ESI are taken from: the first portion of the period's pay, in paise. */
  base: number;
  pf: Deduction;
  esi: Deduction;
  total: number;
};

/** The working days of the example month (the other Payroll examples use the same 26). */
export const EXAMPLE_WORKING_DAYS = 26;

/** A staff member with a monthly salary (rupees), paid `daysPaid` of `workingDays`. */
export function staffExample(input: {
  salary: number;
  daysPaid: number;
  workingDays?: number;
  pfRules: PreviewRule[];
  esiRules: PreviewRule[];
}): Example {
  const monthly = toPaise(input.salary);
  const amounts = staffAmounts(monthly);
  const working = Math.max(1, Math.round(input.workingDays ?? EXAMPLE_WORKING_DAYS)) * 100;
  const days = Math.max(0, Math.round(input.daysPaid * 100));
  const base = divRoundHalfUp(amounts.first_portion * days, working);
  const pf = deduct(input.pfRules, amounts, base);
  const esi = deduct(input.esiRules, amounts, base);
  return { amounts, base, pf, esi, total: pf.amount + esi.amount };
}

/** The weeks in a production pay period, which scale the period's pay to a month (Weekly x4, BiWeekly x2, Monthly x1). */
export const PERIOD_FACTORS = { weekly: 4, biweekly: 2, monthly: 1 } as const;
export type ProductionPeriod = keyof typeof PERIOD_FACTORS;

/** A production worker who earned `periodPay` rupees in a pay period on `cycle`. */
export function productionExample(input: {
  periodPay: number;
  cycle: ProductionPeriod;
  pfRules: PreviewRule[];
  esiRules: PreviewRule[];
}): Example & { periodPaise: number; monthlyEquivalent: number } {
  const periodPaise = toPaise(input.periodPay);
  const monthlyEquivalent = periodPaise * PERIOD_FACTORS[input.cycle];
  const amounts = productionAmounts(monthlyEquivalent);
  const base = divRoundHalfUp(periodPaise, 2);
  const pf = deduct(input.pfRules, amounts, base);
  const esi = deduct(input.esiRules, amounts, base);
  return { amounts, base, pf, esi, total: pf.amount + esi.amount, periodPaise, monthlyEquivalent };
}
