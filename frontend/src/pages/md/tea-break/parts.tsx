import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";

/** A card whose request failed: what the server said, and a retry. The other cards are unaffected. */
export function QueryError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** While a changed filter loads, the old figures stay on screen (so the page never blanks); this dims them so nobody
 *  reads last period's numbers as this period's. */
export function refreshingClass(...queries: UseQueryResult<unknown>[]): string {
  const refreshing = queries.some((q) => q.isFetching && !q.isPending);
  return refreshing ? "opacity-60 transition-opacity" : "transition-opacity";
}

/** The small grey tag next to a group whose figures rest on too few breaks to rank. */
export function SmallSample() {
  return (
    <span
      className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 align-middle text-[9.5px] font-semibold text-slate-500"
      title="Fewer measured breaks than it takes to rank this group: read the rate with care."
    >
      small sample
    </span>
  );
}
