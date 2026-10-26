import type {
  PayCycle,
  PayrollSettingsItem,
  ProdCyclesPatch,
  ProductionPayrollItem,
  WeekStart,
} from "@/lib/api-client/custom-hooks";
import { boxText, parseNumber, RANGES, sameValue, type NumberRule } from "../payroll/form";
import { formatPaise, toPaise } from "../payroll/preview";
import { compareDays, CYCLES, normalizeWeekStart, parseIsoDay, type Period } from "./cycles";

/**
 * The Production Payroll tab's saved groups: one per pay cycle ("Save Weekly settings": the cycle's PERIOD rule, sent as
 * `prodCycles`) and "Pay & Bonus" (the rate suggested for new production employees and the production statutory bonus).
 * What a late day costs a production worker is not here any more: it is on Settings -> Late Detection -> Production, which
 * saves other keys of the same `prodCycles` setting, so neither save can overwrite the other. Number boxes hold text so a
 * cleared box is an error to fix, not a silent 0.
 */

export type CycleForm = {
  /** The weekday the cycle's weeks start on. */
  weekStart: WeekStart;
  /** "YYYY-MM-DD" or blank. */
  anchorDate: string;
};

export type PayBonusForm = {
  /** The Salary Per Shift suggested for a new production employee (0 = no suggestion). */
  defaultSalaryPerShift: string;
  prodBonusPercent: string;
  prodBonusWageCeiling: string;
  prodBonusEligibilityCeiling: string;
};

export type ProductionForms = { cycles: Record<PayCycle, CycleForm>; payBonus: PayBonusForm };

/** The server reports the production bonus (a backend that predates the split does not, and the page then shows it read-only). */
export const prodBonusReported = (s: PayrollSettingsItem | undefined): boolean => s?.prodBonusPercent !== undefined;

/**
 * The saved settings as form values. A cycle the server knows nothing about (an older backend, or nothing stored yet)
 * shows Monday weeks and no date, which is what the engine uses for it. The production bonus falls back to the staff
 * values only while the server does not report its own (that is what the split starts every company from).
 */
export function savedProduction(s: PayrollSettingsItem | undefined): ProductionForms {
  const cycles = {} as Record<PayCycle, CycleForm>;
  for (const cycle of CYCLES) {
    const c = s?.prodCycles?.[cycle];
    cycles[cycle] = { weekStart: normalizeWeekStart(c?.weekStart), anchorDate: c?.anchorDate ?? "" };
  }
  return {
    cycles,
    payBonus: {
      defaultSalaryPerShift: boxText(s?.defaultSalaryPerShift ?? 0),
      prodBonusPercent: boxText(s?.prodBonusPercent ?? s?.bonusPercent ?? 8.33),
      prodBonusWageCeiling: boxText(s?.prodBonusWageCeiling ?? s?.bonusWageCeiling ?? 7000),
      prodBonusEligibilityCeiling: boxText(s?.prodBonusEligibilityCeiling ?? s?.bonusEligibilityCeiling ?? 21000),
    },
  };
}

/**
 * The latest period generated on a cycle, from that cycle's Production Payroll list: the row whose period ends last
 * among those stamped with the cycle. That end is what the engine continues from (production_period.py
 * last_generated_cycle_end); null when nothing has been generated on the cycle yet. Rows without a stamped cycle (older
 * payroll, listed because the employee is on the cycle now) are ignored, as the engine ignores them.
 */
export function latestGeneratedPeriod(
  runs: Pick<ProductionPayrollItem, "periodStart" | "periodEnd" | "payCycle">[],
  cycle: PayCycle,
): Period | null {
  let latest: Period | null = null;
  for (const run of runs) {
    if (run.payCycle !== cycle) continue;
    const start = parseIsoDay(run.periodStart);
    const end = parseIsoDay(run.periodEnd);
    if (!start || !end) continue;
    if (!latest || compareDays(end, latest.end) > 0) latest = { start, end };
  }
  return latest;
}

// ── what is wrong ──

export type CycleErrors = { anchorDate?: string };

/** What stops a cycle being saved: a first period start that is not a real date in the years the server accepts. */
export function cycleErrors(f: CycleForm): CycleErrors {
  const errors: CycleErrors = {};
  if (f.anchorDate.trim()) {
    const date = parseIsoDay(f.anchorDate);
    if (!date) errors.anchorDate = "Pick a real date.";
    else if (date.year < 2000 || date.year > 2100) errors.anchorDate = "Pick a date between the years 2000 and 2100.";
  }
  return errors;
}

export const hasCycleErrors = (e: CycleErrors): boolean => !!e.anchorDate;

const PAY_BONUS_RULES: Record<keyof PayBonusForm, NumberRule> = {
  defaultSalaryPerShift: RANGES.perShift,
  prodBonusPercent: RANGES.percent,
  prodBonusWageCeiling: RANGES.amount,
  prodBonusEligibilityCeiling: RANGES.amount,
};

/**
 * The problem with each changed number box (the same ranges the server enforces). A value left as it was saved is never
 * judged, so a page can always be saved again even if an older page stored something odd.
 */
export function payBonusErrors(f: PayBonusForm, saved: PayBonusForm): Partial<Record<keyof PayBonusForm, string>> {
  const errors: Partial<Record<keyof PayBonusForm, string>> = {};
  for (const key of Object.keys(PAY_BONUS_RULES) as (keyof PayBonusForm)[]) {
    if (sameValue(f[key], saved[key])) continue;
    const error = parseNumber(f[key], PAY_BONUS_RULES[key]).error;
    if (error) errors[key] = error;
  }
  return errors;
}

// ── what is sent ──

/**
 * A PUT /api/payroll-settings body from this tab. The hook's own type describes `prodCycles` as the server answers it
 * (every cycle, every key); a save sends the patch shape instead (only the cycles and keys that change).
 */
export type ProductionPayload = Omit<Partial<PayrollSettingsItem>, "prodCycles"> & { prodCycles?: ProdCyclesPatch };

/**
 * "Save <Cycle> settings": that cycle's period rule only (week start and first period start), never a late value (those
 * belong to Late Detection and are merged key by key by the server). A blank date clears the saved one.
 */
export function cyclePayload(cycle: PayCycle, f: CycleForm): ProductionPayload {
  return {
    prodCycles: { [cycle]: { weekStart: normalizeWeekStart(f.weekStart), anchorDate: f.anchorDate.trim() || null } },
  };
}

/**
 * "Save Pay & Bonus": only the values that were changed, so saving the suggested rate never writes the bonus values (into
 * a branch's own settings, for a branch login) and the other way round.
 */
export function payBonusPayload(f: PayBonusForm, changed: readonly (keyof PayBonusForm)[]): ProductionPayload {
  const payload: ProductionPayload = {};
  for (const key of changed) payload[key] = Number(f[key].trim());
  return payload;
}

// ── what a save changes, in words (for the confirm dialogs) ──

export type PayBonusChange = { label: string; from: string; to: string };

const amount = (text: string) =>
  Number.isFinite(Number(text)) && text.trim() !== "" ? formatPaise(toPaise(Number(text))) : "(blank)";

/** The changed Pay & Bonus values as "label: from -> to" lines. */
export function payBonusChanges(
  changed: readonly (keyof PayBonusForm)[],
  saved: PayBonusForm,
  form: PayBonusForm,
): PayBonusChange[] {
  const lines: Record<keyof PayBonusForm, [string, (text: string) => string]> = {
    defaultSalaryPerShift: ["Suggested rate per shift", amount],
    prodBonusPercent: ["Production bonus rate", (t) => (t.trim() === "" ? "(blank)" : `${Number(t)}%`)],
    prodBonusWageCeiling: ["Production bonus wage ceiling", amount],
    prodBonusEligibilityCeiling: ["Production bonus eligibility limit", amount],
  };
  return changed.map((key) => ({
    label: lines[key][0],
    from: lines[key][1](saved[key]),
    to: lines[key][1](form[key]),
  }));
}
