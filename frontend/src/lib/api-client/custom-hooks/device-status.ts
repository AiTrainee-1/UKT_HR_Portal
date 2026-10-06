// device-status: the Biometric Device Status page (Attendance → Biometric Device Status).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

/** What the server sees of the device. "disabled" = switched off in Settings → Devices. */
export type DeviceStatusState = "connected" | "disconnected" | "error" | "disabled";
/** What this server can reach (a connection check): the result of ping + port + handshake. */
export type DeviceReach = "reachable" | "unreachable" | "refused" | "auth" | "error" | "unchecked";
export type LayerState = "ok" | "warn" | "problem" | "unknown" | "na";
export type LayerKey = "device" | "lan" | "firewall" | "port" | "api" | "railway" | "ip_config" | "timeout" | "auth";

export type DiagnosisLayer = { key: LayerKey; label: string; state: LayerState; finding: string; action: string };

export type Diagnosis = {
  headline: string;
  headlineLayer: LayerKey | null;
  action: string;
  layers: DiagnosisLayer[];
  /** Layers in a "problem" state, in display order. */
  problems: LayerKey[];
};

export type ProbeStep = { key: string; label: string; ok: boolean | null; ms: number | null; note: string };

/** What a connection check read from the device itself. Absent keys were not available on that model. */
export type DeviceReadout = {
  serial?: string;
  deviceName?: string;
  platform?: string;
  mac?: string;
  ip?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
  dhcp?: boolean;
  serverUrl?: string;
  serverPort?: number | null;
  admsEnabled?: boolean;
  proxyEnabled?: boolean;
  timeZoneMinutes?: number | null;
  deviceTime?: string;
  clockSkewSeconds?: number;
  users?: number;
  records?: number;
};

export type ProbeView = {
  checkedAt: string | null;
  ageSeconds: number | null;
  status: "reachable" | "timeout" | "refused" | "unreachable" | "dns" | "auth" | "error";
  latencyMs: number | null;
  /** available:false = this server has no ping program, so the port check stands in for it */
  ping: { available: boolean; ok: boolean; ms: number | null } | null;
  error: string;
  detail: DeviceReadout | null;
  steps: ProbeStep[];
  checkedFrom: string | null;
};

export type DeviceError = { source: "push" | "check" | "sync"; message: string; at: string | null };

export type PushDelay = {
  medianSeconds: number;
  maxSeconds: number;
  samples: number;
  verdict: "realtime" | "delayed" | "batched";
};

export type DeviceStatusRow = {
  id: number;
  name: string;
  deviceType: string;
  host: string;
  port: number;
  serialNumber: string | null;
  isActive: boolean;
  /** 192.168.x.x and the like: only reachable from inside the factory network */
  privateAddress: boolean;
  status: DeviceStatusState;
  statusLabel: string;
  neverConnected: boolean;
  reach: DeviceReach;
  reachLabel: string;
  /** false when the last connection check is old enough that it is shown but no longer treated as evidence */
  reachIsFresh: boolean;
  headline: string;
  action: string;
  diagnosis: Diagnosis;
  errors: DeviceError[];
  push: {
    lastContactAt: string | null;
    lastHeartbeatAt: string | null;
    lastDataAt: string | null;
    lastPushAt: string | null;
    lastPunch: { date: string; time: string | null } | null;
    remoteIp: string | null;
    punchesToday: number;
    delay: PushDelay | null;
    reportedConfig: Record<string, string> | null;
    reportedConfigAt: string | null;
    skippedIds: number;
    skippedPunches: number;
  };
  pull: {
    lastSyncAt: string | null;
    lastSyncError: string | null;
    lastSyncErrorAt: string | null;
    lastReachableAt: string | null;
    probe: ProbeView | null;
  };
};

export type UnknownPusher = {
  serialNumber: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastRemoteIp: string | null;
  contacts: number;
  punches: number;
};

export type DeviceStatusServer = {
  deployment: "railway" | "local";
  environment: string | null;
  commit: string | null;
  host: string;
  scheme: "http" | "https";
  serverTimeIst: string;
  deviceSettings: {
    serverMode: string;
    serverAddress: string;
    serverPort: number;
    https: boolean;
    dnsHint: string;
    /** set when the address shown is not this server's own (a local server) */
    note: string | null;
  };
  admsUrls: string[];
  /** null until a connection check has been run from this server */
  canReachLan: boolean | null;
};

export type DeviceStatusPayload = {
  generatedAt: string;
  server: DeviceStatusServer;
  summary: {
    configured: number;
    enabled: number;
    connected: number;
    disconnected: number;
    error: number;
    unreachable: number;
    neverConnected: number;
    disabled: number;
    punchesToday: number;
  };
  devices: DeviceStatusRow[];
  unknownPushers: UnknownPusher[];
  lastPunchAt: string | null;
  thresholds: {
    heartbeatFreshSeconds: number;
    heartbeatExpectedWithinHours: number;
    silentAfterHours: number;
    slowLatencyMs: number;
    probeFreshHours: number;
  };
};

export type DeviceCheckHistory = {
  deviceId: number;
  checks: {
    id: number;
    checkedAt: string | null;
    status: ProbeView["status"];
    latencyMs: number | null;
    icmpMs: number | null;
    error: string | null;
    checkedFrom: string | null;
  }[];
};

export const DEVICE_STATUS_QUERY_KEY = ["/api/attendance/biometric-status"] as const;

/** The whole picture. Reading it never contacts a device, so it is cheap enough to poll while the page is open. */
export const useDeviceStatus = (autoRefresh: boolean) =>
  useQuery<DeviceStatusPayload>({
    queryKey: DEVICE_STATUS_QUERY_KEY,
    queryFn: () => customFetch<DeviceStatusPayload>("/api/attendance/biometric-status"),
    refetchInterval: autoRefresh ? 15_000 : false,
  });

/** Run a connection check from the server now: every enabled device, or just the ones named. */
export const useRunDeviceCheck = () => {
  const queryClient = useQueryClient();
  return useMutation<{ ranDeviceIds: number[]; status: DeviceStatusPayload }, Error, number[] | undefined>({
    mutationFn: (deviceIds) =>
      customFetch("/api/attendance/biometric-status/check", {
        method: "POST",
        body: JSON.stringify(deviceIds && deviceIds.length > 0 ? { deviceIds } : {}),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(DEVICE_STATUS_QUERY_KEY, data.status);
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/biometric-status", "history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/sync-status-live"] });
    },
  });
};

export const useDeviceCheckHistory = (deviceId: number, enabled: boolean) =>
  useQuery<DeviceCheckHistory>({
    queryKey: ["/api/attendance/biometric-status", "history", deviceId],
    queryFn: () => customFetch<DeviceCheckHistory>(`/api/attendance/biometric-status/${deviceId}/history`),
    enabled,
  });
