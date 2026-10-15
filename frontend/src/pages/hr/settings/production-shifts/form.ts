// The Production Shifts tab's form: what the screen starts from (the saved rules), what is wrong with a value before it is
// sent (the rules the server enforces, in plain words), what changes (for the confirm before a save) and the request a save
// sends. Number boxes hold text, so a cleared box is a problem to fix and not a silent 0. Times are "HH:MM" like the server.
import type {
  ProductionShiftAppliesOn,
  ProductionShiftGroupKind,
  ProductionShiftLegacy,
  ProductionShiftRoundingMode,
  ProductionShiftRules,
  ProductionShiftRulesInput,
} from "@/lib/api-client/custom-hooks";
import type { Change } from "../attendance/form";
import { isIsoDate, prettyDate } from "../compensation/form";
import { parseNumber, type NumberRule } from "../payroll/form";
import { absMinutes, boxTime, clock12, MINUTES_PER_DAY, pointText, toHHMM, toMinutes } from "./time";

// ── the form ──

export type RuleRow = {
  /** Only for React and for finding the row: never sent. */
  key: string;
  /** The server's id; null for a row added on screen and not saved yet. */
  id: number | null;
  label: string;
  enabled: boolean;
  /** "HH:MM" */
  outTime: string;
  /** The time is after midnight, on the morning after the shift day began. */
  outNextDay: boolean;
  /** Shifts earned by leaving at that time, as typed ("0.25"). */
  shiftValue: string;
};

export type GroupRow = {
  key: string;
  id: number | null;
  label: string;
  kind: ProductionShiftGroupKind;
  appliesOn: ProductionShiftAppliesOn;
  startTime: string;
  firstPunchFrom: string;
  firstPunchTo: string;
  /** Blank = none (leaving early is then never flagged). */
  mainOutTime: string;
  mainOutNextDay: boolean;
  enabled: boolean;
  rules: RuleRow[];
};

export type BreakRow = {
  key: string;
  id: number | null;
  label: string;
  enabled: boolean;
  startTime: string;
  endTime: string;
};

export type ShiftRulesDraft = {
  enabled: boolean;
  /** YYYY-MM-DD; blank = the server sent none. */
  effectiveFrom: string;
  graceMinutes: string;
  minCredit: string;
  roundingStep: string;
  roundingMode: ProductionShiftRoundingMode;
  fullDayValue: string;
  nightSessionHours: string;
  groups: GroupRow[];
  breaks: BreakRow[];
};

export const LABEL_MAX = 80;
export const GRACE: NumberRule = { min: 0, max: 30, decimals: 0 };
export const SHIFT_VALUE: NumberRule = { min: 0.01, max: 9.99, decimals: 2 };
export const MIN_CREDIT: NumberRule = { min: 0, max: 9.99, decimals: 2 };
export const FULL_DAY: NumberRule = { min: 0.01, max: 9.99, decimals: 2 };
export const NIGHT_HOURS: NumberRule = { min: 1, max: 24, decimals: 0 };

export const ROUNDING_STEPS: { value: string; label: string }[] = [
  { value: "0.01", label: "0.01 (the exact figure)" },
  { value: "0.05", label: "0.05" },
  { value: "0.25", label: "0.25 (quarters)" },
];
export const ROUNDING_MODES: { value: ProductionShiftRoundingMode; label: string }[] = [
  { value: "nearest", label: "To the nearest step" },
  { value: "down", label: "Down to the step below" },
];
export const APPLIES_ON: { value: ProductionShiftAppliesOn; label: string }[] = [
  { value: "mon_sat", label: "Monday to Saturday" },
  { value: "sunday", label: "Sunday only" },
  { value: "all", label: "Every day" },
];
export const KIND_LABEL: Record<ProductionShiftGroupKind, string> = {
  day: "Day",
  night: "Night",
  sunday: "Sunday",
  custom: "Custom",
};

let counter = 0;
const freshKey = (prefix: string) => `${prefix}-new-${++counter}`;

/** A number the server sent, as it goes into a box: 0.25 -> "0.25", 1 -> "1", "1.00" -> "1". */
const numText = (n: number | string | null | undefined): string => {
  if (n === null || n === undefined || n === "") return "";
  const value = Number(n);
  return Number.isFinite(value) ? String(value) : String(n);
};

/** The shifts of a ladder row as they go into its box, with two decimals like the owner's table: 0.5 -> "0.50", 1 -> "1.00". */
const shiftText = (n: number | string | null | undefined): string => {
  const text = numText(n);
  const value = Number(text);
  return text !== "" && Number.isFinite(value) ? value.toFixed(2) : text;
};

/** The name a row has until HR types one: "Leaves 5:45 PM", "Leaves 5:30 AM next day". */
export const autoRuleLabel = (time: string, nextDay: boolean): string =>
  toMinutes(time) === null ? "" : `Leaves ${pointText(time, nextDay)}`;

/** The name a break has until HR types one: "Break 10:30 AM". */
export const autoBreakLabel = (start: string): string => (toMinutes(start) === null ? "" : `Break ${clock12(start)}`);

/** The saved rules as form values. */
export function draftFrom(s: ProductionShiftRules): ShiftRulesDraft {
  return {
    enabled: s.enabled !== false,
    effectiveFrom: s.effectiveFrom ?? "",
    graceMinutes: numText(s.graceMinutes),
    minCredit: numText(s.minCredit),
    roundingStep: numText(s.roundingStep),
    roundingMode: s.roundingMode === "down" ? "down" : "nearest",
    fullDayValue: numText(s.fullDayValue),
    nightSessionHours: numText(s.nightSessionHours),
    groups: (s.groups ?? []).map((g) => ({
      key: `g-${g.id}`,
      id: g.id,
      label: g.label ?? "",
      kind: g.kind,
      appliesOn: g.appliesOn,
      startTime: boxTime(g.startTime),
      firstPunchFrom: boxTime(g.firstPunchFrom),
      firstPunchTo: boxTime(g.firstPunchTo),
      mainOutTime: g.mainOutTime ? boxTime(g.mainOutTime) : "",
      mainOutNextDay: g.mainOutNextDay === true,
      enabled: g.enabled !== false,
      rules: (g.rules ?? []).map((r) => ({
        key: `r-${r.id}`,
        id: r.id,
        label: r.label ?? "",
        enabled: r.enabled !== false,
        outTime: boxTime(r.outTime),
        outNextDay: r.outNextDay === true,
        shiftValue: shiftText(r.shiftValue),
      })),
    })),
    breaks: (s.breaks ?? []).map((b) => ({
      key: `b-${b.id}`,
      id: b.id,
      label: b.label ?? "",
      enabled: b.enabled !== false,
      startTime: boxTime(b.startTime),
      endTime: boxTime(b.endTime),
    })),
  };
}

// ── same or changed ──

const num = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));
const sameNumber = (a: string, b: string) => {
  const x = num(a);
  const y = num(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a.trim() === b.trim() : x === y;
};
const sameTime = (a: string, b: string) => {
  const x = toMinutes(a);
  const y = toMinutes(b);
  return x !== null && y !== null ? x === y : a.trim() === b.trim();
};

const sameRule = (a: RuleRow, b: RuleRow) =>
  a.label.trim() === b.label.trim() &&
  a.enabled === b.enabled &&
  sameTime(a.outTime, b.outTime) &&
  a.outNextDay === b.outNextDay &&
  sameNumber(a.shiftValue, b.shiftValue);

const sameGroup = (a: GroupRow, b: GroupRow) =>
  groupSettingsSame(a, b) && a.rules.length === b.rules.length && a.rules.every((r, i) => sameRule(r, b.rules[i]));

/** The group's own boxes, apart from its ladder. */
function groupSettingsSame(a: GroupRow, b: GroupRow): boolean {
  const noMainOut = a.mainOutTime.trim() === "" && b.mainOutTime.trim() === "";
  return (
    a.label.trim() === b.label.trim() &&
    a.kind === b.kind &&
    a.appliesOn === b.appliesOn &&
    a.enabled === b.enabled &&
    sameTime(a.startTime, b.startTime) &&
    sameTime(a.firstPunchFrom, b.firstPunchFrom) &&
    sameTime(a.firstPunchTo, b.firstPunchTo) &&
    (noMainOut || (sameTime(a.mainOutTime, b.mainOutTime) && a.mainOutNextDay === b.mainOutNextDay))
  );
}

const sameBreak = (a: BreakRow, b: BreakRow) =>
  a.label.trim() === b.label.trim() &&
  a.enabled === b.enabled &&
  sameTime(a.startTime, b.startTime) &&
  sameTime(a.endTime, b.endTime);

/** The same rules: the same switches, boxes and rows in the same order. Keys do not count, "1" and "1.00" are one value. */
export function sameDraft(a: ShiftRulesDraft, b: ShiftRulesDraft): boolean {
  return (
    a.enabled === b.enabled &&
    a.effectiveFrom === b.effectiveFrom &&
    sameNumber(a.graceMinutes, b.graceMinutes) &&
    sameNumber(a.minCredit, b.minCredit) &&
    sameNumber(a.roundingStep, b.roundingStep) &&
    a.roundingMode === b.roundingMode &&
    sameNumber(a.fullDayValue, b.fullDayValue) &&
    sameNumber(a.nightSessionHours, b.nightSessionHours) &&
    a.groups.length === b.groups.length &&
    a.groups.every((g, i) => sameGroup(g, b.groups[i])) &&
    a.breaks.length === b.breaks.length &&
    a.breaks.every((r, i) => sameBreak(r, b.breaks[i]))
  );
}

// ── dates ──

export type DateNote = { kind: "none" | "today" | "future" | "past"; text: string };

/**
 * What the chosen "applies from" date means, for the note under the box. Every day before it keeps the old calculation; a
 * date in the past reaches back to days that may already be paid, so it is warned about (never blocked).
 */
export function dateNote(from: string, today: string): DateNote {
  if (!isIsoDate(from)) return { kind: "none", text: "" };
  if (from === today) {
    return {
      kind: "today",
      text: `From today (${prettyDate(from)}) on. Every day before today keeps the old calculation, so nothing already paid is judged again.`,
    };
  }
  if (from > today) {
    return {
      kind: "future",
      text: `They start on ${prettyDate(from)}. Until then every day keeps the old calculation.`,
    };
  }
  return {
    kind: "past",
    text: `${prettyDate(from)} is in the past. Every production day from then until today is judged again with these rules the next time it is opened, and the production payroll of those days changes when it is generated again. Payslips already generated are never rewritten. Choose today's date if you do not want that.`,
  };
}

// ── what is wrong ──

export type RuleErrors = Partial<Record<"label" | "time" | "order" | "value" | "paid", string>>;
export type GroupErrors = Partial<Record<"label" | "start" | "window" | "mainOut" | "overlap" | "table", string>>;
export type BreakErrors = Partial<Record<"label" | "start" | "end" | "overlap", string>>;

export type Validation = {
  effectiveFrom: string | null;
  grace: string | null;
  minCredit: string | null;
  fullDay: string | null;
  nightHours: string | null;
  /** The rules are on but no group is: every day would fall back to the old calculation. */
  noGroup: string | null;
  groups: { errors: GroupErrors; rules: RuleErrors[] }[];
  breaks: BreakErrors[];
  /** The first problem in reading order, as a sentence for the Save bar. */
  first: string | null;
  ok: boolean;
};

const groupName = (g: GroupRow, i: number) => g.label.trim() || `Group ${i + 1}`;

/** Two groups can both be the answer for one day when their days overlap. */
const sharesADay = (a: ProductionShiftAppliesOn, b: ProductionShiftAppliesOn) => a === "all" || b === "all" || a === b;

/**
 * The enabled breaks that can be read, as [start, end] minutes of a day (merged, so two that touch count once). Like the
 * engine, each break also repeats the morning after the shift day began.
 */
function breakSpans(breaks: BreakRow[]): [number, number][] {
  const spans = breaks.flatMap((b) => {
    const start = toMinutes(b.startTime);
    const end = toMinutes(b.endTime);
    return b.enabled && start !== null && end !== null && end > start ? [[start, end] as [number, number]] : [];
  });
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Minutes worked from the start to `at` (both counted from the shift day's midnight) without the breaks: the engine's paid_seconds. */
function paidMinutes(start: number, at: number, spans: [number, number][]): number {
  if (at <= start) return 0;
  let total = at - start;
  for (const [from, to] of spans) {
    for (const day of [0, 1]) {
      const lo = Math.max(start, from + MINUTES_PER_DAY * day);
      const hi = Math.min(at, to + MINUTES_PER_DAY * day);
      if (hi > lo) total -= hi - lo;
    }
  }
  return total;
}

/** The shifts of an earlier row that a later row must not go below. */
const valueOf = (text: string): number | null => parseNumber(text, SHIFT_VALUE).value;

/**
 * Everything the server would refuse, in plain words. Rows that are switched off are only checked for being readable;
 * the order, the rising values and the one-group-per-day rules look at the rows that are on.
 */
export function validateDraft(draft: ShiftRulesDraft): Validation {
  const effectiveFrom = isIsoDate(draft.effectiveFrom) ? null : "Pick the date the rules apply from.";
  const grace = parseNumber(draft.graceMinutes, GRACE).error;
  const minCreditBad = parseNumber(draft.minCredit, MIN_CREDIT).error;
  let minCreditTooHigh: string | null = null;
  const fullDay = parseNumber(draft.fullDayValue, FULL_DAY).error;
  const nightHours = parseNumber(draft.nightSessionHours, NIGHT_HOURS).error;

  const spans = breakSpans(draft.breaks);
  const groups = draft.groups.map((g, gi) => {
    const errors: GroupErrors = {};
    const rules: RuleErrors[] = g.rules.map(() => ({}));
    if (g.label.trim() === "") errors.label = "Give the group a name.";
    else if (g.label.trim().length > LABEL_MAX) errors.label = `Keep the name to ${LABEL_MAX} characters.`;
    const start = toMinutes(g.startTime);
    if (start === null) errors.start = "Enter the start time.";
    const from = toMinutes(g.firstPunchFrom);
    const to = toMinutes(g.firstPunchTo);
    if (from === null || to === null) errors.window = "Enter both times of the first-punch window.";
    else if (from > to) errors.window = "The window must start before it ends.";
    if (g.mainOutTime.trim() !== "") {
      const main = absMinutes(g.mainOutTime, g.mainOutNextDay);
      if (main === null) errors.mainOut = "Enter the departure time.";
      else if (start !== null && main <= start) {
        errors.mainOut = `The standard departure (${pointText(g.mainOutTime, g.mainOutNextDay)}) must be after the start time (${clock12(g.startTime)}).${g.mainOutNextDay ? "" : ' For a time after midnight tick "Next day".'}`;
      }
    }

    // the ladder
    let previous: { index: number; at: number; value: number | null; paid: number } | null = null;
    g.rules.forEach((row, ri) => {
      const e = rules[ri];
      if (row.label.trim().length > LABEL_MAX) e.label = `Keep the name to ${LABEL_MAX} characters.`;
      const at = absMinutes(row.outTime, row.outNextDay);
      if (at === null) e.time = "Enter the leaving time.";
      const value = valueOf(row.shiftValue);
      const valueError = parseNumber(row.shiftValue, SHIFT_VALUE).error;
      if (valueError) e.value = valueError;
      if (!row.enabled || at === null) return;
      const startAt = start;
      if (startAt !== null && at <= startAt) {
        e.time = `Must be later than the start (${clock12(g.startTime)}).${row.outNextDay ? "" : ' For a time after midnight tick "Next day".'}`;
      } else if (previous !== null && at <= previous.at) {
        const prior = g.rules[previous.index];
        const hint = row.outNextDay || at >= MINUTES_PER_DAY ? "" : ' For a time after midnight tick "Next day".';
        e.order = `Must be later than row ${previous.index + 1} (${pointText(prior.outTime, prior.outNextDay)}).${hint}`;
      }
      if (previous !== null && previous.value !== null && value !== null && value < previous.value) {
        e.value = `Must be at least row ${previous.index + 1}'s ${previous.value.toFixed(2)}: leaving later never earns less.`;
      }
      // two rows on the same paid time (a rule at the end of a break, or inside it, and one at its start) cannot be told apart
      const paid = startAt === null ? -1 : paidMinutes(startAt, at, spans);
      if (g.enabled && previous !== null && startAt !== null && paid === previous.paid && !e.time && !e.order) {
        const prior = g.rules[previous.index];
        e.paid = `Row ${previous.index + 1} (${pointText(prior.outTime, prior.outNextDay)}) and this row are on the same paid time, because the break between them is unpaid. Only one of the two can have a rule: remove one, or move it out of the break.`;
      }
      previous = { index: ri, at, value, paid };
    });
    if (g.enabled && !g.rules.some((r) => r.enabled)) {
      errors.table = `${groupName(g, gi)} is in use but none of its rows is switched on. Switch a row on, add one, or switch the group off.`;
    }
    return { errors, rules };
  });

  // one group for a day: the first-punch windows of groups that can be used on the same day must not overlap
  draft.groups.forEach((g, gi) => {
    if (!g.enabled || groups[gi].errors.window) return;
    const from = toMinutes(g.firstPunchFrom) as number;
    const to = toMinutes(g.firstPunchTo) as number;
    for (let oi = 0; oi < gi; oi += 1) {
      const other = draft.groups[oi];
      if (!other.enabled || groups[oi].errors.window || !sharesADay(g.appliesOn, other.appliesOn)) continue;
      const otherFrom = toMinutes(other.firstPunchFrom) as number;
      const otherTo = toMinutes(other.firstPunchTo) as number;
      if (from <= otherTo && otherFrom <= to) {
        groups[gi].errors.overlap =
          `The first-punch window overlaps ${groupName(other, oi)} (${clock12(other.firstPunchFrom)} to ${clock12(other.firstPunchTo)}): a day's first punch must belong to one group. Change a window, or the days one of them applies on.`;
        break;
      }
    }
  });

  // breaks: each ends after it starts, and none overlaps another that is on
  const breaks: BreakErrors[] = draft.breaks.map(() => ({}));
  draft.breaks.forEach((b, i) => {
    const e = breaks[i];
    if (b.label.trim().length > LABEL_MAX) e.label = `Keep the name to ${LABEL_MAX} characters.`;
    const start = toMinutes(b.startTime);
    const end = toMinutes(b.endTime);
    if (start === null) e.start = "Enter the start time.";
    if (end === null) e.end = "Enter the end time.";
    if (start !== null && end !== null && end <= start) e.end = "The break must end after it starts.";
  });
  draft.breaks.forEach((b, i) => {
    if (!b.enabled || Object.keys(breaks[i]).length > 0) return;
    const start = toMinutes(b.startTime) as number;
    const end = toMinutes(b.endTime) as number;
    for (let oi = 0; oi < i; oi += 1) {
      const other = draft.breaks[oi];
      if (!other.enabled || Object.keys(breaks[oi]).length > 0) continue;
      const otherStart = toMinutes(other.startTime) as number;
      const otherEnd = toMinutes(other.endTime) as number;
      if (start < otherEnd && otherStart < end) {
        breaks[i].overlap =
          `Overlaps ${other.label.trim() || autoBreakLabel(other.startTime)} (${clock12(other.startTime)} to ${clock12(other.endTime)}): two breaks cannot share a minute.`;
        break;
      }
    }
  });

  // the rules are on but no group is
  const noGroup =
    draft.enabled && !draft.groups.some((g) => g.enabled)
      ? "The rules are switched on but no shift group is switched on: switch a group on, or switch the rules off."
      : null;

  // the minimum credit may not be more than the most any group in use can pay (the server refuses it)
  if (!minCreditBad) {
    const credit = parseNumber(draft.minCredit, MIN_CREDIT).value;
    if (credit !== null && credit > 0) {
      let lowest: { name: string; top: number } | null = null;
      draft.groups.forEach((g, gi) => {
        if (!g.enabled) return;
        const values = g.rules.filter((r) => r.enabled).flatMap((r) => valueOf(r.shiftValue) ?? []);
        if (values.length === 0) return;
        const top = Math.max(...values);
        if (lowest === null || top < lowest.top) lowest = { name: groupName(g, gi), top };
      });
      const worst = lowest as { name: string; top: number } | null;
      if (worst !== null && credit > worst.top) {
        minCreditTooHigh = `${credit.toFixed(2)} is more than the most ${worst.name} can pay (${worst.top.toFixed(2)}): lower it, or add a higher row.`;
      }
    }
  }

  const minCredit = minCreditBad ?? minCreditTooHigh;

  const rowText = (what: string, rows: RuleErrors[]) =>
    rows.flatMap((e, i) => Object.values(e).map((msg) => `${what}, row ${i + 1}: ${msg}`));
  const problems = [
    effectiveFrom && `Applies from: ${effectiveFrom}`,
    grace && `Grace: ${grace}`,
    ...draft.groups.flatMap((g, gi) => {
      const name = groupName(g, gi);
      const e = groups[gi].errors;
      return [
        e.label && `${name}: ${e.label}`,
        e.start && `${name}: ${e.start}`,
        e.window && `${name}: ${e.window}`,
        e.mainOut && `${name}: ${e.mainOut}`,
        e.overlap && `${name}: ${e.overlap}`,
        e.table,
        ...rowText(name, groups[gi].rules),
      ];
    }),
    ...breaks.flatMap((e, i) => Object.values(e).map((msg) => `Break ${i + 1}: ${msg}`)),
    noGroup,
    minCredit && `Minimum shifts: ${minCredit}`,
    fullDay && `Full-day value: ${fullDay}`,
    nightHours && `Night session: ${nightHours}`,
  ].filter((p): p is string => typeof p === "string" && p !== "");

  return {
    effectiveFrom,
    grace,
    minCredit,
    fullDay,
    nightHours,
    noGroup,
    groups,
    breaks,
    first: problems[0] ?? null,
    ok: problems.length === 0,
  };
}

/**
 * Advice about a row whose leaving time is inside a break (a save is allowed). A break is never paid, so such a row earns
 * what leaving when the break starts earns; the server says the same after a save. It becomes a problem that blocks the
 * save (validateDraft) once another row of the group is on that same paid time, for instance one at the break's start.
 */
export function warningsFor(draft: ShiftRulesDraft): string[] {
  const windows = draft.breaks.flatMap((b) => {
    const start = toMinutes(b.startTime);
    const end = toMinutes(b.endTime);
    return b.enabled && start !== null && end !== null && end > start
      ? [
          {
            name: b.label.trim() || autoBreakLabel(b.startTime),
            start,
            end,
            startText: b.startTime,
            endText: b.endTime,
          },
        ]
      : [];
  });
  return draft.groups.flatMap((g, gi) =>
    !g.enabled
      ? []
      : g.rules.flatMap((r) => {
          const at = absMinutes(r.outTime, r.outNextDay);
          if (!r.enabled || at === null) return [];
          const inside = windows.find(
            (w) => (at > w.start && at < w.end) || (at > w.start + MINUTES_PER_DAY && at < w.end + MINUTES_PER_DAY),
          );
          return inside
            ? [
                `${groupName(g, gi)}: leaving at ${pointText(r.outTime, r.outNextDay)} is inside the break ${inside.name} (${clock12(inside.startText)} to ${clock12(inside.endText)}). A break is never paid, so that row earns what leaving when the break starts earns.`,
              ]
            : [];
        }),
  );
}

/** What an advice sentence is about, so the same advice in the server's words and ours is shown once. */
const adviceTopic = (text: string): "break" | null =>
  /is inside the break|falls inside the/.test(text) ? "break" : null;

/**
 * The advice worth showing next to the server's warnings: a sentence of ours is left out when the form still has that very
 * advice as saved (`savedAdvice`) and the server's warnings already make the point (the same advice in different words).
 * Advice that appeared with an edit since the last save is new, so it is always shown.
 */
export function newAdvice(advice: string[], savedAdvice: string[], serverWarnings: string[]): string[] {
  const covered = new Set(serverWarnings.map(adviceTopic).filter((t) => t !== null));
  return advice.filter((a) => {
    const topic = adviceTopic(a);
    return !(topic !== null && covered.has(topic) && savedAdvice.includes(a));
  });
}

// ── the handwriting the owner has not confirmed ──

/**
 * The two rows that follow the owner's handwritten table exactly as it reads, though the handwriting could mean something
 * else (12:30 AM or PM, 12:00 AM or PM). The note goes away from a row once its time or its value is changed.
 */
export function isUnverifiedRow(group: Pick<GroupRow, "kind">, row: RuleRow): boolean {
  const value = num(row.shiftValue);
  if (group.kind === "day") return row.outTime === "00:30" && row.outNextDay && value === 2.5;
  if (group.kind === "night") return row.outTime === "00:00" && row.outNextDay && value === 0.5;
  return false;
}

/** What else the handwriting of an unverified row could mean, for the note about it. */
const UNVERIFIED_HINT: Partial<Record<ProductionShiftGroupKind, string>> = {
  day: "the handwriting may mean 12:30 PM",
  night: "the handwriting may mean 12:00 PM (noon)",
};

/** The unverified rows of the form, with the group they sit in and what the handwriting could mean, in reading order. */
export function unverifiedRows(draft: ShiftRulesDraft): { group: string; row: RuleRow; hint: string }[] {
  return draft.groups.flatMap((g, gi) =>
    g.rules
      .filter((r) => isUnverifiedRow(g, r))
      .map((row) => ({ group: groupName(g, gi), row, hint: UNVERIFIED_HINT[g.kind] ?? "" })),
  );
}

// ── the top of a ladder ──

/** The highest enabled row of a group: leaving later than it earns no more than its shifts. */
export function ladderCap(group: GroupRow): { time: string; nextDay: boolean; value: string } | null {
  let best: { at: number; row: RuleRow } | null = null;
  for (const row of group.rules) {
    const at = absMinutes(row.outTime, row.outNextDay);
    if (row.enabled && at !== null && (best === null || at > best.at)) best = { at, row };
  }
  return best ? { time: best.row.outTime, nextDay: best.row.outNextDay, value: best.row.shiftValue } : null;
}

// ── what is sent ──

/**
 * The save request. Call it only for a draft that passes validateDraft. `expectedVersion` is the `version` the rules had
 * when the draft was started from them: the server refuses the save if somebody else has saved since.
 */
export function toInput(draft: ShiftRulesDraft, expectedVersion?: string | null): ProductionShiftRulesInput {
  return {
    ...(expectedVersion ? { expectedVersion } : {}),
    enabled: draft.enabled,
    effectiveFrom: draft.effectiveFrom,
    graceMinutes: num(draft.graceMinutes),
    minCredit: num(draft.minCredit),
    roundingStep: num(draft.roundingStep),
    roundingMode: draft.roundingMode,
    fullDayValue: num(draft.fullDayValue),
    nightSessionHours: num(draft.nightSessionHours),
    groups: draft.groups.map((g) => ({
      ...(g.id === null ? {} : { id: g.id }),
      label: g.label.trim(),
      kind: g.kind,
      appliesOn: g.appliesOn,
      startTime: g.startTime,
      firstPunchFrom: g.firstPunchFrom,
      firstPunchTo: g.firstPunchTo,
      mainOutTime: g.mainOutTime.trim() === "" ? null : g.mainOutTime,
      mainOutNextDay: g.mainOutTime.trim() === "" ? false : g.mainOutNextDay,
      enabled: g.enabled,
      rules: g.rules.map((r) => ({
        ...(r.id === null ? {} : { id: r.id }),
        label: r.label.trim() || autoRuleLabel(r.outTime, r.outNextDay),
        outTime: r.outTime,
        outNextDay: r.outNextDay,
        shiftValue: num(r.shiftValue),
        enabled: r.enabled,
      })),
    })),
    breaks: draft.breaks.map((b) => ({
      ...(b.id === null ? {} : { id: b.id }),
      label: b.label.trim() || autoBreakLabel(b.startTime),
      startTime: b.startTime,
      endTime: b.endTime,
      enabled: b.enabled,
    })),
  };
}

// ── editing the rows ──

/** Change a row's time or its "next day" tick; the automatic name follows, a typed one stays. */
export function setRuleTime(rows: RuleRow[], key: string, change: Partial<Pick<RuleRow, "outTime" | "outNextDay">>) {
  return rows.map((row) => {
    if (row.key !== key) return row;
    const next = { ...row, ...change };
    const followed = row.label.trim() === "" || row.label.trim() === autoRuleLabel(row.outTime, row.outNextDay);
    return followed ? { ...next, label: autoRuleLabel(next.outTime, next.outNextDay) } : next;
  });
}

/** Rows in order of leaving time; left as they are while any time cannot be read yet. */
export function sortRules(rows: RuleRow[]): RuleRow[] {
  const at = rows.map((r) => absMinutes(r.outTime, r.outNextDay));
  if (at.some((a) => a === null)) return rows;
  const order = rows.map((_, i) => i).sort((a, b) => (at[a] as number) - (at[b] as number) || a - b);
  const sorted = order.map((i) => rows[i]);
  return sorted.every((r, i) => r === rows[i]) ? rows : sorted;
}

/** Breaks in order of start time; left as they are while any time cannot be read yet. */
export function sortBreaks(rows: BreakRow[]): BreakRow[] {
  const at = rows.map((r) => toMinutes(r.startTime));
  if (at.some((a) => a === null)) return rows;
  const order = rows.map((_, i) => i).sort((a, b) => (at[a] as number) - (at[b] as number) || a - b);
  const sorted = order.map((i) => rows[i]);
  return sorted.every((r, i) => r === rows[i]) ? rows : sorted;
}

/** A new ladder row: one hour after the latest row (or the start), earning what that row earns (HR sets the figure). */
export function addRule(group: GroupRow): RuleRow[] {
  const times = group.rules.flatMap((r) => {
    const at = absMinutes(r.outTime, r.outNextDay);
    return at === null ? [] : [{ at, value: r.shiftValue }];
  });
  const start = toMinutes(group.startTime) ?? 8 * 60 + 30;
  const top = times.reduce<{ at: number; value: string } | null>(
    (best, t) => (best === null || t.at >= best.at ? t : best),
    null,
  );
  const at = Math.min(2 * MINUTES_PER_DAY - 1, (top ? top.at : start) + 60);
  const outNextDay = at >= MINUTES_PER_DAY;
  const outTime = toHHMM(at);
  const row: RuleRow = {
    key: freshKey("r"),
    id: null,
    label: autoRuleLabel(outTime, outNextDay),
    enabled: true,
    outTime,
    outNextDay,
    shiftValue: top ? top.value : "1.00",
  };
  return [...group.rules, row];
}

/** A new group: switched OFF until HR has set its window (a group that is on must not share a first-punch window). */
export function newGroup(): GroupRow {
  const row: RuleRow = {
    key: freshKey("r"),
    id: null,
    label: autoRuleLabel("17:00", false),
    enabled: true,
    outTime: "17:00",
    outNextDay: false,
    shiftValue: "1.00",
  };
  return {
    key: freshKey("g"),
    id: null,
    label: "New group",
    kind: "custom",
    appliesOn: "all",
    startTime: "08:30",
    firstPunchFrom: "04:00",
    firstPunchTo: "16:59",
    mainOutTime: "17:00",
    mainOutNextDay: false,
    enabled: false,
    rules: [row],
  };
}

/** A new break: an hour after the latest one ends, 15 minutes long. */
export function addBreak(rows: BreakRow[]): BreakRow[] {
  const last = rows.reduce((best, r) => Math.max(best, toMinutes(r.endTime) ?? 0), 9 * 60);
  const start = Math.min(23 * 60 + 30, last + 60);
  const startTime = toHHMM(start);
  return [
    ...rows,
    {
      key: freshKey("b"),
      id: null,
      label: autoBreakLabel(startTime),
      enabled: true,
      startTime,
      endTime: toHHMM(start + 15),
    },
  ];
}

/** Change a break's start; the automatic name follows, a typed one stays. */
export function setBreakStart(rows: BreakRow[], key: string, startTime: string): BreakRow[] {
  return rows.map((row) => {
    if (row.key !== key) return row;
    const followed = row.label.trim() === "" || row.label.trim() === autoBreakLabel(row.startTime);
    return { ...row, startTime, label: followed ? autoBreakLabel(startTime) : row.label };
  });
}

// ── what changes (for the question before a save) ──

const shiftsText = (value: string) => `${Number(value).toFixed(2)} shifts`;
const rowSummary = (r: RuleRow) =>
  `${pointText(r.outTime, r.outNextDay)} = ${shiftsText(r.shiftValue)}${r.enabled ? "" : " (off)"}`;

/** Every change between the saved rules and the form, one line each (pay-affecting ones marked), for the confirm dialog. */
export function draftChanges(draft: ShiftRulesDraft, saved: ShiftRulesDraft): Change[] {
  const out: Change[] = [];
  const push = (key: string, label: string, from: string, to: string, money = true) =>
    out.push({ key, label, from, to, money });

  if (draft.enabled !== saved.enabled) {
    push("enabled", "Production shift rules", saved.enabled ? "On" : "Off", draft.enabled ? "On" : "Off");
  }
  if (draft.effectiveFrom !== saved.effectiveFrom) {
    push("from", "Applies from", prettyDate(saved.effectiveFrom) || "-", prettyDate(draft.effectiveFrom) || "-");
  }
  if (!sameNumber(draft.graceMinutes, saved.graceMinutes)) {
    push("grace", "Grace", `${saved.graceMinutes} min`, `${draft.graceMinutes} min`);
  }
  if (!sameNumber(draft.minCredit, saved.minCredit)) {
    push("minCredit", "Minimum shifts", saved.minCredit, draft.minCredit);
  }
  if (!sameNumber(draft.roundingStep, saved.roundingStep) || draft.roundingMode !== saved.roundingMode) {
    push(
      "rounding",
      "Rounding",
      `${saved.roundingStep} (${saved.roundingMode})`,
      `${draft.roundingStep} (${draft.roundingMode})`,
    );
  }
  if (!sameNumber(draft.fullDayValue, saved.fullDayValue)) {
    push("fullDay", "Full-day value", saved.fullDayValue, draft.fullDayValue);
  }
  if (!sameNumber(draft.nightSessionHours, saved.nightSessionHours)) {
    push("night", "Night session", `${saved.nightSessionHours} h`, `${draft.nightSessionHours} h`, false);
  }

  const savedGroups = new Map(saved.groups.filter((g) => g.id !== null).map((g) => [g.id, g]));
  const keptIds = new Set(draft.groups.map((g) => g.id).filter((id): id is number => id !== null));
  for (const g of saved.groups) {
    if (g.id !== null && !keptIds.has(g.id)) push(`g${g.id}`, groupName(g, 0), "in use", "removed");
  }
  draft.groups.forEach((g, gi) => {
    const name = groupName(g, gi);
    const before = g.id === null ? undefined : savedGroups.get(g.id);
    if (!before) {
      push(`g-new-${g.key}`, name, "-", `added with ${g.rules.length} ${g.rules.length === 1 ? "row" : "rows"}`);
      return;
    }
    if (!groupSettingsSame(g, before)) {
      push(`g${g.id}`, `${name}: settings`, "as saved", "changed");
    }
    const beforeRules = new Map(before.rules.filter((r) => r.id !== null).map((r) => [r.id, r]));
    const keptRules = new Set(g.rules.map((r) => r.id).filter((id): id is number => id !== null));
    for (const r of before.rules) {
      if (r.id !== null && !keptRules.has(r.id)) push(`r${r.id}`, `${name}: row`, rowSummary(r), "removed");
    }
    for (const r of g.rules) {
      const old = r.id === null ? undefined : beforeRules.get(r.id);
      if (!old) push(`r-new-${r.key}`, `${name}: row`, "-", `added ${rowSummary(r)}`);
      else if (!sameRule(r, old)) push(`r${r.id}`, `${name}: row`, rowSummary(old), rowSummary(r));
    }
  });

  const savedBreaks = new Map(saved.breaks.filter((b) => b.id !== null).map((b) => [b.id, b]));
  const keptBreaks = new Set(draft.breaks.map((b) => b.id).filter((id): id is number => id !== null));
  const breakSummary = (b: BreakRow) => `${clock12(b.startTime)} to ${clock12(b.endTime)}${b.enabled ? "" : " (off)"}`;
  for (const b of saved.breaks) {
    if (b.id !== null && !keptBreaks.has(b.id))
      push(`b${b.id}`, `Break ${b.label || autoBreakLabel(b.startTime)}`, breakSummary(b), "removed");
  }
  for (const b of draft.breaks) {
    const old = b.id === null ? undefined : savedBreaks.get(b.id);
    const name = `Break ${b.label.trim() || autoBreakLabel(b.startTime)}`;
    if (!old) push(`b-new-${b.key}`, name, "-", `added ${breakSummary(b)}`);
    else if (!sameBreak(b, old)) push(`b${b.id}`, name, breakSummary(old), breakSummary(b));
  }
  return out;
}

// ── the old calculation, in a line ──

/** "Punch 1 08:30, Punch 4 20:00, grace 10 minutes": what the old calculation used before the start date. */
export function legacyText(legacy: ProductionShiftLegacy | null | undefined): string {
  if (!legacy) return "";
  const parts: string[] = [];
  if (legacy.punch1Time) parts.push(`first punch ${clock12(boxTime(legacy.punch1Time))}`);
  if (legacy.punch4Time) parts.push(`last punch ${clock12(boxTime(legacy.punch4Time))}`);
  if (typeof legacy.graceMinutes === "number") parts.push(`grace ${legacy.graceMinutes} minutes`);
  return parts.join(", ");
}
