import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { customFetch } from "@/lib/api-client/custom-fetch";
import {
  getListPayrollRunsQueryKey,
  usePayrollMonthActions,
  usePayrollMonthStatus,
  type PayrollDetails,
  type PayrollKind,
  type PayrollRunItem,
} from "@/lib/api-client/custom-hooks";

export type DetailsWorkflow = {
  /** A staff payroll: the only kind with Hold / Unhold and a month lock. */
  applies: boolean;
  onHold: boolean;
  /** A new joiner not added to the payroll yet (added on Skipped Employees). */
  parked: boolean;
  releasedFrom: "hold" | "new_joiner" | null;
  paidAt: string | null;
  /** Payroll Done was pressed for this payroll's month: nothing on it can change. */
  locked: boolean;
  canHold: boolean;
  /** Why Hold / Unhold cannot be pressed now ("" = it can). */
  holdBlocked: string;
  busy: boolean;
  toggleHold: () => Promise<void>;
};

/**
 * Hold / Unhold of one STAFF payroll on its details page (owner 2026-11-10). The details endpoint is unchanged: the
 * payroll's own row (GET /api/payroll?employeeId=&month=&year= lists it, held or not) says whether it is on hold, and
 * the month's status whether the month is finalized and whether this login may change holds.
 */
export function useDetailsWorkflow(details: PayrollDetails, kind: PayrollKind): DetailsWorkflow {
  const { toast } = useToast();
  const applies = kind === "staff" && details.kind === "staff";
  const { month, year } = details.context;
  const params = { employeeId: details.employee.id, month, year };
  const status = usePayrollMonthStatus(month, year, applies);
  const own = useQuery<PayrollRunItem[]>({
    queryKey: getListPayrollRunsQueryKey(params),
    queryFn: () =>
      customFetch<PayrollRunItem[]>(`/api/payroll?employeeId=${params.employeeId}&month=${month}&year=${year}`),
    enabled: applies,
  });
  const { hold } = usePayrollMonthActions();
  const row = own.data?.find((r) => r.id === details.payrollId);
  const locked = !!status.data?.locked;
  const canHold = !!status.data?.can.hold;
  const onHold = !!row?.onHold;
  const name = details.employee.name || "Employee";

  let holdBlocked = "";
  if (!row || !status.data) holdBlocked = "Loading...";
  else if (locked) holdBlocked = `${status.data.label} is finalized (Payroll Done): holds can no longer be changed`;
  else if (!canHold) holdBlocked = "Your login cannot change holds (it needs payroll edit rights)";

  const payrollId = details.payrollId;
  const toggleHold = useCallback(async () => {
    try {
      await hold.mutateAsync({ id: payrollId, hold: !onHold });
      toast({
        title: onHold ? `${name}'s salary is no longer on hold` : `${name}'s salary is on hold`,
        description: onHold
          ? "Back in the payroll and the bank file."
          : "Out of the bank file and the records; still on the Salary Statement as HOLD. Listed under Skipped Employees.",
      });
    } catch (err) {
      toast({
        title: onHold ? "Could not unhold the salary" : "Could not hold the salary",
        description: err instanceof Error ? err.message.replace(/^HTTP \d+[^:]*:\s*/, "") : undefined,
        variant: "destructive",
      });
    }
  }, [hold, payrollId, onHold, name, toast]);

  return {
    applies,
    onHold,
    parked: !!row?.newJoinerParked,
    releasedFrom: row?.releasedFrom ?? null,
    paidAt: row?.paymentStatus === "paid" ? (row.paymentPaidAt ?? null) : null,
    locked,
    canHold,
    holdBlocked,
    busy: hold.isPending,
    toggleHold,
  };
}
