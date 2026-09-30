// gmail: hooks/types for the Gmail Control page (/hr/gmail-control), see ./index.ts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { Paged } from "./whatsapp";

// ── Gmail Control page (/hr/gmail-control) ─────────────────────────────────

/** sent: the mail server accepted it · failed: an attempt that could not complete · blocked: deliberately not attempted. */
export type GmailMessageStatus = "sent" | "failed" | "blocked";
/** A module key from the server's catalog: documents, visitors, recruitment, other. */
export type GmailCategory = string;
/** An email type key from the server's catalog (salary_slip, offer_letter, ...). */
export type GmailEmailType = string;

export type GmailCounts = Record<GmailMessageStatus, number> & { total: number };

export type GmailConfig = {
  provider: string;
  isGmail: boolean;
  /** Host, user and app password are all saved in Settings. */
  smtpConfigured: boolean;
  /** SMTP is set up AND this machine is allowed to send. */
  configured: boolean;
  /** Why nothing can be sent from this server, or null. */
  sendingBlockedReason: string | null;
  sendingAllowedHere: boolean;
  host: string;
  port: number;
  security: string;
  /** The login, partly hidden (ab•••@gmail.com). */
  username: string;
  /** Whether an app password is saved. The password itself is never sent to the browser. */
  passwordSet: boolean;
  fromEmail: string;
  fromName: string;
  companyName: string;
  sentToday: number;
  /** 0 = no limit. */
  dailyLimit: number;
  gmailLimits: { regular: number; workspace: number };
  settingsPath: string;
};

export type GmailMessage = {
  id: number;
  employeeId: number | null;
  employeeCode: string | null;
  recipientName: string;
  recipientEmail: string;
  emailType: GmailEmailType;
  typeLabel: string;
  category: GmailCategory;
  categoryLabel: string;
  relatedModule: string;
  subject: string;
  status: GmailMessageStatus;
  error: string;
  /** The wording that went out, as plain text. */
  messageText: string;
  attachmentName: string;
  referenceId: number | null;
  sentBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type GmailOverview = {
  days: number;
  config: GmailConfig;
  totals: GmailCounts;
  /** Today's and this month's counts, whatever the selected range. */
  today: GmailCounts;
  thisMonth: GmailCounts;
  categories: { key: GmailCategory; label: string }[];
  byCategory: Record<GmailCategory, GmailCounts>;
  byType: { emailType: GmailEmailType; label: string; category: GmailCategory; total: number; failed: number }[];
  daily: { date: string; total: number; failed: number }[];
  recentFailures: GmailMessage[];
};

export const useGmailOverview = (days: number) =>
  useQuery<GmailOverview>({
    queryKey: ["/api/gmail-control/overview", days],
    queryFn: () => customFetch<GmailOverview>(`/api/gmail-control/overview?days=${days}`),
    refetchInterval: 30_000,
  });

export type GmailMessageFilters = {
  status?: GmailMessageStatus | "";
  category?: GmailCategory | "";
  type?: GmailEmailType;
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

export const useGmailMessages = (filters: GmailMessageFilters, enabled = true) =>
  useQuery<Paged<GmailMessage>>({
    queryKey: ["/api/gmail-control/messages", filters],
    queryFn: () => customFetch<Paged<GmailMessage>>(`/api/gmail-control/messages?${query(filters)}`),
    enabled,
    refetchInterval: 30_000,
  });

export type GmailEmployeeRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  email: string;
  department: string | null;
  total: number;
  failed: number;
  lastEmailAt: string | null;
};

export const useGmailEmployees = (params: { search?: string; page: number; pageSize: number }) =>
  useQuery<Paged<GmailEmployeeRow>>({
    queryKey: ["/api/gmail-control/employees", params],
    queryFn: () => customFetch<Paged<GmailEmployeeRow>>(`/api/gmail-control/employees?${query(params)}`),
  });

export type GmailFeature = { key: string; label: string; description: string; group: string; enabled: boolean };
export type GmailFeatureGroup = { key: string; title: string; blurb: string };
export type GmailSetting = { key: string; label: string; value: number; min: number; max: number };
export type GmailControlSettings = {
  groups: GmailFeatureGroup[];
  features: GmailFeature[];
  timings: GmailSetting[];
  config: GmailConfig;
  updatedAt: string | null;
};

export const useGmailControlSettings = () =>
  useQuery<GmailControlSettings>({
    queryKey: ["/api/gmail-control/settings"],
    queryFn: () => customFetch<GmailControlSettings>("/api/gmail-control/settings"),
  });

export const useUpdateGmailControlSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, boolean | number>) =>
      customFetch<GmailControlSettings>("/api/gmail-control/settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/gmail-control/settings"], data);
      queryClient.invalidateQueries({ queryKey: ["/api/gmail-control/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/gmail-control/overview"] });
    },
  });
};

export type GmailTemplateVariable = { name: string; help: string; sample: string };

export type GmailControlTemplate = {
  emailType: GmailEmailType;
  label: string;
  description: string;
  category: GmailCategory;
  categoryLabel: string;
  /** What is attached ("Salary slip (PDF)"), or "" for nothing. */
  attachment: string;
  /** HR's own subject and wording; empty means the default is sent. */
  subject: string;
  messageBody: string;
  defaultSubject: string;
  defaultMessage: string;
  placeholders: string;
  variables: GmailTemplateVariable[];
  /** The fixed table under the wording (label -> variable); empty when this email has none. */
  details: { label: string; variable: string }[];
  /** The current subject, wording and full email rendered with sample values. */
  previewSubject: string;
  preview: string;
  previewHtml: string;
  isEnabled: boolean;
  /** The switch for the email's whole module; null when the module has none. */
  moduleEnabled: boolean | null;
  customised: boolean;
  updatedAt: string | null;
  total: number;
  failed: number;
  lastSentAt: string | null;
};

export const useGmailControlTemplates = () =>
  useQuery<GmailControlTemplate[]>({
    queryKey: ["/api/gmail-control/templates"],
    queryFn: () => customFetch<GmailControlTemplate[]>("/api/gmail-control/templates"),
  });

export const useUpdateGmailControlTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      emailType,
      data,
    }: {
      emailType: GmailEmailType;
      data: { subject?: string; messageBody?: string; isEnabled?: boolean };
    }) =>
      customFetch<GmailControlTemplate>(`/api/gmail-control/templates/${emailType}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/gmail-control/templates"] }),
  });
};

export type GmailTemplatePreview = { subject: string; preview: string; previewHtml: string; error: string | null };

/** Renders unsaved subject and wording with sample values, so HR sees how the email will look. */
export const useGmailTemplatePreview = () =>
  useMutation({
    mutationFn: ({
      emailType,
      subject,
      messageBody,
    }: {
      emailType: GmailEmailType;
      subject: string;
      messageBody: string;
    }) =>
      customFetch<GmailTemplatePreview>(`/api/gmail-control/templates/${emailType}/preview`, {
        method: "POST",
        body: JSON.stringify({ subject, messageBody }),
      }),
  });

export type GmailTestResult = {
  ok: boolean;
  status: GmailMessageStatus;
  error: string;
  sentTo: string;
  message: GmailMessage;
};

/** Sends the test email. A test that could not go out is still a normal answer: `ok` is false and `error` says why. */
export const useGmailTestEmail = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (toEmail: string) =>
      customFetch<GmailTestResult>("/api/gmail-control/test-email", {
        method: "POST",
        body: JSON.stringify({ toEmail }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/gmail-control/overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/gmail-control/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/gmail-control/employees"] });
    },
  });
};
