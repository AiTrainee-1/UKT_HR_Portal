import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, customFetch } from "../custom-fetch";
import {
  DEFAULT_GEO_SETTINGS,
  downloadJourneyExport,
  fileNameOf,
  getJourneyQueryKey,
  getJourneysRootKey,
  getGeoSettingsQueryKey,
  getLiveTracksQueryKey,
  hhmm,
  isTrackingForbidden,
  isTrackingNotFound,
  journeyListQuery,
  journeyRefetchInterval,
  readGeoSettings,
  readJourneyDetail,
  readJourneyDevice,
  readJourneyList,
  readJourneyPoints,
  readLiveTracks,
  toQuery,
  trackingErrorMessage,
  useRebuildJourney,
  useUpdateGeoTrackingSettings,
} from "./geo-tracking";

vi.mock("../custom-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../custom-fetch")>()),
  customFetch: vi.fn(),
}));

// The readers and hooks of the On-Duty Geo-Tracking API (HR side): the shapes of the contract, tolerance for a small difference
// in them (a bare array, a time as epoch milliseconds, a Decimal as text, a missing field), the query strings, the refresh
// policy, the error sentences and the workbook download.

const api = (status: number, body: unknown) =>
  new ApiError(new Response(null, { status, statusText: String(status) }), body, { method: "GET", url: "/x" });

describe("readJourneyList", () => {
  it("reads the page of the contract: rows, page, pageSize, total", () => {
    const page = readJourneyList({
      results: [
        {
          id: 7,
          sessionId: 107,
          employeeId: 11,
          employeeCode: "E1",
          employeeName: "Asha",
          department: "Stitching",
          branchName: null,
          destination: "Buyer",
          startedAt: "2026-10-28T09:00:00+05:30",
          endedAt: null,
          endReason: "",
          status: "active",
          state: "moving",
          durationS: 600,
          distanceM: 1200.5,
          travelS: 500,
          stopS: 100,
          gapS: 0,
          stopCount: 1,
          longestStopS: 100,
          pointsCount: 40,
          eventsCount: 2,
          hasMock: true,
          approvalStatus: "pending_hod",
          lastPointAt: "2026-10-28T09:10:00+05:30",
        },
      ],
      page: 2,
      pageSize: 10,
      total: 31,
    });
    expect(page).toMatchObject({ page: 2, pageSize: 10, total: 31 });
    expect(page.results[0]).toMatchObject({
      id: 7,
      employeeName: "Asha",
      branchName: null,
      status: "active",
      state: "moving",
      distanceM: 1200.5,
      hasMock: true,
      approvalStatus: "pending_hod",
      endReason: "",
    });
  });

  it("survives a bare array, missing fields, a Decimal as text and an unknown state or reason", () => {
    const page = readJourneyList([
      { id: 1, status: "active", state: "weird", distanceM: "2500.25", endReason: "mystery", mockPoints: 3 },
      { id: 2 },
    ]);
    expect(page).toMatchObject({ page: 1, total: 2 });
    expect(page.results[0]).toMatchObject({
      status: "active",
      state: "waiting_first_fix", // an unknown state of an active track
      distanceM: 2500.25,
      endReason: "",
      hasMock: true, // from a mock point counter when the flag is not sent
    });
    expect(page.results[1]).toMatchObject({
      status: "ended",
      state: "ended",
      employeeName: "",
      stopCount: 0,
      hasMock: false,
    });
    expect(readJourneyList(null)).toEqual({ results: [], page: 1, pageSize: 25, total: 0 });
  });

  it("measures a duration the server did not send from the times", () => {
    const [ended, live] = readJourneyList([
      { id: 1, startedAt: "2026-10-28T09:00:00+05:30", endedAt: "2026-10-28T10:30:00+05:30" },
      { id: 2, startedAt: "2026-10-28T09:00:00+05:30", lastPointAt: "2026-10-28T09:20:00+05:30", status: "active" },
    ]).results;
    expect(ended.durationS).toBe(5400);
    expect(live.durationS).toBe(1200);
  });
});

describe("readJourneyDetail", () => {
  const raw = {
    track: {
      id: 7,
      employeeName: "Asha",
      status: "ended",
      lastLatitude: "11.06",
      lastLongitude: 77.06,
      lastBatteryPct: 64,
      distanceM: 900,
    },
    summary: { stopCount: 2, maxSpeedKmh: 62, firstPointAt: "2026-10-28T09:05:00+05:30", flags: { x: 1 } },
    segments: [
      {
        seqNo: 2,
        kind: "stop",
        startedAt: "2026-10-28T09:30:00+05:30",
        centerLat: "11.02",
        centerLng: "77.02",
        radiusM: 40,
      },
      {
        seqNo: 1,
        kind: "travel",
        startedAt: "2026-10-28T09:05:00+05:30",
        polyline: [[11, 77], [11.01, 77.01, 1234], ["x", 1], "bad", [11.02]],
        meta: { mock_points: 2 },
        event: 5,
      },
    ],
    events: [
      { id: 9, kind: "network_lost", startedAt: "2026-10-28T11:00:00+05:30", latitude: 11.05, longitude: 77.05 },
      { id: 3, kind: "GPS_OFF", startedAt: "2026-10-28T10:00:00+05:30" },
    ],
    path: [
      [11, 77, 1_788_000_000_000],
      [11.1, 77.1, 1_788_000_060],
      [11.2, 77.2, "2026-10-28T09:05:00+05:30"],
      ["no"],
      null,
    ],
    device: { model: "SM-A34", permissionLevel: "always", locationEnabled: true },
  };
  const detail = readJourneyDetail(raw);

  it("sorts segments and events by time and reads a Decimal position given as text", () => {
    expect(detail.segments.map((s) => s.seqNo)).toEqual([1, 2]);
    expect(detail.events.map((e) => e.id)).toEqual([3, 9]);
    expect(detail.events[1].kind).toBe("NETWORK_LOST"); // kinds are upper-cased
    expect(detail.segments[1]).toMatchObject({ centerLat: 11.02, centerLng: 77.02 });
    expect(detail.track).toMatchObject({ lastLatitude: 11.06, lastLongitude: 77.06, lastBatteryPct: 64 });
  });

  it("keeps only valid [lat, lng] pairs of a polyline and flags a segment that carries simulated points", () => {
    expect(detail.segments[0].polyline).toEqual([
      [11, 77],
      [11.01, 77.01],
    ]);
    expect(detail.segments[0].mock).toBe(true);
    expect(detail.segments[0].eventId).toBe(5);
    expect(detail.segments[1].mock).toBe(false);
  });

  it("takes the summary figures it is given and the track's own for the rest", () => {
    expect(detail.summary).toMatchObject({ stopCount: 2, maxSpeedKmh: 62, distanceM: 900, flags: { x: 1 } });
  });

  it("reads path times as epoch milliseconds whatever the server sent (ms, seconds or ISO) and drops what is not a point", () => {
    expect(detail.path).toHaveLength(3);
    expect(detail.path[0].t).toBe(1_788_000_000_000);
    expect(detail.path[1].t).toBe(1_788_000_060_000);
    expect(detail.path[2].t).toBe(Date.parse("2026-10-28T09:05:00+05:30"));
  });

  it("reads the device, and no device when none has reported", () => {
    expect(detail.device).toMatchObject({
      model: "SM-A34",
      permissionLevel: "always",
      locationEnabled: true,
      batteryOptimised: null,
    });
    expect(readJourneyDevice({})).toBeNull();
    expect(readJourneyDevice(null)).toBeNull();
    expect(readJourneyDevice({ appVersion: "2.0" })).toMatchObject({ permissionLevel: "unknown", appVersion: "2.0" });
  });

  it("does not fail on an answer without parts", () => {
    const empty = readJourneyDetail({});
    expect(empty).toMatchObject({ segments: [], events: [], path: [], device: null });
    expect(empty.track.status).toBe("ended");
  });
});

describe("readJourneyPoints", () => {
  it("reads raw points as the server sends them (results, nextAfter)", () => {
    const page = readJourneyPoints({
      results: [
        { id: 1, recordedAt: "2026-10-28T09:00:00+05:30", latitude: 11, longitude: 77, accuracyM: 8, isMock: true },
        { id: 2, latitude: "x", longitude: 77 },
        { id: 3, latitude: 11.1, longitude: 77.1, activity: "vehicle", speedMps: 4.5 },
      ],
      nextAfter: 3,
      limit: 3,
    });
    expect(page.points.map((p) => p.id)).toEqual([1, 3]);
    expect(page.points[0]).toMatchObject({ accuracyM: 8, isMock: true, activity: "unknown" });
    expect(page.points[1]).toMatchObject({ activity: "vehicle", speedMps: 4.5 });
    expect(page.next).toBe(3);
  });

  it("ends the cursor when the server says there is nothing more, and continues from the last id when it sends no cursor", () => {
    expect(readJourneyPoints({ results: [{ id: 9, latitude: 1, longitude: 2 }], nextAfter: null }).next).toBeNull();
    expect(readJourneyPoints({ points: [{ id: 9, latitude: 1, longitude: 2 }] }).next).toBe(9);
    expect(readJourneyPoints({ results: [], next: 99 }).next).toBe(99);
    expect(readJourneyPoints({ results: [] }).next).toBeNull();
  });
});

describe("readLiveTracks", () => {
  it("reads the board of the contract, a wrapped one, and an unknown state as waiting for the first fix", () => {
    const rows = readLiveTracks({
      tracks: [
        {
          trackId: 8,
          employeeName: "Ravi",
          state: "location_off",
          latitude: 11.2,
          longitude: 77.2,
          batteryPct: 40,
          network: "none",
          isMocked: true,
          approvalStatus: "pending_hr",
          stopCount: 3,
          distanceM: 5000,
        },
        { trackId: 9, state: "???" },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      trackId: 8,
      state: "location_off",
      batteryPct: 40,
      network: "none",
      isMocked: true,
      stopCount: 3,
    });
    expect(rows[1]).toMatchObject({ state: "waiting_first_fix", latitude: null, batteryPct: null });
    expect(readLiveTracks([{ id: 5 }])[0].trackId).toBe(5);
    expect(readLiveTracks(null)).toEqual([]);
  });
});

describe("readGeoSettings", () => {
  it("reads the rules of the contract and a time with seconds as HH:MM", () => {
    const s = readGeoSettings({
      enabled: false,
      stopSeconds: 240,
      dayEndTime: "23:45:00",
      ondutyPunchPhotos: 2,
      noticeVersion: 4,
      noticeText: "Hello",
      reverseGeocodeProvider: "nominatim",
      updatedBy: "Asha",
      updatedAt: "2026-10-20T08:00:00+05:30",
    });
    expect(s).toMatchObject({
      enabled: false,
      stopSeconds: 240,
      dayEndTime: "23:45",
      ondutyPunchPhotos: 2,
      noticeVersion: 4,
      noticeText: "Hello",
      reverseGeocodeProvider: "nominatim",
      updatedBy: "Asha",
      stopRadiusM: 50, // not sent: the server's default
    });
  });

  it("falls back to the defaults of the spec for an empty answer, a wrapper, or an unknown geocoder", () => {
    expect(readGeoSettings({})).toEqual(DEFAULT_GEO_SETTINGS);
    expect(readGeoSettings({ settings: { stopSeconds: 90 } }).stopSeconds).toBe(90);
    expect(readGeoSettings({ reverseGeocodeProvider: "google" }).reverseGeocodeProvider).toBe("off");
    expect(DEFAULT_GEO_SETTINGS).toMatchObject({
      dayEndTime: "23:50",
      ondutyPunchPhotos: 1,
      retentionDays: 365,
      stopSeconds: 180,
    });
  });

  it("accepts the photo rule under the other spellings and reads anything above 1 as 2", () => {
    expect(readGeoSettings({ onDutyPunchPhotos: 2 }).ondutyPunchPhotos).toBe(2);
    expect(readGeoSettings({ punchPhotos: "2" }).ondutyPunchPhotos).toBe(2);
    expect(readGeoSettings({ ondutyPunchPhotos: 0 }).ondutyPunchPhotos).toBe(1);
  });

  it("normalises a time of day", () => {
    expect(hhmm("23:50:00")).toBe("23:50");
    expect(hhmm("7:05")).toBe("07:05");
    expect(hhmm("nope")).toBe("23:50");
    expect(hhmm(null, "00:00")).toBe("00:00");
  });
});

describe("query strings", () => {
  it("sends only the parameters that have a value", () => {
    expect(toQuery({ a: 1, b: "", c: null, d: undefined, e: "x y" })).toBe("?a=1&e=x+y");
    expect(toQuery({})).toBe("");
    expect(
      journeyListQuery({
        employeeId: 11,
        from: "2026-10-01",
        to: "2026-10-28",
        status: "active",
        endReason: "",
        page: 2,
        pageSize: 25,
      }),
    ).toBe("?employeeId=11&from=2026-10-01&to=2026-10-28&status=active&page=2&pageSize=25");
    expect(journeyListQuery({ employeeId: null, status: "" })).toBe("");
  });
});

describe("refresh policy", () => {
  it("re-reads an active journey every 30 seconds and an ended one never", () => {
    expect(journeyRefetchInterval(readJourneyDetail({ track: { status: "active" } }))).toBe(30_000);
    expect(journeyRefetchInterval(readJourneyDetail({ track: { status: "ended" } }))).toBe(false);
    expect(journeyRefetchInterval(undefined)).toBe(false);
  });
});

describe("error sentences", () => {
  it("shows the sentence the server gave, else a words-only fallback for 403 and 404, else the given one", () => {
    expect(trackingErrorMessage(api(400, { error: "Stop time must be between 1 and 60 minutes." }), "x")).toBe(
      "Stop time must be between 1 and 60 minutes.",
    );
    expect(trackingErrorMessage(api(400, { message: " Bad value " }), "x")).toBe("Bad value");
    expect(trackingErrorMessage(api(403, {}), "x")).toMatch(/Geo Attendance permission/);
    expect(trackingErrorMessage(api(404, null), "x")).toMatch(/not found/);
    expect(trackingErrorMessage(api(500, null), "Could not save.")).toBe("Could not save.");
    expect(trackingErrorMessage(new Error("offline"), "x")).toBe("offline");
    expect(trackingErrorMessage("weird", "fallback")).toBe("fallback");
    expect(isTrackingForbidden(api(403, null))).toBe(true);
    expect(isTrackingForbidden(api(404, null))).toBe(false);
    expect(isTrackingNotFound(api(404, null))).toBe(true);
  });
});

describe("the workbook download", () => {
  const realFetch = globalThis.fetch;
  let clicked: { name: string; href: string }[];

  beforeEach(() => {
    clicked = [];
    URL.createObjectURL = vi.fn(() => "blob:journey");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.href });
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("fetches with the person's own token and saves under the name the server gave", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(["xlsx"]), {
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": 'attachment; filename="journey-E2E001-2026-10-28.xlsx"',
          },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const name = await downloadJourneyExport(7, () => "tok123", "fallback");
    expect(name).toBe("journey-E2E001-2026-10-28.xlsx");
    expect(fetchMock).toHaveBeenCalledWith("/api/tracking/journeys/7/export?format=xlsx", {
      headers: { Authorization: "Bearer tok123" },
    });
    expect(clicked).toEqual([{ name: "journey-E2E001-2026-10-28.xlsx", href: "blob:journey" }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:journey");
  });

  it("names the file after what the server sent when it has no header: a csv when the server fell back to csv", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("a,b", { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } }),
    ) as never;
    expect(await downloadJourneyExport(7, () => null, "journey-x")).toBe("journey-x.csv");
    globalThis.fetch = vi.fn(
      async () => new Response("zip", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    ) as never;
    expect(await downloadJourneyExport(7, () => null, "journey-x")).toBe("journey-x.xlsx");
  });

  it("refuses with the server's sentence", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Journey not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    ) as never;
    await expect(downloadJourneyExport(7, () => "t", "x")).rejects.toThrow("Journey not found");
    globalThis.fetch = vi.fn(async () => new Response("", { status: 500 })) as never;
    await expect(downloadJourneyExport(7, () => "t", "x")).rejects.toThrow("Export failed (500)");
    expect(clicked).toEqual([]);
  });

  it("reads a file name from either form of the header", () => {
    expect(fileNameOf('attachment; filename="a b.xlsx"')).toBe("a b.xlsx");
    expect(fileNameOf("attachment; filename=a.csv")).toBe("a.csv");
    expect(fileNameOf("attachment; filename*=UTF-8''j%C3%B6urney.xlsx")).toBe("jöurney.xlsx");
    expect(fileNameOf("inline")).toBeNull();
    expect(fileNameOf(null)).toBeNull();
  });
});

describe("the mutations", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(customFetch).mockReset();
  });

  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const keys = [getJourneysRootKey(), getJourneyQueryKey(7), getLiveTracksQueryKey()];
    client.setQueryData(getJourneysRootKey(), { cached: true });
    client.setQueryData(getJourneyQueryKey(7), { cached: true });
    client.setQueryData(getLiveTracksQueryKey(), []);
    const hooks: {
      rebuild?: ReturnType<typeof useRebuildJourney>;
      save?: ReturnType<typeof useUpdateGeoTrackingSettings>;
    } = {};
    function Probe() {
      hooks.rebuild = useRebuildJourney();
      hooks.save = useUpdateGeoTrackingSettings();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
    return { client, hooks, keys, unmount: () => act(() => root.unmount()) };
  }

  it("a rebuild posts to the journey and re-reads the journeys and the live board", async () => {
    const view = mount();
    vi.mocked(customFetch).mockResolvedValue({ ok: true });
    await act(async () => {
      await view.hooks.rebuild!.mutateAsync(7);
    });
    expect(vi.mocked(customFetch)).toHaveBeenCalledWith("/api/tracking/journeys/7/rebuild", {
      method: "POST",
      body: "{}",
    });
    for (const key of view.keys) expect(view.client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    view.unmount();
  });

  it("a rebuild that answers with the rebuilt journey puts it straight into the page", async () => {
    const view = mount();
    vi.mocked(customFetch).mockResolvedValue({ track: { id: 7, employeeName: "Asha", status: "ended" }, segments: [] });
    await act(async () => {
      await view.hooks.rebuild!.mutateAsync(7);
    });
    const cached = view.client.getQueryData(getJourneyQueryKey(7)) as { track: { employeeName: string } };
    expect(cached.track.employeeName).toBe("Asha");
    view.unmount();
  });

  it("a failed rebuild invalidates nothing", async () => {
    const view = mount();
    vi.mocked(customFetch).mockRejectedValue(api(500, null));
    await act(async () => {
      await view.hooks.rebuild!.mutateAsync(7).catch(() => undefined);
    });
    for (const key of view.keys) expect(view.client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
    view.unmount();
  });

  it("saving the rules sends the partial body as it is and keeps the answer as the saved rules", async () => {
    const view = mount();
    vi.mocked(customFetch).mockResolvedValue({ ...DEFAULT_GEO_SETTINGS, stopSeconds: 240, dayEndTime: "23:40:00" });
    await act(async () => {
      await view.hooks.save!.mutateAsync({ stopSeconds: 240 });
    });
    expect(vi.mocked(customFetch)).toHaveBeenCalledWith("/api/tracking/settings", {
      method: "PUT",
      body: JSON.stringify({ stopSeconds: 240 }),
    });
    expect(view.client.getQueryData(getGeoSettingsQueryKey())).toMatchObject({ stopSeconds: 240, dayEndTime: "23:40" });
    view.unmount();
  });
});
