import React, { createContext, useContext, useState, useEffect } from "react";
import { useGetMe, getGetMeQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";

type Role = "hr" | "employee";

interface UserInfo {
  role: Role;
  employeeId: number | null;
  name?: string;
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
    name: me.name
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
