// Phone Notify Control (HR portal -> /hr/phone-notify-control; until 2026-11-17 the Mobile Messages tab of Mobile App Login):
// every phone (push) notification the HRMS sends. Backend: api/mobile_messages_views.py (the URL prefix is kept on purpose).
// The switches only control the phone push; the in-app record is always saved.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { Paged } from "./whatsapp";

const BASE = "/api/mobile-app/messages";

/**
 * "sent" = Expo took it, the push service has not confirmed yet; "delivered" = Google/Apple accepted it for the phone;
 * "sending" = it is being handed to Expo right now (2026-11-17: pushes go out after the save, from a queue). A row with
 * no status ("") is waiting for its turn (or was saved before phone notifications existed).
 */
export type PushStatus = "sent" | "delivered" | "no_device" | "failed" | "off" | "sending";

/** `sent` counts every push that went out (the delivered ones included); `delivered` is the part the phone confirmed. */
export type PushCounts = {
  total: number;
  sent: number;
  /** Older servers leave it out. */
  delivered?: number;
  noDevice: number;
  failed: number;
  off: number;
};

export type MobileMessagesOverview = {
  pushEnabled: boolean;
  /** How many kinds of message HR has switched off for phones. */
  switchedOff: number;
  /** How many kinds can be switched (older servers leave it out). */
  kinds?: number;
  /** Employees muted for phone notifications (older servers leave it out). */
  muted?: number;
  devices: {
    employees: number;
    withDevice: number;
    withoutDevice: number;
    tokens: number;
    lastRegisteredAt: string | null;
  };
  today: PushCounts;
  week: PushCounts;
  month: PushCounts;
  /** Share of the last 30 days' notifications the employee has opened; null with none. */
  readRate: number | null;
  byKind: { label: string; count: number }[];
  byDay: { date: string; total: number; sent: number }[];
  /** Every category of notification, in display order (2026-11-17; older servers leave it out). */
  categories?: PushCategory[];
  /** Up to 5 pushes that failed in the last 7 days, newest first (2026-11-17; older servers leave it out). */
  failedRecent?: MobileMessageRow[];
  /** Who receives phone notifications at all (the Settings tab; 2026-11-17, older servers leave it out). */
  recipients?: RecipientsLine;
};

// ── who receives phone notifications (the Settings tab) ───────────────────────

/**
 * Who the automatic senders push to at all: every active employee, staff only, production only, or only the employees on
 * the selected list. Anyone left out gets no push and no notification record (their requests, payslips and chat still
 * work). A message HR sends from the Send tab still goes to whoever HR picks.
 */
export type RecipientMode = "all" | "staff" | "production" | "selected";

/** One of the four choices, with how many active employees it reaches in the viewer's branches, and how many have a phone. */
export type RecipientModeOption = {
  key: RecipientMode;
  label: string;
  description: string;
  employees: number;
  withPhone: number;
};

export type PushRecipients = {
  mode: RecipientMode;
  /** The current mode's name (the server sends it too; the page also reads it from `modes`). */
  modeLabel?: string;
  /** The four choices, in display order. */
  modes: RecipientModeOption[];
  /** Employees on the selected list. */
  selected: number;
  selectedWithPhone: number;
  /** Active employees who receive under the current mode. */
  receiving: number;
  receivingWithPhone: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** A change to the selected list answers with the settings and how many employees it really changed. */
export type RecipientChangeResult = PushRecipients & { changed: number };

/** The current mode as the Overview shows it. */
export type RecipientsLine = {
  mode: RecipientMode;
  modeLabel: string;
  receiving: number;
  receivingWithPhone: number;
};

/** An active employee in the selected-list picker. */
export type RecipientEmployee = {
  id: number;
  name: string;
  code: string;
  employmentType: "staff" | "production";
  department: string | null;
  branch: string | null;
  hasPhone: boolean;
  /** On the selected list. */
  selected: boolean;
};

/** What "every employee matching" means for the bulk changes: the same filters as the list (empty ones left out). */
export type RecipientMatch = {
  search?: string;
  type?: "staff" | "production";
  branch?: number;
  department?: number;
};

export type RecipientEmployeeParams = RecipientMatch & {
  /** "1": only the ones on the list; "0": only the ones not on it. */
  selected?: "1" | "0";
  page: number;
  pageSize: number;
};

/** Exactly one change to the selected list. */
export type RecipientChange =
  | { add: number[] }
  | { remove: number[] }
  | { addMatching: RecipientMatch }
  | { removeMatching: RecipientMatch }
  | { clear: true };

/**
 * A category of notification (Leave, Attendance alerts, Internal chat ...): the switches in it (the same keys as the
 * Controls rows), how many are on, who receives it, and its last 30 days. Every switch, and every notification, is in
 * exactly one category.
 */
export type PushCategory = {
  key: string;
  label: string;
  description: string;
  keys: string[];
  /** How many switches it has. */
  total: number;
  /** How many of them are on. */
  on: number;
  audience: PushAudience[];
  month: PushKindStats;
};

/** Who receives a kind of notification. */
export type PushAudience = "employee" | "approver" | "hr";

/** "whatsapp": the same message also goes by WhatsApp; "app": a phone / in-app notification only. */
export type PushOrigin = "whatsapp" | "app";

/** The last 30 days of one kind (a workflow row: the messages of that workflow). */
export type PushKindStats = {
  total: number;
  sent: number;
  delivered: number;
  failed: number;
  off: number;
  noDevice: number;
};

export type MobileMessageControl = {
  key: string;
  label: string;
  description: string;
  group: string;
  groupLabel: string;
  kind: "message" | "workflow";
  enabled: boolean;
  /** Where in the HRMS it is sent from, one line. */
  sentFrom?: string;
  audience?: PushAudience;
  origin?: PushOrigin;
  stats?: PushKindStats;
  /** The category it belongs to (PushCategory.key) and its name (2026-11-17; older servers leave them out). */
  category?: string;
  categoryLabel?: string;
};

export type MobileMessageControls = {
  pushEnabled: boolean;
  controls: MobileMessageControl[];
  updatedBy: string | null;
  updatedAt: string | null;
};

export type MobileMessageRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  title: string;
  message: string;
  type: string;
  kind: string;
  source: string;
  pushStatus: PushStatus | "";
  pushStatusLabel: string;
  pushError: string | null;
  isRead: boolean;
  createdAt: string;
  pushedAt: string | null;
  /** It failed, found no phone or was switched off: it can be pushed again. */
  canPushAgain?: boolean;
  /** The category it is counted in (PushCategory.key; older servers leave it out). */
  category?: string;
};

export type MobileMessageFilters = {
  search?: string;
  status?: PushStatus | "";
  kind?: string;
  read?: "read" | "unread" | "";
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
};

/** One phone registered for notifications. */
export type MobilePhone = {
  id: number;
  platform: string;
  registeredAt: string | null;
  updatedAt: string | null;
};

export type MobileDeviceRow = {
  id: number;
  name: string;
  employeeCode: string;
  employmentType: string;
  phone: string | null;
  devices: number;
  lastRegisteredAt: string | null;
  /** Muted: no phone notification reaches them (their in-app list still fills). */
  muted?: boolean;
  mutedBy?: string | null;
  mutedAt?: string | null;
  phones?: MobilePhone[];
  /** False: left out by the Settings tab (who receives phone notifications). Older servers leave it out. */
  isRecipient?: boolean;
};

export type MobileDeviceParams = {
  search?: string;
  has?: "with" | "without" | "";
  /** Only the muted employees. */
  muted?: boolean;
  page: number;
  pageSize: number;
};

export type PushHealthState = "ok" | "warning" | "problem" | "unknown";

export type PushFailureReason = { reason: string; label: string; count: number; advice: string };

/** How a push travels and how well it has been doing (the last 30 days). There are no secrets in it. */
export type PushConfig = {
  service: {
    provider: string;
    transport: string;
    url: string;
    androidChannel: string;
    appPackage: string;
  };
  health: {
    state: PushHealthState;
    note: string;
    lastSentAt: string | null;
    lastDeliveredAt: string | null;
    sent30: number;
    delivered30: number;
    failed30: number;
    failureReasons: PushFailureReason[];
  };
  phones: { employeesWithPhone: number; tokens: number; lastRegisteredAt: string | null };
  pushEnabled: boolean;
};

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return qs.toString();
}

export const useMobileMessagesOverview = () =>
  useQuery<MobileMessagesOverview>({
    queryKey: [BASE, "overview"],
    queryFn: () => customFetch<MobileMessagesOverview>(`${BASE}/overview`),
    refetchInterval: 30_000,
  });

/** `enabled: false` asks nothing (the Overview reads the switches only while the role may open Controls). */
export const useMobileMessageControls = (enabled = true) =>
  useQuery<MobileMessageControls>({
    queryKey: [BASE, "controls"],
    queryFn: () => customFetch<MobileMessageControls>(`${BASE}/controls`),
    enabled,
  });

export const useUpdateMobileMessageControls = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { pushEnabled?: boolean; types?: Record<string, boolean> }) =>
      customFetch<MobileMessageControls>(`${BASE}/controls`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: (data) => {
      queryClient.setQueryData([BASE, "controls"], data);
      queryClient.invalidateQueries({ queryKey: [BASE, "overview"] });
      queryClient.invalidateQueries({ queryKey: [BASE, "config"] });
    },
  });
};

export const useMobileMessageLog = (filters: MobileMessageFilters) =>
  useQuery<Paged<MobileMessageRow>>({
    queryKey: [BASE, "log", filters],
    queryFn: () => customFetch<Paged<MobileMessageRow>>(`${BASE}/log?${query(filters)}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

export const useMobileDevices = (params: MobileDeviceParams) =>
  useQuery<Paged<MobileDeviceRow>>({
    queryKey: [BASE, "devices", params],
    queryFn: () =>
      customFetch<Paged<MobileDeviceRow>>(
        `${BASE}/devices?${query({ ...params, muted: params.muted ? "1" : undefined })}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useSendMobileMessage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { employeeId: number; title: string; message: string }) =>
      customFetch<MobileMessageRow>(`${BASE}/send`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [BASE] }),
  });
};

/** Push one notification to its employee's phones again (only one that failed, found no phone or was switched off). */
export const usePushMobileMessageAgain = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<MobileMessageRow>(`${BASE}/log/${id}/push-again`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [BASE] }),
  });
};

/** Mute (or unmute) every phone notification of one employee. */
export const useMuteMobileEmployee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { employeeId: number; muted: boolean }) =>
      customFetch<MobileDeviceRow>(`${BASE}/devices/${data.employeeId}/mute`, {
        method: "PUT",
        body: JSON.stringify({ muted: data.muted }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [BASE] }),
  });
};

/** Forget one registered phone (the app registers again the next time it is opened on it). */
export const useRemoveMobilePhone = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (phoneId: number) => customFetch<void>(`${BASE}/devices/phones/${phoneId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [BASE] }),
  });
};

/** `enabled: false` asks nothing (the Overview reads the health only while the role may open Configuration). */
export const useMobileMessagesConfig = (enabled = true) =>
  useQuery<PushConfig>({
    queryKey: [BASE, "config"],
    queryFn: () => customFetch<PushConfig>(`${BASE}/config`),
    refetchInterval: 60_000,
    enabled,
  });

// ── who receives phone notifications (the Settings tab) ───────────────────────

const RECIPIENTS_KEY = [BASE, "recipients"] as const;
const RECIPIENT_EMPLOYEES_KEY = [BASE, "recipients", "employees"] as const;

/** After a change: the Overview's line and the Employees tab's "Not a recipient" follow it. */
function afterRecipientChange(queryClient: ReturnType<typeof useQueryClient>, data: PushRecipients) {
  const { changed: _changed, ...settings } = data as RecipientChangeResult;
  queryClient.setQueryData(RECIPIENTS_KEY, settings);
  queryClient.invalidateQueries({ queryKey: [BASE, "overview"] });
  queryClient.invalidateQueries({ queryKey: [BASE, "devices"] });
}

/** The mode and its four choices with their counts. */
export const useRecipients = (enabled = true) =>
  useQuery<PushRecipients>({
    queryKey: RECIPIENTS_KEY,
    queryFn: () => customFetch<PushRecipients>(`${BASE}/recipients`),
    enabled,
  });

/** Choose who receives phone notifications. The server refuses "selected" while the selected list is empty. */
export const useSetRecipientMode = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: RecipientMode) =>
      customFetch<PushRecipients>(`${BASE}/recipients`, { method: "PUT", body: JSON.stringify({ mode }) }),
    onSuccess: (data) => afterRecipientChange(queryClient, data),
  });
};

/** One page of the active employees, each saying whether it is on the selected list. */
export const useRecipientEmployees = (params: RecipientEmployeeParams) =>
  useQuery<Paged<RecipientEmployee>>({
    queryKey: [...RECIPIENT_EMPLOYEES_KEY, params],
    queryFn: () => customFetch<Paged<RecipientEmployee>>(`${BASE}/recipients/employees?${query(params)}`),
    placeholderData: keepPreviousData,
  });

type EmployeePages = [readonly unknown[], Paged<RecipientEmployee> | undefined][];

/**
 * Change the selected list. Adding or removing named employees ticks their rows at once (put back if the server refuses);
 * every change asks the list again afterwards, and the settings, the Overview and the Employees tab follow.
 */
export const useChangeRecipients = () => {
  const queryClient = useQueryClient();
  return useMutation<RecipientChangeResult, Error, RecipientChange, { before: EmployeePages }>({
    mutationFn: (change) =>
      customFetch<RecipientChangeResult>(`${BASE}/recipients/employees`, {
        method: "POST",
        body: JSON.stringify(change),
      }),
    onMutate: async (change) => {
      const ids = "add" in change ? change.add : "remove" in change ? change.remove : null;
      if (!ids) return { before: [] };
      await queryClient.cancelQueries({ queryKey: RECIPIENT_EMPLOYEES_KEY });
      const before = queryClient.getQueriesData<Paged<RecipientEmployee>>({ queryKey: RECIPIENT_EMPLOYEES_KEY });
      const on = "add" in change;
      const picked = new Set(ids);
      queryClient.setQueriesData<Paged<RecipientEmployee>>({ queryKey: RECIPIENT_EMPLOYEES_KEY }, (page) =>
        page ? { ...page, items: page.items.map((e) => (picked.has(e.id) ? { ...e, selected: on } : e)) } : page,
      );
      return { before };
    },
    onError: (_error, _change, context) => {
      for (const [key, page] of context?.before ?? []) queryClient.setQueryData(key, page);
    },
    onSuccess: (data) => afterRecipientChange(queryClient, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: RECIPIENT_EMPLOYEES_KEY }),
  });
};

// ── the wording of each kind of notification (the Message Text tab) ───────────

/** A placeholder a wording may use: `{{name}}`, what it stands for, and the value the preview fills in. */
export type PushTemplateVariable = { name: string; help: string; sample: string };

/**
 * One kind of automatic notification and its wording. `title` / `body` are HR's own ("" = the built-in one); the built-in
 * wording has the same {{placeholders}}. A kind that also goes by WhatsApp (`origin: "whatsapp"`) shows WhatsApp's wording
 * on the phone until a phone version is saved; an app-only kind can use {{headline}} and {{message}} (its built-in title and
 * sentence). The counts are all-time, for that kind.
 */
export type PushTemplate = {
  key: string;
  label: string;
  description: string;
  group: string;
  groupLabel: string;
  category: string;
  categoryLabel: string;
  origin: PushOrigin;
  /** The kind's switch on the Controls tab. */
  enabled: boolean;
  variables: PushTemplateVariable[];
  title: string;
  body: string;
  defaultTitle: string;
  defaultBody: string;
  /** One sentence on what the built-in wording is. */
  defaultNote: string;
  customised: boolean;
  /** What is sent now, filled with the sample values. */
  preview: { title: string; body: string };
  updatedBy: string | null;
  updatedAt: string | null;
  total: number;
  sent: number;
  failed: number;
  lastSentAt: string | null;
};

/** A wording filled with the sample values; `error` says what is wrong with it (an unknown placeholder, too long ...). */
export type PushTemplatePreview = { title: string; body: string; error: string | null };

const TEMPLATES_KEY = [BASE, "templates"] as const;

/** Every kind of automatic notification with its wording, in the Controls order. */
export const usePushTemplates = (enabled = true) =>
  useQuery<PushTemplate[]>({
    queryKey: TEMPLATES_KEY,
    queryFn: () => customFetch<PushTemplate[]>(`${BASE}/templates`),
    enabled,
  });

/** Save a kind's title and message. Both blank: back to the built-in wording; one blank: that part stays built in. */
export const useSavePushTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { key: string; title: string; body: string }) =>
      customFetch<PushTemplate>(`${BASE}/templates/${encodeURIComponent(data.key)}`, {
        method: "PUT",
        body: JSON.stringify({ title: data.title, body: data.body }),
      }),
    onSuccess: (row) => {
      queryClient.setQueryData<PushTemplate[]>(TEMPLATES_KEY, (rows) =>
        rows?.map((r) => (r.key === row.key ? row : r)),
      );
      queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
    },
  });
};

/** A wording as it would read, filled with the sample values (blank parts: the built-in wording). Nothing is saved. */
export const usePreviewPushTemplate = () =>
  useMutation({
    mutationFn: (data: { key: string; title: string; body: string }) =>
      customFetch<PushTemplatePreview>(`${BASE}/templates/${encodeURIComponent(data.key)}/preview`, {
        method: "POST",
        body: JSON.stringify({ title: data.title, body: data.body }),
      }),
  });
