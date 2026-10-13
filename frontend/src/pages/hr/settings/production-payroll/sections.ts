import type {
  PayCycle,
  PayrollSettingsItem,
  ProdCyclesPatch,
  ProductionPayrollItem,
  WeekStart,
} from "@/lib/api-client/custom-hooks";
import { boxText, parseNumber, RANGES, sameValue } from "../payroll/form";
import { compareDays, CYCLES, normalizeWeekStart, parseIsoDay, type Period } from "./cycles";

/**
 * The Production Payroll tab's saved groups: one per pay cycle ("Save Weekly settings": the cycle's period rule and
 * its own late rules, sent as `prodCycles`) and the global late detection ("Save Production Late Detection": the switch
 * and the attendance mode). Number boxes hold text so a cleared box is an error to fix, not a silent 0.
 */

export type SlabRow = { fromLates: string; deductionShifts: string };

export type CycleForm = {
  /** The weekday the cycle's weeks start on. */
  weekStart: WeekStart;
  /** "YYYY-MM-DD" or blank. */
  anchorDate: string;
  lateFreeAllowance: string;
  lateSlabs: SlabRow[];
};

export type LateForm = {
  mode: string;
  enabled: boolean;
};

export type ProductionForms = { cycles: Record<PayCycle, CycleForm>; late: LateForm };

/** The two keys of a cycle form that are its late rules (sent only when changed; null hands them back to the shared ones). */
export const CYCLE_LATE_KEYS: readonly (keyof CycleForm)[] = ["lateFreeAllowance", "lateSlabs"];

export const lateKeysChanged = (changed: readonly (keyof CycleForm)[]): boolean =>
  changed.some((k) => CYCLE_LATE_KEYS.includes(k));

const cell = (value: unknown): string =>
  typeof value === "number" ? boxText(value) : typeof value === "string" ? value : "";

const slabCells = (rows: { fromLates?: unknown; deductionShifts?: unknown }[] | undefined): SlabRow[] =>
  (rows ?? []).map((r) => ({ fromLates: cell(r?.fromLates), deductionShifts: cell(r?.deductionShifts) }));

/**
 * The saved settings as form values. A cycle the server knows nothing about (an older backend, or nothing stored yet)
 * shows Monday weeks, no date and the shared production late rules, which is what the engine uses for it.
 */
export function savedProduction(s: PayrollSettingsItem | undefined): ProductionForms {
  const cycles = {} as Record<PayCycle, CycleForm>;
  for (const cycle of CYCLES) {
    const c = s?.prodCycles?.[cycle];
    cycles[cycle] = {
      weekStart: normalizeWeekStart(c?.weekStart),
      anchorDate: c?.anchorDate ?? "",
      lateFreeAllowance: boxText(c?.lateFreeAllowance ?? s?.prodLateFreeAllowance ?? 3),
      lateSlabs: slabCells(c?.lateSlabs ?? s?.prodLateDeductionSlabs),
    };
  }
  return { cycles, late: { mode: s?.prodAttendanceMode ?? "strict", enabled: s?.prodLateDetectionEnabled ?? false } };
}

/**
 * The late rules a payslip of the cycle is judged by, from the saved settings: the cycle's own when it has them, else
 * the shared production values (as the engine's cycle_late_rules reads them).
 */
export function cycleLateRules(
  s: PayrollSettingsItem | undefined,
  cycle: PayCycle,
): { allowance: number; slabs: { fromLates: number; deductionShifts: number }[]; own: boolean } {
  const c = s?.prodCycles?.[cycle];
  return {
    allowance: c?.lateFreeAllowance ?? s?.prodLateFreeAllowance ?? 3,
    slabs: c?.lateSlabs ?? s?.prodLateDeductionSlabs ?? [],
    own: c?.ownLateRules ?? false,
  };
}

/** True when the cycle has late rules of its own (false: it uses the shared production values). */
export const ownLateRules = (s: PayrollSettingsItem | undefined, cycle: PayCycle): boolean =>
  cycleLateRules(s, cycle).own;

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

export type SlabErrors = Partial<Record<keyof SlabRow, string>>[];

export type CycleErrors = { anchorDate?: string; allowance?: string; slabs: SlabErrors };

/** The problem with each slab cell, plus a threshold used twice. */
function slabErrors(slabs: SlabRow[]): SlabErrors {
  const counts = new Map<number, number>();
  for (const s of slabs) {
    const from = parseNumber(s.fromLates, RANGES.lateCount).value;
    if (from !== null) counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  return slabs.map((s) => {
    const errors: Partial<Record<keyof SlabRow, string>> = {};
    const from = parseNumber(s.fromLates, RANGES.lateCount);
    if (from.error) errors.fromLates = from.error;
    else if ((counts.get(from.value!) ?? 0) > 1) errors.fromLates = `${from.value} is used by more than one row.`;
    const shifts = parseNumber(s.deductionShifts, RANGES.slabShifts).error;
    if (shifts) errors.deductionShifts = shifts;
    return errors;
  });
}

/**
 * What stops a cycle being saved: a first period start that is not a real date in the years the server accepts, and
 * the late values once changed (a value left as saved is never judged, so a cycle can always be saved again).
 */
export function cycleErrors(f: CycleForm, saved: CycleForm): CycleErrors {
  const errors: CycleErrors = { slabs: f.lateSlabs.map(() => ({})) };
  if (f.anchorDate.trim()) {
    const date = parseIsoDay(f.anchorDate);
    if (!date) errors.anchorDate = "Pick a real date.";
    else if (date.year < 2000 || date.year > 2100) errors.anchorDate = "Pick a date between the years 2000 and 2100.";
  }
  if (!sameValue(f.lateFreeAllowance, saved.lateFreeAllowance)) {
    errors.allowance = parseNumber(f.lateFreeAllowance, RANGES.lateCount).error ?? undefined;
  }
  if (!sameValue(f.lateSlabs, saved.lateSlabs)) errors.slabs = slabErrors(f.lateSlabs);
  return errors;
}

export const hasCycleErrors = (e: CycleErrors): boolean =>
  !!e.anchorDate || !!e.allowance || e.slabs.some((row) => Object.keys(row).length > 0);

/** A slab that deducts from workers who were never late (threshold 0 with a deduction). */
export function deductsFromEveryone(slabs: SlabRow[]): boolean {
  return slabs.some(
    (s) =>
      parseNumber(s.fromLates, RANGES.lateCount).value === 0 &&
      (parseNumber(s.deductionShifts, RANGES.slabShifts).value ?? 0) > 0,
  );
}

// ── what is sent ──

/**
 * A PUT /api/payroll-settings body from this tab. The hook's own type describes `prodCycles` as the server answers it
 * (every cycle, every key); a save sends the patch shape instead (only the cycles and keys that change).
 */
export type ProductionPayload = Omit<Partial<PayrollSettingsItem>, "prodCycles"> & { prodCycles?: ProdCyclesPatch };

const slabsToSend = (rows: SlabRow[]) =>
  rows
    .map((r) => ({ fromLates: Number(r.fromLates.trim()), deductionShifts: Number(r.deductionShifts.trim()) }))
    .sort((a, b) => a.fromLates - b.fromLates);

/**
 * "Save <Cycle> settings": that cycle only. The period rule (week start, first period start) always goes; the late
 * values go only when they were changed, so saving a period never silently gives a cycle the shared late values as its
 * own. A blank date clears the saved one.
 */
export function cyclePayload(cycle: PayCycle, f: CycleForm, changed: readonly (keyof CycleForm)[]): ProductionPayload {
  const patch: NonNullable<ProdCyclesPatch[PayCycle]> = {
    weekStart: normalizeWeekStart(f.weekStart),
    anchorDate: f.anchorDate.trim() || null,
  };
  if (changed.includes("lateFreeAllowance")) patch.lateFreeAllowance = Number(f.lateFreeAllowance.trim());
  if (changed.includes("lateSlabs")) patch.lateSlabs = slabsToSend(f.lateSlabs);
  return { prodCycles: { [cycle]: patch } };
}

/** "Use the shared rules again": nulls hand the cycle's late rules back to the shared production values. */
export function sharedLatePayload(cycle: PayCycle): ProductionPayload {
  return { prodCycles: { [cycle]: { lateFreeAllowance: null, lateSlabs: null } } };
}

/** "Save Production Late Detection": the global switch and the attendance mode it alone uses. */
export function latePayload(f: LateForm): ProductionPayload {
  return {
    prodAttendanceMode: f.mode as PayrollSettingsItem["prodAttendanceMode"],
    prodLateDetectionEnabled: f.enabled,
  };
}
