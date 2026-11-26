import type {
  BirthdayOutcome,
  BirthdayRow,
  ClaimKind,
  ClaimOvertime,
  CompensationClaim,
  CompensationWindow,
  HolidayDayKind,
  HolidayWorkMonthDay,
  LedgerRow,
} from "@/lib/api-client/custom-hooks";
import { waitingText } from "@/lib/approval-workflow";
import type { KitTone } from "@/pages/hr/outpass-visitors/kit";
import { addDays, countOf, dateLong, dateShort, fmtShifts, minutesText, parseIso, shiftsText } from "../logic";

// Pure helpers of the one claim workflow (Compensation Leave B: Raise, Claims, Balance, Credits) and of the birthday
// outcomes (C) and the announcements list (A): the words for each kind and status, the source of a claim in a sentence, the
// weeks of the Raise strip and the month a filter steps to. Nothing here reads the clock: today is always passed in.

// ── Kinds and statuses ────────────────────────────────────────────────────────

export const KIND_LABEL: Record<ClaimKind, string> = {
  holiday_work: "Sunday / holiday work",
  ot_allowance: "OT allowance (Type 1)",
  ot_shift: "OT shift credit (Type 2)",
  birthday: "Birthday credit",
  use_balance: "Use of balance",
};

export const KIND_OPTIONS = (Object.keys(KIND_LABEL) as ClaimKind[]).map((value) => ({
  value,
  label: KIND_LABEL[value],
}));

/** The server's label when it sent one, else ours. */
export const kindText = (claim: Pick<CompensationClaim, "kind" | "kindLabel">): string =>
  claim.kindLabel || KIND_LABEL[claim.kind] || claim.kind;

export const CLAIM_STATUS_FILTER = [
  { value: "pending", label: "Waiting for HOD" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export const RAISED_BY_OPTIONS = [
  { value: "employee", label: "Employee (app)" },
  { value: "hr", label: "HR" },
];

export const STATUS_TONE: Record<string, KitTone> = { pending: "indigo", approved: "teal", rejected: "rose" };

/** "Waiting for HOD" (or what the approval pipeline says it waits for), "Approved", "Rejected". */
export function claimStatusText(claim: Pick<CompensationClaim, "status" | "approval">): string {
  if (claim.status === "approved") return "Approved";
  if (claim.status === "rejected") return "Rejected";
  return waitingText(claim.approval) ?? "Waiting for HOD";
}

/** "HR (Meena)" / "Employee (app)". */
export function raisedByText(claim: Pick<CompensationClaim, "raisedByRole" | "requestedBy">): string {
  if (claim.raisedByRole === "employee") return "Employee (app)";
  return claim.requestedBy ? `HR (${claim.requestedBy})` : "HR";
}

/** What was claimed: "30 min late-in" for a Type 1 allowance, else the shifts. */
export function claimAmountText(claim: Pick<CompensationClaim, "kind" | "minutes" | "shifts">): string {
  if (claim.kind === "ot_allowance")
    return claim.minutes ? `${minutesText(claim.minutes)} late-in` : "Late-in allowance";
  return shiftsText(claim.shifts);
}

/** What the date of a claim is, per kind. */
export const DATE_LABEL: Record<ClaimKind, string> = {
  holiday_work: "Work date",
  ot_allowance: "OT date",
  ot_shift: "OT date",
  birthday: "Birthday",
  use_balance: "Day off",
};

/** The word for an employee's own Saturday off: worked, it is claimed like a Sunday (never a "company holiday"). */
export const OFF_SATURDAY = "Off Saturday";

/**
 * The day a Sunday / holiday work claim (or a day of the Raise strip) was worked on: "Sunday", "Off Saturday",
 * "Holiday: Diwali", or `holidayFallback` for a holiday with no name.
 */
export function offDayText(
  kind: HolidayDayKind | null | undefined,
  holidayName: string | null | undefined,
  holidayFallback = "Holiday",
): string {
  if (kind === "off_saturday") return OFF_SATURDAY;
  if (kind === "holiday") return holidayName ? `Holiday: ${holidayName}` : holidayFallback;
  return "Sunday";
}

/** "17:30 to 02:10 next day, 8 h 40 min past the shift end". */
export function overtimeText(o: ClaimOvertime | null | undefined): string | null {
  if (!o) return null;
  const end = o.shiftEnd ?? "?";
  const last = o.lastPunch ? `${o.lastPunch}${o.lastPunchNextDay ? " next day" : ""}` : "?";
  const extra = o.extraMinutes ? `, ${minutesText(o.extraMinutes)} past the shift end` : "";
  return `Shift end ${end}, last punch ${last}${extra}`;
}

/** The line under the date of a claim in the list: the day, the OT times, or what the day off is. */
export function claimDateDetail(claim: CompensationClaim): string {
  switch (claim.kind) {
    case "holiday_work":
      return offDayText(claim.dayKind, claim.holidayName);
    case "ot_allowance":
    case "ot_shift":
      return overtimeText(claim.overtime) ?? "Overtime";
    case "birthday":
      return "Worked on the birthday";
    case "use_balance":
      return "Day off from the balance";
    default:
      return "";
  }
}

/** Who decided and when ("Approved by Suresh Raj, 14 Oct 2026"), or null while it waits. */
export function decisionLine(claim: Pick<CompensationClaim, "status" | "reviewedBy" | "reviewedAt">): string | null {
  if (claim.status === "pending") return null;
  const who = claim.reviewedBy ? ` by ${claim.reviewedBy}` : "";
  const when = claim.reviewedAt ? `, ${dateShort(claim.reviewedAt.slice(0, 10))}` : "";
  return `${claim.status === "approved" ? "Approved" : "Rejected"}${who}${when}`;
}

/** What the claim did once decided: what went into (or came out of) the balance, or the day an allowance applies to. */
export function claimEffectText(claim: CompensationClaim): string {
  if (claim.status === "rejected") return "Rejected: nothing was credited.";
  if (claim.status === "pending") {
    if (claim.kind === "use_balance") return "Nothing is taken off the balance until the Department Head approves it.";
    if (claim.kind === "ot_allowance") return "Nothing is applied until the Department Head approves it.";
    return "Nothing is credited until the Department Head approves it.";
  }
  if (claim.kind === "ot_allowance") {
    return claim.appliesOn
      ? `Applied as a late-in allowance on ${dateLong(claim.appliesOn)} (the next working day).`
      : "Applied as a late-in allowance on the next working day after the OT.";
  }
  const entry = claim.ledger;
  if (claim.kind === "use_balance") {
    return entry
      ? `${shiftsText(entry.shifts)} taken off the balance for ${dateLong(entry.date)}.`
      : `${shiftsText(claim.shifts)} taken off the balance for ${dateLong(claim.workDate)}.`;
  }
  return entry
    ? `${shiftsText(entry.shifts)} added to the balance on ${dateShort(entry.date)}.`
    : claim.credited
      ? `${shiftsText(claim.shifts)} added to the balance.`
      : "Approved: the credit is on its way to the balance.";
}

/** Does this claim put something on the ledger (a credit, or the debit of a use-balance request)? */
export const claimTouchesLedger = (claim: Pick<CompensationClaim, "kind">): boolean => claim.kind !== "ot_allowance";

// ── The Raise strip ───────────────────────────────────────────────────────────

/** The latest Sunday strictly before today (today itself is still being worked). */
export function previousSunday(today: string): string {
  const d = parseIso(today);
  if (!d) return today;
  const dow = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return addDays(today, -(dow === 0 ? 7 : dow));
}

/** The days of the month strip grouped by their week, in the order the server sent them. */
export function groupWeeks(days: readonly HolidayWorkMonthDay[]): { label: string; days: HolidayWorkMonthDay[] }[] {
  const weeks: { label: string; days: HolidayWorkMonthDay[] }[] = [];
  for (const day of days) {
    const label = day.weekLabel || "This month";
    const last = weeks.at(-1);
    if (last && last.label === label) last.days.push(day);
    else weeks.push({ label, days: [day] });
  }
  return weeks;
}

/** The month and year `delta` months away. */
export function stepMonth(month: number, year: number, delta: number): { month: number; year: number } {
  const index = year * 12 + (month - 1) + delta;
  return { month: (index % 12) + 1, year: Math.floor(index / 12) };
}

/** The month (1-12) and year of a date, or null. */
export const monthOf = (iso: string | null | undefined): { month: number; year: number } | null => {
  const d = parseIso(iso);
  return d ? { month: d.month, year: d.year } : null;
};

export const inMonth = (iso: string | null | undefined, month: number, year: number): boolean => {
  const d = parseIso(iso);
  return !!d && d.month === month && d.year === year;
};

/** What a day of the strip is: "Sunday", "Off Saturday", or the holiday's name ("Company holiday" when it has none). */
export function stripDayText(day: Pick<HolidayWorkMonthDay, "kind" | "holidayName">): string {
  if (day.kind === "holiday") return day.holidayName ?? "Company holiday";
  return day.kind === "off_saturday" ? OFF_SATURDAY : "Sunday";
}

/** "4 Sundays", "4 Sundays and 1 holiday", "4 Sundays, 1 holiday and 2 off Saturdays": the days of the strip by kind. */
export function stripKindsText(days: readonly Pick<HolidayWorkMonthDay, "kind">[]): string {
  const count = (kind: HolidayDayKind) => days.filter((d) => d.kind === kind).length;
  const parts = [
    countOf(count("sunday"), "Sunday"),
    count("holiday") > 0 ? countOf(count("holiday"), "holiday") : null,
    count("off_saturday") > 0 ? countOf(count("off_saturday"), "off Saturday") : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
}

/** "3 worked · 2 can be claimed" and "1 waiting · 2 approved" for a day of the strip. */
export function dayCounts(day: HolidayWorkMonthDay): { worked: string; claims: string } {
  const worked = `${day.worked} worked · ${day.eligible} to claim`;
  const parts = [
    day.claimed.pending > 0 ? `${day.claimed.pending} waiting` : null,
    day.claimed.approved > 0 ? `${day.claimed.approved} approved` : null,
  ].filter(Boolean);
  return { worked, claims: parts.length > 0 ? parts.join(" · ") : "No claim yet" };
}

// ── The ledger ────────────────────────────────────────────────────────────────

export const LEDGER_SOURCE_OPTIONS = [
  { value: "holiday_work", label: "Sunday / holiday work" },
  { value: "ot_shift", label: "OT shift credit (Type 2)" },
  { value: "birthday", label: "Birthday credit" },
  { value: "redemption", label: "Day off taken" },
  { value: "legacy_credit", label: "Earlier Alternative-Day credit" },
];

export const ENTRY_TYPE_OPTIONS = [
  { value: "credit", label: "Credits (added)" },
  { value: "debit", label: "Debits (taken off)" },
];

/** What a ledger entry is, in words HR reads. */
export function ledgerSourceText(row: {
  source: string;
  type: LedgerRow["type"];
  claim?: unknown;
  sourceLabel?: string | null;
}): string {
  switch (row.source) {
    case "holiday_work":
      return "Sunday / holiday work (approved by the Department Head)";
    case "ot_shift":
      return "OT shift credit, Type 2 (approved by the Department Head)";
    case "birthday":
      return "Birthday credit (worked on the birthday)";
    case "legacy_credit":
      return row.type === "credit" ? "Earlier Alternative-Day credit" : "Earlier Alternative-Day credit used";
    case "redemption":
      return row.claim ? "Day off from the balance (request approved by the HOD)" : "Redeemed as a day off (by HR)";
    default:
      return row.sourceLabel ?? (row.type === "credit" ? "Added" : "Used");
  }
}

/** "+1" / "−0.50". */
export const signedShifts = (row: { type: LedgerRow["type"]; shifts: number }): string =>
  `${row.type === "credit" ? "+" : "−"}${fmtShifts(row.shifts)}`;

// ── Birthdays ─────────────────────────────────────────────────────────────────

// A worked birthday gives 1.00 day of Birthday Compensation to place in the birthday month (2026-11-25): to place, placed
// (waiting / approved) or lapsed. The credit outcomes stay for the birthday credit claims raised before that day.
export const OUTCOME_META: Record<BirthdayOutcome, { label: string; tone: KitTone }> = {
  paid_leave: { label: "Paid birthday leave", tone: "teal" },
  comp_to_place: { label: "Worked: birthday compensation to place", tone: "amber" },
  comp_placed: { label: "Birthday compensation placed", tone: "indigo" },
  comp_lapsed: { label: "Birthday compensation lapsed", tone: "rose" },
  credit_claimable: { label: "Worked: birthday credit (earlier rule)", tone: "slate" },
  credit_pending: { label: "Birthday credit claim: waiting for HOD", tone: "indigo" },
  credit_approved: { label: "Birthday credit approved", tone: "teal" },
  credit_rejected: { label: "Birthday credit claim rejected", tone: "rose" },
  upcoming: { label: "Upcoming", tone: "slate" },
  off_day: { label: "Off day: no benefit", tone: "slate" },
  not_eligible: { label: "Not eligible", tone: "slate" },
  old_rule: { label: "Paid leave (old rule)", tone: "slate" },
};

/** The outcome filter: what a birthday can give now, then the older credit claims (still listed and decided). A worked
 * birthday is never "a credit to claim" any more, so those two values are not offered. */
const OUTCOME_FILTER_ORDER: BirthdayOutcome[] = [
  "paid_leave",
  "comp_to_place",
  "comp_placed",
  "comp_lapsed",
  "credit_pending",
  "credit_approved",
  "upcoming",
  "off_day",
  "not_eligible",
  "old_rule",
];

export const OUTCOME_OPTIONS = OUTCOME_FILTER_ORDER.map((value) => ({ value, label: OUTCOME_META[value].label }));

/** The outcome of a birthday row (an older backend sends none: a benefit then is the old automatic leave). */
export function outcomeOf(row: Pick<BirthdayRow, "outcome" | "benefits">): BirthdayOutcome {
  if (row.outcome && row.outcome in OUTCOME_META) return row.outcome;
  return row.benefits ? "old_rule" : "not_eligible";
}

/** The words of a row's outcome: ours for a value this page knows (the tiles and the filter say the same), else the
 * server's label. */
export function outcomeText(row: Pick<BirthdayRow, "outcome" | "outcomeLabel" | "benefits">): string {
  if (row.outcome && row.outcome in OUTCOME_META) return OUTCOME_META[row.outcome].label;
  return row.outcomeLabel || OUTCOME_META[outcomeOf(row)].label;
}

/** Can HR place Birthday Compensation for the employee now ("Choose date for employee")? Only on the server's word. */
export const canPlaceBirthday = (row: Pick<BirthdayRow, "canPlace">): boolean => row.canPlace === true;

// ── Announcements ─────────────────────────────────────────────────────────────

export type WindowWhen = "today" | "upcoming" | "past";

export const windowWhen = (date: string, today: string): WindowWhen =>
  date === today ? "today" : date > today ? "upcoming" : "past";

export const WINDOW_KIND_OPTIONS = [
  { value: "late_in", label: "Late-in" },
  { value: "early_out", label: "Early-out" },
  { value: "day", label: "Compensation Day (older kind)" },
];

export const WINDOW_STATUS_OPTIONS = [
  { value: "upcoming", label: "Today and upcoming" },
  { value: "past", label: "Past" },
];

/** Why Delete is greyed out on a row the server will not let HR remove, when it does not say. */
export const DELETE_BLOCKED = "This announcement cannot be removed.";

/** The tooltip of a row's Delete: the pause, else why the server will not let it be removed, else what it does. */
export function deleteTitle(
  row: Pick<CompensationWindow, "date" | "canDelete" | "deleteBlockedReason">,
  paused: boolean,
  pausedReason: string,
): string {
  if (paused) return pausedReason;
  if (!row.canDelete) return row.deleteBlockedReason?.trim() || DELETE_BLOCKED;
  return `Delete the announcement of ${dateLong(row.date)}`;
}
