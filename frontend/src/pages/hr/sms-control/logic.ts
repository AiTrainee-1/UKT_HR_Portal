import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  smsPercent,
  type SmsAlert,
  type SmsCodePurpose,
  type SmsCost,
  type SmsMessageStatus,
  type SmsOverview,
  type SmsPurpose,
  type SmsSettings,
  type SmsSettingsInput,
  type SmsUsageDay,
} from "@/lib/api-client/custom-hooks/sms-control";
import { smsPath, type SettingsSectionKey } from "./routes";

/** `part` as a percentage of `whole` (0 to 100), or null when `whole` is nothing. */
export const percent = smsPercent;

// The rules of the SMS Control page that need no screen: what each setting is (its range, its words), how a draft is checked
// and turned into a save, money and months, the alerts and the status line, and the small formatters. Pure, so the render
// tests, the unit tests and the page all read from one place.

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

// ── the limits ────────────────────────────────────────────────────────────────

export type NumericKey =
  | "otpExpiryMinutes"
  | "resendCooldownSeconds"
  | "maxRequestsPerHour"
  | "maxAttemptsPerCode"
  | "maxPerPhonePerHour"
  | "hourlyCap"
  | "dailyCap";

export type SwitchKey = "otpLoginEnabled" | "otpResetEnabled" | "otpActivateEnabled";
export type MoneyKey = "pricePerSms" | "monthlyBudget";

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
      "After this time an SMS code stops working, even if it was never used. A short time is safer; a long time is kinder when the SMS arrives late.",
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
      "After an SMS code is sent, the same employee has to wait this long before the next one. It stops people tapping the button again and again and running up the SMS bill.",
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
      "The most SMS codes one employee can ask for in an hour, whatever the purpose. After that they are told to try later or use their password.",
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
      "The most SMS codes sent to one phone number in an hour, counting every employee record that uses that number. Two records sharing a number cannot double the limit.",
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
        what: "when the cap is reached, new SMS codes are refused for a while and logged as Blocked",
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
      { where: "All login screens", what: "when the cap is reached, new SMS codes are refused until tomorrow" },
      { where: "Overview", what: "the usage bar fills towards this number" },
    ],
    example: (n) => `At most ${n.toLocaleString("en-IN")} SMS go out in one day.`,
  },
];

export const NUMERIC_KEYS: readonly NumericKey[] = LIMIT_RULES.map((r) => r.key);
export const SWITCH_KEYS: readonly SwitchKey[] = ["otpLoginEnabled", "otpResetEnabled", "otpActivateEnabled"];
export const MONEY_KEYS: readonly MoneyKey[] = ["pricePerSms", "monthlyBudget"];

// ── the switches ──────────────────────────────────────────────────────────────

export type SwitchRule = {
  key: SwitchKey;
  purposeKey: SmsCodePurpose;
  title: string;
  purpose: string;
  on: string;
  off: string;
  affects: Affect[];
};

export const SWITCH_RULES: readonly SwitchRule[] = [
  {
    key: "otpLoginEnabled",
    purposeKey: "login",
    title: "Sign in with an SMS code",
    purpose: "Lets an employee sign in with a code sent by SMS instead of typing a password.",
    on: "Employees can sign in with an SMS code",
    off: "Employees cannot sign in with an SMS code",
    affects: [
      { where: "Employee web app and mobile app", what: "the 'Send code by SMS' option shows or hides" },
      { where: "Password sign-in", what: "always stays available" },
    ],
  },
  {
    key: "otpResetEnabled",
    purposeKey: "reset",
    title: "Forgot password by SMS code",
    purpose: "Lets an employee who forgot the password choose a new one after confirming an SMS code.",
    on: "Employees can reset a password with an SMS code",
    off: "Employees cannot reset a password with an SMS code",
    affects: [
      { where: "Forgot password screen", what: "the SMS option shows or hides" },
      { where: "Employees who forgot the password", what: "use a WhatsApp code if that is on, or ask HR" },
    ],
  },
  {
    key: "otpActivateEnabled",
    purposeKey: "activate",
    title: "First-time activation by SMS code",
    purpose:
      "A new employee has no password yet. This lets them confirm an SMS code sent to the number HR has on file before they choose one.",
    on: "New employees can activate their account with an SMS code",
    off: "New employees cannot activate with an SMS code",
    affects: [
      { where: "Activate account screen", what: "the SMS option shows or hides" },
      { where: "New employees", what: "use a WhatsApp code if that is on; with neither, HR sets the first password" },
    ],
  },
];

/** The master switch, as words. */
export const MASTER_RULE = {
  title: "SMS codes",
  purpose:
    "The one switch for every SMS the system sends. While it is off, no SMS goes out at all and the apps offer no SMS option. While it is on, the three switches below choose what SMS codes may be used for.",
  on: "On: employees can get one-time codes by SMS",
  off: "Off: no SMS is sent",
  affects: [
    {
      where: "Employee web app and mobile app",
      what: "pick it up at once: they ask the server before every code, so nothing has to be updated or restarted",
    },
    {
      where: "WhatsApp codes",
      what: "are switched on WhatsApp Control and are not touched by this switch",
      to: "/hr/whatsapp-control",
    },
  ] as Affect[],
};

// ── the money ─────────────────────────────────────────────────────────────────

/** What one SMS costs when HR has not entered a price (the server's default for the estimate). */
export const DEFAULT_PRICE_PER_SMS = 0.2;
export const PRICE_MAX = 100;
export const BUDGET_MAX = 10_000_000;

/** A rupee amount from what was typed ("0.2", "₹ 1,500", "1500.50"), or null when it is not one. Empty is "" (no value). */
export function parseRupees(input: string): number | null | "" {
  const t = input.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  if (t === "") return "";
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(t)) return null;
  return Number(t);
}

export type CostErrors = Partial<Record<MoneyKey, string>>;

/** Checks the Cost section: a price from 0 to 100 rupees (empty = the default) and a budget of 0 or more (empty = none). */
export function validateCost(draft: Pick<SettingsDraft, MoneyKey>): { errors: CostErrors; first: string | null } {
  const errors: CostErrors = {};
  const price = parseRupees(draft.pricePerSms);
  if (price === null || (price !== "" && price > PRICE_MAX)) {
    errors.pricePerSms = `Enter an amount in rupees from 0 to ${PRICE_MAX}, for example 0.20 (up to 4 decimals).`;
  }
  const budget = parseRupees(draft.monthlyBudget);
  if (budget === null || (budget !== "" && budget > BUDGET_MAX)) {
    errors.monthlyBudget = "Enter an amount in rupees, for example 500, or leave it empty for no budget.";
  } else if (budget !== "" && Number(budget.toFixed(2)) !== budget) {
    errors.monthlyBudget = "A budget has at most 2 decimals (paise).";
  }
  const first = errors.pricePerSms
    ? `Price per SMS: ${errors.pricePerSms}`
    : errors.monthlyBudget
      ? `Monthly budget: ${errors.monthlyBudget}`
      : null;
  return { errors, first };
}

const inr = (digits: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** "₹1,234.50". `precise` keeps up to 4 decimals (a price per SMS: "₹0.1150"), at least 2. */
export function formatRupees(n: number | null | undefined, precise = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (!precise) return inr(2).format(n);
  const digits = Math.min(4, Math.max(2, (String(n).split(".")[1] ?? "").length));
  return inr(digits).format(n);
}

/** A rupee amount as a box shows it ("0.2", "1500"): no symbol, no grouping. */
export const rupeesText = (n: number | null): string => (n === null ? "" : String(n));

/** The price the estimate uses: the one saved, else the default. */
export const effectivePrice = (saved: number | null): number => saved ?? DEFAULT_PRICE_PER_SMS;

export type BudgetLevel = "none" | "ok" | "near" | "over";

export type BudgetState = {
  level: BudgetLevel;
  /** soFar as a percentage of the budget, for the bar (0 to 100); null without a budget. */
  barPct: number | null;
  /** soFar as a percentage of the budget, as it is (can pass 100). */
  usedPct: number | null;
  /** At this pace the month ends over the budget. */
  projectedOver: boolean;
  /** How much the projection passes the budget by (0 when it does not). */
  overBy: number;
};

/** How the month's cost stands against the budget: comfortable, close (80%) or over; and whether the projection passes it. */
export function budgetState(cost: Pick<SmsCost, "soFar" | "projected" | "budget" | "budgetUsedPct">): BudgetState {
  const budget = cost.budget;
  if (budget === null || !(budget > 0)) {
    return { level: "none", barPct: null, usedPct: null, projectedOver: false, overBy: 0 };
  }
  const used = cost.soFar !== null ? (cost.soFar / budget) * 100 : (cost.budgetUsedPct ?? 0);
  const projected = cost.projected ?? cost.soFar ?? 0;
  return {
    level: used >= 100 ? "over" : used >= 80 ? "near" : "ok",
    barPct: Math.min(100, Math.max(0, used)),
    usedPct: used,
    projectedOver: projected > budget,
    overBy: Math.max(0, projected - budget),
  };
}

/** The month's cost at this pace: what was spent so far, spread over the days gone, times the days in the month. */
export function projectMonth(soFar: number, month: string, now: Date = new Date()): number {
  const days = daysInMonth(month);
  const current = thisMonth(now);
  if (month !== current) return soFar;
  const elapsed = Math.max(1, Number(istDate(now).slice(8, 10)));
  return (soFar / elapsed) * days;
}

/** "1,000 codes at ₹0.20 cost ₹200.00." from the price being typed. */
export function costExample(price: number, codes = 1000): string {
  return `${plural(codes, "SMS code", "SMS codes")} at ${formatRupees(price, true)} each cost ${formatRupees(price * codes)}.`;
}

// ── months and days ───────────────────────────────────────────────────────────

const IST = "Asia/Kolkata";

/** The calendar day (YYYY-MM-DD) it is in India at `now`. */
export const istDate = (now: Date = new Date()): string =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** The month (YYYY-MM) it is in India at `now`. */
export const thisMonth = (now: Date = new Date()): string => istDate(now).slice(0, 7);

export const isMonth = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** The month `delta` months from `month` ("2026-01", -1 -> "2025-12"). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "November 2026". */
export function monthLabel(month: string): string {
  if (!isMonth(month)) return month;
  const d = new Date(`${month}-15T12:00:00Z`);
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The months the picker offers, newest first: this month and the `count - 1` before it. */
export function monthOptions(now: Date = new Date(), count = 12): string[] {
  const current = thisMonth(now);
  return Array.from({ length: count }, (_, i) => shiftMonth(current, -i));
}

/** A month from the address, or this month when it is not a real one or is still to come. */
export function pickMonth(value: string, now: Date = new Date()): string {
  const current = thisMonth(now);
  return isMonth(value) && value <= current ? value : current;
}

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

/** "12" for a YYYY-MM-DD day (a calendar day has no time zone: it is read as it is written). */
export function dayNumber(date: string): string {
  const day = Number(date.slice(8, 10));
  return Number.isFinite(day) && day > 0 ? String(day) : date;
}

/** "Mon 12 Oct" for a YYYY-MM-DD day. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export const formatNumber = (n: number): string => n.toLocaleString("en-IN");

/** "92%" (one decimal under 10%: "4.5%"); "—" when there is nothing to count. */
export function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const rounded = n < 10 && n > 0 ? Math.round(n * 10) / 10 : Math.round(n);
  return `${rounded}%`;
}

// ── the usage chart ───────────────────────────────────────────────────────────

export type ChartRow = SmsUsageDay & { day: string; label: string; total: number };

/** One row per day of the month for the chart: the days the server sent, the others as zero, in order. */
export function chartRows(month: string, days: readonly SmsUsageDay[], now: Date = new Date()): ChartRow[] {
  if (!isMonth(month)) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const last = month === thisMonth(now) ? Number(istDate(now).slice(8, 10)) : daysInMonth(month);
  return Array.from({ length: last }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    const d = byDate.get(date) ?? { date, sent: 0, failed: 0, blocked: 0, verified: 0 };
    return { ...d, day: String(i + 1), label: dayLabel(date), total: d.sent + d.failed + d.blocked };
  });
}

// ── labels ────────────────────────────────────────────────────────────────────

/** The one SMS provider, as people say it. */
export const PROVIDER_NAME = "2Factor";

export const PURPOSE_LABEL: Record<SmsPurpose, string> = {
  login: "Sign-in code",
  reset: "Password reset",
  activate: "Account activation",
  test: "Test code",
};

export const PURPOSES: readonly SmsPurpose[] = ["login", "reset", "activate", "test"];
export const CODE_PURPOSES: readonly SmsCodePurpose[] = ["login", "reset", "activate"];

export const STATUS_LABEL: Record<SmsMessageStatus, string> = { sent: "Sent", failed: "Failed", blocked: "Blocked" };

/** What a status means. */
export const STATUS_HELP: Record<SmsMessageStatus, string> = {
  sent: `${PROVIDER_NAME} accepted the message`,
  failed: `it could not be handed to ${PROVIDER_NAME}`,
  blocked: "a limit, a switch or the pause stopped it before it was sent",
};

export const purposeLabel = (p: string): string => PURPOSE_LABEL[p as SmsPurpose] ?? p;

/** The line every tab that talks about switching repeats: SMS and WhatsApp codes do not depend on each other. */
export const INDEPENDENT_TEXT =
  "WhatsApp codes are switched on WhatsApp Control and work on their own. Either one is enough for code sign-in, and both may be on: when both are, the employee chooses.";

/** What SMS is used for, and what it never is. */
export const CODES_ONLY_TEXT =
  "SMS is used only for one-time sign-in codes. No promotional, bulk or other SMS is ever sent from the HRMS.";

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
  /** A secret: its value is never shown anywhere, only whether it is set. */
  secret?: boolean;
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
    secret: true,
    what: "Your 2Factor API key: the password that lets the server send SMS from your 2Factor account. Copy it from the 2Factor panel. Keep it secret.",
    example: "",
  },
  {
    name: "TWOFACTOR_TEMPLATE_NAME",
    flag: "templateName",
    required: true,
    what: "The NAME of the OTP template you made in the 2Factor panel (not a number). One template serves sign-in, reset and activation codes.",
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
    what: "Leave it empty and the server decides by itself: a real server sends, a development machine never does. Set it to true to make a development machine send.",
    example: "",
  },
  {
    name: "SMS_ONLY_TO_EMPLOYEES",
    required: false,
    what: "On a development machine that is allowed to send: the employee codes (comma separated) SMS may go to. Every other number is refused, so a test can never reach a real employee by mistake. Leave it empty on the real server.",
    example: "30020",
  },
];

/** The message the Test tab previews: the template with a made-up code where XXXX is. */
export const templatePreview = (code: string): string => TWOFACTOR_TEMPLATE_TEXT.replace("XXXX", code);

export const DOCS_FILE = "twofactor-sms-otp-integration.md";

/** Whether the server reports an environment value as set (the key as a flag, the sender ID and template name as text). */
export const isEnvSet = (env: SmsOverview["env"], flag: "authKey" | "senderId" | "templateName"): boolean =>
  flag === "authKey" ? env.authKey : env[flag] !== "";

/** The names of the required environment values that are not set, as the server reports them. */
export function missingEnv(overview: Pick<SmsOverview, "env">): string[] {
  return ENV_VARS.filter((v) => v.flag && !isEnvSet(overview.env, v.flag)).map((v) => v.name);
}

// ── caps ──────────────────────────────────────────────────────────────────────

export type UsageLevel = "ok" | "near" | "full" | "none";

/** How much of a cap is used: the percentage (0 to 100) and whether it is comfortable, close (80%) or reached. */
export function usage(used: number, cap: number): { pct: number; level: UsageLevel } {
  if (!(cap > 0)) return { pct: 0, level: "none" };
  const pct = Math.min(100, Math.round((used / cap) * 100));
  return { pct, level: used >= cap ? "full" : used / cap >= 0.8 ? "near" : "ok" };
}

/** The balance (SMS credits, as 2Factor reports it) at or under which the page says to top up. */
export const LOW_BALANCE = 100;

// ── the status line at the top ────────────────────────────────────────────────

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export type HeroState = {
  id: "off" | "not-configured" | "not-sending" | "paused" | "working" | "unavailable";
  tone: Tone;
  title: string;
  detail: string;
  badge: string;
};

/** What the SMS codes are doing right now, in one title and one sentence: the first thing the Overview says. */
export function heroState(o: SmsOverview): HeroState {
  const name = PROVIDER_NAME;
  if (!o.otpEnabled) {
    return {
      id: "off",
      tone: "neutral",
      title: "SMS codes are switched off",
      detail: `No SMS is sent. The apps offer no SMS option; WhatsApp codes, when they are on, work without it.${o.configured ? ` ${name} is set up, so SMS codes can be switched on at any time.` : ""}`,
      badge: "Off",
    };
  }
  if (!o.configured) {
    return {
      id: "not-configured",
      tone: "bad",
      title: `SMS codes are on, but ${name} is not set up`,
      detail:
        "No SMS can be sent until the 2Factor values are on the server, so the apps do not offer SMS. Nobody is locked out: password sign-in keeps working.",
      badge: "Not available",
    };
  }
  if (!o.sendingAllowed) {
    return {
      id: "not-sending",
      tone: "warn",
      title: "SMS codes are on, but this server does not send SMS",
      detail: o.sendingNote || "Sending is switched off on this machine. A development machine never sends.",
      badge: "Not available",
    };
  }
  if (o.paused) {
    return {
      id: "paused",
      tone: "bad",
      title: "SMS codes are paused",
      // the server's sentence already says until when; without one, say it here
      detail: `${o.pauseReason || `${name} failed several times in a row, so sending is paused${o.pausedUntil ? ` until ${formatClock(o.pausedUntil)}` : ""}.`} It starts again by itself. Until then employees are told to use another way to sign in.`,
      badge: "Paused",
    };
  }
  if (!o.available) {
    return {
      id: "unavailable",
      tone: "warn",
      title: "SMS codes are on, but not offered",
      detail: "The server does not offer SMS codes right now. The alerts below say why.",
      badge: "Not available",
    };
  }
  return {
    id: "working",
    tone: "good",
    title: "SMS codes are working",
    detail: `Employees can get one-time codes by SMS through ${name} for the purposes switched on in Settings.`,
    badge: "Available",
  };
}

// ── what needs attention ──────────────────────────────────────────────────────

export type AlertItem = {
  id: string;
  tone: Tone;
  message: string;
  /** Where it is dealt with (an address inside the page). */
  to?: string;
  linkLabel?: string;
};

const LEVEL_TONE: Record<SmsAlert["level"], Tone> = { error: "bad", warning: "warn", info: "info" };

/** Where each alert code of the server (sms_control_views._alerts) is dealt with. */
const ALERT_LINKS: Record<
  string,
  { tab: Parameters<typeof smsPath>[0]; nested?: string; query?: string; label: string }
> = {
  not_configured: { tab: "setup", label: "Open Setup" },
  sending_blocked: { tab: "setup", label: "Open Setup" },
  otp_off: { tab: "settings", nested: "switches", label: "Open OTP Switches" },
  all_switches_off: { tab: "settings", nested: "switches", label: "Open OTP Switches" },
  paused: { tab: "messages", label: "See the messages" },
  hourly_cap_near: { tab: "settings", nested: "limits", label: "Open Limits" },
  daily_cap_near: { tab: "settings", nested: "limits", label: "Open Limits" },
  budget_exceeded: { tab: "settings", nested: "cost", label: "Open Cost" },
  budget_projected: { tab: "settings", nested: "cost", label: "Open Cost" },
  failures: { tab: "messages", query: "status=failed", label: "See the failures" },
  dev_lock: { tab: "test", label: "Open Test" },
};

/** Where an alert of the server is dealt with: the known codes first, else read from the code's words. */
export function alertLink(code: string): { to: string; linkLabel: string } | undefined {
  const c = code.toLowerCase();
  const known = ALERT_LINKS[c];
  if (known) return { to: smsPath(known.tab, known.nested, known.query), linkLabel: known.label };
  if (/balance/.test(c)) return undefined;
  if (/budget|cost|price/.test(c)) return { to: smsPath("settings", "cost"), linkLabel: "Open Cost" };
  if (/cap|limit/.test(c)) return { to: smsPath("settings", "limits"), linkLabel: "Open Limits" };
  if (/config|env|key|template|sender|setup/.test(c)) return { to: smsPath("setup"), linkLabel: "Open Setup" };
  if (/pause|circuit|breaker|fail/.test(c)) {
    return { to: smsPath("messages", undefined, "status=failed"), linkLabel: "See the failures" };
  }
  if (/block/.test(c))
    return { to: smsPath("messages", undefined, "status=blocked"), linkLabel: "See the blocked ones" };
  if (/otp|switch|disabled|off/.test(c)) return { to: smsPath("settings", "switches"), linkLabel: "Open OTP Switches" };
  return undefined;
}

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, neutral: 3, good: 4 };

/**
 * The "needs attention" list of the Overview: the server's own alerts when it sends them (each with a link to where it is
 * dealt with), else the same checks worked out here from the overview (an older server). Most serious first.
 */
export function overviewAlerts(o: SmsOverview): AlertItem[] {
  const items: AlertItem[] =
    o.alerts !== null
      ? o.alerts.map((a, i) => ({
          id: a.code || `alert-${i}`,
          tone: LEVEL_TONE[a.level],
          message: a.message,
          ...alertLink(a.code),
        }))
      : derivedAlerts(o);
  return items
    .map((a, i) => ({ a, i }))
    .sort((x, y) => TONE_RANK[x.a.tone] - TONE_RANK[y.a.tone] || x.i - y.i)
    .map((x) => x.a);
}

/** The checks an older server leaves to the page. */
export function derivedAlerts(o: SmsOverview): AlertItem[] {
  const name = PROVIDER_NAME;
  const out: AlertItem[] = [];
  const missing = missingEnv(o);
  if (!o.configured) {
    out.push({
      id: "not_configured",
      tone: o.otpEnabled ? "bad" : "info",
      message:
        missing.length > 0
          ? `${name} is not set up on the server. Not set: ${missing.join(", ")}.`
          : `${name} is not set up on the server: a value still looks like the example text.`,
      ...alertLink("not_configured"),
    });
  }
  if (o.otpEnabled && o.configured && !o.sendingAllowed) {
    out.push({
      id: "sending_blocked",
      tone: "warn",
      message: o.sendingNote || "This machine is not allowed to send SMS.",
    });
  }
  if (o.otpEnabled && o.paused) {
    out.push({
      id: "paused",
      tone: "bad",
      message: o.pauseReason || `SMS sending is paused${o.pausedUntil ? ` until ${formatClock(o.pausedUntil)}` : ""}.`,
      ...alertLink("paused"),
    });
  }
  if (o.balance.credits !== null && o.balance.credits <= LOW_BALANCE && o.configured) {
    out.push({
      id: "balance_low",
      tone: o.balance.credits <= 0 ? "bad" : "warn",
      message: `${name} reports ${formatNumber(o.balance.credits)} SMS credits left. Top up in the ${name} panel before codes stop arriving.`,
    });
  }
  const budget = budgetState(o.cost);
  if (budget.level === "over") {
    out.push({
      id: "budget_over",
      tone: "bad",
      message: `This month's SMS cost (${formatRupees(o.cost.soFar)}) has passed the budget of ${formatRupees(o.cost.budget)}.`,
      ...alertLink("budget"),
    });
  } else if (budget.projectedOver || budget.level === "near") {
    out.push({
      id: "budget_near",
      tone: "warn",
      message: budget.projectedOver
        ? `At this pace the month ends at ${formatRupees(o.cost.projected)}, over the budget of ${formatRupees(o.cost.budget)}.`
        : `This month's SMS cost is close to the budget of ${formatRupees(o.cost.budget)}.`,
      ...alertLink("budget"),
    });
  }
  if (o.limits) {
    for (const [id, span, used, cap] of [
      ["cap_hour", "hourly", o.limits.hourUsed, o.limits.hourlyCap],
      ["cap_day", "daily", o.limits.dayUsed, o.limits.dailyCap],
    ] as const) {
      const u = usage(used, cap);
      if (u.level === "full" || u.level === "near") {
        out.push({
          id,
          tone: u.level === "full" ? "bad" : "warn",
          message:
            u.level === "full"
              ? `The ${span} SMS cap is reached (${formatNumber(used)} of ${formatNumber(cap)}): new SMS codes are refused for now.`
              : `Close to the ${span} SMS cap: ${formatNumber(used)} of ${formatNumber(cap)} used.`,
          ...alertLink("cap"),
        });
      }
    }
  }
  if (o.today.failed > 0 && !o.paused) {
    out.push({
      id: "failed_today",
      tone: "warn",
      message: `${plural(o.today.failed, "SMS", "SMS")} failed today: ${name} did not accept ${o.today.failed === 1 ? "it" : "them"}.`,
      ...alertLink("failed"),
    });
  }
  return out;
}

// ── the Test tab ──────────────────────────────────────────────────────────────

/** The made-up code a test carries (SMS codes have 4 digits). It opens nothing. */
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

/** "••••••3210", the way the log shows a number. */
export const hidePhone = (phone: string): string => `••••••${phone.slice(-4)}`;

/** "30020" / "30020 and 30021" / "30020, 30021 and 30022". */
export function codesText(codes: readonly string[]): string {
  if (codes.length <= 1) return codes[0] ?? "";
  return `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
}

// ── the settings draft ────────────────────────────────────────────────────────

/** The settings as the form holds them (a box can be empty or half typed, so numbers and money are text). */
export type SettingsDraft = { otpEnabled: boolean } & Record<SwitchKey, boolean> &
  Record<NumericKey, string> &
  Record<MoneyKey, string>;

export const SECTION_FIELDS: Record<SettingsSectionKey, readonly (keyof SettingsDraft)[]> = {
  switches: ["otpEnabled", ...SWITCH_KEYS],
  limits: NUMERIC_KEYS,
  cost: MONEY_KEYS,
};

export function draftFrom(saved: SmsSettings): SettingsDraft {
  const draft = { otpEnabled: saved.otpEnabled === true } as SettingsDraft;
  for (const key of SWITCH_KEYS) draft[key] = saved[key] === true;
  for (const key of NUMERIC_KEYS) draft[key] = String(saved[key]);
  draft.pricePerSms = rupeesText(saved.pricePerSms);
  draft.monthlyBudget = rupeesText(saved.monthlyBudget);
  return draft;
}

/** True when the fields of one section differ between two drafts. Money compares by value ("0.2" is "0.20"). */
export function sectionDirty(section: SettingsSectionKey, a: SettingsDraft, b: SettingsDraft): boolean {
  return SECTION_FIELDS[section].some((key) => {
    if (key === "pricePerSms" || key === "monthlyBudget") {
      const x = parseRupees(a[key]);
      const y = parseRupees(b[key]);
      return x === null || y === null ? a[key].trim() !== b[key].trim() : x !== y;
    }
    return a[key] !== b[key];
  });
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
  if (!draft.otpEnabled) return [];
  return SWITCH_KEYS.every((k) => !draft[k])
    ? [
        "SMS codes are on, but all three uses are off, so nobody can get a code by SMS. Turn one on, or switch SMS codes off.",
      ]
    : [];
}

/**
 * The body of a save: only the fields of the section being saved (the server merges them with what is saved and checks the
 * whole all-or-nothing), plus the `version` the page loaded.
 */
export function buildInput(
  draft: SettingsDraft,
  section: SettingsSectionKey,
  expectedVersion: string | undefined,
  saved?: SmsSettings,
): SmsSettingsInput {
  const input: SmsSettingsInput = {};
  if (section === "switches") {
    input.otpEnabled = draft.otpEnabled;
    for (const key of SWITCH_KEYS) input[key] = draft[key];
  }
  if (section === "limits") {
    for (const key of NUMERIC_KEYS) input[key] = parseWhole(draft[key]) ?? saved?.[key];
  }
  if (section === "cost") {
    for (const key of MONEY_KEYS) {
      const value = parseRupees(draft[key]);
      input[key] = value === "" || value === null ? null : value;
    }
  }
  if (expectedVersion) input.expectedVersion = expectedVersion;
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

/** Why SMS codes cannot be switched on right now (null when they can): 2Factor is not set up on the server. The server
 *  refuses it too; the page just says so first. Codes that are already on can always be switched off. */
export function switchOnBlockedReason(configured: boolean | null, savedOn: boolean): string | null {
  if (configured !== false || savedOn) return null;
  return `SMS codes cannot be switched on yet: ${PROVIDER_NAME} is not set up on the server. Finish its setup first (see the Setup tab).`;
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
