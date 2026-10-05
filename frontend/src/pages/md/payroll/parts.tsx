import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { cn } from "@/lib/utils";

/** True when a query has nothing to show and failed: the card shows its error instead of a body. */
export const failed = (query: UseQueryResult<unknown>) => query.isError && !query.data;

/** An error inside one card (what the server said, and a retry): the rest of the page keeps working. */
export function CardError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** The server's notes without the "Matched department 'x' to 'y'" ones: the page shows those once, at the top. */
export const cardNotes = (notes: string[] | undefined): string[] =>
  (notes ?? []).filter((n) => !n.startsWith("Matched "));

/** Why a card is empty: the server's first note that is not about the filters, else a plain sentence. */
export const emptyReason = (notes: string[] | undefined, fallback: string): string => cardNotes(notes)[0] ?? fallback;

/** A small figure with its label, inside a card. */
export function Metric({
  label,
  value,
  sub,
  className,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("rounded-xl bg-[#006496]/[0.04] p-3", className)} data-testid={testId}>
      <p className="text-[11px] font-medium text-[#006496]/65">{label}</p>
      <p className="text-lg font-black leading-tight text-[#1a3a4a]">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] leading-snug text-[#006496]/55">{sub}</p>}
    </div>
  );
}

/** A coloured pill, as the HR pages use for statuses. */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}
