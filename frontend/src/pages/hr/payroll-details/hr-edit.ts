// The "!" on a calendar day HR edited (owner 2026-11-02): what was changed and where its approval stands, in words. The
// server decides everything (api/hr_edit_marks.py); this only words and colours what it sent.

import { dateTime } from "@/components/payroll/kit/format";
import type { HrEdit, HrEditSide, HrEditStatus, PayrollDay } from "@/lib/api-client/custom-hooks";
import { trimNumber } from "./logic";

export type HrEditTone = "waiting" | "applied" | "rejected";

/** Waiting (for the Department Head or for HR), applied, or rejected. */
export const hrEditTone = (status: HrEditStatus | string | null | undefined): HrEditTone =>
  status === "applied" ? "applied" : status === "rejected" ? "rejected" : "waiting";

/** The colours of each state: amber while it waits, green once applied, rose when rejected. The day's own colour on the
 *  payroll calendar never changes (the owner asked for a different colour only in the employee apps). */
export const HR_EDIT_TONE: Record<HrEditTone, { badge: string; soft: string; chip: string; word: string }> = {
  waiting: {
    badge: "bg-amber-500 text-white",
    soft: "border-amber-200 bg-amber-50 text-amber-950",
    chip: "bg-amber-100 text-amber-900",
    word: "Waiting for approval",
  },
  applied: {
    badge: "bg-emerald-600 text-white",
    soft: "border-emerald-200 bg-emerald-50 text-emerald-950",
    chip: "bg-emerald-100 text-emerald-900",
    word: "Applied",
  },
  rejected: {
    badge: "bg-rose-600 text-white",
    soft: "border-rose-200 bg-rose-50 text-rose-950",
    chip: "bg-rose-100 text-rose-900",
    word: "Rejected",
  },
};

/** "Present (1 shift)", "Half Day (0.5 shifts)", "Absent" (no shifts named when there are none). */
export function sideText(side: HrEditSide | null | undefined): string {
  const label = side?.label?.trim() || "Not recorded";
  const shifts = side?.shifts;
  if (shifts === null || shifts === undefined || shifts === 0) return label;
  return `${label} (${trimNumber(shifts)} ${shifts === 1 ? "shift" : "shifts"})`;
}

/** "Present (1 shift) → Half Day (0.5 shifts)". */
export const changeText = (edit: Pick<HrEdit, "from" | "to">): string =>
  `${sideText(edit.from)} → ${sideText(edit.to)}`;

/** "Meena · 2 Nov 2026, 10:15" / "Meena" / "2 Nov 2026, 10:15" / null. */
export function whoWhen(who: string | null | undefined, when: string | null | undefined): string | null {
  const name = who?.trim() || "";
  const at = when ? dateTime(when) : "";
  const moment = at && at !== "—" ? at : "";
  if (name && moment) return `${name} · ${moment}`;
  return name || moment || null;
}

/** The accessible name of the "!": "HR edit: Half Day. Waiting for Department Head (Suresh Raj)". */
export const hrEditLabel = (edit: Pick<HrEdit, "typeLabel" | "stageLabel">): string =>
  `HR edit: ${edit.typeLabel || "attendance changed"}. ${edit.stageLabel}`.trim();

/** A day's HR edit, or null. */
export const hrEditOf = (day: Pick<PayrollDay, "hrEdit"> | null | undefined): HrEdit | null => day?.hrEdit ?? null;

/** How many days carry an HR edit in each state. */
export function hrEditCounts(days: Pick<PayrollDay, "hrEdit">[]): Record<HrEditTone, number> {
  const out: Record<HrEditTone, number> = { waiting: 0, applied: 0, rejected: 0 };
  for (const d of days) if (d.hrEdit) out[hrEditTone(d.hrEdit.status)] += 1;
  return out;
}
