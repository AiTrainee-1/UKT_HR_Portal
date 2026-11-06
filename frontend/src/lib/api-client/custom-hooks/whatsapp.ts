// whatsapp: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";
import { PayrollBreakdownResponse, PayrollRunItem } from "./payroll";

// ── WhatsApp (Settings, single-send mutations, bulk-send progress) ─────────

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

export type WhatsAppStatus = { configured: boolean; instanceId: string | null };

export const useWhatsAppStatus = () =>
  useQuery<WhatsAppStatus>({
    queryKey: ["/api/whatsapp/status"],
    queryFn: () => customFetch<WhatsAppStatus>("/api/whatsapp/status"),
  });

export type WhatsAppTemplate = {
  documentType: WhatsAppDocumentType;
  /** HR's own wording; empty means the built-in default is sent. */
  messageBody: string;
  defaultMessage: string;
  /** What each {{n}} placeholder is filled with for this document type. */
  placeholders: string;
  isEnabled: boolean;
};

export const useWhatsAppTemplates = () =>
  useQuery<WhatsAppTemplate[]>({
    queryKey: ["/api/whatsapp/templates"],
    queryFn: () => customFetch<WhatsAppTemplate[]>("/api/whatsapp/templates"),
  });

export const useUpdateWhatsAppTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ documentType, data }: { documentType: WhatsAppDocumentType; data: Partial<WhatsAppTemplate> }) =>
      customFetch<WhatsAppTemplate>(`/api/whatsapp/templates/${documentType}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/templates"] }),
  });
};

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

/** The statuses every overview count carries. */
export type WhatsAppDeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";
/** The sending queue's statuses: waiting its turn, being sent, too late to be useful (never sent), blocked by a rule. */
export type WhatsAppQueueMessageStatus = "queued" | "sending" | "expired" | "skipped";
export type WhatsAppMessageStatus = WhatsAppDeliveryStatus | WhatsAppQueueMessageStatus;
/** Why a message was sent: a one-time login code, something the employee asked for, an automatic alert, a document. */
export type WhatsAppMessageKind = "code" | "requested" | "automatic" | "document";
/** A module key from the server's catalog: documents, otp, attendance, approvals, geo, visitors, outpass, other. */
export type WhatsAppCategory = string;

export type WhatsAppCounts = Record<WhatsAppDeliveryStatus, number> &
  Partial<Record<WhatsAppQueueMessageStatus, number>> & { total: number; accepted: number };

export type WhatsAppConfig = {
  provider: string;
  configured: boolean;
  instanceId: string | null;
  apiUrl: string;
  defaultCountryCode: string;
  sendDelaySeconds: number;
  publicBaseUrl: string;
  webhookUrl: string;
  webhookTokenSet: boolean;
  /** Approval, visitor and gate messages are delivered by a background worker. */
  backgroundSending: boolean;
};

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
  /** When WhatsApp accepted it; null while it waits or when it was never sent. */
  sentAt?: string | null;
  /** After this it is too late to be useful, and it expires instead of going out. */
  expiresAt?: string | null;
  attempts?: number;
};

export type WhatsAppOverview = {
  days: number;
  config: WhatsAppConfig;
  totals: WhatsAppCounts;
  /** Today's and this month's counts, whatever the selected range. */
  today: WhatsAppCounts;
  thisMonth: WhatsAppCounts;
  categories: { key: WhatsAppCategory; label: string }[];
  /** The HRMS workflows a message can come from (Leave, On-Duty request, ...), for the Workflow filter. */
  relatedModules: { key: string; label: string }[];
  byCategory: Record<WhatsAppCategory, WhatsAppCounts>;
  byType: {
    documentType: WhatsAppDocumentType;
    label: string;
    category: WhatsAppCategory;
    total: number;
    failed: number;
  }[];
  daily: { date: string; total: number; failed: number }[];
  recentFailures: WhatsAppMessage[];
  stalePending: number;
};

export const useWhatsAppOverview = (days: number) =>
  useQuery<WhatsAppOverview>({
    queryKey: ["/api/whatsapp-control/overview", days],
    queryFn: () => customFetch<WhatsAppOverview>(`/api/whatsapp-control/overview?days=${days}`),
    refetchInterval: 30_000,
  });

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

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return qs.toString();
}

export const useWhatsAppMessages = (filters: WhatsAppMessageFilters, enabled = true) =>
  useQuery<Paged<WhatsAppMessage>>({
    queryKey: ["/api/whatsapp-control/messages", filters],
    queryFn: () => customFetch<Paged<WhatsAppMessage>>(`/api/whatsapp-control/messages?${query(filters)}`),
    enabled,
    refetchInterval: 30_000,
  });

export type WhatsAppEmployeeRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  phone: string;
  department: string | null;
  total: number;
  failed: number;
  lastMessageAt: string | null;
  /** The employee asked for no WhatsApp messages ("No WhatsApp"). */
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

const WHATSAPP_EMPLOYEES_KEY = "/api/whatsapp-control/employees";

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
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-control/queue"] });
    },
  });
};

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
  groups: WhatsAppFeatureGroup[];
  /** The module and workflow switches, plus one `type:<document_type>` switch per message type that has no other. */
  features: WhatsAppFeature[];
  timings: WhatsAppTiming[];
  queueLimits: WhatsAppQueueLimit[];
  quietHours: WhatsAppQuietHours;
  config: WhatsAppConfig;
  updatedAt: string | null;
};
/** A PUT carries only what changed: a feature key, a timing or queue limit, engineEnabled, or (part of) quietHours. */
export type WhatsAppControlSettingsUpdate = Record<string, boolean | number | Partial<WhatsAppQuietHours>>;

export const useWhatsAppControlSettings = () =>
  useQuery<WhatsAppControlSettings>({
    queryKey: ["/api/whatsapp-control/settings"],
    queryFn: () => customFetch<WhatsAppControlSettings>("/api/whatsapp-control/settings"),
  });

export const useUpdateWhatsAppControlSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: WhatsAppControlSettingsUpdate) =>
      customFetch<WhatsAppControlSettings>("/api/whatsapp-control/settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/whatsapp-control/settings"], data);
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-control/templates"] });
      // The engine switch, the limits and quiet hours all change what the queue reports.
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-control/queue"] });
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Reads the queue's answer with a safe value for anything missing, so a partial answer can't break the page. */
export function readWhatsAppQueue(raw: unknown): WhatsAppQueue {
  const r = isRecord(raw) ? raw : {};
  const limits = isRecord(r.limits) ? r.limits : {};
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

const WHATSAPP_QUEUE_KEY = "/api/whatsapp-control/queue";

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
      queryClient.invalidateQueries({ queryKey: [WHATSAPP_QUEUE_KEY] });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-control/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-control/overview"] });
    },
  });
};

/** The server's own sentence for a refused request ("Max per hour must be between 1 and 500."), else `fallback`. */
export function whatsAppErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const data = err.data;
    if (isRecord(data)) {
      for (const field of ["error", "message", "detail"]) {
        const sentence = data[field];
        if (typeof sentence === "string" && sentence.trim()) return sentence.trim();
      }
    }
    return fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export type WhatsAppTemplateVariable = { name: string; help: string; sample: string };

export type WhatsAppControlTemplate = {
  documentType: WhatsAppDocumentType;
  label: string;
  description: string;
  category: WhatsAppCategory;
  categoryLabel: string;
  /** False for messages with no text to word (a contact card). */
  hasWording: boolean;
  messageBody: string;
  defaultMessage: string;
  placeholders: string;
  variables: WhatsAppTemplateVariable[];
  /** The current wording rendered with sample values. */
  preview: string;
  isEnabled: boolean;
  /** This message's own switch (Feature Controls); null when it has none. */
  featureEnabled: boolean | null;
  /** The switch for the message's whole module; null when the module has none. */
  moduleEnabled: boolean | null;
  customised: boolean;
  updatedAt: string | null;
  total: number;
  failed: number;
  lastSentAt: string | null;
};

export const useWhatsAppControlTemplates = () =>
  useQuery<WhatsAppControlTemplate[]>({
    queryKey: ["/api/whatsapp-control/templates"],
    queryFn: () => customFetch<WhatsAppControlTemplate[]>("/api/whatsapp-control/templates"),
  });

export const useUpdateWhatsAppControlTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      documentType,
      data,
    }: {
      documentType: WhatsAppDocumentType;
      data: { messageBody?: string; isEnabled?: boolean };
    }) =>
      customFetch<WhatsAppControlTemplate>(`/api/whatsapp-control/templates/${documentType}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-control/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/templates"] });
    },
  });
};

/** Renders unsaved wording with sample values, so HR sees how a message will look. */
export const useWhatsAppTemplatePreview = () =>
  useMutation({
    mutationFn: ({ documentType, messageBody }: { documentType: WhatsAppDocumentType; messageBody: string }) =>
      customFetch<{ preview: string; error: string | null }>(
        `/api/whatsapp-control/templates/${documentType}/preview`,
        { method: "POST", body: JSON.stringify({ messageBody }) },
      ),
  });
