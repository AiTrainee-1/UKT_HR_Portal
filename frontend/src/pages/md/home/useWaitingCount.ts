import { useListLeaveRequests, useListOutpassRequests, useListPermissions } from "@/lib/api-client";

const REFRESH = { refetchInterval: 30_000 } as never;

/**
 * How many leave, permission and outpass requests are still pending: the "N requests waiting" of the welcome card. The
 * same lists and the same rules the Requests page counts by (an outpass counts only when somebody asked for it, not one
 * a gate scan made). The MD only looks at them: HR and the Department Heads decide.
 */
export function useWaitingCount(): number {
  const leaves = useListLeaveRequests({ status: "pending" }, { query: { refetchInterval: 30_000 } } as never);
  const permissions = useListPermissions({ status: "pending" }, REFRESH);
  const outpasses = useListOutpassRequests("pending");
  const pending = (rows: { status?: string | null }[] | undefined) =>
    (rows ?? []).filter((r) => r.status === "pending");
  return (
    pending(leaves.data).length +
    pending(permissions.data).length +
    pending(outpasses.data).filter((o) => (o as { source?: string }).source === "manual").length
  );
}
