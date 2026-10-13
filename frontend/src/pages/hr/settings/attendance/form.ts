import {
  DEFAULT_ARRIVAL,
  MAX_WINDOW_MINUTES,
  minutesOf,
  validateArrival,
  type ArrivalSettings,
} from "@/lib/arrival-rules";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";

// The Staff part of the Attendance tab as one form: what is loaded from GET /api/payroll-settings, what is checked
// before saving, what changed, and the exact body the "Save Attendance Settings" PUT sends. Number boxes are kept as the
// text typed (an emptied box is an error to fix, not a silent 0); they become numbers only in the request.

export type StaffDraft = {
  attendanceMode: "strict" | "simple";
  /** null = the server did not report the switch (an older backend): it cannot be changed here. */
  morningLateInEnabled: boolean | null;
  eveningEarlyOutEnabled: boolean | null;
  secondHalfStart: string;
  lateWindow: string;
  permissionWindow: string;
  extraMinutes: string;
  quarterDeduction: string;
  nightLateWindow: string;
  lunchPermissionZone: string;
  forgottenExitHours: string;
  earlyArrivalProtectionHours: string;
};

/**
 * Settings nothing reads any more (the old half-shift cut-off, the six fixed production windows and the "defaults for
 * new shifts"). They have no control, but the Staff save has always sent them, so they are sent back exactly as loaded.
 */
export type CarriedKeys = Pick<
  PayrollSettingsItem,
  | "simpleHalfShiftCutoff"
  | "prodFirstHalfStart"
  | "prodFirstHalfEnd"
  | "prodSecondHalfStart"
  | "prodSecondHalfEnd"
  | "prodExtraStart"
  | "prodExtraEnd"
> & {
  defaultShiftGraceMinutes: number;
  defaultShiftFirstHalfEnd: string;
  defaultShiftLunchDurationMinutes: number;
  defaultShiftLunchGraceMinutes: number;
};

/** What the server allows this login to change (see the field notes in the tab). */
export type StaffAccess = {
  /** False for a branch-assigned login: company-wide rules are shown but never sent (the server answers 403). */
  companyWideEditable: boolean;
  halfDayReported: boolean;
  arrivalReported: boolean;
  morningReported: boolean;
  eveningReported: boolean;
};

export function staffAccess(data: Partial<PayrollSettingsItem> | undefined): StaffAccess {
  return {
    companyWideEditable: data?.companyWideRulesEditable !== false,
    halfDayReported: data?.halfDaySecondHalfStartTime != null,
    arrivalReported: data?.arrivalLateWindowMinutes != null,
    morningReported: data?.morningLateInEnabled != null,
    eveningReported: data?.eveningEarlyOutEnabled != null,
  };
}

const text = (value: number | null | undefined, fallback: number) => String(value ?? fallback);

export function staffDraftFrom(data: Partial<PayrollSettingsItem>): StaffDraft {
  return {
    attendanceMode: data.attendanceMode === "simple" ? "simple" : "strict",
    morningLateInEnabled: data.morningLateInEnabled ?? null,
    eveningEarlyOutEnabled: data.eveningEarlyOutEnabled ?? null,
    secondHalfStart: data.halfDaySecondHalfStartTime || "14:30",
    lateWindow: text(data.arrivalLateWindowMinutes, DEFAULT_ARRIVAL.lateWindowMinutes),
    permissionWindow: text(data.arrivalPermissionWindowMinutes, DEFAULT_ARRIVAL.permissionWindowMinutes),
    extraMinutes: text(data.arrivalExtraMinutes, DEFAULT_ARRIVAL.extraMinutes),
    quarterDeduction: text(data.arrivalQuarterDeduction, DEFAULT_ARRIVAL.quarterDeduction),
    nightLateWindow: text(data.afternoonLateWindowMinutes, 60),
    lunchPermissionZone: text(data.afternoonPermissionWindowMinutes, 60),
    forgottenExitHours: text(data.lastPunchPostShiftGraceHours, 9),
    earlyArrivalProtectionHours: text(data.firstPunchPreShiftBufferHours, 2),
  };
}

/** The same fallbacks the tab has always used, so a save sends back what it loaded. */
export function carriedKeysFrom(data: Partial<PayrollSettingsItem>): CarriedKeys {
  return {
    simpleHalfShiftCutoff: data.simpleHalfShiftCutoff || "13:30",
    prodFirstHalfStart: data.prodFirstHalfStart || "08:30",
    prodFirstHalfEnd: data.prodFirstHalfEnd || "12:30",
    prodSecondHalfStart: data.prodSecondHalfStart || "13:30",
    prodSecondHalfEnd: data.prodSecondHalfEnd || "17:30",
    prodExtraStart: data.prodExtraStart || "17:50",
    prodExtraEnd: data.prodExtraEnd || "20:00",
    defaultShiftGraceMinutes: data.defaultShiftGraceMinutes ?? 15,
    defaultShiftFirstHalfEnd: data.defaultShiftFirstHalfEnd || "13:30",
    defaultShiftLunchDurationMinutes: data.defaultShiftLunchDurationMinutes ?? 60,
    defaultShiftLunchGraceMinutes: data.defaultShiftLunchGraceMinutes ?? 10,
  };
}

/** A number box's text as a number; NaN when it is empty or not a number. */
export const num = (value: string): number => (value.trim() === "" ? NaN : Number(value));

export const arrivalOf = (d: StaffDraft): ArrivalSettings => ({
  lateWindowMinutes: num(d.lateWindow),
  permissionWindowMinutes: num(d.permissionWindow),
  extraMinutes: num(d.extraMinutes),
  quarterDeduction: num(d.quarterDeduction),
});

export type StaffErrors = Partial<Record<keyof StaffDraft, string>> & {
  /** The arrival timeline's own message (the first of its four numbers that is wrong). */
  arrival?: string;
};

const wholeMinutes = (value: string, label: string): string | undefined => {
  const n = num(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_WINDOW_MINUTES
    ? undefined
    : `${label} must be a whole number of minutes from 0 to ${MAX_WINDOW_MINUTES}.`;
};

/** Hours are stored with one decimal (9.5), so 9.25 would be silently rounded: it is refused instead. */
const hours = (value: string, label: string): string | undefined => {
  const n = num(value);
  return Number.isFinite(n) && n >= 0 && n <= 24 && Math.abs(n * 10 - Math.round(n * 10)) < 1e-9
    ? undefined
    : `${label} must be from 0 to 24 hours, with at most one decimal (for example 9 or 9.5).`;
};

/** The checks the server makes on save (and a few it does not, where a value would be stored wrongly). */
export function validateStaff(d: StaffDraft, access: StaffAccess): StaffErrors {
  const errors: StaffErrors = {};
  if (access.companyWideEditable && access.halfDayReported && minutesOf(d.secondHalfStart) === null) {
    errors.secondHalfStart = "Enter Second Half Start as a valid clock time.";
  }
  if (access.companyWideEditable && access.arrivalReported) {
    const arrival = arrivalOf(d);
    const message = validateArrival(arrival);
    if (message) {
      errors.arrival = message;
      const single = (key: keyof ArrivalSettings) => validateArrival({ ...DEFAULT_ARRIVAL, [key]: arrival[key] });
      if (single("lateWindowMinutes")) errors.lateWindow = message;
      if (single("permissionWindowMinutes")) errors.permissionWindow = message;
      if (single("extraMinutes")) errors.extraMinutes = message;
      if (single("quarterDeduction")) errors.quarterDeduction = message;
    }
  }
  const night = wholeMinutes(d.nightLateWindow, "Night Late window");
  if (night) errors.nightLateWindow = night;
  const zone = wholeMinutes(d.lunchPermissionZone, "Afternoon permission zone width");
  if (zone) errors.lunchPermissionZone = zone;
  const grace = hours(d.forgottenExitHours, "Forgotten last-out grace");
  if (grace) errors.forgottenExitHours = grace;
  const buffer = hours(d.earlyArrivalProtectionHours, "Next-day early-arrival protection");
  if (buffer) errors.earlyArrivalProtectionHours = buffer;
  return errors;
}

/** The first problem to show beside the Save button, or null. */
export const firstError = (errors: StaffErrors): string | null =>
  errors.secondHalfStart ??
  errors.arrival ??
  errors.nightLateWindow ??
  errors.lunchPermissionZone ??
  errors.forgottenExitHours ??
  errors.earlyArrivalProtectionHours ??
  null;

type FieldInfo = {
  label: string;
  /** How a value is shown in the "what changes" list of the confirm dialog. */
  show: (v: string | boolean | null) => string;
  number: boolean;
  /** True when the field changes what someone is paid (not only what is shown). */
  money: boolean;
};

const plain = (unit: string) => (v: string | boolean | null) => `${v} ${unit}`;
const onOff = (v: string | boolean | null) => (v === null ? "not reported" : v ? "On" : "Off");

export const STAFF_FIELDS: Record<keyof StaffDraft, FieldInfo> = {
  attendanceMode: {
    label: "Attendance calculation mode",
    show: (v) => (v === "simple" ? "Simple" : "Strict"),
    number: false,
    money: false,
  },
  morningLateInEnabled: { label: "Morning Late-In marks", show: onOff, number: false, money: true },
  eveningEarlyOutEnabled: { label: "Evening Early-Out marks", show: onOff, number: false, money: true },
  secondHalfStart: { label: "Second Half Start Time", show: (v) => String(v), number: false, money: true },
  lateWindow: { label: "Late window", show: plain("minutes"), number: true, money: true },
  permissionWindow: { label: "Permission window", show: plain("minutes"), number: true, money: true },
  extraMinutes: { label: "Extra minutes", show: plain("minutes"), number: true, money: true },
  quarterDeduction: { label: "Quarter-shift deduction", show: plain("shift"), number: true, money: true },
  nightLateWindow: { label: "Night Late window", show: plain("minutes"), number: true, money: false },
  lunchPermissionZone: { label: "Afternoon permission zone width", show: plain("minutes"), number: true, money: false },
  forgottenExitHours: { label: "Forgotten last-out grace", show: plain("hours"), number: true, money: true },
  earlyArrivalProtectionHours: {
    label: "Next-day early-arrival protection",
    show: plain("hours"),
    number: true,
    money: true,
  },
};

const KEYS = Object.keys(STAFF_FIELDS) as (keyof StaffDraft)[];

const same = (key: keyof StaffDraft, a: StaffDraft, b: StaffDraft): boolean => {
  if (!STAFF_FIELDS[key].number) return a[key] === b[key];
  const x = num(a[key] as string);
  const y = num(b[key] as string);
  return Number.isNaN(x) || Number.isNaN(y) ? a[key] === b[key] : x === y;
};

export const sameStaff = (a: StaffDraft, b: StaffDraft): boolean => KEYS.every((k) => same(k, a, b));

export type Change = { key: string; label: string; from: string; to: string; money: boolean };

/** Every field whose value differs from what is saved, in the order the tab shows them. */
export function staffChanges(draft: StaffDraft, saved: StaffDraft): Change[] {
  return KEYS.filter((k) => !same(k, draft, saved)).map((k) => ({
    key: k,
    label: STAFF_FIELDS[k].label,
    from: STAFF_FIELDS[k].show(saved[k]),
    to: STAFF_FIELDS[k].show(draft[k]),
    money: STAFF_FIELDS[k].money,
  }));
}

/**
 * The body of the Save Attendance Settings PUT: the same keys the tab has always sent. Company-wide rules only when this
 * login may change them and the server reported them; a switch only when it was changed (a guessed default is never
 * written); the settings nothing reads any more exactly as they were loaded.
 */
export function staffPayload(
  draft: StaffDraft,
  saved: StaffDraft,
  carried: CarriedKeys,
  access: StaffAccess,
): Partial<PayrollSettingsItem> {
  const arrival = arrivalOf(draft);
  const companyWide: Partial<PayrollSettingsItem> = {};
  if (access.companyWideEditable) {
    if (
      access.morningReported &&
      draft.morningLateInEnabled !== null &&
      draft.morningLateInEnabled !== saved.morningLateInEnabled
    ) {
      companyWide.morningLateInEnabled = draft.morningLateInEnabled;
    }
    if (
      access.eveningReported &&
      draft.eveningEarlyOutEnabled !== null &&
      draft.eveningEarlyOutEnabled !== saved.eveningEarlyOutEnabled
    ) {
      companyWide.eveningEarlyOutEnabled = draft.eveningEarlyOutEnabled;
    }
    if (access.halfDayReported) companyWide.halfDaySecondHalfStartTime = draft.secondHalfStart;
    if (access.arrivalReported) {
      companyWide.arrivalLateWindowMinutes = arrival.lateWindowMinutes;
      companyWide.arrivalPermissionWindowMinutes = arrival.permissionWindowMinutes;
      companyWide.arrivalExtraMinutes = arrival.extraMinutes;
      companyWide.arrivalQuarterDeduction = arrival.quarterDeduction;
    }
  }
  return {
    attendanceMode: draft.attendanceMode,
    simpleHalfShiftCutoff: carried.simpleHalfShiftCutoff,
    ...companyWide,
    afternoonLateWindowMinutes: num(draft.nightLateWindow),
    afternoonPermissionWindowMinutes: num(draft.lunchPermissionZone),
    lastPunchPostShiftGraceHours: num(draft.forgottenExitHours),
    firstPunchPreShiftBufferHours: num(draft.earlyArrivalProtectionHours),
    prodFirstHalfStart: carried.prodFirstHalfStart,
    prodFirstHalfEnd: carried.prodFirstHalfEnd,
    prodSecondHalfStart: carried.prodSecondHalfStart,
    prodSecondHalfEnd: carried.prodSecondHalfEnd,
    prodExtraStart: carried.prodExtraStart,
    prodExtraEnd: carried.prodExtraEnd,
    defaultShiftGraceMinutes: carried.defaultShiftGraceMinutes,
    defaultShiftFirstHalfEnd: carried.defaultShiftFirstHalfEnd,
    defaultShiftLunchDurationMinutes: carried.defaultShiftLunchDurationMinutes,
    defaultShiftLunchGraceMinutes: carried.defaultShiftLunchGraceMinutes,
  };
}
