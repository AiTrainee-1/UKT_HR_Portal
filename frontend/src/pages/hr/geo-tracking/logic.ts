// Journey History: the words, the figures and the colours. Pure functions (no React), so the rules the screen follows are
// tested on their own (logic.test.ts): how a duration or a distance is written, what a stop of 12 minutes is called,
// which cause belongs to a gap, how segments and events are merged into one timeline, and how the map boxes a journey.
import type {
  JourneyDetail,
  JourneyEvent,
  JourneyListItem,
  JourneySegment,
  JourneyTrail,
  LiveTrack,
  TrackEndReason,
  TrackState,
  TrailPoint,
} from "@/lib/api-client/custom-hooks";

/** A stop shorter than this is "waiting"; from this on it is a "long stop". */
export const LONG_STOP_S = 15 * 60;

export const isLongStop = (seconds: number): boolean => seconds >= LONG_STOP_S;

// ── figures ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** 45 s, 12 min, 1 h 25 min. Empty for nothing known. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const totalMin = Math.floor(s / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** 850 m, 3.24 km, 125.4 km. */
export function fmtDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return "-";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km >= 100 ? km.toFixed(1) : km.toFixed(2)} km`;
}

/** 5 decimals are about a metre: enough to find the place, short enough to read. */
export const fmtCoords = (lat: number | null | undefined, lng: number | null | undefined): string =>
  lat === null || lat === undefined || lng === null || lng === undefined ? "-" : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

// ── times (always India time: the clock of the factory, whatever the browser's) ──────────────────────────────────────

const TZ = "Asia/Kolkata";
const parse = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

export function fmtTime(iso: string | null | undefined, withSeconds = false): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
    timeZone: TZ,
  }).format(new Date(t));
}

export function fmtDate(iso: string | null | undefined): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ }).format(
    new Date(t),
  );
}

/** 28 Oct, 14:05 */
export function fmtDateTime(iso: string | null | undefined, withSeconds = false): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return "-";
  const day = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: TZ }).format(new Date(t));
  return `${day}, ${fmtTime(iso, withSeconds)}`;
}

/** The India calendar day (YYYY-MM-DD) of a time. */
export function istDay(iso: string | null | undefined): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t));
}

/** "14:05 - 14:25", or with the day when it ends on another day; "14:05 - now" while it is open. */
export function timeRange(start: string | null | undefined, end: string | null | undefined, open = false): string {
  if (!start) return "-";
  if (!end) return open ? `${fmtTime(start)} - now` : fmtTime(start);
  if (fmtTime(start) === fmtTime(end) && istDay(start) === istDay(end)) return fmtTime(start);
  return istDay(start) === istDay(end)
    ? `${fmtTime(start)} - ${fmtTime(end)}`
    : `${fmtDateTime(start)} - ${fmtDateTime(end)}`;
}

/** "just now", "5 min ago", "2 h 10 min ago". `now` is a parameter so a test does not depend on the clock. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return "never";
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 === 0 ? `${h} h ago` : `${h} h ${mins % 60} min ago`;
  return `${Math.floor(h / 24)} d ago`;
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const END_REASON_LABEL: Record<Exclude<TrackEndReason, "">, string> = {
  manual: "Marked done by the employee",
  auto_4th_punch: "4th punch captured",
  auto_day_end: "Closed automatically at day end",
  rejected: "Request rejected",
  admin: "Closed by an administrator",
};

export const END_REASONS = Object.keys(END_REASON_LABEL) as Exclude<TrackEndReason, "">[];

export function endReasonLabel(reason: TrackEndReason | string, status: "active" | "ended" = "ended"): string {
  if (status === "active") return "Still tracking";
  return END_REASON_LABEL[reason as keyof typeof END_REASON_LABEL] ?? "Ended";
}

export const STATE_LABEL: Record<TrackState, string> = {
  waiting_first_fix: "Waiting for first location",
  moving: "Moving",
  stationary: "Stationary",
  offline: "Offline",
  location_off: "Location off",
  ended: "Ended",
};

/** Tailwind classes of a state pill: green for moving, amber for stationary, grey for offline, red for location off. */
export const STATE_CLASS: Record<TrackState, string> = {
  moving: "bg-green-50 text-green-700",
  stationary: "bg-amber-50 text-amber-800",
  offline: "bg-gray-100 text-gray-700",
  location_off: "bg-red-50 text-red-700",
  waiting_first_fix: "bg-blue-50 text-blue-700",
  ended: "bg-gray-100 text-gray-600",
};

/** The colour of a state on the map (pins and dots). */
export const STATE_COLOR: Record<TrackState, string> = {
  moving: "#16a34a",
  stationary: "#d97706",
  offline: "#6b7280",
  location_off: "#7c3aed",
  waiting_first_fix: "#2563eb",
  ended: "#6b7280",
};

export type ApprovalGroup = "pending" | "approved" | "rejected" | "unknown";

/** pending_hod / pending_hr / pending -> pending; active / completed / approved -> approved; rejected -> rejected. */
export function approvalGroup(raw: string | null | undefined): ApprovalGroup {
  const v = (raw ?? "").toLowerCase();
  if (v === "pending" || v.startsWith("pending")) return "pending";
  if (v === "approved" || v === "active" || v === "completed") return "approved";
  if (v === "rejected" || v === "declined") return "rejected";
  return "unknown";
}

export function approvalLabel(raw: string | null | undefined): string {
  const v = (raw ?? "").toLowerCase();
  if (v === "pending_hod") return "Awaiting Department Head";
  if (v === "pending_hr") return "Awaiting HR";
  switch (approvalGroup(raw)) {
    case "pending":
      return "Approval pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    default:
      return "Unknown";
  }
}

export const APPROVAL_CLASS: Record<ApprovalGroup, string> = {
  pending: "bg-amber-50 text-amber-800",
  approved: "bg-green-50 text-green-700",
  rejected: "bg-red-50 text-red-700",
  unknown: "bg-gray-100 text-gray-600",
};

export const PERMISSION_LABEL: Record<string, string> = {
  always: "Allow all the time",
  while_using: "Only while using the app",
  denied: "Denied",
  unknown: "Unknown",
};

export const permissionLabel = (level: string): string => PERMISSION_LABEL[level] ?? PERMISSION_LABEL.unknown;

/** Good (green) only for "always": tracking with the app closed needs it. */
export const permissionClass = (level: string): string =>
  level === "always"
    ? "bg-green-50 text-green-700"
    : level === "denied"
      ? "bg-red-50 text-red-700"
      : "bg-amber-50 text-amber-800";

export const CAUSE_LABEL: Record<string, string> = {
  gps_off: "Location services were off",
  network_lost: "No network",
  app_killed: "App was closed",
  device_shutdown: "Phone was switched off",
  permission: "Location permission was taken away",
  power_save: "Battery saver",
  signal_lost: "No data received (signal lost)",
  unknown: "Cause unknown",
};

export const causeLabel = (cause: string): string => (cause ? (CAUSE_LABEL[cause] ?? humanise(cause)) : "");

/** GPS_OFF -> "Gps off": the fallback for a kind nobody wrote a sentence for. */
export function humanise(text: string): string {
  const words = text.toLowerCase().replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

export type EventStyle = {
  label: string;
  color: string;
  /** Which small picture the map pin carries. */
  glyph: "gps" | "network" | "power" | "app" | "mock" | "battery" | "lock" | "clock" | "flag" | "dot";
  /** Lifecycle events (started / stopped) are in the timeline but not on the map: the start and end pins say it. */
  onMap: boolean;
};

export const EVENT_STYLE: Record<string, EventStyle> = {
  TRACKING_STARTED: { label: "Tracking started", color: "#16a34a", glyph: "flag", onMap: false },
  TRACKING_STOPPED: { label: "Tracking stopped", color: "#475569", glyph: "flag", onMap: false },
  GPS_OFF: { label: "Location services turned off", color: "#dc2626", glyph: "gps", onMap: true },
  NETWORK_LOST: { label: "Network lost", color: "#ea580c", glyph: "network", onMap: true },
  AIRPLANE_ON: { label: "Airplane mode on", color: "#ea580c", glyph: "network", onMap: true },
  POWER_SAVE_ON: { label: "Battery saver on", color: "#ca8a04", glyph: "battery", onMap: true },
  PERMISSION_CHANGED: { label: "Location permission changed", color: "#7c3aed", glyph: "lock", onMap: true },
  LOW_BATTERY: { label: "Low battery", color: "#ca8a04", glyph: "battery", onMap: true },
  MOCK_LOCATION: { label: "Simulated (fake) location detected", color: "#dc2626", glyph: "mock", onMap: true },
  CLOCK_CHANGED: { label: "Phone clock changed", color: "#0e7490", glyph: "clock", onMap: true },
  APP_RESTARTED: { label: "App restarted", color: "#2563eb", glyph: "app", onMap: true },
  APP_KILLED: { label: "App was closed", color: "#1f2937", glyph: "app", onMap: true },
  DEVICE_SHUTDOWN: { label: "Phone shut down", color: "#111827", glyph: "power", onMap: true },
  DEVICE_BOOT: { label: "Phone started", color: "#2563eb", glyph: "power", onMap: true },
  BACKGROUND_RESTRICTED: { label: "Background activity restricted", color: "#7c3aed", glyph: "lock", onMap: true },
  SIGNAL_LOST: { label: "No data received (signal lost)", color: "#6b7280", glyph: "network", onMap: true },
  SERVER_NOTE: { label: "Note", color: "#6b7280", glyph: "dot", onMap: true },
};

export const eventStyle = (kind: string): EventStyle =>
  EVENT_STYLE[kind] ?? { label: humanise(kind) || "Event", color: "#6b7280", glyph: "dot", onMap: true };

/** What an event says beyond its name: a permission change, a battery level, a note. */
export function eventDetail(e: JourneyEvent): string {
  const m = e.meta;
  const bits: string[] = [];
  if (e.kind === "PERMISSION_CHANGED" && (m.from || m.to)) {
    bits.push(`${humanise(String(m.from ?? "?"))} to ${humanise(String(m.to ?? "?"))}`);
  }
  const pct = m.batteryPct ?? m.pct ?? m.battery;
  if (e.kind === "LOW_BATTERY" && typeof pct === "number") bits.push(`${Math.round(pct)}%`);
  if (typeof m.note === "string" && m.note) bits.push(m.note);
  if (typeof m.reason === "string" && m.reason && e.kind !== "PERMISSION_CHANGED") bits.push(humanise(m.reason));
  return bits.join(" - ");
}

// ── the merged timeline ───────────────────────────────────────────────────────────────────────────────────────────

export type TimelineType = "travel" | "stop" | "gap" | "event";

export const TIMELINE_TYPE_LABEL: Record<TimelineType, string> = {
  travel: "Travel",
  stop: "Stationary",
  gap: "Gap",
  event: "Event",
};

export const TIMELINE_TYPE_CLASS: Record<TimelineType, string> = {
  travel: "bg-blue-50 text-blue-700",
  stop: "bg-amber-50 text-amber-800",
  gap: "bg-gray-100 text-gray-700",
  event: "bg-purple-50 text-purple-700",
};

export type TimelineRow = {
  /** seg-<seqNo> or ev-<id>: what the map and the table point each other out by. */
  key: string;
  type: TimelineType;
  startedAt: string | null;
  endedAt: string | null;
  /** An interval that has not closed yet (an event or the last segment of an active track). */
  open: boolean;
  durationS: number | null;
  distanceM: number | null;
  /** The headline of the row: the place of a stop, the route of a travel, the name of an event. */
  title: string;
  /** The second line: coordinates, what the event meant. */
  detail: string;
  cause: string;
  /** Stop: a stop of at least LONG_STOP_S. */
  longStop: boolean;
  estimated: boolean;
  mock: boolean;
  /** A stop's number among the stops (1, 2, 3 ...), the number on its map pin. */
  stopNumber: number | null;
  /** Where it happened, when it happened in one place (a stop, an event): what the Google Maps link opens. */
  pos: LatLng | null;
};

export const segmentKey = (s: JourneySegment): string => `seg-${s.seqNo}`;
export const eventKey = (e: JourneyEvent): string => `ev-${e.id}`;

function segmentTitle(s: JourneySegment): { title: string; detail: string } {
  if (s.kind === "stop") {
    const where = fmtCoords(s.centerLat ?? s.startLat, s.centerLng ?? s.startLng);
    return {
      title: s.address || where,
      detail: s.address ? where : s.radiusM > 0 ? `positions within ${Math.round(s.radiusM)} m` : "",
    };
  }
  if (s.kind === "gap") {
    return { title: "No location recorded", detail: "" };
  }
  const speed = s.avgSpeedKmh > 0 ? `, ${Math.round(s.avgSpeedKmh)} km/h on average` : "";
  return {
    title: `Travelled ${fmtDistance(s.distanceM)}${speed}`,
    detail: `${fmtCoords(s.startLat, s.startLng)} to ${fmtCoords(s.endLat, s.endLng)}`,
  };
}

/**
 * Segments (travel, stationary, gap) and events in one list by time. Stops are numbered in order. An event of an interval
 * kind that is still open while the track is active is marked `open` (its duration is not known yet).
 */
export function buildTimeline(segments: JourneySegment[], events: JourneyEvent[], trackActive = false): TimelineRow[] {
  const ordered = [...segments].sort((a, b) => parse(a.startedAt) - parse(b.startedAt) || a.seqNo - b.seqNo);
  let stops = 0;
  const rows: TimelineRow[] = ordered.map((s, i) => {
    const { title, detail } = segmentTitle(s);
    const isStop = s.kind === "stop";
    if (isStop) stops += 1;
    return {
      key: segmentKey(s),
      type: s.kind,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      open: trackActive && i === ordered.length - 1 && !s.endedAt,
      durationS: s.durationS > 0 || s.endedAt ? s.durationS : null,
      distanceM: s.kind === "travel" ? s.distanceM : null,
      title,
      detail,
      cause: s.kind === "gap" ? s.cause || "unknown" : "",
      longStop: isStop && isLongStop(s.durationS),
      estimated: s.estimated,
      mock: s.mock,
      stopNumber: isStop ? stops : null,
      pos: isStop ? stopPosition(s) : null,
    };
  });
  for (const e of events) {
    const style = eventStyle(e.kind);
    const duration =
      e.endedAt && e.startedAt ? Math.max(0, Math.round((parse(e.endedAt) - parse(e.startedAt)) / 1000)) : null;
    rows.push({
      key: eventKey(e),
      type: "event",
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      open: !e.endedAt && trackActive && e.kind in INTERVAL_KINDS,
      durationS: duration,
      distanceM: null,
      title: style.label,
      detail: eventDetail(e),
      cause: "",
      longStop: false,
      estimated: false,
      mock: e.kind === "MOCK_LOCATION",
      stopNumber: null,
      pos: eventPosition(e),
    });
  }
  // by start time; at the same moment a segment comes before an event
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const d = parse(a.row.startedAt) - parse(b.row.startedAt);
      if (d !== 0 && !Number.isNaN(d)) return d;
      if (a.row.type === "event" && b.row.type !== "event") return 1;
      if (b.row.type === "event" && a.row.type !== "event") return -1;
      return a.index - b.index;
    })
    .map((x) => x.row);
}

/** The event kinds that open an interval the matching "on / restored" closes. */
export const INTERVAL_KINDS: Record<string, true> = {
  GPS_OFF: true,
  NETWORK_LOST: true,
  AIRPLANE_ON: true,
  POWER_SAVE_ON: true,
  SIGNAL_LOST: true,
};

// ── the map ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LatLng = [number, number];

const valid = (lat: number | null, lng: number | null): lat is number =>
  lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** Where a stop is drawn: its centre, else where it started. */
export function stopPosition(s: JourneySegment): LatLng | null {
  if (valid(s.centerLat, s.centerLng)) return [s.centerLat as number, s.centerLng as number];
  if (valid(s.startLat, s.startLng)) return [s.startLat as number, s.startLng as number];
  return null;
}

/** A gap is a straight line between where the signal was lost and where it came back. */
export function gapLine(s: JourneySegment): [LatLng, LatLng] | null {
  if (valid(s.startLat, s.startLng) && valid(s.endLat, s.endLng)) {
    return [
      [s.startLat as number, s.startLng as number],
      [s.endLat as number, s.endLng as number],
    ];
  }
  return null;
}

/** The line of a travel segment: its simplified route, else the straight line from start to end. */
export function travelLine(s: JourneySegment): LatLng[] {
  if (s.polyline.length >= 2) return s.polyline;
  if (valid(s.startLat, s.startLng) && valid(s.endLat, s.endLng)) {
    return [
      [s.startLat as number, s.startLng as number],
      [s.endLat as number, s.endLng as number],
    ];
  }
  return [];
}

export const eventPosition = (e: JourneyEvent): LatLng | null =>
  valid(e.latitude, e.longitude) ? [e.latitude as number, e.longitude as number] : null;

export type MapStop = { key: string; pos: LatLng; row: TimelineRow; radiusM: number };

/**
 * Stops whose places are within this of each other are the very same spot (the same gate, visited twice): drawn apart their pins would
 * lie exactly on top of each other and the later one would hide the earlier. Anything farther apart is a place of its own and has
 * its own pin, however near.
 */
export const SAME_PLACE_M = 15;

/** One pin of the map: one stop, or several stops at the same place (the later ones would otherwise hide the earlier). */
export type StopGroup = { key: string; pos: LatLng; stops: MapStop[] };

const placeDistanceM = (a: LatLng, b: LatLng): number => {
  const dy = (b[0] - a[0]) * 110540;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
};

/** Stops in time order -> pins: a stop joins the first pin whose place is within `withinM` of it, else it starts a new pin. */
export function groupStops(stops: MapStop[], withinM: number = SAME_PLACE_M): StopGroup[] {
  const groups: { stops: MapStop[] }[] = [];
  for (const stop of stops) {
    const home = groups.find((g) => placeDistanceM(g.stops[0].pos, stop.pos) <= withinM);
    if (home) home.stops.push(stop);
    else groups.push({ stops: [stop] });
  }
  return groups.map((g) => ({
    key: g.stops[0].key,
    // the middle of the places, so a pin of two stops sits between them
    pos: [
      g.stops.reduce((sum, s) => sum + s.pos[0], 0) / g.stops.length,
      g.stops.reduce((sum, s) => sum + s.pos[1], 0) / g.stops.length,
    ] as LatLng,
    stops: g.stops,
  }));
}

/** What the pin says: "2", or "1 · 3" for stops 1 and 3 at one place ("1 · 3 +2" when there are more than three). */
export function stopGroupLabel(group: StopGroup): string {
  const numbers = group.stops.map((s) => String(s.row.stopNumber ?? "?"));
  return numbers.length <= 3
    ? numbers.join(" \u00b7 ")
    : `${numbers.slice(0, 2).join(" \u00b7 ")} +${numbers.length - 2}`;
}

export type MapModel = {
  /** Travel segments (and `path` when there are none). */
  travel: { key: string; line: LatLng[]; estimated: boolean; mock: boolean }[];
  gaps: { key: string; line: [LatLng, LatLng]; cause: string }[];
  stops: MapStop[];
  /** The stops as pins: stops at one place are one pin (see groupStops). */
  stopGroups: StopGroup[];
  events: { key: string; pos: LatLng; event: JourneyEvent }[];
  start: LatLng | null;
  /** The last known position: where the journey ended, or where the employee is now. */
  end: LatLng | null;
  /** Every coordinate that is drawn: what the map is fitted to. */
  all: LatLng[];
};

/** What the map draws for a journey: lines, stops, events and the two ends. The route comes from the segments, else from `path`. */
export function mapModel(detail: JourneyDetail, rows: TimelineRow[]): MapModel {
  const rowOf = new Map(rows.map((r) => [r.key, r]));
  const travel: MapModel["travel"] = [];
  const gaps: MapModel["gaps"] = [];
  const stops: MapModel["stops"] = [];
  for (const s of detail.segments) {
    const key = segmentKey(s);
    if (s.kind === "travel") {
      const line = travelLine(s);
      if (line.length >= 2) travel.push({ key, line, estimated: s.estimated, mock: s.mock });
    } else if (s.kind === "gap") {
      const line = gapLine(s);
      if (line) gaps.push({ key, line, cause: s.cause });
    } else {
      const pos = stopPosition(s);
      const row = rowOf.get(key);
      if (pos && row) stops.push({ key, pos, row, radiusM: s.radiusM });
    }
  }
  if (travel.length === 0 && gaps.length === 0 && stops.length === 0 && detail.path.length >= 2) {
    // nothing rebuilt yet: the overall route as one line
    travel.push({ key: "path", line: detail.path.map((p) => [p.lat, p.lng] as LatLng), estimated: false, mock: false });
  }
  const events = detail.events.flatMap((e) => {
    const pos = eventPosition(e);
    return pos && eventStyle(e.kind).onMap ? [{ key: eventKey(e), pos, event: e }] : [];
  });
  const firstSeg = detail.segments.find((s) => travelLine(s).length > 0 || stopPosition(s));
  const lastSeg = [...detail.segments].reverse().find((s) => travelLine(s).length > 0 || stopPosition(s));
  const startOfSeg = (s: JourneySegment | undefined): LatLng | null =>
    !s ? null : s.kind === "stop" ? stopPosition(s) : (travelLine(s)[0] ?? null);
  const endOfSeg = (s: JourneySegment | undefined): LatLng | null =>
    !s ? null : s.kind === "stop" ? stopPosition(s) : (travelLine(s).at(-1) ?? null);
  const start: LatLng | null =
    startOfSeg(firstSeg) ?? (detail.path[0] ? [detail.path[0].lat, detail.path[0].lng] : null);
  const lastKnown: LatLng | null = valid(detail.track.lastLatitude, detail.track.lastLongitude)
    ? [detail.track.lastLatitude as number, detail.track.lastLongitude as number]
    : null;
  const end: LatLng | null =
    lastKnown ?? endOfSeg(lastSeg) ?? (detail.path.length ? [detail.path.at(-1)!.lat, detail.path.at(-1)!.lng] : null);
  const all: LatLng[] = [
    ...travel.flatMap((t) => t.line),
    ...gaps.flatMap((g) => g.line),
    ...stops.map((s) => s.pos),
    ...events.map((e) => e.pos),
    ...(start ? [start] : []),
    ...(end ? [end] : []),
  ];
  return { travel, gaps, stops, stopGroups: groupStops(stops), events, start, end, all };
}

/** The south-west and north-east corners of some points (null for none). */
export function boundsOf(points: LatLng[]): [LatLng, LatLng] | null {
  if (points.length === 0) return null;
  let s = 90;
  let w = 180;
  let n = -90;
  let e = -180;
  for (const [la, ln] of points) {
    s = Math.min(s, la);
    n = Math.max(n, la);
    w = Math.min(w, ln);
    e = Math.max(e, ln);
  }
  return [
    [s, w],
    [n, e],
  ];
}

// ── the list and the board ───────────────────────────────────────────────────────────────────────────────────────

/** The end-reason filter: a journey that is still active has no end reason, so it never matches one. */
export const sameReason = (item: JourneyListItem, reason: string): boolean => !reason || item.endReason === reason;

/** The board's rows: the ones that need a look first (location off, offline), then moving, stationary, the rest. */
const BOARD_ORDER: Record<TrackState, number> = {
  location_off: 0,
  offline: 1,
  waiting_first_fix: 2,
  moving: 3,
  stationary: 4,
  ended: 5,
};

export const sortLive = (rows: LiveTrack[]): LiveTrack[] =>
  [...rows].sort((a, b) => BOARD_ORDER[a.state] - BOARD_ORDER[b.state] || a.employeeName.localeCompare(b.employeeName));

// ── the trail: every recorded position (the complete route, and the points HR can pick) ──────────────────────────────────

/** More than this between two positions is not a continuous line: the gap segment draws it (dashed), not the trail. */
export const TRAIL_BREAK_MS = 5 * 60_000;

export type TrailDot = {
  /** pt-<time>: what the map and the details panel point each other out by. */
  key: string;
  pos: LatLng;
  point: TrailPoint;
  /** The number of the stationary period the position belongs to (the number on its map pin), if any. */
  stopNumber: number | null;
  longStop: boolean;
};

/** A continuous stretch of the trail: moving (stopNumber null) or the positions recorded during one stationary period. */
export type TrailRun = { key: string; line: LatLng[]; stopNumber: number | null; longStop: boolean };

export type TrailModel = {
  runs: TrailRun[];
  /** Every position with a usable coordinate, in time order (the ones the pipeline set aside included: `point.used` tells). */
  dots: TrailDot[];
  byKey: Map<string, TrailDot>;
  /** Positions that make the route / positions set aside as too inaccurate or a GPS jump. */
  used: number;
  poor: number;
  /** Positions the phone stored (more than `dots.length` when the server thinned a very long journey). */
  total: number;
  truncated: boolean;
  source: "points" | "segments";
};

export const trailKey = (p: TrailPoint): string => `pt-${p.t}`;

/**
 * What the map draws of the trail: the continuous lines (split where the phone was silent for more than TRAIL_BREAK_MS, and
 * between travelling and each stationary period, so a stop's wander is its own thin line) and one dot per position.
 */
export function trailModel(trail: JourneyTrail | null | undefined, rows: TimelineRow[]): TrailModel | null {
  if (!trail || trail.points.length === 0) return null;
  const stopRow = new Map(rows.filter((r) => r.type === "stop").map((r) => [r.key, r]));
  const dots: TrailDot[] = [];
  const runs: TrailRun[] = [];
  let current: TrailRun | null = null;
  let prev: TrailDot | null = null;
  for (const point of trail.points) {
    if (!valid(point.lat, point.lng)) continue;
    const row = point.stop !== null ? stopRow.get(`seg-${point.stop}`) : undefined;
    const dot: TrailDot = {
      key: trailKey(point),
      pos: [point.lat, point.lng],
      point,
      stopNumber: row?.stopNumber ?? null,
      longStop: row?.longStop ?? false,
    };
    dots.push(dot);
    if (!point.used) continue;
    const fresh = (): TrailRun => ({
      key: `run-${runs.length}`,
      line: [],
      stopNumber: dot.stopNumber,
      longStop: dot.longStop,
    });
    if (!prev || !current || point.t - prev.point.t > TRAIL_BREAK_MS) {
      current = fresh();
      current.line.push(dot.pos);
      runs.push(current);
    } else if (current.stopNumber !== dot.stopNumber) {
      // travelling <-> stationary: a new run that starts at the previous position, so the line stays connected
      current = fresh();
      current.line.push(prev.pos, dot.pos);
      runs.push(current);
    } else {
      current.line.push(dot.pos);
    }
    prev = dot;
  }
  const used = dots.filter((d) => d.point.used).length;
  return {
    runs: runs.filter((r) => r.line.length >= 2),
    dots,
    byKey: new Map(dots.map((d) => [d.key, d])),
    used,
    poor: dots.length - used,
    total: Math.max(trail.total, dots.length),
    truncated: trail.truncated,
    source: trail.source,
  };
}

export const ACTIVITY_LABEL: Record<string, string> = {
  still: "Still",
  walking: "Walking",
  running: "Running",
  vehicle: "In a vehicle",
  bicycle: "Cycling",
  unknown: "Not known",
};
export const activityLabel = (a: string): string => ACTIVITY_LABEL[a] ?? (humanise(a) || ACTIVITY_LABEL.unknown);

export const NETWORK_LABEL: Record<string, string> = {
  wifi: "Wi-Fi",
  cell: "Mobile data",
  none: "No network",
  unknown: "Not known",
};
export const networkLabel = (n: string): string => NETWORK_LABEL[n] ?? (humanise(n) || NETWORK_LABEL.unknown);

export const PROVIDER_LABEL: Record<string, string> = {
  gps: "GPS",
  fused: "GPS + network",
  network: "Network only",
  passive: "Other app's fix",
  unknown: "Not known",
};
export const providerLabel = (p: string): string => PROVIDER_LABEL[p] ?? (humanise(p) || PROVIDER_LABEL.unknown);

export const fmtSpeed = (kmh: number | null | undefined): string =>
  kmh === null || kmh === undefined || !Number.isFinite(kmh) ? "-" : `${Math.round(kmh)} km/h`;

/** "+-14 m": how far from the shown place the phone could really have been. */
export const fmtAccuracy = (m: number | null | undefined): string =>
  m === null || m === undefined || !Number.isFinite(m) ? "-" : `\u00b1${Math.round(m)} m`;

/** In words: a position good to 20 m is good, to 50 m fair, beyond that poor (indoors, between tall buildings). */
export function accuracyWord(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "";
  return m <= 20 ? "good" : m <= 50 ? "fair" : "poor";
}

/** The facts of one recorded position, in reading order (the popup and the details panel show the same list). */
export function pointFacts(p: TrailPoint): [string, string][] {
  const iso = new Date(p.t).toISOString();
  const word = accuracyWord(p.accuracyM);
  return [
    ["Time (IST)", fmtDateTime(iso, true)],
    ["Position", fmtCoords(p.lat, p.lng)],
    ["Accuracy", p.accuracyM === null ? "-" : `${fmtAccuracy(p.accuracyM)}${word ? ` (${word})` : ""}`],
    ["Speed", fmtSpeed(p.speedKmh)],
    ["Activity", activityLabel(p.activity)],
    ["Battery", p.batteryPct === null ? "-" : `${Math.round(p.batteryPct)}%`],
    ["Network", networkLabel(p.network)],
    ["Source", providerLabel(p.provider)],
  ];
}
