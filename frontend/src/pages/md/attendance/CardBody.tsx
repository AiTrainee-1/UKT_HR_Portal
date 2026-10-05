import type { ReactNode } from "react";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";

type QueryLike<T> = { data?: T; isError: boolean; error: unknown; refetch: () => unknown };

/**
 * The inside of a card that is fed by one query: a failed load shows what the server said with a retry (above the
 * previous figures when there are some), and the children are only drawn when there is data.
 */
export default function CardBody<T>({ query, children }: { query: QueryLike<T>; children: (data: T) => ReactNode }) {
  return (
    <>
      {query.isError && (
        <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} className="mb-3" />
      )}
      {query.data ? children(query.data) : null}
    </>
  );
}
