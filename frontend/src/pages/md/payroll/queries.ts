// The page's data: one hook per endpoint (all under /api/md/payroll/), every one given the same month and scope.
// `status` takes only the scope (it lists every month). Each query keeps its previous result on screen while a changed
// filter loads (useMdQuery), so a card shows its spinner only on the first load.

import { useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import type {
  PayrollAdvances,
  PayrollAttention,
  PayrollBridge,
  PayrollComponents,
  PayrollDepartments,
  PayrollDistribution,
  PayrollExceptions,
  PayrollStatus,
  PayrollSummary,
  PayrollTrend,
} from "./types";

export type PayrollFilters = {
  /** "YYYY-MM"; empty = the latest closed month (the server decides). */
  month: string;
  scope: Record<string, string>;
};

export function usePayrollQueries(filters: PayrollFilters, exceptions: { limit: number; kind: string }) {
  const scope: MdQueryParams = filters.scope;
  const withMonth: MdQueryParams = { ...scope, month: filters.month };
  return {
    status: useMdQuery<PayrollStatus>("payroll/status", { ...scope, months: 12 }),
    summary: useMdQuery<PayrollSummary>("payroll/summary", withMonth),
    attention: useMdQuery<PayrollAttention>("payroll/attention", withMonth),
    trend: useMdQuery<PayrollTrend>("payroll/trend", { ...withMonth, months: 12 }),
    bridge: useMdQuery<PayrollBridge>("payroll/bridge", withMonth),
    departments: useMdQuery<PayrollDepartments>("payroll/departments", { ...withMonth, limit: 25 }),
    components: useMdQuery<PayrollComponents>("payroll/components", withMonth),
    distribution: useMdQuery<PayrollDistribution>("payroll/distribution", { ...withMonth, limit: 10 }),
    advances: useMdQuery<PayrollAdvances>("payroll/advances", withMonth),
    exceptions: useMdQuery<PayrollExceptions>("payroll/exceptions", {
      ...withMonth,
      limit: exceptions.limit,
      kind: exceptions.kind,
    }),
  };
}

export type PayrollQueries = ReturnType<typeof usePayrollQueries>;
