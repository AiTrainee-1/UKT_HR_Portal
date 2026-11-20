// sms-control: hooks/types for the SMS Control page (/hr/sms-control), see ./index.ts.
//
// SMS is used for ONE thing only: one-time sign-in codes (login, password reset, first-time activation) sent through
// 2Factor.in. No promotional, bulk or other SMS exists. SMS codes have their own on/off switch here and work on their own:
// WhatsApp codes are switched on WhatsApp Control, and either channel alone is enough for code sign-in (both may be on). The
// server (backend/api/sms_control_views.py, module `sms_control`) answers:
//
//   GET   /api/sms-control/overview             status, the 2Factor balance, this month's codes and cost, alerts
//   GET   /api/sms-control/usage?month=YYYY-MM   per day and per purpose, cost so far and projected, the balance
//   GET   /api/sms-control/settings             the SMS code switches, the limits, the price and budget, with `version`
//   PATCH /api/sms-control/settings             a save is all-or-nothing: a problem is HTTP 400 {"error": "<one sentence>"};
//                                               a copy somebody else has outdated is 400 {"error": ..., "code": "stale_settings"}
//   GET   /api/sms-control/messages             the log (never a code, never a full number), filtered and paged
//   POST  /api/sms-control/test                 one TEST code through the OTP template: {"ok": bool, "message": "<sentence>"}
//
// The 2Factor API key lives only in the server's environment: no endpoint returns or accepts it, only whether it is set.
// Every answer is read through a `read…` function that fills in what a server leaves out (an older or a newer build), so the
// page shows "unknown" instead of crashing.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";

/** sent: 2Factor accepted it · failed: it could not be handed to 2Factor · blocked: held back by a limit, a switch or the pause. */
export type SmsMessageStatus = "sent" | "failed" | "blocked";
export type SmsPurpose = "login" | "reset" | "activate" | "test";
/** The three things an SMS code is for (a test is not a code anybody can use). */
export type SmsCodePurpose = Exclude<SmsPurpose, "test">;

export type SmsAlertLevel = "error" | "warning" | "info";
/** Something the server says needs attention, in one plain sentence. */
export type SmsAlert = { level: SmsAlertLevel; code: string; message: string };

/** What 2Factor reports as left on the account (SMS credits), or why that is not known. */
export type SmsBalance = { credits: number | null; checkedAt: string | null; error: string | null };

/** The month's codes. The rates are percentages (0 to 100, as the server works them out; from the counts when it does not),
 *  null when there is nothing to count. */
export type SmsMonthCounts = {
  /** Every code asked for: sent + failed + blocked. */
  requested: number;
  sent: number;
  failed: number;
  blocked: number;
  /** SMS codes that were typed in and used (an EmployeeOtp sent by SMS and consumed this month). */
  verified: number;
  /** Of the codes handed to 2Factor (sent + failed), the share it accepted. */
  deliveryRate: number | null;
  /** Of the codes sent to employees (tests left out), the share that was used. */
  verifiedRate: number | null;
};

/** Money in rupees (INR). null: not known (no price, no budget). */
export type SmsCost = {
  perSms: number | null;
  soFar: number | null;
  /** The month's cost at this pace (the current month), or the month's total (a past month). */
  projected: number | null;
  budget: number | null;
  /** soFar as a percentage of the budget (can pass 100). */
  budgetUsedPct: number | null;
  currency: "INR";
};

export type SmsOverview = {
  /** Always "twofactor": 2Factor.in is the only SMS provider. */
  provider: "twofactor";
  /** Every required 2Factor value is set and none of them still looks like the example text. */
  configured: boolean;
  /** This machine is allowed to send (a development machine never is, unless SMS_ALLOW_SENDING=true). */
  sendingAllowed: boolean;
  /** One plain sentence about why sending is not allowed (or that it is). */
  sendingNote: string;
  /** The SMS codes master switch (Settings > OTP Switches). */
  otpEnabled: boolean;
  /** SMS codes can be asked for right now: switched on, 2Factor set up and this machine allowed to send. */
  available: boolean;
  /** For which purposes SMS codes are offered right now (null: the server did not say). */
  purposes: Record<SmsCodePurpose, boolean> | null;
  /** Sending is paused for a while (after repeated 2Factor failures, or a cap used up). */
  paused: boolean;
  /** Why, in one sentence (with the time it ends, when there is one). */
  pauseReason: string;
  pausedUntil: string | null;
  /** The 2Factor environment: whether the API key is set (never the key), the sender ID and template NAME (not secrets; empty
   *  while unset or still the example text) and the API address. */
  env: { authKey: boolean; senderId: string; templateName: string; apiBase: string };
  balance: SmsBalance;
  /** The month the numbers are for (YYYY-MM, India time). */
  monthKey: string;
  month: SmsMonthCounts;
  cost: SmsCost;
  /** What needs attention, most serious first. null: the server sent no list (an older build), the page works one out. */
  alerts: SmsAlert[] | null;
  today: { sent: number; failed: number; blocked: number };
  lastSentAt: string | null;
  /** The hourly and daily caps and how much of each is used; null when the server did not say. */
  limits: { hourlyCap: number; dailyCap: number; hourUsed: number; dayUsed: number } | null;
  /** On a development machine: the employee codes SMS may go to (SMS_ONLY_TO_EMPLOYEES). Empty: no such lock reported. */
  devLock: string[];
};

export type SmsUsageDay = { date: string; sent: number; failed: number; blocked: number; verified: number };
export type SmsPurposeCounts = { sent: number; failed: number; blocked: number; verified: number };

export type SmsUsage = {
  /** YYYY-MM. */
  month: string;
  days: SmsUsageDay[];
  totals: {
    requested: number;
    sent: number;
    failed: number;
    blocked: number;
    verified: number;
    deliveryRate: number | null;
    verifiedRate: number | null;
  };
  byPurpose: Record<SmsPurpose, SmsPurposeCounts>;
  cost: SmsCost & { isCurrentMonth: boolean };
  balance: SmsBalance;
};

export type SmsSettings = {
  /** SMS codes on or off (the master switch). WhatsApp codes have their own, on WhatsApp Control. */
  otpEnabled: boolean;
  otpLoginEnabled: boolean;
  otpResetEnabled: boolean;
  otpActivateEnabled: boolean;
  otpExpiryMinutes: number;
  resendCooldownSeconds: number;
  maxRequestsPerHour: number;
  maxAttemptsPerCode: number;
  maxPerPhonePerHour: number;
  hourlyCap: number;
  dailyCap: number;
  /** Rupees per SMS for the cost estimate (the one in use: HR's, else the default); null sent back = the default. */
  pricePerSms: number | null;
  /** The price the server uses when HR has set none. */
  pricePerSmsDefault: number | null;
  /** Rupees HR wants to stay under each month; null: no budget. */
  monthlyBudget: number | null;
  /** A fingerprint of what is saved. A save sends back the one its page loaded as `expectedVersion`. */
  version: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Advice about what is saved (never blocks a save): plain sentences. */
  warnings: string[];
};

type Editable = Omit<SmsSettings, "version" | "updatedAt" | "updatedBy" | "warnings" | "pricePerSmsDefault">;

/** What a save sends: only the fields being changed, and the `version` the page loaded (a stale copy is refused). */
export type SmsSettingsInput = Partial<Editable> & { expectedVersion?: string };

export type SmsMessage = {
  id: number;
  at: string;
  employeeId: number | null;
  employeeName: string | null;
  employeeCode: string | null;
  /** The number with all but the last four digits hidden (••••••1234). */
  maskedPhone: string;
  purpose: SmsPurpose;
  status: SmsMessageStatus;
  /** A short plain sentence about what went wrong; empty for a sent message. */
  error: string;
  providerMessageId: string;
  ip: string;
};

export type SmsMessagePage = {
  items: SmsMessage[];
  total: number;
  page: number;
  pageSize: number;
  statusCounts: Record<SmsMessageStatus, number>;
};

export type SmsMessageFilters = {
  status?: SmsMessageStatus | "";
  purpose?: SmsPurpose | "";
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
};

/** A test code goes to an employee's registered number (by employee code) or to a typed number. */
export type SmsTestInput = { employeeCode: string } | { phone: string };
export type SmsTestResult = { ok: boolean; message: string };

const BASE = "/api/sms-control";
export const SMS_OVERVIEW_KEY = `${BASE}/overview`;
export const SMS_USAGE_KEY = `${BASE}/usage`;
export const SMS_SETTINGS_KEY = `${BASE}/settings`;
export const SMS_MESSAGES_KEY = `${BASE}/messages`;
export const SMS_TEST_URL = `${BASE}/test`;

const POLL_MS = 30_000;
const USAGE_POLL_MS = 60_000;

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return qs.toString();
}

type Loose = Record<string, unknown>;

const obj = (v: unknown): Loose => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {});
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const when = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** A money or decimal value: a number, or a number written as text ("0.2000", a Django Decimal), else null. */
export function smsDecimal(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/** `part` as a percentage of `whole` (0 to 100), or null when `whole` is nothing. */
export function smsPercent(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

/** The month (YYYY-MM) it is now in India, where the factory is. */
export const thisMonthIst = (now: Date = new Date()): string =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 7);

export function readSmsBalance(raw: unknown): SmsBalance {
  const b = obj(raw);
  // `credits` (2026-11-20; null when unknown) or, from an older build, `available`
  const credits = smsDecimal("credits" in b ? b.credits : b.available);
  const error = text(b.error);
  return { credits, checkedAt: when(b.checkedAt), error: error || null };
}

export function readSmsCost(raw: unknown): SmsCost {
  const c = obj(raw);
  const soFar = smsDecimal(c.soFar);
  const budget = smsDecimal(c.budget);
  const sentPct = smsDecimal(c.budgetUsedPct);
  const usedPct =
    soFar !== null && budget !== null && budget > 0 ? (soFar / budget) * 100 : sentPct !== null ? sentPct : null;
  return {
    perSms: smsDecimal(c.perSms),
    soFar,
    projected: smsDecimal(c.projected),
    budget: budget !== null && budget > 0 ? budget : null,
    budgetUsedPct: usedPct,
    currency: "INR",
  };
}

/** A percentage the server sent (0 to 100), else null. */
const rate = (v: unknown): number | null => {
  const n = smsDecimal(v);
  return n === null ? null : Math.min(100, Math.max(0, n));
};

function readMonthCounts(raw: unknown): SmsMonthCounts {
  const m = obj(raw);
  const sent = count(m.sent);
  const failed = count(m.failed);
  const blocked = count(m.blocked);
  const verified = count(m.verified);
  // the server's rates (percentages) when it sends them; worked out from the counts for an older build
  const has = (key: string) => key in m;
  return {
    requested: count(m.requested) || sent + failed + blocked,
    sent,
    failed,
    blocked,
    verified,
    deliveryRate: has("deliveryRate") ? rate(m.deliveryRate) : smsPercent(sent, sent + failed),
    verifiedRate: has("verifiedRate") ? rate(m.verifiedRate) : smsPercent(verified, sent),
  };
}

const LEVELS: readonly SmsAlertLevel[] = ["error", "warning", "info"];

function readAlerts(raw: unknown): SmsAlert[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((a) => obj(a))
    .map((a) => {
      const level = LEVELS.find((l) => l === a.level) ?? (a.level === "danger" ? "error" : "info");
      return { level, code: text(a.code), message: text(a.message) || text(a.title) };
    })
    .filter((a) => a.message !== "");
}

/**
 * The overview with every key present. It reads the answer of 2026-11-20 (`status`, `month`, `cost`, `alerts`) and the
 * older flat one (`configured`, `channel`, `circuit`), so either build fills the page.
 */
export function readSmsOverview(raw: unknown): SmsOverview {
  const r = obj(raw);
  const status = obj(r.status);
  const env = obj(r.env);
  const today = obj(r.today);
  const circuit = obj(r.circuit);
  const limits = r.limits && typeof r.limits === "object" ? obj(r.limits) : null;

  const configured = (flag(status.configured) ?? flag(r.configured)) === true;
  const sendingAllowed = (flag(status.sendingAllowed) ?? flag(r.sendingAllowed)) === true;
  // the master switch: `otpEnabled`, or (a build from before the switch) the old channel being SMS
  const otpEnabled = (flag(status.otpEnabled) ?? flag(r.otpEnabled) ?? r.channel === "sms") === true;
  const paused = (flag(status.paused) ?? flag(circuit.paused)) === true;
  const available = flag(status.available) ?? flag(r.available) ?? (otpEnabled && configured && sendingAllowed);
  const devLock = obj(status.devLock ?? r.devLock);
  const lockList = Array.isArray(devLock.onlyToEmployees) ? devLock.onlyToEmployees : r.onlyToEmployees;
  const purposes = status.purposes && typeof status.purposes === "object" ? obj(status.purposes) : null;
  const month = obj(r.month);

  return {
    provider: "twofactor",
    configured,
    sendingAllowed,
    sendingNote: text(r.sendingNote) || text(status.sendingNote),
    otpEnabled,
    available: available === true,
    purposes: purposes
      ? { login: purposes.login === true, reset: purposes.reset === true, activate: purposes.activate === true }
      : null,
    paused,
    pauseReason: text(status.pauseReason) || text(circuit.reason),
    pausedUntil: when(status.pausedUntil) ?? when(circuit.until),
    env: {
      authKey: env.authKey === true,
      senderId: text(env.senderId),
      templateName: text(env.templateName),
      apiBase: text(env.apiBase),
    },
    balance: readSmsBalance(r.balance),
    monthKey: text(month.month) || thisMonthIst(),
    month: readMonthCounts(month),
    cost: readSmsCost(r.cost),
    alerts: readAlerts(r.alerts),
    today: { sent: count(today.sent), failed: count(today.failed), blocked: count(today.blocked) },
    lastSentAt: when(r.lastSentAt),
    limits: limits
      ? {
          hourlyCap: count(limits.hourlyCap),
          dailyCap: count(limits.dailyCap),
          hourUsed: count(limits.hourUsed),
          dayUsed: count(limits.dayUsed),
        }
      : null,
    devLock: Array.isArray(lockList) ? lockList.map((c) => String(c)).filter(Boolean) : [],
  };
}

const PURPOSE_KEYS: readonly SmsPurpose[] = ["login", "reset", "activate", "test"];

function readPurposeCounts(raw: unknown): SmsPurposeCounts {
  const p = obj(raw);
  return { sent: count(p.sent), failed: count(p.failed), blocked: count(p.blocked), verified: count(p.verified) };
}

/** The usage of one month with every key present. Totals the server left out are added up from the days. */
export function readSmsUsage(raw: unknown, askedMonth = "", now: Date = new Date()): SmsUsage {
  const r = obj(raw);
  const days = (Array.isArray(r.days) ? r.days : []).map((d) => {
    const day = obj(d);
    return {
      date: text(day.date),
      sent: count(day.sent),
      failed: count(day.failed),
      blocked: count(day.blocked),
      verified: count(day.verified),
    };
  });
  const sum = (key: keyof Omit<SmsUsageDay, "date">) => days.reduce((n, d) => n + d[key], 0);
  const t = obj(r.totals);
  const has = (key: string) => typeof t[key] === "number";
  const sent = has("sent") ? count(t.sent) : sum("sent");
  const failed = has("failed") ? count(t.failed) : sum("failed");
  const blocked = has("blocked") ? count(t.blocked) : sum("blocked");
  const verified = has("verified") ? count(t.verified) : sum("verified");
  const byPurpose = obj(r.byPurpose);
  const cost = obj(r.cost);
  const month = text(r.month) || askedMonth || thisMonthIst(now);
  return {
    month,
    days,
    totals: {
      requested: count(t.requested) || sent + failed + blocked,
      sent,
      failed,
      blocked,
      verified,
      deliveryRate: "deliveryRate" in t ? rate(t.deliveryRate) : smsPercent(sent, sent + failed),
      verifiedRate: "verifiedRate" in t ? rate(t.verifiedRate) : smsPercent(verified, sent),
    },
    byPurpose: Object.fromEntries(PURPOSE_KEYS.map((k) => [k, readPurposeCounts(byPurpose[k])])) as Record<
      SmsPurpose,
      SmsPurposeCounts
    >,
    cost: {
      ...readSmsCost(cost),
      isCurrentMonth: typeof cost.isCurrentMonth === "boolean" ? cost.isCurrentMonth : month === thisMonthIst(now),
    },
    balance: readSmsBalance(r.balance),
  };
}

const whole = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** The settings document with every key present (the defaults of a new installation fill what is missing). */
export function readSmsSettings(raw: unknown): SmsSettings {
  const r = obj(raw);
  const on = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const budget = smsDecimal(r.monthlyBudget);
  return {
    otpEnabled: on(r.otpEnabled, r.otpChannel === "sms"),
    otpLoginEnabled: on(r.otpLoginEnabled, true),
    otpResetEnabled: on(r.otpResetEnabled, true),
    otpActivateEnabled: on(r.otpActivateEnabled, true),
    otpExpiryMinutes: whole(r.otpExpiryMinutes, 5),
    resendCooldownSeconds: whole(r.resendCooldownSeconds, 60),
    maxRequestsPerHour: whole(r.maxRequestsPerHour, 5),
    maxAttemptsPerCode: whole(r.maxAttemptsPerCode, 5),
    maxPerPhonePerHour: whole(r.maxPerPhonePerHour, 5),
    hourlyCap: whole(r.hourlyCap, 300),
    dailyCap: whole(r.dailyCap, 1500),
    pricePerSms: smsDecimal(r.pricePerSms),
    pricePerSmsDefault: smsDecimal(r.pricePerSmsDefault),
    monthlyBudget: budget !== null && budget > 0 ? budget : null,
    version: text(r.version),
    updatedAt: when(r.updatedAt),
    updatedBy: when(r.updatedBy),
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string" && !!w) : [],
  };
}

export const useSmsOverview = () =>
  useQuery<SmsOverview>({
    queryKey: [SMS_OVERVIEW_KEY],
    queryFn: async () => readSmsOverview(await customFetch<unknown>(SMS_OVERVIEW_KEY)),
    refetchInterval: POLL_MS,
  });

/** One month's usage (`month` YYYY-MM; empty asks for this month). The month on screen stays while the next one loads. */
export const useSmsUsage = (month: string) =>
  useQuery<SmsUsage>({
    queryKey: [SMS_USAGE_KEY, month],
    queryFn: async () =>
      readSmsUsage(await customFetch<unknown>(`${SMS_USAGE_KEY}${month ? `?${query({ month })}` : ""}`), month),
    placeholderData: keepPreviousData,
    refetchInterval: USAGE_POLL_MS,
  });

export const useSmsSettings = () =>
  useQuery<SmsSettings>({
    queryKey: [SMS_SETTINGS_KEY],
    queryFn: async () => readSmsSettings(await customFetch<unknown>(SMS_SETTINGS_KEY)),
  });

/** True when the answer is the settings document (and not, say, an empty 204 or `{"ok": true}`). */
const isSettingsDocument = (v: unknown): boolean => {
  const r = obj(v);
  return typeof r.version === "string" && typeof r.otpEnabled === "boolean";
};

/**
 * Saves the fields being changed and puts the answer (the document as it now is, with its new `version`) in the cache. The
 * save is a PATCH; a server that only knows PUT (405) is asked again with PUT, which takes the same partial body.
 */
export const useUpdateSmsSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SmsSettingsInput): Promise<SmsSettings> => {
      const send = (method: "PATCH" | "PUT") =>
        customFetch<unknown>(SMS_SETTINGS_KEY, { method, body: JSON.stringify(body) });
      let answer: unknown;
      try {
        answer = await send("PATCH");
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 405) throw err;
        answer = await send("PUT");
      }
      // an answer that is not the document is followed by a read, so the cache never holds anything else
      if (isSettingsDocument(answer)) return readSmsSettings(answer);
      return readSmsSettings(await customFetch<unknown>(SMS_SETTINGS_KEY));
    },
    onSuccess: (data) => {
      queryClient.setQueryData([SMS_SETTINGS_KEY], data);
      // the switch, the price and the budget all show on the overview and in the usage
      void queryClient.invalidateQueries({ queryKey: [SMS_OVERVIEW_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SMS_USAGE_KEY] });
    },
  });
};

export const useSmsMessages = (filters: SmsMessageFilters) =>
  useQuery<SmsMessagePage>({
    queryKey: [SMS_MESSAGES_KEY, filters],
    queryFn: () => customFetch<SmsMessagePage>(`${SMS_MESSAGES_KEY}?${query(filters)}`),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
  });

/** Sends one test code (the OTP template, a made-up code) and refreshes the log, the counts and the usage. */
export const useSendSmsTest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SmsTestInput) =>
      customFetch<SmsTestResult>(SMS_TEST_URL, { method: "POST", body: JSON.stringify(input) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [SMS_OVERVIEW_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SMS_MESSAGES_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SMS_USAGE_KEY] });
    },
  });
};
