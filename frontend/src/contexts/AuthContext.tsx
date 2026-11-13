import React, { createContext, useContext, useState, useEffect } from "react";
import { useGetMe, getGetMeQueryKey } from "@/lib/api-client";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useQueryClient } from "@tanstack/react-query";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import {
  hasOwnSetting,
  legacyCanView,
  legacyRouteKey,
  resolvePermission,
  resolvePermissionOrChildren,
  ROUTE_OR_MODULES,
} from "@/lib/permission-modules";
import { canApprove as canApproveKind, type Category, type DisplayCategory } from "@/lib/hr-access";

type Role = "hr" | "employee";

interface UserInfo {
  role: Role;
  employeeId: number | null;
  name?: string;
  isSuperAdmin?: boolean;
  /** The single ADMIN_USERNAME account -narrower than isSuperAdmin.
   *  Gates Account Management → Master. */
  isMasterAdmin?: boolean;
  /** The Managing Director: opens the executive portal (/md/*). Decided by the server (/auth/me), never by the token. */
  isMd?: boolean;
  /** What the account may do in each module: its role's permissions and, for the MD, the access the MD portal's pages need. */
  permissions?: Record<string, PermissionLevel>;
  /** The role's own permissions, without the MD's added access: whether the account has an HR role at all. */
  rolePermissions?: Record<string, PermissionLevel>;
  branchId?: number | null;
  branchName?: string | null;
  /** The account category (Admin / HR Manager / HR Assistant), read from the database by /auth/me (lib/hr-access.ts). */
  category?: Category;
  /** The category, or "super_admin" / "md" for those two accounts. */
  displayCategory?: DisplayCategory;
  categoryLabel?: string;
  /** "explicit": the approvals below decide; "legacy": approve = edit on the module, as always (an older backend: unset). */
  approvalMode?: "explicit" | "legacy";
  /** {request kind: may approve / reject}, after role, the account's own changes and the HR Assistant locks. */
  approvals?: Record<string, boolean>;
  /** The kinds this account can never approve (HR Assistants: missing punches and attendance edits). */
  lockedApprovals?: string[];
}

export type { PermissionLevel };

/** May the signed-in account approve / reject this kind of request ("leave", "missing_punch", ...)? See lib/hr-access.ts. */
export function canApprove(user: UserInfo | null, kind: string): boolean {
  return canApproveKind(user, kind);
}

// Cascading + fail-closed, mirroring backend permission_middleware.py: a
// submodule with no explicit entry inherits its parent's level, and a
// module missing from the whole chain defaults to "hidden".
export function permissionLevel(user: UserInfo | null, moduleKey: string): PermissionLevel {
  if (!user || user.role !== "hr") return "edit";
  if (user.isSuperAdmin) return "edit";
  return resolvePermission(user.permissions, moduleKey);
}

export function canView(user: UserInfo | null, moduleKey: string): boolean {
  const level = permissionLevel(user, moduleKey);
  return level === "view" || level === "edit";
}

export function canEdit(user: UserInfo | null, moduleKey: string): boolean {
  return permissionLevel(user, moduleKey) === "edit";
}

// Route-level reachability for a single-page parent module (e.g. "settings",
// whose tabs share one route with no routes of their own) -true if the
// user can view/edit the module itself OR any of its MODULE_TREE children.
// See resolvePermissionOrChildren for why this differs from canView.
export function canViewPage(user: UserInfo | null, moduleKey: string): boolean {
  if (!user || user.role !== "hr") return true;
  if (user.isSuperAdmin) return true;
  const level = resolvePermissionOrChildren(user.permissions, moduleKey);
  return level === "view" || level === "edit";
}

// Route-level reachability for a page whose sub-tabs each carry their own
// unrelated flat module key (see ROUTE_OR_MODULES -e.g. Staff Payroll's
// Payroll/Salary/Payslip tabs, still gated by "payroll"/"salary"/
// "salary_slip"). Reachable if any of those keys is visible, same spirit as
// canViewPage but for siblings instead of MODULE_TREE parent+children.
export function canViewRoute(user: UserInfo | null, path: string, moduleKey: string | null): boolean {
  const orKeys = ROUTE_OR_MODULES[path];
  if (orKeys) return orKeys.some((k) => canViewPage(user, k));
  if (!moduleKey) return true;
  if (canViewPage(user, moduleKey)) return true;
  // An address that had its section's key before 2026-11-11 (/hr/employees/new was "employees"): while the role sets
  // nothing on the new key's own chain, the old rule still decides, so no existing role loses or gains a page.
  const legacy = legacyRouteKey(path, moduleKey);
  if (legacy && user && user.role === "hr" && !hasOwnSetting(user.permissions, moduleKey, legacy)) {
    return legacyCanView(user.permissions, legacy);
  }
  return false;
}

// Like permissionLevel(...) === "view", but for a ROUTE_OR_MODULES page: the
// page-wide view-only banner/lock should only fire if none of the sub-tab
// keys grant edit (an editable sub-tab means the page-wide lock would be
// wrong for that tab -per-tab locking, e.g. StaffPayroll's own tabLevel
// check, is what actually governs each tab in that case).
export function isRouteViewOnly(user: UserInfo | null, path: string, moduleKey: string | null): boolean {
  const orKeys = ROUTE_OR_MODULES[path];
  if (orKeys) {
    const levels = orKeys.map((k) => permissionLevel(user, k));
    return !levels.includes("edit") && levels.includes("view");
  }
  if (!moduleKey || permissionLevel(user, moduleKey) !== "view") return false;
  // A part of this page set to Edit on its own (a tab, a sub-tab): the page-wide lock would lock it too, so the page
  // locks its View-only parts itself instead (lib/tab-access.tsx; Settings: settingsTabLevel).
  return !hasEditablePart(user, moduleKey);
}

/** Is a part of `moduleKey` (a key under it) set to Edit on its own for this login? */
export function hasEditablePart(user: UserInfo | null, moduleKey: string): boolean {
  if (!user || user.role !== "hr" || user.isSuperAdmin || !user.permissions) return false;
  const prefix = `${moduleKey}.`;
  return Object.entries(user.permissions).some(([k, v]) => k.startsWith(prefix) && v === "edit");
}

interface AuthContextType {
  token: string | null;
  user: UserInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string, role: Role, employeeId: number | null, name?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** The category / approval fields of /auth/me (an older backend sends none of them: every field stays unset). */
function accessOf(me: unknown): Partial<UserInfo> {
  const m = me as Partial<UserInfo>;
  return {
    category: m.category,
    displayCategory: m.displayCategory,
    categoryLabel: m.categoryLabel,
    approvalMode: m.approvalMode,
    approvals: m.approvals,
    lockedApprovals: m.lockedApprovals,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("uk_textile_token");
    }
    return null;
  });

  const queryClient = useQueryClient();

  const { data: me, isLoading: meLoading, error } = useGetMe({
    query: {
      enabled: !!token,
      queryKey: getGetMeQueryKey(),
      retry: false,
    }
  });

  useEffect(() => {
    if (error) {
      // If the token is invalid, clear it
      logout();
    }
  }, [error]);

  const login = (newToken: string, role: Role, employeeId: number | null, name?: string) => {
    localStorage.setItem("uk_textile_token", newToken);
    setToken(newToken);
    // Invalidate the 'me' query to fetch the new user details
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };

  const logout = () => {
    // Best-effort -revokes the LoginSession row so the device disappears
    // from the Login Devices page immediately instead of lingering "active"
    // until the JWT's own 12h expiry. Never blocks local logout on this.
    if (token) {
      customFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    }
    localStorage.removeItem("uk_textile_token");
    setToken(null);
    queryClient.clear();
  };

  const user: UserInfo | null = me ? {
    role: me.role as Role,
    employeeId: me.employeeId || null,
    name: me.name,
    isSuperAdmin: (me as { isSuperAdmin?: boolean }).isSuperAdmin,
    isMasterAdmin: (me as { isMasterAdmin?: boolean }).isMasterAdmin,
    isMd: (me as { isMd?: boolean }).isMd,
    permissions: (me as { permissions?: Record<string, PermissionLevel> }).permissions,
    rolePermissions: (me as { rolePermissions?: Record<string, PermissionLevel> }).rolePermissions,
    branchId: (me as { branchId?: number | null }).branchId ?? null,
    branchName: (me as { branchName?: string | null }).branchName ?? null,
    ...accessOf(me),
  } : null;

  const value = {
    token,
    user,
    isAuthenticated: !!token && !!user,
    isLoading: !!token && meLoading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
