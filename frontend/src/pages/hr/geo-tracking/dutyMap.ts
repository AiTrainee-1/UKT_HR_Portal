// On-Duty Map: what the map draws for each employee. Pure functions (no React), tested on their own in dutyMap.test.ts.
//
// Two feeds meet here, joined by employee:
//   * GET /api/on-duty-map?date=       who was On-Duty that day, their request (destination, stage) and punches, and (older phones)
//                                      the position pings of the day;
//   * GET /api/tracking/journeys/day-map?date=   the journeys the new tracking recorded that day, with their routes (travel
//                                      lines, stops, gaps): the same pieces the Journey History map is drawn from.
// An employee with a journey is drawn like a journey on the Journey History map (a route line, numbered stops, a flag at the start
// and a person at the end). One without a journey (a request made before tracking existed) keeps the old position pings as a plain
// line. One employee can have several journeys in a day (a morning duty marked Done, then an afternoon one): they are one entry,
// their stops numbered on from the first.
import type { DayMapJourney, JourneySegment, OnDutyMapEmployee, TrackState } from "@/lib/api-client/custom-hooks";
import { SAME_PLACE_M, gapLine, isLongStop, stopPosition, travelLine } from "./logic";
import { distanceM, type LatLng } from "./tiruppur";

export type DutyStop = {
  key: string;
  /** 1, 2, 3 ... the number on the pin (counted through the employee's day). */
  number: number;
  pos: LatLng;
  startedAt: string | null;
  endedAt: string | null;
  durationS: number;
  /** 15 minutes or more. */
  long: boolean;
  /** Still going on: the last stop of a journey that is still recording. */
  open: boolean;
  address: string;
  radiusM: number;
};

/** One pin of the map: one stop, or several stops at the very same place (the later ones would hide the earlier). */
export type DutyPin = { key: string; pos: LatLng; stops: DutyStop[]; label: string; long: boolean };

export type DutyLeg = {
  key: string;
  line: LatLng[];
  estimated: boolean;
  mock: boolean;
  startedAt: string | null;
  endedAt: string | null;
  distanceM: number;
  avgSpeedKmh: number;
};

export type DutyGap = {
  key: string;
  line: [LatLng, LatLng];
  cause: string;
  startedAt: string | null;
  endedAt: string | null;
  durationS: number;
};

export type DutyTotals = { distanceM: number; stops: number; durationS: number; travelS: number; stopS: number };

export type DutyEntry = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  /** The request of the day (from the on-duty feed); null for a journey whose request that feed did not list. */
  session: OnDutyMapEmployee["session"] | null;
  punches: OnDutyMapEmployee["punches"];
  destination: string;
  /** What the request is at: pending_hod, pending_hr, active, completed or rejected ("" when unknown). */
  approvalStatus: string;
  journeys: DayMapJourney[];
  /** The state of the latest journey (moving, stationary ...), null when there is none. */
  state: TrackState | null;
  /** The latest journey is still recording: its end is where the employee is now. */
  live: boolean;
  legs: DutyLeg[];
  gaps: DutyGap[];
  stops: DutyStop[];
  pins: DutyPin[];
  start: LatLng | null;
  end: LatLng | null;
  /** When the end position was recorded (the last position of a live journey, the end of a finished one). */
  endAt: string | null;
  /** The plain line of the old position pings, used only when the employee has no journey. */
  legacy: LatLng[];
  /** Every coordinate that is drawn: what the map is fitted to. */
  all: LatLng[];
  totals: DutyTotals;
  lastSeenAt: string | null;
  batteryPct: number | null;
  network: string | null;
  mocked: boolean;
  hasJourney: boolean;
};

/** Today in India (YYYY-MM-DD): the day the factory is on, whatever the browser's own zone says. */
export function todayIst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

const startMs = (iso: string | null): number => (iso ? Date.parse(iso) : 0);

/** What a pin says: "2", or "1 · 3" for stops 1 and 3 at one place ("1 · 3 +2" when there are more than three). */
export function pinLabel(stops: DutyStop[]): string {
  const numbers = stops.map((s) => String(s.number));
  return numbers.length <= 3 ? numbers.join(" · ") : `${numbers.slice(0, 2).join(" · ")} +${numbers.length - 2}`;
}

/** Stops in time order -> pins: a stop joins the first pin within `withinM` of it, else it starts a new one. */
export function groupPins(stops: DutyStop[], withinM: number = SAME_PLACE_M): DutyPin[] {
  const groups: DutyStop[][] = [];
  for (const stop of stops) {
    const home = groups.find((g) => distanceM(g[0].pos, stop.pos) <= withinM);
    if (home) home.push(stop);
    else groups.push([stop]);
  }
  return groups.map((g) => ({
    key: g[0].key,
    // the middle of the places, so a pin of two stops sits between them
    pos: [g.reduce((sum, s) => sum + s.pos[0], 0) / g.length, g.reduce((sum, s) => sum + s.pos[1], 0) / g.length],
    stops: g,
    label: pinLabel(g),
    long: g.some((s) => s.long),
  }));
}

function firstPoint(segments: JourneySegment[]): LatLng | null {
  for (const s of segments) {
    if (s.kind === "stop") {
      const pos = stopPosition(s);
      if (pos) return pos;
    } else if (s.kind === "gap") {
      const line = gapLine(s);
      if (line) return line[0];
    } else {
      const line = travelLine(s);
      if (line.length > 0) return line[0];
    }
  }
  return null;
}

function lastPoint(segments: JourneySegment[]): LatLng | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.kind === "stop") {
      const pos = stopPosition(s);
      if (pos) return pos;
    } else if (s.kind === "gap") {
      const line = gapLine(s);
      if (line) return line[1];
    } else {
      const line = travelLine(s);
      if (line.length > 0) return line[line.length - 1];
    }
  }
  return null;
}

const finite = (lat: number | null, lng: number | null): LatLng | null =>
  lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
    ? [lat, lng]
    : null;

function entryOf(employeeId: number, emp: OnDutyMapEmployee | undefined, journeys: DayMapJourney[]): DutyEntry {
  const latest = journeys.at(-1) ?? null;
  const legs: DutyLeg[] = [];
  const gaps: DutyGap[] = [];
  const stops: DutyStop[] = [];
  let number = 0;
  for (const j of journeys) {
    for (const s of j.segments) {
      const key = `${j.id}-${s.seqNo}`;
      if (s.kind === "travel") {
        const line = travelLine(s);
        if (line.length >= 2) {
          legs.push({
            key,
            line,
            estimated: s.estimated,
            mock: s.mock,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            distanceM: s.distanceM,
            avgSpeedKmh: s.avgSpeedKmh,
          });
        }
      } else if (s.kind === "gap") {
        const line = gapLine(s);
        if (line) {
          gaps.push({ key, line, cause: s.cause, startedAt: s.startedAt, endedAt: s.endedAt, durationS: s.durationS });
        }
      } else {
        const pos = stopPosition(s);
        if (pos) {
          number += 1;
          stops.push({
            key,
            number,
            pos,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            durationS: s.durationS,
            long: isLongStop(s.durationS),
            open: j.status === "active" && j === latest && !s.endedAt,
            address: s.address,
            radiusM: s.radiusM,
          });
        }
      }
    }
  }
  const segments = journeys.flatMap((j) => j.segments);
  const legacy: LatLng[] = journeys.length === 0 ? (emp?.routePoints ?? []).map((p) => [p.latitude, p.longitude]) : [];
  const start = firstPoint(segments) ?? legacy[0] ?? null;
  const live = latest?.status === "active";
  const lastKnown = latest ? finite(latest.lastLatitude, latest.lastLongitude) : null;
  const old = emp && emp.latitude !== null && emp.longitude !== null ? finite(emp.latitude, emp.longitude) : null;
  const end = lastKnown ?? lastPoint(segments) ?? old ?? legacy.at(-1) ?? null;
  const pins = groupPins(stops);
  const all: LatLng[] = [
    ...legs.flatMap((l) => l.line),
    ...gaps.flatMap((g) => g.line),
    ...pins.map((p) => p.pos),
    ...legacy,
    ...(start ? [start] : []),
    ...(end ? [end] : []),
  ];
  const sum = (pick: (j: DayMapJourney) => number) => journeys.reduce((total, j) => total + pick(j), 0);
  return {
    employeeId,
    employeeCode: emp?.employeeCode ?? latest?.employeeCode ?? "",
    employeeName: emp?.employeeName ?? latest?.employeeName ?? `Employee ${employeeId}`,
    department: emp?.department ?? latest?.department ?? null,
    session: emp?.session ?? null,
    punches: emp?.punches ?? [],
    destination: latest?.destination || emp?.session.destination || "",
    approvalStatus: latest?.approvalStatus || emp?.session.status || "",
    journeys,
    state: latest ? latest.state : null,
    live,
    legs,
    gaps,
    stops,
    pins,
    start,
    end,
    endAt: latest ? (live ? latest.lastPointAt : (latest.endedAt ?? latest.lastPointAt)) : (emp?.lastSeenAt ?? null),
    legacy,
    all,
    totals: {
      distanceM: sum((j) => j.distanceM),
      stops: stops.length,
      durationS: sum((j) => j.durationS),
      travelS: sum((j) => j.travelS),
      stopS: sum((j) => j.stopS),
    },
    lastSeenAt: latest ? latest.lastPointAt : (emp?.lastSeenAt ?? null),
    batteryPct: latest?.lastBatteryPct ?? null,
    network: latest?.lastNetwork ?? null,
    mocked: journeys.some((j) => j.hasMock),
    hasJourney: journeys.length > 0,
  };
}

/** One entry per employee that was On-Duty or recorded a journey that day, by name. */
export function buildDutyEntries(
  employees: readonly OnDutyMapEmployee[],
  journeys: readonly DayMapJourney[],
): DutyEntry[] {
  const byEmployee = new Map<number, DayMapJourney[]>();
  for (const j of journeys) {
    const list = byEmployee.get(j.employeeId);
    if (list) list.push(j);
    else byEmployee.set(j.employeeId, [j]);
  }
  const listed = new Map(employees.map((e) => [e.employeeId, e]));
  const ids = new Set<number>([...listed.keys(), ...byEmployee.keys()]);
  return [...ids]
    .map((id) =>
      entryOf(
        id,
        listed.get(id),
        [...(byEmployee.get(id) ?? [])].sort((a, b) => startMs(a.startedAt) - startMs(b.startedAt) || a.id - b.id),
      ),
    )
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.employeeId - b.employeeId);
}

/** The employee has something to draw (a route, a stop, a position). */
export const hasRoute = (e: DutyEntry): boolean => e.all.length > 0;

export type DutySummary = { employees: number; withRoute: number; live: number; distanceM: number; stops: number };

export function summarize(entries: readonly DutyEntry[]): DutySummary {
  return {
    employees: entries.length,
    withRoute: entries.filter(hasRoute).length,
    live: entries.filter((e) => e.live).length,
    distanceM: entries.reduce((total, e) => total + e.totals.distanceM, 0),
    stops: entries.reduce((total, e) => total + e.totals.stops, 0),
  };
}
