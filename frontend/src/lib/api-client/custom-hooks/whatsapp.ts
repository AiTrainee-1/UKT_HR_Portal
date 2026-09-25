// whatsapp: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
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
    refetchInterval: enabled ? 600 : false,
    staleTime: 0,
  });

export type WhatsAppBulkResult = { ok: boolean; sent: number; failed: number; failures: WhatsAppBulkFailure[] };

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

export type WhatsAppMessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";
/** A module key from the server's catalog: documents, otp, attendance, approvals, geo, visitors, outpass, other. */
export type WhatsAppCategory = string;

export type WhatsAppCounts = Record<WhatsAppMessageStatus, number> & { total: number; accepted: number };

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
  employeePortalUrl: string;
  /** Approval, visitor and gate messages are delivered by a background worker. */
  backgroundSending: boolean;
  linkPreview: boolean;
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
  error: string;
  messageText: string;
  providerMessageId: string;
  referenceId: number | null;
  sentBy: string | null;
  automatic: boolean;
  createdAt: string | null;
  updatedAt: string | null;
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
};

export const useWhatsAppEmployees = (params: { search?: string; page: number; pageSize: number }) =>
  useQuery<Paged<WhatsAppEmployeeRow>>({
    queryKey: ["/api/whatsapp-control/employees", params],
    queryFn: () => customFetch<Paged<WhatsAppEmployeeRow>>(`/api/whatsapp-control/employees?${query(params)}`),
  });

export type WhatsAppFeature = { key: string; label: string; description: string; group: string; enabled: boolean };
export type WhatsAppFeatureGroup = { key: string; title: string; blurb: string };
export type WhatsAppTiming = { key: string; label: string; value: number; min: number; max: number };
export type WhatsAppControlSettings = {
  groups: WhatsAppFeatureGroup[];
  features: WhatsAppFeature[];
  timings: WhatsAppTiming[];
  config: WhatsAppConfig;
  updatedAt: string | null;
};

export const useWhatsAppControlSettings = () =>
  useQuery<WhatsAppControlSettings>({
    queryKey: ["/api/whatsapp-control/settings"],
    queryFn: () => customFetch<WhatsAppControlSettings>("/api/whatsapp-control/settings"),
  });

export const useUpdateWhatsAppControlSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, boolean | number>) =>
      customFetch<WhatsAppControlSettings>("/api/whatsapp-control/settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/whatsapp-control/settings"], data);
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-control/templates"] });
    },
  });
};

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
