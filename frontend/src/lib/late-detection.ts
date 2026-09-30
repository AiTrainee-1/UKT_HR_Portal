import type { PermissionType, PermissionWireType } from "@/lib/api-client/custom-hooks";
import { TONE, type Tone } from "@/lib/statusTones";

// Pure presentation rules for Late Detection, Permissions and Half-Day Detection, shared by every HR page that shows
// an attendance day, a permission request or a payslip's late deduction. Nothing here fetches or mutates anything;
// the rules themselves live in backend/api/attendance_final.py and this only reads back what the API already decided.

/** Settings → Attendance defaults; the API always sends the real values, these only cover a settings load in flight. */
export const DEFAULT_FIRST_HALF_END = "13:30";
export const DEFAULT_SECOND_HALF_START = "14:30";

/** Every permission is exactly this long, whatever type it is. */
export const PERMISSION_MINUTES = 60;

// ── clock times ──

/** "HH:MM" or "HH:MM:SS" -> minutes past midnight; null for anything else (blank, "25:00", "9:5"). */
export function clockMinutes(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((value ?? "").trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

/**
 * Client-side twin of the settings PUT's Half-Day check, so the message shows before the request is sent: both times
 * must be real clock times and the Morning half must end no later than the Evening half starts. Equal is allowed.
 * Returns the message to show, or null when the pair is fine.
 */
export function validateHalfDayTimes(
  firstHalfEnd: string | null | undefined,
  secondHalfStart: string | null | undefined,
): string | null {
  const first = clockMinutes(firstHalfEnd);
  const second = clockMinutes(secondHalfStart);
  if (first === null || second === null) return "Enter both Half-Day times (First Half End and Second Half Start).";
  if (first > second) return "First Half End Time must not be later than Second Half Start Time.";
  return null;
}

// ── half day ──

export type HalfDayHalf = "morning" | "evening";

/**
 * Which half a Half Day was worked in. The day itself knows: a day computed by the arrival timeline carries its
 * `arrivalZone`, and "second_half" means the employee arrived after the first-half limit (the Evening half), any other
 * zone that they made the first half (the Morning half). Without a zone (a manual override, an older record) it falls
 * back to the retired fixed First Half End time: a first punch before it is the Morning half, otherwise the Evening one.
 * Null when there is no first punch to judge by (a manual override may have none).
 */
export function halfDayWorked(
  firstPunch: string | null | undefined,
  firstHalfEnd: string | null | undefined = DEFAULT_FIRST_HALF_END,
  arrivalZone?: string | null,
): HalfDayHalf | null {
  if (arrivalZone) return arrivalZone === "second_half" ? "evening" : "morning";
  const first = clockMinutes(firstPunch);
  if (first === null) return null;
  const cutoff = clockMinutes(firstHalfEnd) ?? clockMinutes(DEFAULT_FIRST_HALF_END)!;
  return first < cutoff ? "morning" : "evening";
}

/** The Attendance Sheet endpoint spells the Evening half "afternoon"; everything else on screen says Evening. */
export function normalizeHalf(period: string | null | undefined): HalfDayHalf | null {
  if (period === "morning") return "morning";
  if (period === "afternoon" || period === "evening") return "evening";
  return null;
}

export const halfLabel = (half: HalfDayHalf): string => (half === "morning" ? "Morning half" : "Evening half");

// ── a day's Late Detection / Permission state ──

/** What the API says about one attendance day; every field is optional because each endpoint sends a slightly different set. */
export type DayLateState = {
  status?: string | null;
  isLate?: boolean | null;
  /** Most endpoints say isEarlyOut ... */
  isEarlyOut?: boolean | null;
  /** ... but employee-monthly and the report-log detail say earlyLeave. */
  earlyLeave?: boolean | null;
  isHalfShift?: boolean | null;
  /** Strict mode's lunch-return lateness ("Night Late") -informational, never priced. */
  lateAfternoon?: boolean | null;
  /** Plain-language explanation of why the day was flagged; only some endpoints send it. */
  lateReason?: string | null;
  morningPermissionApplied?: boolean | null;
  eveningPermissionApplied?: boolean | null;
  morningPermissionExcess?: boolean | null;
  eveningPermissionExcess?: boolean | null;
  middlePermissionToday?: boolean | null;
  /** Strict mode's lunch-return permission zone. */
  permissionAfternoon?: boolean | null;
  firstPunch?: string | null;
  /** The Attendance Sheet's own answer to "which half" (morning | afternoon). Wins over the first-punch inference. */
  halfDayPeriod?: string | null;
  /** Where the first punch fell on the morning arrival timeline: on_time | late | excused | quarter | second_half. */
  arrivalZone?: string | null;
};

export type HalfDayCutoffs = { firstHalfEnd?: string | null; secondHalfStart?: string | null };

export const isEarlyOutDay = (day: DayLateState): boolean => !!(day.isEarlyOut ?? day.earlyLeave);

export type LateFlagKind =
  | "late"
  | "earlyOut"
  | "lateAfternoon"
  | "halfDay"
  | "quarterShift"
  | "permissionApplied"
  | "permissionExcess"
  | "middlePermission"
  | "permissionAfternoon";

/** One colour per kind, all from the portal's shared tone palette (statusTones.ts) except the lunch-return permission. */
export const LATE_FLAG_CLASS: Record<LateFlagKind, string> = {
  late: TONE.caution,
  earlyOut: TONE.caution,
  lateAfternoon: TONE.caution,
  halfDay: TONE.warning,
  quarterShift: TONE.warning,
  permissionApplied: TONE.success,
  permissionExcess: TONE.danger,
  middlePermission: TONE.info,
  permissionAfternoon: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

export type LateFlag = {
  key: string;
  kind: LateFlagKind;
  label: string;
  /** Short qualifier shown after the label. */
  detail?: string;
  /** The longer explanation, for a tooltip. */
  title: string;
};

const sides = (morning: boolean, evening: boolean): string =>
  morning && evening ? "Morning + Evening" : morning ? "Morning" : "Evening";

/**
 * The badges one attendance day earns from Late Detection, Permissions and Half-Day Detection, in reading order. Only
 * things that are true are returned, so an ordinary day has none. The day's own status (Present / Half Shift ...) is
 * shown separately by each page. Late / Early Out are only ever raised for a day somebody actually worked.
 */
export function lateDetectionFlags(day: DayLateState, cutoffs: HalfDayCutoffs = {}): LateFlag[] {
  const flags: LateFlag[] = [];
  const worked = !day.status || day.status === "present" || day.status === "half_shift";
  const reason = day.lateReason?.trim() || null;
  const firstHalfEnd = cutoffs.firstHalfEnd || DEFAULT_FIRST_HALF_END;
  const secondHalfStart = cutoffs.secondHalfStart || DEFAULT_SECOND_HALF_START;

  if (worked && day.isLate) {
    flags.push({
      key: "late",
      kind: "late",
      label: "Late",
      title:
        reason ??
        "Morning Late-In: the first punch was after the shift start plus grace, inside the Late window (Settings → Attendance).",
    });
  }
  // Only a Full Day is docked; a quarter-zone arrival that is already a Half Day (no second-half punch) is not docked twice.
  if (worked && day.arrivalZone === "quarter" && (day.status ?? "present") === "present") {
    flags.push({
      key: "quarterShift",
      kind: "quarterShift",
      label: "Quarter shift",
      detail: "late arrival",
      title:
        reason ??
        "The first punch was after the Late window: a quarter shift is deducted (a small deduction instead of a Half Day). It is not also counted as Late.",
    });
  }
  if (worked && isEarlyOutDay(day)) {
    flags.push({
      key: "earlyOut",
      kind: "earlyOut",
      label: "Early Out",
      title:
        reason ??
        "Evening Early-Out: the last punch was before the shift end minus grace (moved 60 minutes earlier on a day an Allowed Evening Early-Out permission applied).",
    });
  }
  if (worked && day.lateAfternoon) {
    flags.push({
      key: "lateAfternoon",
      kind: "lateAfternoon",
      label: "Late after lunch",
      title:
        "Strict mode only: came back from lunch late. Informational -it neither changes Full/Half Day nor counts in the monthly late pool.",
    });
  }

  const isHalf = day.status === "half_shift" || !!day.isHalfShift;
  if (isHalf) {
    const half = normalizeHalf(day.halfDayPeriod) ?? halfDayWorked(day.firstPunch, firstHalfEnd, day.arrivalZone);
    // A Half Shift status already says "half" on every page -say something only when it adds which half, or when the
    // status is not itself half shift (a Full-status day flagged half is an oddity worth naming).
    if (half || day.status !== "half_shift") {
      flags.push({
        key: "half",
        kind: "halfDay",
        label: half ? `${halfLabel(half)} only` : "Half Day",
        title: half
          ? half === "morning"
            ? `Half Day: came in for the Morning half, but no punch at or after ${secondHalfStart}.`
            : day.arrivalZone === "second_half"
              ? `Half Day: arrived after the first-half limit (shift start + grace + the arrival windows in Settings → Attendance), with a punch at or after ${secondHalfStart}.`
              : `Half Day: punches only in the Evening half (at or after ${secondHalfStart}).`
          : `Half Day: punches in only one of the two halves.`,
      });
    }
  }

  if (day.morningPermissionApplied || day.eveningPermissionApplied) {
    const parts: string[] = [];
    if (day.morningPermissionApplied) {
      parts.push(
        "An Allowed Morning Late-In permission excused the arrival up to the end of the permission window (Settings → Attendance).",
      );
    }
    if (day.eveningPermissionApplied) {
      parts.push(
        `An Allowed Evening Early-Out permission moved today's shift end ${PERMISSION_MINUTES} minutes earlier.`,
      );
    }
    flags.push({
      key: "permApplied",
      kind: "permissionApplied",
      label: "Allowed permission applied",
      detail: sides(!!day.morningPermissionApplied, !!day.eveningPermissionApplied),
      title: parts.join(" "),
    });
  }
  if (day.morningPermissionExcess || day.eveningPermissionExcess) {
    flags.push({
      key: "permExcess",
      kind: "permissionExcess",
      label: "Excess permission",
      detail: "did not protect the day",
      title:
        `${sides(!!day.morningPermissionExcess, !!day.eveningPermissionExcess)} permission approved, but beyond the ` +
        "monthly cap: it did not move the shift boundary, the day was judged against the plain shift time, and it " +
        "counts as one occurrence in the monthly late pool.",
    });
  }
  if (day.middlePermissionToday) {
    flags.push({
      key: "permMiddle",
      kind: "middlePermission",
      label: "Middle One-Hour",
      title: `Middle One-Hour Permission: excuses a ${PERMISSION_MINUTES} minute gap during the shift. It never moves the shift start or end.`,
    });
  }
  if (day.permissionAfternoon) {
    flags.push({
      key: "permAfternoon",
      kind: "permissionAfternoon",
      label: "Lunch-return permission",
      title: "Strict mode only: the lunch return fell inside the afternoon permission zone. Informational.",
    });
  }
  return flags;
}

/** The written reason behind a day's flags, when the API sent one (plain text, blank -> none). */
export function lateReasonText(day: DayLateState): string | null {
  return day.lateReason?.trim() || null;
}

// ── permissions ──

/** The three permission types, in the order the selector offers them (the API accepts and sends these keys). */
export const PERMISSION_TYPES: readonly { key: PermissionType; label: string; hint: string }[] = [
  {
    key: "morning_late_in",
    label: "Morning Late-In",
    hint: "Arriving up to 60 minutes after the shift start. When Allowed, that day's shift start moves 60 minutes later.",
  },
  {
    key: "evening_early_out",
    label: "Evening Early-Out",
    hint: "Leaving up to 60 minutes before the shift end. When Allowed, that day's shift end moves 60 minutes earlier.",
  },
  {
    key: "middle_permission",
    label: "Middle One-Hour Permission",
    hint: "A 60 minute gap during the shift. It never moves the shift start or end.",
  },
];

/** Every spelling the API has ever used for a type, keyed the way the server normalises them (lower-case, underscores). */
const TYPE_ALIASES: Record<string, PermissionType> = {
  morning_late_in: "morning_late_in",
  late_in: "morning_late_in",
  evening_early_out: "evening_early_out",
  early_out: "evening_early_out",
  middle_permission: "middle_permission",
  middle_one_hour_permission: "middle_permission",
  middle_one_hour: "middle_permission",
  short_leave: "middle_permission",
};

/** Any accepted spelling ("Late In", "early-out", "morning_late_in" ...) -> the canonical key, or null. */
export function normalizePermissionType(raw: string | null | undefined): PermissionType | null {
  if (raw == null) return null;
  const key = raw.trim().toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean).join("_");
  return Object.prototype.hasOwnProperty.call(TYPE_ALIASES, key) ? TYPE_ALIASES[key] : null;
}

export const permissionTypeLabelOf = (key: PermissionType | null | undefined): string | null =>
  PERMISSION_TYPES.find((t) => t.key === key)?.label ?? null;

/**
 * A permission's type label: the API's own typeLabel, else derived from typeKey, else from the deprecated `type`
 * string; null when the request has no type at all (older web-app submissions, until HR classifies them).
 */
export function permissionTypeLabel(p: {
  typeLabel?: string | null;
  typeKey?: string | null;
  type?: string | null;
}): string | null {
  return (
    p.typeLabel ||
    permissionTypeLabelOf(normalizePermissionType(p.typeKey)) ||
    permissionTypeLabelOf(normalizePermissionType(p.type)) ||
    null
  );
}

export type PermissionOutcome = { label: string; tone: Tone; className: string; explanation: string };

const outcome = (label: string, tone: Tone, explanation: string): PermissionOutcome => ({
  label,
  tone,
  className: TONE[tone],
  explanation,
});

/**
 * A permission's canonical type: typeKey when the server sends it, else the deprecated `type` field (which holds the
 * pre-rewrite spelling -"Late In" / "Early Out" / "Short Leave" -on an older backend, which never sends typeKey).
 * Null only when the request genuinely has no type. Test this, never bare `typeKey`.
 */
export function permissionTypeKey(p: { typeKey?: string | null; type?: string | null }): PermissionType | null {
  return normalizePermissionType(p.typeKey) ?? normalizePermissionType(p.type);
}

const WIRE_TYPES: Record<PermissionType, PermissionWireType> = {
  morning_late_in: "Late In",
  evening_early_out: "Early Out",
  middle_permission: "Short Leave",
};

/**
 * The spelling to put on the wire when creating or re-typing a permission. Always the pre-rewrite one: the rewritten
 * backend accepts either spelling, an older backend rejects the new slugs with a 400, and the two roll out at
 * different moments.
 */
export const permissionTypeWire = (type: PermissionType): PermissionWireType => WIRE_TYPES[type];

/**
 * What a permission request amounts to, in the words the policy uses: Pending, Allowed (approved and within the
 * monthly cap), Not Allowed (rejected), Overdue / Excess (approved but beyond the cap). "Allowed" is only ever said
 * when the server said the request is within the cap (capStatus "within_cap"): a backend that does not report
 * capStatus gets plain "Approved" and no claim about what it moved.
 */
export function permissionOutcome(p: {
  status: string;
  capStatus?: string | null;
  statusLabel?: string | null;
  typeKey?: string | null;
  type?: string | null;
  monthlyLimit?: number | null;
}): PermissionOutcome {
  const capKnown = p.capStatus != null;
  if (p.status === "pending") {
    return outcome(
      p.statusLabel || "Pending",
      "warning",
      capKnown
        ? "Waiting for a decision. Only an approval within the monthly cap can move a shift boundary."
        : "Waiting for a decision.",
    );
  }
  if (p.status === "rejected") {
    return outcome(p.statusLabel || "Not Allowed", "danger", "Rejected -it has no effect on attendance.");
  }
  if (p.capStatus === "excess") {
    const cap = p.monthlyLimit != null ? ` of ${p.monthlyLimit}` : "";
    return outcome(
      p.statusLabel || "Overdue / Excess",
      "caution",
      `Approved, but beyond the monthly cap${cap}: it does not move the shift boundary and counts as one occurrence in the monthly late pool.`,
    );
  }
  if (p.capStatus === "within_cap") {
    const type = permissionTypeKey(p);
    const effect =
      type === "morning_late_in"
        ? `That day's shift start moves ${PERMISSION_MINUTES} minutes later.`
        : type === "evening_early_out"
          ? `That day's shift end moves ${PERMISSION_MINUTES} minutes earlier.`
          : type === "middle_permission"
            ? `It excuses a ${PERMISSION_MINUTES} minute gap during the shift; nothing moves.`
            : "It has no type yet, so it cannot move a shift boundary until one is set.";
    return outcome(p.statusLabel || "Allowed", "success", `Approved within the monthly cap. ${effect}`);
  }
  // Approved, and the server did not say whether it is within the cap (an older backend): just "Approved".
  return outcome(p.statusLabel || "Approved", "success", "");
}

// ── the monthly late pool ──

/** The shapes of a late-pool summary the API sends: a payslip's lateSummary, and employee-shift-stats' summary. */
export type LatePoolInput = {
  lateInCount?: number | null;
  earlyOutCount?: number | null;
  excessPermissionCount?: number | null;
  totalLateCount?: number | null;
  freeAllowanceUsed?: number | null;
  freeAllowance?: number | null;
  permissionMonthlyCap?: number | null;
  billableLateCount?: number | null;
  shiftDeductions?: number | string | null;
  lateInDays?: number | null;
  earlyOutDays?: number | null;
};

export type LatePoolView = {
  /** False for a payslip generated before the split into late-in / early-out / excess (only a total is known). */
  detailed: boolean;
  lateIn: number | null;
  earlyOut: number | null;
  excess: number | null;
  total: number;
  freeAllowance: number | null;
  freeUsed: number | null;
  billable: number;
  shifts: number;
  permissionCap: number | null;
  lateInDays: number | null;
  earlyOutDays: number | null;
  /** True when more days were flagged than occurrences counted: a late day with an Excess permission counts once. */
  mergedIntoExcess: boolean;
};

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Normalises a late-pool summary so the UI never has to print "undefined": an older payslip has only totalLateCount,
 * billableLateCount and shiftDeductions, a current one also has the split; both come out as one shape.
 */
export function latePoolView(s: LatePoolInput | null | undefined): LatePoolView | null {
  if (!s) return null;
  const lateIn = numOrNull(s.lateInCount);
  const earlyOut = numOrNull(s.earlyOutCount);
  const excess = numOrNull(s.excessPermissionCount);
  const detailed = lateIn !== null || earlyOut !== null || excess !== null;
  const total = numOrNull(s.totalLateCount) ?? (lateIn ?? 0) + (earlyOut ?? 0) + (excess ?? 0);
  const freeAllowance = numOrNull(s.freeAllowance);
  const freeUsed = numOrNull(s.freeAllowanceUsed) ?? (freeAllowance !== null ? Math.min(total, freeAllowance) : null);
  const billable = numOrNull(s.billableLateCount) ?? Math.max(0, total - (freeUsed ?? 0));
  const shifts = Number(s.shiftDeductions ?? 0);
  const lateInDays = numOrNull(s.lateInDays);
  const earlyOutDays = numOrNull(s.earlyOutDays);
  return {
    detailed,
    lateIn,
    earlyOut,
    excess,
    total,
    freeAllowance,
    freeUsed,
    billable,
    shifts: Number.isFinite(shifts) ? shifts : 0,
    permissionCap: numOrNull(s.permissionMonthlyCap),
    lateInDays,
    earlyOutDays,
    mergedIntoExcess:
      (lateInDays !== null && lateIn !== null && lateInDays > lateIn) ||
      (earlyOutDays !== null && earlyOut !== null && earlyOutDays > earlyOut),
  };
}
