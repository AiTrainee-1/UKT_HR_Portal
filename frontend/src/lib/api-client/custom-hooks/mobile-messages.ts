// Phone Notify Control (HR portal -> /hr/phone-notify-control; until 2026-11-17 the Mobile Messages tab of Mobile App Login):
// every phone (push) notification the HRMS sends. Backend: api/mobile_messages_views.py (the URL prefix is kept on purpose).
// The switches only control the phone push; the in-app record is always saved.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { Paged } from "./whatsapp";

const BASE = "/api/mobile-app/messages";

/** "sent" = Expo took it, the push service has not confirmed yet; "delivered" = Google/Apple accepted it for the phone. */
export type PushStatus = "sent" | "delivered" | "no_device" | "failed" | "off";

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

export const useMobileMessageControls = () =>
  useQuery<MobileMessageControls>({
    queryKey: [BASE, "controls"],
    queryFn: () => customFetch<MobileMessageControls>(`${BASE}/controls`),
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
