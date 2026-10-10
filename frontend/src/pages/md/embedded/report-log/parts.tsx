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

/** The small neutral tag next to a group whose figures rest on too few absences to rank. */
export function SmallSample() {
  return (
    <span
      className="md-chip md-analytics-tone-neutral md-analytics-chip-sm ml-1.5 align-middle"
      title="Fewer absences than it takes to rank this group: read the figures with care."
    >
      small sample
    </span>
  );
}
