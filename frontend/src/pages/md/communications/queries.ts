// The page's state in the address and its four read-only queries (types.ts). Every query keeps its previous answer on
// screen while a changed filter loads (useMdQuery), so a card shows its skeleton only on the first load.

import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useMdQuery } from "@/lib/api-client/custom-hooks/md";
import {
  applyCommsPatch,
  commsSearch,
  historyParams,
  parseCommsState,
  type CommsPatch,
  type CommsState,
} from "./logic";
import type { CommsHistory, CommsMonth, CommsOverview, SmsBalance } from "./types";

/** The page state, read from the address and written back to it (a replace: filters do not pile up in the history). */
export function useCommsState() {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const state = useMemo(() => parseCommsState(search), [search]);
  const update = useCallback(
    (patch: CommsPatch) => navigate(`${path}${commsSearch(applyCommsPatch(state, patch))}`, { replace: true }),
    [state, path, navigate],
  );
  return [state, update] as const;
}

export type CommsUpdate = ReturnType<typeof useCommsState>[1];

export const SERIES_MONTHS = 12;

/**
 * The overview (KPIs, 12 months, insights) and the month's breakdown follow the month (none = this month: the server
 * decides, so nothing waits on another query); the history follows the month or its own date range, the channel and its
 * filters. The SMS credits are a live read from 2Factor (cached 5 minutes on the server), so they load on their own and
 * never hold the page up.
 */
export function useCommsData(state: CommsState) {
  const overview = useMdQuery<CommsOverview>("comms/overview", { month: state.month, months: SERIES_MONTHS });
  const month = state.month || overview.data?.month || "";
  const detail = useMdQuery<CommsMonth>("comms/month", { month: state.month });
  const history = useMdQuery<CommsHistory>("comms/history", historyParams(state));
  const balance = useMdQuery<SmsBalance>("comms/sms-balance", undefined, { staleTime: 5 * 60_000 });
  return { overview, detail, history, balance, month };
}

export type CommsData = ReturnType<typeof useCommsData>;
