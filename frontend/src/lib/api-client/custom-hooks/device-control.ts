// device-control: the Device Control section (Attendance → Device Control): the overview, Data Fetch, Data Push and the
// Site Connectors that reach devices on networks the server cannot.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  | "unknown"
  // devices behind a Site Connector: the connector itself, or what it reported
  | "connector_offline"
  | "connector_off"
  | "pending"
  | "lost"
  | "expired"
  | "revoked"
  | "removed"
  | "not_assigned"
  | "incomplete"
  | "upload"
  | "unsupported";

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
  /** The Site Connector that reaches this device, when the server cannot. */
  via: { id: number; name: string; online: boolean } | null;
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
    // every read opens a TCP session to each LAN device: kept to one every 2 minutes
    refetchInterval: autoRefresh ? 120_000 : false,
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
export type DeviceMode = "any" | "all" | "none" | "missing";

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
  /** "active" = an active employee, on a device or not (Data Push -> Add Users). */
  link?: "all" | PersonLink | "active";
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

// ── operations: what a device behind a Site Connector makes a request into ─────────────────────────────────────────────

export type OperationPending = {
  deviceId: number;
  deviceName: string;
  connector: string;
  state: "waiting" | "working";
};

export type DeviceOperation = {
  id: number;
  kind: "refresh" | "apply" | "delete";
  status: "running" | "done" | "failed";
  pending: OperationPending[];
  final: unknown;
  error: string;
  createdAt: string;
  finishedAt: string | null;
};

type Started = { operation: DeviceOperation };

/** A read or change that includes a device behind a Site Connector is answered with {operation} (the connector has to be
 *  asked, and cannot be waited for inside one request); anything else is already the answer. */
export const isStarted = (body: unknown): body is Started =>
  !!body && typeof body === "object" && "operation" in (body as object);

/** How long a page waits for a connector: longer than the server's own limit for a job (7 minutes to be taken, and 3 more
 *  after it was taken), so the server's specific answer ("the device may or may not have been changed") is what a person
 *  gets when a connector dies, not a generic time-out from here. */
export const FOLLOW_TIMEOUT_MS = 13 * 60_000;
/** How long a lost connection to the HRMS is put up with: the operation carries on at the server whatever this page does. */
export const FOLLOW_NETWORK_GIVE_UP_MS = 90_000;
export const LOST_CONTACT_MESSAGE =
  "Lost contact with the server while the site connector was working. The change may still go through: read the devices again to see where things stand.";

export type FollowOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  networkGiveUpMs?: number;
  load?: (id: number) => Promise<DeviceOperation>;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (operation: DeviceOperation) => void;
};

/** What a person is waiting for, in a sentence: which connector, which devices, and whether it has started. */
export function describeOperationWait(operation: DeviceOperation): string {
  if (operation.status !== "running") return "";
  if (operation.pending.length === 0) return "Finishing…";
  const connectors = [...new Set(operation.pending.map((p) => p.connector))].join(", ");
  const devices = operation.pending.map((p) => p.deviceName).join(", ");
  return operation.pending.some((p) => p.state === "working")
    ? `The site connector “${connectors}” is working on ${devices}…`
    : `Waiting for the site connector “${connectors}” to pick this up (${devices})…`;
}

/** The answer to a request that may have gone to a Site Connector: the body itself, or the operation's final answer once
 *  the connector has reported (asked about every 1.5 seconds). A look that fails (a dropped connection, a deploy at the
 *  server) is tried again for up to 90 seconds; one the server refuses (signed out, no longer there) is not. */
export async function followOperation<T>(body: T | Started, options: FollowOptions = {}): Promise<T> {
  if (!isStarted(body)) return body;
  const {
    intervalMs = 1500,
    timeoutMs = FOLLOW_TIMEOUT_MS,
    networkGiveUpMs = FOLLOW_NETWORK_GIVE_UP_MS,
    load = (id: number) => customFetch<DeviceOperation>(`${BASE}/operations/${id}`),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    onUpdate,
  } = options;
  let operation = body.operation;
  onUpdate?.(operation);
  const startedAt = Date.now();
  let firstFailureAt: number | null = null;
  let failures = 0;
  while (operation.status === "running") {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("The site connector has not finished. Read the devices again to see where things stand.");
    }
    await sleep(failures > 0 ? Math.min(5000, intervalMs * 2 ** Math.min(failures, 3)) : intervalMs);
    try {
      operation = await load(operation.id);
      failures = 0;
      firstFailureAt = null;
      onUpdate?.(operation);
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 || status === 403 || status === 404) throw error;
      failures += 1;
      firstFailureAt ??= Date.now();
      if (Date.now() - firstFailureAt >= networkGiveUpMs) throw new Error(LOST_CONTACT_MESSAGE);
    }
  }
  if (operation.status === "failed" || operation.final == null) {
    throw new Error(operation.error || "The operation did not finish.");
  }
  return operation.final as T;
}

/** What the page says while a connector works: the sentence for the latest look at the operation. */
const useWaiting = () => {
  const [waiting, setWaiting] = useState("");
  return {
    waiting,
    onUpdate: (operation: DeviceOperation) => setWaiting(describeOperationWait(operation)),
    clear: () => setWaiting(""),
  };
};

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
    queryClient.invalidateQueries({ queryKey: [`${BASE}/users/history`] });
    queryClient.invalidateQueries({ queryKey: [`${BASE}/links/summary`] });
    // an Inactive employee leaves the Employees list's active count and the Skipped-punches picture
    queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
  };
};

export const useRefreshDeviceUsers = () => {
  const after = useRefreshAfterChange();
  const { waiting, onUpdate, clear } = useWaiting();
  const mutation = useMutation<RefreshResult, Error, number[] | undefined>({
    mutationFn: async (deviceIds) =>
      followOperation(
        await customFetch<RefreshResult | Started>(`${BASE}/users/refresh`, {
          method: "POST",
          body: JSON.stringify(deviceIds && deviceIds.length > 0 ? { deviceIds } : {}),
        }),
        { onUpdate },
      ),
    onSettled: () => {
      clear();
      after();
    },
  });
  return { ...mutation, waiting };
};

/** Why the page made a change, kept in the history of user changes ("" = the older screens). */
export type ChangeContext = "add" | "edit" | "copy" | "transfer" | "make_same" | "delete" | "";

export const usePushDeviceUsers = () => {
  const after = useRefreshAfterChange();
  const { waiting, onUpdate, clear } = useWaiting();
  const mutation = useMutation<PushResult, Error, { deviceIds: number[]; users: UserInput[]; context?: ChangeContext }>(
    {
      mutationFn: async (body) =>
        followOperation(
          await customFetch<PushResult | Started>(`${BASE}/users/push`, { method: "POST", body: JSON.stringify(body) }),
          { onUpdate },
        ),
      onSettled: () => {
        clear();
        after();
      },
    },
  );
  return { ...mutation, waiting };
};

export const useUpdateDeviceUsers = () => {
  const after = useRefreshAfterChange();
  const { waiting, onUpdate, clear } = useWaiting();
  const mutation = useMutation<PushResult, Error, { deviceIds: number[]; users: UserInput[]; context?: ChangeContext }>(
    {
      mutationFn: async (body) =>
        followOperation(
          await customFetch<PushResult | Started>(`${BASE}/users/update`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
          { onUpdate },
        ),
      onSettled: () => {
        clear();
        after();
      },
    },
  );
  return { ...mutation, waiting };
};

export const useDeleteDeviceUsers = () => {
  const after = useRefreshAfterChange();
  const { waiting, onUpdate, clear } = useWaiting();
  const mutation = useMutation<
    DeleteResult,
    Error,
    { userIds: string[]; deviceIds?: number[]; markInactive: boolean; context?: ChangeContext }
  >({
    mutationFn: async (body) =>
      followOperation(
        await customFetch<DeleteResult | Started>(`${BASE}/users/delete`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        { onUpdate },
      ),
    onSettled: () => {
      clear();
      after();
    },
  });
  return { ...mutation, waiting };
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

// ── Link / Unlink ───────────────────────────────────────────────────────────────────────────────────────────────────

export type DeviceLinkRow = {
  employeeId: number;
  code: string;
  name: string;
  status: string;
  department: string | null;
  branch: string | null;
  /** Devices that hold a user with this employee's code (as of the last read of the devices). */
  onDevices: number[];
  /** Devices UNLINKED from this employee: their punches carrying this code are ignored. Empty = every device is linked. */
  unlinked: number[];
};
export type DeviceLinksPayload = { mode: "search" | "restricted"; items: DeviceLinkRow[] };

export const DEVICE_LINKS_KEY = ["/api/attendance/device-control/links"] as const;

/** The employees matching a search (Employee Code or name), or - with no search - those who have a device unlinked. */
export const useDeviceLinks = (search: string) =>
  useQuery<DeviceLinksPayload>({
    queryKey: [...DEVICE_LINKS_KEY, search],
    queryFn: () => customFetch<DeviceLinksPayload>(`${BASE}/links?search=${encodeURIComponent(search)}`),
    placeholderData: (previous) => previous,
  });

/** Set the devices unlinked from one employee (an empty list links every device again). */
export const useSetEmployeeDeviceLinks = () => {
  const queryClient = useQueryClient();
  return useMutation<
    { employeeId: number; unlinked: number[]; linkedCount: number },
    Error,
    { employeeId: number; unlinkedDeviceIds: number[] }
  >({
    mutationFn: ({ employeeId, unlinkedDeviceIds }) =>
      customFetch(`${BASE}/employees/${employeeId}/links`, {
        method: "POST",
        body: JSON.stringify({ unlinkedDeviceIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DEVICE_LINKS_KEY });
      // Link / Unlink -> Home counts and Modified history
      queryClient.invalidateQueries({ queryKey: [`${BASE}/links/summary`] });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/links/history`] });
    },
  });
};

// ── Data Fetch ──────────────────────────────────────────────────────────────────────────────────────────────────────

// ── Link / Unlink -> Home and Modified, Data Push -> history (owner 2026-11-17) ──────────────────────────────────

export type LinkSummaryDevice = {
  deviceId: number;
  deviceName: string;
  isActive: boolean;
  via: "direct" | "connector";
  usersOnDevice: number;
  employees: number;
  staff: number;
  production: number;
  alsoOnOtherDevices: number;
  unlinkedHere: number;
  inactiveEmployees: number;
  notInHrms: number;
  otherType: number;
  usersReadAt: string | null;
};

export type LinkSummary = {
  employmentType: EmploymentType | "";
  summary: {
    employees: number;
    onAnyDevice: number;
    onNoDevice: number;
    onMultipleDevices: number;
    linkedToMultipleDevices: number;
    withUnlinkedDevices: number;
    devices: number;
  };
  devices: LinkSummaryDevice[];
};

export const useLinkSummary = (employmentType: EmploymentType | "") =>
  useQuery<LinkSummary>({
    queryKey: [`${BASE}/links/summary`, employmentType],
    queryFn: () =>
      customFetch<LinkSummary>(`${BASE}/links/summary${employmentType ? `?employmentType=${employmentType}` : ""}`),
  });

export type HistoryEmployee = {
  id: number;
  code: string;
  name: string;
  employmentType: string;
  department: string | null;
};

export type LinkHistory = {
  total: number;
  page: number;
  pageSize: number;
  rows: {
    id: number;
    employee: HistoryEmployee;
    deviceId: number | null;
    deviceName: string;
    action: "link" | "unlink";
    changedBy: string;
    at: string;
  }[];
  current: { employee: HistoryEmployee; unlinkedDevices: string[] }[];
};

export type LinkHistoryParams = {
  search?: string;
  action?: "link" | "unlink" | "";
  employmentType?: EmploymentType | "";
  device?: number | null;
  page?: number;
};

export const useLinkHistory = (params: LinkHistoryParams) =>
  useQuery<LinkHistory>({
    queryKey: [`${BASE}/links/history`, params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.search) q.set("search", params.search);
      if (params.action) q.set("action", params.action);
      if (params.employmentType) q.set("employmentType", params.employmentType);
      if (params.device) q.set("device", String(params.device));
      if (params.page && params.page > 1) q.set("page", String(params.page));
      return customFetch<LinkHistory>(`${BASE}/links/history?${q}`);
    },
    placeholderData: (prev) => prev,
  });

export type UserChangeKind = "create" | "update" | "delete";

export type UserChange = {
  id: number;
  kind: UserChangeKind;
  context: ChangeContext;
  status: "done" | "partial" | "failed";
  userIds: string[];
  userNames: Record<string, string>;
  deviceNames: string[];
  results: {
    deviceName: string;
    ok: boolean;
    error?: string;
    added: number;
    updated: number;
    deleted: number;
    absent: number;
    skipped: number;
    failed: number;
  }[];
  rejected: number;
  viaConnector: boolean;
  requestedBy: string;
  at: string;
};

export const useUserHistory = (kind: UserChangeKind | "", search = "", page = 1, contexts: ChangeContext[] = []) =>
  useQuery<{ total: number; page: number; pageSize: number; rows: UserChange[] }>({
    queryKey: [`${BASE}/users/history`, kind, search, page, contexts.join()],
    queryFn: () => {
      const q = new URLSearchParams();
      if (kind) q.set("kind", kind);
      if (contexts.length) q.set("context", contexts.join(","));
      if (search) q.set("search", search);
      if (page > 1) q.set("page", String(page));
      return customFetch(`${BASE}/users/history?${q}`);
    },
    placeholderData: (prev) => prev,
  });

export type FetchPreset = "today" | "yesterday" | "last7" | "this_month" | "last_month" | "all" | "custom";
export type FetchRange = { preset: FetchPreset; from?: string; to?: string };

export type FetchUnmatched = { userId: string; punches: number; lastDate: string | null; deviceName?: string };
export type FetchSample = { code: string; name: string; date: string; time: string; type: "IN" | "OUT" };
export type SuspiciousDay = { employeeId: number; employeeName: string; date: string; punches: number };

/** Where one device's read has got (owner 2026-11-17: an animated progress bar of the fetch). */
export type FetchStage = "connecting" | "waiting" | "reading" | "checking" | "writing" | "done" | "failed";

export type FetchDeviceResult = {
  deviceId: number;
  deviceName: string;
  status: "reading" | "processing" | "done" | "failed";
  phase?: string;
  stage?: FetchStage;
  /** Records of the device's attendance log received so far, of all it holds (counted as the log arrives). */
  recordsRead?: number;
  recordsTotal?: number | null;
  via?: "direct" | "connector";
  /** Punches of people outside the run's scope: only counted. */
  outOfScope?: number;
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
  /** Punches ignored because their employee is limited to other devices. */
  restricted?: number;
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
    restricted?: number;
    outOfScope?: number;
    unmatched: FetchUnmatched[];
    suspiciousDays: SuspiciousDay[];
  } | null;
  error: string;
  createdAt: string;
  finishedAt: string | null;
  elapsedSeconds: number;
  /** Whose punches it takes: null = everyone. */
  scope?: FetchScope | null;
  scopeLabel?: string;
};

export type EmploymentType = "staff" | "production";

/** Whose punches a fetch takes (owner 2026-11-17): a kind of employee, or chosen employees. */
export type FetchScope = {
  employmentType?: EmploymentType;
  employeeIds?: number[];
  employees?: { id: number; code: string; name: string; employmentType: string }[];
};

export type FetchEmployee = {
  id: number;
  code: string;
  name: string;
  employmentType: EmploymentType;
  department: string | null;
  onDevices: string[];
};

/** Active employees to fetch one of (search by code or name). */
export const useFetchEmployees = (search: string, employmentType: EmploymentType | "", enabled = true) =>
  useQuery<{ items: FetchEmployee[] }>({
    queryKey: [`${BASE}/fetch/employees`, search, employmentType],
    queryFn: () =>
      customFetch<{ items: FetchEmployee[] }>(
        `${BASE}/fetch/employees?${new URLSearchParams({ search, ...(employmentType ? { employmentType } : {}) })}`,
      ),
    enabled,
    staleTime: 30_000,
  });

export const useStartFetch = () => {
  const queryClient = useQueryClient();
  return useMutation<
    FetchRun,
    Error,
    { deviceIds: number[]; range: FetchRange; apply: boolean; scope?: FetchScope | null }
  >({
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

// ── Site Connectors ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const CONNECTORS_KEY = [`${BASE}/connectors`] as const;

export type ConnectorState = "online" | "offline" | "unpaired" | "off";

/** What a connector last said about reading a device's punches on its own schedule. */
export type ConnectorSync = {
  at?: string;
  ok?: boolean;
  error?: string;
  read?: number;
  queued?: number;
  inRange?: number;
  matched?: number;
  alreadyInHrms?: number;
  new?: number;
  created?: number;
  unmatchedPunches?: number;
  skipped?: boolean;
  windowDays?: number;
};

export type ConnectorDevice = {
  id: number;
  name: string;
  host: string;
  port: number;
  isActive: boolean;
  connected: boolean;
  code: string;
  reason: string;
  sync: ConnectorSync | null;
};

export type SiteConnector = {
  id: number;
  name: string;
  notes: string;
  isActive: boolean;
  state: ConnectorState;
  paired: boolean;
  pairedAt: string | null;
  pairingPending: boolean;
  pairingExpiresAt: string | null;
  lastSeenAt: string | null;
  lastRemoteIp: string | null;
  version: string | null;
  hostname: string | null;
  os: string | null;
  punchSyncMinutes: number;
  punchSyncDays: number;
  uptimeSeconds: number | null;
  outbox: number | null;
  openJobs: number;
  devices: ConnectorDevice[];
  createdBy: string;
  createdAt: string;
};

export type ConnectorWithCode = { connector: SiteConnector; pairingCode: string; pairingExpiresAt: string };

/**
 * Every connector, with how it and its devices are (asked again every 30 seconds). `poll: false` reads it once, for a
 * page that only needs the list (Settings -> Devices picks a connector from it), not the live state.
 */
export const useConnectors = (enabled = true, { poll = true }: { poll?: boolean } = {}) =>
  useQuery<{ connectors: SiteConnector[] }>({
    queryKey: CONNECTORS_KEY,
    queryFn: () => customFetch<{ connectors: SiteConnector[] }>(`${BASE}/connectors`),
    // asked again every 30 seconds, except while the answer is an error (a role without Attendance access, a server down)
    refetchInterval: (query) => (!poll || query.state.status === "error" ? false : 30_000),
    enabled,
  });

const useRefreshConnectors = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY });
    queryClient.invalidateQueries({ queryKey: DEVICE_CONTROL_OVERVIEW_KEY });
  };
};

export const useCreateConnector = () => {
  const after = useRefreshConnectors();
  return useMutation<ConnectorWithCode, Error, { name: string; notes?: string }>({
    gcTime: 0,
    mutationFn: (body) =>
      customFetch<ConnectorWithCode>(`${BASE}/connectors`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: after,
  });
};

export type ConnectorChanges = Partial<{
  name: string;
  notes: string;
  isActive: boolean;
  punchSyncMinutes: number;
  punchSyncDays: number;
}>;

export const useUpdateConnector = () => {
  const after = useRefreshConnectors();
  return useMutation<{ connector: SiteConnector }, Error, { id: number; changes: ConnectorChanges }>({
    mutationFn: ({ id, changes }) =>
      customFetch<{ connector: SiteConnector }>(`${BASE}/connectors/${id}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      }),
    onSuccess: after,
  });
};

export const useNewPairingCode = () => {
  const after = useRefreshConnectors();
  return useMutation<ConnectorWithCode, Error, number>({
    gcTime: 0,
    mutationFn: (id) =>
      customFetch<ConnectorWithCode>(`${BASE}/connectors/${id}/pairing`, { method: "POST", body: "{}" }),
    onSuccess: after,
  });
};

export const useDeleteConnector = () => {
  const after = useRefreshConnectors();
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, number>({
    mutationFn: (id) => customFetch<unknown>(`${BASE}/connectors/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      after();
      // its devices are connected directly again: Settings → Devices shows that
      queryClient.invalidateQueries({ queryKey: ["/api/biometric-devices"] });
    },
  });
};
