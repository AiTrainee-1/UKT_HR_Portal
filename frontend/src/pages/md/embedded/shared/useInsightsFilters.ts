import { useCallback, useMemo, useState } from "react";
import type { ScopeChoice } from "@/lib/md/period";
import {
  filterParams,
  readFilters,
  whenLabel,
  writeFilters,
  type InsightsDefaults,
  type InsightsFilters,
  type InsightsWhen,
} from "./filters";

function currentSearch(): string {
  try {
    return window.location.search;
  } catch {
    return "";
  }
}

/** Puts the filters in the address without a new history entry (the Back button still leaves the page). */
function remember(filters: InsightsFilters, defaults: InsightsDefaults) {
  try {
    const url = new URL(window.location.href);
    const next = writeFilters(url.search, filters, defaults);
    if (next === url.search) return;
    window.history.replaceState(window.history.state, "", `${url.pathname}${next}${url.hash}`);
  } catch {
    /* the address just keeps the old filters */
  }
}

/**
 * The filters of an Insights tab, read from the address on open and written back on every change, so a refresh or a shared
 * link opens the same month, unit and department. `params` is what to send to /api/md/...; `label` the month or period in
 * words ("Nov 2026 (so far)").
 *
 * `defaults` must be stable (a module-level constant): it decides what is left out of the address.
 */
export function useInsightsFilters(defaults: InsightsDefaults = {}) {
  const [filters, setFilters] = useState<InsightsFilters>(() => readFilters(currentSearch(), defaults));

  const update = useCallback(
    (change: (current: InsightsFilters) => InsightsFilters) => {
      setFilters((current) => {
        const next = change(current);
        remember(next, defaults);
        return next;
      });
    },
    [defaults],
  );

  const setWhen = useCallback((when: InsightsWhen) => update((f) => ({ ...f, when })), [update]);
  const setScope = useCallback((scope: ScopeChoice) => update((f) => ({ ...f, scope })), [update]);
  const setExtra = useCallback(
    (key: string, value: string) => update((f) => ({ ...f, extra: { ...f.extra, [key]: value } })),
    [update],
  );

  const params = useMemo(() => filterParams(filters), [filters]);
  return { filters, params, label: whenLabel(filters.when), setWhen, setScope, setExtra };
}
