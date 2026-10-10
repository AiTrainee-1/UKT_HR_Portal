// Departments / Designations pages: the aggregated endpoints (backend/api/org_structure_views.py) and the two writes the
// generated client does not have. Kept here, not in the shared client, so the pages own their contract.
//
// Query keys all start with the list endpoint's own key ("/api/departments" / "/api/designations"), so the existing
// invalidations (the assignment lookup, the generated delete hook) refresh these views too.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";

/** The head-count figures every row carries: active people by employment type, and everyone not active. */
export type Headcount = {
  activeStaff: number;
  activeProduction: number;
  /** Active, with an employment type that is neither (an old import could leave one). */
  activeOther: number;
  active: number;
  inactive: number;
};

export type DepartmentRow = Headcount & {
  id: number;
  name: string;
  description: string | null;
  branchId: number | null;
  branchName: string | null;
  designationCount: number;
  /** Active heads of department assigned to it. */
  hodCount: number;
  createdAt: string | null;
};

export type BranchRef = { id: number; name: string };

export type Unassigned = { active: number; staff: number; production: number };

export type DepartmentsOverview = {
  departments: DepartmentRow[];
  branches: BranchRef[];
  /** Active employees with no department. */
  unassigned: Unassigned;
};

export type DesignationRow = Headcount & {
  id: number;
  title: string;
  level: string | null;
  departmentId: number | null;
  departmentName: string | null;
  branchId: number | null;
  branchName: string | null;
  createdAt: string | null;
};

export type TreeDepartment = {
  id: number;
  name: string;
  branchId: number | null;
  branchName: string | null;
  /** Active employees in the department, with or without a designation. */
  active: number;
};

export type DesignationsTree = {
  designations: DesignationRow[];
  departments: TreeDepartment[];
  branches: BranchRef[];
  /** Active employees with no designation. */
  unassigned: Unassigned;
};

export type Person = {
  id: number;
  employeeCode: string;
  name: string;
  designationId: number | null;
  designationTitle: string | null;
  departmentId: number | null;
  departmentName: string | null;
  employmentType: string;
  status: string;
};

export type DepartmentPeople = {
  department: { id: number; name: string; branchId: number | null; branchName: string | null };
  employees: Person[];
};

export type DesignationPeople = {
  designation: {
    id: number;
    title: string;
    level: string | null;
    departmentId: number | null;
    departmentName: string | null;
    branchName: string | null;
  };
  employees: Person[];
};

export const overviewKey = () => ["/api/departments", "overview"] as const;
export const departmentPeopleKey = (id: number) => ["/api/departments", "employees", id] as const;
export const treeKey = () => ["/api/designations", "tree"] as const;
export const designationPeopleKey = (id: number) => ["/api/designations", "employees", id] as const;

export const useDepartmentsOverview = () =>
  useQuery({
    queryKey: overviewKey(),
    queryFn: () => customFetch<DepartmentsOverview>("/api/departments/overview"),
  });

export const useDepartmentPeople = (id: number | null) =>
  useQuery({
    queryKey: departmentPeopleKey(id ?? 0),
    queryFn: () => customFetch<DepartmentPeople>(`/api/departments/${id}/employees`),
    enabled: id != null,
  });

export const useDesignationsTree = () =>
  useQuery({
    queryKey: treeKey(),
    queryFn: () => customFetch<DesignationsTree>("/api/designations/tree"),
  });

export const useDesignationPeople = (id: number | null) =>
  useQuery({
    queryKey: designationPeopleKey(id ?? 0),
    queryFn: () => customFetch<DesignationPeople>(`/api/designations/${id}/employees`),
    enabled: id != null,
  });

/** Name and description only: a department never changes branch. */
export const useUpdateDepartment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, description }: { id: number; name: string; description: string }) =>
      customFetch<{ id: number; name: string }>(`/api/departments/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name, description }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/designations"] });
    },
  });
};

export const useUpdateDesignation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      title,
      departmentId,
      level,
    }: {
      id: number;
      title: string;
      departmentId: number | null;
      level: string;
    }) =>
      customFetch<{ id: number; title: string }>(`/api/designations/${id}`, {
        method: "PUT",
        body: JSON.stringify({ title, departmentId, level }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/designations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
    },
  });
};

/** Refresh everything an assignment change touches: both pages' figures and the employee lists. */
export function useRefreshOrg() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/designations"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] }),
    ]);
}

/** The message the backend sent with an error ({"error": "..."}), or undefined. */
export function errorMessage(e: unknown): string | undefined {
  if (e instanceof Error && e.message) {
    // ApiError builds "HTTP 400 Bad Request: <message>"; keep just the message when there is one
    const m = /^HTTP \d+ [^:]*: (.+)$/s.exec(e.message);
    return m ? m[1] : e.message;
  }
  return undefined;
}
