import type {
  CompensationClaim,
  PlacementCalendar,
  PlacementDay,
  PlacementItem,
  PlacementSource,
  PlacementSourceKey,
} from "@/lib/api-client/custom-hooks";
import { hrCanAct, hrCanReject } from "@/lib/approval-workflow";
import type { KitTone } from "@/pages/hr/outpass-visitors/kit";
import { dateShort, parseIso } from "../logic";

// Pure helpers of compensation days on a date HR chooses (owner brief 2026-11-28; the dialog is PlaceCompDialog). HR places
// Shift / Overtime / Sunday / Holiday work compensation, or the balance as a whole, on a working day of a calendar month; the
// server says which day takes how much and why a day cannot be chosen. These helpers only put that into words, keep the
// choice inside what is left (and, for a day off worked, inside the credit HR chose), and lay the month out Monday first.

const EPS = 1e-9;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The server's limit on the optional reason when it does not send one. */
export const REASON_MAX_DEFAULT = 500;

/** "0.50", "1.00": an amount the way the server writes it. */
export const shiftNumber = (n: number | null | undefined): string => round2(Number(n) || 0).toFixed(2);

/** "0.50 shift", "1.00 shift", "1.50 shifts" (the server's own wording: one shift or less is "shift"). */
export const shiftWord = (n: number | null | undefined): string =>
  `${shiftNumber(n)} ${round2(Number(n) || 0) > 1 ? "shifts" : "shift"}`;

/** What each amount is, in words, under its number on the amount buttons. */
export const AMOUNT_TEXT: Record<string, string> = {
  "0.25": "Quarter shift",
  "0.50": "Half shift",
  "0.75": "Three quarters",
  "1.00": "Full shift",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 2 Dec": the day in the summary sentence. */
export function dayText(iso: string | null | undefined): string {
  const d = parseIso(iso);
  if (!d) return "—";
  return `${WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]} ${d.day} ${MONTHS[d.month - 1]}`;
}

// ── the source ────────────────────────────────────────────────────────────────

/** The string form of a source, as the calendar is asked for it: "overtime:12", "holiday_work:2026-11-22", "claim:40",
 *  "balance". */
export const overtimeSource = (recordId: number): string => `overtime:${recordId}`;
export const holidayWorkSource = (date: string): string => `holiday_work:${date}`;
export const claimSource = (claimId: number): string => `claim:${claimId}`;
export const BALANCE_SOURCE = "balance";

/** The source as the POST body wants it ({type, id} / {type, date} / {type}): the one the calendar answered for. */
export function sourceKeyOfCalendar(source: Pick<PlacementSource, "type" | "id" | "date">): PlacementSourceKey {
  if (source.type === "holiday_work") return { type: source.type, date: source.date };
  if (source.type === "balance") return { type: source.type };
  return { type: source.type, id: source.id };
}

/**
 * What can be placed now: what the source has left, and for a day off worked never more than the credit HR chose for it
 * (`credit`; 1.00 by default). Never below 0.
 */
export function capOf(source: Pick<PlacementSource, "left" | "creditFixed" | "canPlace">, credit: number): number {
  if (!source.canPlace) return 0;
  const left = Math.max(0, round2(source.left));
  return source.creditFixed ? left : Math.min(left, round2(credit));
}

/** The credit the source gives when HR places it: the credit HR chose for a day off worked, else its total. */
export const creditOf = (source: Pick<PlacementSource, "total" | "creditFixed">, credit: number): number =>
  source.creditFixed ? round2(source.total) : round2(credit);

// ── the days ──────────────────────────────────────────────────────────────────

/** The amounts a day can take within `cap` (the server already keeps them within what the source has left). */
export const amountsFor = (day: Pick<PlacementDay, "amounts">, cap: number): number[] =>
  (day.amounts ?? []).filter((a) => a <= cap + EPS);

/** Can this day be picked now? */
export const canPick = (day: Pick<PlacementDay, "amounts">, cap: number): boolean => amountsFor(day, cap).length > 0;

/** The amount picked when a day is chosen: the server's suggestion when it fits, else the most that does. */
export function defaultAmount(day: Pick<PlacementDay, "amounts" | "suggested">, cap: number): number | null {
  const fits = amountsFor(day, cap);
  if (day.suggested !== null && day.suggested !== undefined && fits.some((a) => Math.abs(a - day.suggested!) < EPS))
    return day.suggested;
  return fits.length > 0 ? Math.max(...fits) : null;
}

/** Why a day cannot be picked: the server's reason, else that what is left does not fit it. */
export function dayProblem(day: Pick<PlacementDay, "amounts" | "reason" | "label">, cap: number): string | null {
  if (canPick(day, cap)) return null;
  if ((day.amounts ?? []).length > 0) return `Only ${shiftWord(cap)} is left to place, and this day takes more.`;
  return day.reason ?? `${day.label || "This day"}: it cannot be chosen.`;
}

/** Why an amount cannot be placed on this day (for its greyed-out button), or null when it can. */
export function amountProblem(
  day: Pick<PlacementDay, "amounts" | "reason">,
  amount: number,
  cap: number,
): string | null {
  if (amount > cap + EPS) return `Only ${shiftWord(cap)} is left to place.`;
  const amounts = day.amounts ?? [];
  if (!amounts.some((a) => Math.abs(a - amount) < EPS)) {
    return amounts.length > 0
      ? `This day can take at most ${shiftWord(Math.max(...amounts))}.`
      : (day.reason ?? "This day cannot be chosen.");
  }
  return null;
}

/** The month Monday first, as weeks of seven cells (null = a day of the month before / after). */
export function monthWeeks<T extends { date: string }>(days: readonly T[]): (T | null)[][] {
  if (days.length === 0) return [];
  const d = parseIso(days[0].date);
  if (!d) return [];
  const lead = (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (T | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** The short word under a day's number in the calendar. */
export const DAY_MARK: Record<string, string> = {
  future: "",
  today: "Today",
  absent: "Absent",
  half_shift: "Half",
  present: "Worked",
  on_leave: "Leave",
  holiday: "Holiday",
  off_day: "Off",
  locked: "Locked",
  out_of_window: "",
  not_joined: "Not joined",
  placed: "Comp",
  casual_leave: "CL",
  birthday_comp: "BC",
  none: "",
};

/** "Comp" when a placement waits or was approved on the day, else null. */
export const placedMark = (day: Pick<PlacementDay, "placed">): string | null =>
  (day.placed ?? []).some((p) => p.status === "pending" || p.status === "approved") ? "Comp" : null;

// ── what the dialog says ──────────────────────────────────────────────────────

/** "Asha K takes 0.50 shift off on Wed 2 Dec. It goes to the Department Head, then HR." */
export const summaryText = (employeeName: string, amount: number, date: string): string =>
  `${employeeName} takes ${shiftWord(amount)} off on ${dayText(date)}. It goes to the Department Head, then HR.`;

/**
 * What happens to the rest when less than the source gives is placed: the rest of a credit placed at once stays in the
 * balance, the rest of an approved credit or of the balance can be placed later. Null when nothing is left over.
 */
export function restText(
  source: Pick<PlacementSource, "type" | "total" | "left" | "creditFixed" | "placesAtOnce">,
  credit: number,
  amount: number,
): string | null {
  if (source.placesAtOnce) {
    const rest = round2(creditOf(source, credit) - amount);
    return rest > EPS
      ? `The credit is ${shiftWord(creditOf(source, credit))}: the rest (${shiftWord(rest)}) stays in the balance.`
      : null;
  }
  const rest = round2(source.left - amount);
  if (rest <= EPS) return null;
  return source.type === "claim"
    ? `${shiftWord(rest)} of this credit stays in the balance, to place later.`
    : `${shiftWord(rest)} of the balance stays, to place later.`;
}

/** The figures of the source in a line: "Total 1.00 · placed 0.25 · left 0.75". */
export const sourceFiguresText = (source: Pick<PlacementSource, "total" | "placed" | "left">): string =>
  `Total ${shiftNumber(source.total)} · placed ${shiftNumber(source.placed)} · left ${shiftNumber(source.left)}`;

/** Why Send cannot be used whatever day is picked (the first that applies), or null. */
export function blockReason(
  cal: Pick<PlacementCalendar, "hodProblem" | "workflowOn" | "source">,
  rightProblem: string | null,
): string | null {
  if (!cal.workflowOn) return WORKFLOW_OFF;
  if (cal.source.refusal) return cal.source.refusal;
  if (!cal.source.canPlace) return "Nothing can be placed from this now.";
  if (cal.hodProblem) return cal.hodProblem;
  return rightProblem;
}

export const WORKFLOW_OFF =
  "Compensation days on chosen dates are switched off in User Management → Approval Workflow Control, so a date can't be chosen right now.";

// ── the open placements ───────────────────────────────────────────────────────

/** waiting for the Department Head = indigo, waiting for HR = amber, approved = teal, rejected = rose. */
export function placementTone(p: Pick<PlacementItem, "status" | "stage">): KitTone {
  if (p.status === "pending") return p.stage === "hr" ? "amber" : "indigo";
  if (p.status === "approved") return "teal";
  if (p.status === "rejected") return "rose";
  return "slate";
}

const STATUS_TEXT: Record<string, string> = {
  approved: "Approved",
  rejected: "Not approved",
  withdrawn: "Withdrawn",
};

/** The server's words for the status, else ours. */
export function placementStatusText(p: Pick<PlacementItem, "status" | "stage" | "statusLabel">): string {
  if (p.statusLabel) return p.statusLabel;
  if (p.status === "pending")
    return p.stage === "hr" ? "Approved by the Department Head, waiting for HR" : "Waiting for the Department Head";
  return STATUS_TEXT[p.status] ?? p.status;
}

/** "HR (Meena)" / "Employee (app)". */
export const placedByText = (p: Pick<PlacementItem, "raisedByRole" | "requestedBy">): string =>
  p.raisedByRole === "employee" ? "Employee (app)" : p.requestedBy ? `HR (${p.requestedBy})` : "HR";

/** HR's turn on a date HR chose (after the Department Head): HR decides it in Requests or in Claims. */
export const waitsForHr = (p: Pick<PlacementItem, "status" | "stage" | "hrStep">): boolean =>
  p.hrStep && p.status === "pending" && p.stage === "hr";

/** The Requests page with this placement's details open (HR's decision lives there too). */
export const placementRequestsLink = (id: number): string => `/hr/requests?kind=compensation_placement&focus=${id}`;

// ── a row of the Claims list ──────────────────────────────────────────────────

const CREDIT_KINDS = new Set(["holiday_work", "ot_shift", "birthday"]);

/** An approved credit with some still to place: "Choose date" places it (source `claim:<id>`). */
export const canChooseDateFor = (c: Pick<CompensationClaim, "kind" | "status" | "leftToPlace">): boolean =>
  CREDIT_KINDS.has(c.kind) && c.status === "approved" && (c.leftToPlace ?? 0) > EPS;

/** "Day off on 2 Dec 2026 · 0.50 shift" for a date HR chose; null for any other claim. */
export function placedDayLine(c: Pick<CompensationClaim, "hrStep" | "useDate" | "useShifts">): string | null {
  if (!c.hrStep || !c.useDate) return null;
  return `Day off on ${dateShort(c.useDate)}${c.useShifts != null ? ` · ${shiftWord(c.useShifts)}` : ""}`;
}

/** The stage of a date HR chose, while it waits ("Approved by the Department Head, waiting for HR"); else null. */
export function placementStageText(
  c: Pick<CompensationClaim, "hrStep" | "status" | "stage" | "statusLabel">,
): string | null {
  if (!c.hrStep || c.status !== "pending") return null;
  if (c.statusLabel) return c.statusLabel;
  return c.stage === "hr" ? "Approved by the Department Head, waiting for HR" : "Waiting for the Department Head";
}

/**
 * The status chip of a date HR chose while it waits, kept short for the list: where it waits ("Waiting for HR"), the
 * server's whole sentence as its tooltip, and what is already done ("Approved by the Department Head") for the line
 * under it. Null for any other claim.
 */
export function placementChip(
  c: Pick<CompensationClaim, "hrStep" | "status" | "stage" | "statusLabel">,
): { text: string; title: string; done: string | null } | null {
  const label = placementStageText(c);
  if (!label) return null;
  return c.stage === "hr"
    ? { text: "Waiting for HR", title: label, done: "Approved by the Department Head" }
    : { text: "Waiting for the Department Head", title: label, done: null };
}

/** May HR approve / reject this date HR chose right now (the Department Head approved, and the login may decide)? */
export const hrMayApprovePlacement = (c: Pick<CompensationClaim, "hrStep" | "status" | "approval">): boolean =>
  !!c.hrStep && c.status === "pending" && hrCanAct(c.approval, false);

export const hrMayRejectPlacement = (c: Pick<CompensationClaim, "hrStep" | "status" | "approval">): boolean =>
  !!c.hrStep && c.status === "pending" && hrCanReject(c.approval, false);
