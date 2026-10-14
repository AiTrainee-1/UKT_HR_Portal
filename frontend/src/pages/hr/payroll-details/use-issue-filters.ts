import { useCallback, useState } from "react";
import type { IssueSeverity } from "@/lib/api-client/custom-hooks";
import { NO_ISSUE_FILTERS, type IssueFilters, type IssueGroupBy } from "./logic";

/**
 * The state of the Issues filters, kept by the page (not the card) because the calendar writes to it too: choosing a
 * day there narrows the issues to that day.
 */
export function useIssueFilters() {
  const [filters, setFilters] = useState<IssueFilters>(NO_ISSUE_FILTERS);
  const [groupBy, setGroupBy] = useState<IssueGroupBy>("date");

  const patch = useCallback((change: Partial<IssueFilters>) => setFilters((f) => ({ ...f, ...change })), []);
  const toggleSeverity = useCallback(
    (severity: IssueSeverity) =>
      setFilters((f) => ({
        ...f,
        severities: f.severities.includes(severity)
          ? f.severities.filter((s) => s !== severity)
          : [...f.severities, severity],
      })),
    [],
  );
  const reset = useCallback(() => setFilters(NO_ISSUE_FILTERS), []);
  /** Narrow the list to one day (the day chosen on the calendar), or lift that narrowing again. */
  const setDay = useCallback(
    (date: string | null) => setFilters((f) => ({ ...f, from: date ?? "", to: date ?? "" })),
    [],
  );

  return { filters, groupBy, setGroupBy, patch, toggleSeverity, reset, setDay };
}

export type IssueFilterState = ReturnType<typeof useIssueFilters>;
