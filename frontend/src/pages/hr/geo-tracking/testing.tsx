import type { Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";

// Shared by the render tests of Journey History, the Live Map, the tracking rules and the punch photos: the DOM helpers the other
// render tests of the repository use (re-exported from the Endpoint Sharing tests), and a small copy of the server behind
// `customFetch` that answers with the shapes of the API contract (GET /api/tracking/...), so the pages are tested end to end
// without a backend. (The `vi.mock` calls stay in each test file: vitest only hoists them there.)
export {
  all,
  buttonNamed,
  choose,
  click,
  clickId,
  css,
  here,
  installBrowserStubs,
  mount,
  must,
  press,
  q,
  settle,
  text,
  typeAt,
  typeInto,
  unmount,
  waitFor,
} from "../settings/endpoint-sharing/testing";

export type Call = { method: string; url: string; body: Record<string, unknown> };

export const apiError = (status: number, body: unknown = null): ApiError =>
  new ApiError(new Response(null, { status, statusText: String(status) }), body, { method: "GET", url: "/x" });

export const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── fixtures: what the server sends ────────────────────────────────────────────────────────────────────────────────

const at = (hhmm: string, day = "2026-10-28") => `${day}T${hhmm}:00+05:30`;
export const IST = at;

export type Raw = Record<string, unknown>;

/** One row of the journey list. */
export function listItem(id: number, over: Raw = {}): Raw {
  return {
    id,
    sessionId: 100 + id,
    employeeId: 10 + id,
    employeeCode: `E2E00${id}`,
    employeeName: `Employee ${id}`,
    department: "Stitching",
    branchName: "E2E Head Office",
    destination: `Buyer ${id}`,
    startedAt: at("09:00"),
    endedAt: at("17:40"),
    endReason: "manual",
    status: "ended",
    state: "ended",
    durationS: 31200,
    distanceM: 14250,
    travelS: 11400,
    stopS: 3600,
    gapS: 900,
    stopCount: 2,
    longestStopS: 1500,
    pointsCount: 482,
    eventsCount: 5,
    hasMock: false,
    approvalStatus: "pending_hr",
    lastPointAt: at("17:39"),
    ...over,
  };
}

/** The route trail of a journey as GET /api/tracking/journeys/<id>/trail sends it: a position every 4 minutes along the two
 * stretches of travel, positions inside the two stationary periods (stop = the segment's seqNo) and one the pipeline set aside.
 * 29 positions, 28 of them used; the lines of the map are 4 runs: travel, stop 1, stop 2, travel. */
export function trailFixture(id = 7, over: Raw = {}): Raw {
  const clock = (minutes: number) =>
    at(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  const p = (minutes: number, lat: number, lng: number, extra: Raw = {}) => ({
    t: Date.parse(clock(minutes)),
    lat,
    lng,
    acc: 12,
    spd: 28,
    act: "vehicle",
    bat: 64,
    net: "cell",
    prov: "fused",
    mock: false,
    used: true,
    stop: null,
    ...extra,
  });
  const still = { spd: 0, act: "still" };
  const ramp = (from: number, to: number, a: [number, number], b: [number, number]) => {
    const steps = Math.round((to - from) / 4);
    return Array.from({ length: steps + 1 }, (_, i) => {
      const f = i / steps;
      return p(from + i * 4, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
    });
  };
  const points = [
    ...ramp(545, 569, [11.0, 77.0], [11.019, 77.019]), // 09:05 - 09:29, 7 positions
    p(570, 11.02, 77.02, { ...still, stop: 2 }),
    p(573, 11.0201, 77.0201, { ...still, stop: 2 }),
    p(577, 11.0199, 77.0199, { ...still, stop: 2 }),
    p(580, 11.025, 77.025, { used: false, acc: 180 }),
    ...Array.from({ length: 7 }, (_, i) => p(625 + i * 4, 11.04 + i * 0.0001, 77.04, { ...still, stop: 4, acc: 30 })),
    ...ramp(650, 690, [11.0401, 77.0401], [11.06, 77.06]), // 10:50 - 11:30, 11 positions
  ];
  return {
    trackId: id,
    source: "points",
    total: points.length,
    count: points.length,
    truncated: false,
    points,
    ...over,
  };
}

/** One journey as the detail endpoint sends it: stops, a gap, an estimated stretch, events, a path and the phone. */
export function detailFixture(
  id = 7,
  over: { track?: Raw; summary?: Raw; segments?: Raw[]; events?: Raw[]; device?: Raw | null } = {},
): Raw {
  const track = {
    ...listItem(id, { employeeName: "Asha Kumar", employeeCode: "E2E001", destination: "Tirupur buyer visit" }),
    lastLatitude: 11.06,
    lastLongitude: 77.06,
    lastBatteryPct: 64,
    lastNetwork: "cell",
    ...over.track,
  };
  const segments = over.segments ?? [
    {
      seqNo: 1,
      kind: "travel",
      startedAt: at("09:05"),
      endedAt: at("09:30"),
      durationS: 1500,
      distanceM: 3200,
      startLat: 11.0,
      startLng: 77.0,
      endLat: 11.02,
      endLng: 77.02,
      polyline: [
        [11.0, 77.0],
        [11.01, 77.01],
        [11.02, 77.02],
      ],
      avgSpeedKmh: 28,
      estimated: false,
    },
    {
      seqNo: 2,
      kind: "stop",
      startedAt: at("09:30"),
      endedAt: at("09:38"),
      durationS: 480,
      centerLat: 11.02,
      centerLng: 77.02,
      radiusM: 40,
      address: "",
    },
    {
      seqNo: 3,
      kind: "gap",
      startedAt: at("10:10"),
      endedAt: at("10:25"),
      durationS: 900,
      startLat: 11.03,
      startLng: 77.03,
      endLat: 11.035,
      endLng: 77.035,
      cause: "gps_off",
      eventId: 2,
    },
    {
      seqNo: 4,
      kind: "stop",
      startedAt: at("10:25"),
      endedAt: at("10:50"),
      durationS: 1500,
      centerLat: 11.04,
      centerLng: 77.04,
      radiusM: 60,
      address: "Buyer office, Avinashi Road",
    },
    {
      seqNo: 5,
      kind: "travel",
      startedAt: at("10:50"),
      endedAt: at("11:30"),
      durationS: 2400,
      distanceM: 5200,
      startLat: 11.04,
      startLng: 77.04,
      endLat: 11.06,
      endLng: 77.06,
      polyline: [
        [11.04, 77.04],
        [11.06, 77.06],
      ],
      avgSpeedKmh: 31,
      estimated: true,
    },
  ];
  const events = over.events ?? [
    {
      id: 1,
      kind: "TRACKING_STARTED",
      source: "server",
      startedAt: at("09:00"),
      endedAt: null,
      latitude: null,
      longitude: null,
      meta: {},
    },
    {
      id: 2,
      kind: "GPS_OFF",
      source: "device",
      startedAt: at("10:10"),
      endedAt: at("10:25"),
      latitude: 11.03,
      longitude: 77.03,
      meta: {},
    },
    {
      id: 3,
      kind: "NETWORK_LOST",
      source: "device",
      startedAt: at("11:00"),
      endedAt: at("11:05"),
      latitude: 11.05,
      longitude: 77.05,
      meta: {},
    },
    {
      id: 4,
      kind: "PERMISSION_CHANGED",
      source: "device",
      startedAt: at("11:10"),
      endedAt: at("11:10"),
      latitude: 11.055,
      longitude: 77.055,
      meta: { from: "always", to: "while_using" },
    },
    {
      id: 5,
      kind: "TRACKING_STOPPED",
      source: "server",
      startedAt: at("17:40"),
      endedAt: null,
      latitude: null,
      longitude: null,
      meta: {},
    },
  ];
  return {
    track,
    summary: {
      distanceM: 14250,
      travelS: 11400,
      stopS: 3600,
      gapS: 900,
      stopCount: 2,
      longestStopS: 1500,
      maxSpeedKmh: 62,
      firstPointAt: at("09:05"),
      summaryThrough: at("17:39"),
      rebuiltAt: at("17:41"),
      flags: {},
      ...over.summary,
    },
    segments,
    events,
    path: [
      [11.0, 77.0, Date.parse(at("09:05"))],
      [11.02, 77.02, Date.parse(at("09:30"))],
      [11.06, 77.06, Date.parse(at("11:30"))],
    ],
    device:
      over.device === undefined
        ? {
            deviceId: "dev-1",
            platform: "android",
            model: "Samsung SM-A346E",
            osVersion: "14",
            appVersion: "2.4.0",
            permissionLevel: "always",
            locationEnabled: true,
            backgroundRestricted: false,
            batteryOptimised: true,
            powerSave: false,
            lastSeenAt: at("17:39"),
            lastBatteryPct: 64,
            lastNetwork: "cell",
            lastHeartbeatAt: at("17:39"),
          }
        : over.device,
  };
}

export function liveRow(trackId: number, over: Raw = {}): Raw {
  return {
    trackId,
    sessionId: 100 + trackId,
    employeeId: 10 + trackId,
    employeeCode: `E2E00${trackId}`,
    employeeName: `Employee ${trackId}`,
    department: "Stitching",
    branchName: "E2E Head Office",
    destination: `Buyer ${trackId}`,
    state: "moving",
    stateSince: at("09:10"),
    latitude: 11.0 + trackId / 100,
    longitude: 77.0 + trackId / 100,
    accuracyM: 12,
    lastPointAt: new Date(Date.now() - 2 * 60000).toISOString(),
    batteryPct: 71,
    network: "wifi",
    isMocked: false,
    startedAt: at("09:00"),
    approvalStatus: "pending_hod",
    stopCount: 1,
    distanceM: 2400,
    ...over,
  };
}

export const SETTINGS_RAW: Raw = {
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
  dayEndTime: "23:50:00",
  ondutyPunchPhotos: 1,
  noticeVersion: 3,
  noticeText: "UKTextiles records your route while an On-Duty request is open.",
  reverseGeocodeProvider: "off",
  updatedBy: "Asha Admin",
  updatedAt: at("08:00", "2026-10-20"),
};

export const EMPLOYEES = [
  {
    id: 11,
    employeeCode: "E2E001",
    firstName: "Asha",
    lastName: "Kumar",
    departmentName: "Stitching",
    status: "active",
  },
  { id: 12, employeeCode: "E2E002", firstName: "Ravi", lastName: "Nair", departmentName: "Cutting", status: "active" },
];

export type World = {
  journeys: Raw[];
  details: Record<number, Raw>;
  /** The route trail of a journey (no entry = the endpoint answers 404). */
  trails: Record<number, Raw>;
  live: Raw[];
  settings: Raw;
  /** Old live feed (employees HR switched live tracking on for). */
  team: Raw[];
  verifications: Raw[];
  requests: string[];
  writes: Call[];
  unexpected: string[];
  /** Paths (without the query) that fail with this status and body. */
  failing: Map<string, { status: number; body?: unknown }>;
};

export function newWorld(): World {
  return {
    journeys: [
      listItem(7, {
        employeeName: "Asha Kumar",
        employeeCode: "E2E001",
        employeeId: 11,
        destination: "Tirupur buyer visit",
      }),
      listItem(8, {
        employeeName: "Ravi Nair",
        employeeCode: "E2E002",
        employeeId: 12,
        destination: "Erode mill",
        status: "active",
        state: "moving",
        endedAt: null,
        endReason: "",
        approvalStatus: "pending_hod",
        hasMock: true,
        startedAt: at("09:30"),
      }),
      listItem(9, {
        employeeName: "Meena Devi",
        employeeCode: "E2E003",
        employeeId: 13,
        destination: "Salem dye house",
        endReason: "rejected",
        approvalStatus: "rejected",
        startedAt: at("08:00", "2026-10-27"),
        endedAt: at("12:00", "2026-10-27"),
      }),
    ],
    details: {
      7: detailFixture(7),
      8: detailFixture(8, {
        track: {
          status: "active",
          state: "moving",
          endedAt: null,
          endReason: "",
          employeeName: "Ravi Nair",
          hasMock: true,
        },
      }),
    },
    trails: { 7: trailFixture(7), 8: trailFixture(8) },
    live: [],
    settings: copy(SETTINGS_RAW),
    team: [],
    verifications: [],
    requests: [],
    writes: [],
    unexpected: [],
    failing: new Map(),
  };
}

const istDay = (iso: unknown) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(String(iso)));

/** Wires the fake server into the mocked `customFetch`. */
export function installWorld(fetchMock: Mock, world: World = newWorld()): World {
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = (options?.method ?? "GET").toUpperCase();
    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    const body = options?.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {};
    world.requests.push(`${method} ${url}`);
    if (method !== "GET") world.writes.push({ method, url, body });
    const failing = world.failing.get(path);
    if (failing) throw apiError(failing.status, failing.body ?? { error: "failed" });

    if (method === "GET" && path === "/api/tracking/journeys") {
      let rows = world.journeys.filter((j) => {
        if (params.get("employeeId") && String(j.employeeId) !== params.get("employeeId")) return false;
        if (params.get("status") && j.status !== params.get("status")) return false;
        if (params.get("endReason") && j.endReason !== params.get("endReason")) return false;
        const day = istDay(j.startedAt);
        if (params.get("from") && day < params.get("from")!) return false;
        if (params.get("to") && day > params.get("to")!) return false;
        return true;
      });
      const pageSize = Number(params.get("pageSize") ?? 25);
      const page = Number(params.get("page") ?? 1);
      const total = rows.length;
      rows = rows.slice((page - 1) * pageSize, page * pageSize);
      return { results: copy(rows), page, pageSize, total };
    }
    const one = /^\/api\/tracking\/journeys\/(\d+)$/.exec(path);
    if (method === "GET" && one) {
      const detail = world.details[Number(one[1])];
      if (!detail) throw apiError(404, { error: "Journey not found" });
      return copy(detail);
    }
    const trail = /^\/api\/tracking\/journeys\/(\d+)\/trail$/.exec(path);
    if (method === "GET" && trail) {
      const found = world.trails[Number(trail[1])];
      if (!found) throw apiError(404, { error: "Journey not found" });
      return copy(found);
    }
    const rebuild = /^\/api\/tracking\/journeys\/(\d+)\/rebuild$/.exec(path);
    if (method === "POST" && rebuild) return { ok: true };
    if (method === "GET" && path === "/api/tracking/live") return copy(world.live);
    if (method === "GET" && path === "/api/tracking/settings") return copy(world.settings);
    if (method === "PUT" && path === "/api/tracking/settings") {
      world.settings = { ...world.settings, ...body, updatedBy: "Asha Admin", updatedAt: at("10:00") };
      return copy(world.settings);
    }
    if (method === "GET" && path === "/api/live-location/team") return copy(world.team);
    if (method === "GET" && path === "/api/employees") return copy(EMPLOYEES);
    if (method === "GET" && path === "/api/branches") return [];
    if (method === "GET" && path === "/api/on-duty-sessions") return [];
    if (method === "GET" && path === "/api/approval-summary") return {};
    if (method === "GET" && path === "/api/on-duty-punch-verifications") return copy(world.verifications);
    world.unexpected.push(`${method} ${url}`);
    throw apiError(404, { error: `unexpected request ${method} ${url}` });
  });
  return world;
}
