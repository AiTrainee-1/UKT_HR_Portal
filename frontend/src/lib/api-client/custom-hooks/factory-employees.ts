// factory-employees: hooks/types for the Factory Employees page (/hr/employees/factory-emp, owner 2026-11-20), see ./index.ts.
//
// Drivers, housekeeping, chefs, security and other factory support staff. A factory employee is an ORDINARY employee (same
// record, attendance and payroll) marked as factory, with an optional label (Driver, Housekeeping...). The server
// (backend/api/factory_employee_views.py, permission key `employees.factory`, everything branch-scoped) answers:
//
//   GET    /api/employees/factory?status=&labelId=&search=&departmentId=&designationId=&employmentType=
//          {employees, labels, counts, canEdit}; the counts ignore labelId
//   POST   /api/employees/factory                  a NEW employee (the employee create body + labelId): 201 = the row
//   GET    /api/employees/factory/candidates?search=   employees not in Factory Employees yet (max 50, active first)
//   POST   /api/employees/factory/add              {employeeIds, labelId?} -> {updated}
//   POST   /api/employees/factory/remove           {employeeIds} -> {updated} (they stay ordinary employees)
//   POST   /api/employees/factory/label            {employeeIds, labelId|null} -> {updated}
//   GET    /api/employees/factory/labels           {labels}
//   POST   /api/employees/factory/labels           {name, color?, description?} -> 201 label
//   PATCH  /api/employees/factory/labels/<id>      {name?, color?, description?, sortOrder?} -> label
//   DELETE /api/employees/factory/labels/<id>[?unassign=1]   204; 409 {error, employees} while employees carry it
//   GET    /api/employees/factory/<id>/history     {items: [{at, by, action, module, description}]}, newest first
//   GET    /api/employees/factory/shifts           every existing shift with the active factory employees on it, and those
//                                                  on none (owner 2026-11-20: shifts are only assigned / removed here)
//   POST   /api/employees/factory/shifts/plan      {shiftId, employeeIds, effectiveFrom?, saturdayOff?} -> the planner preview
//   POST   /api/employees/factory/shifts/apply     (same body) -> the planner result with `applied`; 400 with its errors
//   POST   /api/employees/factory/shifts/remove    {employeeIds, lastDay?} -> {ended, cancelled}
//   POST   /api/employees/factory/payroll          {employeeIds, category, payCycle (production), salaryAmount? +
//                                                  salaryBreakup? | salaryPerShift?, confirm?, reason?} -> {updated, refused,
//                                                  cleared}; 400 without a production frequency; 409 confirm_cycle_change
//
// Staff Payroll is monthly; Production Payroll is paid on the chosen frequency's cycle (Weekly, BiWeekly or Monthly).
// Shifts and payroll are this page's own (key employees.factory). Editing an employee's personal details and their status
// go through the existing employee endpoints (their own keys); those two writes are typed here too.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { SalaryBreakup } from "../generated/api.schemas";
import type { PlanResult } from "./shifts";

/** The payroll an employee is in: staff -> Staff Payroll (monthly salary), production -> Production Payroll (per shift). */
export type FactoryPayrollCategory = "staff" | "production";
export type FactoryStatusFilter = "active" | "inactive" | "all";
export type FactoryPayCycle = "weekly" | "biweekly" | "monthly";

/** The shift an employee is on today (custom hours already applied), or null. */
export type FactoryShift = {
  assignmentId: number;
  shiftId: number;
  name: string;
  startTime: string | null;
  endTime: string | null;
  effectiveFrom: string | null;
  saturdayOff: boolean;
};

export type FactoryEmployee = {
  id: number;
  code: string;
  name: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  employmentType: FactoryPayrollCategory | string;
  status: string;
  isFactory?: boolean;
  labelId: number | null;
  label: string | null;
  labelColor: string | null;
  departmentId: number | null;
  /** The department's name ("" or null when none). */
  department: string | null;
  designationId: number | null;
  designation: string | null;
  branchId: number | null;
  unit: string | null;
  joinDate: string | null;
  /** Staff Payroll: the monthly salary. */
  salaryAmount: number | null;
  /** Production Payroll: the salary per shift. */
  salaryPerShift: number | null;
  /** Production Payroll: the pay cycle, null = in no Production Payroll yet. */
  productionPayCycle: FactoryPayCycle | null;
  shift: FactoryShift | null;
  payrollReady: boolean;
  /** What keeps them out of their payroll: "No monthly salary", "No salary per shift", "No pay cycle ..." (null = ready). */
  payrollIssue: string | null;
  /** Only on a create: names that could not be used (an unknown branch...). */
  warnings?: string[];
};

export type FactoryLabel = {
  id: number;
  name: string;
  /** "#rrggbb". */
  color: string;
  description: string | null;
  /** Factory employees carrying it. */
  employees?: number;
  sortOrder: number;
};

export type FactoryCounts = {
  total: number;
  active: number;
  inactive: number;
  unlabeled: number;
  /** label id (as text) -> employees with it. */
  byLabel: Record<string, number>;
};

export type FactoryEmployeesResult = {
  employees: FactoryEmployee[];
  labels: FactoryLabel[];
  counts: FactoryCounts;
  /** Whether this login may change the page (employees.factory: edit). */
  canEdit: boolean;
};

export type FactoryFilters = {
  status: FactoryStatusFilter;
  /** A label's id, "none" = without a label; left out = every label. */
  labelId?: number | "none";
  search?: string;
  departmentId?: number;
  designationId?: number;
  employmentType?: FactoryPayrollCategory;
};

export type FactoryCandidate = {
  id: number;
  code: string;
  name: string;
  employmentType: string;
  department: string | null;
  designation: string | null;
  status: string;
};

export type FactoryHistoryItem = {
  at: string | null;
  by: string | null;
  action: string;
  module: string;
  description: string;
};

/** The employee record as GET /api/employees/<id> sends it: what the page's edit form reads. */
export type FactoryEmployeeRecord = {
  id: number;
  employeeCode: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  gender?: string | null;
  employmentType?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  designationId?: number | null;
  designationTitle?: string | null;
  branchId?: number | null;
  branchName?: string | null;
  salaryType?: string | null;
  salaryAmount?: number | null;
  salaryBreakup?: SalaryBreakup | null;
  salaryPerShift?: number | null;
  status?: string | null;
  joinDate?: string | null;
};

export const FACTORY_API = "/api/employees/factory";

export const getFactoryEmployeesQueryKey = (filters?: FactoryFilters) => [FACTORY_API, filters ?? null] as const;
export const getFactoryLabelsQueryKey = () => [`${FACTORY_API}/labels`] as const;
export const getFactoryCandidatesQueryKey = (search: string) => [`${FACTORY_API}/candidates`, search] as const;
export const getFactoryHistoryQueryKey = (id: number) => [`${FACTORY_API}/history`, id] as const;
/** The same key the generated useGetEmployee uses, so an edit here refreshes the profile page too. */
export const getFactoryEmployeeRecordQueryKey = (id: number) => [`/api/employees/${id}`] as const;

/** The list request's query string: "all" filters and a blank search are left out. */
export function factoryQueryString(filters: FactoryFilters): string {
  const qs = new URLSearchParams();
  qs.set("status", filters.status);
  if (filters.labelId !== undefined) qs.set("labelId", String(filters.labelId));
  const search = filters.search?.trim();
  if (search) qs.set("search", search);
  if (filters.departmentId) qs.set("departmentId", String(filters.departmentId));
  if (filters.designationId) qs.set("designationId", String(filters.designationId));
  if (filters.employmentType) qs.set("employmentType", filters.employmentType);
  return qs.toString();
}

const keyStartsWith = (prefix: string) => (q: { queryKey: readonly unknown[] }) =>
  typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(prefix);

/** Every Factory Employees list, label list, candidate search and history. */
export const invalidateFactory = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ predicate: keyStartsWith(FACTORY_API) });

/** Everything about employees: this page, All Employees, the profile, the production lists. */
export const invalidateEmployeeData = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/employees") });

// ── reads ──

export const useFactoryEmployees = (filters: FactoryFilters, options?: { enabled?: boolean }) =>
  useQuery({
    queryKey: getFactoryEmployeesQueryKey(filters),
    queryFn: () => customFetch<FactoryEmployeesResult>(`${FACTORY_API}?${factoryQueryString(filters)}`),
    placeholderData: keepPreviousData,
    enabled: options?.enabled ?? true,
  });

export const useFactoryLabels = (options?: { enabled?: boolean }) =>
  useQuery({
    queryKey: getFactoryLabelsQueryKey(),
    queryFn: () => customFetch<{ labels: FactoryLabel[] }>(`${FACTORY_API}/labels`),
    enabled: options?.enabled ?? true,
  });

export const useFactoryCandidates = (search: string, enabled = true) =>
  useQuery({
    queryKey: getFactoryCandidatesQueryKey(search.trim()),
    queryFn: ({ signal }) => {
      const text = search.trim();
      return customFetch<{ employees: FactoryCandidate[] }>(
        `${FACTORY_API}/candidates${text ? `?${new URLSearchParams({ search: text })}` : ""}`,
        { signal },
      );
    },
    enabled,
    placeholderData: keepPreviousData,
  });

export const useFactoryHistory = (id: number | null) =>
  useQuery({
    queryKey: getFactoryHistoryQueryKey(id ?? 0),
    queryFn: () => customFetch<{ items: FactoryHistoryItem[] }>(`${FACTORY_API}/${id}/history`),
    enabled: id !== null,
  });

/** One existing shift and the active factory employees on it. */
export type FactoryShiftMember = {
  id: number;
  code: string;
  name: string;
  employmentType: string;
  assignmentId: number;
  effectiveFrom: string | null;
  /** Set once they were taken off: on the shift up to and including this day. */
  effectiveTo: string | null;
};

export type FactoryShiftGroup = {
  id: number;
  name: string;
  shiftType: FactoryPayrollCategory;
  startTime: string | null;
  endTime: string | null;
  graceMinutes: number | null;
  genderRule: string;
  employees: FactoryShiftMember[];
};

export type FactoryShiftsResult = {
  shifts: FactoryShiftGroup[];
  noShift: { id: number; code: string; name: string; employmentType: string }[];
  canEdit: boolean;
};

/** The body of a shift plan / apply: these factory employees on this shift from a day. */
export type FactoryShiftBody = { shiftId: number; employeeIds: number[]; effectiveFrom: string; saturdayOff: boolean };

export const getFactoryShiftsQueryKey = () => [`${FACTORY_API}/shifts`] as const;

export const useFactoryShifts = (options?: { enabled?: boolean }) =>
  useQuery({
    queryKey: getFactoryShiftsQueryKey(),
    queryFn: () => customFetch<FactoryShiftsResult>(`${FACTORY_API}/shifts`),
    enabled: options?.enabled ?? true,
  });

/** The preview of an assignment (re-asked when the body changes; the last answer stays meanwhile). */
export const useFactoryShiftPlan = (body: FactoryShiftBody, enabled: boolean) =>
  useQuery({
    queryKey: [`${FACTORY_API}/shifts/plan`, body],
    queryFn: () =>
      customFetch<PlanResult>(`${FACTORY_API}/shifts/plan`, { method: "POST", body: JSON.stringify(body) }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 30_000,
  });

export const useFactoryEmployeeRecord = (id: number | null) =>
  useQuery({
    queryKey: getFactoryEmployeeRecordQueryKey(id ?? 0),
    queryFn: () => customFetch<FactoryEmployeeRecord>(`/api/employees/${id}`),
    enabled: id !== null,
    // the form is filled once from what the server has now
    staleTime: 0,
  });

// ── writes ──

const post = <T>(url: string, body: unknown, method = "POST") =>
  customFetch<T>(url, { method, body: JSON.stringify(body) });

/** POST /api/employees/factory: the employee create body (see NewEmployee.tsx) plus `labelId`. */
export const useCreateFactoryEmployee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => post<FactoryEmployee>(FACTORY_API, body),
    onSuccess: () => void invalidateEmployeeData(queryClient),
  });
};

/** Who moved department / designation because of a label (owner 2026-11-20: the label IS the employee's department and
 *  designation everywhere): "department ADMIN -> DRIVER, designation MIS -> DRIVER". */
export type FactoryMoved = { employeeId: number; code: string; what: string };

export type FactoryLabelResult = { updated: number; moved?: FactoryMoved[] };

/** A label changes departments and designations across the HRMS: every employee list and both org pages refresh. */
const invalidateLabelEffects = (queryClient: QueryClient) =>
  Promise.all([
    invalidateEmployeeData(queryClient),
    queryClient.invalidateQueries({ predicate: keyStartsWith("/api/departments") }),
    queryClient.invalidateQueries({ predicate: keyStartsWith("/api/designations") }),
  ]);

export const useAddFactoryEmployees = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { employeeIds: number[]; labelId?: number | null }) =>
      post<FactoryLabelResult>(`${FACTORY_API}/add`, body),
    onSuccess: () => void invalidateLabelEffects(queryClient),
  });
};

export const useRemoveFactoryEmployees = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { employeeIds: number[] }) => post<{ updated: number }>(`${FACTORY_API}/remove`, body),
    onSuccess: () => void invalidateFactory(queryClient),
  });
};

export const useSetFactoryLabel = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { employeeIds: number[]; labelId: number | null }) =>
      post<FactoryLabelResult>(`${FACTORY_API}/label`, body),
    onSuccess: () => void invalidateLabelEffects(queryClient),
  });
};

export type FactoryLabelInput = { name?: string; color?: string; description?: string; sortOrder?: number };

export const useCreateFactoryLabel = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FactoryLabelInput) => post<FactoryLabel>(`${FACTORY_API}/labels`, body),
    onSuccess: () => void invalidateFactory(queryClient),
  });
};

/** One label's changes; several (a reorder) are sent one after the other and the lists refreshed once. */
export const useUpdateFactoryLabels = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (changes: { id: number; data: FactoryLabelInput }[]) => {
      const out: FactoryLabel[] = [];
      for (const { id, data } of changes)
        out.push(await post<FactoryLabel>(`${FACTORY_API}/labels/${id}`, data, "PATCH"));
      return out;
    },
    // a renamed label renames its department and designation
    onSettled: () => void invalidateLabelEffects(queryClient),
  });
};

/** DELETE a label. Without `unassign` the server answers 409 {error, employees} while anyone still has it. */
export const useDeleteFactoryLabel = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, unassign }: { id: number; unassign?: boolean }) =>
      customFetch<void>(`${FACTORY_API}/labels/${id}${unassign ? "?unassign=1" : ""}`, { method: "DELETE" }),
    onSuccess: () => void invalidateFactory(queryClient),
  });
};

/** Shift assignments touch attendance everywhere: the page's lists and Manage Shifts' own. */
const invalidateShifts = (queryClient: QueryClient) =>
  Promise.all([
    invalidateFactory(queryClient),
    queryClient.invalidateQueries({ predicate: keyStartsWith("/api/shift") }),
  ]);

export const useApplyFactoryShift = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FactoryShiftBody) => post<PlanResult>(`${FACTORY_API}/shifts/apply`, body),
    onSuccess: () => void invalidateShifts(queryClient),
  });
};

export const useRemoveFactoryShift = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { employeeIds: number[]; lastDay?: string }) =>
      post<{ ended: number; cancelled: number }>(`${FACTORY_API}/shifts/remove`, body),
    onSuccess: () => void invalidateShifts(queryClient),
  });
};

export type FactoryPayrollBody = {
  employeeIds: number[];
  category: FactoryPayrollCategory;
  /** Required for Production Payroll; Staff Payroll is monthly. */
  payCycle?: FactoryPayCycle;
  salaryAmount?: number;
  salaryBreakup?: Record<string, string>;
  salaryPerShift?: number;
  confirm?: boolean;
  reason?: string;
};

export type FactoryPayrollResult = {
  updated: FactoryEmployee[];
  refused: { employeeId: number; code: string; name: string; reason: string }[];
  /** A department / designation of the other kind that had to be removed. */
  cleared: { employeeId: number; code: string; what: string }[];
  /** Moved to their label's department / designation of the new kind. */
  moved?: FactoryMoved[];
};

/** POST /api/employees/factory/payroll: the payroll category, frequency and amount of one or many factory employees. */
export const useSetFactoryPayroll = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FactoryPayrollBody) => post<FactoryPayrollResult>(`${FACTORY_API}/payroll`, body),
    onSuccess: () => {
      void invalidateLabelEffects(queryClient);
      void queryClient.invalidateQueries({ predicate: keyStartsWith("/api/payroll/production") });
      void queryClient.invalidateQueries({ predicate: keyStartsWith("/api/shift") });
    },
  });
};

/** PATCH /api/employees/<id> (the Edit Employee endpoint; permission `employees`). */
export const useUpdateFactoryEmployee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      post<FactoryEmployeeRecord>(`/api/employees/${id}`, data, "PATCH"),
    onSuccess: () => void invalidateEmployeeData(queryClient),
  });
};

/** PATCH /api/employees/<id>/status for each employee (permission `employees.status`); the failures are returned. */
export const useSetFactoryEmployeeStatus = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, status }: { ids: number[]; status: "active" | "inactive" }) => {
      const failed: { id: number; error: unknown }[] = [];
      let updated = 0;
      for (const id of ids) {
        try {
          await post(`/api/employees/${id}/status`, { status }, "PATCH");
          updated++;
        } catch (error) {
          failed.push({ id, error });
        }
      }
      return { updated, failed };
    },
    onSettled: () => void invalidateEmployeeData(queryClient),
  });
};
