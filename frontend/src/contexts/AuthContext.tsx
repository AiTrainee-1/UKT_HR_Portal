import React, { createContext, useContext, useState, useEffect } from "react";
import { useGetMe, getGetMeQueryKey } from "@/lib/api-client";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useQueryClient } from "@tanstack/react-query";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { resolvePermission, resolvePermissionOrChildren, ROUTE_OR_MODULES } from "@/lib/permission-modules";

type Role = "hr" | "employee";

interface UserInfo {
  role: Role;
  employeeId: number | null;
  name?: string;
  isSuperAdmin?: boolean;
  /** The single ADMIN_USERNAME account -narrower than isSuperAdmin.
   *  Gates Account Management → Master. */
  isMasterAdmin?: boolean;
  permissions?: Record<string, PermissionLevel>;
  branchId?: number | null;
  branchName?: string | null;
}

export type { PermissionLevel };

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
  if (orKeys) return orKeys.some((k) => canView(user, k));
  return moduleKey ? canViewPage(user, moduleKey) : true;
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
  return moduleKey ? permissionLevel(user, moduleKey) === "view" : false;
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
    permissions: (me as { permissions?: Record<string, PermissionLevel> }).permissions,
    branchId: (me as { branchId?: number | null }).branchId ?? null,
    branchName: (me as { branchName?: string | null }).branchName ?? null,
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
