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
  | "visitor_notification";

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
