// Geo Attendance: the open tab and the open journey live in the page address (/hr/geo-attendance?tab=journeys&journey=12), so a
// journey can be linked to, "Open journey" on the Live Map can jump to it, and a refresh comes back to the same place.
import { useCallback, useEffect, useState } from "react";

export type GeoTab = "approvals" | "verifications" | "map" | "journeys" | "onduty" | "tracking";

export const GEO_TABS: readonly GeoTab[] = ["approvals", "verifications", "map", "journeys", "onduty", "tracking"];
export const DEFAULT_GEO_TAB: GeoTab = "approvals";

/** The tab and journey the address names (an unknown tab is the first one; a bad journey id is none). */
export function readGeoAddress(search: string): { tab: GeoTab; journey: number | null } {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "";
  const journey = Number(params.get("journey"));
  return {
    tab: (GEO_TABS as readonly string[]).includes(tab) ? (tab as GeoTab) : DEFAULT_GEO_TAB,
    journey: Number.isInteger(journey) && journey > 0 ? journey : null,
  };
}

/** The address search for a tab (and journey), keeping any other parameter. */
export function geoAddress(search: string, tab: GeoTab, journey: number | null): string {
  const params = new URLSearchParams(search);
  if (tab === DEFAULT_GEO_TAB) params.delete("tab");
  else params.set("tab", tab);
  if (tab === "journeys" && journey !== null) params.set("journey", String(journey));
  else params.delete("journey");
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function useGeoAddress() {
  const [state, setState] = useState(() => readGeoAddress(typeof window === "undefined" ? "" : window.location.search));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = geoAddress(window.location.search, state.tab, state.journey);
    if (next !== window.location.search) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${next}${window.location.hash}`,
      );
    }
  }, [state]);

  const setTab = useCallback(
    (tab: GeoTab) => setState((s) => ({ tab, journey: tab === "journeys" ? s.journey : null })),
    [],
  );
  const setJourney = useCallback((journey: number | null) => setState({ tab: "journeys", journey }), []);
  return { tab: state.tab, journeyId: state.journey, setTab, setJourney };
}
