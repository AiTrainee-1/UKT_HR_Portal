import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { PayrollRunItem } from "./payroll";

// The Staff Payroll month workflow (owner 2026-11-10, backend api/payroll_month_workflow.py): Hold / Unhold, new joiners
// kept aside until "Add to payroll", Payroll Done (the month is locked for good), Mark as Paid, and the release and pay of
// a held / new employee after the lock. None of these changes a payroll figure.

export type PayrollMonthState = "open" | "finalized" | "paid";

export type PayrollMonthCounts = {
  /** In the month's payroll: the records, their totals and the bank file. */
  inPayroll: number;
  /** ... of which not marked Cleared yet. */
  notCleared: number;
  onHold: number;
  /** New joiners not added to the payroll. */
  newJoiners: number;
  /** Released and paid on their own after the lock. */
  paidSeparately: number;
  /** Payment status Paid (what the employee sees). */
  paid: number;
  /** In the payroll and not paid yet. */
  notPaid: number;
};

export type PayrollMonthStatus = {
  month: number;
  year: number;
  label: string;
  state: PayrollMonthState;
  /** Payroll Done was pressed: nothing in the month can change (except Release & pay). */
  locked: boolean;
  /** The month's last day is behind us (India time). */
  monthEnded: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  /** Calendar days from Payroll Done to Mark as Paid (India time); null until paid. */
  daysToPay: number | null;
  /** The month's first generation and last computation (as they stood when it was finalized, once it is). */
  firstGeneratedAt: string | null;
  lastComputedAt: string | null;
  /** In the caller's scope (a unit login sees its unit's numbers). */
  counts: PayrollMonthCounts;
  /** The month as it stood when it was finalized. */
  snapshot: { inPayroll: number; notCleared: number; onHold: number; newJoiners: number; mainNet: number } | null;
  /** Not limited to one unit: only such a login may press Payroll Done / Mark as Paid / Release & pay. */
  wholeCompany: boolean;
  can: { finalize: boolean; markPaid: boolean; hold: boolean; addToPayroll: boolean; releaseAndPay: boolean };
  /** Mark as Paid only: how many employees it paid. */
  employeesPaid?: number;
};

export type PayrollMonthSkipped = {
  month: number;
  year: number;
  locked: boolean;
  onHold: PayrollRunItem[];
  newJoiners: PayrollRunItem[];
  paidSeparately: PayrollRunItem[];
};

const period = (month: number, year: number) => `month=${month}&year=${year}`;

export const getPayrollMonthStatusQueryKey = (month: number, year: number) =>
  ["/api/payroll/month-status", { month, year }] as const;

export const getPayrollMonthSkippedQueryKey = (month: number, year: number) =>
  ["/api/payroll/month-skipped", { month, year }] as const;

/** Where the month stands (Payroll Done / Payment Pending / Paid), its timeline and what this login may do. */
export const usePayrollMonthStatus = (month: number, year: number, enabled = true) =>
  useQuery<PayrollMonthStatus>({
    queryKey: getPayrollMonthStatusQueryKey(month, year),
    queryFn: () => customFetch<PayrollMonthStatus>(`/api/payroll/month-status?${period(month, year)}`),
    enabled: enabled && month > 0 && year > 0,
  });

/** The month's held, new-joiner and paid-separately payrolls, with their figures and bank details. */
export const usePayrollMonthSkipped = (month: number, year: number) =>
  useQuery<PayrollMonthSkipped>({
    queryKey: getPayrollMonthSkippedQueryKey(month, year),
    queryFn: () => customFetch<PayrollMonthSkipped>(`/api/payroll/month-skipped?${period(month, year)}`),
  });

const isPayrollKey = (key: readonly unknown[]): boolean =>
  typeof key[0] === "string" && key[0].startsWith("/api/payroll") && !key[0].includes("skip-check");

const post = <T>(url: string, body?: unknown) =>
  customFetch<T>(url, { method: "POST", body: JSON.stringify(body ?? {}) });

/**
 * Every workflow action, each refreshing the payroll figures on screen when it is done (but not the slow skip check:
 * none of these changes who has a salary or working days).
 */
export function usePayrollMonthActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ predicate: (q) => isPayrollKey(q.queryKey) });
  const onSuccess = () => void refresh();

  const hold = useMutation({
    mutationFn: ({ id, hold }: { id: number; hold: boolean }) =>
      post<PayrollRunItem>(`/api/payroll/${id}/hold`, { hold }),
    onSuccess,
  });
  const addToPayroll = useMutation({
    mutationFn: (id: number) => post<PayrollRunItem>(`/api/payroll/${id}/add-to-payroll`),
    onSuccess,
  });
  const releaseAndPay = useMutation({
    mutationFn: (id: number) => post<PayrollRunItem>(`/api/payroll/${id}/release-and-pay`),
    onSuccess,
  });
  const finalize = useMutation({
    mutationFn: ({ month, year }: { month: number; year: number }) =>
      post<PayrollMonthStatus>("/api/payroll/month-finalize", { month, year }),
    onSuccess,
  });
  const markPaid = useMutation({
    mutationFn: ({ month, year }: { month: number; year: number }) =>
      post<PayrollMonthStatus>("/api/payroll/month-paid", { month, year }),
    onSuccess,
  });
  return { hold, addToPayroll, releaseAndPay, finalize, markPaid };
}
