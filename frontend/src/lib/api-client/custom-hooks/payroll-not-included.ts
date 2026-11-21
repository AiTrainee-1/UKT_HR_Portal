// payroll-not-included: the "Not included" view of the Payroll tab of Staff Payroll and of every Production Payroll cycle
// page (owner 2026-11-20). Every employee of the HRMS who is not in the month's staff payroll / the period's production
// payroll, with the reason (inactive, no salary, joined later, on hold, a parked new joiner, paid separately, skipped by
// the engine, not generated yet, on another pay cycle or on the other payroll). Backend: GET /api/payroll/not-included
// (key `payroll.not_included`) and GET /api/payroll/production/not-included (key `production_payroll.payroll.not_included`).
// Read only.
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import { payrollApiBase, scopeQuery, type PayrollScope } from "./payroll-insights";
import type { CyclePeriod, PayCycle } from "./production-cycles";

/** Why an employee is not in the payroll. The server's list is the source of truth: a code added there just works. */
export type NotIncludedReasonCode =
  | "inactive"
  | "joined_after"
  | "no_salary"
  | "on_hold"
  | "new_joiner"
  | "paid_separately"
  | "skipped"
  | "not_generated"
  /** Staff list: a production employee (paid on Production Payroll). */
  | "production"
  /** Production list: on another pay cycle (`detail` names it). */
  | "other_cycle"
  /** Production list: not assigned to any pay cycle. */
  | "no_cycle"
  /** Production list: a staff employee (paid on the Staff Payroll). */
  | "staff"
  | (string & {});

export type NotIncludedEmployee = {
  id: number;
  code: string;
  name: string;
  category: "staff" | "production" | (string & {});
  /** Raw Employee.status, lower-case ("active" / "inactive"). */
  status: string;
  departmentId: number | null;
  department: string | null;
  designationId: number | null;
  designation: string | null;
  branchId: number | null;
  unit: string | null;
  joinDate: string | null;
  reasonCode: NotIncludedReasonCode;
  /** The reason as a plain sentence. */
  reason: string;
  /** More about the reason ("A payroll was generated ... before the employee was made inactive"), or null. */
  detail: string | null;
  /** The month's / period's payroll of the employee (held / new joiner / paid separately), or null. */
  payrollId: number | null;
};

/** What the view reads, staff or production. */
export type PeriodNotIncluded = {
  /** "November 2026" (staff); a production answer may leave it out. */
  periodLabel?: string;
  /** Any payroll was generated for the month / period. */
  generated: boolean;
  /** generated = false: active employees with a salary waiting for the month / period to be generated. */
  notGeneratedCount: number;
  summary: {
    total: number;
    staff: number;
    production: number;
    byReason: Partial<Record<NotIncludedReasonCode, number>>;
  };
  employees: NotIncludedEmployee[];
  departments: { id: number; name: string }[];
  designations: { id: number; title: string }[];
};

export type PayrollNotIncluded = PeriodNotIncluded & { month: number; year: number; periodLabel: string };

export type ProductionNotIncluded = PeriodNotIncluded & { cycle: PayCycle; periodStart: string; periodEnd: string };

export const notIncludedPath = (scope: PayrollScope): string => `${payrollApiBase(scope.kind)}/not-included`;

/** Staff keys hold the month, production keys the cycle and the period. */
export const getNotIncludedQueryKey = (scope: PayrollScope) =>
  scope.kind === "staff"
    ? (["/api/payroll/not-included", { month: scope.month, year: scope.year }] as const)
    : ([
        "/api/payroll/production/not-included",
        { cycle: scope.cycle, periodStart: scope.periodStart, periodEnd: scope.periodEnd },
      ] as const);

export const getPayrollNotIncludedQueryKey = (month: number, year: number) =>
  getNotIncludedQueryKey({ kind: "staff", month, year });

const scopeReady = (scope: PayrollScope): boolean =>
  scope.kind === "staff"
    ? scope.month > 0 && scope.year > 0
    : !!scope.cycle && !!scope.periodStart && !!scope.periodEnd;

/** Who is not in the month's / period's payroll, and why. `enabled` false while the view is hidden from the role. */
export const usePeriodNotIncluded = (scope: PayrollScope, enabled = true) =>
  useQuery<PeriodNotIncluded>({
    queryKey: getNotIncludedQueryKey(scope),
    queryFn: () => customFetch<PeriodNotIncluded>(`${notIncludedPath(scope)}?${scopeQuery(scope)}`),
    enabled: enabled && scopeReady(scope),
  });

/** One staff month. */
export const usePayrollNotIncluded = (month: number, year: number, enabled = true) =>
  usePeriodNotIncluded({ kind: "staff", month, year }, enabled);

/** One period of a production pay cycle. */
export const useProductionNotIncluded = (cycle: PayCycle, period: CyclePeriod, enabled = true) =>
  usePeriodNotIncluded({ kind: "production", cycle, ...period }, enabled);
