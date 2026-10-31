// Mobile Messages (HR portal -> Mobile App Login -> Mobile Messages): what is pushed to employees' phones.
// Backend: api/mobile_messages_views.py. The switches only control the phone push; the in-app record is always saved.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { Paged } from "./whatsapp";

const BASE = "/api/mobile-app/messages";

/** "sent" = Expo took it, the push service has not confirmed yet; "delivered" = Google/Apple accepted it for the phone. */
export type PushStatus = "sent" | "delivered" | "no_device" | "failed" | "off";

export type PushCounts = { total: number; sent: number; noDevice: number; failed: number; off: number };

export type MobileMessagesOverview = {
  pushEnabled: boolean;
  /** How many kinds of message HR has switched off for phones. */
  switchedOff: number;
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

export type MobileMessageControl = {
  key: string;
  label: string;
  description: string;
  group: string;
  groupLabel: string;
  kind: "message" | "workflow";
  enabled: boolean;
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

export type MobileDeviceRow = {
  id: number;
  name: string;
  employeeCode: string;
  employmentType: string;
  phone: string | null;
  devices: number;
  lastRegisteredAt: string | null;
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

export const useMobileDevices = (params: {
  search?: string;
  has?: "with" | "without" | "";
  page: number;
  pageSize: number;
}) =>
  useQuery<Paged<MobileDeviceRow>>({
    queryKey: [BASE, "devices", params],
    queryFn: () => customFetch<Paged<MobileDeviceRow>>(`${BASE}/devices?${query(params)}`),
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
