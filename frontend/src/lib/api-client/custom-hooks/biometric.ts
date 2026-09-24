// biometric: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import { SyncBiometricMode } from "./attendance";
import { SyncResult } from "./shared";

// ── Biometric Sync Pipeline Progress ──────────────────────────────────────────

export type SyncDeviceStatus = "pending" | "syncing" | "completed" | "failed";
export type SyncProgressDevice = { id: number | string; label: string; status: SyncDeviceStatus };
export type SyncProgress = {
  stage: "idle" | "running" | "completed";
  devices: SyncProgressDevice[];
  startedAt: string | null;
  finishedAt: string | null;
  /** The finished run's outcome. Null while running. Carries what the POST
   *  used to return, now that the sync runs in the background and the
   *  request answers 202 straight away. */
  result: SyncResult | null;
};

export const useSyncBiometricProgress = (enabled: boolean) =>
  useQuery<SyncProgress>({
    queryKey: ["/api/attendance/sync-biometric-progress"],
    queryFn: () => customFetch<SyncProgress>("/api/attendance/sync-biometric-progress"),
    enabled,
    refetchInterval: enabled ? 600 : false,
    // The pipeline only cares about the freshest snapshot -never serve a stale one.
    staleTime: 0,
  });

// ── Biometric Device Management ───────────────────────────────────────────────

export type BiometricDeviceItem = {
  id: number | "env";
  name: string;
  deviceType: string;
  host: string;
  port: number | null;
  hasApiKey: boolean;
  connectionConfig: Record<string, unknown>;
  isActive: boolean;
  isDefault: boolean;
  /** true for the read-only device configured via backend/.env */
  isEnv?: boolean;
  lastSyncedAt: string | null;
  notes: string | null;
  createdAt: string | null;
};

export const getBiometricDevicesQueryKey = () => ["/api/biometric-devices"] as const;

export const useListBiometricDevices = () =>
  useQuery<BiometricDeviceItem[]>({
    queryKey: getBiometricDevicesQueryKey(),
    queryFn: () => customFetch<BiometricDeviceItem[]>("/api/biometric-devices"),
  });

export const useCreateBiometricDevice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      deviceType?: string;
      host?: string;
      port?: number | null;
      apiKey?: string;
      isActive?: boolean;
      isDefault?: boolean;
      notes?: string;
      connectionConfig?: Record<string, unknown>;
    }) =>
      customFetch<BiometricDeviceItem>("/api/biometric-devices", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getBiometricDevicesQueryKey() }),
  });
};

export const useUpdateBiometricDevice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<{
        name: string;
        deviceType: string;
        host: string;
        port: number | null;
        apiKey: string;
        isActive: boolean;
        isDefault: boolean;
        notes: string;
        connectionConfig: Record<string, unknown>;
      }>;
    }) =>
      customFetch<BiometricDeviceItem>(`/api/biometric-devices/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getBiometricDevicesQueryKey() }),
  });
};

export const useDeleteBiometricDevice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/biometric-devices/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getBiometricDevicesQueryKey() }),
  });
};

// ── Auto Sync (configurable background biometric sync rules) ─────────────────

export type AutoSyncRuleItem = {
  id: number;
  name: string;
  /** "HH:MM", Asia/Kolkata */
  time: string;
  /** cron-compatible: "*" (every day) or e.g. "mon,tue,wed,thu,fri" */
  daysOfWeek: string;
  /** empty = every enabled device, same convention as manual Sync Biometric */
  deviceSelection: (number | "env")[];
  mode: SyncBiometricMode;
  isEnabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: "success" | "failed" | null;
  lastRunSummary: string | null;
  createdAt: string | null;
};

export type AutoSyncRuleInput = Partial<{
  name: string;
  time: string;
  daysOfWeek: string;
  deviceSelection: (number | "env")[];
  mode: SyncBiometricMode;
  isEnabled: boolean;
}>;

export const getAutoSyncRulesQueryKey = () => ["/api/auto-sync-rules"] as const;

export const useListAutoSyncRules = () =>
  useQuery<AutoSyncRuleItem[]>({
    queryKey: getAutoSyncRulesQueryKey(),
    queryFn: () => customFetch<AutoSyncRuleItem[]>("/api/auto-sync-rules"),
    refetchInterval: 60_000,
  });

export const useCreateAutoSyncRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AutoSyncRuleInput) =>
      customFetch<AutoSyncRuleItem>("/api/auto-sync-rules", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getAutoSyncRulesQueryKey() }),
  });
};

export const useUpdateAutoSyncRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: AutoSyncRuleInput }) =>
      customFetch<AutoSyncRuleItem>(`/api/auto-sync-rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getAutoSyncRulesQueryKey() }),
  });
};

export const useDeleteAutoSyncRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/auto-sync-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getAutoSyncRulesQueryKey() }),
  });
};

// ── Production Shift Workflow (punch times + dynamic shift-value segments) ────

export type ProductionShiftSegment = {
  id: number;
  label: string;
  startTime: string;
  endTime: string;
  shiftValue: number;
  order: number;
  isActive: boolean;
};

export type ProductionShiftConfigResponse = {
  punch1Time: string;
  punch2Time: string;
  punch3Time: string;
  punch4Time: string;
  graceMinutes: number;
  updatedAt: string | null;
  segments: ProductionShiftSegment[];
};

export const getProductionShiftConfigQueryKey = () => ["/api/production-shift-config"] as const;

export const useProductionShiftConfig = () =>
  useQuery<ProductionShiftConfigResponse>({
    queryKey: getProductionShiftConfigQueryKey(),
    queryFn: () => customFetch<ProductionShiftConfigResponse>("/api/production-shift-config"),
  });

export const useUpdateProductionShiftConfig = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: Partial<{
        punch1Time: string;
        punch2Time: string;
        punch3Time: string;
        punch4Time: string;
        graceMinutes: number;
      }>,
    ) => customFetch("/api/production-shift-config", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};

export const useCreateProductionShiftSegment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      label: string;
      startTime: string;
      endTime: string;
      shiftValue: number;
      order?: number;
      isActive?: boolean;
    }) =>
      customFetch<ProductionShiftSegment>("/api/production-shift-segments", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};

export const useUpdateProductionShiftSegment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<{
        label: string;
        startTime: string;
        endTime: string;
        shiftValue: number;
        order: number;
        isActive: boolean;
      }>;
    }) =>
      customFetch<ProductionShiftSegment>(`/api/production-shift-segments/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};

export const useDeleteProductionShiftSegment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/production-shift-segments/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};
