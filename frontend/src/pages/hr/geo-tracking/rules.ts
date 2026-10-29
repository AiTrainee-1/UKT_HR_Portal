// Tracking Settings -> "Geo-tracking rules": the form model. The server keeps times in seconds; HR thinks in minutes for the
// long ones (a stop, a gap, a lost signal) and in seconds for the phone's sampling, so each field says which it shows and how
// it converts. Every field has a range the page checks before saving (the server checks again and its sentence is shown).
// A save sends only what changed.
import {
  hhmm,
  type GeoReverseProvider,
  type GeoTrackingSettings,
  type GeoTrackingSettingsPatch,
} from "@/lib/api-client/custom-hooks";

/** What the server accepts for the notice. */
export const NOTICE_MAX_CHARS = 5000;

export type NumberKey =
  | "stopMinutes"
  | "stopRadiusM"
  | "gapMinutes"
  | "signalLostMinutes"
  | "maxAccuracyM"
  | "maxSpeedKmh"
  | "sampleMovingSeconds"
  | "sampleStillSeconds"
  | "uploadBatchPoints"
  | "uploadIntervalSeconds"
  | "retentionDays"
  | "stopAccuracyFactor"
  | "mergeStopGapSeconds"
  | "distanceFilterM";

/** What the form holds: text for every number (so a half-typed value stays as typed) and the choices. */
export type RulesForm = Record<NumberKey, string> & {
  enabled: boolean;
  dayEndTime: string;
  ondutyPunchPhotos: "1" | "2";
  noticeText: string;
  /** Raise the notice version: every employee accepts the notice again before the next track records. */
  reaccept: boolean;
  reverseGeocodeProvider: GeoReverseProvider;
};

export type NumberSpec = {
  key: NumberKey;
  /** The server field this is. */
  field: keyof GeoTrackingSettings;
  label: string;
  unit: string;
  min: number;
  max: number;
  integer: boolean;
  /** Seconds in the server, minutes on the screen: 60; otherwise 1. */
  factor: number;
  hint: string;
};

export const NUMBER_SPECS: NumberSpec[] = [
  {
    key: "stopMinutes",
    field: "stopSeconds",
    label: "Stationary after",
    unit: "minutes",
    min: 1,
    max: 60,
    integer: false,
    factor: 60,
    hint: "Staying within the radius for this long is recorded as a stationary period (waiting, a break). Default 3.",
  },
  {
    key: "stopRadiusM",
    field: "stopRadiusM",
    label: "Stop radius",
    unit: "metres",
    min: 10,
    max: 500,
    integer: true,
    factor: 1,
    hint: "How far the phone may drift and still count as the same place. Default 50.",
  },
  {
    key: "gapMinutes",
    field: "gapSeconds",
    label: "Gap after",
    unit: "minutes",
    min: 1,
    max: 60,
    integer: false,
    factor: 60,
    hint: "No location for longer than this is shown as a gap, with its cause. Default 5.",
  },
  {
    key: "signalLostMinutes",
    field: "signalLostSeconds",
    label: "Signal lost after",
    unit: "minutes",
    min: 2,
    max: 120,
    integer: false,
    factor: 60,
    hint: "A track that has sent nothing for this long is shown as Offline and a signal-lost event is recorded. Default 10.",
  },
  {
    key: "maxAccuracyM",
    field: "maxAccuracyM",
    label: "Ignore positions worse than",
    unit: "metres",
    min: 10,
    max: 1000,
    integer: true,
    factor: 1,
    hint: "A position whose accuracy circle is wider than this is set aside. Default 100.",
  },
  {
    key: "maxSpeedKmh",
    field: "maxSpeedKmh",
    label: "Ignore jumps faster than",
    unit: "km/h",
    min: 30,
    max: 500,
    integer: true,
    factor: 1,
    hint: "A position that implies a speed above this is a GPS jump and is set aside. Default 200.",
  },
  {
    key: "sampleMovingSeconds",
    field: "sampleMovingSeconds",
    label: "Phone: position every (moving)",
    unit: "seconds",
    min: 2,
    max: 120,
    integer: true,
    factor: 1,
    hint: "How often the phone records a position while the employee is moving. Shorter = a route that follows the road corners, but more battery. Default 3.",
  },
  {
    key: "sampleStillSeconds",
    field: "sampleStillSeconds",
    label: "Phone: position every (still)",
    unit: "seconds",
    min: 30,
    max: 1800,
    integer: true,
    factor: 1,
    hint: "How often it records while the employee stays in one place. A minute keeps every stop of 3 minutes or more visible and notices a departure quickly; longer saves battery but can miss short stops. Default 60.",
  },
  {
    key: "uploadBatchPoints",
    field: "uploadBatchPoints",
    label: "Phone: send after",
    unit: "positions",
    min: 5,
    max: 500,
    integer: true,
    factor: 1,
    hint: "The phone sends its saved positions when this many are waiting. Default 30.",
  },
  {
    key: "uploadIntervalSeconds",
    field: "uploadIntervalSeconds",
    label: "Phone: send at least every",
    unit: "seconds",
    min: 10,
    max: 900,
    integer: true,
    factor: 1,
    hint: "...or when this much time has passed. Default 60.",
  },
  {
    key: "retentionDays",
    field: "retentionDays",
    label: "Keep raw positions for",
    unit: "days",
    min: 7,
    max: 3650,
    integer: true,
    factor: 1,
    hint: "Older raw positions and events are deleted. Stops, gaps and the totals of a journey are kept. Default 365.",
  },
  {
    key: "stopAccuracyFactor",
    field: "stopAccuracyFactor",
    label: "Stop radius for poor GPS",
    unit: "x accuracy",
    min: 0.5,
    max: 5,
    integer: false,
    factor: 1,
    hint: "A stop's radius also grows to this many times the typical accuracy. Default 2.",
  },
  {
    key: "mergeStopGapSeconds",
    field: "mergeStopGapSeconds",
    label: "Join stops closer in time than",
    unit: "seconds",
    min: 0,
    max: 1800,
    integer: true,
    factor: 1,
    hint: "Two stops at the same place with less time between them become one. Default 120.",
  },
  {
    key: "distanceFilterM",
    field: "distanceFilterM",
    label: "Phone: ignore moves under",
    unit: "metres",
    min: 0,
    max: 200,
    integer: true,
    factor: 1,
    hint: "The phone records a new position only after moving this far. Default 10.",
  },
];

export const SPEC: Record<NumberKey, NumberSpec> = Object.fromEntries(NUMBER_SPECS.map((s) => [s.key, s])) as Record<
  NumberKey,
  NumberSpec
>;

const shown = (n: number): string => String(Math.round(n * 1000) / 1000);

export function toForm(s: GeoTrackingSettings): RulesForm {
  const numbers = Object.fromEntries(
    NUMBER_SPECS.map((spec) => [spec.key, shown((s[spec.field] as number) / spec.factor)]),
  ) as Record<NumberKey, string>;
  return {
    ...numbers,
    enabled: s.enabled,
    dayEndTime: s.dayEndTime,
    ondutyPunchPhotos: s.ondutyPunchPhotos === 2 ? "2" : "1",
    noticeText: s.noticeText,
    reaccept: false,
    reverseGeocodeProvider: s.reverseGeocodeProvider,
  };
}

export const sameForm = (a: RulesForm, b: RulesForm): boolean => JSON.stringify(a) === JSON.stringify(b);

export type RuleErrors = Partial<Record<keyof RulesForm, string>>;

const rangeWords = (spec: NumberSpec) => `${spec.min} and ${spec.max} ${spec.unit}`;

/** Messages in words, by field. Empty when the form can be saved. `saved` tells whether the notice was touched. */
export function validate(form: RulesForm, saved: GeoTrackingSettings): RuleErrors {
  const errors: RuleErrors = {};
  for (const spec of NUMBER_SPECS) {
    const text = form[spec.key].trim();
    const n = Number(text);
    if (text === "" || !Number.isFinite(n))
      errors[spec.key] = `${spec.label}: enter a number between ${rangeWords(spec)}.`;
    else if (n < spec.min || n > spec.max) errors[spec.key] = `${spec.label}: must be between ${rangeWords(spec)}.`;
    else if (spec.integer && !Number.isInteger(n)) errors[spec.key] = `${spec.label}: use a whole number.`;
    else if (spec.factor !== 1 && Math.abs(n * spec.factor - Math.round(n * spec.factor)) > 1e-6) {
      errors[spec.key] = `${spec.label}: use a whole number of seconds (2.5 minutes is fine).`;
    }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.dayEndTime)) {
    errors.dayEndTime = "Day end: choose a time of day (for example 23:50).";
  } else if (form.dayEndTime < "12:00") {
    errors.dayEndTime = "Day end: choose a time between 12:00 and 23:59 (it closes the day's duties).";
  }
  // a blank notice would leave the consent screen empty: refused when it was changed to blank
  if (form.noticeText.trim() === "" && form.noticeText !== saved.noticeText) {
    errors.noticeText = "Write the notice employees accept before tracking starts.";
  } else if (form.noticeText.length > NOTICE_MAX_CHARS) {
    errors.noticeText = `The notice can be at most ${NOTICE_MAX_CHARS} characters (it is ${form.noticeText.length}).`;
  }
  return errors;
}

/** The server's number for a field of the form. */
const serverNumber = (spec: NumberSpec, text: string): number => Math.round(Number(text) * spec.factor * 1000) / 1000;

/** Only what differs from the saved rules (a partial save). */
export function toPatch(form: RulesForm, saved: GeoTrackingSettings): GeoTrackingSettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const spec of NUMBER_SPECS) {
    const next = serverNumber(spec, form[spec.key]);
    if (next !== (saved[spec.field] as number)) patch[spec.field] = next;
  }
  if (form.enabled !== saved.enabled) patch.enabled = form.enabled;
  if (hhmm(form.dayEndTime) !== saved.dayEndTime) patch.dayEndTime = hhmm(form.dayEndTime);
  const photos = form.ondutyPunchPhotos === "2" ? 2 : 1;
  if (photos !== saved.ondutyPunchPhotos) patch.ondutyPunchPhotos = photos;
  if (form.noticeText !== saved.noticeText) patch.noticeText = form.noticeText;
  // a changed text also raises the version (the server does it too; sending it makes the answer certain)
  if (form.reaccept || noticeChanged(form, saved)) patch.noticeVersion = saved.noticeVersion + 1;
  if (form.reverseGeocodeProvider !== saved.reverseGeocodeProvider)
    patch.reverseGeocodeProvider = form.reverseGeocodeProvider;
  return patch as GeoTrackingSettingsPatch;
}

/** The notice text was changed: everybody has to accept the new wording. */
export const noticeChanged = (form: RulesForm, saved: GeoTrackingSettings): boolean =>
  form.noticeText !== saved.noticeText;

/** Switching to two photos locks out an employee whose app takes one: that save is confirmed first. */
export const needsPhotoConfirm = (form: RulesForm, saved: GeoTrackingSettings): boolean =>
  form.ondutyPunchPhotos === "2" && saved.ondutyPunchPhotos !== 2;
