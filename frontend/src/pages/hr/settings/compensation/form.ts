// The Compensation tab's form: what the screen starts from (the saved settings), what is wrong with a value before it is
// sent (the same rules the server enforces, in plain words), and the request a save sends. Number boxes hold text so a
// cleared box is a problem to fix, not a silent 0.
import type { CompensationSettings, CompensationSettingsInput } from "@/lib/api-client/custom-hooks";
import { parseNumber, type NumberRule } from "../payroll/form";
import { formatDay } from "../payroll/preview";
import { formatDuration, formatUntil, MINUTES_PER_DAY, parseUntil, saysNextDay } from "./time";

// ── the form ──

export type AllowanceRow = {
  /** Only for React and for finding the row: never sent. */
  key: string;
  /** The server's id; null for a row added on screen and not saved yet. */
  id: number | null;
  label: string;
  enabled: boolean;
  /** The extra work after the shift end that earns the allowance, as two boxes: hours and minutes. */
  hours: string;
  minutes: string;
  allowanceMinutes: string;
};

export type ShiftRow = {
  key: string;
  id: number | null;
  label: string;
  enabled: boolean;
  /** The limit as a clock time ("9:00 PM", "2:00 AM next day"); ignored while `noLimit`. */
  until: string;
  /** The last row: no upper limit, every later punch-out gets these shifts. */
  noLimit: boolean;
  /** "0.25" | "0.5" | "0.75" | "1" */
  shifts: string;
};

export type CompensationDraft = {
  allowanceEnabled: boolean;
  /** YYYY-MM-DD; blank = not set yet (the server sets today when the feature is switched on for the first time). */
  allowanceFrom: string;
  allowanceRules: AllowanceRow[];
  shiftEnabled: boolean;
  shiftMinExtra: string;
  relaxationEnabled: boolean;
  payEnabled: boolean;
  shiftRules: ShiftRow[];
  windowsEnabled: boolean;
  holidayWorkEnabled: boolean;
  birthdayEnabled: boolean;
  birthdayFrom: string;
};

export const LABEL_MAX = 80;
const HOURS: NumberRule = { min: 0, max: 24, decimals: 0 };
const MINUTES: NumberRule = { min: 0, max: 59, decimals: 0 };
export const ALLOWANCE_MINUTES: NumberRule = { min: 0, max: 240, decimals: 0 };
export const THRESHOLD: NumberRule = { min: 1, max: 1440, decimals: 0 };
export const MAX_EXTRA_MINUTES = 1440;

/** The four amounts a Type 2 rule may give. */
export const SHIFT_CHOICES: { value: string; label: string }[] = [
  { value: "0.25", label: "0.25 shift" },
  { value: "0.5", label: "0.50 shift" },
  { value: "0.75", label: "0.75 shift" },
  { value: "1", label: "1.00 shift" },
];

const shiftKey = (text: string): string => {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) ? String(Number(n.toFixed(2))) : text.trim();
};

let counter = 0;
const freshKey = (prefix: string) => `${prefix}-new-${++counter}`;

const byOrder = <T extends { sortOrder: number; id: number }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.id - b.id;

/** The saved settings as form values. A group an older server does not report starts at its defaults (all off). */
export function draftFrom(s: CompensationSettings): CompensationDraft {
  const allowance = s.allowance ?? { enabled: false, effectiveFrom: null };
  const shift = s.shift ?? { enabled: false, minExtraMinutes: 150, relaxationEnabled: true, payEnabled: false };
  const birthday = s.birthday ?? { enabled: false, effectiveFrom: null };
  return {
    allowanceEnabled: allowance.enabled === true,
    allowanceFrom: allowance.effectiveFrom ?? "",
    allowanceRules: [...(s.allowanceRules ?? [])].sort(byOrder).map((r) => ({
      key: `a-${r.id}`,
      id: r.id,
      label: r.label ?? "",
      enabled: r.enabled !== false,
      hours: String(Math.floor(r.minExtraMinutes / 60)),
      minutes: String(r.minExtraMinutes % 60),
      allowanceMinutes: String(r.allowanceMinutes),
    })),
    shiftEnabled: shift.enabled === true,
    shiftMinExtra: String(shift.minExtraMinutes),
    relaxationEnabled: shift.relaxationEnabled !== false,
    payEnabled: shift.payEnabled === true,
    shiftRules: [...(s.shiftRules ?? [])].sort(byOrder).map((r) => ({
      key: `s-${r.id}`,
      id: r.id,
      label: r.label ?? "",
      enabled: r.enabled !== false,
      until: r.untilMinutes === null ? "" : formatUntil(r.untilMinutes),
      noLimit: r.untilMinutes === null,
      shifts: shiftKey(String(r.shifts)),
    })),
    windowsEnabled: s.windows?.enabled === true,
    holidayWorkEnabled: s.holidayWork?.enabled === true,
    birthdayEnabled: birthday.enabled === true,
    birthdayFrom: birthday.effectiveFrom ?? "",
  };
}

// ── same or changed ──

const num = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));
const sameNumber = (a: string, b: string) => {
  const x = num(a);
  const y = num(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a.trim() === b.trim() : x === y;
};

/** Total minutes of an allowance row's two boxes; null while either is not a number. */
export function extraMinutesOf(row: Pick<AllowanceRow, "hours" | "minutes">): number | null {
  const h = num(row.hours);
  const m = num(row.minutes);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
}

function sameAllowanceRow(a: AllowanceRow, b: AllowanceRow): boolean {
  const x = extraMinutesOf(a);
  const y = extraMinutesOf(b);
  const sameExtra =
    x !== null && y !== null ? x === y : a.hours.trim() === b.hours.trim() && a.minutes.trim() === b.minutes.trim();
  return (
    a.label.trim() === b.label.trim() &&
    a.enabled === b.enabled &&
    sameExtra &&
    sameNumber(a.allowanceMinutes, b.allowanceMinutes)
  );
}

function sameShiftRow(a: ShiftRow, b: ShiftRow): boolean {
  let sameUntil: boolean;
  if (a.noLimit || b.noLimit) {
    sameUntil = a.noLimit === b.noLimit;
  } else {
    const x = parseUntil(a.until);
    const y = parseUntil(b.until);
    sameUntil =
      x.error === undefined && y.error === undefined ? x.minutes === y.minutes : a.until.trim() === b.until.trim();
  }
  return (
    a.label.trim() === b.label.trim() &&
    a.enabled === b.enabled &&
    sameUntil &&
    shiftKey(a.shifts) === shiftKey(b.shifts)
  );
}

/**
 * The same settings: the same switches, dates and rows in the same order. Ids and keys do not count (a row added on screen
 * has none until it is saved), and "1" and "1.0", or "21:00" and "9:00 PM", are the same value.
 */
export function sameDraft(a: CompensationDraft, b: CompensationDraft): boolean {
  return (
    a.allowanceEnabled === b.allowanceEnabled &&
    a.allowanceFrom === b.allowanceFrom &&
    a.shiftEnabled === b.shiftEnabled &&
    sameNumber(a.shiftMinExtra, b.shiftMinExtra) &&
    a.relaxationEnabled === b.relaxationEnabled &&
    a.payEnabled === b.payEnabled &&
    a.windowsEnabled === b.windowsEnabled &&
    a.holidayWorkEnabled === b.holidayWorkEnabled &&
    a.birthdayEnabled === b.birthdayEnabled &&
    a.birthdayFrom === b.birthdayFrom &&
    a.allowanceRules.length === b.allowanceRules.length &&
    a.allowanceRules.every((r, i) => sameAllowanceRow(r, b.allowanceRules[i])) &&
    a.shiftRules.length === b.shiftRules.length &&
    a.shiftRules.every((r, i) => sameShiftRow(r, b.shiftRules[i]))
  );
}

// ── dates ──

/** Today's date in India (the factory's own time, as the server uses), YYYY-MM-DD. */
export function todayIst(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(0, 10);
}

export function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** "2026-10-14" -> "14 Oct 2026". */
export function prettyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? formatDay({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }) : iso;
}

export type DateNote = { kind: "none" | "today" | "future" | "past"; text: string };

/**
 * What the chosen "applies from" date means, for the warning under the box. Nothing before the date is ever changed; a
 * date in the past reaches back to days whose attendance may already have been judged.
 */
export function dateNote(from: string, today: string): DateNote {
  if (!isIsoDate(from)) return { kind: "none", text: "" };
  if (from === today) {
    return {
      kind: "today",
      text: `From today (${prettyDate(from)}) on. Days before today are never changed, so a month that is already paid keeps its attendance and its pay.`,
    };
  }
  if (from > today) {
    return {
      kind: "future",
      text: `It starts on ${prettyDate(from)}. Until then nothing changes.`,
    };
  }
  return {
    kind: "past",
    text: `${prettyDate(from)} is in the past. Days from then until today will also be judged with it when they are opened or their month is generated again. Payslips already generated are never rewritten, but a month whose payroll is generated again will change. Choose today's date if you do not want that.`,
  };
}

// ── what is wrong ──

export type RowErrors = Partial<Record<"label" | "extra" | "allowance" | "until" | "shifts" | "order", string>>;

export type Validation = {
  allowanceFrom: string | null;
  birthdayFrom: string | null;
  allowanceRows: RowErrors[];
  allowanceTable: string | null;
  threshold: string | null;
  shiftRows: RowErrors[];
  shiftTable: string | null;
  /** Type 2 is on but neither Relaxation nor Payment is: HR could not assign anything (the server refuses it too). */
  shiftMode: string | null;
  /** The first problem in reading order, as a sentence for the Save bar. */
  first: string | null;
  ok: boolean;
};

export const LAST_ROW_OPEN =
  'The last rule that is on must have no upper limit, so a punch-out later than every other row still earns a shift. Tick "No upper limit" on it.';

const dateProblem = (text: string, saved: string): string | null => {
  if (text === "") return saved ? "Pick the date it applies from." : null;
  return isIsoDate(text) ? null : "Pick a valid date.";
};

/**
 * Everything the server would refuse, in plain words. Only the order of the Type 2 ladder and the "only the last rule has
 * no limit" rule look at the rows that are switched on; every row must be readable because every row is sent.
 */
export function validateDraft(
  draft: CompensationDraft,
  saved: { allowanceFrom: string; birthdayFrom: string },
): Validation {
  // Type 1 rows
  const allowanceRows: RowErrors[] = draft.allowanceRules.map(() => ({}));
  const seen = new Map<number, number>();
  draft.allowanceRules.forEach((row, i) => {
    const e = allowanceRows[i];
    if (row.label.trim().length > LABEL_MAX) e.label = `Keep the name to ${LABEL_MAX} characters.`;
    const h = parseNumber(row.hours, HOURS);
    const m = parseNumber(row.minutes, MINUTES);
    if (h.error) e.extra = `Hours: ${h.error}`;
    else if (m.error) e.extra = `Minutes: ${m.error}`;
    else {
      const total = (h.value ?? 0) * 60 + (m.value ?? 0);
      if (total < 1) e.extra = "Extra work must be at least 1 minute.";
      else if (total > MAX_EXTRA_MINUTES) e.extra = "Extra work can be at most 24 hours.";
      else if (row.enabled) {
        const first = seen.get(total);
        if (first === undefined) seen.set(total, i);
        else
          e.extra = `Row ${first + 1} already uses ${formatDuration(total)}: each row needs a different amount of extra work.`;
      }
    }
    const a = parseNumber(row.allowanceMinutes, ALLOWANCE_MINUTES);
    if (a.error) e.allowance = a.error;
  });
  const allowanceTable =
    draft.allowanceEnabled && !draft.allowanceRules.some((r) => r.enabled)
      ? "Type 1 is switched on but no rule is switched on. Switch a rule on, add one, or switch Type 1 off."
      : null;

  // Type 2 threshold and ladder
  const threshold = parseNumber(draft.shiftMinExtra, THRESHOLD).error;
  const shiftRows: RowErrors[] = draft.shiftRules.map(() => ({}));
  const enabledAt = draft.shiftRules.flatMap((r, i) => (r.enabled ? [i] : []));
  const lastEnabled = enabledAt.length ? enabledAt[enabledAt.length - 1] : -1;
  let previous: { index: number; minutes: number } | null = null;
  draft.shiftRules.forEach((row, i) => {
    const e = shiftRows[i];
    if (row.label.trim().length > LABEL_MAX) e.label = `Keep the name to ${LABEL_MAX} characters.`;
    if (!SHIFT_CHOICES.some((c) => c.value === shiftKey(row.shifts)))
      e.shifts = "Shifts must be 0.25, 0.50, 0.75 or 1.00.";
    let minutes: number | null = null;
    if (!row.noLimit) {
      const parsed = parseUntil(row.until);
      if (parsed.error !== undefined) e.until = parsed.error;
      else minutes = parsed.minutes;
    }
    if (!row.enabled) return;
    if (row.noLimit) {
      if (i !== lastEnabled) {
        e.order = "Only the last rule can have no upper limit. Move it to the end, or switch the rules after it off.";
      }
    } else if (i === lastEnabled) {
      // The server wants it too: a punch-out later than every other row must still land on a row.
      e.order = LAST_ROW_OPEN;
      if (minutes !== null) previous = { index: i, minutes };
    } else if (minutes !== null) {
      if (previous !== null && minutes <= previous.minutes) {
        const hint =
          saysNextDay(row.until) || minutes >= MINUTES_PER_DAY
            ? ""
            : ' For a time after midnight write it as "2:00 AM next day".';
        e.order = `Must be later than rule ${previous.index + 1} (${formatUntil(previous.minutes)}).${hint}`;
      }
      previous = { index: i, minutes };
    }
  });
  const shiftTable =
    draft.shiftEnabled && enabledAt.length === 0
      ? "Type 2 is switched on but no rule is switched on. Switch a rule on, add one, or switch Type 2 off."
      : null;

  const shiftMode =
    draft.shiftEnabled && !draft.relaxationEnabled && !draft.payEnabled
      ? "Type 2 is switched on: switch on Relaxation, Payment or both, or switch Type 2 off."
      : null;

  const allowanceFrom = dateProblem(draft.allowanceFrom, saved.allowanceFrom);
  const birthdayFrom = dateProblem(draft.birthdayFrom, saved.birthdayFrom);

  const rowText = (what: string, rows: RowErrors[]) =>
    rows.flatMap((e, i) => Object.values(e).map((msg) => `${what}, rule ${i + 1}: ${msg}`));
  const problems = [
    allowanceFrom && `Type 1 start date: ${allowanceFrom}`,
    allowanceTable,
    ...rowText("Type 1", allowanceRows),
    threshold && `Type 2 threshold: ${threshold}`,
    shiftTable,
    shiftMode,
    ...rowText("Type 2", shiftRows),
    birthdayFrom && `Birthday start date: ${birthdayFrom}`,
  ].filter((p): p is string => typeof p === "string" && p !== "");

  return {
    allowanceFrom,
    birthdayFrom,
    allowanceRows,
    allowanceTable,
    threshold,
    shiftRows,
    shiftTable,
    shiftMode,
    first: problems[0] ?? null,
    ok: problems.length === 0,
  };
}

/**
 * Things that are allowed but probably not meant (never block a save): an allowance row that asks for more extra work than
 * Type 2 starts at can never apply (the server says the same after a save, in the same words).
 */
export function warningsFor(draft: CompensationDraft): string[] {
  if (!draft.allowanceEnabled) return [];
  const threshold = parseNumber(draft.shiftMinExtra, THRESHOLD).value;
  if (threshold === null) return [];
  return draft.allowanceRules.flatMap((r) => {
    const extra = extraMinutesOf(r);
    if (!r.enabled || extra === null || extra <= threshold) return [];
    return [
      `The '${r.label.trim() || formatDuration(extra)}' allowance can never apply: shift-based compensation already starts at ${formatDuration(threshold)} of extra work.`,
    ];
  });
}

// ── what is sent ──

/** The save request. Call it only for a draft that passes validateDraft. */
export function toInput(draft: CompensationDraft): CompensationSettingsInput {
  return {
    allowance: {
      enabled: draft.allowanceEnabled,
      ...(draft.allowanceFrom ? { effectiveFrom: draft.allowanceFrom } : {}),
    },
    shift: {
      enabled: draft.shiftEnabled,
      minExtraMinutes: num(draft.shiftMinExtra),
      relaxationEnabled: draft.relaxationEnabled,
      payEnabled: draft.payEnabled,
    },
    windows: { enabled: draft.windowsEnabled },
    holidayWork: { enabled: draft.holidayWorkEnabled },
    birthday: {
      enabled: draft.birthdayEnabled,
      ...(draft.birthdayFrom ? { effectiveFrom: draft.birthdayFrom } : {}),
    },
    allowanceRules: draft.allowanceRules.map((r, i) => {
      const extra = extraMinutesOf(r) ?? 0;
      return {
        ...(r.id === null ? {} : { id: r.id }),
        label: r.label.trim() || formatDuration(extra),
        enabled: r.enabled,
        minExtraMinutes: extra,
        allowanceMinutes: num(r.allowanceMinutes),
        sortOrder: i + 1,
      };
    }),
    shiftRules: draft.shiftRules.map((r, i) => {
      const until = r.noLimit ? null : (parseUntil(r.until).minutes ?? null);
      return {
        ...(r.id === null ? {} : { id: r.id }),
        label: r.label.trim() || autoShiftLabel(until),
        enabled: r.enabled,
        untilMinutes: until,
        shifts: Number(shiftKey(r.shifts)),
        sortOrder: i + 1,
      };
    }),
  };
}

// ── editing the rows ──

/** The name a Type 1 row has until HR types one: its extra work in words ("1 hour 30 minutes"). */
export const autoAllowanceLabel = (row: Pick<AllowanceRow, "hours" | "minutes">): string => {
  const total = extraMinutesOf(row);
  return total !== null && total >= 1 ? formatDuration(total) : "";
};

/** The name a Type 2 row has until HR types one: "Up to 9:00 PM", or "No time limit" for the last row. */
export const autoShiftLabel = (until: number | null): string =>
  until === null ? "No time limit" : `Up to ${formatUntil(until)}`;

const autoShiftLabelOf = (row: Pick<ShiftRow, "until" | "noLimit">): string => {
  if (row.noLimit) return autoShiftLabel(null);
  const parsed = parseUntil(row.until);
  return parsed.error === undefined ? autoShiftLabel(parsed.minutes) : "";
};

/**
 * Change an allowance row's extra work. While the row's name is still the automatic one (or blank) it follows the new
 * amount, so "1 hour" does not stay on a row that now asks for 1 hour 15 minutes.
 */
export function setAllowanceExtra(
  rows: AllowanceRow[],
  key: string,
  change: Partial<Pick<AllowanceRow, "hours" | "minutes">>,
): AllowanceRow[] {
  return rows.map((row) => {
    if (row.key !== key) return row;
    const next = { ...row, ...change };
    const followed = row.label.trim() === "" || row.label.trim() === autoAllowanceLabel(row);
    return followed ? { ...next, label: autoAllowanceLabel(next) } : next;
  });
}

/** Change a ladder row's limit or its "no upper limit" tick; the automatic name follows, a typed one stays. */
export function setShiftLimit(
  rows: ShiftRow[],
  key: string,
  change: Partial<Pick<ShiftRow, "until" | "noLimit">>,
): ShiftRow[] {
  return rows.map((row) => {
    if (row.key !== key) return row;
    const next = { ...row, ...change };
    const followed = row.label.trim() === "" || row.label.trim() === autoShiftLabelOf(row);
    return followed ? { ...next, label: autoShiftLabelOf(next) } : next;
  });
}

/** Rows in order of extra work (rows that cannot be read yet keep their place at the end). */
export function sortAllowanceRows(rows: AllowanceRow[]): AllowanceRow[] {
  const total = (r: AllowanceRow) => extraMinutesOf(r) ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => (total(a) === total(b) ? 0 : total(a) < total(b) ? -1 : 1));
}

/** Rows in order of time, the row with no limit last; left as they are while any limit cannot be read. */
export function sortShiftRows(rows: ShiftRow[]): ShiftRow[] {
  const limit = (r: ShiftRow): number | null => {
    if (r.noLimit) return Number.POSITIVE_INFINITY;
    const parsed = parseUntil(r.until);
    return parsed.error === undefined ? parsed.minutes : null;
  };
  const limits = rows.map(limit);
  if (limits.some((l) => l === null)) return rows;
  const order = rows.map((_, i) => i).sort((a, b) => (limits[a] as number) - (limits[b] as number) || a - b);
  const sorted = order.map((i) => rows[i]);
  return sorted.every((r, i) => r === rows[i]) ? rows : sorted;
}

/** A new Type 1 row: 30 minutes more extra work than the largest row, with the same allowance as that row. */
export function addAllowanceRow(rows: AllowanceRow[]): AllowanceRow[] {
  const largest = rows.reduce<AllowanceRow | null>(
    (best, r) => ((extraMinutesOf(r) ?? 0) >= (best ? (extraMinutesOf(best) ?? 0) : -1) ? r : best),
    null,
  );
  const extra = Math.min(MAX_EXTRA_MINUTES, (largest ? (extraMinutesOf(largest) ?? 0) : 30) + 30);
  const row: AllowanceRow = {
    key: freshKey("a"),
    id: null,
    label: "",
    enabled: true,
    hours: String(Math.floor(extra / 60)),
    minutes: String(extra % 60),
    allowanceMinutes: largest ? largest.allowanceMinutes : "30",
  };
  return [...rows, { ...row, label: autoAllowanceLabel(row) }];
}

/** The limit a new Type 2 row starts with: one hour after the latest limit in the table (9:00 PM when there is none). */
export function suggestLimit(rows: ShiftRow[]): { minutes: number; shifts: string } {
  const finite = rows.flatMap((r) => {
    if (r.noLimit) return [];
    const parsed = parseUntil(r.until);
    return parsed.error === undefined ? [{ row: r, minutes: parsed.minutes }] : [];
  });
  const top = finite.reduce<{ row: ShiftRow; minutes: number } | null>(
    (best, f) => (best === null || f.minutes >= best.minutes ? f : best),
    null,
  );
  return top
    ? { minutes: Math.min(2 * MINUTES_PER_DAY - 1, top.minutes + 60), shifts: top.row.shifts }
    : { minutes: 21 * 60, shifts: "0.25" };
}

/**
 * A new Type 2 row. While a row that is on has no upper limit (it must stay last) the new row goes just before it, one
 * hour later than the latest limit and with the same shifts as that row. With no such row the new row is added at the
 * end WITH no upper limit, so the table stays valid (the last rule that is on must have none).
 */
export function addShiftRow(rows: ShiftRow[]): ShiftRow[] {
  const open = rows.findIndex((r) => r.noLimit && r.enabled);
  if (open === -1) {
    return [
      ...rows,
      {
        key: freshKey("s"),
        id: null,
        label: autoShiftLabel(null),
        enabled: true,
        until: "",
        noLimit: true,
        shifts: "1",
      },
    ];
  }
  const { minutes, shifts } = suggestLimit(rows);
  const row: ShiftRow = {
    key: freshKey("s"),
    id: null,
    label: autoShiftLabel(minutes),
    enabled: true,
    until: formatUntil(minutes),
    noLimit: false,
    shifts,
  };
  return [...rows.slice(0, open), row, ...rows.slice(open)];
}

/**
 * The "applies from" date after a feature's switch is flipped in the form. The server starts a feature switched ON again
 * at TODAY unless a date is named, so that it never reaches back into days already judged: the form shows that date at
 * once (and sends it). Switching it back off undoes that, and a date HR typed is never touched.
 */
export function dateAfterSwitch(args: {
  on: boolean;
  savedOn: boolean;
  savedFrom: string;
  currentFrom: string;
  today: string;
}): string {
  const { on, savedOn, savedFrom, currentFrom, today } = args;
  if (on && !savedOn && currentFrom === savedFrom) return today;
  if (!on && !savedOn && currentFrom === today) return savedFrom;
  return currentFrom;
}
