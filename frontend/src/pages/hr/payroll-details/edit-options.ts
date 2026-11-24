// The Edit Attendance form's options (2026-11-02): the server's catalogue in groups (Worked / Compensation / Not worked, then
// Permission / Late / Early-Out / Casual Leave / Leave / On-Duty / Missing Punch / Penalty Waiver / OT Pay), what each tile
// says, whether it can be chosen for the day, and the proposal it sends. Kept apart from the form so it can be tested on its
// own. The server decides availability and applies the change (api/attendance_edit.py); nothing here is a rule of its own.
// 2026-11-24: a day whose payroll is finalized (Payroll Done) is locked; the compensation types use the compensation
// balance; Leave sends its part of the day, Missing Punch its time and OT Pay its shifts.

import type {
  AttendanceEditChoice,
  AttendanceEditContext,
  AttendanceEditGroup,
  AttendanceEditGroupKey,
  AttendanceEditItem,
  AttendanceEditProposal,
  AttendanceEditType,
  CasualLeaveBalance,
} from "@/lib/api-client/custom-hooks";

/** The three groups the form always had (one tile per attendance type) ... */
export const CLASSIC_GROUPS: readonly AttendanceEditGroupKey[] = ["worked", "compensation", "not_worked"];
/** ... and the ones added on 2026-11-02 and 2026-11-24 (one tile per sub-choice), in the server's order. */
export const OPTION_GROUPS: readonly AttendanceEditGroupKey[] = [
  "permission",
  "late",
  "early_out",
  "casual_leave",
  "leave",
  "on_duty",
  "missing_punch",
  "penalty_waiver",
  "ot_pay",
];

export const isClassicGroup = (key: string): boolean => (CLASSIC_GROUPS as readonly string[]).includes(key);

const TYPE_GROUP: Record<AttendanceEditType["group"], AttendanceEditGroupKey> = {
  Attendance: "worked",
  Compensation: "compensation",
  Other: "not_worked",
};

/** The look and the short line under each group's title. The first three keep the colours they always had. `solid` is
 *  the chosen button of a picker in the details (the shift value, the part of the day). */
export const GROUP_LOOK: Record<
  AttendanceEditGroupKey,
  { title: string; hint: string; tile: string; on: string; chip: string; solid: string }
> = {
  worked: {
    title: "Worked",
    hint: "How much of the day was worked",
    tile: "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40",
    on: "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200",
    chip: "bg-indigo-100 text-indigo-800",
    solid: "bg-indigo-600 text-white",
  },
  compensation: {
    title: "Compensation",
    hint: "Uses the compensation balance, up to a full day",
    tile: "border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/40",
    on: "border-violet-500 bg-violet-50 ring-2 ring-violet-200",
    chip: "bg-violet-100 text-violet-800",
    solid: "bg-violet-600 text-white",
  },
  not_worked: {
    title: "Not worked",
    hint: "Absent or a holiday",
    tile: "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50",
    on: "border-slate-600 bg-slate-100 ring-2 ring-slate-300",
    chip: "bg-slate-200 text-slate-700",
    solid: "bg-slate-700 text-white",
  },
  permission: {
    title: "Permission",
    hint: "Counts as an approved permission (uses the monthly allowance)",
    tile: "border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50/40",
    on: "border-blue-500 bg-blue-50 ring-2 ring-blue-200",
    chip: "bg-blue-100 text-blue-800",
    solid: "bg-blue-600 text-white",
  },
  late: {
    title: "Late",
    hint: "Mark the day Late, or take its Late mark away",
    tile: "border-slate-200 bg-white hover:border-amber-300 hover:bg-amber-50/40",
    on: "border-amber-500 bg-amber-50 ring-2 ring-amber-200",
    chip: "bg-amber-100 text-amber-900",
    solid: "bg-amber-600 text-white",
  },
  early_out: {
    title: "Early-Out",
    hint: "Mark the day Early-Out, or take its Early-Out mark away",
    tile: "border-slate-200 bg-white hover:border-orange-300 hover:bg-orange-50/40",
    on: "border-orange-500 bg-orange-50 ring-2 ring-orange-200",
    chip: "bg-orange-100 text-orange-900",
    solid: "bg-orange-600 text-white",
  },
  casual_leave: {
    title: "Casual Leave",
    hint: "Paid leave from the employee's yearly balance",
    tile: "border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50/40",
    on: "border-sky-500 bg-sky-50 ring-2 ring-sky-200",
    chip: "bg-sky-100 text-sky-900",
    solid: "bg-sky-600 text-white",
  },
  leave: {
    title: "Leave",
    hint: "An approved leave with its reason (not paid)",
    tile: "border-slate-200 bg-white hover:border-rose-300 hover:bg-rose-50/40",
    on: "border-rose-500 bg-rose-50 ring-2 ring-rose-200",
    chip: "bg-rose-100 text-rose-900",
    solid: "bg-rose-600 text-white",
  },
  on_duty: {
    title: "On-Duty",
    hint: "Worked away from the branch: Present, and an On-Duty record is added",
    tile: "border-slate-200 bg-white hover:border-teal-300 hover:bg-teal-50/40",
    on: "border-teal-500 bg-teal-50 ring-2 ring-teal-200",
    chip: "bg-teal-100 text-teal-900",
    solid: "bg-teal-600 text-white",
  },
  missing_punch: {
    title: "Missing Punch",
    hint: "Add the punch the device missed",
    tile: "border-slate-200 bg-white hover:border-cyan-300 hover:bg-cyan-50/40",
    on: "border-cyan-500 bg-cyan-50 ring-2 ring-cyan-200",
    chip: "bg-cyan-100 text-cyan-900",
    solid: "bg-cyan-600 text-white",
  },
  penalty_waiver: {
    title: "Penalty Waiver",
    hint: "Take back the day's Penalty Early-Out deduction",
    tile: "border-slate-200 bg-white hover:border-lime-300 hover:bg-lime-50/40",
    on: "border-lime-500 bg-lime-50 ring-2 ring-lime-200",
    chip: "bg-lime-100 text-lime-900",
    solid: "bg-lime-700 text-white",
  },
  ot_pay: {
    title: "OT Pay",
    hint: "Pay the day's detected overtime",
    tile: "border-slate-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/40",
    on: "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200",
    chip: "bg-emerald-100 text-emerald-900",
    solid: "bg-emerald-600 text-white",
  },
};

/** The look of a group the page does not know (a newer server): plain slate. */
const PLAIN_LOOK = GROUP_LOOK.not_worked;
export const groupLook = (group: Pick<AttendanceEditGroup, "key" | "label" | "description">) =>
  GROUP_LOOK[group.key] ?? { ...PLAIN_LOOK, title: group.label, hint: group.description };

/** An old attendance type as an item of the catalogue (an older server sends only `types`). */
export function typeAsItem(t: AttendanceEditType): AttendanceEditItem {
  const group = TYPE_GROUP[t.group] ?? "not_worked";
  return {
    key: t.key,
    label: t.label,
    group,
    groupLabel: GROUP_LOOK[group].title,
    description: t.description,
    status: t.status,
    shifts: t.shifts,
    shiftChoices: t.shiftChoices,
    choices: [],
    choiceRequired: false,
    worked: t.worked,
    compensation: t.compensation,
    staffOnly: false,
    available: true,
    unavailableReason: null,
  };
}

/** The groups the form draws: the server's catalogue, or (an older server) the three first groups built from `types`. */
export function editGroups(ctx: Pick<AttendanceEditContext, "types" | "options">): AttendanceEditGroup[] {
  if (ctx.options && ctx.options.length > 0) return ctx.options.filter((g) => g.items.length > 0);
  return CLASSIC_GROUPS.map((key) => ({
    key,
    label: GROUP_LOOK[key].title,
    description: GROUP_LOOK[key].hint,
    items: (ctx.types ?? []).filter((t) => (TYPE_GROUP[t.group] ?? "not_worked") === key).map(typeAsItem),
  })).filter((g) => g.items.length > 0);
}

/** What is chosen: an item, and its sub-choice when it has them. */
export type EditPick = { itemKey: string; choice: string | null };

/** One tile of a group: an item with sub-choices gives a tile per choice; an item without gives one tile. */
export type EditTile = {
  id: string;
  testId: string;
  item: AttendanceEditItem;
  choice: AttendanceEditChoice | null;
  label: string;
  chip: string;
  description: string;
  available: boolean;
  /** Why it cannot be chosen, when that is not already said once for the whole group. */
  reason: string | null;
};

/** "Morning Late-In", "Evening Early-Out", "Middle One-Hour" (the server calls the last one "... Permission"). */
export function choiceLabel(
  item: Pick<AttendanceEditItem, "group">,
  choice: Pick<AttendanceEditChoice, "label">,
): string {
  return item.group === "permission" ? choice.label.replace(/\s+Permission$/i, "") : choice.label;
}

/** "1 day", "0.5 day" (Casual Leave is never more than a day per tile). */
const daysText = (days: number): string => `${Math.round(days * 100) / 100} ${days > 1 ? "days" : "day"}`;

/** "0.25 to 1.00 shift", "0.25 to 0.50 shift", "0.50 shift": the amounts that may be chosen (the server lists only the
 *  ones that fit). */
export function shiftRange(choices: readonly string[]): string {
  if (choices.length === 0) return "";
  if (choices.length === 1) return `${choices[0]} shift`;
  return `${choices[0]} to ${choices[choices.length - 1]} shift`;
}

/** The small chip on a tile: the shift value, the permission's length, the days of Casual Leave ... */
export function tileChip(item: AttendanceEditItem, choice: AttendanceEditChoice | null): string {
  if (choice) {
    if (item.group === "late") return choice.value === "unmark" ? "Late mark removed" : "Counts as a Late";
    if (item.group === "early_out")
      return choice.value === "unmark" ? "Early-Out mark removed" : "Counts as an Early-Out";
    if (item.group === "missing_punch") return choice.value.endsWith("_in") ? "IN punch" : "OUT punch";
    if (choice.durationMinutes) return `${choice.durationMinutes} min`;
    if (choice.days !== null && choice.days !== undefined) return daysText(choice.days);
    return choice.shifts ? `${choice.shifts} shift` : "";
  }
  if (item.group === "ot_pay" && item.otMinutes) return `${item.otMinutes} min overtime`;
  if (item.group === "penalty_waiver") return Number(item.shifts) > 0 ? `${item.shifts} shift back` : "";
  if (item.shiftChoices.length > 0) return shiftRange(item.shiftChoices);
  if (item.group === "on_duty") return `Present · ${item.shifts ?? "1.00"} shift`;
  return item.shifts ? `${item.shifts} shift` : "";
}

/** The reason said once for the whole group (a production employee has no Permission, say), when it holds for every tile.
 *  `said`: a sentence the form already shows for every group (the Payroll Done lock), so it is not repeated here. */
export function groupNote(group: AttendanceEditGroup, said: string | null = null): string | null {
  const notes = group.items.map((item) => {
    if (item.available || !item.unavailableReason) return null;
    const shared = item.choices.every((c) => !c.unavailableReason || c.unavailableReason === item.unavailableReason);
    return item.choices.length === 0 || shared ? item.unavailableReason : null;
  });
  const note = notes.length > 0 && notes.every((n) => n) ? notes[0] : null;
  return note && note !== said ? note : null;
}

export function groupTiles(group: AttendanceEditGroup, said: string | null = null): EditTile[] {
  const note = groupNote(group);
  const unsaid = (reason: string | null) => (reason && reason !== note && reason !== said ? reason : null);
  return group.items.flatMap((item): EditTile[] => {
    if (item.choices.length === 0) {
      return [
        {
          id: item.key,
          testId: `pd-edit-type-${item.key}`,
          item,
          choice: null,
          label: item.label,
          chip: tileChip(item, null),
          description: item.description,
          available: item.available,
          reason: item.available ? null : unsaid(item.unavailableReason),
        },
      ];
    }
    return item.choices.map((choice) => {
      const available = item.available && choice.available;
      return {
        id: `${item.key}:${choice.value}`,
        testId: `pd-edit-type-${item.key}-${choice.value}`,
        item,
        choice,
        label: choiceLabel(item, choice),
        chip: tileChip(item, choice),
        description: choice.description,
        available,
        reason: available ? null : unsaid(choice.unavailableReason ?? item.unavailableReason),
      };
    });
  });
}

/** The tile of a pick, or null when it is no longer offered. */
export function findTile(groups: AttendanceEditGroup[], pick: EditPick | null): EditTile | null {
  if (!pick) return null;
  for (const group of groups) {
    const tile = groupTiles(group).find(
      (t) => t.item.key === pick.itemKey && (t.choice?.value ?? null) === (pick.choice ?? null),
    );
    if (tile) return tile;
  }
  return null;
}

export const pickOf = (tile: EditTile): EditPick => ({ itemKey: tile.item.key, choice: tile.choice?.value ?? null });

/** "Permission · Morning Late-In", "Mark as Late", "Casual Leave · First half", "Leave · Sick Leave", "Half Day". */
export function tileTitle(tile: Pick<EditTile, "item" | "label" | "choice">): string {
  if (!tile.choice || tile.item.group === "late" || tile.item.group === "early_out") return tile.label;
  return `${tile.item.label} · ${tile.label}`;
}

/** What the change is called once its details are in, the way the request will name it: "Leave · Sick Leave · First
 *  half", "Missing Punch · Morning Check-In 09:05", "OT Pay · 0.50 shift". */
export function proposalTitle(
  tile: Pick<EditTile, "item" | "label" | "choice">,
  details: { portion?: string | null; punchTime?: string; shifts?: string } = {},
): string {
  const title = tileTitle(tile);
  const item = tile.item;
  if (item.group === "leave") {
    const portion = itemPortions(item).find((p) => p.value === details.portion);
    return portion && portion.value !== "full" ? `${title} · ${portion.label}` : title;
  }
  if (item.group === "missing_punch" && details.punchTime) return `${title} ${details.punchTime.slice(0, 5)}`;
  if (item.group === "ot_pay" && details.shifts) return `${title} · ${details.shifts} shift`;
  return title;
}

/** Shows the first in / last out times and the Late / Early Out switches (only the old worked types send them). */
export const showsPunches = (item: AttendanceEditItem | null | undefined): boolean =>
  !!item && isClassicGroup(item.group) && item.worked;

// ── the details of the options added on 2026-11-24 ───────────────────────────────────────────────────────────────────

/** The Payroll Done lock in the server's words (a plain fallback when it sent none), or null when the day can change. */
export function lockMessage(ctx: Pick<AttendanceEditContext, "locked"> | null | undefined): string | null {
  if (!ctx?.locked?.locked) return null;
  return (
    ctx.locked.message?.trim() ||
    "The payroll of this day is finalized (Payroll Done), so its attendance can no longer change."
  );
}

/** Leave: the parts of the day it can cover (Full day / First half / Second half). */
export const itemPortions = (item: Pick<AttendanceEditItem, "portions">): AttendanceEditChoice[] => item.portions ?? [];

/** The part of the day to start from: the one already chosen while it can still be chosen, else the first that can. */
export function portionFor(item: Pick<AttendanceEditItem, "portions">, current: string | null = null): string | null {
  const portions = itemPortions(item);
  if (current && portions.some((p) => p.value === current && p.available)) return current;
  return portions.find((p) => p.available)?.value ?? null;
}

/** The shift value a tile starts with: OT Pay the overtime detected (nothing when none); a compensation type its own
 *  value when it still fits, else the most that fits; any other tile its own value. */
export function startShifts(
  item: Pick<AttendanceEditItem, "group" | "shifts" | "shiftChoices" | "defaultShifts">,
): string {
  const choices = item.shiftChoices;
  if (item.group === "ot_pay")
    return item.defaultShifts && choices.includes(item.defaultShifts) ? item.defaultShifts : "";
  if (choices.length === 0) return item.shifts ?? "";
  if (item.shifts && choices.includes(item.shifts)) return item.shifts;
  return choices[choices.length - 1];
}

/** "09:05" or "09:05:00" (what a time field gives). */
export const isPunchTime = (value: string | null | undefined): boolean =>
  /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test((value ?? "").trim());

const shiftText = (value: string | number): string => Number(value).toFixed(2);

/** Compensation: "The day counts 0.50 shift now · balance available 2.50 shift" (null on an older server). */
export function compensationText(item: Pick<AttendanceEditItem, "dayShifts" | "balanceAvailable">): string | null {
  if (item.dayShifts === undefined || item.balanceAvailable === undefined) return null;
  return `The day counts ${shiftText(item.dayShifts)} shift now · balance available ${shiftText(item.balanceAvailable)} shift`;
}

/** Penalty Waiver: "0.25 shift is added back (left 80 min early)" (null when there is nothing to add back). */
export function penaltyText(item: Pick<AttendanceEditItem, "shifts" | "penaltyMinutes">): string | null {
  if (!(Number(item.shifts) > 0)) return null;
  const early = item.penaltyMinutes ? ` (left ${item.penaltyMinutes} min early)` : "";
  return `${shiftText(item.shifts ?? 0)} shift is added back${early}`;
}

/** OT Pay: "Overtime detected: 95 min" (null when no overtime was detected). */
export function otText(item: Pick<AttendanceEditItem, "otMinutes">): string | null {
  return item.otMinutes === null || item.otMinutes === undefined ? null : `Overtime detected: ${item.otMinutes} min`;
}

/** The question over the shift values: what the chosen amount is. */
export function shiftQuestion(item: Pick<AttendanceEditItem, "group">): string {
  if (item.group === "compensation") return "How much of the balance to use?";
  if (item.group === "ot_pay") return "How much overtime to pay?";
  return "How much is the day worth?";
}

export type ProposalInput = {
  employeeId: number;
  date: string;
  tile: EditTile;
  note: string;
  /** Compensation types and OT Pay: the shift value chosen. */
  shifts?: string;
  firstIn?: string;
  lastOut?: string;
  late?: boolean;
  earlyOut?: boolean;
  /** On-Duty: where the employee was (optional). */
  destination?: string;
  /** Leave: the part of the day (full / first_half / second_half). */
  portion?: string | null;
  /** Missing Punch: the time of the punch ("09:05"). */
  punchTime?: string;
};

/** What POST /api/attendance/override is sent: the old types exactly as before; a newer option its `type` and `choice`
 *  (On-Duty its destination when one is written, Leave its part of the day, Missing Punch its time, OT Pay its shifts). */
export function buildProposal(input: ProposalInput): AttendanceEditProposal {
  const { employeeId, date, tile } = input;
  const item = tile.item;
  const note = input.note.trim();
  if (isClassicGroup(item.group)) {
    return {
      employeeId,
      date,
      type: item.key,
      note,
      shifts: item.shiftChoices.length ? (input.shifts ?? item.shifts ?? undefined) : undefined,
      firstPunch: item.worked ? input.firstIn || null : null,
      lastPunch: item.worked ? input.lastOut || null : null,
      isLate: item.worked ? !!input.late : false,
      isEarlyOut: item.worked ? !!input.earlyOut : false,
    };
  }
  const out: AttendanceEditProposal = { employeeId, date, type: item.key, note };
  if (tile.choice) out.choice = tile.choice.value;
  if (item.group === "on_duty") {
    const where = (input.destination ?? "").trim().slice(0, 200);
    if (where) out.destination = where;
  }
  if (item.group === "leave" && input.portion) out.portion = input.portion;
  if (item.group === "missing_punch" || item.needsTime) out.punchTime = (input.punchTime ?? "").trim().slice(0, 5);
  if (item.shiftChoices.length > 0 && input.shifts) out.shifts = input.shifts;
  return out;
}

/** "Full day, First half or Second half". */
const orList = (words: string[]): string =>
  words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : (words[0] ?? "");

/** Why the change cannot be sent yet, in the words of the line beside the button; null when it can. */
export function sendBlocker(state: {
  noHod: boolean;
  future: boolean;
  tile: EditTile | null;
  note: string;
  /** The Payroll Done lock (lockMessage): nothing of the day can be proposed. */
  locked?: string | null;
  /** Compensation types and OT Pay: the shift value chosen. */
  shifts?: string;
  /** Leave: the part of the day chosen. */
  portion?: string | null;
  /** Missing Punch: the time typed. */
  punchTime?: string;
}): string | null {
  if (state.locked) return state.locked;
  if (state.noHod) return "Assign a Department Head to send this.";
  if (state.future) return "This day has not come yet.";
  if (!state.tile) return "Choose what the day should be.";
  if (!state.tile.available) return state.tile.reason ?? state.tile.item.unavailableReason ?? "This cannot be chosen.";
  const item = state.tile.item;
  if (item.choiceRequired && !state.tile.choice) return "Choose one of its options.";
  const portions = itemPortions(item);
  if (item.group === "leave" && portions.length > 0) {
    const portion = portions.find((p) => p.value === state.portion);
    if (!portion) return `Choose the part of the day: ${orList(portions.map((p) => p.label))}.`;
    if (!portion.available) return portion.unavailableReason ?? `${portion.label} cannot be chosen for this day.`;
  }
  if (item.group === "missing_punch" || item.needsTime) {
    const at = (state.punchTime ?? "").trim();
    if (!at) return "Type the time of the missing punch.";
    if (!isPunchTime(at)) return "Type the punch time as hours and minutes, like 09:05.";
  }
  if ((item.group === "ot_pay" || item.group === "compensation") && item.shiftChoices.length > 0) {
    if (!state.shifts || !item.shiftChoices.includes(state.shifts)) {
      return item.group === "ot_pay" ? "Choose how much overtime to pay." : "Choose how much of the balance to use.";
    }
  }
  if (state.note.trim().length < 3) return "Write the reason to send it.";
  return null;
}

/** The server's own sentence from a refused request ({error: "..."}), else the error's message without "HTTP 400 ...:". */
export function serverSentence(err: unknown): string {
  const e = err as { data?: unknown; message?: unknown } | null | undefined;
  const body = e?.data;
  if (body && typeof body === "object") {
    const sentence = (body as { error?: unknown }).error;
    if (typeof sentence === "string" && sentence.trim()) return sentence.trim();
  }
  const message = typeof e?.message === "string" ? e.message : "";
  const stripped = /^HTTP \d{3}(?: [^:]*)?: (.+)$/s.exec(message);
  return (stripped ? stripped[1] : message).trim() || "The change could not be sent. Try again.";
}

const dayCount = (n: number): string => String(Math.round(n * 100) / 100);

/** "11 of 12 left in 2026" (null when the employee has no balance: production). */
export function clBalanceText(balance: CasualLeaveBalance | null | undefined): string | null {
  if (!balance) return null;
  if (!balance.tracked) return `No Casual Leave balance is kept for ${balance.year}`;
  return `${dayCount(balance.remaining)} of ${dayCount(balance.total)} left in ${balance.year}`;
}

/** "1 used · 0.5 waiting for approval" (null when nothing is used or waiting). */
export function clBalanceDetail(balance: CasualLeaveBalance | null | undefined): string | null {
  if (!balance || !balance.tracked) return null;
  const parts = [
    balance.used ? `${dayCount(balance.used)} used` : "",
    balance.pending ? `${dayCount(balance.pending)} waiting for approval` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** What a chosen Casual Leave does to the balance: "Uses 1 day: 11 of 12 left now, 10 once approved." */
export function clUseText(
  balance: CasualLeaveBalance | null | undefined,
  days: number | null | undefined,
): string | null {
  if (!balance || !balance.tracked || days === null || days === undefined) return null;
  const after = Math.max(0, balance.remaining - days);
  return `Uses ${daysText(days)} of the balance: ${dayCount(balance.remaining)} of ${dayCount(balance.total)} left now, ${dayCount(after)} once approved.`;
}
