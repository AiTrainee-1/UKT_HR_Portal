import type { PayCycle, PayrollSettingsItem, ProdCyclesPatch } from "@/lib/api-client/custom-hooks";
import type { Change } from "../attendance/form";
import { boxText, parseNumber, RANGES, sameValue } from "../payroll/form";
import { CYCLE_INFO, CYCLES } from "../production-payroll/cycles";

/**
 * The PRODUCTION page of Settings -> Late Detection: the switch, what counts as late, and each pay cycle's free late days and
 * deduction slabs. One form, one Save. These settings used to sit in Production Payroll; the pay period rules stayed there,
 * and the two screens save different keys of the same `prodCycles` setting, which the server merges key by key
 * (production_cycles.merge_prod_cycles), so a save from either never overwrites what the other owns. For the same reason a
 * save here sends only what was changed. Number boxes hold text so a cleared box is an error to fix, not a silent 0.
 */

export type SlabRow = { fromLates: string; deductionShifts: string };

export type CycleLateForm = {
  lateFreeAllowance: string;
  lateSlabs: SlabRow[];
};

export type ProductionLateForm = {
  /** Late deductions on production payslips (prodLateDetectionEnabled). */
  enabled: boolean;
  /** What counts as late, "strict" or "simple" (prodAttendanceMode). */
  mode: string;
  cycles: Record<PayCycle, CycleLateForm>;
};

const cell = (value: unknown): string =>
  typeof value === "number" ? boxText(value) : typeof value === "string" ? value : "";

const slabCells = (rows: { fromLates?: unknown; deductionShifts?: unknown }[] | undefined): SlabRow[] =>
  (rows ?? []).map((r) => ({ fromLates: cell(r?.fromLates), deductionShifts: cell(r?.deductionShifts) }));

/**
 * The saved settings as form values. A cycle the server knows nothing about (an older backend, or nothing stored yet) shows
 * the shared production late rules, which is what the engine uses for it.
 */
export function savedProductionLate(s: PayrollSettingsItem | undefined): ProductionLateForm {
  const cycles = {} as Record<PayCycle, CycleLateForm>;
  for (const cycle of CYCLES) {
    const c = s?.prodCycles?.[cycle];
    cycles[cycle] = {
      lateFreeAllowance: boxText(c?.lateFreeAllowance ?? s?.prodLateFreeAllowance ?? 3),
      lateSlabs: slabCells(c?.lateSlabs ?? s?.prodLateDeductionSlabs),
    };
  }
  return { enabled: s?.prodLateDetectionEnabled ?? false, mode: s?.prodAttendanceMode ?? "strict", cycles };
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

// ── what changed ──

const sameCycle = (a: CycleLateForm, b: CycleLateForm) => ({
  allowance: sameValue(a.lateFreeAllowance, b.lateFreeAllowance),
  slabs: sameValue(a.lateSlabs, b.lateSlabs),
});

/** Which cycles have a late value that differs from the saved one. */
export function changedCycles(form: ProductionLateForm, saved: ProductionLateForm): PayCycle[] {
  return CYCLES.filter((cycle) => {
    const same = sameCycle(form.cycles[cycle], saved.cycles[cycle]);
    return !same.allowance || !same.slabs;
  });
}

/** Same page: the same switch, mode and every cycle's two late values. */
export const sameProductionLate = (a: ProductionLateForm, b: ProductionLateForm): boolean =>
  a.enabled === b.enabled && a.mode === b.mode && changedCycles(a, b).length === 0;

// ── what is wrong ──

export type SlabErrors = Partial<Record<keyof SlabRow, string>>[];

export type CycleLateErrors = { allowance?: string; slabs: SlabErrors };

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
 * What stops a cycle's late rules being saved: the values once changed (a value left as saved is never judged, so a page
 * can always be saved again even if an older page stored something odd).
 */
export function cycleLateErrors(f: CycleLateForm, saved: CycleLateForm): CycleLateErrors {
  const errors: CycleLateErrors = { slabs: f.lateSlabs.map(() => ({})) };
  if (!sameValue(f.lateFreeAllowance, saved.lateFreeAllowance)) {
    errors.allowance = parseNumber(f.lateFreeAllowance, RANGES.lateCount).error ?? undefined;
  }
  if (!sameValue(f.lateSlabs, saved.lateSlabs)) errors.slabs = slabErrors(f.lateSlabs);
  return errors;
}

export const hasCycleLateErrors = (e: CycleLateErrors): boolean =>
  !!e.allowance || e.slabs.some((row) => Object.keys(row).length > 0);

/** The first problem of any cycle, in words with the cycle's name, or null when the whole page can be saved. */
export function firstLateProblem(
  form: ProductionLateForm,
  saved: ProductionLateForm,
  labelOf: (cycle: PayCycle) => string,
): string | null {
  for (const cycle of CYCLES) {
    if (hasCycleLateErrors(cycleLateErrors(form.cycles[cycle], saved.cycles[cycle]))) {
      return `${labelOf(cycle)} has a late value to fix.`;
    }
  }
  return null;
}

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
 * A PUT /api/payroll-settings body from this page. The hook's own type describes `prodCycles` as the server answers it
 * (every cycle, every key); a save sends the patch shape instead (only the cycles and keys that change).
 */
export type ProductionLatePayload = Omit<Partial<PayrollSettingsItem>, "prodCycles"> & { prodCycles?: ProdCyclesPatch };

const slabsToSend = (rows: SlabRow[]) =>
  rows
    .map((r) => ({ fromLates: Number(r.fromLates.trim()), deductionShifts: Number(r.deductionShifts.trim()) }))
    .sort((a, b) => a.fromLates - b.fromLates);

/**
 * "Save Production Late Detection": only the keys that were changed. The switch and the mode are company values (or a
 * branch's own), and a cycle's free late days and slabs are its own late rules: none of them is sent unless it changed, so
 * saving one never gives a cycle the shared late values as its own, never writes an unchanged value into a branch's own
 * settings, and never touches the cycle's period rule (week start, first period start), which Production Payroll owns.
 */
export function productionLatePayload(form: ProductionLateForm, saved: ProductionLateForm): ProductionLatePayload {
  const payload: ProductionLatePayload = {};
  if (form.enabled !== saved.enabled) payload.prodLateDetectionEnabled = form.enabled;
  if (form.mode !== saved.mode) payload.prodAttendanceMode = form.mode as PayrollSettingsItem["prodAttendanceMode"];
  const prodCycles: ProdCyclesPatch = {};
  for (const cycle of CYCLES) {
    const now = form.cycles[cycle];
    const was = saved.cycles[cycle];
    const patch: NonNullable<ProdCyclesPatch[PayCycle]> = {};
    if (!sameValue(now.lateFreeAllowance, was.lateFreeAllowance))
      patch.lateFreeAllowance = Number(now.lateFreeAllowance.trim());
    if (!sameValue(now.lateSlabs, was.lateSlabs)) patch.lateSlabs = slabsToSend(now.lateSlabs);
    if (Object.keys(patch).length > 0) prodCycles[cycle] = patch;
  }
  if (Object.keys(prodCycles).length > 0) payload.prodCycles = prodCycles;
  return payload;
}

/** "Use the shared rules again": nulls hand the cycle's late rules back to the shared production values. */
export function sharedLatePayload(cycle: PayCycle): ProductionLatePayload {
  return { prodCycles: { [cycle]: { lateFreeAllowance: null, lateSlabs: null } } };
}

// ── what a save changes, in words (for the confirm) ──

const MODE_NAME: Record<string, string> = { strict: "Strict", simple: "Simple" };

const slabsText = (rows: SlabRow[]): string =>
  rows.length === 0
    ? "no slabs (nothing deducted)"
    : slabsToSend(rows)
        .map((r) => `${r.fromLates} → ${r.deductionShifts}`)
        .join(", ");

/** Every value of the page that differs from what is saved, as "label: from -> to" lines (all of them change pay). */
export function productionLateChanges(form: ProductionLateForm, saved: ProductionLateForm): Change[] {
  const changes: Change[] = [];
  if (form.enabled !== saved.enabled) {
    changes.push({
      key: "enabled",
      label: "Late deductions",
      from: saved.enabled ? "On" : "Off",
      to: form.enabled ? "On" : "Off",
      money: true,
    });
  }
  if (form.mode !== saved.mode) {
    changes.push({
      key: "mode",
      label: "What counts as late",
      from: MODE_NAME[saved.mode] ?? saved.mode,
      to: MODE_NAME[form.mode] ?? form.mode,
      money: true,
    });
  }
  for (const cycle of CYCLES) {
    const label = CYCLE_INFO[cycle].label;
    const now = form.cycles[cycle];
    const was = saved.cycles[cycle];
    if (!sameValue(now.lateFreeAllowance, was.lateFreeAllowance)) {
      changes.push({
        key: `${cycle}-allowance`,
        label: `${label}: free late days a period`,
        from: was.lateFreeAllowance,
        to: now.lateFreeAllowance,
        money: true,
      });
    }
    if (!sameValue(now.lateSlabs, was.lateSlabs)) {
      changes.push({
        key: `${cycle}-slabs`,
        label: `${label}: deduction slabs`,
        from: slabsText(was.lateSlabs),
        to: slabsText(now.lateSlabs),
        money: true,
      });
    }
  }
  return changes;
}
