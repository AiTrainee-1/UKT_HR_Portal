// The Edit Attendance form's options (2026-11-02): the server's catalogue in groups (Worked / Compensation / Not worked, then
// Permission / Late / Casual Leave / On-Duty), what each tile says, whether it can be chosen for the day, and the proposal it
// sends. Kept apart from the form so it can be tested on its own. The server decides availability and applies the change
// (api/attendance_edit.py); nothing here is a rule of its own.

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
/** ... and the four added on 2026-11-02 (one tile per sub-choice). */
export const OPTION_GROUPS: readonly AttendanceEditGroupKey[] = ["permission", "late", "casual_leave", "on_duty"];

export const isClassicGroup = (key: string): boolean => (CLASSIC_GROUPS as readonly string[]).includes(key);

const TYPE_GROUP: Record<AttendanceEditType["group"], AttendanceEditGroupKey> = {
  Attendance: "worked",
  Compensation: "compensation",
  Other: "not_worked",
};

/** The look and the short line under each group's title. The first three keep the words and colours they always had. */
export const GROUP_LOOK: Record<
  AttendanceEditGroupKey,
  { title: string; hint: string; tile: string; on: string; chip: string }
> = {
  worked: {
    title: "Worked",
    hint: "How much of the day was worked",
    tile: "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40",
    on: "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200",
    chip: "bg-indigo-100 text-indigo-800",
  },
  compensation: {
    title: "Compensation",
    hint: "A paid day given in return for extra work",
    tile: "border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/40",
    on: "border-violet-500 bg-violet-50 ring-2 ring-violet-200",
    chip: "bg-violet-100 text-violet-800",
  },
  not_worked: {
    title: "Not worked",
    hint: "Absent, on leave or a holiday",
    tile: "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50",
    on: "border-slate-600 bg-slate-100 ring-2 ring-slate-300",
    chip: "bg-slate-200 text-slate-700",
  },
  permission: {
    title: "Permission",
    hint: "Counts as an approved permission (uses the monthly allowance)",
    tile: "border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50/40",
    on: "border-blue-500 bg-blue-50 ring-2 ring-blue-200",
    chip: "bg-blue-100 text-blue-800",
  },
  late: {
    title: "Late",
    hint: "Mark the day Late, or take its Late mark away",
    tile: "border-slate-200 bg-white hover:border-amber-300 hover:bg-amber-50/40",
    on: "border-amber-500 bg-amber-50 ring-2 ring-amber-200",
    chip: "bg-amber-100 text-amber-900",
  },
  casual_leave: {
    title: "Casual Leave",
    hint: "Paid leave from the employee's yearly balance",
    tile: "border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50/40",
    on: "border-sky-500 bg-sky-50 ring-2 ring-sky-200",
    chip: "bg-sky-100 text-sky-900",
  },
  on_duty: {
    title: "On-Duty",
    hint: "Worked away from the branch: Present with an On-Duty label",
    tile: "border-slate-200 bg-white hover:border-teal-300 hover:bg-teal-50/40",
    on: "border-teal-500 bg-teal-50 ring-2 ring-teal-200",
    chip: "bg-teal-100 text-teal-900",
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

/** The small chip on a tile: the shift value, the permission's length, the days of Casual Leave ... */
export function tileChip(item: AttendanceEditItem, choice: AttendanceEditChoice | null): string {
  if (choice) {
    if (item.group === "late") return choice.value === "unmark" ? "Late mark removed" : "Counts as a Late";
    if (choice.durationMinutes) return `${choice.durationMinutes} min`;
    if (choice.days !== null && choice.days !== undefined) return daysText(choice.days);
    return choice.shifts ? `${choice.shifts} shift` : "";
  }
  if (item.shiftChoices.length > 0) return "0.25 to 1.00 shift";
  if (item.group === "on_duty") return `Present · ${item.shifts ?? "1.00"} shift`;
  return item.shifts ? `${item.shifts} shift` : "";
}

/** The reason said once for the whole group (a production employee has no Permission, say), when it holds for every tile. */
export function groupNote(group: AttendanceEditGroup): string | null {
  const notes = group.items.map((item) => {
    if (item.available || !item.unavailableReason) return null;
    const shared = item.choices.every((c) => !c.unavailableReason || c.unavailableReason === item.unavailableReason);
    return item.choices.length === 0 || shared ? item.unavailableReason : null;
  });
  return notes.length > 0 && notes.every((n) => n) ? notes[0] : null;
}

export function groupTiles(group: AttendanceEditGroup): EditTile[] {
  const note = groupNote(group);
  const unsaid = (reason: string | null) => (reason && reason !== note ? reason : null);
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

/** "Permission · Morning Late-In", "Mark as Late", "Casual Leave · First half", "Half Day". */
export function tileTitle(tile: Pick<EditTile, "item" | "label" | "choice">): string {
  if (!tile.choice || tile.item.group === "late") return tile.label;
  return `${tile.item.label} · ${tile.label}`;
}

/** Shows the first in / last out times and the Late / Early Out switches (only the old worked types send them). */
export const showsPunches = (item: AttendanceEditItem | null | undefined): boolean =>
  !!item && isClassicGroup(item.group) && item.worked;

export type ProposalInput = {
  employeeId: number;
  date: string;
  tile: EditTile;
  note: string;
  /** Compensation types: the shift value chosen. */
  shifts?: string;
  firstIn?: string;
  lastOut?: string;
  late?: boolean;
  earlyOut?: boolean;
  /** On-Duty: where the employee was (optional). */
  destination?: string;
};

/** What POST /api/attendance/override is sent: the old types exactly as before; a newer option its `type` and `choice`
 *  (and On-Duty its destination, when one is written). */
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
  return out;
}

/** Why the change cannot be sent yet, in the words of the line beside the button; null when it can. */
export function sendBlocker(state: {
  noHod: boolean;
  future: boolean;
  tile: EditTile | null;
  note: string;
}): string | null {
  if (state.noHod) return "Assign a Department Head to send this.";
  if (state.future) return "This day has not come yet.";
  if (!state.tile) return "Choose what the day should be.";
  if (!state.tile.available) return state.tile.reason ?? state.tile.item.unavailableReason ?? "This cannot be chosen.";
  if (state.tile.item.choiceRequired && !state.tile.choice) return "Choose one of its options.";
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
