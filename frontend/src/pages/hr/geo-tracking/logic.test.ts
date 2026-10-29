import { describe, expect, it } from "vitest";
import {
  readJourneyDetail,
  readJourneyEvent,
  readJourneySegment,
  readJourneyTrail,
  readLiveTracks,
  type JourneyEvent,
  type JourneySegment,
} from "@/lib/api-client/custom-hooks";
import {
  approvalGroup,
  approvalLabel,
  boundsOf,
  buildTimeline,
  causeLabel,
  endReasonLabel,
  eventDetail,
  eventStyle,
  fmtDateTime,
  fmtDistance,
  fmtDuration,
  fmtTime,
  humanise,
  accuracyWord,
  activityLabel,
  fmtAccuracy,
  fmtSpeed,
  groupStops,
  isLongStop,
  istDay,
  mapModel,
  networkLabel,
  pointFacts,
  providerLabel,
  SAME_PLACE_M,
  sameReason,
  sortLive,
  stopGroupLabel,
  timeAgo,
  timeRange,
  trailKey,
  trailModel,
  LONG_STOP_S,
  TRAIL_BREAK_MS,
} from "./logic";
import { detailFixture, listItem, liveRow, trailFixture } from "./testing";

// The words, figures and map geometry of Journey History: no React, no server.

describe("durations and distances", () => {
  it("writes a duration as seconds, minutes, or hours and minutes", () => {
    expect(fmtDuration(0)).toBe("0 s");
    expect(fmtDuration(45)).toBe("45 s");
    expect(fmtDuration(60)).toBe("1 min");
    expect(fmtDuration(719)).toBe("11 min");
    expect(fmtDuration(3600)).toBe("1 h");
    expect(fmtDuration(5100)).toBe("1 h 25 min");
    expect(fmtDuration(null)).toBe("-");
    expect(fmtDuration(Number.NaN)).toBe("-");
    expect(fmtDuration(-5)).toBe("0 s");
  });

  it("writes a distance in metres under a kilometre and kilometres above", () => {
    expect(fmtDistance(0)).toBe("0 m");
    expect(fmtDistance(849.6)).toBe("850 m");
    expect(fmtDistance(3240)).toBe("3.24 km");
    expect(fmtDistance(125400)).toBe("125.4 km");
    expect(fmtDistance(undefined)).toBe("-");
  });

  it("calls a stop of 15 minutes or more a long stop, and a shorter one waiting", () => {
    expect(LONG_STOP_S).toBe(900);
    expect(isLongStop(899)).toBe(false);
    expect(isLongStop(900)).toBe(true);
  });
});

describe("times are India time whatever the browser's zone", () => {
  it("formats a UTC time as the factory clock", () => {
    // 09:30 UTC is 15:00 in India
    expect(fmtTime("2026-10-28T09:30:00Z")).toBe("15:00");
    expect(fmtTime("2026-10-28T09:30:15Z", true)).toBe("15:00:15");
    expect(fmtDateTime("2026-10-28T09:30:00Z")).toBe("28 Oct, 15:00");
    expect(istDay("2026-10-28T20:00:00Z")).toBe("2026-10-29");
    expect(fmtTime(null)).toBe("-");
    expect(fmtTime("not a time")).toBe("-");
  });

  it("writes a range with the day only when it crosses midnight", () => {
    expect(timeRange("2026-10-28T09:30:00+05:30", "2026-10-28T09:38:00+05:30")).toBe("09:30 - 09:38");
    expect(timeRange("2026-10-28T09:30:00+05:30", "2026-10-28T09:30:20+05:30")).toBe("09:30");
    expect(timeRange("2026-10-28T23:30:00+05:30", "2026-10-29T00:10:00+05:30")).toBe("28 Oct, 23:30 - 29 Oct, 00:10");
    expect(timeRange("2026-10-28T09:30:00+05:30", null, true)).toBe("09:30 - now");
    expect(timeRange("2026-10-28T09:30:00+05:30", null)).toBe("09:30");
    expect(timeRange(null, null)).toBe("-");
  });

  it("says how long ago a time was", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(timeAgo("2026-10-28T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-28T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-10-28T09:50:00Z", now)).toBe("2 h 10 min ago");
    expect(timeAgo("2026-10-28T10:00:00Z", now)).toBe("2 h ago");
    expect(timeAgo("2026-10-25T12:00:00Z", now)).toBe("3 d ago");
    expect(timeAgo(null, now)).toBe("never");
  });
});

describe("labels", () => {
  it("names how a journey ended, and that an active one has not", () => {
    expect(endReasonLabel("manual")).toBe("Marked done by the employee");
    expect(endReasonLabel("auto_4th_punch")).toBe("4th punch captured");
    expect(endReasonLabel("auto_day_end")).toBe("Closed automatically at day end");
    expect(endReasonLabel("rejected")).toBe("Request rejected");
    expect(endReasonLabel("admin")).toBe("Closed by an administrator");
    expect(endReasonLabel("", "ended")).toBe("Ended");
    expect(endReasonLabel("manual", "active")).toBe("Still tracking");
  });

  it("groups the approval stage of the request into pending, approved or rejected", () => {
    for (const raw of ["pending_hod", "pending_hr", "pending"]) expect(approvalGroup(raw)).toBe("pending");
    for (const raw of ["active", "completed", "approved"]) expect(approvalGroup(raw)).toBe("approved");
    expect(approvalGroup("rejected")).toBe("rejected");
    expect(approvalGroup("")).toBe("unknown");
    expect(approvalLabel("pending_hod")).toBe("Awaiting Department Head");
    expect(approvalLabel("pending_hr")).toBe("Awaiting HR");
    expect(approvalLabel("pending")).toBe("Approval pending");
    expect(approvalLabel("active")).toBe("Approved");
    expect(approvalLabel("rejected")).toBe("Rejected");
    expect(approvalLabel(null)).toBe("Unknown");
  });

  it("explains the cause of a gap, and writes a cause nobody wrote a sentence for in plain words", () => {
    expect(causeLabel("gps_off")).toBe("Location services were off");
    expect(causeLabel("device_shutdown")).toBe("Phone was switched off");
    expect(causeLabel("unknown")).toBe("Cause unknown");
    expect(causeLabel("sim_removed")).toBe("Sim removed");
    expect(causeLabel("")).toBe("");
    expect(humanise("GPS_OFF")).toBe("Gps off");
  });

  it("gives every event kind of the contract its own colour and a sentence, and an unknown kind a neutral one", () => {
    const kinds = [
      "TRACKING_STARTED",
      "TRACKING_STOPPED",
      "GPS_OFF",
      "NETWORK_LOST",
      "AIRPLANE_ON",
      "POWER_SAVE_ON",
      "PERMISSION_CHANGED",
      "LOW_BATTERY",
      "MOCK_LOCATION",
      "CLOCK_CHANGED",
      "APP_RESTARTED",
      "APP_KILLED",
      "DEVICE_SHUTDOWN",
      "DEVICE_BOOT",
      "BACKGROUND_RESTRICTED",
      "SIGNAL_LOST",
      "SERVER_NOTE",
    ];
    for (const k of kinds) expect(eventStyle(k).label, k).not.toBe("");
    // the ones HR must tell apart at a glance have distinct colours
    const colours = [
      "GPS_OFF",
      "NETWORK_LOST",
      "APP_KILLED",
      "DEVICE_SHUTDOWN",
      "MOCK_LOCATION",
      "PERMISSION_CHANGED",
    ].map((k) => eventStyle(k).color);
    expect(new Set(colours).size).toBeGreaterThanOrEqual(5);
    expect(eventStyle("MOCK_LOCATION").color).toBe("#dc2626"); // the red of the "simulated location" styling
    expect(eventStyle("TRACKING_STARTED").onMap).toBe(false);
    expect(eventStyle("SOMETHING_NEW")).toMatchObject({ label: "Something new", glyph: "dot", onMap: true });
  });

  it("adds what an event meant: a permission change, a battery level, a note", () => {
    const ev = (kind: string, meta: Record<string, unknown>): JourneyEvent => readJourneyEvent({ id: 1, kind, meta });
    expect(eventDetail(ev("PERMISSION_CHANGED", { from: "always", to: "while_using" }))).toBe("Always to While using");
    expect(eventDetail(ev("LOW_BATTERY", { batteryPct: 14.2 }))).toBe("14%");
    expect(eventDetail(ev("SERVER_NOTE", { note: "Closed by Asha" }))).toBe("Closed by Asha");
    expect(eventDetail(ev("GPS_OFF", {}))).toBe("");
  });

  it("orders the live board so the rows that need a look come first", () => {
    const rows = readLiveTracks([
      liveRow(1, { state: "moving", employeeName: "B" }),
      liveRow(2, { state: "location_off", employeeName: "Z" }),
      liveRow(3, { state: "stationary", employeeName: "A" }),
      liveRow(4, { state: "offline", employeeName: "M" }),
      liveRow(5, { state: "moving", employeeName: "A" }),
    ]);
    // location off, offline, moving (by name), stationary
    expect(sortLive(rows).map((r) => r.trackId)).toEqual([2, 4, 5, 1, 3]);
  });

  it("filters by end reason: an active journey never matches one", () => {
    const active = readJourneyDetail({ track: listItem(1, { status: "active", endReason: "" }) }).track;
    const done = readJourneyDetail({ track: listItem(2, { endReason: "rejected" }) }).track;
    expect(sameReason(active, "")).toBe(true);
    expect(sameReason(active, "manual")).toBe(false);
    expect(sameReason(done, "rejected")).toBe(true);
    expect(sameReason(done, "manual")).toBe(false);
  });
});

describe("the merged timeline", () => {
  const detail = readJourneyDetail(detailFixture(7));
  const rows = buildTimeline(detail.segments, detail.events, false);

  it("puts travel, stationary periods, gaps and events in one list by time", () => {
    expect(rows.map((r) => `${r.type}:${r.key}`)).toEqual([
      "event:ev-1", // tracking started 09:00
      "travel:seg-1", // 09:05
      "stop:seg-2", // 09:30
      "gap:seg-3", // 10:10 (the GPS_OFF event starts at the same minute: the segment first)
      "event:ev-2",
      "stop:seg-4", // 10:25
      "travel:seg-5", // 10:50
      "event:ev-3", // 11:00
      "event:ev-4", // 11:10
      "event:ev-5", // 17:40
    ]);
  });

  it("numbers the stops and calls them waiting under 15 minutes and a long stop from 15 on", () => {
    const stops = rows.filter((r) => r.type === "stop");
    expect(stops.map((s) => s.stopNumber)).toEqual([1, 2]);
    expect(stops.map((s) => s.longStop)).toEqual([false, true]);
    expect(stops.map((s) => s.durationS)).toEqual([480, 1500]);
    // the place of a stop: its address, else its coordinates; the other one is the second line
    expect(stops[0].title).toBe("11.02000, 77.02000");
    expect(stops[0].detail).toBe("positions within 40 m");
    expect(stops[1].title).toBe("Buyer office, Avinashi Road");
    expect(stops[1].detail).toBe("11.04000, 77.04000");
  });

  it("gives a gap its cause, a travel its distance and an event its name and duration", () => {
    const gap = rows.find((r) => r.key === "seg-3")!;
    expect(gap.cause).toBe("gps_off");
    expect(gap.durationS).toBe(900);
    const travel = rows.find((r) => r.key === "seg-1")!;
    expect(travel.distanceM).toBe(3200);
    expect(travel.title).toBe("Travelled 3.20 km, 28 km/h on average");
    expect(rows.find((r) => r.key === "seg-5")!.estimated).toBe(true);
    const off = rows.find((r) => r.key === "ev-2")!;
    expect(off.title).toBe("Location services turned off");
    expect(off.durationS).toBe(900);
    expect(rows.find((r) => r.key === "ev-4")!.detail).toBe("Always to While using");
  });

  it("marks an interval that has not closed on an active track as ongoing", () => {
    const open: JourneyEvent[] = [
      readJourneyEvent({ id: 9, kind: "NETWORK_LOST", startedAt: "2026-10-28T11:00:00+05:30", endedAt: null }),
      readJourneyEvent({ id: 10, kind: "APP_KILLED", startedAt: "2026-10-28T11:01:00+05:30", endedAt: null }),
    ];
    const active = buildTimeline([], open, true);
    expect(active.map((r) => r.open)).toEqual([true, false]); // a point event (app killed) is never "ongoing"
    expect(buildTimeline([], open, false).map((r) => r.open)).toEqual([false, false]);
  });

  it("marks simulated (fake GPS) parts", () => {
    const segs: JourneySegment[] = [
      readJourneySegment({ seqNo: 1, kind: "travel", startedAt: "2026-10-28T09:00:00+05:30", meta: { mockPoints: 4 } }),
      readJourneySegment({ seqNo: 2, kind: "travel", startedAt: "2026-10-28T09:10:00+05:30", meta: {} }),
    ];
    expect(buildTimeline(segs, [], false).map((r) => r.mock)).toEqual([true, false]);
  });
});

describe("the map geometry", () => {
  const detail = readJourneyDetail(detailFixture(7));
  const rows = buildTimeline(detail.segments, detail.events, false);
  const model = mapModel(detail, rows);

  it("draws travel as lines, gaps as one straight line, stops as numbered pins and events that have a place", () => {
    expect(model.travel.map((t) => [t.key, t.line.length, t.estimated])).toEqual([
      ["seg-1", 3, false],
      ["seg-5", 2, true],
    ]);
    expect(model.gaps.map((g) => g.key)).toEqual(["seg-3"]);
    expect(model.gaps[0].line).toEqual([
      [11.03, 77.03],
      [11.035, 77.035],
    ]);
    expect(model.stops.map((s) => [s.key, s.row.stopNumber])).toEqual([
      ["seg-2", 1],
      ["seg-4", 2],
    ]);
    // tracking started / stopped have no place and are not pins; the others are
    expect(model.events.map((e) => e.event.kind)).toEqual(["GPS_OFF", "NETWORK_LOST", "PERMISSION_CHANGED"]);
  });

  it("starts at the first travel and ends at the last known position", () => {
    expect(model.start).toEqual([11.0, 77.0]);
    expect(model.end).toEqual([11.06, 77.06]);
  });

  it("falls back to the overall path when nothing has been rebuilt yet, and to nothing when there is no position", () => {
    const bare = readJourneyDetail(detailFixture(7, { segments: [], events: [] }));
    const fromPath = mapModel(bare, []);
    expect(fromPath.travel).toHaveLength(1);
    expect(fromPath.travel[0].line).toHaveLength(3);
    const empty = readJourneyDetail({ track: listItem(1, { status: "active" }), segments: [], events: [], path: [] });
    const none = mapModel(empty, []);
    expect(none.all).toEqual([]);
    expect(none.start).toBeNull();
    expect(none.end).toBeNull();
  });

  it("ignores a position at (0, 0) or outside the globe", () => {
    const odd = readJourneyDetail({
      track: listItem(1, {}),
      segments: [{ seqNo: 1, kind: "stop", startedAt: "2026-10-28T09:00:00+05:30", centerLat: 0, centerLng: 0 }],
      events: [{ id: 1, kind: "GPS_OFF", startedAt: "2026-10-28T09:00:00+05:30", latitude: 95, longitude: 10 }],
    });
    const m = mapModel(odd, buildTimeline(odd.segments, odd.events));
    expect(m.stops).toEqual([]);
    expect(m.events).toEqual([]);
  });

  it("boxes a set of points", () => {
    expect(boundsOf([])).toBeNull();
    expect(
      boundsOf([
        [11.0, 77.1],
        [11.2, 77.0],
        [10.9, 77.3],
      ]),
    ).toEqual([
      [10.9, 77.0],
      [11.2, 77.3],
    ]);
    expect(boundsOf(model.all)).toEqual([
      [11.0, 77.0],
      [11.06, 77.06],
    ]);
  });
});

describe("the route trail", () => {
  const detail = readJourneyDetail(detailFixture(7));
  const rows = buildTimeline(detail.segments, detail.events);

  it("reads every position of the trail endpoint, in time order, tolerating missing fields", () => {
    const trail = readJourneyTrail(trailFixture(7));
    expect(trail.trackId).toBe(7);
    expect(trail.source).toBe("points");
    expect(trail.count).toBe(29);
    expect(trail.total).toBe(29);
    expect(trail.truncated).toBe(false);
    expect(trail.points.map((p) => p.t)).toEqual([...trail.points.map((p) => p.t)].sort((a, b) => a - b));
    const stopPoint = trail.points.find((p) => p.stop === 2)!;
    expect(stopPoint).toMatchObject({
      activity: "still",
      speedKmh: 0,
      accuracyM: 12,
      batteryPct: 64,
      network: "cell",
      provider: "fused",
    });
    expect(trail.points.filter((p) => !p.used)).toHaveLength(1);
    // junk and an old spelling are survived
    const odd = readJourneyTrail({
      points: [
        { t: "2026-10-28T09:00:00+05:30", latitude: "11.5", longitude: 77.5, accuracyM: 9 },
        { lat: 1 },
        null,
        5,
      ],
      truncated: true,
      total: 900,
    });
    expect(odd.points).toHaveLength(1);
    expect(odd.points[0]).toMatchObject({
      lat: 11.5,
      lng: 77.5,
      accuracyM: 9,
      used: true,
      stop: null,
      activity: "unknown",
    });
    expect(odd.truncated).toBe(true);
    expect(odd.total).toBe(900);
    expect(readJourneyTrail(null).points).toEqual([]);
    expect(readJourneyTrail({ source: "segments" }).source).toBe("segments");
  });

  it("draws the whole route: a line per stretch (travel, each stop, travel) and a dot per position", () => {
    const model = trailModel(readJourneyTrail(trailFixture(7)), rows)!;
    expect(model.dots).toHaveLength(29);
    expect(model.used).toBe(28);
    expect(model.poor).toBe(1);
    expect(model.total).toBe(29);
    expect(model.runs.map((r) => [r.stopNumber, r.longStop, r.line.length])).toEqual([
      [null, false, 7], // travel to the first stop
      [1, false, 4], // stop 1 (8 min: waiting); starts at the last travelling position so the line stays connected
      [2, true, 7], // stop 2 (25 min: a long stop); the 5-minute silence before it is not a line
      [null, false, 12], // travel on, starting at the last position of stop 2
    ]);
    // a dot knows the stop it belongs to (the number on the pin), and a position set aside is still there
    expect(model.dots.filter((d) => d.stopNumber === 1)).toHaveLength(3);
    expect(model.dots.filter((d) => d.stopNumber === 2)).toHaveLength(7);
    expect(model.dots.filter((d) => !d.point.used)).toHaveLength(1);
    const first = model.dots[0];
    expect(model.byKey.get(first.key)).toBe(first);
    expect(first.key).toBe(trailKey(first.point));
  });

  it("does not join positions that are far apart in time: the gap segment draws that", () => {
    const t0 = Date.parse("2026-10-28T09:00:00+05:30");
    const p = (min: number, lat: number) => ({ t: t0 + min * 60_000, lat, lng: 77, used: true });
    const model = trailModel(
      readJourneyTrail({ points: [p(0, 11), p(2, 11.001), p(4, 11.002), p(30, 11.02), p(32, 11.021)] }),
      [],
    )!;
    expect(TRAIL_BREAK_MS).toBe(5 * 60_000);
    expect(model.runs.map((r) => r.line.length)).toEqual([3, 2]);
  });

  it("is nothing without positions, and ignores a position without a usable coordinate", () => {
    expect(trailModel(null, rows)).toBeNull();
    expect(trailModel(readJourneyTrail({ points: [] }), rows)).toBeNull();
    const withZero = trailModel(
      readJourneyTrail({
        points: [
          { t: 1, lat: 0, lng: 0 },
          { t: 2, lat: 11, lng: 77 },
        ],
      }),
      [],
    )!;
    expect(withZero.dots).toHaveLength(1);
  });

  it("counts a thinned trail as such", () => {
    const model = trailModel(readJourneyTrail(trailFixture(7, { total: 9000, truncated: true })), rows)!;
    expect(model.total).toBe(9000);
    expect(model.truncated).toBe(true);
    expect(model.dots).toHaveLength(29);
  });

  it("describes one position in words: time, place, accuracy, speed, activity, battery, network, source", () => {
    const point = readJourneyTrail(trailFixture(7)).points.find((p) => p.stop === 2)!;
    const facts = Object.fromEntries(pointFacts(point));
    expect(facts["Time (IST)"]).toMatch(/28 Oct, 09:3\d:00/);
    expect(facts.Position).toMatch(/^11\.0\d{4}, 77\.0\d{4}$/);
    expect(facts.Accuracy).toBe("±12 m (good)");
    expect(facts.Speed).toBe("0 km/h");
    expect(facts.Activity).toBe("Still");
    expect(facts.Battery).toBe("64%");
    expect(facts.Network).toBe("Mobile data");
    expect(facts.Source).toBe("GPS + network");
    const bare = Object.fromEntries(pointFacts({ ...point, accuracyM: null, speedKmh: null, batteryPct: null }));
    expect(bare.Accuracy).toBe("-");
    expect(bare.Speed).toBe("-");
    expect(bare.Battery).toBe("-");
  });

  it("names accuracy, activity, network and source, and falls back to readable words", () => {
    expect([10, 20, 21, 50, 51, 180].map(accuracyWord)).toEqual(["good", "good", "fair", "fair", "poor", "poor"]);
    expect(accuracyWord(null)).toBe("");
    expect(fmtAccuracy(13.6)).toBe("±14 m");
    expect(fmtAccuracy(null)).toBe("-");
    expect(fmtSpeed(27.6)).toBe("28 km/h");
    expect(fmtSpeed(null)).toBe("-");
    expect([activityLabel("vehicle"), activityLabel("walking"), activityLabel("on_foot"), activityLabel("")]).toEqual([
      "In a vehicle",
      "Walking",
      "On foot",
      "Not known",
    ]);
    expect([networkLabel("wifi"), networkLabel("cell"), networkLabel("none"), networkLabel("5g")]).toEqual([
      "Wi-Fi",
      "Mobile data",
      "No network",
      "5g",
    ]);
    expect([providerLabel("gps"), providerLabel("network"), providerLabel("x_y")]).toEqual([
      "GPS",
      "Network only",
      "X y",
    ]);
  });

  it("gives a stop and an event row their place (for the Google Maps link), and travel and gaps none", () => {
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["seg-2"].pos).toEqual([11.02, 77.02]);
    expect(byKey["seg-4"].pos).toEqual([11.04, 77.04]);
    expect(byKey["seg-1"].pos).toBeNull();
    expect(byKey["seg-3"].pos).toBeNull();
    expect(byKey["ev-2"].pos).toEqual([11.03, 77.03]);
    expect(byKey["ev-1"].pos).toBeNull();
  });
});

describe("stops at one place are one pin", () => {
  const stopAt = (n: number, lat: number, lng: number) =>
    ({
      key: `seg-${n}`,
      pos: [lat, lng] as [number, number],
      radiusM: 20,
      row: { stopNumber: n } as never,
    }) as Parameters<typeof groupStops>[0][number];

  it("puts the stops of one place on one pin, in the order they were visited", () => {
    // stop 1 and stop 3 are 4 m apart (the real journey: the same place before and after a visit elsewhere)
    const groups = groupStops([
      stopAt(1, 11.131287, 77.318855),
      stopAt(2, 11.132097, 77.325465),
      stopAt(3, 11.131255, 77.318848),
    ]);
    expect(groups.map((g) => g.stops.map((s) => s.row.stopNumber))).toEqual([[1, 3], [2]]);
    expect(groups[0].key).toBe("seg-1");
    // the pin sits between the places of its stops
    expect(groups[0].pos[0]).toBeCloseTo((11.131287 + 11.131255) / 2, 6);
    expect(groups[0].pos[1]).toBeCloseTo((77.318855 + 77.318848) / 2, 6);
  });

  it("keeps stops that are not on the very same spot apart, however near", () => {
    expect(SAME_PLACE_M).toBe(15);
    // 0.0002 degrees of latitude is about 22 m: a place of its own; 0.0001 is about 11 m: the same spot
    expect(groupStops([stopAt(1, 11.0, 77.0), stopAt(2, 11.0002, 77.0)])).toHaveLength(2);
    expect(groupStops([stopAt(1, 11.0, 77.0), stopAt(2, 11.0001, 77.0)])).toHaveLength(1);
    // the break 65 m from another (the real journey) is never merged with it
    expect(groupStops([stopAt(1, 11.132025, 77.326), stopAt(2, 11.132119, 77.32541)])).toHaveLength(2);
    expect(groupStops([stopAt(1, 11.0, 77.0), stopAt(2, 11.0004, 77.0)], 60)).toHaveLength(1);
    expect(groupStops([])).toEqual([]);
  });

  it("writes every number on the pin, and does not run on past three", () => {
    const group = (...n: number[]) => groupStops(n.map((i) => stopAt(i, 11.0, 77.0)))[0];
    expect(stopGroupLabel(group(2))).toBe("2");
    expect(stopGroupLabel(group(1, 3))).toBe("1 \u00b7 3");
    expect(stopGroupLabel(group(1, 3, 5))).toBe("1 \u00b7 3 \u00b7 5");
    expect(stopGroupLabel(group(1, 3, 5, 7, 9))).toBe("1 \u00b7 3 +3");
  });

  it("is part of the map model: one pin per place, and the stops themselves are all still there", () => {
    const detail = readJourneyDetail(detailFixture(7));
    const model = mapModel(detail, buildTimeline(detail.segments, detail.events));
    expect(model.stops).toHaveLength(2);
    expect(model.stopGroups.map((g) => g.stops.length)).toEqual([1, 1]);
  });
});
