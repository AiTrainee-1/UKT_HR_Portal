// geo-tracking: the HR side of On-Duty Geo-Tracking (backend/api/geo_tracking/). A track starts when an employee submits an
// On-Duty request and records their route, the places they stopped at, the gaps where no location arrived and the events
// (location off, network lost, app closed, phone shut down, fake GPS ...). This file is the contract of the portal with
// that API: journeys (list, one journey, raw points, export, rebuild), the live board and the rules (settings).
//
// The shapes are the contract of the spec (docs: "On-Duty Geo-Tracking"). The readers are forgiving (a missing field, a
// bare array instead of a wrapper, a time as epoch milliseconds) so a small difference does not blank a page, but the field
// names are exact. Nothing here talks to a third party: coordinates stay on our own server.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch, getApiOrigin } from "../custom-fetch";

// ── types ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TrackStatus = "active" | "ended";
/** moving / stationary / offline (no data for a while) / location_off (GPS switched off) / waiting_first_fix / ended. */
export type TrackState = "waiting_first_fix" | "moving" | "stationary" | "offline" | "location_off" | "ended";
/** Why a track stopped: the employee marked Done, the 4th punch, the automatic close at day end, the request rejected, an admin. */
export type TrackEndReason = "manual" | "auto_4th_punch" | "auto_day_end" | "rejected" | "admin" | "";

/** One row of the journey list. */
export type JourneyListItem = {
  id: number;
  sessionId: number | null;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  branchName: string | null;
  destination: string;
  startedAt: string | null;
  endedAt: string | null;
  endReason: TrackEndReason;
  status: TrackStatus;
  state: TrackState;
  /** Seconds from the start of the track to its end (or to now while it is active). */
  durationS: number;
  distanceM: number;
  travelS: number;
  /** Time spent stationary (waiting, breaks, stops). */
  stopS: number;
  /** Time with no location (location off, no network, app closed ...). */
  gapS: number;
  stopCount: number;
  longestStopS: number;
  pointsCount: number;
  eventsCount: number;
  /** A simulated (fake GPS) location was reported at least once. */
  hasMock: boolean;
  /** What the On-Duty request is at: the raw status (pending_hod, pending_hr, active, completed, rejected) or approved / pending / rejected. */
  approvalStatus: string;
  lastPointAt: string | null;
};

export type JourneyTrack = JourneyListItem & {
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastBatteryPct: number | null;
  lastNetwork: string | null;
  stateSince: string | null;
};

export type JourneySummary = {
  distanceM: number;
  travelS: number;
  stopS: number;
  gapS: number;
  stopCount: number;
  longestStopS: number;
  maxSpeedKmh: number;
  firstPointAt: string | null;
  /** The last point the totals include (the journey is rebuilt as data arrives). */
  summaryThrough: string | null;
  rebuiltAt: string | null;
  flags: Record<string, unknown>;
};

export type SegmentKind = "travel" | "stop" | "gap";

export type JourneySegment = {
  seqNo: number;
  kind: SegmentKind;
  startedAt: string | null;
  endedAt: string | null;
  durationS: number;
  distanceM: number;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  /** Stop: the centre of the place. */
  centerLat: number | null;
  centerLng: number | null;
  radiusM: number;
  pointCount: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  /** Travel: the route, simplified, as [lat, lng] pairs. */
  polyline: [number, number][];
  /** Stop: the address, when the optional reverse geocoder filled it in. */
  address: string;
  /** Gap: gps_off, network_lost, app_killed, device_shutdown, permission, power_save, signal_lost or unknown. */
  cause: string;
  /** Drawn between two known points rather than measured. */
  estimated: boolean;
  eventId: number | null;
  meta: Record<string, unknown>;
  /** The segment contains simulated (fake GPS) locations. */
  mock: boolean;
};

export type JourneyEvent = {
  id: number;
  kind: string;
  source: string;
  startedAt: string | null;
  /** An interval event (GPS off, network lost ...) has an end; null while it is still open. */
  endedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  meta: Record<string, unknown>;
};

/** One point of the simplified overall route: t is epoch milliseconds (null when the server sent none). */
export type JourneyPathPoint = { lat: number; lng: number; t: number | null };

export type JourneyDevice = {
  deviceId: string;
  platform: string;
  model: string;
  osVersion: string;
  appVersion: string;
  /** always / while_using / denied / unknown. */
  permissionLevel: string;
  locationEnabled: boolean | null;
  backgroundRestricted: boolean | null;
  batteryOptimised: boolean | null;
  powerSave: boolean | null;
  lastSeenAt: string | null;
  lastBatteryPct: number | null;
  lastNetwork: string | null;
  lastHeartbeatAt: string | null;
};

export type JourneyDetail = {
  track: JourneyTrack;
  summary: JourneySummary;
  segments: JourneySegment[];
  events: JourneyEvent[];
  path: JourneyPathPoint[];
  device: JourneyDevice | null;
};

export type JourneyListParams = {
  employeeId?: number | null;
  /** YYYY-MM-DD, the day the journey started on or after. */
  from?: string;
  /** YYYY-MM-DD, the day the journey started on or before. */
  to?: string;
  status?: "" | TrackStatus;
  /** Not part of the first contract: sent too, and also applied to the rows that arrive (see JourneyList). */
  endReason?: string;
  page?: number;
  pageSize?: number;
};

export type JourneyListPage = { results: JourneyListItem[]; page: number; pageSize: number; total: number };

/** One raw GPS point (the cursor feed behind the route). */
export type JourneyRawPoint = {
  id: number;
  recordedAt: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  speedMps: number | null;
  activity: string;
  batteryPct: number | null;
  network: string;
  provider: string;
  isMock: boolean;
};

export type JourneyPointsPage = { points: JourneyRawPoint[]; next: number | null };

/**
 * One recorded position of the route trail (GET /api/tracking/journeys/<id>/trail): every fix the phone stored, in time order,
 * so the map can show the COMPLETE route and let HR pick any point of it. `used` is false for a position the pipeline set aside
 * (too inaccurate, or a GPS jump); `stop` is the seqNo of the stationary period the position belongs to, if any.
 */
export type TrailPoint = {
  /** epoch milliseconds */
  t: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedKmh: number | null;
  activity: string;
  batteryPct: number | null;
  network: string;
  provider: string;
  mock: boolean;
  used: boolean;
  stop: number | null;
};

export type JourneyTrail = {
  trackId: number;
  /** "points" = the stored fixes; "segments" = rebuilt from the stops and travel lines once the raw rows were purged. */
  source: "points" | "segments";
  /** Positions the phone stored / positions in this answer (the server thins a very long journey). */
  total: number;
  count: number;
  truncated: boolean;
  points: TrailPoint[];
};

/** One active track of the live board. */
export type LiveTrack = {
  trackId: number;
  sessionId: number | null;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  branchName: string | null;
  destination: string;
  state: TrackState;
  stateSince: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  lastPointAt: string | null;
  batteryPct: number | null;
  network: string | null;
  isMocked: boolean;
  startedAt: string | null;
  approvalStatus: string;
  stopCount: number;
  distanceM: number;
};

export type GeoReverseProvider = "off" | "nominatim";

/** The rules of geo-tracking (one row on the server). Times are seconds unless the name says otherwise. */
export type GeoTrackingSettings = {
  enabled: boolean;
  stopSeconds: number;
  stopRadiusM: number;
  stopAccuracyFactor: number;
  mergeStopGapSeconds: number;
  gapSeconds: number;
  signalLostSeconds: number;
  maxAccuracyM: number;
  maxSpeedKmh: number;
  sampleMovingSeconds: number;
  sampleStillSeconds: number;
  distanceFilterM: number;
  uploadBatchPoints: number;
  uploadIntervalSeconds: number;
  retentionDays: number;
  /** HH:MM (India time): open On-Duty sessions and tracks close at this time. */
  dayEndTime: string;
  /** How many photos an On-Duty punch needs: 1, or 2 once every employee has the new app. */
  ondutyPunchPhotos: 1 | 2;
  noticeVersion: number;
  noticeText: string;
  reverseGeocodeProvider: GeoReverseProvider;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** What a save sends: any of the rules, never who or when it was last saved. */
export type GeoTrackingSettingsPatch = Partial<Omit<GeoTrackingSettings, "updatedBy" | "updatedAt">>;

/** What the server starts with (and what an unread field falls back to). */
export const DEFAULT_GEO_SETTINGS: GeoTrackingSettings = {
  enabled: true,
  stopSeconds: 180,
  stopRadiusM: 50,
  stopAccuracyFactor: 2,
  mergeStopGapSeconds: 120,
  gapSeconds: 300,
  signalLostSeconds: 600,
  maxAccuracyM: 100,
  maxSpeedKmh: 200,
  sampleMovingSeconds: 3,
  sampleStillSeconds: 60,
  distanceFilterM: 10,
  uploadBatchPoints: 30,
  uploadIntervalSeconds: 60,
  retentionDays: 365,
  dayEndTime: "23:50",
  ondutyPunchPhotos: 1,
  noticeVersion: 1,
  noticeText: "",
  reverseGeocodeProvider: "off",
  updatedBy: null,
  updatedAt: null,
};

// ── query keys ────────────────────────────────────────────────────────────────────────────────────────────────────

const PATH = "/api/tracking";
export const TRACKING_PATH = PATH;

/** Prefix of every journey query (the list, one journey, its points): invalidate this to refresh them all. */
export const getJourneysRootKey = () => [`${PATH}/journeys`] as const;
export const getJourneysQueryKey = (params: JourneyListParams) => [`${PATH}/journeys`, "list", params] as const;
export const getJourneyQueryKey = (id: number) => [`${PATH}/journeys`, "one", id] as const;
export const getJourneyPointsQueryKey = (id: number, after: number, limit: number) =>
  [`${PATH}/journeys`, "points", id, after, limit] as const;
export const getJourneyTrailQueryKey = (id: number) => [`${PATH}/journeys`, "trail", id] as const;
export const getLiveTracksQueryKey = () => [`${PATH}/live`] as const;
export const getGeoSettingsQueryKey = () => [`${PATH}/settings`] as const;

// ── reading what the server sends, tolerantly ─────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fallback = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // a Decimal comes through JSON as a string ("12.345678")
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
};
const numOrNull = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const first = <T>(...values: (T | undefined)[]): T | undefined => values.find((v) => v !== undefined && v !== null);
const list = (v: unknown, ...wrappers: string[]): unknown[] => {
  if (Array.isArray(v)) return v;
  if (isObj(v)) for (const key of wrappers) if (Array.isArray(v[key])) return v[key] as unknown[];
  return [];
};

/** A time as an ISO string: the server sends ISO text, or epoch milliseconds (or seconds). */
function timeOrNull(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** A time as epoch milliseconds. */
function epochOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const STATES: TrackState[] = ["waiting_first_fix", "moving", "stationary", "offline", "location_off", "ended"];
const trackState = (v: unknown, fallback: TrackState): TrackState =>
  STATES.includes(v as TrackState) ? (v as TrackState) : fallback;
const END_REASONS: TrackEndReason[] = ["manual", "auto_4th_punch", "auto_day_end", "rejected", "admin"];
const endReason = (v: unknown): TrackEndReason =>
  END_REASONS.includes(v as TrackEndReason) ? (v as TrackEndReason) : "";
const SEGMENT_KINDS: SegmentKind[] = ["travel", "stop", "gap"];

/** A latitude / longitude pair from either spelling of the keys. */
const lat = (r: Json, ...keys: string[]) => numOrNull(first(...keys.map((k) => r[k])));

export function readJourneyItem(raw: unknown): JourneyListItem {
  const r = isObj(raw) ? raw : {};
  const status: TrackStatus = r.status === "active" ? "active" : "ended";
  const mockPoints = num(r.mockPoints);
  const startedAt = timeOrNull(r.startedAt);
  const endedAt = timeOrNull(r.endedAt);
  const lastPointAt = timeOrNull(r.lastPointAt);
  let durationS = num(r.durationS, -1);
  if (durationS < 0) {
    // an older answer without the figure: measured from the times
    const start = startedAt ? Date.parse(startedAt) : NaN;
    const stop = endedAt ? Date.parse(endedAt) : lastPointAt ? Date.parse(lastPointAt) : NaN;
    durationS = Number.isFinite(start) && Number.isFinite(stop) ? Math.max(0, Math.round((stop - start) / 1000)) : 0;
  }
  return {
    id: num(r.id),
    sessionId: numOrNull(r.sessionId),
    employeeId: num(r.employeeId),
    employeeCode: str(r.employeeCode),
    employeeName: str(r.employeeName),
    department: strOrNull(r.department),
    branchName: strOrNull(r.branchName),
    destination: str(r.destination),
    startedAt,
    endedAt,
    endReason: endReason(r.endReason),
    status,
    state: trackState(r.state, status === "active" ? "waiting_first_fix" : "ended"),
    durationS,
    distanceM: num(r.distanceM),
    travelS: num(r.travelS),
    stopS: num(r.stopS),
    gapS: num(r.gapS),
    stopCount: num(r.stopCount),
    longestStopS: num(r.longestStopS),
    pointsCount: num(r.pointsCount),
    eventsCount: num(r.eventsCount),
    hasMock: typeof r.hasMock === "boolean" ? r.hasMock : mockPoints > 0,
    approvalStatus: str(r.approvalStatus),
    lastPointAt,
  };
}

export function readJourneyTrack(raw: unknown): JourneyTrack {
  const r = isObj(raw) ? raw : {};
  return {
    ...readJourneyItem(r),
    lastLatitude: numOrNull(r.lastLatitude),
    lastLongitude: numOrNull(r.lastLongitude),
    lastBatteryPct: numOrNull(r.lastBatteryPct),
    lastNetwork: strOrNull(r.lastNetwork),
    stateSince: timeOrNull(r.stateSince),
  };
}

export function readJourneyList(raw: unknown): JourneyListPage {
  const root = isObj(raw) ? raw : {};
  const results = list(raw, "results", "journeys", "items", "tracks", "data").map(readJourneyItem);
  return {
    results,
    page: num(root.page, 1),
    pageSize: num(root.pageSize, results.length || 25),
    total: num(root.total, results.length),
  };
}

function readSummary(raw: unknown, track: JourneyTrack): JourneySummary {
  const r = isObj(raw) ? raw : {};
  return {
    distanceM: num(r.distanceM, track.distanceM),
    travelS: num(r.travelS, track.travelS),
    stopS: num(r.stopS, track.stopS),
    gapS: num(r.gapS, track.gapS),
    stopCount: num(r.stopCount, track.stopCount),
    longestStopS: num(r.longestStopS, track.longestStopS),
    maxSpeedKmh: num(r.maxSpeedKmh),
    firstPointAt: timeOrNull(r.firstPointAt),
    summaryThrough: timeOrNull(r.summaryThrough),
    rebuiltAt: timeOrNull(r.rebuiltAt),
    flags: isObj(r.flags) ? r.flags : {},
  };
}

/** A polyline of [lat, lng] (or [lat, lng, t]) pairs: anything that is not a pair of finite numbers is dropped. */
function readPolyline(v: unknown): [number, number][] {
  return list(v).flatMap((p) => {
    if (!Array.isArray(p)) return [];
    const a = numOrNull(p[0]);
    const b = numOrNull(p[1]);
    return a !== null && b !== null ? [[a, b] as [number, number]] : [];
  });
}

function isMockSegment(meta: Json, direct: unknown): boolean {
  if (direct === true) return true;
  return (
    meta.mock === true ||
    meta.hasMock === true ||
    meta.isMock === true ||
    meta.isMocked === true ||
    num(meta.mockPoints) > 0 ||
    num(meta.mock_points) > 0
  );
}

export function readJourneySegment(raw: unknown, index = 0): JourneySegment {
  const r = isObj(raw) ? raw : {};
  const meta = isObj(r.meta) ? r.meta : {};
  const kind = SEGMENT_KINDS.includes(r.kind as SegmentKind) ? (r.kind as SegmentKind) : "travel";
  return {
    seqNo: num(first(r.seqNo, r.seq), index + 1),
    kind,
    startedAt: timeOrNull(r.startedAt),
    endedAt: timeOrNull(r.endedAt),
    durationS: num(r.durationS),
    distanceM: num(r.distanceM),
    startLat: lat(r, "startLat", "startLatitude"),
    startLng: lat(r, "startLng", "startLongitude"),
    endLat: lat(r, "endLat", "endLatitude"),
    endLng: lat(r, "endLng", "endLongitude"),
    centerLat: lat(r, "centerLat", "centerLatitude"),
    centerLng: lat(r, "centerLng", "centerLongitude"),
    radiusM: num(r.radiusM),
    pointCount: num(r.pointCount),
    avgSpeedKmh: num(r.avgSpeedKmh),
    maxSpeedKmh: num(r.maxSpeedKmh),
    polyline: readPolyline(r.polyline),
    address: str(r.address),
    cause: str(r.cause),
    estimated: r.estimated === true,
    eventId: numOrNull(first(r.eventId, r.event)),
    meta,
    mock: isMockSegment(meta, r.mock ?? r.isMock),
  };
}

export function readJourneyEvent(raw: unknown, index = 0): JourneyEvent {
  const r = isObj(raw) ? raw : {};
  return {
    id: num(r.id, -(index + 1)),
    kind: str(r.kind).toUpperCase(),
    source: str(r.source, "device"),
    startedAt: timeOrNull(r.startedAt),
    endedAt: timeOrNull(r.endedAt),
    latitude: numOrNull(r.latitude),
    longitude: numOrNull(r.longitude),
    meta: isObj(r.meta) ? r.meta : {},
  };
}

function readPathPoint(raw: unknown): JourneyPathPoint | null {
  if (Array.isArray(raw)) {
    const a = numOrNull(raw[0]);
    const b = numOrNull(raw[1]);
    return a !== null && b !== null ? { lat: a, lng: b, t: epochOrNull(raw[2]) } : null;
  }
  if (isObj(raw)) {
    const a = numOrNull(raw.latitude ?? raw.lat);
    const b = numOrNull(raw.longitude ?? raw.lng);
    return a !== null && b !== null ? { lat: a, lng: b, t: epochOrNull(raw.t ?? raw.recordedAt) } : null;
  }
  return null;
}

export function readJourneyDevice(raw: unknown): JourneyDevice | null {
  if (!isObj(raw)) return null;
  const device: JourneyDevice = {
    deviceId: str(raw.deviceId),
    platform: str(raw.platform),
    model: str(raw.model),
    osVersion: str(raw.osVersion),
    appVersion: str(raw.appVersion),
    permissionLevel: str(raw.permissionLevel, "unknown") || "unknown",
    locationEnabled: boolOrNull(raw.locationEnabled),
    backgroundRestricted: boolOrNull(raw.backgroundRestricted),
    batteryOptimised: boolOrNull(raw.batteryOptimised),
    powerSave: boolOrNull(raw.powerSave),
    lastSeenAt: timeOrNull(raw.lastSeenAt),
    lastBatteryPct: numOrNull(raw.lastBatteryPct),
    lastNetwork: strOrNull(raw.lastNetwork),
    lastHeartbeatAt: timeOrNull(raw.lastHeartbeatAt),
  };
  // an empty object (no device has reported yet) is "no device", not a card of blanks
  const informative = device.model || device.osVersion || device.appVersion || device.deviceId || device.lastSeenAt;
  return informative ? device : null;
}

export function readJourneyDetail(raw: unknown): JourneyDetail {
  const root = isObj(raw) ? raw : {};
  const track = readJourneyTrack(root.track);
  const startOf = (a: { startedAt: string | null }) => (a.startedAt ? Date.parse(a.startedAt) : 0);
  return {
    track,
    summary: readSummary(root.summary, track),
    segments: list(root.segments)
      .map((s, i) => readJourneySegment(s, i))
      .sort((a, b) => startOf(a) - startOf(b) || a.seqNo - b.seqNo),
    events: list(root.events)
      .map((e, i) => readJourneyEvent(e, i))
      .sort((a, b) => startOf(a) - startOf(b)),
    path: list(root.path)
      .map(readPathPoint)
      .filter((p): p is JourneyPathPoint => p !== null),
    device: readJourneyDevice(root.device),
  };
}

export function readJourneyPoints(raw: unknown): JourneyPointsPage {
  const root = isObj(raw) ? raw : {};
  const points = list(raw, "points", "results", "items").flatMap((p): JourneyRawPoint[] => {
    if (!isObj(p)) return [];
    const a = numOrNull(p.latitude);
    const b = numOrNull(p.longitude);
    if (a === null || b === null) return [];
    return [
      {
        id: num(p.id),
        recordedAt: timeOrNull(p.recordedAt),
        latitude: a,
        longitude: b,
        accuracyM: numOrNull(p.accuracyM),
        speedMps: numOrNull(p.speedMps),
        activity: str(p.activity, "unknown"),
        batteryPct: numOrNull(p.batteryPct),
        network: str(p.network, "unknown"),
        provider: str(p.provider, "unknown"),
        isMock: p.isMock === true,
      },
    ];
  });
  // the server sends `nextAfter` (null at the end of the points); another spelling, or none, continues from the last id
  const cursorKey = ["nextAfter", "next", "cursor"].find((key) => key in root);
  const lastId = points.length > 0 ? points[points.length - 1].id : null;
  return { points, next: cursorKey ? numOrNull(root[cursorKey]) : lastId };
}

function readTrailPoint(raw: unknown): TrailPoint | null {
  if (!isObj(raw)) return null;
  const t = epochOrNull(first(raw.t, raw.recordedAt));
  const la = numOrNull(first(raw.lat, raw.latitude));
  const ln = numOrNull(first(raw.lng, raw.longitude));
  if (t === null || la === null || ln === null) return null;
  return {
    t,
    lat: la,
    lng: ln,
    accuracyM: numOrNull(first(raw.acc, raw.accuracyM)),
    speedKmh: numOrNull(first(raw.spd, raw.speedKmh)),
    activity: str(first(raw.act, raw.activity), "unknown") || "unknown",
    batteryPct: numOrNull(first(raw.bat, raw.batteryPct)),
    network: str(first(raw.net, raw.network), "unknown") || "unknown",
    provider: str(first(raw.prov, raw.provider), "unknown") || "unknown",
    mock: first(raw.mock, raw.isMock) === true,
    used: raw.used !== false,
    stop: numOrNull(raw.stop),
  };
}

export function readJourneyTrail(raw: unknown): JourneyTrail {
  const root = isObj(raw) ? raw : {};
  const points = list(raw, "points", "results")
    .map(readTrailPoint)
    .filter((p): p is TrailPoint => p !== null)
    .sort((a, b) => a.t - b.t);
  return {
    trackId: num(root.trackId),
    source: root.source === "segments" ? "segments" : "points",
    total: num(root.total, points.length),
    count: points.length,
    truncated: root.truncated === true,
    points,
  };
}

export function readLiveTrack(raw: unknown): LiveTrack {
  const r = isObj(raw) ? raw : {};
  return {
    trackId: num(first(r.trackId, r.id)),
    sessionId: numOrNull(r.sessionId),
    employeeId: num(r.employeeId),
    employeeCode: str(r.employeeCode),
    employeeName: str(r.employeeName),
    department: strOrNull(r.department),
    branchName: strOrNull(r.branchName),
    destination: str(r.destination),
    state: trackState(r.state, "waiting_first_fix"),
    stateSince: timeOrNull(r.stateSince),
    latitude: numOrNull(r.latitude),
    longitude: numOrNull(r.longitude),
    accuracyM: numOrNull(r.accuracyM),
    lastPointAt: timeOrNull(r.lastPointAt),
    batteryPct: numOrNull(r.batteryPct),
    network: strOrNull(r.network),
    isMocked: r.isMocked === true,
    startedAt: timeOrNull(r.startedAt),
    approvalStatus: str(r.approvalStatus),
    stopCount: num(r.stopCount),
    distanceM: num(r.distanceM),
  };
}

export const readLiveTracks = (raw: unknown): LiveTrack[] =>
  list(raw, "results", "tracks", "items", "live", "data").map(readLiveTrack);

const REVERSE: GeoReverseProvider[] = ["off", "nominatim"];

/** "23:50:00" or "23:50" -> "23:50" (what a time field holds). */
export function hhmm(v: unknown, fallback = DEFAULT_GEO_SETTINGS.dayEndTime): string {
  const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})/.exec(v) : null;
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : fallback;
}

export function readGeoSettings(raw: unknown): GeoTrackingSettings {
  const root = isObj(raw) ? raw : {};
  const r = isObj(root.settings) ? root.settings : root;
  const d = DEFAULT_GEO_SETTINGS;
  const photos = num(
    first(r.ondutyPunchPhotos, r.onDutyPunchPhotos, r.punchPhotos, r.onduty_punch_photos),
    d.ondutyPunchPhotos,
  );
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    stopSeconds: num(r.stopSeconds, d.stopSeconds),
    stopRadiusM: num(r.stopRadiusM, d.stopRadiusM),
    stopAccuracyFactor: num(r.stopAccuracyFactor, d.stopAccuracyFactor),
    mergeStopGapSeconds: num(r.mergeStopGapSeconds, d.mergeStopGapSeconds),
    gapSeconds: num(r.gapSeconds, d.gapSeconds),
    signalLostSeconds: num(r.signalLostSeconds, d.signalLostSeconds),
    maxAccuracyM: num(r.maxAccuracyM, d.maxAccuracyM),
    maxSpeedKmh: num(r.maxSpeedKmh, d.maxSpeedKmh),
    sampleMovingSeconds: num(r.sampleMovingSeconds, d.sampleMovingSeconds),
    sampleStillSeconds: num(r.sampleStillSeconds, d.sampleStillSeconds),
    distanceFilterM: num(r.distanceFilterM, d.distanceFilterM),
    uploadBatchPoints: num(r.uploadBatchPoints, d.uploadBatchPoints),
    uploadIntervalSeconds: num(r.uploadIntervalSeconds, d.uploadIntervalSeconds),
    retentionDays: num(r.retentionDays, d.retentionDays),
    dayEndTime: hhmm(r.dayEndTime),
    ondutyPunchPhotos: photos >= 2 ? 2 : 1,
    noticeVersion: num(r.noticeVersion, d.noticeVersion),
    noticeText: str(r.noticeText),
    reverseGeocodeProvider: REVERSE.includes(r.reverseGeocodeProvider as GeoReverseProvider)
      ? (r.reverseGeocodeProvider as GeoReverseProvider)
      : "off",
    updatedBy: strOrNull(r.updatedBy),
    updatedAt: timeOrNull(r.updatedAt),
  };
}

/** True when the server refused because the person may not see or change this (a role without the Geo Attendance module). */
export const isTrackingForbidden = (err: unknown): boolean => err instanceof ApiError && err.status === 403;
export const isTrackingNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

/** The sentence the server gave for a refused request ("Stop minutes must be between 1 and 60."), else `fallback`. */
export function trackingErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const data = err.data;
    if (isObj(data)) {
      const sentence = first(data.error, data.message, data.detail);
      if (typeof sentence === "string" && sentence.trim() !== "") return sentence.trim();
    }
    if (err.status === 403)
      return "Your role does not allow this. Ask an administrator for the Geo Attendance permission.";
    if (err.status === 404) return "That journey was not found (or it belongs to another branch).";
    return fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

// ── hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `?a=1&b=2` from the parameters that have a value. */
export function toQuery(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

export const journeyListQuery = (p: JourneyListParams): string =>
  toQuery({
    employeeId: p.employeeId ?? undefined,
    from: p.from,
    to: p.to,
    status: p.status,
    endReason: p.endReason,
    page: p.page,
    pageSize: p.pageSize,
  });

/** The list of journeys, newest first. Refreshed every 30 s (a live journey's distance grows). */
export const useJourneys = (params: JourneyListParams, enabled = true) =>
  useQuery<JourneyListPage>({
    queryKey: getJourneysQueryKey(params),
    queryFn: async () => readJourneyList(await customFetch<unknown>(`${PATH}/journeys${journeyListQuery(params)}`)),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    retry: false,
    enabled,
  });

/** An active journey is read again every 30 s; one that has ended never changes by itself. */
export const journeyRefetchInterval = (data: JourneyDetail | undefined): number | false =>
  data?.track.status === "active" ? 30_000 : false;

export const useJourney = (id: number | null) =>
  useQuery<JourneyDetail>({
    queryKey: getJourneyQueryKey(id ?? 0),
    queryFn: async () => readJourneyDetail(await customFetch<unknown>(`${PATH}/journeys/${id}`)),
    enabled: id !== null,
    refetchInterval: (query) => journeyRefetchInterval(query.state.data),
    retry: false,
  });

/** The raw points of a journey, `limit` at a time after the point id `after` (0 = from the start). */
export const useJourneyPoints = (id: number | null, after = 0, limit = 500, enabled = true) =>
  useQuery<JourneyPointsPage>({
    queryKey: getJourneyPointsQueryKey(id ?? 0, after, limit),
    queryFn: async () =>
      readJourneyPoints(await customFetch<unknown>(`${PATH}/journeys/${id}/points${toQuery({ after, limit })}`)),
    enabled: enabled && id !== null,
    retry: false,
  });

/** Every stored position of a journey, for the map. An active journey is read again every 30 s, like its detail. */
export const useJourneyTrail = (id: number | null, enabled = true, live = false) =>
  useQuery<JourneyTrail>({
    queryKey: getJourneyTrailQueryKey(id ?? 0),
    queryFn: async () => readJourneyTrail(await customFetch<unknown>(`${PATH}/journeys/${id}/trail`)),
    enabled: enabled && id !== null,
    refetchInterval: live ? 30_000 : false,
    retry: false,
  });

/** Recomputes the stops, gaps and totals of one journey from its raw data (nothing raw is changed). */
export const useRebuildJourney = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const answer = await customFetch<unknown>(`${PATH}/journeys/${id}/rebuild`, { method: "POST", body: "{}" });
      return { id, detail: isObj(answer) && isObj(answer.track) ? readJourneyDetail(answer) : null };
    },
    onSuccess: ({ id, detail }) => {
      if (detail) queryClient.setQueryData(getJourneyQueryKey(id), detail);
      void queryClient.invalidateQueries({ queryKey: getJourneysRootKey() });
      void queryClient.invalidateQueries({ queryKey: getLiveTracksQueryKey() });
    },
  });
};

/** Every active track, for the live board. Refreshed every 20 s. */
export const useLiveTracks = (enabled = true) =>
  useQuery<LiveTrack[]>({
    queryKey: getLiveTracksQueryKey(),
    queryFn: async () => readLiveTracks(await customFetch<unknown>(`${PATH}/live`)),
    refetchInterval: 20_000,
    retry: false,
    enabled,
  });

export const useGeoTrackingSettings = (enabled = true) =>
  useQuery<GeoTrackingSettings>({
    queryKey: getGeoSettingsQueryKey(),
    queryFn: async () => readGeoSettings(await customFetch<unknown>(`${PATH}/settings`)),
    retry: false,
    enabled,
  });

/** A partial save: only what is sent changes. The answer is the whole object as it now is. */
export const useUpdateGeoTrackingSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: GeoTrackingSettingsPatch) =>
      readGeoSettings(await customFetch<unknown>(`${PATH}/settings`, { method: "PUT", body: JSON.stringify(patch) })),
    onSuccess: (saved) => {
      queryClient.setQueryData(getGeoSettingsQueryKey(), saved);
      // the rules change what the board and the next rebuild say
      void queryClient.invalidateQueries({ queryKey: getLiveTracksQueryKey() });
    },
  });
};

/** The file name a download response asks for (Content-Disposition), or null. */
export function fileNameOf(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

/**
 * Downloads the workbook of one journey (summary, segments, events sheets) with the person's own token, as a real "Save as".
 * The server sends .xlsx, or .csv when it has no spreadsheet library: the saved name follows what it sent. Returns the name.
 */
export async function downloadJourneyExport(
  id: number,
  getToken: () => string | null,
  baseName: string,
  format: "xlsx" | "csv" = "xlsx",
): Promise<string> {
  const token = getToken();
  const response = await fetch(`${getApiOrigin()}${PATH}/journeys/${id}/export?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      (isObj(body) && typeof body.error === "string" && body.error) || `Export failed (${response.status})`,
    );
  }
  const blob = await response.blob();
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const name =
    fileNameOf(response.headers.get("content-disposition")) ?? `${baseName}.${type.includes("csv") ? "csv" : format}`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
  return name;
}
