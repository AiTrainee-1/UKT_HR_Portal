import type {
  BirthdayCompBlock,
  BirthdayCompDay,
  BirthdayCompPortion,
  BirthdayCompStatusKey,
  BirthdayCompUse,
  BirthdayCompUseBrief,
} from "@/lib/api-client/custom-hooks";
import type { KitTone } from "@/pages/hr/outpass-visitors/kit";
import { dayMonth } from "../logic";

// Pure helpers of Birthday Compensation on a chosen date (owner 2026-11-25), as the Birthdays page shows it: a worked
// birthday gives 1.00 day to place on working days of the birthday month, as a full day or a first / second half (two halves
// may go on two different dates). The server says which day takes which part and why a day cannot be chosen; these helpers
// only put that into words, keep the choice inside what is left, and lay the month out Monday first.

export const PORTIONS: readonly BirthdayCompPortion[] = ["full", "first_half", "second_half"];

export const PORTION_TEXT: Record<BirthdayCompPortion, string> = {
  full: "Full day",
  first_half: "First half",
  second_half: "Second half",
};

export const PORTION_DAYS: Record<BirthdayCompPortion, number> = { full: 1, first_half: 0.5, second_half: 0.5 };

/** The server's limit on the optional reason. */
export const REASON_MAX = 500;

const EPS = 1e-9;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "1.00", "0.50": a day amount the way the server writes it. */
export const daysNumber = (n: number | null | undefined): string => round2(Number(n) || 0).toFixed(2);

/** "1.00 day", "0.50 day", "2.00 days". */
export const daysWord = (n: number | null | undefined): string =>
  `${daysNumber(n)} ${round2(Number(n) || 0) > 1 ? "days" : "day"}`;

/** What is still to place: the total less what waits and what was approved (never below 0). */
export function leftToPlace(days: { total: number; held: number; used: number } | null | undefined): number {
  if (!days) return 0;
  return Math.max(0, round2(days.total - days.held - days.used));
}

/** The parts a day can take within what is left (0.50 left: halves only). The server limits them too. */
export const portionsFor = (day: Pick<BirthdayCompDay, "portions">, left: number): BirthdayCompPortion[] =>
  PORTIONS.filter((p) => day.portions.includes(p) && PORTION_DAYS[p] <= left + EPS);

/** Why a part cannot be placed on this day (for its greyed-out button), or null when it can. */
export function portionProblem(
  day: Pick<BirthdayCompDay, "portions" | "reason">,
  portion: BirthdayCompPortion,
  left: number,
): string | null {
  if (PORTION_DAYS[portion] > left + EPS) {
    return `Only ${daysWord(left)} is left to place: choose a first or second half.`;
  }
  if (!day.portions.includes(portion)) {
    const offered = PORTIONS.filter((p) => day.portions.includes(p)).map((p) => PORTION_TEXT[p].toLowerCase());
    return offered.length > 0
      ? `Only ${offered.join(" or ")} can be placed on this day.`
      : (day.reason ?? "This day cannot be chosen.");
  }
  return null;
}

/** The part picked when a day is chosen: the server's suggestion when it fits, else the first part that does. */
export function defaultPortion(
  day: Pick<BirthdayCompDay, "portions" | "suggested">,
  left: number,
): BirthdayCompPortion | null {
  const fits = portionsFor(day, left);
  if (day.suggested && fits.includes(day.suggested)) return day.suggested;
  return fits[0] ?? null;
}

/** Can this day be picked now (it takes a part, within what is left)? */
export const canPick = (day: Pick<BirthdayCompDay, "portions">, left: number): boolean =>
  portionsFor(day, left).length > 0;

/** Why a day cannot be picked: the server's reason, else that what is left does not fit it. */
export function dayProblem(day: Pick<BirthdayCompDay, "portions" | "reason" | "label">, left: number): string | null {
  if (canPick(day, left)) return null;
  if (day.portions.length > 0) return `Only ${daysWord(left)} is left to place, and this day takes a full day only.`;
  return day.reason ?? `${day.label}: this day cannot be chosen.`;
}

/** The month Monday first, as weeks of seven cells (null = a day of the month before / after). */
export function monthWeeks(days: readonly BirthdayCompDay[]): (BirthdayCompDay | null)[][] {
  if (days.length === 0) return [];
  const [y, m, d] = days[0].date.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (BirthdayCompDay | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** The short word under a day's number in the calendar. */
export const DAY_MARK: Record<string, string> = {
  future: "",
  today: "Today",
  absent: "Absent",
  on_leave: "Leave",
  half_shift: "Half",
  present: "Worked",
  holiday: "Holiday",
  birthday: "Birthday",
  off_day: "Off",
  not_joined: "Not joined",
  locked: "Locked",
  casual_leave: "CL",
  compensation: "Comp",
  none: "",
};

/** The open placements on a day ("BC" for a full day, "½ BC" / "BC ½" for a half), or null. */
export function placedMark(day: Pick<BirthdayCompDay, "placed">): string | null {
  const open = (day.placed ?? []).filter((p) => p.status === "pending" || p.status === "approved");
  if (open.length === 0) return null;
  if (open.some((p) => p.portion === "full")) return "BC";
  const first = open.some((p) => p.portion === "first_half");
  const second = open.some((p) => p.portion === "second_half");
  return first && second ? "BC" : first ? "½ BC" : "BC ½";
}

// ── the uses ──────────────────────────────────────────────────────────────────

export const USE_TONE: Record<BirthdayCompStatusKey, KitTone> = {
  pending: "indigo",
  pending_hr: "amber",
  approved: "teal",
  rejected: "rose",
  withdrawn: "slate",
};

export const USE_STATUS_TEXT: Record<BirthdayCompStatusKey, string> = {
  pending: "Waiting for the Department Head",
  pending_hr: "Approved by the Department Head, waiting for HR",
  approved: "Approved",
  rejected: "Not approved",
  withdrawn: "Withdrawn",
};

const keyOf = (u: Pick<BirthdayCompUseBrief, "status" | "statusKey">): BirthdayCompStatusKey =>
  (u.statusKey in USE_TONE ? u.statusKey : u.status) as BirthdayCompStatusKey;

export const placementTone = (u: Pick<BirthdayCompUseBrief, "status" | "statusKey">): KitTone =>
  USE_TONE[keyOf(u)] ?? "slate";

/** The server's words for the status ("Approved: first half paid on 3 Mar"), else ours. */
export const placementStatusText = (u: Pick<BirthdayCompUseBrief, "status" | "statusKey" | "statusLabel">): string =>
  u.statusLabel || USE_STATUS_TEXT[keyOf(u)] || u.status;

/** "3 Mar · first half". */
export const placementWhenText = (u: Pick<BirthdayCompUseBrief, "useDate" | "portion" | "portionLabel">): string =>
  `${dayMonth(u.useDate)} · ${(u.portionLabel || PORTION_TEXT[u.portion] || u.portion).toLowerCase()}`;

/** "HR (Meena)" / "Employee (app)". */
export const placementRaisedText = (u: Pick<BirthdayCompUse, "raisedByRole" | "requestedBy">): string =>
  u.raisedByRole === "employee" ? "Employee (app)" : u.requestedBy ? `HR (${u.requestedBy})` : "HR";

/** HR's turn on a waiting use (after the Department Head): HR decides it in Requests. */
export const waitsForHr = (u: Pick<BirthdayCompUse, "status" | "statusKey" | "approval">): boolean =>
  u.status === "pending" && (u.statusKey === "pending_hr" || !!u.approval?.hrTurn);

/** The Requests page with this use's details open (HR's decision lives there). */
export const requestsLink = (id: number): string => `/hr/requests?kind=birthday_compensation&focus=${id}`;

// ── a row of the Birthdays list ───────────────────────────────────────────────

/** Does the row's `birthdayCompensation` block have a placement to show (to place, placed, lapsed)? */
export const showsPlacement = (block: BirthdayCompBlock | null | undefined): block is BirthdayCompBlock =>
  !!block && (block.state === "available" || block.state === "placed" || block.state === "lapsed");

/** "0.50 of 1.00 day placed", with what is left or what lapsed: the line under a row's outcome. */
export function placementSummary(block: BirthdayCompBlock): string {
  const placed = round2(block.held + block.used);
  const head = `${daysNumber(placed)} of ${daysWord(block.total)} placed`;
  if (block.state === "lapsed") return `${head} · ${daysWord(block.lapsed)} lapsed on ${dayMonth(block.lapsesOn)}`;
  if (block.state === "available")
    return `${head} · ${daysWord(block.available)} to place by ${dayMonth(block.lapsesOn)}`;
  return head;
}
