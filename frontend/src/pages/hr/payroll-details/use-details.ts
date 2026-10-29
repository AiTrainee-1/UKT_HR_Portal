import { useCallback, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ApiError, customFetch } from "@/lib/api-client/custom-fetch";
import {
  getPayrollDetailsQueryKey,
  payrollApiBase,
  useUpdatePayrollRecord,
  type PayrollDetails,
  type PayrollKind,
} from "@/lib/api-client/custom-hooks";

/** The server said "no": the payroll does not exist, is outside this login's branch, or the role may not open it. */
export function isMissingError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403 || error.status === 400);
}

/**
 * One payroll's details, the same request and cache key as `usePayrollDetails`, with two additions the page needs:
 * while the next payroll of Previous / Next loads, the previous one stays on screen (`isPlaceholderData`), and a
 * missing or forbidden payroll is not retried (the answer will not change).
 */
export function usePayrollDetailsView(kind: PayrollKind, id: number | null) {
  return useQuery<PayrollDetails>({
    queryKey: getPayrollDetailsQueryKey(kind, id ?? 0),
    queryFn: () => customFetch<PayrollDetails>(`${payrollApiBase(kind)}/${id}/details`),
    enabled: !!id,
    placeholderData: keepPreviousData,
    retry: (failures, error) => !isMissingError(error) && failures < 1,
  });
}

/** Every payroll screen reads from a query whose key starts with this: marking one paid refreshes all of them. */
export const isPayrollQuery = (queryKey: readonly unknown[]): boolean =>
  typeof queryKey[0] === "string" && queryKey[0].startsWith("/api/payroll");

/** "Mark as paid": the existing payroll update (PATCH /api/payroll/<id>), then every payroll query is refreshed. */
export function useMarkPaid() {
  const { mutateAsync } = useUpdatePayrollRecord();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const markPaid = useCallback(
    async (payrollId: number, employeeName: string) => {
      setBusy(true);
      try {
        await mutateAsync({ id: payrollId, data: { status: "paid" } });
        toast({ title: `${employeeName || "Employee"}'s salary marked as cleared` });
        await queryClient.invalidateQueries({ predicate: (q) => isPayrollQuery(q.queryKey) });
      } catch (err) {
        toast({
          title: "Failed to update status",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [mutateAsync, queryClient, toast],
  );

  return { markPaid, busy };
}
