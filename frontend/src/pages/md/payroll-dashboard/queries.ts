// The Payroll page's data and its state in the address. Four read-only endpoints (types.ts); every query keeps its previous
// answer on screen while a changed filter loads (useMdQuery), so a card shows its skeleton only on the first load.

import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { applyPatch, dashSearch, parseDashState, type DashPatch, type DashState } from "./logic";
import type { PayDepartmentsResponse, PayMonthlyResponse, PayPeopleResponse, PayPersonResponse } from "./types";

/** The history state put on the entry of an employee opened from the list: Back on the page can then go back in the
 *  browser's history, so the list returns exactly as it was (and the browser's own Back agrees with it). */
export const FROM_LIST_STATE = { mdPayrollFromList: true } as const;

export const cameFromList = (): boolean =>
  (window.history.state as { mdPayrollFromList?: boolean } | null)?.mdPayrollFromList === true;

/**
 * The page state, read from the address and written back to it. `push` makes a new history entry (a new tab, an employee
 * opened: Back returns); anything else (a filter, the search, a sort, a page) replaces the current one.
 */
export function useDashState() {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const state = useMemo(() => parseDashState(search), [search]);
  const update = useCallback(
    (patch: DashPatch, options: { push?: boolean; historyState?: unknown } = {}) => {
      const next = applyPatch(state, patch);
      navigate(`${path}${dashSearch(next)}`, { replace: !options.push, state: options.historyState });
    },
    [state, path, navigate],
  );
  return [state, update] as const;
}

export type DashUpdate = ReturnType<typeof useDashState>[1];

const scopeParams = (s: DashState): MdQueryParams => ({ branch: s.branch, department: s.department, type: s.type });

export const PEOPLE_PAGE_SIZE = 25;
export const HISTORY_MONTHS = 24;

/**
 * The page's queries. The month trend runs on every tab (it lists the months for the picker and, with no month chosen,
 * names the latest one); the other tabs then ask for that same month, so every tab describes one month even when the
 * latest month differs between scopes.
 */
export function usePayrollDashboard(state: DashState) {
  const monthly = useMdQuery<PayMonthlyResponse>("payroll/monthly", {
    month: state.month,
    months: 12,
    ...scopeParams(state),
  });
  const month = state.month || monthly.data?.month || "";
  const monthKnown = !!state.month || !monthly.isPending;

  const departments = useMdQuery<PayDepartmentsResponse>(
    "payroll/department-breakdown",
    { month, branch: state.branch, type: state.type },
    { enabled: state.view === "departments" && monthKnown },
  );
  const people = useMdQuery<PayPeopleResponse>(
    "payroll/people",
    {
      month,
      ...scopeParams(state),
      q: state.q,
      sort: state.sort,
      dir: state.dir,
      page: state.page,
      pageSize: PEOPLE_PAGE_SIZE,
    },
    { enabled: state.view === "employees" && !state.employee && monthKnown },
  );
  const person = useMdQuery<PayPersonResponse>(
    `payroll/people/${state.employee ?? 0}`,
    { months: HISTORY_MONTHS },
    { enabled: !!state.employee },
  );
  return { monthly, departments, people, person, month };
}

export type DashQueries = ReturnType<typeof usePayrollDashboard>;

/** The server's "numbers made at" stamp, when the answer carries one (the MD endpoints' common envelope adds it). */
export function stampOf(...answers: unknown[]): string | undefined {
  for (const a of answers) {
    const stamp = (a as { generatedAt?: unknown } | null | undefined)?.generatedAt;
    if (typeof stamp === "string" && stamp) return stamp;
  }
  return undefined;
}
