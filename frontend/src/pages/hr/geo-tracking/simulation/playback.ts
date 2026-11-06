// Journey Simulation: the arithmetic of replaying a recorded journey. Pure functions (no React, no Leaflet), tested on their own
// (playback.test.ts) with journeys shaped like the trail endpoint's answers.
//
// The replay moves along the RECORDED positions only, in time order: the positions the route uses (`used`), the same ones the
// journey map draws. Nothing is invented or snapped to a road: between two consecutive recorded positions the marker moves in a
// straight line at the pace the two time stamps give; across a gap (no position for more than TRAIL_BREAK_MS, the break the map
// also makes) it does not move at all: it waits where the signal was lost and jumps to where it came back, which the map draws
// as a dashed line. The stops and their arrival / departure / dwell are the journey's own stop segments (buildTimeline), so the
// numbers are the ones the journey page and its PDF show.
import type { JourneyPathPoint, JourneySegment, JourneyTrail, TrailPoint } from "@/lib/api-client/custom-hooks";
import { TRAIL_BREAK_MS, type LatLng, type TimelineRow } from "../logic";

// ── the model ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One recorded position the replay passes through. `t` is epoch milliseconds. */
export type SimPoint = {
  t: number;
  lat: number;
  lng: number;
  /** What the phone measured, km/h (null when it sent none). */
  speedKmh: number | null;
  /** The seqNo of the stop segment the position belongs to (null while travelling). */
  stop: number | null;
};

/** No position between two consecutive ones for more than TRAIL_BREAK_MS: the replay waits and jumps instead of moving. */
export type SimGap = {
  /** The gap lies between points[index] and points[index + 1]. */
  index: number;
  startT: number;
  endT: number;
  durationS: number;
  from: LatLng;
  to: LatLng;
  /** The cause the journey's own gap segment gives (gps_off, network_lost ...), or "" when none overlaps. */
  cause: string;
};

/** A stop of the journey (its stop segment): where, from when to when, how long. */
export type SimStop = {
  /** The row key (seg-<seqNo>) the journey page uses for the same stop. */
  key: string;
  number: number;
  startT: number;
  /** null while the employee is still there (a journey in progress). */
  endT: number | null;
  durationS: number | null;
  pos: LatLng | null;
  /** The address when the reverse geocoder knew it, else the coordinates. */
  place: string;
  long: boolean;
  open: boolean;
};

export type SimTrack = {
  points: SimPoint[];
  /** Metres along the recorded positions up to each point (a gap adds nothing: nobody knows the road taken). */
  cum: number[];
  totalM: number;
  /** gapAfter[i]: the step from points[i] to points[i + 1] is a gap. */
  gapAfter: boolean[];
  gaps: SimGap[];
  stops: SimStop[];
  startT: number;
  endT: number;
  durationMs: number;
  /** Where the positions came from: every recorded fix ("trail"), or the simplified overall route ("path"). */
  source: "trail" | "path" | "none";
};

const EMPTY: SimTrack = {
  points: [],
  cum: [],
  totalM: 0,
  gapAfter: [],
  gaps: [],
  stops: [],
  startT: 0,
  endT: 0,
  durationMs: 0,
  source: "none",
};

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function metresBetween(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a to b, degrees clockwise from north (0 - 360). */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const [la1, lo1, la2, lo2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const y = Math.sin(lo2 - lo1) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const validPos = (lat: number, lng: number) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Time-ordered, one position per instant (a repeated stamp keeps the later one, as the phone does when it resends). */
function orderPoints(raw: SimPoint[]): SimPoint[] {
  const sorted = raw.filter((p) => Number.isFinite(p.t) && validPos(p.lat, p.lng)).sort((a, b) => a.t - b.t);
  const out: SimPoint[] = [];
  for (const p of sorted) {
    if (out.length && out[out.length - 1].t === p.t) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

const fromTrail = (points: TrailPoint[]): SimPoint[] =>
  points.filter((p) => p.used).map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, stop: p.stop }));

const fromPath = (path: JourneyPathPoint[]): SimPoint[] =>
  path.flatMap((p) => (p.t === null ? [] : [{ t: p.t, lat: p.lat, lng: p.lng, speedKmh: null, stop: null }]));

export type BuildOptions = {
  /** The journey's timeline rows (buildTimeline): the stops are read from them. */
  rows?: TimelineRow[];
  /** The journey's segments: a gap's cause is read from the gap segment that overlaps it. */
  segments?: JourneySegment[];
  /** The simplified overall route: used only when the trail has no usable position. */
  path?: JourneyPathPoint[];
  /** More than this between two positions is a gap (default TRAIL_BREAK_MS, the break the journey map makes). */
  gapMs?: number;
};

/** The replay of one journey from its trail (every recorded fix), or from the simplified route when there is no trail. */
export function buildSimTrack(trail: JourneyTrail | null | undefined, options: BuildOptions = {}): SimTrack {
  const gapMs = options.gapMs ?? TRAIL_BREAK_MS;
  let source: SimTrack["source"] = "trail";
  let points = orderPoints(fromTrail(trail?.points ?? []));
  if (points.length === 0 && options.path?.length) {
    points = orderPoints(fromPath(options.path));
    source = "path";
  }
  if (points.length === 0) return { ...EMPTY, stops: stopsOf(options.rows ?? []) };

  const cum: number[] = [0];
  const gapAfter: boolean[] = [];
  const gaps: SimGap[] = [];
  const gapSegments = (options.segments ?? []).filter((s) => s.kind === "gap");
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const gap = b.t - a.t > gapMs;
    gapAfter.push(gap);
    cum.push(cum[i - 1] + (gap ? 0 : metresBetween([a.lat, a.lng], [b.lat, b.lng])));
    if (gap) {
      const seg = gapSegments.find((s) => ms(s.startedAt) <= b.t && ms(s.endedAt) >= a.t);
      gaps.push({
        index: i - 1,
        startT: a.t,
        endT: b.t,
        durationS: Math.round((b.t - a.t) / 1000),
        from: [a.lat, a.lng],
        to: [b.lat, b.lng],
        cause: seg?.cause || "",
      });
    }
  }
  gapAfter.push(false);
  const startT = points[0].t;
  const endT = points[points.length - 1].t;
  return {
    points,
    cum,
    totalM: cum[cum.length - 1],
    gapAfter,
    gaps,
    stops: stopsOf(options.rows ?? []),
    startT,
    endT,
    durationMs: endT - startT,
    source,
  };
}

function stopsOf(rows: TimelineRow[]): SimStop[] {
  return rows.flatMap((r): SimStop[] => {
    if (r.type !== "stop" || r.stopNumber === null) return [];
    const startT = ms(r.startedAt);
    if (!Number.isFinite(startT)) return [];
    const endT = ms(r.endedAt);
    return [
      {
        key: r.key,
        number: r.stopNumber,
        startT,
        endT: Number.isFinite(endT) ? endT : null,
        durationS: r.durationS,
        pos: r.pos,
        place: r.title,
        long: r.longStop,
        open: r.open,
      },
    ];
  });
}

// ── where the replay is at a moment ─────────────────────────────────────────────────────────────────────────────────

/** How the marker shows the employee: standing still, on foot, or in a vehicle (from the recorded speed). */
export type TravelMode = "still" | "walking" | "vehicle";

/** Below this the employee is standing still; from WALK_MAX_KMH on they are in a vehicle (a two-wheeler, a car, a bus). */
export const STILL_MAX_KMH = 1.5;
export const WALK_MAX_KMH = 9;

export const modeFor = (kmh: number | null, atStop: boolean): TravelMode =>
  atStop || kmh === null || kmh < STILL_MAX_KMH
    ? atStop || (kmh !== null && kmh < STILL_MAX_KMH)
      ? "still"
      : "walking"
    : kmh < WALK_MAX_KMH
      ? "walking"
      : "vehicle";

export type SimState = {
  t: number;
  lat: number;
  lng: number;
  /** points[index] is the last recorded position at or before t. */
  index: number;
  /** How far between points[index] and points[index + 1] (0 at a point, and always 0 across a gap). */
  fraction: number;
  speedKmh: number | null;
  /** Degrees from north, or null when the employee is not going anywhere. */
  bearing: number | null;
  mode: TravelMode;
  gap: SimGap | null;
  stop: SimStop | null;
  /** Metres along the recorded positions so far. */
  distanceM: number;
  atStart: boolean;
  atEnd: boolean;
};

/** The largest i with points[i].t <= t (0 before the first point). */
export function indexAt(track: SimTrack, t: number): number {
  const p = track.points;
  if (p.length === 0 || t <= p[0].t) return 0;
  let lo = 0;
  let hi = p.length - 1;
  if (t >= p[hi].t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const clampT = (track: SimTrack, t: number): number =>
  Math.min(track.endT, Math.max(track.startT, Number.isFinite(t) ? t : track.startT));

/** The stop the employee is at at time t (a stop still open holds every moment from its start). */
export function stopAt(track: SimTrack, t: number): SimStop | null {
  return track.stops.find((s) => t >= s.startT && (s.endT === null ? true : t <= s.endT)) ?? null;
}

/** The pace between two recorded positions, km/h. */
const paceKmh = (a: SimPoint, b: SimPoint): number | null => {
  const dt = (b.t - a.t) / 3_600_000;
  return dt > 0 ? metresBetween([a.lat, a.lng], [b.lat, b.lng]) / 1000 / dt : null;
};

/** Where the replay is at time t (null for a journey with no recorded position). */
export function positionAt(track: SimTrack, rawT: number): SimState | null {
  const pts = track.points;
  if (pts.length === 0) return null;
  const t = clampT(track, rawT);
  const i = indexAt(track, t);
  const a = pts[i];
  const b = pts[i + 1];
  const gap = b && track.gapAfter[i] ? (track.gaps.find((g) => g.index === i) ?? null) : null;
  let lat = a.lat;
  let lng = a.lng;
  let fraction = 0;
  let speedKmh: number | null = a.speedKmh;
  let bearing: number | null = null;
  let distanceM = track.cum[i];
  if (b && !gap) {
    const span = b.t - a.t;
    fraction = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    lat = a.lat + (b.lat - a.lat) * fraction;
    lng = a.lng + (b.lng - a.lng) * fraction;
    distanceM = track.cum[i] + (track.cum[i + 1] - track.cum[i]) * fraction;
    const measured =
      a.speedKmh !== null && b.speedKmh !== null ? a.speedKmh + (b.speedKmh - a.speedKmh) * fraction : null;
    speedKmh = measured ?? paceKmh(a, b);
    if (metresBetween([a.lat, a.lng], [b.lat, b.lng]) > 3) bearing = bearingBetween([a.lat, a.lng], [b.lat, b.lng]);
  } else if (gap) {
    speedKmh = null;
  }
  const stop = stopAt(track, t);
  return {
    t,
    lat,
    lng,
    index: i,
    fraction,
    speedKmh,
    bearing: stop ? null : bearing,
    mode: gap ? "still" : modeFor(speedKmh, stop !== null),
    gap,
    stop,
    distanceM,
    atStart: t <= track.startT,
    atEnd: t >= track.endT,
  };
}

/**
 * The distance the journey page shows, scaled to how far the replay has got: the share of the recorded positions passed so
 * far, times the journey's own total (summary.distanceM), so the figure ends exactly on the number of the page and the PDF.
 */
export function distanceSoFar(track: SimTrack, state: SimState | null, journeyTotalM: number): number {
  if (!state || track.totalM <= 0) return state?.atEnd ? journeyTotalM : 0;
  if (state.atEnd) return journeyTotalM;
  return (state.distanceM / track.totalM) * journeyTotalM;
}

// ── the clock ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Replay speeds, as multiples of real time. */
export const SPEEDS = [1, 2, 5, 10, 30, 60] as const;
/** Or the whole journey in a fixed number of seconds. */
export const FIT_SECONDS = [30, 60, 120] as const;

export type SpeedChoice = { kind: "x"; x: number } | { kind: "fit"; seconds: number };

export const DEFAULT_SPEED: SpeedChoice = { kind: "fit", seconds: 60 };

/** Recorded milliseconds per real millisecond. "Fit in N s" never goes slower than real time. */
export function rateFor(choice: SpeedChoice, durationMs: number): number {
  if (choice.kind === "x") return Math.max(0.1, choice.x);
  const wanted = Math.max(1, choice.seconds) * 1000;
  return Math.max(1, durationMs / wanted);
}

export const speedLabel = (choice: SpeedChoice): string =>
  choice.kind === "x" ? `${choice.x}×` : `Fit in ${choice.seconds} s`;

/** A gap is shown for this long (real time) before the replay jumps across it. */
export const GAP_HOLD_MS = 1200;

export type Clock = {
  t: number;
  /** Real milliseconds left to wait at a gap before jumping across it (0: not waiting). */
  holdMs: number;
};

/**
 * The clock after `realDtMs` of real time at `rate`. Reaching a gap stops the clock where the signal was lost for GAP_HOLD_MS
 * (the page says why), then jumps to where it came back; the time inside a gap is never played out. Never passes the end.
 */
export function tick(track: SimTrack, clock: Clock, realDtMs: number, rate: number): Clock {
  if (track.points.length === 0) return clock;
  if (clock.holdMs > 0) {
    const left = clock.holdMs - Math.max(0, realDtMs);
    if (left > 0) return { t: clock.t, holdMs: left };
    const gap = track.gaps.find((g) => g.startT <= clock.t && clock.t < g.endT);
    return { t: gap ? gap.endT : clock.t, holdMs: 0 };
  }
  const next = clampT(track, clock.t + Math.max(0, realDtMs) * rate);
  const gap = track.gaps.find((g) => g.startT <= next && clock.t < g.endT);
  if (gap) return { t: Math.max(clock.t, gap.startT), holdMs: GAP_HOLD_MS };
  return { t: next, holdMs: 0 };
}

/** Real seconds the whole replay takes at a rate (gaps are jumped: their time is replaced by the short hold). */
export function playSeconds(track: SimTrack, rate: number): number {
  const gapMs = track.gaps.reduce((sum, g) => sum + (g.endT - g.startT), 0);
  return (track.durationMs - gapMs) / rate / 1000 + (track.gaps.length * GAP_HOLD_MS) / 1000;
}

// ── step-through (for people who asked their system for less motion) ────────────────────────────────────────────────

export type MomentKind = "start" | "arrive" | "leave" | "gap-start" | "gap-end" | "end";

export type Moment = { t: number; kind: MomentKind; label: string; stopNumber: number | null };

const MOMENT_ORDER: Record<MomentKind, number> = {
  start: 0,
  "gap-end": 1,
  leave: 2,
  arrive: 3,
  "gap-start": 4,
  end: 5,
};

/** The moments worth stopping at, in time order: the start, every arrival at and departure from a stop, both ends of every gap, the end. */
export function keyMoments(track: SimTrack): Moment[] {
  if (track.points.length === 0) return [];
  const out: Moment[] = [{ t: track.startT, kind: "start", label: "Start", stopNumber: null }];
  for (const s of track.stops) {
    if (s.startT > track.startT && s.startT < track.endT)
      out.push({ t: s.startT, kind: "arrive", label: `Arrived at stop ${s.number}`, stopNumber: s.number });
    if (s.endT !== null && s.endT > track.startT && s.endT < track.endT)
      out.push({ t: s.endT, kind: "leave", label: `Left stop ${s.number}`, stopNumber: s.number });
  }
  for (const g of track.gaps) {
    out.push({ t: g.startT, kind: "gap-start", label: "Location lost", stopNumber: null });
    out.push({ t: g.endT, kind: "gap-end", label: "Location back", stopNumber: null });
  }
  out.push({ t: track.endT, kind: "end", label: "End", stopNumber: null });
  // at one instant the story reads: the signal comes back, then the employee leaves / arrives, then the signal is lost
  out.sort((a, b) => a.t - b.t || MOMENT_ORDER[a.kind] - MOMENT_ORDER[b.kind]);
  return out.filter((m, i) => i === 0 || m.t !== out[i - 1].t || m.kind !== out[i - 1].kind);
}

/** The first moment after t (or the last one). */
export function nextMoment(moments: Moment[], t: number): Moment | null {
  return moments.find((m) => m.t > t) ?? moments[moments.length - 1] ?? null;
}

/** The last moment before t (or the first one). */
export function previousMoment(moments: Moment[], t: number): Moment | null {
  for (let i = moments.length - 1; i >= 0; i--) if (moments[i].t < t) return moments[i];
  return moments[0] ?? null;
}

// ── the progress bar ────────────────────────────────────────────────────────────────────────────────────────────────

/** 0 - 1: how far through the journey a moment is. */
export const progressOf = (track: SimTrack, t: number): number =>
  track.durationMs > 0 ? Math.min(1, Math.max(0, (t - track.startT) / track.durationMs)) : t >= track.endT ? 1 : 0;

export const timeAtProgress = (track: SimTrack, p: number): number =>
  track.startT + Math.min(1, Math.max(0, p)) * track.durationMs;

export type Band = { kind: "stop" | "gap"; from: number; to: number; label: string; long?: boolean };

/** The stops and gaps as stretches of the progress bar (0 - 1), so HR sees where they are before playing. */
export function bands(track: SimTrack): Band[] {
  if (track.durationMs <= 0) return [];
  const out: Band[] = [];
  for (const s of track.stops) {
    const from = progressOf(track, s.startT);
    const to = progressOf(track, s.endT ?? track.endT);
    if (to > from) out.push({ kind: "stop", from, to, label: `Stop ${s.number}`, long: s.long });
  }
  for (const g of track.gaps)
    out.push({ kind: "gap", from: progressOf(track, g.startT), to: progressOf(track, g.endT), label: "No location" });
  return out.sort((a, b) => a.from - b.from);
}

// ── the route drawn so far ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The route from the start to the replay's position, as continuous runs (a new run after every gap) whose last run ends at the
 * marker. `fromIndex` lets a caller that already drew the earlier runs ask only for the rest.
 */
export function travelledRuns(track: SimTrack, state: SimState | null): LatLng[][] {
  if (!state || track.points.length === 0) return [];
  const runs: LatLng[][] = [];
  let run: LatLng[] = [];
  for (let i = 0; i <= state.index; i++) {
    const p = track.points[i];
    run.push([p.lat, p.lng]);
    if (i < state.index && track.gapAfter[i]) {
      if (run.length) runs.push(run);
      run = [];
    }
  }
  if (state.fraction > 0) run.push([state.lat, state.lng]);
  if (run.length) runs.push(run);
  return runs;
}

/** The gaps the replay has reached (their dashed lines are drawn from the moment the signal was lost). */
export const gapsReached = (track: SimTrack, t: number): SimGap[] => track.gaps.filter((g) => g.startT <= t);
