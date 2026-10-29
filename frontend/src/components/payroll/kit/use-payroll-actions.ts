import { useCallback, useState } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useUpdatePayrollRecord } from "@/lib/api-client";

const PAYROLL_KEY_PREFIXES = ["/api/payroll", "/api/salary-slips"];
// "Who would be skipped" depends only on who has a salary and working days, and it is the heaviest question the page asks
// (about 14 s of server work for 120 staff): a change to one payslip must not ask it again.
const SKIP_CHECK_PREFIXES = ["/api/payroll/skip-check", "/api/payroll/production/skip-check"];

/** A payroll query: records, insights (dashboard, issues, rules, statement), details, payslips - production ones included. */
const isPayrollQuery = (q: { queryKey: readonly unknown[] }): boolean =>
  typeof q.queryKey[0] === "string" && PAYROLL_KEY_PREFIXES.some((p) => String(q.queryKey[0]).startsWith(p));

const isSkipCheck = (q: { queryKey: readonly unknown[] }): boolean =>
  SKIP_CHECK_PREFIXES.some((p) => String(q.queryKey[0]).startsWith(p));

export type RefreshOptions = {
  /** Ask "who would be skipped" again too (default). A change to one payslip leaves it out: it cannot have changed. */
  skipCheck?: boolean;
};

/** Reloads the payroll figures on screen after something changed (or when HR presses Refresh, which reloads all of them). */
export function useRefreshPayroll(): (options?: RefreshOptions) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    (options: RefreshOptions = {}) => {
      const withSkipCheck = options.skipCheck ?? true;
      return queryClient.invalidateQueries({
        predicate: (q) => isPayrollQuery(q) && (withSkipCheck || !isSkipCheck(q)),
      });
    },
    [queryClient],
  );
}

/** True while any payroll figure is loading or reloading (the page's Refresh button spins meanwhile). */
export function useIsRefreshingPayroll(): boolean {
  return useIsFetching({ predicate: isPayrollQuery }) > 0;
}

/**
 * "Mark as Cleared" on one payroll record, shared by the record lists and the Salary tabs. `markingId` is the record whose update
 * is running (its button spins and waits); a success reloads the payroll figures (not the skipped-employees check).
 */
export function useMarkPaid() {
  const { toast } = useToast();
  const { mutateAsync: updateRecord } = useUpdatePayrollRecord();
  const refresh = useRefreshPayroll();
  const [markingId, setMarkingId] = useState<number | null>(null);

  const markPaid = useCallback(
    async (run: { id: number; employeeName?: string | null }) => {
      setMarkingId(run.id);
      try {
        await updateRecord({ id: run.id, data: { status: "paid" } });
        toast({ title: `${run.employeeName ?? "Employee"}'s salary marked as cleared` });
        await refresh({ skipCheck: false });
      } catch {
        toast({ title: "Failed to update status", variant: "destructive" });
      } finally {
        setMarkingId(null);
      }
    },
    [updateRecord, toast, refresh],
  );

  return { markPaid, markingId };
}
