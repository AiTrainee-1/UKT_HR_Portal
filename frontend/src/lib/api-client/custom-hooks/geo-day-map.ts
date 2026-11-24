// geo-day-map: the On-Duty Map's one-request feed of a day's journeys (GET /api/tracking/journeys/day-map?date=YYYY-MM-DD): every
// journey that was recording on that India day with its route (the segments: travel polylines, stops, gaps), so the map draws
// every employee's journey without one detail request per journey. Read-only; refreshed every 30 s.
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import {
  getJourneysRootKey,
  readJourneySegment,
  readJourneyTrack,
  type JourneySegment,
  type JourneyTrack,
} from "./geo-tracking";

/** One journey of the day: the list row and the last known position, with its segments in time order. */
export type DayMapJourney = JourneyTrack & { segments: JourneySegment[] };

/** `from` / `to` / `truncated` only when the map was asked for several days (the date filter, 2026-11-24): the server
 *  then sends at most its own cap of journeys, the latest ones, and says when it left some out. */
export type JourneyDayMap = { date: string; journeys: DayMapJourney[]; truncated?: boolean };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function readJourneyDayMap(raw: unknown, fallbackDate = ""): JourneyDayMap {
  const root = isObj(raw) ? raw : {};
  const rows = Array.isArray(root.journeys) ? root.journeys : Array.isArray(raw) ? raw : [];
  const startOf = (a: { startedAt: string | null }) => (a.startedAt ? Date.parse(a.startedAt) : 0);
  return {
    date: typeof root.date === "string" ? root.date : fallbackDate,
    ...(root.truncated === true ? { truncated: true } : {}),
    journeys: rows.map((row): DayMapJourney => {
      const r = isObj(row) ? row : {};
      const segments = (Array.isArray(r.segments) ? r.segments : [])
        .map((s, i) => readJourneySegment(s, i))
        .sort((a, b) => startOf(a) - startOf(b) || a.seqNo - b.seqNo);
      return { ...readJourneyTrack(r), segments };
    }),
  };
}

/** Under the journeys' own root key, so rebuilding a journey refreshes the map too. */
export const getJourneyDayMapQueryKey = (date: string) => [...getJourneysRootKey(), "day-map", date] as const;

/** Every journey of a day (`date`), or of the date filter's days (`days`: from / to, YYYY-MM-DD, India). */
export const useJourneyDayMap = (date: string, enabled = true, days?: { from: string; to: string }) =>
  useQuery<JourneyDayMap>({
    queryKey: days ? getJourneyDayMapQueryKey(`${days.from}_${days.to}`) : getJourneyDayMapQueryKey(date),
    queryFn: async () =>
      readJourneyDayMap(
        await customFetch<unknown>(
          `/api/tracking/journeys/day-map?${
            days ? new URLSearchParams({ from: days.from, to: days.to }).toString() : `date=${encodeURIComponent(date)}`
          }`,
        ),
        days ? days.to : date,
      ),
    // a day's routes, not a live board: every 30 s, like the On-Duty feed it is drawn with
    refetchInterval: 30_000,
    retry: false,
    enabled,
  });
