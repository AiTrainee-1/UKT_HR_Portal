// device-control: the Device Control section (Attendance → Device Control): the overview, Data Fetch and Data Push.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

const BASE = "/api/attendance/device-control";
export const DEVICE_CONTROL_OVERVIEW_KEY = [`${BASE}/overview`] as const;
export const DEVICE_CONTROL_PEOPLE_KEY = [`${BASE}/people`] as const;
export const DEVICE_CONTROL_RUNS_KEY = [`${BASE}/fetch/runs`] as const;

// ── overview ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether THIS server can open a session with the device right now. (What the device pushes to the server is `push`.) */
export type ConnectionState = "connected" | "disconnected" | "disabled" | "unknown";
export type ConnectionCode =
  | "ok"
  | "busy"
  | "cloud"
  | "timeout"
  | "refused"
  | "unreachable"
  | "auth"
  | "protocol"
  | "config"
  | "error"
  | "disabled"
  | "unknown";

export type DeviceCapacity = {
  users?: number;
  usersCap?: number;
  fingers?: number;
  fingersCap?: number;
  records?: number;
  recordsCap?: number;
  cards?: number;
  faces?: number;
  facesCap?: number;
  serial?: string;
  platform?: string;
  firmware?: string;
  pinWidth?: number;
  readAt?: string;
};

export type DeviceControlDevice = {
  id: number;
  name: string;
  host: string;
  port: number;
  serialNumber: string | null;
  deviceType: string;
  isActive: boolean;
  privateAddress: boolean;
  connection: { state: ConnectionState; code: ConnectionCode; reason: string; latencyMs: number | null };
  push: { state: "live" | "silent" | "never" | "disabled"; lastContactAt: string | null };
  capacity: DeviceCapacity | null;
  deviceTime: string | null;
  clockSkewSeconds: number | null;
  usersRead: { at: string | null; error: string };
};

export type DeviceControlOverview = {
  generatedAt: string;
  server: { deployment: "railway" | "local" };
  summary: {
    configured: number;
    enabled: number;
    connected: number;
    disconnected: number;
    disabled: number;
    sendingToServer: number;
    peopleOnDevices: number;
    linked: number;
    deviceOnly: number;
    hrmsOnly: number;
    inactiveOnDevice: number;
  };
  devices: DeviceControlDevice[];
};

export const useDeviceControlOverview = (autoRefresh: boolean) =>
  useQuery<DeviceControlOverview>({
    queryKey: DEVICE_CONTROL_OVERVIEW_KEY,
    queryFn: () => customFetch<DeviceControlOverview>(`${BASE}/overview`),
    refetchInterval: autoRefresh ? 30_000 : false,
  });

/** Ask every device again (the server otherwise reuses an answer a few seconds old). */
export const useRecheckDevices = () => {
  const queryClient = useQueryClient();
  return useMutation<DeviceControlOverview, Error, void>({
    mutationFn: () => customFetch<DeviceControlOverview>(`${BASE}/overview?fresh=1`),
    onSuccess: (data) => queryClient.setQueryData(DEVICE_CONTROL_OVERVIEW_KEY, data),
  });
};

// ── people ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PersonLink = "linked" | "device_only" | "hrms_only" | "inactive_on_device" | "restricted";
export type DeviceMode = "any" | "all" | "none";

export type PersonPresence = {
  deviceId: number;
  uid: number;
  name: string;
  privilege: number;
  role: string;
  card: number;
  hasPassword: boolean;
  group: string;
};

export type PersonEmployee = {
  id: number;
  code: string;
  name: string;
  status: string;
  employmentType: string;
  department: string | null;
  designation: string | null;
  branch: string | null;
  photoUrl: string | null;
};

export type PersonRow = {
  key: string;
  userId: string;
  name: string;
  link: PersonLink;
  restricted: boolean;
  employee: PersonEmployee | null;
  presence: PersonPresence[];
  deviceCount: number;
  differs: ("name" | "role" | "card")[];
};

export type PeopleFacets = {
  total: number;
  onDevices: number;
  linked: number;
  deviceOnly: number;
  hrmsOnly: number;
  inactiveOnDevice: number;
  restricted: number;
  multipleDevices: number;
  singleDevice: number;
  admins: number;
  differs: number;
  perDevice: Record<string, number>;
};

export type PeoplePayload = {
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  items: PersonRow[];
  facets: PeopleFacets;
};

export type PeopleParams = {
  search?: string;
  devices?: number[];
  deviceMode?: DeviceMode;
  link?: "all" | PersonLink;
  count?: "any" | "single" | "multiple";
  role?: "any" | "admin" | "user";
  employmentType?: "" | "staff" | "production";
  departmentId?: number | null;
  branchId?: number | null;
  differs?: boolean;
  sort?: "name" | "code" | "devices" | "department";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

/** The query string for a people request: only what differs from "no filter", so cache keys stay stable. */
export function peopleQuery(p: PeopleParams): string {
  const q = new URLSearchParams();
  if (p.search) q.set("search", p.search);
  if (p.devices?.length) {
    q.set("devices", p.devices.join(","));
    q.set("deviceMode", p.deviceMode ?? "any");
  }
  if (p.link && p.link !== "all") q.set("link", p.link);
  if (p.count && p.count !== "any") q.set("count", p.count);
  if (p.role && p.role !== "any") q.set("role", p.role);
  if (p.employmentType) q.set("employmentType", p.employmentType);
  if (p.departmentId) q.set("departmentId", String(p.departmentId));
  if (p.branchId) q.set("branchId", String(p.branchId));
  if (p.differs) q.set("differs", "1");
  if (p.sort && p.sort !== "name") q.set("sort", p.sort);
  if (p.dir === "desc") q.set("dir", "desc");
  if (p.page && p.page > 1) q.set("page", String(p.page));
  if (p.pageSize && p.pageSize !== 50) q.set("pageSize", String(p.pageSize));
  const text = q.toString();
  return text ? `?${text}` : "";
}

export const useDevicePeople = (params: PeopleParams, enabled = true) =>
  useQuery<PeoplePayload>({
    queryKey: [...DEVICE_CONTROL_PEOPLE_KEY, peopleQuery(params)],
    queryFn: () => customFetch<PeoplePayload>(`${BASE}/people${peopleQuery(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

// ── reading and changing users ──────────────────────────────────────────────────────────────────────────────────────

export type RefreshResult = {
  results: {
    deviceId: number;
    deviceName: string;
    ok: boolean;
    count?: number;
    ms?: number;
    code?: string;
    error?: string;
  }[];
};

/** What the page sends for one user. A field left out is left alone on a device that already has the user. */
export type UserInput = {
  userId: string;
  name?: string;
  privilege?: number;
  /** "" clears it */
  password?: string;
  /** "" or 0 clears it */
  card?: number | string;
  group?: string;
  employeeId?: number;
};

export type DeviceChangeEntry = {
  deviceId: number;
  deviceName: string;
  ok: boolean;
  added: string[];
  updated: string[];
  deleted: string[];
  skipped: { userId: string; reason: string }[];
  failed: { userId: string; error: string }[];
  code?: string;
  error?: string;
};

export type PushResult = {
  mode: "create" | "update";
  rejected: { userId: string; error: string }[];
  results: DeviceChangeEntry[];
  summary: { added: number; updated: number; failed: number };
};

export type InactiveEntry = {
  userId: string;
  employeeId: number | null;
  name: string;
  changed: boolean;
  reason: string;
};

export type DeleteResult = {
  results: DeviceChangeEntry[];
  inactive: InactiveEntry[];
  rejected: { userId: string; error: string }[];
  summary: { deleted: number; failed: number; madeInactive: number };
};

/** Every list on the page (people, the overview, the device counts) follows a change on a device. */
const useRefreshAfterChange = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: DEVICE_CONTROL_PEOPLE_KEY });
    queryClient.invalidateQueries({ queryKey: DEVICE_CONTROL_OVERVIEW_KEY });
    // an Inactive employee leaves the Employees list's active count and the Skipped-punches picture
    queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
  };
};

export const useRefreshDeviceUsers = () => {
  const after = useRefreshAfterChange();
  return useMutation<RefreshResult, Error, number[] | undefined>({
    mutationFn: (deviceIds) =>
      customFetch<RefreshResult>(`${BASE}/users/refresh`, {
        method: "POST",
        body: JSON.stringify(deviceIds && deviceIds.length > 0 ? { deviceIds } : {}),
      }),
    onSuccess: after,
  });
};

export const usePushDeviceUsers = () => {
  const after = useRefreshAfterChange();
  return useMutation<PushResult, Error, { deviceIds: number[]; users: UserInput[] }>({
    mutationFn: (body) => customFetch<PushResult>(`${BASE}/users/push`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: after,
  });
};

export const useUpdateDeviceUsers = () => {
  const after = useRefreshAfterChange();
  return useMutation<PushResult, Error, { deviceIds: number[]; users: UserInput[] }>({
    mutationFn: (body) =>
      customFetch<PushResult>(`${BASE}/users/update`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: after,
  });
};

export const useDeleteDeviceUsers = () => {
  const after = useRefreshAfterChange();
  return useMutation<DeleteResult, Error, { userIds: string[]; deviceIds?: number[]; markInactive: boolean }>({
    mutationFn: (body) =>
      customFetch<DeleteResult>(`${BASE}/users/delete`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: after,
  });
};

export const useSaveEmployeePhoto = () => {
  const queryClient = useQueryClient();
  return useMutation<{ employeeId: number; photoUrl: string }, Error, { employeeId: number; photo: string }>({
    mutationFn: ({ employeeId, photo }) =>
      customFetch(`${BASE}/employees/${employeeId}/photo`, { method: "POST", body: JSON.stringify({ photo }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DEVICE_CONTROL_PEOPLE_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
    },
  });
};

// ── Data Fetch ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type FetchPreset = "today" | "yesterday" | "last7" | "this_month" | "last_month" | "all" | "custom";
export type FetchRange = { preset: FetchPreset; from?: string; to?: string };

export type FetchUnmatched = { userId: string; punches: number; lastDate: string | null; deviceName?: string };
export type FetchSample = { code: string; name: string; date: string; time: string; type: "IN" | "OUT" };
export type SuspiciousDay = { employeeId: number; employeeName: string; date: string; punches: number };

export type FetchDeviceResult = {
  deviceId: number;
  deviceName: string;
  status: "reading" | "processing" | "done" | "failed";
  phase?: string;
  code?: string;
  error?: string;
  onDevice?: number;
  inRange?: number;
  matched?: number;
  alreadyInHrms?: number;
  new?: number;
  created?: number;
  unmatchedPunches?: number;
  unmatchedIds?: number;
  unmatched?: FetchUnmatched[];
  invalidRecords?: number;
  samples?: FetchSample[];
  durationMs?: number;
  suspiciousDays?: SuspiciousDay[];
};

export type FetchRun = {
  id: number;
  mode: "preview" | "update";
  status: "running" | "done" | "failed";
  startedBy: string;
  rangeLabel: string;
  dateFrom: string | null;
  dateTo: string | null;
  deviceIds: number[];
  results: FetchDeviceResult[];
  summary: {
    devices: number;
    devicesDone: number;
    devicesFailed: number;
    onDevice: number;
    inRange: number;
    alreadyInHrms: number;
    new: number;
    created: number;
    unmatchedPunches: number;
    unmatched: FetchUnmatched[];
    suspiciousDays: SuspiciousDay[];
  } | null;
  error: string;
  createdAt: string;
  finishedAt: string | null;
  elapsedSeconds: number;
};

export const useStartFetch = () => {
  const queryClient = useQueryClient();
  return useMutation<FetchRun, Error, { deviceIds: number[]; range: FetchRange; apply: boolean }>({
    mutationFn: (body) => customFetch<FetchRun>(`${BASE}/fetch/start`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (run) => {
      queryClient.setQueryData([...DEVICE_CONTROL_RUNS_KEY, run.id], run);
      queryClient.invalidateQueries({ queryKey: [`${BASE}/fetch/runs`, "list"] });
    },
  });
};

/** One run, polled every 1.5 s until it has finished. */
export const useFetchRun = (id: number | null) =>
  useQuery<FetchRun>({
    queryKey: [...DEVICE_CONTROL_RUNS_KEY, id],
    queryFn: () => customFetch<FetchRun>(`${BASE}/fetch/runs/${id}`),
    enabled: id != null,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false),
  });

/** The history. While one is running it is polled too, so a reloaded page picks the run back up. */
export const useFetchRuns = () =>
  useQuery<{ runs: FetchRun[] }>({
    queryKey: [`${BASE}/fetch/runs`, "list"],
    queryFn: () => customFetch<{ runs: FetchRun[] }>(`${BASE}/fetch/runs`),
    refetchInterval: (query) => (query.state.data?.runs.some((r) => r.status === "running") ? 3000 : false),
  });
