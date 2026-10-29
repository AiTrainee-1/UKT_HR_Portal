import { describe, expect, it } from "vitest";
import { readJourneyDayMap, type OnDutyMapEmployee } from "@/lib/api-client/custom-hooks";
import { buildDutyEntries, groupPins, hasRoute, pinLabel, summarize, todayIst, type DutyStop } from "./dutyMap";

// On-Duty Map: what the map draws for each employee, from the two feeds (the day's On-Duty list and the day's journeys).

const at = (hhmm: string) => `2026-10-28T${hhmm}:00+05:30`;

type Raw = Record<string, unknown>;

const travel = (seqNo: number, from: string, to: string, line: [number, number][], over: Raw = {}): Raw => ({
  seqNo,
  kind: "travel",
  startedAt: at(from),
  endedAt: at(to),
  durationS: 1200,
  distanceM: 3200,
  polyline: line,
  startLat: line[0][0],
  startLng: line[0][1],
  endLat: line[line.length - 1][0],
  endLng: line[line.length - 1][1],
  avgSpeedKmh: 28,
  ...over,
});

const stop = (
  seqNo: number,
  from: string,
  to: string,
  lat: number,
  lng: number,
  minutes: number,
  over: Raw = {},
): Raw => ({
  seqNo,
  kind: "stop",
  startedAt: at(from),
  endedAt: at(to),
  durationS: minutes * 60,
  centerLat: lat,
  centerLng: lng,
  radiusM: 30,
  ...over,
});

const journey = (id: number, employeeId: number, name: string, segments: Raw[], over: Raw = {}): Raw => ({
  id,
  sessionId: 100 + id,
  employeeId,
  employeeCode: `E${employeeId}`,
  employeeName: name,
  department: "Stitching",
  destination: `Visit ${id}`,
  startedAt: at("09:00"),
  endedAt: at("17:00"),
  status: "ended",
  state: "ended",
  distanceM: 5000,
  travelS: 3000,
  stopS: 1800,
  gapS: 0,
  durationS: 28800,
  stopCount: 1,
  lastLatitude: 11.06,
  lastLongitude: 77.06,
  lastPointAt: at("16:59"),
  approvalStatus: "completed",
  segments,
  ...over,
});

const day = (...journeys: Raw[]) => readJourneyDayMap({ date: "2026-10-28", journeys }).journeys;

const person = (id: number, name: string, over: Partial<OnDutyMapEmployee> = {}): OnDutyMapEmployee => ({
  employeeId: id,
  employeeCode: `E${id}`,
  employeeName: name,
  department: "Stitching",
  locationTrackingEnabled: true,
  latitude: null,
  longitude: null,
  lastSeenAt: null,
  routePoints: [],
  session: { id: 100 + id, destination: `Session ${id}`, status: "active" },
  punches: [],
  ...over,
});

const stopOf = (number: number, lat: number, lng: number, long = false): DutyStop => ({
  key: `s${number}`,
  number,
  pos: [lat, lng],
  startedAt: null,
  endedAt: null,
  durationS: long ? 1800 : 300,
  long,
  open: false,
  address: "",
  radiusM: 30,
});

describe("one entry per employee, joined from both feeds", () => {
  it("lists everybody On-Duty that day and everybody who recorded a journey, by name", () => {
    const entries = buildDutyEntries(
      [person(2, "Zoya Khan"), person(1, "Asha Kumar")],
      day(
        journey(7, 1, "Asha Kumar", [
          travel(1, "09:00", "09:20", [
            [11, 77],
            [11.02, 77.02],
          ]),
        ]),
        journey(8, 3, "Meena Devi", []),
      ),
    );
    expect(entries.map((e) => e.employeeName)).toEqual(["Asha Kumar", "Meena Devi", "Zoya Khan"]);
    // Meena has a journey but was not on the On-Duty list: her name comes from the journey
    const meena = entries[1];
    expect(meena.session).toBeNull();
    expect(meena.employeeCode).toBe("E3");
    expect(meena.destination).toBe("Visit 8");
  });

  it("keeps the request and the punches of the day from the On-Duty feed", () => {
    const [asha] = buildDutyEntries(
      [
        person(1, "Asha Kumar", {
          punches: [{ punchNumber: 1, punchType: "IN", punchTime: "09:07:00", status: "approved" }],
        }),
      ],
      day(journey(7, 1, "Asha Kumar", [], { approvalStatus: "pending_hr" })),
    );
    expect(asha.punches).toHaveLength(1);
    expect(asha.session?.destination).toBe("Session 1");
    expect(asha.approvalStatus).toBe("pending_hr"); // the journey knows the stage of the request
    expect(asha.destination).toBe("Visit 7");
  });

  it("uses the request's own stage and destination for an employee without a journey", () => {
    const [asha] = buildDutyEntries([person(1, "Asha Kumar")], []);
    expect(asha.hasJourney).toBe(false);
    expect(asha.approvalStatus).toBe("active");
    expect(asha.destination).toBe("Session 1");
    expect(asha.state).toBeNull();
  });
});

describe("the route of a journey", () => {
  const segments = [
    travel(1, "09:00", "09:20", [
      [11, 77],
      [11.02, 77.02],
    ]),
    stop(2, "09:20", "09:32", 11.02, 77.02, 12),
    travel(
      3,
      "09:32",
      "10:00",
      [
        [11.02, 77.02],
        [11.05, 77.05],
      ],
      { estimated: true },
    ),
    {
      seqNo: 4,
      kind: "gap",
      startedAt: at("10:00"),
      endedAt: at("10:20"),
      durationS: 1200,
      startLat: 11.05,
      startLng: 77.05,
      endLat: 11.06,
      endLng: 77.06,
      cause: "gps_off",
    },
    stop(5, "10:20", "11:00", 11.06, 77.06, 40),
  ];
  const [asha] = buildDutyEntries([person(1, "Asha Kumar")], day(journey(7, 1, "Asha Kumar", segments)));

  it("draws the travel as lines, the gap as a dashed line and every stop as a numbered pin", () => {
    expect(asha.legs).toHaveLength(2);
    expect(asha.legs[1].estimated).toBe(true);
    expect(asha.gaps).toHaveLength(1);
    expect(asha.gaps[0].cause).toBe("gps_off");
    expect(asha.stops.map((s) => s.number)).toEqual([1, 2]);
    expect(asha.pins.map((p) => p.label)).toEqual(["1", "2"]);
  });

  it("calls a stop of 15 minutes or more a long stop, and a shorter one a wait", () => {
    expect(asha.stops.map((s) => s.long)).toEqual([false, true]);
    expect(asha.pins.map((p) => p.long)).toEqual([false, true]);
  });

  it("starts at the first place of the route and ends where the employee was last known to be", () => {
    expect(asha.start).toEqual([11, 77]);
    expect(asha.end).toEqual([11.06, 77.06]); // the journey's last known position
    expect(asha.all).toContainEqual([11.05, 77.05]);
    expect(hasRoute(asha)).toBe(true);
  });

  it("ends at the end of the last segment when the journey has no last known position", () => {
    const [e] = buildDutyEntries(
      [],
      day(journey(7, 1, "Asha Kumar", segments, { lastLatitude: null, lastLongitude: null })),
    );
    expect(e.end).toEqual([11.06, 77.06]);
  });

  it("totals the journey", () => {
    expect(asha.totals).toEqual({ distanceM: 5000, stops: 2, durationS: 28800, travelS: 3000, stopS: 1800 });
  });

  it("knows a journey that is still recording: its end is where the employee is now, its last stop is still going", () => {
    const [live] = buildDutyEntries(
      [],
      day(
        journey(
          9,
          1,
          "Asha Kumar",
          [
            travel(1, "09:00", "09:20", [
              [11, 77],
              [11.02, 77.02],
            ]),
            stop(2, "09:20", "09:40", 11.02, 77.02, 20, { endedAt: null }),
          ],
          { status: "active", state: "stationary", endedAt: null, lastLatitude: 11.021, lastLongitude: 77.021 },
        ),
      ),
    );
    expect(live.live).toBe(true);
    expect(live.state).toBe("stationary");
    expect(live.end).toEqual([11.021, 77.021]);
    expect(live.stops[0].open).toBe(true);
    expect(live.endAt).toBe(at("16:59"));
  });
});

describe("an employee with several journeys in one day", () => {
  it("is one entry: the stops are numbered on from the first journey and the end is the last one's", () => {
    const morning = journey(7, 1, "Asha Kumar", [stop(1, "09:00", "09:30", 11.0, 77.0, 30)], {
      startedAt: at("09:00"),
      endedAt: at("12:00"),
      lastLatitude: 11.0,
      lastLongitude: 77.0,
    });
    const afternoon = journey(8, 1, "Asha Kumar", [stop(1, "14:00", "14:20", 11.1, 77.1, 20)], {
      startedAt: at("14:00"),
      endedAt: at("17:00"),
      lastLatitude: 11.1,
      lastLongitude: 77.1,
    });
    const entries = buildDutyEntries([person(1, "Asha Kumar")], day(afternoon, morning)); // in any order
    expect(entries).toHaveLength(1);
    expect(entries[0].journeys.map((j) => j.id)).toEqual([7, 8]);
    expect(entries[0].stops.map((s) => [s.number, s.pos[0]])).toEqual([
      [1, 11.0],
      [2, 11.1],
    ]);
    expect(entries[0].end).toEqual([11.1, 77.1]);
    expect(entries[0].totals.distanceM).toBe(10000);
  });
});

describe("an employee without a journey", () => {
  it("keeps the old position pings as a plain line, with the old position as the end", () => {
    const [e] = buildDutyEntries(
      [
        person(1, "Asha Kumar", {
          latitude: 11.03,
          longitude: 77.03,
          lastSeenAt: at("12:00"),
          routePoints: [
            { latitude: 11.0, longitude: 77.0, recordedAt: at("09:00") },
            { latitude: 11.02, longitude: 77.02, recordedAt: at("10:00") },
          ],
        }),
      ],
      [],
    );
    expect(e.legacy).toEqual([
      [11.0, 77.0],
      [11.02, 77.02],
    ]);
    expect(e.start).toEqual([11.0, 77.0]);
    expect(e.end).toEqual([11.03, 77.03]);
    expect(e.legs).toEqual([]);
    expect(hasRoute(e)).toBe(true);
    expect(e.lastSeenAt).toBe(at("12:00"));
  });

  it("has nothing to draw when the phone never reported (the map says so)", () => {
    const [e] = buildDutyEntries([person(1, "Asha Kumar")], []);
    expect(hasRoute(e)).toBe(false);
    expect(e.all).toEqual([]);
  });

  it("does not draw the old pings under a journey: the journey is the better record", () => {
    const [e] = buildDutyEntries(
      [person(1, "Asha Kumar", { routePoints: [{ latitude: 11.5, longitude: 77.5, recordedAt: at("09:00") }] })],
      day(
        journey(7, 1, "Asha Kumar", [
          travel(1, "09:00", "09:20", [
            [11, 77],
            [11.02, 77.02],
          ]),
        ]),
      ),
    );
    expect(e.legacy).toEqual([]);
  });
});

describe("stops at the same place share one pin", () => {
  it("joins stops within 15 m, numbers them together, and puts the pin between them", () => {
    const pins = groupPins([stopOf(1, 11.0, 77.0), stopOf(2, 11.05, 77.05), stopOf(3, 11.00005, 77.0)]);
    expect(pins).toHaveLength(2);
    expect(pins[0].label).toBe("1 · 3");
    expect(pins[0].stops.map((s) => s.number)).toEqual([1, 3]);
    expect(pins[0].pos[0]).toBeCloseTo(11.000025, 6);
    expect(pins[1].label).toBe("2");
  });

  it("keeps stops that are a little farther apart as pins of their own (each place is its own pin)", () => {
    expect(groupPins([stopOf(1, 11.0, 77.0), stopOf(2, 11.0003, 77.0)])).toHaveLength(2); // about 33 m
  });

  it("is a long pin when any stop in it is long", () => {
    expect(groupPins([stopOf(1, 11, 77), stopOf(2, 11, 77, true)])[0].long).toBe(true);
  });

  it("writes a long label short", () => {
    const four = [1, 2, 3, 4].map((n) => stopOf(n, 11, 77));
    expect(pinLabel(four)).toBe("1 · 2 +2");
    expect(pinLabel(four.slice(0, 3))).toBe("1 · 2 · 3");
  });
});

describe("the summary above the list", () => {
  it("counts the employees, the routes drawn, the ones on the road and the distance", () => {
    const entries = buildDutyEntries(
      [person(1, "Asha Kumar"), person(2, "Ravi Nair"), person(3, "Zoya Khan")],
      day(
        journey(
          7,
          1,
          "Asha Kumar",
          [
            travel(1, "09:00", "09:20", [
              [11, 77],
              [11.02, 77.02],
            ]),
          ],
          { distanceM: 4000 },
        ),
        journey(
          8,
          2,
          "Ravi Nair",
          [
            travel(1, "09:00", "09:20", [
              [11, 77],
              [11.02, 77.02],
            ]),
          ],
          { distanceM: 6000, status: "active", state: "moving", endedAt: null },
        ),
      ),
    );
    expect(summarize(entries)).toEqual({ employees: 3, withRoute: 2, live: 1, distanceM: 10000, stops: 0 });
  });
});

describe("today in India", () => {
  it("is the India day, not the UTC day", () => {
    // 22:00 UTC on the 27th is 03:30 on the 28th in India
    expect(todayIst(new Date("2026-10-27T22:00:00Z"))).toBe("2026-10-28");
    expect(todayIst(new Date("2026-10-28T10:00:00Z"))).toBe("2026-10-28");
  });
});
