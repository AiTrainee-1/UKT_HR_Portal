// accounts: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "../custom-fetch";
import { keepPreviousWhileSearching } from "./shared";

export type PermissionLevel = "hidden" | "view" | "edit";

export type Role = {
  id: number;
  name: string;
  description?: string | null;
  permissions: Record<string, PermissionLevel>;
  /** {request kind: may approve}, or null: the role keeps the old rule (approve = edit on the module). An older
   *  backend sends nothing (same as null). */
  approvals?: Record<string, boolean> | null;
  /** "" = for any account; "hr_manager" / "hr_assistant" = only for accounts of that category. */
  category?: "" | "hr_manager" | "hr_assistant";
  isSystem: boolean;
  createdAt?: string | null;
};

/** An HR Manager / HR Assistant account's own changes on top of its role. */
export type PermissionOverrides = {
  modules?: Record<string, PermissionLevel>;
  approvals?: Record<string, boolean>;
};

export type HrUserItem = {
  id: number;
  username: string;
  email?: string | null;
  fullName?: string | null;
  roleId?: number | null;
  roleName?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  branchId?: number | null;
  branchName?: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  /** The Super Admin's username and password come from ADMIN_USERNAME / ADMIN_PASSWORD in the backend .env (synced at
   *  every backend start): the portal cannot change them for that account. */
  credentialsFromEnv?: boolean;
  /** The Managing Director: the one account with the executive MD portal and the AI assistant. */
  isMd?: boolean;
  mdAssignedAt?: string | null;
  /** Hidden from the Account Management list. Purely presentational -a
   *  hidden account still logs in and keeps every permission. */
  isHidden?: boolean;
  /** Per-account capability grants, e.g. { co: true }. */
  masterFeatures?: Record<string, boolean>;
  /** "admin" (every account made before categories existed) | "hr_manager" | "hr_assistant". */
  category?: "admin" | "hr_manager" | "hr_assistant";
  /** The category, or "super_admin" / "md" for those two accounts. */
  displayCategory?: "admin" | "hr_manager" | "hr_assistant" | "super_admin" | "md";
  categoryLabel?: string;
  permissionOverrides?: PermissionOverrides;
  lastLogin?: string | null;
  createdAt?: string | null;
};

export type AuditLogEntry = {
  id: number;
  userType: string;
  userId?: number | null;
  userName: string;
  action: string;
  module: string;
  recordId?: number | null;
  recordDescription?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  ipAddress?: string | null;
  createdAt?: string | null;
};

export type AuditLogsResponse = {
  total: number;
  page: number;
  pageSize: number;
  results: AuditLogEntry[];
};
export const getListRolesQueryKey = () => ["/api/roles"] as const;
export const getListHrUsersQueryKey = () => ["/api/hr-users"] as const;
export const getMasterHrUsersQueryKey = () => ["/api/hr-users/master"] as const;
export const getListAuditLogsQueryKey = (params?: Record<string, string | number>) =>
  ["/api/audit-logs", params] as const;

// ── Roles ─────────────────────────────────────────────────────────────────────

export const listRoles = () => customFetch<Role[]>("/api/roles");

export const useListRoles = <TData = Role[]>(options?: UseQueryOptions<Role[], unknown, TData>) =>
  useQuery<Role[], unknown, TData>({
    queryKey: getListRolesQueryKey(),
    queryFn: listRoles,
    ...options,
  });

export const useCreateRole = () =>
  useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      permissions?: Record<string, PermissionLevel>;
      approvals?: Record<string, boolean> | null;
      category?: "" | "hr_manager" | "hr_assistant";
    }) =>
      customFetch<Role>("/api/roles", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteRole = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/roles/${id}`, { method: "DELETE" }),
  });

export const useUpdateRole = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Role> }) =>
      customFetch<Role>(`/api/roles/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

// ── HR Users ──────────────────────────────────────────────────────────────────

export const listHrUsers = () => customFetch<HrUserItem[]>("/api/hr-users");

export const useListHrUsers = <TData = HrUserItem[]>(options?: UseQueryOptions<HrUserItem[], unknown, TData>) =>
  useQuery<HrUserItem[], unknown, TData>({
    queryKey: getListHrUsersQueryKey(),
    queryFn: listHrUsers,
    ...options,
  });

export const useCreateHrUser = () =>
  useMutation({
    mutationFn: (data: {
      username: string;
      password: string;
      email?: string;
      fullName?: string;
      roleId?: number;
      branchId?: number | null;
      /** Make the new account the Managing Director (clears any branch: the MD is company-wide). */
      isMd?: boolean;
      /** Take the MD identity from the current MD in the same step. */
      replaceMd?: boolean;
      /** Set only here and on update, by the Super Admin; default "admin". */
      category?: "admin" | "hr_manager" | "hr_assistant";
      permissionOverrides?: PermissionOverrides;
    }) =>
      customFetch<HrUserItem>("/api/hr-users", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateHrUser = () =>
  useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<HrUserItem & { password?: string; replaceMd?: boolean }>;
    }) =>
      customFetch<HrUserItem>(`/api/hr-users/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteHrUser = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/hr-users/${id}`, { method: "DELETE" }),
  });

// ── Account Management → Master ───────────────────────────────────────────────
// Restricted to the single ADMIN_USERNAME account; the backend returns 403 for
// anyone else, including other super admins.

export const useMasterHrUsers = <TData = HrUserItem[]>(
  options?: Omit<UseQueryOptions<HrUserItem[], unknown, TData>, "queryKey" | "queryFn">,
) =>
  useQuery<HrUserItem[], unknown, TData>({
    queryKey: getMasterHrUsersQueryKey(),
    queryFn: () => customFetch<HrUserItem[]>("/api/hr-users/master"),
    ...options,
  });

/** Toggles is_hidden / master_features only -never role, branch or password. */
export const useUpdateMasterFlags = () =>
  useMutation({
    mutationFn: ({ id, ...data }: { id: number; isHidden?: boolean; features?: Record<string, boolean> }) =>
      customFetch<HrUserItem>(`/api/hr-users/${id}/master-flags`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

// ── Audit Logs ────────────────────────────────────────────────────────────────

export type AuditLogStats = {
  today: number;
  thisWeek: number;
  total: number;
  byModule: Record<string, number>;
  byAction: Record<string, number>;
  recentUsers: { name: string; at: string }[];
};

export const useAuditLogStats = () =>
  useQuery<AuditLogStats>({
    queryKey: ["/api/audit-logs/stats"],
    queryFn: () => customFetch<AuditLogStats>("/api/audit-logs/stats"),
    refetchInterval: 30000,
  });

export const listAuditLogs = (
  params?: {
    module?: string;
    action?: string;
    userName?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  },
  init?: { signal?: AbortSignal },
) => {
  const qs = new URLSearchParams();
  if (params?.module && params.module !== "all") qs.set("module", params.module);
  if (params?.action && params.action !== "all") qs.set("action", params.action);
  if (params?.userName) qs.set("userName", params.userName);
  if (params?.dateFrom) qs.set("dateFrom", params.dateFrom);
  if (params?.dateTo) qs.set("dateTo", params.dateTo);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const q = qs.toString();
  return customFetch<AuditLogsResponse>(`/api/audit-logs${q ? `?${q}` : ""}`, { signal: init?.signal });
};

export const useListAuditLogs = <TData = AuditLogsResponse>(
  params?: Parameters<typeof listAuditLogs>[0],
  options?: UseQueryOptions<AuditLogsResponse, unknown, TData>,
) => {
  const queryKey = getListAuditLogsQueryKey(params as Record<string, string | number>);
  return useQuery<AuditLogsResponse, unknown, TData>({
    queryKey,
    queryFn: ({ signal }) => listAuditLogs(params, { signal }),
    // a new user-name search keeps the log on screen until its rows arrive; a new page or filter shows the loader
    placeholderData: keepPreviousWhileSearching(queryKey, "userName"),
    ...options,
  });
};

// ── HR Assistant activity (Super Admin + HR Managers) ─────────────────────────

export type HrActivityRow = {
  id: number;
  at: string | null;
  accountId: number | null;
  username: string | null;
  fullName: string | null;
  action: string;
  module: string;
  moduleLabel: string;
  recordId: number | null;
  description: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  ipAddress?: string | null;
};

export type HrActivityAccount = {
  id: number;
  username: string;
  fullName?: string | null;
  roleName?: string | null;
  branchName?: string | null;
  isActive: boolean;
  lastLogin?: string | null;
};

export type HrActivityResponse = {
  category: "hr_assistant" | "hr_manager";
  total: number;
  page: number;
  pageSize: number;
  results: HrActivityRow[];
  summary: { today: number; last7Days: number; approvals: number };
  accounts: HrActivityAccount[];
  modules: { key: string; label: string }[];
  /** Only the Super Admin may switch to the HR Managers' activity. */
  canSeeManagers: boolean;
};

export type HrActivityFilters = {
  category?: "hr_assistant" | "hr_manager";
  accountId?: string;
  module?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page?: number;
  pageSize?: number;
};

export const hrActivityQuery = (f: HrActivityFilters): string => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(f)) {
    if (value !== undefined && value !== null && value !== "" && value !== "all") qs.set(key, String(value));
  }
  const q = qs.toString();
  return `/api/hr-activity${q ? `?${q}` : ""}`;
};

export const useHrActivity = (filters: HrActivityFilters, enabled = true) =>
  useQuery<HrActivityResponse>({
    queryKey: ["/api/hr-activity", filters],
    queryFn: ({ signal }) => customFetch<HrActivityResponse>(hrActivityQuery(filters), { signal }),
    placeholderData: (previous) => previous,
    enabled,
  });

// ── Login Devices ─────────────────────────────────────────────────────────────

export type LoginSessionEntry = {
  id: number;
  hrUserId: number;
  username: string;
  fullName: string;
  roleName?: string | null;
  deviceLabel: string;
  ipAddress?: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
};

export type LoginSessionsResponse = {
  total: number;
  results: LoginSessionEntry[];
};

export const getListLoginSessionsQueryKey = () => ["/api/login-sessions"] as const;

export const useListLoginSessions = (options?: UseQueryOptions<LoginSessionsResponse>) =>
  useQuery<LoginSessionsResponse>({
    queryKey: getListLoginSessionsQueryKey(),
    queryFn: () => customFetch<LoginSessionsResponse>("/api/login-sessions"),
    refetchInterval: 60_000,
    ...options,
  });

export const useRevokeLoginSession = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: number) =>
      customFetch<{ message: string }>(`/api/login-sessions/${sessionId}/revoke`, {
        method: "POST",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getListLoginSessionsQueryKey() }),
  });
};

// ── Mobile App Login ──────────────────────────────────────────────────────────

export type MobileAppLoginEntry = {
  id: number;
  employeeCode: string;
  name: string;
  department: string | null;
  designation: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  employmentType: string;
  /** Has completed Set Password — i.e. an account exists they can log in with. */
  hasPassword: boolean;
  /** Only populated for sign-ins recorded since login tracking was added. */
  lastMobileLoginAt: string | null;
  deviceCount: number;
};

export type MobileAppLoginsResponse = {
  summary: {
    total: number;
    hasAccess: number;
    noAccess: number;
    signedIn: number;
    activeNoAccess: number;
  };
  results: MobileAppLoginEntry[];
};

export type MobileAppLoginFilters = {
  access?: "all" | "has_access" | "no_access" | "signed_in" | "never_signed_in";
  status?: "all" | "active" | "inactive";
  search?: string;
};

export const getMobileAppLoginsQueryKey = (f: MobileAppLoginFilters) =>
  ["/api/mobile-app-logins", f.access ?? "all", f.status ?? "all", f.search ?? ""] as const;

export const useMobileAppLogins = (filters: MobileAppLoginFilters) =>
  useQuery<MobileAppLoginsResponse>({
    queryKey: getMobileAppLoginsQueryKey(filters),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (filters.access) qs.set("access", filters.access);
      if (filters.status) qs.set("status", filters.status);
      if (filters.search) qs.set("search", filters.search);
      return customFetch<MobileAppLoginsResponse>(`/api/mobile-app-logins?${qs}`);
    },
  });

/**
 * Downloads the currently-filtered staff list as .xlsx. Sends the same
 * filters the list is showing, so the file matches what's on screen.
 * Uses a raw fetch rather than customFetch because the response is a binary
 * attachment, not JSON.
 */
export async function downloadMobileAppLoginsExcel(filters: MobileAppLoginFilters): Promise<void> {
  const qs = new URLSearchParams();
  if (filters.access) qs.set("access", filters.access);
  if (filters.status) qs.set("status", filters.status);
  if (filters.search) qs.set("search", filters.search);

  const token = typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;

  const response = await fetch(`${getApiOrigin()}/api/mobile-app-logins/export?${qs}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`Export failed: ${response.statusText}`);

  // Prefer the filename the server chose so the date/filter is baked in.
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"';]+)"?/i);
  const filename = match?.[1] ?? "mobile-app-login.xlsx";

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

/**
 * Sets a new mobile-app password, or clears it so the employee runs Set
 * Password again. There is deliberately no "read password" counterpart —
 * the stored value is a bcrypt hash and cannot be reversed.
 */
export const useResetMobileAppPassword = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, password, clear }: { employeeId: number; password?: string; clear?: boolean }) =>
      customFetch<{ message: string; hasPassword: boolean }>(`/api/mobile-app-logins/${employeeId}/reset-password`, {
        method: "POST",
        body: JSON.stringify(clear ? { clear: true } : { password }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/mobile-app-logins"] }),
  });
};

// ── Mobile App Login → New Version ────────────────────────────────────────────

export type MobileAppVersionEntry = {
  id: number;
  platform: "android";
  /** Dotted number, e.g. "3.0.0". */
  version: string;
  downloadUrl: string;
  releaseNotes: string;
  /** The employee can't dismiss the "New Version Available" prompt until they update. */
  isMandatory: boolean;
  /** Off = withdrawn: the app is no longer told about it. */
  isActive: boolean;
  /** The build the app is currently offering (highest active version). */
  isLatest: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MobileAppVersionInput = {
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
  isMandatory?: boolean;
};

export const MOBILE_APP_VERSIONS_KEY = ["/api/mobile-app/versions"] as const;

export const useMobileAppVersions = () =>
  useQuery<MobileAppVersionEntry[]>({
    queryKey: MOBILE_APP_VERSIONS_KEY,
    queryFn: () => customFetch<MobileAppVersionEntry[]>("/api/mobile-app/versions"),
  });

export const usePublishMobileAppVersion = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MobileAppVersionInput) =>
      customFetch<MobileAppVersionEntry>("/api/mobile-app/versions", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MOBILE_APP_VERSIONS_KEY }),
  });
};

export const useUpdateMobileAppVersion = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...changes }: { id: number } & Partial<MobileAppVersionInput & { isActive: boolean }>) =>
      customFetch<MobileAppVersionEntry>(`/api/mobile-app/versions/${id}`, {
        method: "PUT",
        body: JSON.stringify(changes),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MOBILE_APP_VERSIONS_KEY }),
  });
};

export const useDeleteMobileAppVersion = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/mobile-app/versions/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MOBILE_APP_VERSIONS_KEY }),
  });
};
