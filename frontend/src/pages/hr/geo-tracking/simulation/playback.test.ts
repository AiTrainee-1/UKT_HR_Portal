import { describe, expect, it } from "vitest";
import { readJourneyDetail, readJourneyTrail } from "@/lib/api-client/custom-hooks";
import { buildTimeline } from "../logic";
import { IST, detailFixture, trailFixture } from "../testing";
import {
  DEFAULT_SPEED,
  GAP_HOLD_MS,
  bands,
  bearingBetween,
  buildSimTrack,
  clampT,
  distanceSoFar,
  gapsReached,
  indexAt,
  keyMoments,
  metresBetween,
  modeFor,
  nextMoment,
  playSeconds,
  positionAt,
  previousMoment,
  progressOf,
  rateFor,
  tick,
  timeAtProgress,
  travelledRuns,
  type Clock,
} from "./playback";

// The arithmetic of the Journey Simulation, on journeys shaped like the server's answers (testing.tsx): the trail of journey 7
// (travel 09:05-09:29, stop 09:30-09:37, one position set aside, no position from 09:37 to 10:25, a stop, travel to 11:30) and
// its detail (stop segments 2 and 4, a gap segment caused by location off).

const t = (hhmm: string) => Date.parse(IST(hhmm));

function journey7() {
  const detail = readJourneyDetail(detailFixture(7));
  const rows = buildTimeline(detail.segments, detail.events, false);
  const trail = readJourneyTrail(trailFixture(7));
  return { detail, rows, trail, track: buildSimTrack(trail, { rows, segments: detail.segments, path: detail.path }) };
}

describe("the replay is built from the recorded positions only", () => {
  it("uses every position the route uses, in time order, and leaves out the one the pipeline set aside", () => {
    const { trail, track } = journey7();
    expect(trail.points).toHaveLength(29);
    expect(track.points).toHaveLength(28);
    expect(track.points.some((p) => p.lat === 11.025)).toBe(false); // the GPS jump at 09:40
    expect(track.points.every((p, i) => i === 0 || p.t > track.points[i - 1].t)).toBe(true);
    expect(track.startT).toBe(t("09:05"));
    expect(track.endT).toBe(t("11:30"));
    expect(track.durationMs).toBe(145 * 60_000);
    expect(track.source).toBe("trail");
  });

  it("sorts positions that arrive out of order and keeps one per instant", () => {
    const raw = trailFixture(7);
    const points = [...(raw.points as Record<string, unknown>[])];
    const shuffled = { ...raw, points: [points[3], points[0], points[2], points[1], { ...points[1], lat: 11.5 }] };
    const track = buildSimTrack(readJourneyTrail(shuffled));
    expect(track.points.map((p) => p.t)).toEqual([0, 1, 2, 3].map((i) => points[i].t as number));
    expect(track.points[1].lat).toBe(11.5); // the resent position wins
  });

  it("falls back to the simplified route when the trail has no position, and is empty when nothing is known", () => {
    const path = [
      { lat: 11, lng: 77, t: t("09:00") },
      { lat: 11.01, lng: 77.01, t: t("09:10") },
      { lat: 11.02, lng: 77.02, t: null },
    ];
    const fallback = buildSimTrack(readJourneyTrail({ points: [] }), { path });
    expect(fallback.source).toBe("path");
    expect(fallback.points).toHaveLength(2); // a position without a time cannot be placed on the clock
    const none = buildSimTrack(null);
    expect(none.points).toHaveLength(0);
    expect(positionAt(none, t("10:00"))).toBeNull();
    expect(keyMoments(none)).toEqual([]);
  });

  it("finds the gap where no position arrived for more than 5 minutes, with the cause of the journey's own gap segment", () => {
    const { track } = journey7();
    expect(track.gaps).toHaveLength(1);
    const [gap] = track.gaps;
    expect(gap.startT).toBe(t("09:37"));
    expect(gap.endT).toBe(t("10:25"));
    expect(gap.durationS).toBe(48 * 60);
    expect(gap.cause).toBe("gps_off");
    expect(track.gapAfter[gap.index]).toBe(true);
    // a gap adds no distance: nobody knows which road was taken
    expect(track.cum[gap.index + 1]).toBe(track.cum[gap.index]);
  });

  it("reads the stops from the journey's stop segments (the numbers of the journey page)", () => {
    const { track } = journey7();
    expect(track.stops.map((s) => [s.number, s.startT, s.endT, s.durationS, s.long])).toEqual([
      [1, t("09:30"), t("09:38"), 480, false],
      [2, t("10:25"), t("10:50"), 1500, true],
    ]);
    expect(track.stops[1].place).toBe("Buyer office, Avinashi Road");
  });
});

describe("where the marker is at a moment", () => {
  it("is exactly on a recorded position at its time, and between two positions in proportion to the time", () => {
    const { track } = journey7();
    const at = positionAt(track, t("09:05"))!;
    expect([at.lat, at.lng]).toEqual([11.0, 77.0]);
    expect(at.atStart).toBe(true);
    // 09:05 -> 09:09 is one 4-minute step; two minutes in is half way
    const half = positionAt(track, t("09:07"))!;
    const a = track.points[0];
    const b = track.points[1];
    expect(half.index).toBe(0);
    expect(half.fraction).toBeCloseTo(0.5, 6);
    expect(half.lat).toBeCloseTo((a.lat + b.lat) / 2, 9);
    expect(half.lng).toBeCloseTo((a.lng + b.lng) / 2, 9);
    expect(half.distanceM).toBeCloseTo(track.cum[1] / 2, 3);
  });

  it("never leaves the journey: before the start it is at the first position, after the end at the last", () => {
    const { track } = journey7();
    expect(positionAt(track, t("08:00"))!.lat).toBe(11.0);
    const end = positionAt(track, t("18:00"))!;
    expect([end.lat, end.lng]).toEqual([11.06, 77.06]);
    expect(end.atEnd).toBe(true);
    expect(clampT(track, Number.NaN)).toBe(track.startT);
  });

  it("does not move across a gap: it waits where the signal was lost", () => {
    const { track } = journey7();
    const lost = track.points[track.gaps[0].index];
    const inGap = positionAt(track, t("10:00"))!;
    expect(inGap.gap).not.toBeNull();
    expect([inGap.lat, inGap.lng]).toEqual([lost.lat, lost.lng]);
    expect(inGap.fraction).toBe(0);
    expect(inGap.speedKmh).toBeNull();
    // and is where it came back once the gap is over
    const back = positionAt(track, t("10:25"))!;
    expect(back.gap).toBeNull();
    expect(back.lat).toBe(11.04);
  });

  it("says which stop the employee is at, and the speed and heading while travelling", () => {
    const { track } = journey7();
    const atStop = positionAt(track, t("09:33"))!;
    expect(atStop.stop?.number).toBe(1);
    expect(atStop.mode).toBe("still");
    expect(atStop.bearing).toBeNull();
    const driving = positionAt(track, t("11:00"))!;
    expect(driving.stop).toBeNull();
    expect(driving.speedKmh).toBe(28); // what the phone measured
    expect(driving.mode).toBe("vehicle");
    expect(driving.bearing).toBeGreaterThan(30); // heading north-east
    expect(driving.bearing).toBeLessThan(60);
  });

  it("works out the pace from the positions when the phone sent no speed", () => {
    const base = trailFixture(7);
    const noSpeed = {
      ...base,
      points: (base.points as Record<string, unknown>[]).map((p) => ({ ...p, spd: null })),
    };
    const track = buildSimTrack(readJourneyTrail(noSpeed));
    const s = positionAt(track, t("09:07"))!;
    const a = track.points[0];
    const b = track.points[1];
    const kmh = metresBetween([a.lat, a.lng], [b.lat, b.lng]) / 1000 / (4 / 60);
    expect(s.speedKmh).toBeCloseTo(kmh, 6);
  });

  it("tells walking from riding by the recorded speed", () => {
    expect(modeFor(0.5, false)).toBe("still");
    expect(modeFor(4.5, false)).toBe("walking");
    expect(modeFor(32, false)).toBe("vehicle");
    expect(modeFor(32, true)).toBe("still"); // at a stop, whatever the last speed said
    expect(modeFor(null, false)).toBe("walking");
  });

  it("finds the position index by binary search", () => {
    const { track } = journey7();
    expect(indexAt(track, track.points[10].t)).toBe(10);
    expect(indexAt(track, track.points[10].t + 1)).toBe(10);
    expect(indexAt(track, track.points[10].t - 1)).toBe(9);
    expect(indexAt(track, 0)).toBe(0);
    expect(indexAt(track, Number.MAX_SAFE_INTEGER)).toBe(track.points.length - 1);
  });

  it("measures distance and heading on the earth", () => {
    expect(metresBetween([11, 77], [11.001, 77])).toBeCloseTo(111.2, 0);
    expect(bearingBetween([11, 77], [11.01, 77])).toBeCloseTo(0, 3);
    expect(bearingBetween([11, 77], [11, 77.01])).toBeCloseTo(90, 1);
    expect(bearingBetween([11, 77], [10.99, 77])).toBeCloseTo(180, 3);
  });
});

describe("the distance shown matches the journey page", () => {
  it("grows with the replay and ends exactly on the journey's own total", () => {
    const { track, detail } = journey7();
    const total = detail.summary.distanceM;
    const start = distanceSoFar(track, positionAt(track, track.startT), total);
    const middle = distanceSoFar(track, positionAt(track, t("10:30")), total);
    const end = distanceSoFar(track, positionAt(track, track.endT), total);
    expect(start).toBe(0);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(total);
    expect(end).toBe(total);
  });
});

describe("the clock", () => {
  it("plays real time times the chosen speed", () => {
    expect(rateFor({ kind: "x", x: 1 }, 1000)).toBe(1);
    expect(rateFor({ kind: "x", x: 30 }, 1000)).toBe(30);
    const { track } = journey7();
    const clock = tick(track, { t: track.startT, holdMs: 0 }, 1000, 60);
    expect(clock.t).toBe(track.startT + 60_000);
    expect(clock.holdMs).toBe(0);
  });

  it("'fit in N seconds' plays the whole journey in that time, never slower than real time", () => {
    const { track } = journey7();
    expect(rateFor({ kind: "fit", seconds: 60 }, track.durationMs)).toBeCloseTo(track.durationMs / 60_000, 9);
    expect(rateFor({ kind: "fit", seconds: 60 }, 10_000)).toBe(1); // a 10-second journey is not slowed down
    expect(rateFor(DEFAULT_SPEED, track.durationMs)).toBeGreaterThan(1);
  });

  it("stops at a gap, holds there for a moment, then jumps to where the signal came back", () => {
    const { track } = journey7();
    const gap = track.gaps[0];
    let clock: Clock = { t: gap.startT - 60_000, holdMs: 0 };
    clock = tick(track, clock, 1000, 600); // would go 10 minutes ahead, into the gap
    expect(clock).toEqual({ t: gap.startT, holdMs: GAP_HOLD_MS });
    clock = tick(track, clock, GAP_HOLD_MS / 2, 600);
    expect(clock.t).toBe(gap.startT); // still waiting, whatever the speed
    clock = tick(track, clock, GAP_HOLD_MS, 600);
    expect(clock).toEqual({ t: gap.endT, holdMs: 0 });
    // and plays on from there
    clock = tick(track, clock, 1000, 60);
    expect(clock.t).toBe(gap.endT + 60_000);
  });

  it("a replay started inside a gap (after a scrub) waits, then jumps", () => {
    const { track } = journey7();
    const gap = track.gaps[0];
    const clock = tick(track, { t: t("10:00"), holdMs: 0 }, 16, 10);
    expect(clock).toEqual({ t: t("10:00"), holdMs: GAP_HOLD_MS });
    expect(tick(track, clock, GAP_HOLD_MS + 1, 10).t).toBe(gap.endT);
  });

  it("never runs past the end", () => {
    const { track } = journey7();
    const clock = tick(track, { t: track.endT - 1000, holdMs: 0 }, 60_000, 60);
    expect(clock.t).toBe(track.endT);
    expect(tick(track, clock, 1000, 60).t).toBe(track.endT);
  });

  it("knows how long a replay takes in real seconds (the gap replaced by its short hold)", () => {
    const { track } = journey7();
    const gapMs = track.gaps[0].endT - track.gaps[0].startT;
    expect(playSeconds(track, 60)).toBeCloseTo((track.durationMs - gapMs) / 60 / 1000 + GAP_HOLD_MS / 1000, 6);
  });
});

describe("scrubbing", () => {
  it("turns a place on the bar into a time and back", () => {
    const { track } = journey7();
    expect(progressOf(track, track.startT)).toBe(0);
    expect(progressOf(track, track.endT)).toBe(1);
    expect(timeAtProgress(track, 0.5)).toBe(track.startT + track.durationMs / 2);
    expect(timeAtProgress(track, 7)).toBe(track.endT);
    expect(progressOf(track, timeAtProgress(track, 0.3))).toBeCloseTo(0.3, 9);
  });

  it("shows where the stops and the gap lie on the bar", () => {
    const { track } = journey7();
    const b = bands(track);
    expect(b.map((x) => x.kind)).toEqual(["stop", "gap", "stop"]);
    expect(b[0].from).toBeCloseTo(progressOf(track, t("09:30")), 9);
    expect(b[1].to).toBeCloseTo(progressOf(track, t("10:25")), 9);
    expect(b[2].long).toBe(true);
  });

  it("draws the route up to the marker, in runs broken at the gap", () => {
    const { track } = journey7();
    expect(travelledRuns(track, positionAt(track, track.startT))).toEqual([[[11, 77]]]);
    const mid = positionAt(track, t("09:07"))!;
    const runs = travelledRuns(track, mid);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(2);
    expect(runs[0][1]).toEqual([mid.lat, mid.lng]);
    const after = travelledRuns(track, positionAt(track, t("11:00")));
    expect(after).toHaveLength(2);
    expect(gapsReached(track, t("09:00"))).toHaveLength(0);
    expect(gapsReached(track, t("10:00"))).toHaveLength(1);
  });
});

describe("step-through, for people who asked for less motion", () => {
  it("steps between the start, the arrivals and departures, both ends of the gap and the end", () => {
    const { track } = journey7();
    const moments = keyMoments(track);
    expect(moments.map((m) => m.kind)).toEqual([
      "start",
      "arrive",
      "gap-start",
      "leave",
      "gap-end",
      "arrive",
      "leave",
      "end",
    ]);
    expect(moments.map((m) => m.t)).toEqual([...moments.map((m) => m.t)].sort((a, b) => a - b));
    expect(nextMoment(moments, track.startT)?.label).toBe("Arrived at stop 1");
    expect(previousMoment(moments, t("10:30"))?.kind).toBe("arrive");
    expect(nextMoment(moments, track.endT)?.kind).toBe("end");
    expect(previousMoment(moments, track.startT)?.kind).toBe("start");
  });
});

describe("a journey in progress, a short one and a very long one", () => {
  it("a stop that is still open holds every moment from its start", () => {
    const raw = detailFixture(7, {
      track: { status: "active", endedAt: null, state: "stationary" },
      segments: [
        {
          seqNo: 1,
          kind: "stop",
          startedAt: IST("11:20"),
          endedAt: null,
          durationS: 0,
          centerLat: 11.06,
          centerLng: 77.06,
          radiusM: 20,
        },
      ],
    });
    const detail = readJourneyDetail(raw);
    const rows = buildTimeline(detail.segments, detail.events, true);
    const track = buildSimTrack(readJourneyTrail(trailFixture(7)), { rows, segments: detail.segments });
    expect(track.stops[0].endT).toBeNull();
    expect(positionAt(track, t("11:30"))!.stop?.number).toBe(1);
  });

  it("one position: the marker stands there, there is nothing to play", () => {
    const one = buildSimTrack(readJourneyTrail({ points: [{ t: t("09:00"), lat: 11, lng: 77 }] }));
    expect(one.durationMs).toBe(0);
    const s = positionAt(one, t("12:00"))!;
    expect([s.lat, s.lng, s.atEnd]).toEqual([11, 77, true]);
    expect(progressOf(one, t("09:00"))).toBe(1);
    expect(keyMoments(one).map((m) => m.kind)).toEqual(["start", "end"]);
  });

  it("8,000 positions are built and searched quickly", () => {
    const start = t("06:00");
    const points = Array.from({ length: 8000 }, (_, i) => ({
      t: start + i * 3000,
      lat: 11 + i * 0.00002,
      lng: 77 + Math.sin(i / 50) * 0.001,
      spd: 30,
      used: true,
    }));
    const began = performance.now();
    const track = buildSimTrack(readJourneyTrail({ points }));
    for (let k = 0; k < 2000; k++) positionAt(track, start + Math.random() * track.durationMs);
    expect(performance.now() - began).toBeLessThan(1500);
    expect(track.points).toHaveLength(8000);
    expect(track.gaps).toHaveLength(0);
  });
});
