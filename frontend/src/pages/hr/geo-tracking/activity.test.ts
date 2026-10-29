import { describe, expect, it } from "vitest";
import { readJourneyDetail } from "@/lib/api-client/custom-hooks";
import { buildActivities, journeyStats, legText, timeSplit } from "./activity";
import { buildTimeline } from "./logic";
import { IST, detailFixture, listItem } from "./testing";

// The journey told as a story: started, break, resumed, break, ..., completed. Pure functions, no React, no server.

const story = (raw: Record<string, unknown>, active = false, options = {}) => {
  const detail = readJourneyDetail(raw);
  const rows = buildTimeline(detail.segments, detail.events, active);
  return { detail, rows, items: buildActivities(detail, rows, active, options) };
};

const stop = (seqNo: number, from: string, to: string, over: Record<string, unknown> = {}) => ({
  seqNo,
  kind: "stop",
  startedAt: IST(from),
  endedAt: IST(to),
  durationS: (Date.parse(IST(to)) - Date.parse(IST(from))) / 1000,
  centerLat: 11.0 + seqNo / 100,
  centerLng: 77.0,
  radiusM: 12,
  address: "",
  ...over,
});

const travel = (seqNo: number, from: string, to: string, over: Record<string, unknown> = {}) => ({
  seqNo,
  kind: "travel",
  startedAt: IST(from),
  endedAt: IST(to),
  durationS: (Date.parse(IST(to)) - Date.parse(IST(from))) / 1000,
  distanceM: 4000,
  startLat: 11.0 + (seqNo - 1) / 100,
  startLng: 77.0,
  endLat: 11.0 + seqNo / 100,
  endLng: 77.0,
  polyline: [],
  avgSpeedKmh: 30,
  estimated: false,
  ...over,
});

describe("the journey as a story", () => {
  it("tells the recorded journey in order: started, breaks, resumed, no location, completed", () => {
    const { items } = story(detailFixture(7));
    expect(items.map((a) => a.title)).toEqual([
      "Journey started",
      "Break taken",
      "Location not recorded",
      "Break taken",
      "Journey resumed",
      "Network lost",
      "Location permission changed",
      "On-duty completed",
    ]);
    expect(items.map((a) => a.kind)).toEqual(["start", "break", "gap", "break", "resume", "notice", "notice", "end"]);
  });

  it("numbers the breaks, marks a break of 15 minutes or more as long, and gives each break its place and length", () => {
    const { items } = story(detailFixture(7));
    const breaks = items.filter((a) => a.kind === "break");
    expect(breaks.map((b) => b.breakNumber)).toEqual([1, 2]);
    expect(breaks.map((b) => b.longBreak)).toEqual([false, true]);
    expect(breaks.map((b) => b.durationS)).toEqual([480, 1500]);
    expect(breaks[0].place).toBe("11.02000, 77.02000");
    // the address the geocoder knew is the place; the coordinates are still in the facts
    expect(breaks[1].place).toBe("Buyer office, Avinashi Road");
    expect(breaks[1].facts).toContainEqual(["Coordinates", "11.04000, 77.04000"]);
    expect(breaks[0].selectKey).toBe("seg-2");
  });

  it("puts the travel that led to an item on the line before it, and 'resumed' where travel starts after a break", () => {
    const { items } = story(detailFixture(7));
    const first = items.find((a) => a.kind === "break");
    expect(first?.legBefore).toMatchObject({ key: "seg-1", distanceM: 3200, durationS: 1500, avgKmh: 28 });
    const resumed = items.find((a) => a.kind === "resume");
    expect(resumed).toMatchObject({ selectKey: "seg-5", note: "Left after a break of 25 min" });
    // the last stretch (estimated) joins "resumed" to the end of the journey
    const end = items[items.length - 1];
    expect(end.legBefore).toMatchObject({ key: "seg-5", estimated: true });
    expect(end.note).toBe("Marked done by the employee");
  });

  it("tells a gap once: the event that caused it is a fact of the gap, not an item of its own", () => {
    const { items } = story(detailFixture(7));
    const gap = items.find((a) => a.kind === "gap");
    expect(gap?.note).toBe("Location services were off");
    expect(gap?.durationS).toBe(900);
    expect(gap?.facts).toContainEqual(["Location services turned off", "10:10:00 - 10:25:00"]);
    expect(gap?.rowKeys).toEqual(["seg-3", "ev-2"]);
    // a network loss that no gap explains, and a permission change, stay as notices; started / stopped are not items
    expect(items.filter((a) => a.kind === "notice").map((a) => a.rowKeys)).toEqual([["ev-3"], ["ev-4"]]);
    expect(items.some((a) => a.title.startsWith("Tracking"))).toBe(false);
  });

  it("starts at the tracking start and the first position, and points the first and last items at the map when asked", () => {
    const { items } = story(detailFixture(7), false, { startKey: "pt-1", endKey: "pt-99" });
    expect(items[0]).toMatchObject({
      title: "Journey started",
      selectKey: "pt-1",
      rowKeys: ["pt-1"],
      place: "11.00000, 77.00000",
    });
    expect(items[0].note).toBe('On-Duty to "Tirupur buyer visit"');
    expect(items[items.length - 1]).toMatchObject({ kind: "end", selectKey: "pt-99" });
    expect(items[items.length - 1].place).toBe("11.06000, 77.06000");
  });

  it("ends with 'on duty now' while the journey is still recorded", () => {
    const { items } = story(
      detailFixture(7, {
        track: { status: "active", endReason: "", endedAt: null, state: "moving", stateSince: IST("11:20") },
      }),
      true,
    );
    const last = items[items.length - 1];
    expect(last).toMatchObject({ kind: "live", title: "On duty now", open: true });
    expect(last.note).toContain("Moving since 11:20");
  });

  it("says when the request was rejected", () => {
    const { items } = story(detailFixture(7, { track: { endReason: "rejected" } }));
    expect(items[items.length - 1].title).toBe("Request rejected, tracking stopped");
  });

  it("still tells a journey with nothing in it: its start and its end", () => {
    const { items } = story(detailFixture(7, { segments: [], events: [] }));
    expect(items.map((a) => a.kind)).toEqual(["start", "end"]);
  });

  it("follows what was recorded, not a fixed sequence: a journey that never stopped has no breaks and no 'resumed'", () => {
    const { items, detail } = story(
      detailFixture(7, { segments: [travel(1, "09:05", "09:45"), travel(2, "09:45", "10:20")], events: [] }),
    );
    expect(items.map((a) => a.kind)).toEqual(["start", "end"]);
    expect(items[1].legBefore?.key).toBe("seg-2");
    expect(journeyStats(detail, items)).toMatchObject({ breakCount: 0, resumed: 0, legCount: 2 });
  });

  it("sets off again after every break: three breaks mean three 'resumed' items", () => {
    const { items } = story(
      detailFixture(7, {
        segments: [
          stop(1, "09:00", "09:10"),
          travel(2, "09:10", "09:30"),
          stop(3, "09:30", "09:40"),
          travel(4, "09:40", "10:00"),
          stop(5, "10:00", "10:30"),
          travel(6, "10:30", "10:50"),
        ],
        events: [],
      }),
    );
    expect(items.map((a) => a.kind)).toEqual(["start", "break", "resume", "break", "resume", "break", "resume", "end"]);
    expect(items.filter((a) => a.kind === "break").map((b) => b.legBefore?.key ?? null)).toEqual([
      null,
      "seg-2",
      "seg-4",
    ]);
  });
});

describe("the figures of the story", () => {
  it("counts breaks, long breaks, the longest and the average, starts and resumes, and takes the totals from the journey", () => {
    const { detail, items } = story(detailFixture(7));
    const stats = journeyStats(detail, items);
    expect(stats).toMatchObject({
      journeyS: 31200,
      travelS: 11400,
      breakS: 3600,
      gapS: 900,
      distanceM: 14250,
      breakCount: 2,
      longBreakCount: 1,
      longestBreakS: 1500,
      averageBreakS: 1800,
      started: 1,
      resumed: 1,
      gapCount: 1,
      legCount: 2,
    });
  });

  it("splits the time between the road, the breaks and the gaps, never more than the whole", () => {
    const { detail, items } = story(detailFixture(7));
    const split = timeSplit(journeyStats(detail, items));
    expect(split.travel + split.breaks + split.gap + split.other).toBeCloseTo(1, 6);
    expect(split.travel).toBeCloseTo(11400 / 31200, 4);
    expect(split.breaks).toBeCloseTo(3600 / 31200, 4);
    // measured time longer than the whole journey (a rebuild in progress) is scaled, not drawn past the end
    const over = timeSplit({ ...journeyStats(detail, items), journeyS: 100 });
    expect(over.travel + over.breaks + over.gap + over.other).toBeCloseTo(1, 6);
  });

  it("writes a leg in words", () => {
    expect(
      legText({
        key: "seg-1",
        distanceM: 12260,
        durationS: 1140,
        avgKmh: 38.4,
        estimated: false,
        startedAt: null,
        endedAt: null,
      }),
    ).toBe("12.26 km in 19 min, 38 km/h on average");
    expect(
      legText({
        key: "seg-1",
        distanceM: 24,
        durationS: 16,
        avgKmh: 0,
        estimated: false,
        startedAt: null,
        endedAt: null,
      }),
    ).toBe("24 m in 16 s");
  });

  it("reads a track with no times without breaking", () => {
    const { detail, items } = story({
      track: listItem(1, { startedAt: null, endedAt: null, durationS: 0, lastPointAt: null }),
      segments: [],
      events: [],
      path: [],
    });
    const stats = journeyStats(detail, items);
    expect(stats.journeyS).toBe(0);
    expect(items[0].title).toBe("Journey started");
  });
});
