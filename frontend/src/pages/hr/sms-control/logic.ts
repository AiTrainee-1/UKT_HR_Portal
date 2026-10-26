import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  SmsChannel,
  SmsMessageStatus,
  SmsOverview,
  SmsPurpose,
  SmsSettings,
  SmsSettingsInput,
} from "@/lib/api-client/custom-hooks";
import { smsPath, type SettingsSectionKey } from "./routes";

// The rules of the SMS Control page that need no screen: what each setting is (its range, its words), how a draft is checked
// and turned into a save, the "what to do next" list, and the small formatters. Pure, so the render tests, the unit tests and
// the page all read from one place.

// ── the settings ──────────────────────────────────────────────────────────────

export type NumericKey =
  | "otpExpiryMinutes"
  | "resendCooldownSeconds"
  | "maxRequestsPerHour"
  | "maxAttemptsPerCode"
  | "maxPerPhonePerHour"
  | "hourlyCap"
  | "dailyCap";

export type SwitchKey = "otpLoginEnabled" | "otpResetEnabled" | "otpActivateEnabled";

export type Affect = { where: string; what: string; to?: string };

export type LimitRule = {
  key: NumericKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  default: number;
  /** What the setting is for, in one or two plain sentences. */
  purpose: string;
  /** What changes in the application when it is changed. */
  affects: Affect[];
  /** A worked example from the number being typed. */
  example: (n: number) => string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The seven limits, in the order they are shown. The ranges are the server's: a save outside them is refused. */
export const LIMIT_RULES: readonly LimitRule[] = [
  {
    key: "otpExpiryMinutes",
    label: "How long a code works",
    unit: "minutes",
    min: 1,
    max: 15,
    default: 5,
    purpose:
      "After this time a code stops working, even if it was never used. A short time is safer; a long time is kinder when the SMS arrives late.",
    affects: [
      { where: "The SMS text", what: "tells the employee the code expires in this many minutes" },
      { where: "Login, reset and activation", what: "an older code is refused as 'incorrect or expired'" },
    ],
    example: (n) => `A code asked for at 10:00 works until ${clockAfter(10 * 60, n)}.`,
  },
  {
    key: "resendCooldownSeconds",
    label: "Wait before asking again",
    unit: "seconds",
    min: 30,
    max: 600,
    default: 60,
    purpose:
      "After a code is sent, the same employee has to wait this long before the next one. It stops people tapping the button again and again and running up the SMS bill.",
    affects: [
      { where: "Login screens", what: "show a countdown and keep the resend button off until it ends" },
      { where: "SMS cost", what: "a longer wait means fewer repeat messages" },
    ],
    example: (n) => `Asked at 10:00, the next code can be asked for at ${clockAfter(10 * 60, 0, n)}.`,
  },
  {
    key: "maxRequestsPerHour",
    label: "Codes per employee, per hour",
    unit: "codes",
    min: 1,
    max: 20,
    default: 5,
    purpose:
      "The most codes one employee can ask for in an hour, whatever the purpose. After that they are told to try later or use their password.",
    affects: [
      { where: "Login screens", what: "an employee over the limit sees 'too many requests' until the hour passes" },
      { where: "Messages", what: "the extra requests are not sent, so they cost nothing" },
    ],
    example: (n) => `An employee can ask for ${plural(n, "code", "codes")} between 10:00 and 11:00.`,
  },
  {
    key: "maxAttemptsPerCode",
    label: "Wrong tries per code",
    unit: "tries",
    min: 3,
    max: 5,
    default: 5,
    purpose:
      "How many wrong codes may be typed before that code is thrown away and the employee has to ask for a new one. It stops guessing. SMS codes have only 4 digits, so this is held to 5 at most.",
    affects: [
      { where: "Login screens", what: "after this many wrong tries the code is dead, even if it has not expired" },
    ],
    example: (n) => `After ${plural(n, "wrong try", "wrong tries")}, the code is cancelled.`,
  },
  {
    key: "maxPerPhonePerHour",
    label: "Codes per phone number, per hour",
    unit: "codes",
    min: 1,
    max: 20,
    default: 5,
    purpose:
      "The most codes sent to one phone number in an hour, counting every employee record that uses that number. Two records sharing a number cannot double the limit.",
    affects: [
      { where: "Login screens", what: "a number over the limit is refused until the hour passes" },
      { where: "Messages", what: "the refused requests are logged as Blocked" },
    ],
    example: (n) => `One number gets at most ${plural(n, "code", "codes")} between 10:00 and 11:00.`,
  },
  {
    key: "hourlyCap",
    label: "SMS cap for the whole company, per hour",
    unit: "SMS",
    min: 1,
    max: 10000,
    default: 300,
    purpose:
      "The most SMS the system sends in one hour, for everyone together. It protects you from a surprise bill if someone abuses the login screen.",
    affects: [
      {
        where: "All login screens",
        what: "when the cap is reached, new codes are refused for a while and logged as Blocked",
      },
      { where: "Overview", what: "the usage bar fills towards this number" },
    ],
    example: (n) => `At most ${n.toLocaleString("en-IN")} SMS go out between 10:00 and 11:00.`,
  },
  {
    key: "dailyCap",
    label: "SMS cap for the whole company, per day",
    unit: "SMS",
    min: 1,
    max: 10000,
    default: 1500,
    purpose: "The same protection over a whole day. The day starts at midnight, Indian time.",
    affects: [
      { where: "All login screens", what: "when the cap is reached, new codes are refused until tomorrow" },
      { where: "Overview", what: "the usage bar fills towards this number" },
    ],
    example: (n) => `At most ${n.toLocaleString("en-IN")} SMS go out in one day.`,
  },
];

export const NUMERIC_KEYS: readonly NumericKey[] = LIMIT_RULES.map((r) => r.key);
export const SWITCH_KEYS: readonly SwitchKey[] = ["otpLoginEnabled", "otpResetEnabled", "otpActivateEnabled"];

export type SwitchRule = {
  key: SwitchKey;
  title: string;
  purpose: string;
  on: string;
  off: string;
  affects: Affect[];
};

export const SWITCH_RULES: readonly SwitchRule[] = [
  {
    key: "otpLoginEnabled",
    title: "Sign in with a code",
    purpose: "Lets an employee sign in with a code sent by SMS instead of typing a password.",
    on: "Employees can sign in with an SMS code",
    off: "Employees cannot sign in with an SMS code",
    affects: [
      { where: "Employee web app and mobile app", what: "the 'Sign in with a code' option shows or hides" },
      { where: "Password sign-in", what: "always stays available" },
    ],
  },
  {
    key: "otpResetEnabled",
    title: "Forgot password by code",
    purpose: "Lets an employee who forgot the password choose a new one after confirming an SMS code.",
    on: "Employees can reset a password with an SMS code",
    off: "Employees cannot reset a password with an SMS code",
    affects: [
      { where: "Forgot password screen", what: "the reset-by-code option shows or hides" },
      { where: "Employees who forgot the password", what: "have to ask HR for help while it is off" },
    ],
  },
  {
    key: "otpActivateEnabled",
    title: "First-time activation by code",
    purpose:
      "A new employee has no password yet. This makes them confirm an SMS code to the number HR has on file before they can choose one.",
    on: "New employees activate their account with an SMS code",
    off: "New employees cannot activate with an SMS code",
    affects: [
      { where: "Activate account screen", what: "the code step shows or hides" },
      { where: "New employees", what: "HR has to set their first password while it is off" },
    ],
  },
];

/** The settings with the numbers as typed (a box can be empty or half typed, so it holds text). */
export type SettingsDraft = Record<SwitchKey, boolean> & Record<NumericKey, string> & { otpChannel: SmsChannel };

export const SECTION_FIELDS: Record<SettingsSectionKey, readonly (keyof SettingsDraft)[]> = {
  channel: ["otpChannel"],
  limits: NUMERIC_KEYS,
  switches: SWITCH_KEYS,
};

export function draftFrom(saved: SmsSettings): SettingsDraft {
  const draft = { otpChannel: saved.otpChannel } as SettingsDraft;
  for (const key of SWITCH_KEYS) draft[key] = saved[key] === true;
  for (const key of NUMERIC_KEYS) draft[key] = String(saved[key]);
  return draft;
}

/** True when the fields of one section differ between two drafts. */
export function sectionDirty(section: SettingsSectionKey, a: SettingsDraft, b: SettingsDraft): boolean {
  return SECTION_FIELDS[section].some((key) => a[key] !== b[key]);
}

/** `draft` with the fields of one section taken from `from`. */
export function withSection(section: SettingsSectionKey, draft: SettingsDraft, from: SettingsDraft): SettingsDraft {
  const next = { ...draft } as Record<string, unknown>;
  for (const key of SECTION_FIELDS[section]) next[key] = from[key];
  return next as SettingsDraft;
}

/** A whole number from what was typed, or null when it is not one ("", "5.5", "abc", "-3"). */
export function parseWhole(text: string): number | null {
  const t = text.trim();
  return /^\d{1,9}$/.test(t) ? Number(t) : null;
}

export type Validation = { errors: Partial<Record<NumericKey, string>>; first: string | null };

export function validateLimits(draft: SettingsDraft): Validation {
  const errors: Partial<Record<NumericKey, string>> = {};
  for (const rule of LIMIT_RULES) {
    const n = parseWhole(draft[rule.key]);
    if (n === null || n < rule.min || n > rule.max) {
      errors[rule.key] =
        `Enter a whole number from ${rule.min.toLocaleString("en-IN")} to ${rule.max.toLocaleString("en-IN")}.`;
    }
  }
  // the server refuses an hourly cap above the daily cap: say so before sending
  const hourly = parseWhole(draft.hourlyCap);
  const daily = parseWhole(draft.dailyCap);
  if (!errors.hourlyCap && !errors.dailyCap && hourly !== null && daily !== null && hourly > daily) {
    errors.dailyCap = `The daily cap cannot be lower than the hourly cap (${formatNumber(hourly)}).`;
  }
  const first = LIMIT_RULES.find((r) => errors[r.key]);
  return { errors, first: first ? `${first.label}: ${errors[first.key]}` : null };
}

/** Advice that never blocks a save: something that is allowed but probably not meant. */
export function limitsAdvice(draft: SettingsDraft): string[] {
  const advice: string[] = [];
  const cooldown = parseWhole(draft.resendCooldownSeconds);
  const perHour = parseWhole(draft.maxRequestsPerHour);
  if (cooldown !== null && perHour !== null && cooldown * perHour > 3600) {
    advice.push(
      "With this wait between codes, an employee can never use all the codes allowed per hour: the wait is the stricter limit.",
    );
  }
  return advice;
}

export function switchesAdvice(draft: SettingsDraft): string[] {
  return SWITCH_KEYS.every((k) => !draft[k])
    ? ["All three are off, so nobody can get a code by SMS. Password sign-in still works."]
    : [];
}

/**
 * The body of a save. Every save sends the whole document (the server checks it all-or-nothing): the SAVED values, with the
 * fields of the section being saved taken from the draft, plus the `version` the page loaded.
 */
export function buildInput(
  saved: SmsSettings,
  draft: SettingsDraft,
  section: SettingsSectionKey,
  expectedVersion: string | undefined,
): SmsSettingsInput {
  const input: SmsSettingsInput = {
    otpChannel: saved.otpChannel,
    otpLoginEnabled: saved.otpLoginEnabled,
    otpResetEnabled: saved.otpResetEnabled,
    otpActivateEnabled: saved.otpActivateEnabled,
    otpExpiryMinutes: saved.otpExpiryMinutes,
    resendCooldownSeconds: saved.resendCooldownSeconds,
    maxRequestsPerHour: saved.maxRequestsPerHour,
    maxAttemptsPerCode: saved.maxAttemptsPerCode,
    maxPerPhonePerHour: saved.maxPerPhonePerHour,
    hourlyCap: saved.hourlyCap,
    dailyCap: saved.dailyCap,
  };
  if (section === "channel") input.otpChannel = draft.otpChannel;
  if (section === "switches") for (const key of SWITCH_KEYS) input[key] = draft[key];
  if (section === "limits") for (const key of NUMERIC_KEYS) input[key] = parseWhole(draft[key]) ?? saved[key];
  if (expectedVersion !== undefined) input.expectedVersion = expectedVersion;
  return input;
}

/** The server's one-sentence explanation of a refusal, when it sent one. */
export function serverSentence(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data as { error?: unknown; message?: unknown; detail?: unknown } | null;
  for (const v of [data?.message, data?.error, data?.detail]) {
    if (typeof v === "string" && v.trim() && v !== "permission_denied") return v.trim();
  }
  return null;
}

export const STALE_TEXT =
  "Someone else saved these settings while you were editing. Reload to see their changes; your edits are kept until you reload.";

/** What went wrong with a save or a test, in words an HR manager can act on. */
export function failureText(err: unknown, what: string): string {
  const sentence = serverSentence(err);
  if (sentence) return sentence;
  if (err instanceof ApiError && err.status === 403) return `Your login is not allowed to ${what}.`;
  if (err instanceof ApiError && err.status === 429) return "Too many tries. Wait a little and try again.";
  return `Could not ${what}. Check the connection and try again.`;
}

// ── time and numbers ──────────────────────────────────────────────────────────

const IST = "Asia/Kolkata";

function clockAfter(startMinutes: number, addMinutes: number, addSeconds = 0): string {
  const total = startMinutes * 60 + addMinutes * 60 + addSeconds;
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return s ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}`;
}

/** "14 Oct 2026, 3:41 pm" in the factory's own time. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: IST,
  });
}

/** "3:41 pm" in the factory's own time. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: IST });
}

/** "Mon 12" for a YYYY-MM-DD day (a calendar day has no time zone: it is read as it is written). */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const weekday = d.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${d.getUTCDate()}`;
}

export const formatNumber = (n: number): string => n.toLocaleString("en-IN");

// ── labels ────────────────────────────────────────────────────────────────────

export const CHANNEL_LABEL: Record<SmsChannel, string> = { whatsapp: "WhatsApp", sms: "SMS" };

/** The one SMS provider, as people say it. */
export const PROVIDER_NAME = "2Factor";

export const PURPOSE_LABEL: Record<SmsPurpose, string> = {
  login: "Login code",
  reset: "Password reset",
  activate: "Account activation",
  test: "Test message",
};

export const PURPOSES: readonly SmsPurpose[] = ["login", "reset", "activate", "test"];

export const STATUS_LABEL: Record<SmsMessageStatus, string> = { sent: "Sent", failed: "Failed", blocked: "Blocked" };

/** What a status means. */
export const STATUS_HELP: Record<SmsMessageStatus, string> = {
  sent: `${PROVIDER_NAME} accepted the message`,
  failed: `it could not be handed to ${PROVIDER_NAME}`,
  blocked: "a limit, a switch or the pause stopped it before it was sent",
};

export const purposeLabel = (p: string): string => PURPOSE_LABEL[p as SmsPurpose] ?? p;

// ── 2Factor's values ──────────────────────────────────────────────────────────

/** The OTP template made in the 2Factor panel (SMS OTP > OTP Templates). It must hold XXXX once (the code goes there) and be
 *  under 150 characters. */
export const TWOFACTOR_TEMPLATE_TEXT =
  "XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.";
export const TWOFACTOR_TEMPLATE_NAME = "UKT_HRMS_OTP";
export const TWOFACTOR_SENDER_ID = "UKTHRM";

export type EnvVar = {
  name: string;
  /** Which of the overview's `env` flags says whether it is set (the optional ones have none). */
  flag?: "authKey" | "senderId" | "templateName";
  required: boolean;
  what: string;
  example: string;
};

/** The environment values on the server (backend/.env), the required ones first. The API key is only ever set there: this page
 *  never asks for it. */
export const ENV_VARS: readonly EnvVar[] = [
  {
    name: "TWOFACTOR_API_KEY",
    flag: "authKey",
    required: true,
    what: "Your 2Factor API key: the password that lets the server send SMS from your 2Factor account. Copy it from the 2Factor panel. Keep it secret.",
    example: "your_2factor_api_key_here",
  },
  {
    name: "TWOFACTOR_TEMPLATE_NAME",
    flag: "templateName",
    required: true,
    what: "The NAME of the OTP template you made in the 2Factor panel (not a number). One template serves login, reset and activation codes.",
    example: TWOFACTOR_TEMPLATE_NAME,
  },
  {
    name: "TWOFACTOR_SENDER_ID",
    flag: "senderId",
    required: true,
    what: "The six-letter sender name employees see on the SMS. It must be the one approved for the template.",
    example: TWOFACTOR_SENDER_ID,
  },
  {
    name: "TWOFACTOR_API_BASE",
    required: false,
    what: "The address of the 2Factor API. Leave it as it is unless 2Factor tells you otherwise.",
    example: "https://2factor.in/API/V1",
  },
  {
    name: "SMS_ALLOW_SENDING",
    required: false,
    what: "Leave it empty and the server decides by itself: a real server sends, a development machine never does. Set it to true to force sending on a machine that would not.",
    example: "",
  },
];

/** The message the Test tab previews: the template with a made-up code where XXXX is. */
export const templatePreview = (code: string): string => TWOFACTOR_TEMPLATE_TEXT.replace("XXXX", code);

export const DOCS_FILE = "twofactor-sms-otp-integration.md";

/** Whether the server reports an environment value as set (the key as a flag, the sender ID and template name as text). */
export const isEnvSet = (env: SmsOverview["env"], flag: "authKey" | "senderId" | "templateName"): boolean =>
  flag === "authKey" ? env.authKey : env[flag] !== "";

/** The names of the required environment values that are not set, as the server reports them. */
export function missingEnv(overview: SmsOverview): string[] {
  return ENV_VARS.filter((v) => v.flag && !isEnvSet(overview.env, v.flag)).map((v) => v.name);
}

// ── usage, the chart ──────────────────────────────────────────────────────────

export type UsageLevel = "ok" | "near" | "full" | "none";

/** How much of a cap is used: the percentage (0 to 100) and whether it is comfortable, close (80%) or reached. */
export function usage(used: number, cap: number): { pct: number; level: UsageLevel } {
  if (!(cap > 0)) return { pct: 0, level: "none" };
  const pct = Math.min(100, Math.round((used / cap) * 100));
  return { pct, level: used >= cap ? "full" : used / cap >= 0.8 ? "near" : "ok" };
}

export type Bar = {
  date: string;
  label: string;
  sent: number;
  failed: number;
  total: number;
  sentPct: number;
  failedPct: number;
};

/** One bar per day: the sent part and the failed part, each as a share of the busiest day. */
export function chartBars(days: SmsOverview["last7Days"]): { bars: Bar[]; max: number } {
  const max = Math.max(1, ...days.map((d) => d.sent + d.failed));
  const bars = days.map((d) => ({
    date: d.date,
    label: dayLabel(d.date),
    sent: d.sent,
    failed: d.failed,
    total: d.sent + d.failed,
    sentPct: (d.sent / max) * 100,
    failedPct: (d.failed / max) * 100,
  }));
  return { bars, max };
}

// ── what to do next ───────────────────────────────────────────────────────────

/** The balance (as 2Factor reports it) at or under which the checklist says to top up. */
export const LOW_BALANCE = 100;

export type StepTone = "bad" | "warn" | "todo" | "info" | "done";

export type NextStep = {
  id: string;
  tone: StepTone;
  title: string;
  detail: string;
  /** Where the step is done (an address inside the page). */
  to?: string;
  linkLabel?: string;
  /** A standing reminder, not a problem: it never stops "everything is in order" from being said, and comes after it. */
  hint?: boolean;
};

export type BalanceState = {
  /** amount: a number 2Factor reported · low: that number is at or under LOW_BALANCE · empty: 2Factor refused the last message
   *  for lack of balance · unknown: nothing can be said (2Factor offers no balance check this system can use). */
  kind: "amount" | "low" | "empty" | "unknown";
  amount: number | null;
  /** What the server said about the balance (an explanation, or the reason it could not be read). */
  note: string;
};

// The server's note when the last message was refused for lack of balance ("...the account has no balance. Top it up in the
// 2Factor panel."). The everyday note ("2Factor documents no balance check this system can use safely...") must NOT match.
const EMPTY_BALANCE = /\b(has no balance|out of balance|ran out of|insufficient|top it up)\b/i;

export function balanceState(o: SmsOverview): BalanceState {
  const note = o.balance.error ?? "";
  if (o.balance.available !== null) {
    return { kind: o.balance.available <= LOW_BALANCE ? "low" : "amount", amount: o.balance.available, note };
  }
  return { kind: EMPTY_BALANCE.test(note) ? "empty" : "unknown", amount: null, note };
}

const RANK: Record<StepTone, number> = { bad: 0, warn: 1, todo: 2, info: 3, done: 4 };

/**
 * The plain-English checklist of the Overview, worked out from the state of the server: what is missing (by name, never by
 * value), what the channel is and what switching does, why this machine will not send, the balance, the limits and the
 * pause. The most serious come first. When nothing is left, one line says so.
 */
export function nextSteps(o: SmsOverview): NextStep[] {
  const steps: NextStep[] = [];
  const name = PROVIDER_NAME;
  const apiBase = "TWOFACTOR_API_BASE";
  const onSms = o.channel === "sms";
  const missing = missingEnv(o);

  if (!o.configured) {
    if (missing.length > 0) {
      steps.push({
        id: "configure",
        tone: onSms ? "bad" : "todo",
        title: `Add the ${name} details to the server`,
        detail: `Not set yet: ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} to backend/.env on the server and restart the server. The values are never shown on this page.${onSms ? "" : " Until then codes keep going by WhatsApp."}`,
        to: smsPath("setup"),
        linkLabel: "Open the setup steps",
      });
    } else {
      steps.push({
        id: "placeholder",
        tone: onSms ? "bad" : "todo",
        title: `Replace the example ${name} values`,
        detail: `All three values are filled in, but the server does not accept them yet: one may still be the example text (it starts with 'your_' or contains 'here'), or ${apiBase} may be wrong. Put the real values from ${name} in backend/.env and restart the server.`,
        to: smsPath("setup"),
        linkLabel: "Open the setup steps",
      });
    }
    if (onSms) {
      steps.push({
        id: "sms-not-ready",
        tone: "bad",
        title: `SMS is chosen, but ${name} is not set up`,
        detail:
          "Employees cannot get codes by SMS right now. The login screens hide the code options and password sign-in keeps working, so nobody is locked out. Finish the setup, or switch back to WhatsApp.",
        to: smsPath("settings", "channel"),
        linkLabel: "Open Channel",
      });
    }
  }

  if (!o.sendingAllowed) {
    steps.push({
      id: "sending-blocked",
      tone: onSms ? "bad" : "warn",
      title: "This machine will not send SMS",
      detail:
        o.sendingNote ||
        "Sending is switched off on this machine. A development machine never sends. Set SMS_ALLOW_SENDING=true in backend/.env only if you really want it to.",
    });
  }

  if (o.configured && !onSms) {
    steps.push({
      id: "switch",
      tone: "info",
      title: "Codes still go by WhatsApp",
      detail: `${name} is ready. When you want employees to get their login, reset and activation codes by SMS, choose SMS under Settings > Channel. WhatsApp keeps sending every other message either way, and you can switch back at any time.`,
      to: smsPath("settings", "channel"),
      linkLabel: "Open Channel",
    });
  }

  if (o.circuit.paused) {
    steps.push({
      id: "paused",
      tone: "bad",
      title: "SMS sending is paused",
      detail: `${name} failed three times in ten minutes, so sending is paused${o.circuit.until ? ` until ${formatClock(o.circuit.until)}` : " for a few minutes"}. It starts again by itself. Meanwhile employees are told to use their password. Look at the failures to see what ${name} said.`,
      to: smsPath("messages", undefined, "status=failed"),
      linkLabel: "See the failures",
    });
  }

  if (o.configured) {
    const balance = balanceState(o);
    if (balance.kind === "empty") {
      steps.push({
        id: "balance-empty",
        tone: "bad",
        title: `${name} says the account has no balance`,
        detail: `${balance.note} Codes cannot be sent until it is topped up.`,
      });
    } else if (balance.kind === "low" && balance.amount !== null) {
      steps.push({
        id: "balance-low",
        tone: "warn",
        title: `The ${name} balance is low`,
        detail: `${name} reports ${formatNumber(balance.amount)} left. Top it up in the ${name} panel before codes stop arriving.`,
      });
    } else if (balance.kind === "unknown" && (onSms || o.lastSentAt)) {
      // 2Factor offers no balance check this system can use, so this is a standing reminder, not a problem
      steps.push({
        id: "balance-note",
        tone: "info",
        hint: true,
        title: `Keep an eye on the ${name} balance`,
        detail:
          balance.note ||
          `This page cannot read your ${name} balance. Look at it in the ${name} panel now and then, and top it up before it runs out.`,
      });
    }
  }

  const hour = usage(o.limits.hourUsed, o.limits.hourlyCap);
  const day = usage(o.limits.dayUsed, o.limits.dailyCap);
  for (const [id, span, u, used, cap] of [
    ["cap-hour", "hourly", hour, o.limits.hourUsed, o.limits.hourlyCap],
    ["cap-day", "daily", day, o.limits.dayUsed, o.limits.dailyCap],
  ] as const) {
    if (u.level === "full") {
      steps.push({
        id,
        tone: "bad",
        title: `The ${span} SMS cap is reached`,
        detail: `${formatNumber(used)} of ${formatNumber(cap)} used, so new codes are refused for now and logged as Blocked. If this is real use, raise the cap; if not, look for one number asking again and again.`,
        to: smsPath("settings", "limits"),
        linkLabel: "Open Limits",
      });
    } else if (u.level === "near") {
      steps.push({
        id,
        tone: "warn",
        title: `Close to the ${span} SMS cap`,
        detail: `${formatNumber(used)} of ${formatNumber(cap)} used. When it is reached, new codes are refused for a while.`,
        to: smsPath("settings", "limits"),
        linkLabel: "Open Limits",
      });
    }
  }

  if (o.today.blocked > 0 && hour.level !== "full" && day.level !== "full") {
    steps.push({
      id: "blocked",
      tone: "warn",
      title: `${plural(o.today.blocked, "SMS was", "SMS were")} blocked today`,
      detail: `Blocked means a limit, a switch or the pause stopped it before it reached ${name}. The Messages list says which.`,
      to: smsPath("messages", undefined, "status=blocked"),
      linkLabel: "See the blocked messages",
    });
  }

  if (o.today.failed > 0 && !o.circuit.paused) {
    steps.push({
      id: "failed",
      tone: "warn",
      title: `${plural(o.today.failed, "SMS", "SMS")} failed today`,
      detail: `${name} did not accept them. The Messages list shows the reason for each one.`,
      to: smsPath("messages", undefined, "status=failed"),
      linkLabel: "See the failures",
    });
  }

  if (o.configured && o.sendingAllowed && !o.lastSentAt) {
    steps.push({
      id: "try",
      tone: "todo",
      title: "Send a test SMS to your own phone",
      detail: `Nothing has been sent yet. A test shows that ${name} accepts the message and that the text reads well.`,
      to: smsPath("test"),
      linkLabel: "Open Test",
    });
  }

  if (steps.every((step) => step.hint)) {
    steps.push({
      id: "all-good",
      tone: "done",
      title: "Everything is in order",
      detail: `Codes go by SMS and nothing needs attention. ${plural(o.today.sent, "SMS has", "SMS have")} been sent today.`,
    });
  }

  // the most serious first; a standing reminder always comes last
  const rank = (step: NextStep) => (step.hint ? 9 : RANK[step.tone]);
  return steps.sort((a, b) => rank(a) - rank(b));
}

// ── the Test tab ──────────────────────────────────────────────────────────────

export const TEST_CODE = "1234";

export const MOBILE_HELP = "Enter a 10-digit Indian mobile number, for example 9876543210.";

/** The ten digits of a number typed with spaces, dashes, +91, 91 or a leading 0; or why it is not one. */
export function normalizeMobile(input: string): { ok: true; phone: string } | { ok: false; error: string } {
  let digits = input.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (/^\d+$/.test(digits)) {
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  }
  if (!/^[6-9]\d{9}$/.test(digits)) return { ok: false, error: MOBILE_HELP };
  return { ok: true, phone: digits };
}

// ── what a section of Settings is given ───────────────────────────────────────

/** The editor state SettingsTab keeps and hands to the section on screen (it lives above the sections, so switching between
 *  them does not lose what was typed). */
export type SectionProps = {
  draft: SettingsDraft;
  /** What is saved, in the shape of a draft. */
  saved: SettingsDraft;
  patch: (change: Partial<SettingsDraft>) => void;
  /** This role may look but not change. */
  readOnly: boolean;
  /** This section is being saved. */
  saving: boolean;
  /** Some section is being saved: no box may change under it. */
  busy: boolean;
  /** Why the last save of this section was refused, in a sentence. */
  error: string | null;
  /** The refusal was the stale-copy one: offer to reload. */
  stale: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
};

// ── why a login cannot change anything ────────────────────────────────────────

/** A role that has SMS Control as View Only. */
export const VIEW_ONLY_TEXT =
  "View only: this role can look at everything here but cannot change a setting or send a test.";

/** A branch login: the settings and the test are company-wide (the server answers 403 company_wide_settings). */
export const BRANCH_ONLY_TEXT =
  "Signed in for a branch: the SMS settings and the test are company-wide, so only an administrator (a login with no branch) can use them. You can still look at everything.";
