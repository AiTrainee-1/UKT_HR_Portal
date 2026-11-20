// whatsapp: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
//
// Since 2026-11-20 every WhatsApp message goes out through the official Meta WhatsApp Cloud API as an APPROVED Meta
// template. The first half of this file is what the rest of the portal uses (one-document sends, the
// salary-slip bulk send); the second half is WhatsApp Control (/hr/whatsapp-control). Every answer of WhatsApp Control is
// read through a read*() function that fills in a safe value for anything missing, so an older or a newer server (the
// backend lands in parallel) never breaks a tab.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";
import { PayrollBreakdownResponse, PayrollRunItem } from "./payroll";

// ── WhatsApp (single-send mutations, bulk-send progress) ───────────────────

export type WhatsAppDocumentType =
  | "salary_slip"
  | "id_card"
  | "offer_letter"
  | "experience_letter"
  | "resignation_letter"
  | "other"
  | "visitor_notification"
  | "otp_login"
  | "otp_reset"
  | "otp_activate"
  | "absent_alert"
  | "late_alert"
  | "four_punch_alert"
  | "missing_punch_alert"
  | "geo_approval"
  | "geo_rejection"
  | "geo_punch_approval"
  | "geo_punch_rejection"
  | "on_duty_punch_reminder"
  | "approval_approved"
  | "approval_rejected"
  | "outpass_gate_out"
  | "outpass_gate_in"
  | "visitor_contact"
  // The server's message catalog is the source of truth; a type added there just works here.
  | (string & {});

// Single-document sends -one mutation per document type, same {ok, sentTo}
// shape as the equivalent email mutations above.
export const useWhatsAppSalarySlip = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/salary-slips/${id}/whatsapp`, { method: "POST" }),
  });

export const useWhatsAppIdCard = () =>
  useMutation({
    mutationFn: (employeeId: number) =>
      customFetch<{ ok: boolean; sentTo: string }>("/api/idcard/whatsapp", {
        method: "POST",
        body: JSON.stringify({ employeeId }),
      }),
  });

export const useWhatsAppOfferLetter = () =>
  useMutation({
    mutationFn: (employeeId: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/employees/${employeeId}/offer-letter/whatsapp`, {
        method: "POST",
      }),
  });

export const useWhatsAppExperienceLetter = () =>
  useMutation({
    mutationFn: ({ employeeId, lastWorkingDate }: { employeeId: number; lastWorkingDate?: string }) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/employees/${employeeId}/experience-letter/whatsapp`, {
        method: "POST",
        body: JSON.stringify({ lastWorkingDate }),
      }),
  });

export const useWhatsAppResignation = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/recruitment/resignations/${id}/whatsapp`, { method: "POST" }),
  });

export const useWhatsAppEmployeeDocument = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/employee-documents/${id}/whatsapp`, { method: "POST" }),
  });

// Bulk WhatsApp send (Salary Slip only, mirroring salary_slip_bulk_email 1:1)
export type WhatsAppBulkFailure = { employeeName: string; employeeCode: string; error: string };

export type WhatsAppBulkProgress = {
  stage: "idle" | "running" | "completed";
  documentType: WhatsAppDocumentType | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentEmployee: string | null;
  failures: WhatsAppBulkFailure[];
  startedAt: string | null;
  finishedAt: string | null;
};

export const useWhatsAppBulkProgress = (enabled: boolean) =>
  useQuery<WhatsAppBulkProgress>({
    queryKey: ["/api/salary-slips/bulk-whatsapp-progress"],
    queryFn: () => customFetch<WhatsAppBulkProgress>("/api/salary-slips/bulk-whatsapp-progress"),
    enabled,
    refetchInterval: enabled ? 1500 : false,
    staleTime: 0,
  });

export type WhatsAppBulkResult = {
  ok: boolean;
  sent: number;
  failed: number;
  failures: WhatsAppBulkFailure[];
  /** Messages waiting in the send queue (the server paces them; anything not sent by tonight expires). */
  queued?: number;
  /** The server's own sentence about the batch. */
  message?: string;
};

/** What a single "send on WhatsApp" answers: the message now waits its turn in the send queue (2026-11-06). */
export type WhatsAppSendResult = { sentTo?: string; status?: string; queued?: boolean };

/** The toast after sending one document on WhatsApp: "queued" when it waits its turn, "sent" when it already went. */
export function whatsappSendToast(result: WhatsAppSendResult, who?: string): { title: string; description: string } {
  const to = result.sentTo ? ` (${result.sentTo})` : "";
  if (result.queued || result.status === "queued") {
    return {
      title: who ? `WhatsApp queued for ${who}` : "WhatsApp queued",
      description: `It goes out in turn${to}, within the sending limits. See WhatsApp Control → Messages.`,
    };
  }
  return { title: who ? `WhatsApp sent to ${who}` : "Sent via WhatsApp", description: `Sent${to}.` };
}

export const useUpdatePayrollRecord = () =>
  useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<{ status: string; bonus: number; deductions: number; notes: string }>;
    }) =>
      customFetch<PayrollRunItem>(`/api/payroll/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const getPayrollBreakdownQueryKey = (id: number) => ["/api/payroll", id, "breakdown"] as const;

export const usePayrollBreakdown = (id: number | null) =>
  useQuery<PayrollBreakdownResponse>({
    queryKey: getPayrollBreakdownQueryKey(id ?? 0),
    queryFn: () => customFetch<PayrollBreakdownResponse>(`/api/payroll/${id}/breakdown`),
    enabled: !!id,
  });

// ── WhatsApp Control page (/hr/whatsapp-control) ───────────────────────────
//
//   GET   overview                     the connection, this month's messages and cost, templates, OTP, queue, alerts
//   GET   usage?month=YYYY-MM          per day / category / type, cost so far and projected (with and without GST)
//   GET   settings / PATCH settings    switches, timings, sending limits, quiet hours, OTP master, template overrides,
//                                      price per category, monthly budget
//   GET   meta-templates               the Meta templates (synced from Meta) and which message types use each
//   POST  meta-templates/sync          pull them from Meta now
//   GET   meta-templates/draft/<type>  a ready-to-submit draft for one message type
//   POST  meta-templates               create a template and submit it to Meta for approval
//   POST  meta-templates/create-missing   submit a draft for every switched-on type without a template
//   DELETE meta-templates/<id>         delete a template at Meta and here
//   GET   connection                   the set-up checklist (environment variable names, phone, token, webhook)
//   GET/POST test-message              Send a test: the options, then a dry-run preview or a real send
//   GET   messages, employees, queue;  PATCH employees/<id>/opt-out;  POST queue/clear

const BASE = "/api/whatsapp-control";

/** Every status a message row can have: the queue's (queued, sending, expired, skipped) and Meta's delivery ones. */
export type WhatsAppDeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export type WhatsAppQueueMessageStatus = "queued" | "sending" | "expired" | "skipped";
export type WhatsAppMessageStatus = WhatsAppDeliveryStatus | WhatsAppQueueMessageStatus;
/** Why a message was sent: a one-time login code, something the employee asked for, an automatic alert, a document. */
export type WhatsAppMessageKind = "code" | "requested" | "automatic" | "document";
/** A module key from the server's catalog: documents, otp, attendance, approvals, hod, geo, visitors, outpass, other. */
export type WhatsAppCategory = string;
/** Meta's pricing categories (what a message is charged as). One-time codes are authentication. */
export type WhatsAppPricingCategory = "authentication" | "utility" | "marketing" | "service";
export const WHATSAPP_PRICING_CATEGORIES: readonly WhatsAppPricingCategory[] = [
  "authentication",
  "utility",
  "marketing",
  "service",
];

// ── reading helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** A number from JSON: a number, or a Decimal the server sent as text ("0.1150"); anything else is null. */
const numOrNull = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
const codeList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.map((c) => (typeof c === "number" ? String(c) : c)).filter((c): c is string => typeof c === "string");
  return out.length ? out : null;
};
/** A rate as a percentage: the server may send 0.93 or 93. */
const pctOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  if (n === null) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
};

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return qs.toString();
}

/** The server's own sentence for a refused request ("Max per hour must be between 1 and 500."), else `fallback`. A code
 *  in `error` ("permission_denied", from the permission middleware) is passed over for the sentence in `message`. */
export function whatsAppErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const data = err.data;
    if (isRecord(data)) {
      for (const field of ["error", "message", "detail"]) {
        const sentence = data[field];
        if (typeof sentence !== "string" || !sentence.trim()) continue;
        if (field === "error" && /^[a-z]+(_[a-z]+)+$/.test(sentence.trim()) && typeof data.message === "string")
          continue;
        return sentence.trim();
      }
    }
    return fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A refused form's per-field sentences ({fields: {body: "..."}} or {errors: {...}}), when the server sent them. */
export function whatsAppFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !isRecord(err.data)) return {};
  const out: Record<string, string> = {};
  for (const holder of [err.data.fields, err.data.errors, err.data.fieldErrors]) {
    if (!isRecord(holder)) continue;
    for (const [key, value] of Object.entries(holder)) {
      const sentence = Array.isArray(value) ? value.find((v) => typeof v === "string") : value;
      if (typeof sentence === "string" && sentence.trim()) out[key] = sentence.trim();
    }
  }
  return out;
}

// ── Overview ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WhatsAppAlert = { level: "error" | "warning" | "info"; code: string; message: string };

export type WhatsAppConnectionSummary = {
  configured: boolean;
  sendingAllowed: boolean;
  blockReasons: string[];
  /** Meta's quality rating of the number: GREEN, YELLOW, RED (null: not known). */
  qualityRating: string | null;
  /** Meta's messaging limit: TIER_250, TIER_2K, TIER_10K, TIER_100K, TIER_UNLIMITED. */
  messagingLimitTier: string | null;
  displayNumber: string | null;
  verifiedName: string | null;
  /** The number's status at Meta (CONNECTED, FLAGGED, RESTRICTED ...). */
  status: string | null;
  lastWebhookAt: string | null;
};

export type WhatsAppMonthCounts = {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  queued: number;
  skipped: number;
  /** Percentages (0-100), null when nothing was sent. */
  deliveryRate: number | null;
  readRate: number | null;
};

export type WhatsAppCostSummary = {
  soFar: number;
  projected: number;
  budget: number | null;
  budgetUsedPct: number | null;
  currency: string;
};

/** A switched-on message type with no approved or pending template: it is skipped until one exists. */
export type WhatsAppMissingTemplate = { type: string; label: string; templateName: string | null };

export type WhatsAppOtpSummary = {
  enabled: boolean;
  /** WhatsApp codes can go out right now (configured, engine on, template approved). */
  available: boolean;
  templateStatus: string | null;
  templateName: string | null;
  /** This month's WhatsApp codes, when the server counts them. */
  month: { sent: number; delivered: number | null; verified: number | null } | null;
};

export type WhatsAppOverview = {
  connection: WhatsAppConnectionSummary;
  month: WhatsAppMonthCounts;
  cost: WhatsAppCostSummary;
  templates: { approved: number; pending: number; rejected: number; missingForEnabledTypes: WhatsAppMissingTemplate[] };
  otp: WhatsAppOtpSummary;
  queue: WhatsAppQueue | null;
  alerts: WhatsAppAlert[];
};

const ALERT_LEVELS = ["error", "warning", "info"] as const;

function readAlerts(v: unknown): WhatsAppAlert[] {
  return (Array.isArray(v) ? v : [])
    .map((a): WhatsAppAlert | null => {
      if (typeof a === "string" && a.trim()) return { level: "warning", code: "", message: a };
      if (!isRecord(a) || !strOrNull(a.message)) return null;
      const level = ALERT_LEVELS.includes(a.level as WhatsAppAlert["level"])
        ? (a.level as WhatsAppAlert["level"])
        : "info";
      return { level, code: str(a.code), message: str(a.message) };
    })
    .filter((a): a is WhatsAppAlert => a !== null);
}

function readMissing(v: unknown): WhatsAppMissingTemplate[] {
  return (Array.isArray(v) ? v : [])
    .map((m): WhatsAppMissingTemplate | null => {
      if (typeof m === "string" && m) return { type: m, label: m, templateName: null };
      if (!isRecord(m)) return null;
      const type = strOrNull(m.type) ?? strOrNull(m.key) ?? strOrNull(m.documentType);
      if (!type) return null;
      return {
        type,
        label: strOrNull(m.label) ?? type,
        templateName: strOrNull(m.templateName) ?? strOrNull(m.template) ?? strOrNull(m.name),
      };
    })
    .filter((m): m is WhatsAppMissingTemplate => m !== null);
}

export function readWhatsAppOverview(raw: unknown): WhatsAppOverview {
  const r = rec(raw);
  const c = rec(r.connection);
  const m = rec(r.month);
  const cost = rec(r.cost);
  const t = rec(r.templates);
  const o = rec(r.otp);
  const om = isRecord(o.month) ? o.month : typeof o.sent === "number" ? o : null;
  const sent = num(m.sent);
  const delivered = num(m.delivered);
  const read = num(m.read);
  return {
    connection: {
      configured: c.configured === true,
      sendingAllowed: c.sendingAllowed === true,
      blockReasons: strList(c.blockReasons),
      qualityRating: strOrNull(c.qualityRating),
      messagingLimitTier: strOrNull(c.messagingLimitTier),
      displayNumber: strOrNull(c.displayNumber),
      verifiedName: strOrNull(c.verifiedName),
      status: strOrNull(c.status),
      lastWebhookAt: strOrNull(c.lastWebhookAt),
    },
    month: {
      sent,
      delivered,
      read,
      failed: num(m.failed),
      queued: num(m.queued),
      skipped: num(m.skipped),
      // the server's rate when it sent one; else worked out here (a read message was delivered first)
      deliveryRate: pctOrNull(m.deliveryRate) ?? (sent ? Math.round(((delivered + read) / sent) * 1000) / 10 : null),
      readRate: pctOrNull(m.readRate) ?? (sent ? Math.round((read / sent) * 1000) / 10 : null),
    },
    cost: {
      soFar: numOrNull(cost.soFar) ?? 0,
      projected: numOrNull(cost.projected) ?? 0,
      budget: numOrNull(cost.budget),
      budgetUsedPct: numOrNull(cost.budgetUsedPct),
      currency: strOrNull(cost.currency) ?? "INR",
    },
    templates: {
      approved: num(t.approved),
      pending: num(t.pending),
      rejected: num(t.rejected),
      missingForEnabledTypes: readMissing(t.missingForEnabledTypes),
    },
    otp: {
      enabled: o.enabled === true,
      available: o.available === true,
      templateStatus: strOrNull(o.templateStatus),
      templateName: strOrNull(o.templateName) ?? strOrNull(o.template),
      month: om ? { sent: num(om.sent), delivered: numOrNull(om.delivered), verified: numOrNull(om.verified) } : null,
    },
    queue: isRecord(r.queue) ? readWhatsAppQueue(r.queue) : null,
    alerts: readAlerts(r.alerts),
  };
}

export const WHATSAPP_OVERVIEW_KEY = `${BASE}/overview`;

export const useWhatsAppOverview = (enabled = true) =>
  useQuery<WhatsAppOverview>({
    queryKey: [WHATSAPP_OVERVIEW_KEY],
    queryFn: async () => readWhatsAppOverview(await customFetch<unknown>(WHATSAPP_OVERVIEW_KEY)),
    enabled,
    refetchInterval: 60_000,
  });

// ── Usage & Cost ────────────────────────────────────────────────────────────────────────────────────────────────────

export type WhatsAppCategoryCounts = Record<WhatsAppPricingCategory, number>;

export type WhatsAppUsageDay = {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  byCategory: WhatsAppCategoryCounts;
};

export type WhatsAppCategoryUsage = { messages: number; billable: number; rate: number; cost: number };

export type WhatsAppTypeUsage = { type: string; label: string; module: string; messages: number; cost: number };

export type WhatsAppUsage = {
  month: string;
  days: WhatsAppUsageDay[];
  totals: { sent: number; delivered: number; read: number; failed: number; skipped: number; billable: number };
  byCategory: Record<WhatsAppPricingCategory, WhatsAppCategoryUsage>;
  byType: WhatsAppTypeUsage[];
  cost: {
    soFar: number;
    soFarWithGst: number;
    projected: number;
    projectedWithGst: number;
    gstRate: number;
    budget: number | null;
    budgetUsedPct: number | null;
    currency: string;
    isCurrentMonth: boolean;
  };
  rates: Record<WhatsAppPricingCategory, number>;
  /** Meta's own figures for the month (pricing analytics), when Meta answered. */
  meta: {
    available: boolean;
    cost: number | null;
    volume: number | null;
    lastSyncedAt: string | null;
    error: string | null;
  };
};

/** India's price per delivered message before GST (Meta's rate card, Nov 2026): the page's estimate when the server
 *  sends none. HR edits them on Settings. */
export const WHATSAPP_DEFAULT_PRICE_RATES: Readonly<Record<WhatsAppPricingCategory, number>> = {
  authentication: 0.115,
  utility: 0.115,
  marketing: 0.8631,
  service: 0,
};

const GST = 0.18;

function readCategoryCounts(v: unknown): WhatsAppCategoryCounts {
  const r = rec(v);
  return {
    authentication: num(r.authentication),
    utility: num(r.utility),
    marketing: num(r.marketing),
    service: num(r.service),
  };
}

function readRates(v: unknown): Record<WhatsAppPricingCategory, number> {
  const r = rec(v);
  const out = { ...WHATSAPP_DEFAULT_PRICE_RATES };
  for (const c of WHATSAPP_PRICING_CATEGORIES) {
    const n = numOrNull(r[c]);
    if (n !== null && n >= 0) out[c] = n;
  }
  return out;
}

export function readWhatsAppUsage(raw: unknown, askedMonth = ""): WhatsAppUsage {
  const r = rec(raw);
  const totals = rec(r.totals);
  const byCat = rec(r.byCategory);
  const cost = rec(r.cost);
  const meta = rec(r.meta);
  const rates = readRates(r.rates);
  const gstRate = numOrNull(cost.gstRate) ?? GST;
  const soFar = numOrNull(cost.soFar) ?? 0;
  const projected = numOrNull(cost.projected) ?? soFar;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const byCategory = Object.fromEntries(
    WHATSAPP_PRICING_CATEGORIES.map((c) => {
      const row = rec(byCat[c]);
      return [
        c,
        {
          messages: num(row.messages),
          billable: num(row.billable),
          rate: numOrNull(row.rate) ?? rates[c],
          cost: numOrNull(row.cost) ?? 0,
        },
      ];
    }),
  ) as Record<WhatsAppPricingCategory, WhatsAppCategoryUsage>;
  return {
    month: strOrNull(r.month) ?? askedMonth,
    days: (Array.isArray(r.days) ? r.days : [])
      .filter(isRecord)
      .filter((d) => typeof d.date === "string" && d.date !== "")
      .map((d) => ({
        date: d.date as string,
        sent: num(d.sent),
        delivered: num(d.delivered),
        read: num(d.read),
        failed: num(d.failed),
        byCategory: readCategoryCounts(d.byCategory),
      })),
    totals: {
      sent: num(totals.sent),
      delivered: num(totals.delivered),
      read: num(totals.read),
      failed: num(totals.failed),
      skipped: num(totals.skipped),
      billable: num(totals.billable),
    },
    byCategory,
    byType: (Array.isArray(r.byType) ? r.byType : [])
      .filter(isRecord)
      .filter((t) => typeof t.type === "string" && t.type !== "")
      .map((t) => ({
        type: t.type as string,
        label: strOrNull(t.label) ?? (t.type as string),
        module: str(t.module),
        messages: num(t.messages),
        cost: numOrNull(t.cost) ?? 0,
      })),
    cost: {
      soFar,
      soFarWithGst: numOrNull(cost.soFarWithGst) ?? round2(soFar * (1 + gstRate)),
      projected,
      projectedWithGst: numOrNull(cost.projectedWithGst) ?? round2(projected * (1 + gstRate)),
      gstRate,
      budget: numOrNull(cost.budget),
      budgetUsedPct: numOrNull(cost.budgetUsedPct),
      currency: strOrNull(cost.currency) ?? "INR",
      isCurrentMonth: cost.isCurrentMonth !== false,
    },
    rates,
    meta: {
      available: meta.available === true,
      cost: numOrNull(meta.cost),
      volume: numOrNull(meta.volume),
      lastSyncedAt: strOrNull(meta.lastSyncedAt),
      error: strOrNull(meta.error),
    },
  };
}

export const WHATSAPP_USAGE_KEY = `${BASE}/usage`;

/** One month's usage ("YYYY-MM"; "" = this month). */
export const useWhatsAppUsage = (month: string, enabled = true) =>
  useQuery<WhatsAppUsage>({
    queryKey: [WHATSAPP_USAGE_KEY, month],
    queryFn: async () =>
      readWhatsAppUsage(
        await customFetch<unknown>(month ? `${WHATSAPP_USAGE_KEY}?${query({ month })}` : WHATSAPP_USAGE_KEY),
        month,
      ),
    enabled,
    placeholderData: keepPreviousData,
  });

// ── Messages ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WhatsAppMessage = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  phone: string;
  documentType: WhatsAppDocumentType;
  typeLabel: string;
  category: WhatsAppCategory;
  categoryLabel: string;
  /** The workflow behind it ("leave", "on_duty", ...) when one message type serves several. */
  relatedModule: string;
  /** "Approvals - Leave": the HRMS module this message belongs to. */
  relatedLabel: string;
  status: WhatsAppMessageStatus;
  /** Why it failed, or (skipped / expired) which rule held it back. */
  error: string;
  messageText: string;
  providerMessageId: string;
  referenceId: number | null;
  sentBy: string | null;
  automatic: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  // The sending queue's fields (a server older than the queue leaves them out).
  kind?: WhatsAppMessageKind | (string & {});
  /** When Meta accepted it; null while it waits or when it was never sent. */
  sentAt?: string | null;
  /** After this it is too late to be useful, and it expires instead of going out. */
  expiresAt?: string | null;
  attempts?: number;
  // Meta Cloud API (2026-11-20)
  /** The Meta template it was sent as. */
  templateName?: string;
  /** What Meta charges it as (from the delivery receipt, else the template's category). */
  pricingCategory?: WhatsAppPricingCategory | (string & {}) | null;
  /** Meta says it is charged; null while not known. */
  billable?: boolean | null;
  deliveredAt?: string | null;
  readAt?: string | null;
};

/** A message row with the Meta fields read under either name the server may use. */
export function readWhatsAppMessage(raw: WhatsAppMessage): WhatsAppMessage {
  const r = raw as unknown as Record<string, unknown>;
  const pricing =
    strOrNull(r.pricingCategory) ??
    strOrNull(r.metaCategory) ??
    (WHATSAPP_PRICING_CATEGORIES.includes(r.category as WhatsAppPricingCategory) ? (r.category as string) : null);
  return {
    ...raw,
    templateName: strOrNull(r.templateName) ?? strOrNull(r.template) ?? "",
    pricingCategory: pricing ? pricing.toLowerCase() : null,
    billable: boolOrNull(r.billable),
    deliveredAt: strOrNull(r.deliveredAt),
    readAt: strOrNull(r.readAt),
    messageText: str(r.messageText),
    error: str(r.error),
  };
}

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

export type WhatsAppMessageFilters = {
  status?: WhatsAppMessageStatus | "";
  category?: WhatsAppCategory | "";
  /** One HRMS workflow, e.g. "leave" (Approvals). */
  related?: string;
  type?: string;
  employeeId?: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
};

export const useWhatsAppMessages = (filters: WhatsAppMessageFilters, enabled = true) =>
  useQuery<Paged<WhatsAppMessage>>({
    queryKey: [`${BASE}/messages`, filters],
    queryFn: async () => {
      const page = await customFetch<Paged<WhatsAppMessage>>(`${BASE}/messages?${query(filters)}`);
      return { ...page, items: (page?.items ?? []).map(readWhatsAppMessage) };
    },
    enabled,
    refetchInterval: 30_000,
  });

// ── Employees and opt-out ───────────────────────────────────────────────────────────────────────────────────────────

export type WhatsAppEmployeeRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  phone: string;
  department: string | null;
  total: number;
  failed: number;
  lastMessageAt: string | null;
  /** The employee asked for no WhatsApp messages ("No WhatsApp"), or replied STOP. */
  optOut: boolean;
};

export type WhatsAppEmployeeParams = {
  search?: string;
  /** "true" lists only the employees with No WhatsApp on. */
  optOut?: "true";
  /** "1" lists every employee, also those never messaged (so HR can turn No WhatsApp on for anyone). */
  all?: "1";
  page: number;
  pageSize: number;
};

const WHATSAPP_EMPLOYEES_KEY = `${BASE}/employees`;

export const useWhatsAppEmployees = (params: WhatsAppEmployeeParams) =>
  useQuery<Paged<WhatsAppEmployeeRow>>({
    queryKey: [WHATSAPP_EMPLOYEES_KEY, params],
    queryFn: () => customFetch<Paged<WhatsAppEmployeeRow>>(`${WHATSAPP_EMPLOYEES_KEY}?${query(params)}`),
  });

/** Turns an employee's "No WhatsApp" on or off. The switch moves at once and moves back if the server refuses. */
export const useSetWhatsAppOptOut = () => {
  const queryClient = useQueryClient();
  const isEmployeeList = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === WHATSAPP_EMPLOYEES_KEY;
  return useMutation({
    mutationFn: ({ employeeId, optOut, reason }: { employeeId: number; optOut: boolean; reason?: string }) =>
      customFetch<WhatsAppEmployeeRow>(`${WHATSAPP_EMPLOYEES_KEY}/${employeeId}/opt-out`, {
        method: "PATCH",
        body: JSON.stringify(reason ? { optOut, reason } : { optOut }),
      }),
    onMutate: async ({ employeeId, optOut }) => {
      await queryClient.cancelQueries({ predicate: isEmployeeList });
      const previous = queryClient.getQueriesData<Paged<WhatsAppEmployeeRow>>({ predicate: isEmployeeList });
      queryClient.setQueriesData<Paged<WhatsAppEmployeeRow>>({ predicate: isEmployeeList }, (page) =>
        page ? { ...page, items: page.items.map((r) => (r.employeeId === employeeId ? { ...r, optOut } : r)) } : page,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ predicate: isEmployeeList });
      // Messages held back from now on show as Skipped.
      queryClient.invalidateQueries({ queryKey: [WHATSAPP_QUEUE_KEY] });
    },
  });
};

// ── Settings (switches, timings, limits, OTP master, overrides, prices, budget) ─────────────────────────────────────

export type WhatsAppFeature = { key: string; label: string; description: string; group: string; enabled: boolean };
export type WhatsAppFeatureGroup = { key: string; title: string; blurb: string };
export type WhatsAppTiming = { key: string; label: string; value: number; min: number; max: number };
export type WhatsAppQueueLimitKey = "minGapSeconds" | "maxPerHour" | "maxPerDay" | "maxPerEmployeePerDay";
/** One of the sending queue's limits, with the range the server accepts. */
export type WhatsAppQueueLimit = {
  key: WhatsAppQueueLimitKey | (string & {});
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
};
/** No message goes out between start and end ("HH:MM", may run past midnight). */
export type WhatsAppQuietHours = { enabled: boolean; start: string; end: string };
export type WhatsAppControlSettings = {
  /** The master switch: OFF sends nothing by WhatsApp, one-time login codes included. */
  engineEnabled: boolean;
  /** The WhatsApp OTP master switch: OFF sends no code by WhatsApp (SMS codes are set on SMS Control, on their own). */
  otpEnabled: boolean;
  groups: WhatsAppFeatureGroup[];
  /** The module and workflow switches, plus one `type:<document_type>` switch per message type that has no other. */
  features: WhatsAppFeature[];
  timings: WhatsAppTiming[];
  queueLimits: WhatsAppQueueLimit[];
  quietHours: WhatsAppQuietHours | undefined;
  /** HR's choice of Meta template for a message type: {typeKey: templateName}. */
  templateOverrides: Record<string, string>;
  /** Rupees per delivered billable message, before GST, per Meta pricing category. */
  priceRates: Record<WhatsAppPricingCategory, number>;
  /** Rupees a month; null = no budget set. */
  monthlyBudget: number | null;
  updatedAt: string | null;
};
/** A change carries only what changed: a feature key, a timing or queue limit, engineEnabled, otpEnabled, (part of)
 *  quietHours, templateOverrides, priceRates, monthlyBudget. */
export type WhatsAppControlSettingsUpdate = Record<
  string,
  boolean | number | null | Partial<WhatsAppQuietHours> | Record<string, string> | Record<string, number>
>;

export function readWhatsAppSettings(raw: unknown): WhatsAppControlSettings {
  const r = rec(raw);
  const list = <T>(v: unknown, keep: (x: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(v) ? v : [])
      .filter(isRecord)
      .map(keep)
      .filter((x): x is T => x !== null);
  const q = isRecord(r.quietHours) ? r.quietHours : null;
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(r.templateOverrides))) if (typeof v === "string" && v) overrides[k] = v;
  return {
    engineEnabled: r.engineEnabled !== false,
    otpEnabled: r.otpEnabled !== false,
    groups: list(r.groups, (g) =>
      typeof g.key === "string" ? { key: g.key, title: str(g.title) || g.key, blurb: str(g.blurb) } : null,
    ),
    features: list(r.features, (f) =>
      typeof f.key === "string"
        ? {
            key: f.key,
            label: str(f.label) || f.key,
            description: str(f.description),
            group: str(f.group) || "other",
            enabled: f.enabled === true,
          }
        : null,
    ),
    timings: list(r.timings, (t) =>
      typeof t.key === "string"
        ? { key: t.key, label: str(t.label) || t.key, value: num(t.value), min: num(t.min), max: num(t.max) }
        : null,
    ),
    queueLimits: list(r.queueLimits, (l) =>
      typeof l.key === "string"
        ? {
            key: l.key,
            label: str(l.label) || l.key,
            value: num(l.value),
            min: num(l.min),
            max: num(l.max),
            unit: str(l.unit),
          }
        : null,
    ),
    quietHours: q
      ? { enabled: q.enabled === true, start: str(q.start) || "21:00", end: str(q.end) || "07:00" }
      : undefined,
    templateOverrides: overrides,
    priceRates: readRates(r.priceRates),
    monthlyBudget: numOrNull(r.monthlyBudget),
    updatedAt: strOrNull(r.updatedAt),
  };
}

export const WHATSAPP_SETTINGS_KEY = `${BASE}/settings`;

export const useWhatsAppControlSettings = (enabled = true) =>
  useQuery<WhatsAppControlSettings>({
    queryKey: [WHATSAPP_SETTINGS_KEY],
    queryFn: async () => readWhatsAppSettings(await customFetch<unknown>(WHATSAPP_SETTINGS_KEY)),
    enabled,
  });

/** PATCH (the Meta contract); a server that still only knows PUT (405) gets the same body as a PUT. */
async function saveSettings(data: WhatsAppControlSettingsUpdate): Promise<unknown> {
  const init = { body: JSON.stringify(data) };
  try {
    return await customFetch<unknown>(WHATSAPP_SETTINGS_KEY, { ...init, method: "PATCH" });
  } catch (e) {
    if (e instanceof ApiError && e.status === 405)
      return customFetch<unknown>(WHATSAPP_SETTINGS_KEY, { ...init, method: "PUT" });
    throw e;
  }
}

export const useUpdateWhatsAppControlSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: WhatsAppControlSettingsUpdate) => readWhatsAppSettings(await saveSettings(data)),
    onSuccess: (data) => {
      queryClient.setQueryData([WHATSAPP_SETTINGS_KEY], data);
      // The switches, limits, prices and budget change what the queue, the overview, the cost and the templates report.
      for (const key of [WHATSAPP_QUEUE_KEY, WHATSAPP_OVERVIEW_KEY, WHATSAPP_USAGE_KEY, WHATSAPP_META_TEMPLATES_KEY])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
};

// ── The sending queue ──────────────────────────────────────────────────────

export type WhatsAppQueue = {
  engineEnabled: boolean;
  paused: boolean;
  /** Why sending is paused, in words HR can act on. */
  pausedReason: string;
  inQuietHours: boolean;
  queued: number;
  sentToday: number;
  sentLastHour: number;
  failedToday: number;
  expiredToday: number;
  skippedToday: number;
  /** When the next waiting message is due to go out; null when nothing waits. */
  nextSendAt: string | null;
  limits: Record<WhatsAppQueueLimitKey, number>;
};

/** Reads the queue's answer with a safe value for anything missing, so a partial answer can't break the page. */
export function readWhatsAppQueue(raw: unknown): WhatsAppQueue {
  const r = rec(raw);
  const limits = rec(r.limits);
  return {
    engineEnabled: r.engineEnabled !== false,
    paused: r.paused === true,
    pausedReason: typeof r.pausedReason === "string" ? r.pausedReason : "",
    inQuietHours: r.inQuietHours === true,
    queued: num(r.queued),
    sentToday: num(r.sentToday),
    sentLastHour: num(r.sentLastHour),
    failedToday: num(r.failedToday),
    expiredToday: num(r.expiredToday),
    skippedToday: num(r.skippedToday),
    nextSendAt: typeof r.nextSendAt === "string" && r.nextSendAt ? r.nextSendAt : null,
    limits: {
      minGapSeconds: num(limits.minGapSeconds),
      maxPerHour: num(limits.maxPerHour),
      maxPerDay: num(limits.maxPerDay),
      maxPerEmployeePerDay: num(limits.maxPerEmployeePerDay),
    },
  };
}

const WHATSAPP_QUEUE_KEY = `${BASE}/queue`;

/** Today's sending queue. Polled every 30 s while the card showing it is on screen (and the browser tab is visible). */
export const useWhatsAppQueue = (enabled = true) =>
  useQuery<WhatsAppQueue>({
    queryKey: [WHATSAPP_QUEUE_KEY],
    queryFn: async () => readWhatsAppQueue(await customFetch<unknown>(WHATSAPP_QUEUE_KEY)),
    enabled,
    refetchInterval: 30_000,
  });

/** Drops every message still waiting in the queue; none of them will be sent. */
export const useClearWhatsAppQueue = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => customFetch<{ cleared: number }>(`${WHATSAPP_QUEUE_KEY}/clear`, { method: "POST" }),
    onSuccess: () => {
      for (const key of [WHATSAPP_QUEUE_KEY, `${BASE}/messages`, WHATSAPP_OVERVIEW_KEY])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
};

// ── Meta templates ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Meta's template statuses (DRAFT: saved here, never submitted; DELETED: Meta no longer has it). */
export type MetaTemplateStatus =
  | "DRAFT"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "PAUSED"
  | "DISABLED"
  | "IN_APPEAL"
  | "PENDING_DELETION"
  | "DELETED"
  | "LIMIT_EXCEEDED"
  | (string & {});

export type MetaTemplateCategory = "UTILITY" | "AUTHENTICATION" | "MARKETING" | (string & {});

export type WhatsAppMetaTemplate = {
  id: number;
  name: string;
  language: string;
  category: MetaTemplateCategory;
  status: MetaTemplateStatus;
  qualityScore: string | null;
  rejectedReason: string | null;
  /** The HRMS message types sent as this template (by default or by HR's choice). */
  messageTypes: string[];
  /** Meta's components (HEADER, BODY, FOOTER, BUTTONS). */
  components: Record<string, unknown>[];
  lastSyncedAt: string | null;
  metaId: string | null;
};

export type WhatsAppMetaTemplates = {
  templates: WhatsAppMetaTemplate[];
  lastSyncedAt: string | null;
  /** The Meta keys are set on this server (else nothing can be synced or submitted). */
  configured: boolean;
};

const upper = (v: unknown, fallback: string): string => (strOrNull(v) ?? fallback).toUpperCase();

export function readMetaTemplates(raw: unknown): WhatsAppMetaTemplates {
  const r = rec(raw);
  const rows = Array.isArray(raw) ? raw : r.templates;
  return {
    templates: (Array.isArray(rows) ? rows : [])
      .filter(isRecord)
      .filter((t) => typeof t.name === "string" && t.name !== "")
      .map((t, i) => {
        const quality = isRecord(t.qualityScore) ? strOrNull(t.qualityScore.score) : strOrNull(t.qualityScore);
        return {
          id: typeof t.id === "number" ? t.id : -(i + 1),
          name: t.name as string,
          language: strOrNull(t.language) ?? "en",
          category: upper(t.category, "UTILITY"),
          status: upper(t.status, "PENDING"),
          qualityScore: quality ? quality.toUpperCase() : null,
          rejectedReason: strOrNull(t.rejectedReason),
          messageTypes: strList(t.messageTypes),
          components: (Array.isArray(t.components) ? t.components : []).filter(isRecord),
          lastSyncedAt: strOrNull(t.lastSyncedAt),
          metaId: strOrNull(t.metaId) ?? (typeof t.metaId === "number" ? String(t.metaId) : null),
        };
      }),
    lastSyncedAt: strOrNull(r.lastSyncedAt),
    configured: r.configured !== false,
  };
}

export const WHATSAPP_META_TEMPLATES_KEY = `${BASE}/meta-templates`;

export const useMetaTemplates = (enabled = true) =>
  useQuery<WhatsAppMetaTemplates>({
    queryKey: [WHATSAPP_META_TEMPLATES_KEY],
    queryFn: async () => readMetaTemplates(await customFetch<unknown>(WHATSAPP_META_TEMPLATES_KEY)),
    enabled,
  });

/** What changes when a template is created, synced or deleted: the list, the overview's counts and alerts, the
 *  settings (a type's template status) and the OTP tab (the code template). */
function invalidateTemplates(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of [WHATSAPP_META_TEMPLATES_KEY, WHATSAPP_OVERVIEW_KEY, `${BASE}/meta-templates/draft`])
    void queryClient.invalidateQueries({ queryKey: [key] });
}

export type WhatsAppSyncResult = { synced: number | null; message: string | null };

export const useSyncMetaTemplates = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<WhatsAppSyncResult> => {
      const r = rec(await customFetch<unknown>(`${WHATSAPP_META_TEMPLATES_KEY}/sync`, { method: "POST" }));
      const synced =
        numOrNull(r.synced) ?? numOrNull(r.count) ?? (Array.isArray(r.templates) ? r.templates.length : null);
      return { synced, message: strOrNull(r.message) };
    },
    onSuccess: () => invalidateTemplates(queryClient),
  });
};

/** The header a template carries: none, a document (PDF) or an image (the ID card). */
export type WhatsAppTemplateHeader = "" | "document" | "image" | "text";

export type WhatsAppTemplateDraft = {
  /** The message type it is for ("" for a template HR writes from scratch). */
  messageType: string;
  name: string;
  language: string;
  category: MetaTemplateCategory;
  header: WhatsAppTemplateHeader;
  body: string;
  footer: string;
  /** A sample value for every {{variable}} of the body (Meta asks for one). */
  examples: Record<string, string>;
  warnings: string[];
  /** AUTHENTICATION only: how long a code lasts (Meta prints it in the footer). */
  codeExpirationMinutes: number | null;
};

const HEADERS: readonly WhatsAppTemplateHeader[] = ["", "document", "image", "text"];

export function readWhatsAppTemplateDraft(raw: unknown, messageType = ""): WhatsAppTemplateDraft {
  const r = rec(raw);
  const headerRaw = isRecord(r.header) ? str(r.header.type ?? r.header.format) : str(r.header);
  const header = headerRaw.toLowerCase() as WhatsAppTemplateHeader;
  const examples: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(r.examples)))
    if (typeof v === "string" || typeof v === "number") examples[k] = String(v);
  return {
    messageType: strOrNull(r.messageType) ?? strOrNull(r.type) ?? messageType,
    name: str(r.name),
    language: strOrNull(r.language) ?? "en",
    category: upper(r.category, "UTILITY"),
    header: HEADERS.includes(header) ? header : "",
    body: str(r.body),
    footer: typeof r.footer === "string" ? r.footer : "UK Textiles HR",
    examples,
    warnings: strList(r.warnings),
    codeExpirationMinutes: numOrNull(r.codeExpirationMinutes) ?? numOrNull(r.expiryMinutes),
  };
}

/** The draft for one message type (the catalog's wording turned into a Meta template), or null while none is asked. */
export const useMetaTemplateDraft = (messageType: string | null) =>
  useQuery<WhatsAppTemplateDraft>({
    queryKey: [`${BASE}/meta-templates/draft`, messageType],
    queryFn: async () =>
      readWhatsAppTemplateDraft(
        await customFetch<unknown>(`${BASE}/meta-templates/draft/${encodeURIComponent(messageType ?? "")}`),
        messageType ?? "",
      ),
    enabled: !!messageType,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

export type WhatsAppTemplateInput = {
  name: string;
  language: string;
  category: MetaTemplateCategory;
  header: WhatsAppTemplateHeader;
  body: string;
  footer: string;
  examples: Record<string, string>;
  /** The message type it is made for (the server may point the type at it). */
  messageType?: string;
  codeExpirationMinutes?: number;
};

export const useCreateMetaTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: WhatsAppTemplateInput) => {
      const r = rec(
        await customFetch<unknown>(WHATSAPP_META_TEMPLATES_KEY, { method: "POST", body: JSON.stringify(input) }),
      );
      const row = isRecord(r.template) ? r.template : r;
      return readMetaTemplates({ templates: [row] }).templates[0] ?? null;
    },
    onSuccess: () => invalidateTemplates(queryClient),
  });
};

export type WhatsAppCreateMissingResult = {
  type: string;
  label: string;
  name: string | null;
  ok: boolean;
  status: string | null;
  error: string | null;
};

export function readWhatsAppCreateMissing(raw: unknown): WhatsAppCreateMissingResult[] {
  const r = rec(raw);
  const rows = Array.isArray(raw) ? raw : Array.isArray(r.results) ? r.results : Array.isArray(r.types) ? r.types : [];
  return rows
    .filter(isRecord)
    .map((x) => {
      const type = strOrNull(x.type) ?? strOrNull(x.messageType) ?? strOrNull(x.key) ?? "";
      const error = strOrNull(x.error) ?? strOrNull(x.message);
      return {
        type,
        label: strOrNull(x.label) ?? type,
        name: strOrNull(x.name) ?? strOrNull(x.templateName),
        ok: x.ok === true || (x.ok === undefined && !strOrNull(x.error)),
        status: strOrNull(x.status),
        error: x.ok === true ? null : error,
      };
    })
    .filter((x) => x.type !== "" || x.name !== null);
}

export const useCreateMissingMetaTemplates = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readWhatsAppCreateMissing(
        await customFetch<unknown>(`${WHATSAPP_META_TEMPLATES_KEY}/create-missing`, { method: "POST" }),
      ),
    onSuccess: () => invalidateTemplates(queryClient),
  });
};

export const useDeleteMetaTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<unknown>(`${WHATSAPP_META_TEMPLATES_KEY}/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateTemplates(queryClient),
  });
};

// ── The set-up check (Settings tab) ─────────────────────────────────────────────────────────────────────────────────

/** One environment variable of the set-up checklist. `required: false` = optional (a default is used when it is not
 *  set, e.g. WHATSAPP_CLOUD_API_VERSION); an older server that does not say counts every variable as required. */
export type WhatsAppEnvVar = { name: string; set: boolean; secret: boolean; required: boolean };

/** Meta's answer about the business phone number. */
export type WhatsAppPhoneInfo = {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  status: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  throughput: string | null;
  platformType: string | null;
};

export type WhatsAppConnection = {
  env: WhatsAppEnvVar[];
  configured: boolean;
  sendingAllowed: boolean;
  blockReasons: string[];
  /** null when Meta was not asked (keys missing) or did not answer. */
  phone: WhatsAppPhoneInfo | null;
  /** Meta accepted the access token; null when it was not tried. */
  tokenOk: boolean | null;
  error: string | null;
  apiVersion: string | null;
  webhook: { url: string; verifyTokenSet: boolean; appSecretSet: boolean; lastWebhookAt: string | null };
  /** The employee codes a development machine may message; null for no limit. */
  devLock: { onlyToEmployees: string[] | null };
};

const pick = (r: Record<string, unknown>, camel: string, snake: string): string | null =>
  strOrNull(r[camel]) ?? strOrNull(r[snake]);

function readPhone(raw: unknown): WhatsAppPhoneInfo | null {
  if (!isRecord(raw)) return null;
  const tp = raw.throughput;
  const info: WhatsAppPhoneInfo = {
    displayPhoneNumber: pick(raw, "displayPhoneNumber", "display_phone_number"),
    verifiedName: pick(raw, "verifiedName", "verified_name"),
    qualityRating: pick(raw, "qualityRating", "quality_rating"),
    messagingLimitTier: pick(raw, "messagingLimitTier", "messaging_limit_tier"),
    status: strOrNull(raw.status),
    nameStatus: pick(raw, "nameStatus", "name_status"),
    codeVerificationStatus: pick(raw, "codeVerificationStatus", "code_verification_status"),
    throughput: isRecord(tp) ? strOrNull(tp.level) : strOrNull(tp),
    platformType: pick(raw, "platformType", "platform_type"),
  };
  return Object.values(info).some((v) => v !== null) ? info : null;
}

export function readWhatsAppConnection(raw: unknown): WhatsAppConnection {
  const r = rec(raw);
  const w = rec(r.webhook);
  const lock = rec(r.devLock);
  return {
    env: (Array.isArray(r.env) ? r.env : [])
      .filter(isRecord)
      .filter((e) => typeof e.name === "string" && e.name !== "")
      .map((e) => ({
        name: e.name as string,
        set: e.set === true,
        secret: e.secret === true,
        required: e.required !== false,
      })),
    configured: r.configured === true,
    sendingAllowed: r.sendingAllowed === true,
    blockReasons: strList(r.blockReasons),
    phone: readPhone(r.phone),
    tokenOk: boolOrNull(r.tokenOk),
    error: strOrNull(r.error),
    apiVersion: strOrNull(r.apiVersion),
    webhook: {
      url: str(w.url),
      verifyTokenSet: w.verifyTokenSet === true,
      appSecretSet: w.appSecretSet === true,
      lastWebhookAt: strOrNull(w.lastWebhookAt),
    },
    devLock: { onlyToEmployees: codeList(lock.onlyToEmployees) },
  };
}

export const WHATSAPP_CONNECTION_KEY = `${BASE}/connection`;

/** The set-up check. It asks Meta live, so it is read when the tab opens and on "Check again", never polled. */
export const useWhatsAppConnection = (enabled = true) =>
  useQuery<WhatsAppConnection>({
    queryKey: [WHATSAPP_CONNECTION_KEY],
    queryFn: async () => readWhatsAppConnection(await customFetch<unknown>(WHATSAPP_CONNECTION_KEY)),
    enabled,
    staleTime: 0,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
  });

// ── Send a test ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   GET  test-message?search=   who may receive a test and the message types that can be tried
//   POST test-message           {documentType, employeeId, dryRun?}: with dryRun the template, its parameters and the
//                               rendered text only; without it the message is SENT AT ONCE (not queued) as its Meta
//                               template, and Meta's answer comes back (wamid, or an error code and sentence)

export type WhatsAppTestRecipient = {
  id: number;
  code: string;
  name: string;
  /** Masked: "••••9103". */
  phone: string | null;
  hasPhone: boolean;
  /** Why this machine may not message them (no phone, not an allowed employee), or null. */
  blockedReason: string | null;
};

export type WhatsAppTestType = {
  documentType: WhatsAppDocumentType;
  label: string;
  module: string;
  moduleLabel: string;
  kind: string;
  variables: { name: string; sample: string }[];
  /** The Meta template it goes out as, and that template's status here, when the server says. */
  templateName: string | null;
  templateStatus: string | null;
};

export type WhatsAppTestOptions = {
  /** Why nothing can be sent from this machine at all, or null. */
  blockReason: string | null;
  /** The employee codes this machine may message (then `recipients` is exactly them); null for no limit. */
  limitedTo: string[] | null;
  recipients: WhatsAppTestRecipient[];
  types: WhatsAppTestType[];
};

function readRecipient(raw: unknown): WhatsAppTestRecipient | null {
  if (!isRecord(raw) || typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    code: typeof raw.code === "string" ? raw.code : String(raw.code ?? ""),
    name: strOrNull(raw.name) ?? `Employee #${raw.id}`,
    phone: strOrNull(raw.phone),
    hasPhone: raw.hasPhone !== false && strOrNull(raw.phone) !== null,
    blockedReason: strOrNull(raw.blockedReason),
  };
}

export function readWhatsAppTestOptions(raw: unknown): WhatsAppTestOptions {
  const r = rec(raw);
  const types = (Array.isArray(r.types) ? r.types : [])
    .filter(isRecord)
    .filter((t) => typeof t.documentType === "string" && t.documentType !== "")
    .map((t) => {
      const key = t.documentType as string;
      const module = typeof t.module === "string" && t.module ? t.module : "other";
      return {
        documentType: key,
        label: strOrNull(t.label) ?? key,
        module,
        moduleLabel: strOrNull(t.moduleLabel) ?? module,
        kind: typeof t.kind === "string" ? t.kind : "",
        variables: (Array.isArray(t.variables) ? t.variables : [])
          .filter(isRecord)
          .map((v) => ({ name: String(v.name ?? ""), sample: String(v.sample ?? "") }))
          .filter((v) => v.name !== ""),
        // the server nests it: template {name, language, status, category, header}
        templateName: strOrNull(t.templateName) ?? strOrNull(t.template) ?? strOrNull(rec(t.template).name),
        templateStatus: strOrNull(t.templateStatus) ?? strOrNull(rec(t.template).status),
      };
    });
  return {
    blockReason: strOrNull(r.blockReason),
    limitedTo: codeList(r.limitedTo),
    recipients: (Array.isArray(r.recipients) ? r.recipients : [])
      .map(readRecipient)
      .filter((x): x is WhatsAppTestRecipient => x !== null),
    types,
  };
}

export const WHATSAPP_TEST_KEY = `${BASE}/test-message`;

/** Who may receive a test (on a limited machine exactly the allowed employees, else up to 20 matching `search`) and the
 *  message types that can be tried. */
export const useWhatsAppTestOptions = (search: string, enabled = true) => {
  const term = search.trim();
  return useQuery<WhatsAppTestOptions>({
    queryKey: [WHATSAPP_TEST_KEY, term],
    queryFn: async () =>
      readWhatsAppTestOptions(
        await customFetch<unknown>(term ? `${WHATSAPP_TEST_KEY}?${query({ search: term })}` : WHATSAPP_TEST_KEY),
      ),
    enabled,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
};

/** preview: a dry run (nothing sent). sent: Meta accepted it. failed: Meta refused it. blocked: this machine's rules held
 *  it back, or the type has no approved template (nothing reached Meta). */
export type WhatsAppTestStatus = "preview" | "sent" | "failed" | "blocked";

export type WhatsAppTestParam = { name: string; value: string };

export type WhatsAppTestResult = {
  status: WhatsAppTestStatus;
  documentType: string;
  /** Masked number. */
  to: string | null;
  employee: WhatsAppTestRecipient | null;
  /** The template's body with the parameters filled in. */
  text: string;
  templateName: string | null;
  language: string | null;
  /** The parameters sent with the template, in order. */
  params: WhatsAppTestParam[];
  /** "document" / "image" when a file travels in the header. */
  header: string | null;
  /** On a preview: why sending it would be held back, or null. */
  blockReason: string | null;
  /** The Messages log row of a real send. */
  logId: number | null;
  /** Meta's message id (wamid) of a real send. */
  providerMessageId: string | null;
  error: string | null;
  /** Meta's error code (190, 131026, 132001 ...). */
  errorCode: number | null;
  httpStatus: number | null;
  /** Meta's own answer (the server removes anything secret). */
  providerResponse: unknown;
  /** The random code a test of a one-time-code type sent (so HR can check it arrived), else null. */
  testCode: string | null;
};

export type WhatsAppTestInput = {
  documentType: string;
  employeeId: number;
  /** true: only the preview, nothing is sent. Left out: SENT AT ONCE. */
  dryRun?: true;
};

const TEST_STATUSES: readonly WhatsAppTestStatus[] = ["preview", "sent", "failed", "blocked"];

function readParams(v: unknown): WhatsAppTestParam[] {
  if (Array.isArray(v))
    return v
      .filter(isRecord)
      .map((p) => ({
        name: str(p.name ?? p.parameter_name ?? p.parameterName),
        value: String(p.value ?? p.text ?? ""),
      }))
      .filter((p) => p.name !== "" || p.value !== "");
  if (isRecord(v)) return Object.entries(v).map(([name, value]) => ({ name, value: String(value ?? "") }));
  return [];
}

/** Reads a test's answer; one that is none of the four (a newer server) shows as failed, with a sentence saying so. */
export function readWhatsAppTestResult(raw: unknown): WhatsAppTestResult {
  const r = rec(raw);
  const tpl = rec(r.template); // {name, language, status, category, header} on the server's answer
  const known = TEST_STATUSES.includes(r.status as WhatsAppTestStatus);
  const status = known ? (r.status as WhatsAppTestStatus) : "failed";
  return {
    status,
    documentType: str(r.documentType),
    to: strOrNull(r.to),
    employee: readRecipient(r.employee),
    text: str(r.text) || str(r.renderedText),
    templateName: strOrNull(r.templateName) ?? strOrNull(r.template) ?? strOrNull(tpl.name),
    language: strOrNull(r.language) ?? strOrNull(tpl.language),
    params: readParams(r.params ?? r.parameters),
    header: strOrNull(r.header) ?? strOrNull(tpl.header),
    blockReason: strOrNull(r.blockReason),
    logId: numOrNull(r.logId),
    providerMessageId: strOrNull(r.providerMessageId) ?? strOrNull(r.wamid),
    error: strOrNull(r.error) ?? (known ? null : "The server's answer was not understood."),
    errorCode: numOrNull(r.errorCode) ?? numOrNull(r.code),
    httpStatus: numOrNull(r.httpStatus),
    providerResponse: r.providerResponse ?? null,
    testCode: strOrNull(r.testCode),
  };
}

/** Previews (`dryRun: true`) or sends a test. A real send changes the Messages log, the overview and the queue. */
export const useWhatsAppTestMessage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: WhatsAppTestInput) =>
      readWhatsAppTestResult(
        await customFetch<unknown>(WHATSAPP_TEST_KEY, { method: "POST", body: JSON.stringify(input) }),
      ),
    onSuccess: (_result, input) => {
      if (input.dryRun) return;
      for (const key of [`${BASE}/messages`, WHATSAPP_OVERVIEW_KEY, WHATSAPP_QUEUE_KEY, WHATSAPP_USAGE_KEY])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
};
