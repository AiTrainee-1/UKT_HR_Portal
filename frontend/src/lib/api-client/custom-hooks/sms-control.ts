// sms-control: hooks/types for the SMS Control page (/hr/sms-control), see ./index.ts.
//
// Login, password-reset and activation codes can go by SMS through 2Factor.in instead of WhatsApp. HR sees and controls that on
// one page. The server (backend/api/sms_control_views.py, module `sms_control`) answers:
//
//   GET  /api/sms-control/overview   status, balance, today's counts, the caps in use, the last 7 days, the circuit breaker
//   GET  /api/sms-control/settings   the channel, the three switches and the limits, with `version` for the stale guard
//   PUT  /api/sms-control/settings   a save is all-or-nothing: a problem is HTTP 400 {"error": "<one sentence>"}; a copy
//                                    that somebody else has outdated is 400 {"error": ..., "code": "stale_settings"}
//   GET  /api/sms-control/messages   the log (never a code, never a full number), filtered and paged
//   POST /api/sms-control/test       one test SMS through the real template: {"ok": bool, "message": "<sentence>"}
//
// The 2Factor API key lives only in the server's environment: no endpoint returns or accepts it, only whether it is set.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

/** Where login / reset / activation codes go. WhatsApp stays the default until HR switches. */
export type SmsChannel = "whatsapp" | "sms";
/** sent: 2Factor accepted it · failed: it could not be delivered to 2Factor · blocked: held back by a limit, a switch or the pause. */
export type SmsMessageStatus = "sent" | "failed" | "blocked";
export type SmsPurpose = "login" | "reset" | "activate" | "test";

export type SmsOverview = {
  /** Always "twofactor": 2Factor.in is the only SMS provider. */
  provider: "twofactor";
  channel: SmsChannel;
  /** Every required 2Factor value is set and none of them still looks like the example text. */
  configured: boolean;
  /** This machine is allowed to send (a development machine never is, unless SMS_ALLOW_SENDING=true). */
  sendingAllowed: boolean;
  /** One plain sentence about why sending is not allowed; empty when it is. */
  sendingNote: string;
  /** The 2Factor environment: whether the API key is set (never the key), the sender ID and template NAME (not secrets;
   *  empty while unset or still the example text) and the API address. */
  env: { authKey: boolean; senderId: string; templateName: string; apiBase: string };
  balance: { available: number | null; checkedAt: string | null; error: string | null };
  today: { sent: number; failed: number; blocked: number };
  last7Days: { date: string; sent: number; failed: number }[];
  lastSentAt: string | null;
  limits: { hourlyCap: number; dailyCap: number; hourUsed: number; dayUsed: number };
  circuit: { paused: boolean; until: string | null };
};

export type SmsSettings = {
  otpChannel: SmsChannel;
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
  /** A fingerprint of what is saved. A save sends back the one its page loaded as `expectedVersion`. */
  version: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Advice about what is saved (never blocks a save): plain sentences. */
  warnings: string[];
};

/** What a save sends: the nine settings, and the `version` the page loaded (the server refuses a save made on a stale copy). */
export type SmsSettingsInput = Omit<SmsSettings, "version" | "updatedAt" | "updatedBy" | "warnings"> & {
  expectedVersion?: string;
};

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

export type SmsTestResult = { ok: boolean; message: string };

const BASE = "/api/sms-control";
export const SMS_OVERVIEW_KEY = `${BASE}/overview`;
export const SMS_SETTINGS_KEY = `${BASE}/settings`;
export const SMS_MESSAGES_KEY = `${BASE}/messages`;

const POLL_MS = 30_000;

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return qs.toString();
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The overview with every key present. The page never has to guard a missing part, so a server that leaves out a key (an
 * older or a newer build) shows "unknown" where it would otherwise have crashed.
 */
export function readSmsOverview(raw: Partial<SmsOverview> | null | undefined): SmsOverview {
  const r = raw ?? {};
  const env = r.env ?? ({} as Partial<SmsOverview["env"]>);
  const balance = r.balance ?? ({} as Partial<SmsOverview["balance"]>);
  const today = r.today ?? ({} as Partial<SmsOverview["today"]>);
  const limits = r.limits ?? ({} as Partial<SmsOverview["limits"]>);
  const circuit = r.circuit ?? ({} as Partial<SmsOverview["circuit"]>);
  return {
    provider: "twofactor",
    channel: r.channel === "sms" ? "sms" : "whatsapp",
    configured: r.configured === true,
    sendingAllowed: r.sendingAllowed === true,
    sendingNote: text(r.sendingNote),
    env: {
      authKey: env.authKey === true,
      senderId: text(env.senderId),
      templateName: text(env.templateName),
      apiBase: text(env.apiBase),
    },
    balance: {
      available: typeof balance.available === "number" ? balance.available : null,
      checkedAt: typeof balance.checkedAt === "string" ? balance.checkedAt : null,
      error: typeof balance.error === "string" && balance.error ? balance.error : null,
    },
    today: { sent: count(today.sent), failed: count(today.failed), blocked: count(today.blocked) },
    last7Days: Array.isArray(r.last7Days)
      ? r.last7Days.map((d) => ({ date: text(d?.date), sent: count(d?.sent), failed: count(d?.failed) }))
      : [],
    lastSentAt: typeof r.lastSentAt === "string" ? r.lastSentAt : null,
    limits: {
      hourlyCap: count(limits.hourlyCap),
      dailyCap: count(limits.dailyCap),
      hourUsed: count(limits.hourUsed),
      dayUsed: count(limits.dayUsed),
    },
    circuit: {
      paused: circuit.paused === true,
      until: typeof circuit.until === "string" ? circuit.until : null,
    },
  };
}

export const useSmsOverview = () =>
  useQuery<SmsOverview>({
    queryKey: [SMS_OVERVIEW_KEY],
    queryFn: async () => readSmsOverview(await customFetch<Partial<SmsOverview>>(SMS_OVERVIEW_KEY)),
    refetchInterval: POLL_MS,
  });

export const useSmsSettings = () =>
  useQuery<SmsSettings>({
    queryKey: [SMS_SETTINGS_KEY],
    queryFn: () => customFetch<SmsSettings>(SMS_SETTINGS_KEY),
  });

/** Saves the settings and puts the answer (the document as it now is, with its new `version`) in the cache. */
export const useUpdateSmsSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SmsSettingsInput): Promise<SmsSettings> => {
      const answer = await customFetch<Partial<SmsSettings> | null>(SMS_SETTINGS_KEY, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      // an answer that is not the document is followed by a read, so the cache never holds anything else
      if (answer && typeof answer.otpChannel === "string") return answer as SmsSettings;
      return customFetch<SmsSettings>(SMS_SETTINGS_KEY);
    },
    onSuccess: (data) => {
      queryClient.setQueryData([SMS_SETTINGS_KEY], data);
      void queryClient.invalidateQueries({ queryKey: [SMS_OVERVIEW_KEY] });
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

/** Sends one test SMS (the real template, the code 123456) and refreshes the log and the counts. */
export const useSendSmsTest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (phone: string) =>
      customFetch<SmsTestResult>(`${BASE}/test`, { method: "POST", body: JSON.stringify({ phone }) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [SMS_OVERVIEW_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SMS_MESSAGES_KEY] });
    },
  });
};
