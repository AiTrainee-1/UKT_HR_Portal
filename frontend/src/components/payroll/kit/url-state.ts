import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import type { PayCycle, PayrollKind } from "@/lib/api-client/custom-hooks";

/**
 * Page state that lives in the address (`?tab=salary&month=10&dept=4`): it survives a reload and, because the list pages
 * write it with `replace`, a Back from a payroll's details page lands on exactly the tab, period and filters that were open.
 * `defaults` must be a module-level constant (its identity is a dependency); a value equal to its default is left out of
 * the address so a fresh page keeps a clean URL.
 */
export function useUrlParams<T extends Record<string, string>>(defaults: T) {
  const search = useSearch();
  const [path, navigate] = useLocation();

  const values = useMemo(() => {
    const params = new URLSearchParams(search);
    const out: Record<string, string> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const v = params.get(key);
      if (v !== null) out[key] = v;
    }
    return out as T;
  }, [search, defaults]);

  const set = useCallback(
    (patch: Partial<T>) => {
      const params = new URLSearchParams(search);
      for (const [key, value] of Object.entries(patch) as [string, string | undefined][]) {
        if (value === undefined || value === "" || value === defaults[key]) params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      // Keep the history entry's state (a details page remembers it was opened from a list), only the address changes.
      navigate(`${path}${qs ? `?${qs}` : ""}`, { replace: true, state: window.history.state });
    },
    [search, path, navigate, defaults],
  );

  return [values, set] as const;
}

// ── Addresses ─────────────────────────────────────────────────────────────────

export const STAFF_PAYROLL_PATH = "/hr/payroll";
export const productionPayrollPath = (cycle: PayCycle) => `/hr/production-payroll/${cycle}`;

/** The details page of one payroll: staff under /hr/payroll, production under /hr/production-payroll (each is gated by its
 *  own permission module). `section` jumps to a part of it (issues, rules, days). */
export function payrollDetailsPath(kind: PayrollKind, id: number, section?: string): string {
  const base = kind === "production" ? "/hr/production-payroll/details" : "/hr/payroll/details";
  return `${base}/${id}${section ? `?section=${encodeURIComponent(section)}` : ""}`;
}

/** The history state a list page puts on its entry for a details page: "I came from the payroll list, Back returns there". */
export const PAYROLL_NAV_STATE = { fromPayroll: true } as const;

type Navigate = (to: string, options?: { replace?: boolean; state?: unknown }) => void;

/** Opens a payroll's details page so that Back returns to the list exactly as it was (same tab, period and filters). */
export function openPayrollDetails(navigate: Navigate, kind: PayrollKind, id: number, section?: string): void {
  navigate(payrollDetailsPath(kind, id, section), { state: PAYROLL_NAV_STATE });
}

/** True when this page was opened from a payroll list in this session (so history.back() is a safe Back). */
export const cameFromPayroll = (): boolean =>
  (window.history.state as { fromPayroll?: boolean } | null)?.fromPayroll === true;

/** Where a details page returns to when it was opened with no history (a pasted link): the list for its period. */
export function payrollListPath(ctx: {
  kind: PayrollKind;
  month: number;
  year: number;
  cycle: PayCycle | null;
  periodStart: string | null;
  periodEnd: string | null;
}): string {
  if (ctx.kind === "production" && ctx.cycle) {
    const period = ctx.periodStart && ctx.periodEnd ? `?period=${ctx.periodStart}_${ctx.periodEnd}` : "";
    return `${productionPayrollPath(ctx.cycle)}${period}`;
  }
  return `${STAFF_PAYROLL_PATH}?month=${ctx.month}&year=${ctx.year}`;
}

/** "2026-02-02_2026-02-08" <-> the two dates (a production period in the address). */
export function parsePeriodParam(value: string | null | undefined): { periodStart: string; periodEnd: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(value ?? "");
  return m ? { periodStart: m[1], periodEnd: m[2] } : null;
}

export const periodParam = (p: { periodStart: string; periodEnd: string } | null | undefined): string =>
  p ? `${p.periodStart}_${p.periodEnd}` : "";
