// The Production side's data and its state in the address. Four read-only endpoints (../types.ts, Prod*); every query
// keeps its previous answer on screen while a changed filter loads (useMdQuery).

import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import type { ProdDepartmentsResponse, ProdOverviewResponse, ProdPeopleResponse, ProdPersonResponse } from "../types";
import { applyProdPatch, parseProdState, periodParams, prodSearch, type ProdPatch, type ProdState } from "./logic";

export const WORKERS_PAGE_SIZE = 25;
export const TREND_PERIODS = 12;
export const WORKER_PERIODS = 12;

/** The history state put on a worker opened from the list, so Back returns to the list as it was. */
export const FROM_WORKERS_STATE = { mdPayrollFromWorkers: true } as const;

export const cameFromWorkers = (): boolean =>
  (window.history.state as { mdPayrollFromWorkers?: boolean } | null)?.mdPayrollFromWorkers === true;

export function useProdState() {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const state = useMemo(() => parseProdState(search), [search]);
  const update = useCallback(
    (patch: ProdPatch, options: { push?: boolean; historyState?: unknown } = {}) => {
      const next = applyProdPatch(state, patch);
      navigate(`${path}${prodSearch(next)}`, { replace: !options.push, state: options.historyState });
    },
    [state, path, navigate],
  );
  return [state, update] as const;
}

export type ProdUpdate = ReturnType<typeof useProdState>[1];

/**
 * The page's queries. The overview always runs (it lists the cycles and periods for the pickers and, with nothing chosen,
 * names the cycle and period the server picked); the other tabs then ask for that same cycle and period, so every tab
 * describes one period.
 */
export function useProductionPayroll(state: ProdState) {
  const scope: MdQueryParams = { branch: state.branch, department: state.department };
  const overview = useMdQuery<ProdOverviewResponse>("payroll/production/overview", {
    cycle: state.cycle,
    ...periodParams(state.period),
    periods: TREND_PERIODS,
    ...scope,
  });
  const cycle = state.cycle || overview.data?.cycle || "";
  const period = state.period || overview.data?.period?.key || "";
  const known = (!!state.cycle && !!state.period) || !overview.isPending;
  const chosen: MdQueryParams = { cycle, ...periodParams(period) };

  const departments = useMdQuery<ProdDepartmentsResponse>(
    "payroll/production/departments",
    { ...chosen, branch: state.branch },
    { enabled: state.view === "departments" && known },
  );
  const people = useMdQuery<ProdPeopleResponse>(
    "payroll/production/people",
    {
      ...chosen,
      ...scope,
      q: state.q,
      sort: state.sort,
      dir: state.dir,
      page: state.page,
      pageSize: WORKERS_PAGE_SIZE,
    },
    { enabled: state.view === "workers" && !state.worker && known },
  );
  const person = useMdQuery<ProdPersonResponse>(
    `payroll/production/people/${state.worker ?? 0}`,
    { periods: WORKER_PERIODS },
    { enabled: !!state.worker },
  );
  return { overview, departments, people, person, cycle, period };
}

export type ProdQueries = ReturnType<typeof useProductionPayroll>;
