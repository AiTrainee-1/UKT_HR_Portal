import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import { scopeQuery, type PayrollKind, type PayrollScope } from "./payroll-insights";
import type { PayCycle } from "./production-cycles";

// The Excess tab of Staff Payroll (owner 2026-11-20, permission key `salary`) and of every Production Payroll cycle page
// (key `production_payroll.salary`): amounts HR adds to ("Excess") or takes off ("Detection") an employee's earned salary
// for one payroll month (staff) or one pay period (production), each with a mandatory remark and a full history.
// Backend prefixes /api/payroll-excess/ (staff) and /api/production-payroll-excess/ (production). Adding, changing or
// removing an entry updates an already generated payroll at once (bonus and NET), so every change here reloads the payroll
// figures on screen too.

export type ExcessKind = "excess" | "detection";
/** manual = one employee, bulk = the same amount for several, migrated = a bonus that was on a payroll before this tab. */
export type ExcessSource = "manual" | "bulk" | "migrated";
export type ExcessAction = "added" | "changed" | "removed";

/** The pay period of a production entry (null on a staff entry). */
type PeriodKeys = { cycle?: PayCycle | null; periodStart?: string | null; periodEnd?: string | null };

export type ExcessEntry = PeriodKeys & {
  id: number;
  employeeId: number;
  kind: ExcessKind;
  amount: number;
  remark: string;
  source: ExcessSource;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** One employee of the month / period with at least one entry. */
export type ExcessEmployeeRow = {
  employeeId: number;
  code: string;
  name: string;
  designation: string | null;
  department: string | null;
  excess: number;
  detection: number;
  /** excess - detection. */
  net: number;
  /** The month's (period's) payroll row, or null when it is not generated yet. */
  payrollId: number | null;
  /** In the Records list (false: not generated / held / parked new joiner). */
  inPayroll: boolean;
  /** Before Excess / Detection: staff payroll gross + OT, production the period's gross (shifts x rate). Null: no payroll. */
  earnedSalary: number | null;
  /** earnedSalary + net (null when no payroll). */
  earnedWithExcess: number | null;
  /** The payroll's NET (null when no payroll). */
  netPay: number | null;
  /** This employee's active entries of the month / period, newest first. */
  entries: ExcessEntry[];
};

export type ExcessDepartment = {
  departmentId: number | null;
  department: string;
  unit: string | null;
  employees: number;
  excessTotal: number;
  detectionTotal: number;
  net: number;
  rows: ExcessEmployeeRow[];
};

/** An employee of the caller's scope, for the picker. An ineligible one carries the reason and is never selectable. */
export type ExcessEmployeeOption = {
  id: number;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  eligible: boolean;
  reason: string | null;
};

export type ExcessSummary = {
  employees: number;
  entries: number;
  excessTotal: number;
  detectionTotal: number;
  net: number;
};

/** What the Excess tab shows for one staff month or one production period (the production answer adds its period). */
export type PayrollExcessData = PeriodKeys & {
  /** Staff only (a production answer may leave them out). */
  month?: number;
  year?: number;
  /** "November 2026", or "Weekly 02 Nov - 08 Nov 2026". */
  periodLabel: string;
  /** Payroll Done: no change at all (the server answers 409). */
  locked: boolean;
  lockedMessage: string | null;
  /** Any payroll generated for the month / period (amounts are applied when it is). */
  payrollGenerated: boolean;
  /** May this login add, change and remove (the tab's key at Edit). */
  canEdit: boolean;
  summary: ExcessSummary;
  /** Only departments with entries, sorted by name; rows by code. */
  departments: ExcessDepartment[];
  employeeOptions: ExcessEmployeeOption[];
};

/** The staff answer (GET /api/payroll-excess/month). */
export type PayrollExcessMonth = PayrollExcessData & { month: number; year: number };

export type ExcessRefused = { employeeId: number; code: string; name: string; reason: string };

export type AddExcessBody = {
  /** The staff month or production period the amount is for. */
  scope: PayrollScope;
  kind: ExcessKind;
  amount: number;
  remark: string;
  employeeIds: number[];
};

export type AddExcessResult = { created: ExcessEntry[]; refused: ExcessRefused[]; payrollUpdated: number };
export type ChangeExcessBody = { id: number; amount: number; remark: string };
export type ChangeExcessResult = { entry: ExcessEntry; payrollUpdated: boolean };
export type RemoveExcessBody = { entryIds: number[]; remark: string };
export type RemoveExcessResult = { removed: number; payrollUpdated: number };

export type ExcessHistoryItem = PeriodKeys & {
  id: number;
  entryId: number;
  employeeId: number;
  code: string;
  name: string;
  department: string | null;
  /** The month of a staff item; a production item names its period (and its month may be left out). */
  month?: number | null;
  year?: number | null;
  kind: ExcessKind;
  action: ExcessAction;
  source: ExcessSource;
  /** null for "added". */
  previousAmount: number | null;
  /** null for "removed". */
  newAmount: number | null;
  remark: string;
  by: string | null;
  at: string;
  /** null when no payroll was touched. */
  payrollNetBefore: number | null;
  payrollNetAfter: number | null;
};

export type ExcessHistoryPage = { items: ExcessHistoryItem[]; total: number; page: number; pageSize: number };

/**
 * Staff: month + year (both empty = every month). Production: the cycle (always) and the period (both ends empty = every
 * period of the cycle).
 */
export type ExcessHistoryFilters = {
  month?: number | null;
  year?: number | null;
  cycle?: PayCycle | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  departmentId?: number | null;
  employeeId?: number | null;
  kind?: ExcessKind | null;
  action?: ExcessAction | null;
  page?: number;
  pageSize?: number;
};

export const PAYROLL_EXCESS_PREFIX = "/api/payroll-excess";
export const PRODUCTION_EXCESS_PREFIX = "/api/production-payroll-excess";

/** The API prefix of a payroll kind. */
export const excessPrefix = (kind: PayrollKind): string =>
  kind === "production" ? PRODUCTION_EXCESS_PREFIX : PAYROLL_EXCESS_PREFIX;

/** `/api/payroll-excess/month?month=11&year=2026` or `/api/production-payroll-excess/period?cycle=weekly&periodStart=...`. */
export const payrollExcessUrl = (scope: PayrollScope): string =>
  `${excessPrefix(scope.kind)}/${scope.kind === "staff" ? "month" : "period"}?${scopeQuery(scope)}`;

/** Staff keys hold the month, production keys the cycle and the period, so two periods never share a cache entry. */
export const getPayrollExcessQueryKey = (scope: PayrollScope) =>
  scope.kind === "staff"
    ? ([`${PAYROLL_EXCESS_PREFIX}/month`, { month: scope.month, year: scope.year }] as const)
    : ([
        `${PRODUCTION_EXCESS_PREFIX}/period`,
        { cycle: scope.cycle, periodStart: scope.periodStart, periodEnd: scope.periodEnd },
      ] as const);

export const getPayrollExcessMonthQueryKey = (month: number, year: number) =>
  getPayrollExcessQueryKey({ kind: "staff", month, year });

export const getPayrollExcessHistoryQueryKey = (kind: PayrollKind, filters: ExcessHistoryFilters) =>
  [`${excessPrefix(kind)}/history`, filters] as const;

/** The history endpoint's query string; empty filters are left out. */
export function excessHistoryQueryString(filters: ExcessHistoryFilters): string {
  const qs = new URLSearchParams();
  const put = (key: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") qs.set(key, String(value));
  };
  if (filters.month && filters.year) {
    put("month", filters.month);
    put("year", filters.year);
  }
  put("cycle", filters.cycle);
  if (filters.periodStart && filters.periodEnd) {
    put("periodStart", filters.periodStart);
    put("periodEnd", filters.periodEnd);
  }
  put("departmentId", filters.departmentId);
  put("employeeId", filters.employeeId);
  put("kind", filters.kind);
  put("action", filters.action);
  put("page", filters.page ?? 1);
  put("pageSize", filters.pageSize ?? 50);
  return qs.toString();
}

const scopeReady = (scope: PayrollScope): boolean =>
  scope.kind === "staff"
    ? scope.month > 0 && scope.year > 0
    : !!scope.cycle && !!scope.periodStart && !!scope.periodEnd;

/** The month's (period's) Excess / Detection: summary, department breakdown, the picker's options and the edit rights. */
export const usePayrollExcess = (scope: PayrollScope, enabled = true) =>
  useQuery<PayrollExcessData>({
    queryKey: getPayrollExcessQueryKey(scope),
    queryFn: () => customFetch<PayrollExcessData>(payrollExcessUrl(scope)),
    enabled: enabled && scopeReady(scope),
  });

/** One staff month. */
export const usePayrollExcessMonth = (month: number, year: number, enabled = true) =>
  usePayrollExcess({ kind: "staff", month, year }, enabled);

/** One period of a production pay cycle. */
export const useProductionExcessPeriod = (
  cycle: PayCycle,
  period: { periodStart: string; periodEnd: string },
  enabled = true,
) => usePayrollExcess({ kind: "production", cycle, ...period }, enabled);

/** Every add / change / remove, newest first, a page at a time (the previous page stays on screen while the next loads). */
export const usePayrollExcessHistory = (kind: PayrollKind, filters: ExcessHistoryFilters, enabled = true) =>
  useQuery<ExcessHistoryPage>({
    queryKey: getPayrollExcessHistoryQueryKey(kind, filters),
    queryFn: () => customFetch<ExcessHistoryPage>(`${excessPrefix(kind)}/history?${excessHistoryQueryString(filters)}`),
    enabled,
    placeholderData: keepPreviousData,
  });

// What an Excess change can move: this tab's own figures, every payroll figure (records, month / period status,
// insights, details: "/api/payroll..." covers staff and "/api/payroll/production..." - the slow skip check is left alone,
// nobody's salary or working days changed) and the payslips.
const REFRESH_PREFIXES = ["/api/payroll", PRODUCTION_EXCESS_PREFIX, "/api/salary-slips", "/api/payslips"];

export const isExcessRefreshKey = (key: readonly unknown[]): boolean =>
  typeof key[0] === "string" &&
  REFRESH_PREFIXES.some((p) => String(key[0]).startsWith(p)) &&
  !String(key[0]).includes("skip-check");

/** The period part of a write: `{month, year}` for staff, `{cycle, periodStart, periodEnd}` for production. */
export const excessScopeBody = (scope: PayrollScope): Record<string, string | number> =>
  scope.kind === "staff"
    ? { month: scope.month, year: scope.year }
    : { cycle: scope.cycle, periodStart: scope.periodStart, periodEnd: scope.periodEnd };

const send = <T>(url: string, method: "POST" | "PATCH", body: unknown) =>
  customFetch<T>(url, { method, body: JSON.stringify(body) });

/** Add (one or several employees), change and remove, each reloading the Excess figures and the payroll they touch. */
export function usePayrollExcessActions(kind: PayrollKind = "staff") {
  const queryClient = useQueryClient();
  const prefix = excessPrefix(kind);
  const onSuccess = () => void queryClient.invalidateQueries({ predicate: (q) => isExcessRefreshKey(q.queryKey) });

  const add = useMutation({
    mutationFn: ({ scope, ...rest }: AddExcessBody) =>
      send<AddExcessResult>(`${prefix}/entries`, "POST", { ...excessScopeBody(scope), ...rest }),
    onSuccess,
  });
  const change = useMutation({
    mutationFn: ({ id, amount, remark }: ChangeExcessBody) =>
      send<ChangeExcessResult>(`${prefix}/entries/${id}`, "PATCH", { amount, remark }),
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: (body: RemoveExcessBody) => send<RemoveExcessResult>(`${prefix}/remove`, "POST", body),
    onSuccess,
  });
  return { add, change, remove };
}
