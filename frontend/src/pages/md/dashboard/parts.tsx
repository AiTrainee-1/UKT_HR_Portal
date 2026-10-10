// Small pieces the Dashboard's sections share.

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { cn } from "@/lib/utils";
import { isSectionError } from "./types";

/** What a section says when the overview could not be loaded at all (the reason and the Retry are at the top). */
export function Unavailable() {
  return (
    <p className="py-6 text-center text-sm font-medium text-md-ink-soft" data-testid="md-dashboard-unavailable">
      This could not be loaded, so nothing is shown here. The reason is at the top of the page.
    </p>
  );
}

/** A small label pill under a chart. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("md-chip whitespace-nowrap tabular-nums", className)}>{children}</span>;
}

/** A heading above a group of cards: the title, what the group is, and a hairline that runs out to the edge. */
export function GroupHeading({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end gap-4">
      <div className="min-w-0">
        <h3 id={id} className="text-lg font-black tracking-tight text-md-ink">
          {title}
        </h3>
        {children && <p className="mt-0.5 text-xs font-medium text-md-ink-soft">{children}</p>}
      </div>
      <span aria-hidden className="md-dashboard-rule mb-2 hidden sm:block" />
    </div>
  );
}

/**
 * The inline error of a trend card: its whole request failed (nothing to show), or the server answered but could not
 * read this one chart. Either way the card says so and offers Retry; the other cards are untouched. Null = no error.
 */
export function trendError(query: UseQueryResult<unknown>, section: unknown): ReactNode {
  if (query.isError && !query.data) {
    return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
  }
  if (isSectionError(section)) {
    return <ErrorBanner message={section.error} onRetry={() => void query.refetch()} />;
  }
  return null;
}
