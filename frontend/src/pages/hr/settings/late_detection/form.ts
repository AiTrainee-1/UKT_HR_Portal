import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import type { Change } from "../attendance/form";
import { allowanceProblem, capProblem, slabsProblem, type Slab, type SlabText } from "./preview";

// The two forms of the Late Detection tab: the late policy (free allowance + slabs, "Save Late Detection Policy") and
// the permission policy (the monthly cap, "Save Permission Policy"). Each sends only its own keys, as it always has.

export type LateDraft = { allowance: string; slabs: SlabText[] };
export type CapDraft = { cap: string };

const num = (text: string): number => (text.trim() === "" ? NaN : Number(text));

export function lateDraftFrom(data: Partial<PayrollSettingsItem>): LateDraft {
  return {
    allowance: String(data.lateFreeAllowance ?? 3),
    slabs: (data.lateDeductionSlabs ?? []).map((s) => ({
      fromLates: String(s.fromLates),
      deductionShifts: String(s.deductionShifts),
    })),
  };
}

export const capDraftFrom = (data: Partial<PayrollSettingsItem>): CapDraft => ({
  cap: String(data.permissionMonthlyCap ?? 3),
});

/** The rows as numbers (a row that is not a number yet stays NaN and is skipped by the examples). */
export const slabsOf = (d: LateDraft): Slab[] =>
  d.slabs.map((s) => ({ fromLates: num(s.fromLates), deductionShifts: num(s.deductionShifts) }));

const sorted = (rows: Slab[]) => [...rows].sort((a, b) => a.fromLates - b.fromLates);
const sameNumber = (a: string, b: string) => {
  const x = num(a);
  const y = num(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
};

/** Same policy: the same allowance and the same rows, in any order (the server stores them in ascending order). */
export function sameLate(a: LateDraft, b: LateDraft): boolean {
  if (!sameNumber(a.allowance, b.allowance) || a.slabs.length !== b.slabs.length) return false;
  const x = sorted(slabsOf(a));
  const y = sorted(slabsOf(b));
  return x.every(
    (r, i) => Object.is(r.fromLates, y[i].fromLates) && Object.is(r.deductionShifts, y[i].deductionShifts),
  );
}

export const sameCap = (a: CapDraft, b: CapDraft): boolean => sameNumber(a.cap, b.cap);

export const lateProblem = (d: LateDraft): string | null => allowanceProblem(d.allowance) ?? slabsProblem(d.slabs);

export const capDraftProblem = (d: CapDraft): string | null => capProblem(d.cap);

/** The Save Late Detection Policy request: the allowance and the rows in ascending order. */
export function latePayload(d: LateDraft): Partial<PayrollSettingsItem> {
  return { lateFreeAllowance: num(d.allowance), lateDeductionSlabs: sorted(slabsOf(d)) };
}

export const capPayload = (d: CapDraft): Partial<PayrollSettingsItem> => ({ permissionMonthlyCap: num(d.cap) });

const slabsText = (d: LateDraft) =>
  d.slabs.length === 0
    ? "no slabs (nothing deducted)"
    : sorted(slabsOf(d))
        .map((s) => `${s.fromLates} → ${s.deductionShifts}`)
        .join(", ");

export function lateChanges(draft: LateDraft, saved: LateDraft): Change[] {
  const changes: Change[] = [];
  if (!sameNumber(draft.allowance, saved.allowance)) {
    changes.push({
      key: "allowance",
      label: "Free allowance",
      from: `${saved.allowance} marks`,
      to: `${draft.allowance} marks`,
      money: true,
    });
  }
  const savedRows = { allowance: "0", slabs: saved.slabs };
  if (!sameLate({ allowance: "0", slabs: draft.slabs }, savedRows)) {
    changes.push({ key: "slabs", label: "Deduction slabs", from: slabsText(saved), to: slabsText(draft), money: true });
  }
  return changes;
}

export const capChanges = (draft: CapDraft, saved: CapDraft): Change[] =>
  sameCap(draft, saved)
    ? []
    : [
        {
          key: "cap",
          label: "Permission monthly cap",
          from: `${saved.cap} a month`,
          to: `${draft.cap} a month`,
          money: true,
        },
      ];
