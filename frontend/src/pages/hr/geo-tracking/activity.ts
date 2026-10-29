// Journey History: the journey told as a story, in the order it happened. Started -> break -> resumed -> break -> ... -> completed.
// Built from the same segments and events as the detailed log (so it is always the journey that was recorded, never a fixed
// sequence): every stationary period is a break, travel that follows a break is "resumed", a time with no location is a gap, an
// event that matters (simulated location, app closed, battery saver ...) is a notice, and the journey ends with "completed" (or, while
// it is still recorded, "on duty now"). Travel between two items is the "leg" that joins them. Pure functions, tested on their own.
import type { JourneyDetail, JourneyEvent, JourneySegment } from "@/lib/api-client/custom-hooks";
import {
  INTERVAL_KINDS,
  causeLabel,
  endReasonLabel,
  eventDetail,
  eventPosition,
  eventStyle,
  fmtCoords,
  fmtDistance,
  fmtDuration,
  fmtTime,
  isLongStop,
  stopPosition,
  STATE_LABEL,
  type LatLng,
  type TimelineRow,
} from "./logic";

export type ActivityKind = "start" | "break" | "resume" | "gap" | "notice" | "end" | "live";

/** The travel between two items of the story: how far, how long, how fast. */
export type Leg = {
  /** The key of the travel segment (what the map highlights). */
  key: string;
  distanceM: number;
  durationS: number;
  avgKmh: number;
  estimated: boolean;
  startedAt: string | null;
  endedAt: string | null;
};

export type Activity = {
  key: string;
  kind: ActivityKind;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Breaks and gaps: how long; null for a point in time. */
  durationS: number | null;
  /** Still going on: the journey is recorded and this has not ended yet. */
  open: boolean;
  pos: LatLng | null;
  /** The address when the optional reverse geocoder knew it, else the coordinates ("" when no position is known). */
  place: string;
  /** What the map points out and the detailed log highlights when this item is picked (null: nothing). */
  selectKey: string | null;
  /** Every row of the detailed log this item stands for: a pin picked on the map opens the item whose rows hold it. */
  rowKeys: string[];
  /** Break: its number among the breaks (1, 2, 3 ...). */
  breakNumber: number | null;
  longBreak: boolean;
  /** The travel that brought the journey here from the previous item. */
  legBefore: Leg | null;
  /** One short line under the title. */
  note: string;
  /** The rest, shown when the item is opened: label and value. */
  facts: [string, string][];
  mock: boolean;
  estimated: boolean;
};

export type JourneyStats = {
  /** From the start of the tracking to its end (to now while it is recorded). */
  journeyS: number;
  travelS: number;
  breakS: number;
  gapS: number;
  distanceM: number;
  breakCount: number;
  longBreakCount: number;
  longestBreakS: number;
  averageBreakS: number;
  /** "Started travelling": 1 for any journey that has begun. */
  started: number;
  /** "Resumed travelling": how many times the journey set off again after a break. */
  resumed: number;
  gapCount: number;
  legCount: number;
};

export type ActivityOptions = {
  /** What a pick of the first / last item points out on the map (the first and last recorded position). */
  startKey?: string | null;
  endKey?: string | null;
};

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** The gap between two instants in whole seconds (0 when either is unknown). */
const secondsBetween = (a: string | null, b: string | null): number => {
  const d = (ms(b) - ms(a)) / 1000;
  return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
};

const stamp = (iso: string | null, withSeconds = true): string => (iso ? fmtTime(iso, withSeconds) : "-");

function legOf(s: JourneySegment, key: string): Leg {
  const hours = s.durationS / 3600;
  return {
    key,
    distanceM: s.distanceM,
    durationS: s.durationS,
    avgKmh: s.avgSpeedKmh > 0 ? s.avgSpeedKmh : hours > 0 ? s.distanceM / 1000 / hours : 0,
    estimated: s.estimated,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

/** "12.26 km in 19 min, 38 km/h on average" */
export function legText(leg: Leg): string {
  const speed = leg.avgKmh > 0 ? `, ${Math.round(leg.avgKmh)} km/h on average` : "";
  return `${fmtDistance(leg.distanceM)} in ${fmtDuration(leg.durationS)}${speed}`;
}

function segmentPlace(s: JourneySegment, which: "start" | "end"): LatLng | null {
  if (s.kind === "stop") return stopPosition(s);
  const lat = which === "start" ? s.startLat : s.endLat;
  const lng = which === "start" ? s.startLng : s.endLng;
  return lat !== null && lng !== null && !(lat === 0 && lng === 0) ? [lat, lng] : null;
}

const where = (pos: LatLng | null, address = ""): string => address || (pos ? fmtCoords(pos[0], pos[1]) : "");

/** The events that are only the cause of a gap (the interval kinds that overlap it) are told by the gap, not twice. */
function overlaps(e: JourneyEvent, g: JourneySegment): boolean {
  if (!(e.kind in INTERVAL_KINDS)) return false;
  const slack = 60_000;
  const es = ms(e.startedAt);
  const ee = e.endedAt ? ms(e.endedAt) : es;
  return es <= ms(g.endedAt) + slack && ee >= ms(g.startedAt) - slack;
}

const SILENT_EVENTS = new Set(["TRACKING_STARTED", "TRACKING_STOPPED"]);

export function buildActivities(
  detail: JourneyDetail,
  rows: TimelineRow[],
  active: boolean,
  options: ActivityOptions = {},
): Activity[] {
  const { track } = detail;
  const segs = new Map<string, JourneySegment>();
  for (const s of detail.segments) segs.set(`seg-${s.seqNo}`, s);
  const events = new Map<string, JourneyEvent>();
  for (const e of detail.events) events.set(`ev-${e.id}`, e);
  const gaps = detail.segments.filter((s) => s.kind === "gap");

  const firstGeo = rows
    .map((r) => segs.get(r.key))
    .map((s) => (s ? segmentPlace(s, "start") : null))
    .find((p) => p !== null);
  const startPos: LatLng | null = firstGeo ?? null;
  let lastGeo: LatLng | null = null;
  for (const r of rows) {
    const s = segs.get(r.key);
    const p = s ? segmentPlace(s, "end") : null;
    if (p) lastGeo = p;
  }
  const endPos: LatLng | null =
    track.lastLatitude !== null && track.lastLongitude !== null ? [track.lastLatitude, track.lastLongitude] : lastGeo;

  const out: Activity[] = [];
  let pendingLeg: Leg | null = null;
  let breaks = 0;

  const base = (kind: ActivityKind, key: string, title: string, startedAt: string | null): Activity => ({
    key,
    kind,
    title,
    startedAt,
    endedAt: null,
    durationS: null,
    open: false,
    pos: null,
    place: "",
    selectKey: null,
    rowKeys: [],
    breakNumber: null,
    longBreak: false,
    legBefore: null,
    note: "",
    facts: [],
    mock: false,
    estimated: false,
  });

  // ── started ──
  const start = base("start", "act-start", "Journey started", track.startedAt);
  start.pos = startPos;
  start.place = where(startPos);
  start.selectKey = options.startKey ?? null;
  start.rowKeys = options.startKey ? [options.startKey] : [];
  start.note = `On-Duty to "${track.destination || "no destination"}"`;
  start.facts = [
    ["Tracking started", stamp(track.startedAt)],
    ["First position", detail.summary.firstPointAt ? stamp(detail.summary.firstPointAt) : "none yet"],
  ];
  out.push(start);

  const lastOut = (): Activity => out[out.length - 1];

  for (const row of rows) {
    const s = segs.get(row.key);
    if (s) {
      if (s.kind === "travel") {
        const afterBreak = lastOut().kind === "break";
        const leg = legOf(s, row.key);
        if (afterBreak) {
          const prev = lastOut();
          const resumed = base("resume", `act-${row.key}`, "Journey resumed", s.startedAt);
          resumed.pos = prev.pos;
          resumed.place = prev.place;
          resumed.selectKey = row.key;
          resumed.rowKeys = [row.key];
          resumed.note = `Left after a break of ${fmtDuration(prev.durationS)}`;
          resumed.facts = [
            ["Set off at", stamp(s.startedAt)],
            ["Break lasted", fmtDuration(prev.durationS)],
            ["Next leg", legText(leg)],
          ];
          resumed.mock = s.mock;
          out.push(resumed);
        }
        pendingLeg = leg;
        continue;
      }
      if (s.kind === "stop") {
        breaks += 1;
        const pos = stopPosition(s);
        const item = base("break", `act-${row.key}`, "Break taken", s.startedAt);
        item.endedAt = s.endedAt;
        item.durationS = row.durationS;
        item.open = row.open;
        item.pos = pos;
        item.place = where(pos, s.address);
        item.selectKey = row.key;
        item.rowKeys = [row.key];
        item.breakNumber = breaks;
        item.longBreak = isLongStop(s.durationS);
        item.legBefore = pendingLeg;
        item.note = s.radiusM > 0 ? `Positions within ${Math.round(s.radiusM)} m` : "";
        item.facts = [
          ["From", stamp(s.startedAt)],
          ["Until", s.endedAt ? stamp(s.endedAt) : "still there"],
          ["Lasted", row.durationS === null ? "ongoing" : fmtDuration(row.durationS)],
          ...(s.address ? ([["Address", s.address]] as [string, string][]) : []),
          ...(pos ? ([["Coordinates", fmtCoords(pos[0], pos[1])]] as [string, string][]) : []),
          ...(s.pointCount > 0 ? ([["Positions recorded", String(s.pointCount)]] as [string, string][]) : []),
          ...(pendingLeg ? ([["Arrived after", legText(pendingLeg)]] as [string, string][]) : []),
        ];
        item.mock = s.mock;
        item.estimated = s.estimated;
        pendingLeg = null;
        out.push(item);
        continue;
      }
      // a gap: no location recorded
      const covered = detail.events.filter((e) => overlaps(e, s));
      const item = base("gap", `act-${row.key}`, "Location not recorded", s.startedAt);
      item.endedAt = s.endedAt;
      item.durationS = row.durationS;
      item.open = row.open;
      item.pos = segmentPlace(s, "start");
      item.place = where(item.pos);
      item.selectKey = row.key;
      item.rowKeys = [row.key, ...covered.map((e) => `ev-${e.id}`)];
      item.legBefore = pendingLeg;
      const cause = row.cause ? causeLabel(row.cause) : "";
      item.note = cause;
      item.facts = [
        ["From", stamp(s.startedAt)],
        ["Until", s.endedAt ? stamp(s.endedAt) : "not back yet"],
        ["Lasted", row.durationS === null ? "ongoing" : fmtDuration(row.durationS)],
        ...(cause ? ([["Cause", cause]] as [string, string][]) : []),
        ...covered.map((e): [string, string] => [
          eventStyle(e.kind).label,
          `${stamp(e.startedAt)}${e.endedAt ? ` - ${stamp(e.endedAt)}` : ""}`,
        ]),
      ];
      item.mock = s.mock;
      item.estimated = s.estimated;
      pendingLeg = null;
      out.push(item);
      continue;
    }

    const e = events.get(row.key);
    if (!e || SILENT_EVENTS.has(e.kind)) continue;
    if (gaps.some((g) => overlaps(e, g))) continue;
    const style = eventStyle(e.kind);
    const item = base("notice", `act-${row.key}`, style.label, e.startedAt);
    item.endedAt = e.endedAt;
    item.durationS = row.durationS;
    item.open = row.open;
    item.pos = eventPosition(e);
    item.place = where(item.pos);
    item.selectKey = row.key;
    item.rowKeys = [row.key];
    item.note = eventDetail(e);
    item.facts = [
      ["At", stamp(e.startedAt)],
      ...(e.endedAt ? ([["Until", stamp(e.endedAt)]] as [string, string][]) : []),
      ...(row.durationS !== null ? ([["Lasted", fmtDuration(row.durationS)]] as [string, string][]) : []),
    ];
    item.mock = e.kind === "MOCK_LOCATION";
    out.push(item);
  }

  // ── completed, or still on duty ──
  if (active) {
    const live = base("live", "act-end", "On duty now", track.stateSince ?? track.lastPointAt ?? track.startedAt);
    live.open = true;
    live.pos = endPos;
    live.place = where(endPos);
    live.selectKey = options.endKey ?? null;
    live.rowKeys = options.endKey ? [options.endKey] : [];
    live.legBefore = pendingLeg;
    live.note = `${STATE_LABEL[track.state]}${track.stateSince ? ` since ${stamp(track.stateSince, false)}` : ""}`;
    live.facts = [
      ["State", STATE_LABEL[track.state]],
      ["Last position", track.lastPointAt ? stamp(track.lastPointAt) : "none yet"],
      ...(pendingLeg ? ([["Travelling now", legText(pendingLeg)]] as [string, string][]) : []),
    ];
    out.push(live);
  } else {
    const endedAt = track.endedAt ?? track.lastPointAt;
    const rejected = track.endReason === "rejected";
    const end = base("end", "act-end", rejected ? "Request rejected, tracking stopped" : "On-duty completed", endedAt);
    end.pos = endPos;
    end.place = where(endPos);
    end.selectKey = options.endKey ?? null;
    end.rowKeys = options.endKey ? [options.endKey] : [];
    end.legBefore = pendingLeg;
    end.note = endReasonLabel(track.endReason, track.status);
    end.facts = [
      ["Ended at", stamp(endedAt)],
      ["How it ended", endReasonLabel(track.endReason, track.status)],
      ["Total time", fmtDuration(track.durationS)],
      ...(pendingLeg ? ([["Last leg", legText(pendingLeg)]] as [string, string][]) : []),
    ];
    out.push(end);
  }
  return out;
}

export function journeyStats(detail: JourneyDetail, activities: Activity[]): JourneyStats {
  const { summary, track } = detail;
  const breaksList = activities.filter((a) => a.kind === "break");
  const durations = breaksList.map((a) => a.durationS ?? 0);
  const breakS = summary.stopS > 0 ? summary.stopS : durations.reduce((t, d) => t + d, 0);
  return {
    journeyS:
      track.durationS > 0 ? track.durationS : secondsBetween(track.startedAt, track.endedAt ?? track.lastPointAt),
    travelS: summary.travelS,
    breakS,
    gapS: summary.gapS,
    distanceM: summary.distanceM,
    breakCount: breaksList.length,
    longBreakCount: breaksList.filter((a) => a.longBreak).length,
    longestBreakS: Math.max(0, summary.longestStopS, ...durations),
    averageBreakS: breaksList.length ? Math.round(breakS / breaksList.length) : 0,
    started: track.startedAt ? 1 : 0,
    resumed: activities.filter((a) => a.kind === "resume").length,
    gapCount: activities.filter((a) => a.kind === "gap").length,
    legCount: detail.segments.filter((s) => s.kind === "travel").length,
  };
}

/** The share of the journey spent travelling, on a break and with no location, for the bar under the figures (0 - 1 each, in order). */
export function timeSplit(stats: JourneyStats): { travel: number; breaks: number; gap: number; other: number } {
  const total = Math.max(stats.journeyS, stats.travelS + stats.breakS + stats.gapS, 1);
  const travel = Math.min(1, stats.travelS / total);
  const breaks = Math.min(1 - travel, stats.breakS / total);
  const gap = Math.min(1 - travel - breaks, stats.gapS / total);
  return { travel, breaks, gap, other: Math.max(0, 1 - travel - breaks - gap) };
}
