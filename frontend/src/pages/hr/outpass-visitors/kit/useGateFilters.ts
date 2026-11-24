import { useCallback, useEffect, useMemo, useState } from "react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { rangeDays, readDateRange } from "@/lib/date-range";
import { DATE_PRESETS, isDateKey, istDateKey, msUntilNextIstDay, resolveDateRange, toInstant } from "./fmt";

/** The list's paging keys: in the address like the filters, never counted as a filter, never sent with an export. */
const PAGING = new Set(["page", "pageSize"]);
/** The date filter's keys (DateRangeFilter, or the HR portal's DateRangeBar with `month`): the API gets `from` / `to`
 *  worked out from them, never `range` or `month`. */
const DATE_KEYS = new Set(["range", "month", "from", "to"]);

export type GateFilters<T extends Record<string, string>> = {
  /** Every filter as the address has it (its default when the address has none), plus `page`. */
  filters: T & { page: string };
  /** Changes some filters (written to the address with `replace`) and goes back to page 1, unless the patch sets `page`. */
  set: (patch: Partial<T & { page: string }>) => void;
  page: number;
  setPage: (page: number) => void;
  /** Rows per page when the defaults have a `pageSize`, else undefined (the API's own). */
  pageSize: number | undefined;
  /** Every filter back to its default (the `keep` ones excepted) and page 1. */
  clear: () => void;
  /** How many filters differ from their defaults (paging and the `keep` ones not counted): drives ClearFilters. */
  activeCount: number;
  /** The days the date filter stands for (`range` / `from` / `to`), as the API takes them; "" = no limit. */
  dateRange: { from: string; to: string };
  /** For the list API: every filter that has a value (the date filter as `from` / `to`), then `page` (and `pageSize`). */
  params: URLSearchParams;
  /** For an export (downloadGateFile / ExportButton): `params` without the paging. */
  exportQuery: URLSearchParams;
  /** `params` as a string: put it in the React Query key so every filter change is its own cache entry. */
  queryKey: string;
};

/**
 * The filters of one list, kept in the address (`?range=week&type=exit&q=ravi&page=2`), so a reload, a shared link or
 * Back shows the same rows. Built on the payroll kit's `useUrlParams`:
 *
 * - `defaults` must be a module-level constant (its identity is a dependency) of strings; "" means "any", and a value
 *   equal to its default is left out of the address.
 * - A `range` key (with `from` and `to`) is the date filter: "today" / "week" / "month" are worked out from today in
 *   India, "custom" uses `from` / `to`, "all" has no limit. `params` carries `from` / `to`, never `range`.
 * - With a `month` key as well, the date filter is the HR portal's one (lib/date-range, components/date-range
 *   DateRangeBar, owner brief 2026-11-24): "today" / "yesterday" / "month" (the whole month of `month`, the current one
 *   when empty) / "custom", nothing after today.
 * - `page` is always there (default "1"); `pageSize` only when the defaults have it.
 * - `keep` names keys that are not filters (Visitors' `?view=`): Clear leaves them alone and they are not counted, but
 *   they still go to the API like any other value, so leave a pure screen switch out of `defaults` if the API must not
 *   see it (read it with `useUrlParams` instead).
 */
export function useGateFilters<T extends Record<string, string>>(
  defaults: T,
  options: { keep?: readonly string[] } = {},
): GateFilters<T> {
  const all = useMemo(() => ({ page: "1", ...defaults }) as T & { page: string }, [defaults]);
  const [raw, write] = useUrlParams(all);
  // A link that carries days but no `range` (`?from=2026-01-01&to=2026-11-18`) means those days: the address drops a
  // default `range`, and choosing a preset always clears `from` / `to`, so days next to the default range are custom.
  const values = useMemo(
    () =>
      "range" in all && raw.range === all.range && (isDateKey(raw.from) || isDateKey(raw.to))
        ? ({ ...raw, range: "custom" } as typeof raw)
        : raw,
    [all, raw],
  );
  const keepKey = (options.keep ?? []).join("\u0000");
  // "Today" / "This week" / "This month" are worked out from today in India: read it on every render, and re-render at
  // India's midnight, so a list left open overnight asks for the new day by itself.
  const portalDates = "month" in all;
  const today = useIstToday(
    "range" in all && (portalDates ? values.range !== "custom" : DATE_PRESETS.some((p) => p.value === values.range)),
  );

  const set = useCallback(
    (patch: Partial<T & { page: string }>) => {
      write("page" in patch ? patch : ({ ...patch, page: "1" } as Partial<T & { page: string }>));
    },
    [write],
  );

  const setPage = useCallback(
    (page: number) => write({ page: String(Math.max(1, Math.floor(page))) } as Partial<T & { page: string }>),
    [write],
  );

  const clear = useCallback(() => {
    const keep = new Set(keepKey ? keepKey.split("\u0000") : []);
    const patch: Record<string, string> = {};
    for (const key of Object.keys(all)) if (!keep.has(key) && key !== "pageSize") patch[key] = all[key];
    write(patch as Partial<T & { page: string }>);
  }, [all, write, keepKey]);

  const derived = useMemo(() => {
    const keep = new Set(keepKey ? keepKey.split("\u0000") : []);
    const hasDate = Object.keys(all).some((k) => DATE_KEYS.has(k));
    // a preset is worked out from `today` (India), so it moves on to the new day at midnight
    const at = toInstant(today) ?? new Date();
    const dateRange = !hasDate
      ? { from: "", to: "" }
      : portalDates
        ? rangeDays(readDateRange(values as Record<string, string>, at), at)
        : resolveDateRange({ range: values.range, from: values.from, to: values.to }, at);
    const filterParams = new URLSearchParams();
    // the date filter counts once, however many of its keys moved
    let activeCount = Object.keys(all).some((k) => DATE_KEYS.has(k) && !keep.has(k) && (values[k] ?? "") !== all[k])
      ? 1
      : 0;
    for (const key of Object.keys(all)) {
      const value = values[key] ?? "";
      if (PAGING.has(key) || DATE_KEYS.has(key)) continue;
      if (!keep.has(key) && value !== all[key]) activeCount += 1;
      if (value !== "") filterParams.set(key, value);
    }
    if (dateRange.from) filterParams.set("from", dateRange.from);
    if (dateRange.to) filterParams.set("to", dateRange.to);
    const params = new URLSearchParams(filterParams);
    params.set("page", String(pageOf(values.page)));
    if ("pageSize" in all && values.pageSize) params.set("pageSize", values.pageSize);
    return { dateRange, exportQuery: filterParams, params, activeCount, queryKey: params.toString() };
  }, [all, values, keepKey, today, portalDates]);

  return {
    filters: values,
    set,
    page: pageOf(values.page),
    setPage,
    pageSize: "pageSize" in all && Number(values.pageSize) > 0 ? Number(values.pageSize) : undefined,
    clear,
    ...derived,
  };
}

/**
 * Today in India ("2026-11-18"), read on every render. While `watch` is on, a timer re-renders the caller just after
 * India's midnight (and again every following midnight), so a value worked out from today follows the new day.
 */
function useIstToday(watch: boolean): string {
  const [tick, setTick] = useState(0);
  const today = istDateKey(new Date());
  useEffect(() => {
    if (!watch) return;
    const timer = setTimeout(() => setTick((n) => n + 1), msUntilNextIstDay() + 1000);
    return () => clearTimeout(timer);
  }, [watch, today, tick]);
  return today;
}

const pageOf = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
};
