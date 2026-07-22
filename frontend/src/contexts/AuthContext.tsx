import React, { createContext, useContext, useState, useEffect } from "react";
import { useGetMe, getGetMeQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { resolvePermission, resolvePermissionOrChildren } from "@/lib/permission-modules";

type Role = "hr" | "employee";

interface UserInfo {
  role: Role;
  employeeId: number | null;
  name?: string;
  isSuperAdmin?: boolean;
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
// whose tabs share one route with no routes of their own) — true if the
// user can view/edit the module itself OR any of its MODULE_TREE children.
// See resolvePermissionOrChildren for why this differs from canView.
export function canViewPage(user: UserInfo | null, moduleKey: string): boolean {
  if (!user || user.role !== "hr") return true;
  if (user.isSuperAdmin) return true;
  const level = resolvePermissionOrChildren(user.permissions, moduleKey);
  return level === "view" || level === "edit";
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
    localStorage.removeItem("uk_textile_token");
    setToken(null);
    queryClient.clear();
  };

  const user: UserInfo | null = me ? {
    role: me.role as Role,
    employeeId: me.employeeId || null,
    name: me.name,
    isSuperAdmin: (me as { isSuperAdmin?: boolean }).isSuperAdmin,
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
