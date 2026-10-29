import { describe, expect, it } from "vitest";
import { getJourneyDayMapQueryKey, readJourneyDayMap } from "./geo-day-map";
import { getJourneysRootKey } from "./geo-tracking";

// GET /api/tracking/journeys/day-map: the journeys of a day with their routes, read tolerantly like the rest of geo-tracking.

describe("readJourneyDayMap", () => {
  it("reads every journey with its list-row fields, its last known position and its segments in time order", () => {
    const map = readJourneyDayMap({
      date: "2026-10-28",
      journeys: [
        {
          id: 7,
          employeeId: 11,
          employeeName: "Asha Kumar",
          status: "active",
          state: "moving",
          lastLatitude: "11.02",
          lastLongitude: 77.02,
          distanceM: 3200,
          segments: [
            {
              seqNo: 2,
              kind: "stop",
              startedAt: "2026-10-28T09:30:00+05:30",
              centerLat: 11.02,
              centerLng: 77.02,
              durationS: 600,
            },
            {
              seqNo: 1,
              kind: "travel",
              startedAt: "2026-10-28T09:00:00+05:30",
              polyline: [
                [11, 77],
                [11.02, 77.02],
              ],
            },
          ],
        },
      ],
    });
    expect(map.date).toBe("2026-10-28");
    expect(map.journeys).toHaveLength(1);
    const j = map.journeys[0];
    expect([j.id, j.employeeName, j.status, j.state, j.distanceM]).toEqual([7, "Asha Kumar", "active", "moving", 3200]);
    expect([j.lastLatitude, j.lastLongitude]).toEqual([11.02, 77.02]); // a decimal that came as text
    expect(j.segments.map((s) => [s.seqNo, s.kind])).toEqual([
      [1, "travel"],
      [2, "stop"],
    ]);
    expect(j.segments[0].polyline).toEqual([
      [11, 77],
      [11.02, 77.02],
    ]);
  });

  it("copes with a missing wrapper, a missing list and garbage", () => {
    expect(readJourneyDayMap(null, "2026-10-28")).toEqual({ date: "2026-10-28", journeys: [] });
    expect(readJourneyDayMap({}, "2026-10-27").journeys).toEqual([]);
    expect(readJourneyDayMap([{ id: 3, segments: "nope" }]).journeys[0].segments).toEqual([]);
    expect(readJourneyDayMap({ journeys: ["x", 4, null] }).journeys).toHaveLength(3);
  });
});

describe("the query key", () => {
  it("sits under the journeys' own root, so rebuilding a journey refreshes the map, and holds the day", () => {
    const key = getJourneyDayMapQueryKey("2026-10-28");
    expect(key.slice(0, getJourneysRootKey().length)).toEqual([...getJourneysRootKey()]);
    expect(key).toContain("2026-10-28");
    expect(getJourneyDayMapQueryKey("2026-10-27")).not.toEqual(key);
  });
});
