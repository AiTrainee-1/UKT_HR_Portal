import { useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import type {
  GeoAttention,
  GeoBreakdown,
  GeoBriefing,
  GeoLive,
  GeoPeople,
  GeoReach,
  GeoSummary,
  GeoTrend,
  GeoUnusual,
  GeoVerification,
  GroupBy,
} from "./types";

/** How often the live picture asks again: people go out and come back all day. */
export const LIVE_REFRESH_MS = 60_000;

/** Every request the Insights tab makes, one per card, so a slow or failed one never blanks the others. The live picture
 *  has no period: it is "right now" for the chosen unit, department and type. */
export function useGeoData(params: MdQueryParams, scope: MdQueryParams, by: GroupBy) {
  return {
    summary: useMdQuery<GeoSummary>("geo/summary", params),
    briefing: useMdQuery<GeoBriefing>("geo/briefing", params),
    attention: useMdQuery<GeoAttention>("geo/attention", params),
    trend: useMdQuery<GeoTrend>("geo/trend", params),
    verification: useMdQuery<GeoVerification>("geo/verification", params),
    groups: useMdQuery<GeoBreakdown>("geo/departments", { ...params, by, limit: 25 }),
    reach: useMdQuery<GeoReach>("geo/reach", params),
    unusual: useMdQuery<GeoUnusual>("geo/unusual", { ...params, limit: 25 }),
    people: useMdQuery<GeoPeople>("geo/people", { ...params, limit: 25 }),
    live: useMdQuery<GeoLive>("geo/live", scope, { refetchInterval: LIVE_REFRESH_MS }),
  };
}
