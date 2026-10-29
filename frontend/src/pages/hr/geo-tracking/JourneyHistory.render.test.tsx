import { act, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import JourneyHistoryTab from "./JourneyHistoryTab";
import { mapSpy, resetMap } from "./leafletMock";
import {
  all,
  buttonNamed,
  choose,
  click,
  clickId,
  css,
  detailFixture,
  installBrowserStubs,
  installWorld,
  IST,
  listItem,
  mount,
  q,
  settle,
  text,
  trailFixture,
  typeAt,
  unmount,
  waitFor,
  type World,
} from "./testing";

// Geo Attendance -> Journey History in jsdom: the list with its filters and paging, the empty / loading / error states, and one
// journey's page (summary cards, map, timeline, phone health, export, rebuild) with a small copy of the server behind customFetch
// and the map replaced by plain elements (jsdom cannot draw one).

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "tok123", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("react-leaflet", async () => (await import("./leafletMock")).leafletMock);

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
const VIEW_ONLY = { role: "hr", employeeId: null, isSuperAdmin: false, permissions: { geo_attendance: "view" } };

let world: World;

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  resetMap();
  h.user.current = SUPER;
  world = installWorld(h.fetch);
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
});

/** The tab with the open journey kept in state, as the page keeps it. */
const harness = (initial: number | null) =>
  function Harness() {
    const [id, setId] = useState<number | null>(initial);
    return <JourneyHistoryTab journeyId={id} onJourneyChange={setId} />;
  };

const openList = async () => {
  mount("/hr/geo-attendance?tab=journeys", harness(null));
  await waitFor(() => q("journey-list") !== null && q("journey-loading") === null, "the list");
};
const openJourney = async (id: number) => {
  mount(`/hr/geo-attendance?tab=journeys&journey=${id}`, harness(id));
  await waitFor(() => q("journey-detail") !== null || q("journey-detail-error") !== null, "the journey");
};

const rows = () => all("journey-row");
const rowFor = (id: number) => rows().find((r) => r.dataset.journeyId === String(id))!;
const journeyRequests = () => world.requests.filter((r) => r.startsWith("GET /api/tracking/journeys?"));
const lastListRequest = () => journeyRequests().at(-1)!;
const mouseDown = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
const polylines = () => all("polyline");
const markers = () => all("marker");
const timelineRow = (key: string) => css(`[data-testid="timeline-row"][data-key="${key}"]`)!;
const nextPage = () => css('[aria-label="Next page"]') as HTMLButtonElement;

describe("the list", () => {
  it("shows one row per journey with who, where to, when it started and ended and why, and the figures", async () => {
    await openList();
    expect(rows()).toHaveLength(3);

    const done = text(rowFor(7));
    expect(done).toContain("Asha Kumar");
    expect(done).toContain("E2E001");
    expect(done).toContain("Tirupur buyer visit");
    expect(done).toContain("28 Oct, 09:00"); // started
    expect(done).toContain("28 Oct, 17:40"); // ended, in India time
    expect(done).toContain("Marked done by the employee");
    expect(done).toContain("8 h 40 min"); // duration of 31200 s
    expect(done).toContain("14.25 km");
    expect(done).toContain("25 min"); // longest stop
    expect(done).toContain("15 min"); // gap time of 900 s
    expect(text(rowFor(7).querySelector('[data-testid="approval-chip"]'))).toBe("Awaiting HR");
    expect(rowFor(7).querySelector('[data-testid="mock-flag"]')).toBeNull();
    expect(rowFor(7).querySelector('[data-testid="live-badge"]')).toBeNull();
  });

  it("shows an active journey with a Live badge and its state, not an end", async () => {
    await openList();
    const live = rowFor(8);
    expect(live.dataset.status).toBe("active");
    expect(live.querySelector('[data-testid="live-badge"]')).not.toBeNull();
    expect(text(live.querySelector('[data-testid="row-state"]'))).toBe("Moving");
    expect(text(live)).not.toContain("Marked done");
    expect(text(live.querySelector('[data-testid="approval-chip"]'))).toBe("Awaiting Department Head");
  });

  it("flags a journey where a simulated (fake GPS) location was reported, and says how a rejected one ended", async () => {
    await openList();
    expect(text(rowFor(8).querySelector('[data-testid="mock-flag"]'))).toBe("Simulated");
    expect(text(rowFor(9))).toContain("Request rejected");
    expect(text(rowFor(9).querySelector('[data-testid="approval-chip"]'))).toBe("Rejected");
  });

  it("filters by status and by how it ended, asking the server and keeping the page right", async () => {
    await openList();
    choose("#journey-status", "active");
    await waitFor(() => rows().length === 1, "only the active journey");
    expect(lastListRequest()).toContain("status=active");
    expect(rowFor(8)).toBeTruthy();

    choose("#journey-status", "");
    await waitFor(() => rows().length === 3, "all again");
    choose("#journey-reason", "rejected");
    await waitFor(() => rows().length === 1, "only the rejected one");
    expect(lastListRequest()).toContain("endReason=rejected");
    expect(text(rowFor(9))).toContain("Meena Devi");
    expect(q("reason-note")).toBeNull(); // the server narrowed the list itself: nothing to explain
  });

  it("applies the end-reason filter to the rows even when the server does not know it", async () => {
    // a server that ignores `endReason` returns everything: the page still shows only the matching rows
    const real = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url: string, options?: RequestInit) =>
      real(url.replace(/endReason=[^&]*&?/, ""), options),
    );
    await openList();
    choose("#journey-reason", "manual");
    await waitFor(
      () => h.fetch.mock.calls.some((c) => String(c[0]).includes("endReason=manual")),
      "the filtered request",
    );
    await settle(20);
    expect(rows().map((r) => r.dataset.journeyId)).toEqual(["7"]);
    // and says so: only this page was narrowed
    expect(text(q("reason-note"))).toContain("only the journeys of this page that match are shown");
  });

  it("filters by employee: a search box over the active employees, then a chip with the choice", async () => {
    await openList();
    typeAt('[data-testid="employee-filter-input"]', "rav");
    await waitFor(() => q("employee-filter-options") !== null, "the matches");
    expect(text(q("employee-filter-options"))).toContain("Ravi Nair");
    expect(text(q("employee-filter-options"))).not.toContain("Asha");
    mouseDown(css('[data-testid="employee-filter-options"] button')!);

    await waitFor(() => q("employee-filter-chosen") !== null && rows().length === 1, "the employee's journey");
    expect(lastListRequest()).toContain("employeeId=12");
    expect(text(q("employee-filter-chosen"))).toBe("Ravi Nair (E2E002)");
    expect(rowFor(8)).toBeTruthy();

    click(css('[aria-label="Clear the employee filter"]'));
    await waitFor(() => rows().length === 3 && q("employee-filter-input") !== null, "everybody again");
  });

  it("says when no employee matches the search", async () => {
    await openList();
    typeAt('[data-testid="employee-filter-input"]', "zzz");
    await waitFor(() => q("employee-filter-options") !== null, "the box");
    expect(text(q("employee-filter-options"))).toContain('No employee matches "zzz"');
  });

  it("filters by a date range and refuses a range that ends before it starts", async () => {
    await openList();
    typeAt("#journey-from", "2026-10-28");
    await waitFor(() => rows().length === 2, "the journeys of the 28th");
    expect(lastListRequest()).toContain("from=2026-10-28");
    expect(rows().map((r) => r.dataset.journeyId)).toEqual(["7", "8"]);

    const before = journeyRequests().length;
    typeAt("#journey-to", "2026-10-27");
    await waitFor(() => q("range-error") !== null, "the range message");
    expect(text(q("range-error"))).toContain('The "From" date is after the "To" date');
    await settle(30);
    // no request for a range that cannot match
    expect(journeyRequests().length).toBe(before);
  });

  it("clears every filter with one button", async () => {
    await openList();
    choose("#journey-status", "ended");
    await waitFor(() => rows().length === 2, "ended journeys");
    click(buttonNamed("Clear filters"));
    await waitFor(() => rows().length === 3, "all journeys");
    expect((css("#journey-status") as HTMLSelectElement).value).toBe("");
    expect(buttonNamed("Clear filters")).toBeUndefined();
  });

  it("pages through a long list from the server", async () => {
    world.journeys = Array.from({ length: 30 }, (_, i) => listItem(100 + i, { employeeName: `Person ${i}` }));
    await openList();
    expect(rows()).toHaveLength(25);
    expect(text(css('[data-slot="page-info"]'))).toContain("Page 1 of 2");
    expect(text(css('[data-slot="page-info"]'))).toContain("of 30");
    click(nextPage());
    await waitFor(() => rows().length === 5, "the second page");
    expect(lastListRequest()).toContain("page=2");
    expect(text(css('[data-slot="page-info"]'))).toContain("Page 2 of 2");
  });

  it("goes back to the first page when a filter changes", async () => {
    world.journeys = Array.from({ length: 30 }, (_, i) => listItem(100 + i, { status: i % 2 ? "active" : "ended" }));
    await openList();
    click(nextPage());
    await waitFor(() => rows().length === 5, "the second page");
    choose("#journey-status", "active");
    await waitFor(() => rows().length === 15, "the active journeys");
    expect(lastListRequest()).toContain("page=1");
  });

  it("says there are no journeys yet, and says nothing matches when a filter is the reason", async () => {
    world.journeys = [];
    await openList();
    expect(text(q("journey-empty"))).toContain("No journeys yet");
    expect(text(q("journey-empty"))).toContain("submits an On-Duty request");
    choose("#journey-status", "active");
    await waitFor(
      () => text(q("journey-empty")).includes("No journey matches these filters"),
      "the filtered empty note",
    );
  });

  it("shows placeholders while loading", async () => {
    let release: (v: unknown) => void = () => {};
    const real = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation((url: string, options?: RequestInit) =>
      url.startsWith("/api/tracking/journeys?") ? new Promise((resolve) => (release = resolve)) : real(url, options),
    );
    mount("/hr/geo-attendance?tab=journeys", harness(null));
    await settle(10);
    expect(q("journey-loading")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    await act(async () => release({ results: [], page: 1, pageSize: 25, total: 0 }));
    await waitFor(() => q("journey-empty") !== null, "the empty list");
  });

  it("says why the list could not load and tries again", async () => {
    world.failing.set("/api/tracking/journeys", { status: 500, body: { error: "The database is busy." } });
    await openList();
    expect(text(q("journey-error"))).toContain("The journeys could not be loaded.");
    expect(text(q("journey-error"))).toContain("The database is busy.");
    world.failing.clear();
    click(buttonNamed("Try again"));
    await waitFor(() => rows().length === 3, "the list after trying again");
  });

  it("says when the role may not see journeys", async () => {
    world.failing.set("/api/tracking/journeys", { status: 403, body: null });
    await openList();
    expect(text(q("journey-error"))).toContain("You are not allowed to see journeys.");
  });

  it("opens a journey from its row and comes Back to the same list", async () => {
    await openList();
    choose("#journey-status", "ended");
    await waitFor(() => rows().length === 2, "ended journeys");
    click(rowFor(7));
    await waitFor(() => q("journey-detail") !== null, "the journey");
    expect(q("journey-detail")!.dataset.journeyId).toBe("7");
    clickId("journey-back");
    await waitFor(() => q("journey-list") !== null && rows().length === 2, "the list as it was left");
    expect((css("#journey-status") as HTMLSelectElement).value).toBe("ended");
  });
});

describe("one journey", () => {
  it("shows who, where to, how it ended and the approval", async () => {
    await openJourney(7);
    const d = text(q("journey-detail"));
    expect(d).toContain("Asha Kumar");
    expect(d).toContain("E2E001");
    expect(d).toContain('"Tirupur buyer visit"');
    expect(d).toContain("Stitching");
    expect(d).toContain("E2E Head Office");
    expect(text(q("journey-times"))).toContain("Started 28 Oct, 09:00:00");
    expect(text(q("journey-times"))).toContain("Ended 28 Oct, 17:40:00 (Marked done by the employee)");
    expect(text(q("approval-chip"))).toBe("Awaiting HR");
    expect(q("live-badge")).toBeNull();
    expect(q("live-note")).toBeNull();
  });

  it("shows the summary cards: distance, travel, stationary and gap time, stops, longest stop, points, events", async () => {
    await openJourney(7);
    const v = (id: string) => text(q(`${id}-value`));
    expect(v("card-distance")).toBe("14.25 km");
    expect(text(q("card-distance"))).toContain("Top speed 62 km/h");
    expect(v("card-travel")).toBe("3 h 10 min");
    expect(v("card-stationary")).toBe("1 h");
    expect(v("card-gap")).toBe("15 min");
    expect(v("card-stops")).toBe("2");
    expect(v("card-longest")).toBe("25 min");
    expect(v("card-points")).toBe("482");
    expect(v("card-events")).toBe("5");
  });

  it("draws travel solid, a gap dashed grey, an estimated stretch dashed and lighter", async () => {
    await openJourney(7);
    const lines = polylines().map((l) => [l.dataset.color, l.dataset.dash, l.dataset.points]);
    expect(lines).toEqual([
      ["#006496", "", "3"], // travel: solid
      ["#4aa3c7", "6 8", "2"], // estimated: dashed, lighter
      ["#6b7280", "4 8", "2"], // gap: dashed grey
    ]);
  });

  it("puts numbered pins on the stops, a pin per event that has a place, and a start and an end", async () => {
    await openJourney(7);
    const pins = (kind: string) => markers().filter((m) => m.dataset.pin === kind);
    expect(pins("stop").map((m) => m.dataset.title)).toEqual(["Stop 1: 09:30 - 09:38", "Stop 2: 10:25 - 10:50"]);
    // events with their own pictures; tracking started / stopped are not pins
    expect(pins("event").map((m) => m.dataset.title)).toEqual([
      "Location services turned off",
      "Network lost",
      "Location permission changed",
    ]);
    expect(pins("flag").map((m) => m.dataset.title)).toEqual(["Start of the journey"]);
    expect(pins("person").map((m) => m.dataset.title)).toEqual(["End of the journey"]);
    expect(pins("stop")[0].dataset.lat).toBe("11.02");
    expect(pins("stop")[0].dataset.lng).toBe("77.02");
  });

  it("opens a stop with its start, end, duration, waiting or long stop, and its address or coordinates", async () => {
    await openJourney(7);
    const popups = all("stop-popup").map((p) => text(p));
    expect(popups[0]).toContain("Stop 1");
    expect(popups[0]).toContain("09:30 - 09:38");
    expect(popups[0]).toContain("8 min");
    expect(popups[0]).toContain("waiting");
    expect(popups[0]).toContain("11.02000, 77.02000"); // no address: the coordinates
    expect(popups[1]).toContain("Stop 2");
    expect(popups[1]).toContain("25 min");
    expect(popups[1]).toContain("long stop");
    expect(popups[1]).toContain("Buyer office, Avinashi Road");
  });

  it("fits the map to the whole route when it opens, and again on Fit route", async () => {
    await openJourney(7);
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
    expect(mapSpy.fitBounds.mock.calls[0][0]).toEqual([
      [11.0, 77.0],
      [11.06, 77.06],
    ]);
    clickId("journey-fit");
    await settle();
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(2);
  });

  it("lists everything in one timeline by time, with the type, place, duration, distance and cause", async () => {
    await openJourney(7);
    const keys = all("timeline-row").map((r) => r.dataset.key);
    expect(keys).toEqual(["ev-1", "seg-1", "seg-2", "seg-3", "ev-2", "seg-4", "seg-5", "ev-3", "ev-4", "ev-5"]);
    expect(all("timeline-row").map((r) => r.dataset.type)).toEqual([
      "event",
      "travel",
      "stop",
      "gap",
      "event",
      "stop",
      "travel",
      "event",
      "event",
      "event",
    ]);
    const travel = text(timelineRow("seg-1"));
    expect(travel).toContain("09:05 - 09:30");
    expect(travel).toContain("Travel");
    expect(travel).toContain("Travelled 3.20 km");
    expect(travel).toContain("25 min");
    expect(text(timelineRow("seg-5"))).toContain("estimated");
    const gap = text(timelineRow("seg-3"));
    expect(gap).toContain("Gap");
    expect(gap).toContain("15 min");
    expect(gap).toContain("Location services were off");
    expect(text(timelineRow("ev-4"))).toContain("Always to While using");
  });

  it("shows a stationary period as Stationary with its length and a waiting / long stop chip", async () => {
    await openJourney(7);
    const short = timelineRow("seg-2");
    expect(text(short)).toContain("Stationary");
    expect(text(short)).toContain("8 min");
    expect(text(short.querySelector('[data-testid="stop-kind"]'))).toBe("waiting");
    expect(text(short)).toContain("#1");
    const long = timelineRow("seg-4");
    expect(text(long)).toContain("25 min");
    expect(text(long.querySelector('[data-testid="stop-kind"]'))).toBe("long stop");
    expect(text(long)).toContain("Buyer office, Avinashi Road");
    expect(text(long)).toContain("#2");
  });

  it("narrows the timeline to stationary periods, gaps, events or travel", async () => {
    await openJourney(7);
    expect(text(q("timeline-show-stop"))).toBe("Stationary (2)");
    expect(text(q("timeline-show-gap"))).toBe("Gaps (1)");
    expect(text(q("timeline-show-event"))).toBe("Events (5)");
    expect(text(q("timeline-show-travel"))).toBe("Travel (2)");
    clickId("timeline-show-stop");
    expect(all("timeline-row").map((r) => r.dataset.key)).toEqual(["seg-2", "seg-4"]);
    clickId("timeline-show-event");
    expect(all("timeline-row")).toHaveLength(5);
    clickId("timeline-show-all");
    expect(all("timeline-row")).toHaveLength(10);
  });

  it("highlights a travel on the map and moves the map to it when its row is picked", async () => {
    await openJourney(7);
    mapSpy.fitBounds.mockClear();
    click(timelineRow("seg-1"));
    await settle();
    expect(timelineRow("seg-1").dataset.selected).toBe("true");
    expect(timelineRow("seg-2").dataset.selected).toBe("false");
    expect(polylines().map((l) => l.dataset.weight)).toEqual(["8", "4", "3"]); // the picked line is thick
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
    expect(mapSpy.fitBounds.mock.calls[0][0]).toEqual([
      [11.0, 77.0],
      [11.02, 77.02],
    ]);
  });

  it("moves the map to a stop when its row is picked, and enlarges its pin", async () => {
    await openJourney(7);
    click(timelineRow("seg-4"));
    await settle();
    expect(mapSpy.setView).toHaveBeenCalledWith([11.04, 77.04], 16);
    expect(all("circle").map((c) => c.dataset.radius)).toEqual(["60"]); // the stop's radius is drawn
    // picking the same row again lets go of it
    click(timelineRow("seg-4"));
    await settle();
    expect(timelineRow("seg-4").dataset.selected).toBe("false");
    expect(all("circle")).toHaveLength(0);
  });

  it("highlights the row when something is picked on the map", async () => {
    await openJourney(7);
    click(markers().find((m) => m.dataset.title === "Network lost")!);
    await settle();
    expect(timelineRow("ev-3").dataset.selected).toBe("true");
    click(polylines()[2]); // the gap line
    await settle();
    expect(timelineRow("seg-3").dataset.selected).toBe("true");
    expect(timelineRow("ev-3").dataset.selected).toBe("false");
    click(markers().find((m) => m.dataset.pin === "stop")!);
    await settle();
    expect(timelineRow("seg-2").dataset.selected).toBe("true");
  });

  it("shows the phone and whether it can keep tracking with the app closed", async () => {
    await openJourney(7);
    const t = (id: string) => text(q(id));
    expect(t("device-model")).toContain("Samsung SM-A346E");
    expect(t("device-os")).toContain("android 14");
    expect(t("device-app")).toContain("2.4.0");
    expect(t("device-permission")).toContain("Allow all the time");
    expect(t("device-location")).toContain("On");
    expect(t("device-optimised")).toContain("Restricting the app");
    expect(t("device-background")).toContain("No");
    expect(t("device-powersave")).toContain("Off");
    expect(t("device-last-seen")).toContain("28 Oct, 17:39:00");
    expect(t("device-battery")).toContain("64%");
    expect(t("device-network")).toContain("cell");
  });

  it("says when no phone has reported yet", async () => {
    world.details[7] = detailFixture(7, {
      device: null,
      track: { lastBatteryPct: null, lastNetwork: null, lastPointAt: null },
    });
    await openJourney(7);
    expect(text(q("device-empty"))).toContain("No phone has reported yet");
    expect(text(q("device-last-seen"))).toContain("Never");
    expect(text(q("device-battery"))).toContain("Not reported");
  });

  it("paints simulated (fake GPS) travel in the red the page uses, with a note", async () => {
    world.details[10] = detailFixture(10, {
      track: { hasMock: true },
      segments: [
        {
          seqNo: 1,
          kind: "travel",
          startedAt: "2026-10-28T09:05:00+05:30",
          endedAt: "2026-10-28T09:30:00+05:30",
          durationS: 1500,
          distanceM: 900,
          polyline: [
            [11, 77],
            [11.01, 77.01],
          ],
          meta: { mockPoints: 6 },
        },
      ],
      events: [
        {
          id: 1,
          kind: "MOCK_LOCATION",
          source: "device",
          startedAt: "2026-10-28T09:10:00+05:30",
          latitude: 11.005,
          longitude: 77.005,
        },
      ],
    });
    await openJourney(10);
    expect(polylines()[0].dataset.color).toBe("#dc2626");
    expect(text(timelineRow("seg-1"))).toContain("simulated");
    expect(text(timelineRow("ev-1"))).toContain("Simulated (fake) location detected");
    expect(text(q("mock-note"))).toContain("simulated (fake GPS) location");
    expect(q("mock-flag")).not.toBeNull();
  });

  it("shows an active journey as Live, with its state, its latest position and a note that it refreshes by itself", async () => {
    await openJourney(8);
    expect(q("journey-detail")!.dataset.status).toBe("active");
    expect(q("live-badge")).not.toBeNull();
    expect(text(q("state-pill"))).toBe("Moving");
    expect(text(q("live-note"))).toContain("every 30 seconds");
    expect(text(q("journey-times"))).toContain("Still tracking");
    expect(
      markers()
        .filter((m) => m.dataset.pin === "person")
        .map((m) => m.dataset.title),
    ).toEqual(["Latest position"]);
    expect(q("mock-note")).not.toBeNull();
  });

  it("says a rejected request stopped the tracking and that what was recorded is kept", async () => {
    world.details[9] = detailFixture(9, { track: { endReason: "rejected", approvalStatus: "rejected" } });
    await openJourney(9);
    expect(text(q("rejected-note"))).toContain("rejected, so tracking stopped");
    expect(text(q("rejected-note"))).toContain("kept");
    expect(text(q("journey-times"))).toContain("Request rejected");
  });

  it("explains an empty journey: nothing yet while active, nothing recorded when ended", async () => {
    world.details[11] = detailFixture(11, {
      track: {
        status: "active",
        state: "waiting_first_fix",
        endedAt: null,
        endReason: "",
        lastLatitude: null,
        lastLongitude: null,
      },
      segments: [],
      events: [],
      device: null,
    });
    (world.details[11] as { path: unknown[] }).path = [];
    await openJourney(11);
    expect(text(q("journey-map-empty"))).toContain("No location has arrived yet");
    expect(text(q("timeline-empty"))).toContain("Nothing has been recorded yet");
    expect(markers()).toHaveLength(0);
    expect(mapSpy.fitBounds).not.toHaveBeenCalled();
  });

  it("refreshes on the Refresh button", async () => {
    await openJourney(7);
    const before = world.requests.filter((r) => r === "GET /api/tracking/journeys/7").length;
    clickId("journey-refresh");
    await waitFor(
      () => world.requests.filter((r) => r === "GET /api/tracking/journeys/7").length === before + 1,
      "a second read",
    );
  });

  it("keeps showing the journey and says so when a refresh fails", async () => {
    await openJourney(8);
    world.failing.set("/api/tracking/journeys/8", { status: 500, body: { error: "Server is restarting" } });
    clickId("journey-refresh");
    await waitFor(() => q("refresh-failed") !== null, "the warning");
    expect(text(q("refresh-failed"))).toContain("Server is restarting");
    expect(q("journey-detail")).not.toBeNull();
  });

  it("says when the journey does not exist, with a way back", async () => {
    await openJourney(999);
    expect(text(q("journey-detail-error"))).toContain("This journey was not found.");
    expect(buttonNamed("Try again")).toBeTruthy();
    expect(q("journey-back")).not.toBeNull();
  });

  it("shows placeholders while the journey loads", async () => {
    let release: (v: unknown) => void = () => {};
    const real = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation((url: string, options?: RequestInit) =>
      url === "/api/tracking/journeys/7" ? new Promise((resolve) => (release = resolve)) : real(url, options),
    );
    mount("/hr/geo-attendance?tab=journeys&journey=7", harness(7));
    await settle(10);
    expect(q("journey-detail-loading")).not.toBeNull();
    await act(async () => release(world.details[7]));
    await waitFor(() => q("journey-detail") !== null, "the journey");
  });
});

describe("export and rebuild", () => {
  const realFetch = globalThis.fetch;
  let saved: string[];

  beforeEach(() => {
    saved = [];
    URL.createObjectURL = vi.fn(() => "blob:journey");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("downloads the workbook with the person's own token and says so", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(["xlsx"]), { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await openJourney(7);
    clickId("journey-export");
    await waitFor(() => saved.length === 1, "the saved file");
    expect(fetchMock).toHaveBeenCalledWith("/api/tracking/journeys/7/export?format=xlsx", {
      headers: { Authorization: "Bearer tok123" },
    });
    expect(saved[0]).toBe("journey-E2E001-2026-10-28.xlsx");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Journey exported" }));
  });

  it("says why an export failed", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Workbook library missing" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    ) as never;
    await openJourney(7);
    clickId("journey-export");
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Export failed",
        description: "Workbook library missing",
        variant: "destructive",
      }),
    );
    expect(saved).toEqual([]);
  });

  it("asks before rebuilding, then recomputes from the raw data and reads the journey again", async () => {
    await openJourney(7);
    clickId("journey-rebuild");
    await settle();
    expect(document.body.textContent).toContain("Rebuild this journey?");
    expect(document.body.textContent).toContain("not changed or deleted");
    expect(world.writes).toEqual([]); // nothing yet
    const reads = world.requests.filter((r) => r === "GET /api/tracking/journeys/7").length;
    click(buttonNamed("Rebuild journey"));
    await waitFor(() => world.writes.length === 1, "the rebuild call");
    expect(world.writes[0]).toMatchObject({ method: "POST", url: "/api/tracking/journeys/7/rebuild" });
    await waitFor(
      () => world.requests.filter((r) => r === "GET /api/tracking/journeys/7").length > reads,
      "a new read",
    );
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Journey rebuilt" }));
  });

  it("does nothing when the rebuild is cancelled", async () => {
    await openJourney(7);
    clickId("journey-rebuild");
    await settle();
    click(buttonNamed("Cancel"));
    await settle();
    expect(world.writes).toEqual([]);
  });

  it("says why a rebuild failed", async () => {
    world.failing.set("/api/tracking/journeys/7/rebuild", {
      status: 400,
      body: { error: "The journey has no points." },
    });
    await openJourney(7);
    clickId("journey-rebuild");
    await settle();
    click(buttonNamed("Rebuild journey"));
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Rebuild failed",
        description: "The journey has no points.",
        variant: "destructive",
      }),
    );
  });

  it("gives a role with View only the journey and the export, but no Rebuild", async () => {
    h.user.current = VIEW_ONLY;
    await openJourney(7);
    expect(q("journey-rebuild")).toBeNull();
    expect(q("journey-export")).not.toBeNull();
    // the portal locks buttons whose words say "export" for View only; this one reads, so it opts out of the lock
    expect(q("journey-export")!.hasAttribute("data-view-safe")).toBe(true);
    expect(q("journey-refresh")!.hasAttribute("data-view-safe")).toBe(true);
  });
});

describe("the complete route and the place details", () => {
  const trailReady = () => waitFor(() => q("trail-controls")?.dataset.trail === "ready", "the recorded positions");
  const panel = () => q("place-details")!;
  const inPanel = (testId: string) => panel().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const stopPin = (n: number) => markers().filter((m) => m.dataset.pin === "stop")[n - 1]!;
  beforeEach(() => window.localStorage.clear());

  it("asks for every recorded position and draws the whole route under the travel, with the count", async () => {
    await openJourney(7);
    await trailReady();
    expect(world.requests).toContain("GET /api/tracking/journeys/7/trail");
    // one thin line per stretch: travel, stop 1 (waiting, amber), stop 2 (a long stop, purple), travel
    expect(all("trail-run").map((r) => [r.dataset.color, r.dataset.points])).toEqual([
      ["#1e3a8a", "7"],
      ["#d97706", "4"],
      ["#7c3aed", "7"],
      ["#1e3a8a", "12"],
    ]);
    // the travel and gap lines of the journey are still drawn on top of it
    expect(polylines()).toHaveLength(3);
    expect(text(q("trail-count"))).toBe("29 positions recorded");
    expect(text(q("trail-controls"))).toContain("Show every recorded position (28)");
    expect(text(q("trail-controls"))).toContain("Include 1 set aside (poor accuracy)");
    expect(text(q("map-legend"))).toContain("Recorded position");
  });

  it("keeps the map and says so when the recorded positions cannot be loaded", async () => {
    world.failing.set("/api/tracking/journeys/7/trail", { status: 500 });
    await openJourney(7);
    await waitFor(() => q("trail-controls")?.dataset.trail === "error", "the failure");
    expect(text(q("trail-error"))).toContain("could not be loaded");
    expect(all("trail-run")).toHaveLength(0);
    expect(polylines()).toHaveLength(3);
    expect(q("journey-detail")).not.toBeNull();
  });

  it("says how many positions there are when a very long journey was thinned, or rebuilt from the stored route", async () => {
    world.trails[7] = trailFixture(7, { total: 9000, truncated: true });
    await openJourney(7);
    await trailReady();
    expect(text(q("trail-count"))).toBe("29 of 9000 positions shown (a very long journey is thinned for the map)");
    unmount();
    world.trails[7] = trailFixture(7, { source: "segments" });
    await openJourney(7);
    await trailReady();
    expect(text(q("trail-count"))).toContain("rebuilt from the stored route");
  });

  it("shows where the journey ended, with Google Maps links, until something is picked", async () => {
    await openJourney(7);
    expect(panel().dataset.kind).toBe("latest");
    expect(text(q("place-heading"))).toBe("End of the journey");
    expect(inPanel("open-google-maps")!.getAttribute("href")).toBe(
      "https://www.google.com/maps/search/?api=1&query=11.060000,77.060000",
    );
    expect(inPanel("google-directions")!.getAttribute("href")).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=11.060000,77.060000",
    );
  });

  it("opens a stop with its times, how long it lasted, its positions and the links to Google Maps", async () => {
    await openJourney(7);
    click(stopPin(1));
    await settle();
    expect(panel().dataset.kind).toBe("picked");
    expect(text(q("place-heading"))).toContain("Stop 1");
    expect(text(panel())).toContain("waiting");
    const facts = text(q("place-facts"));
    expect(facts).toContain("09:30 - 09:38");
    expect(facts).toContain("8 min");
    expect(facts).toContain("recorded");
    expect(inPanel("open-google-maps")!.getAttribute("href")).toBe(
      "https://www.google.com/maps/search/?api=1&query=11.020000,77.020000",
    );
    // the stop's own popup on the map carries the same links
    expect(q("stop-popup")!.querySelector('[data-testid="open-google-maps"]')).not.toBeNull();
    // the second stop is a long stop with an address
    click(stopPin(2));
    await settle();
    expect(text(q("place-heading"))).toContain("Stop 2");
    expect(text(panel())).toContain("long stop");
    expect(text(q("place-title"))).toBe("Buyer office, Avinashi Road");
    expect(text(q("place-facts"))).toContain("11.04000, 77.04000");
  });

  it("shows the two ends of a travel and of a gap, each with its links", async () => {
    await openJourney(7);
    click(timelineRow("seg-1"));
    await settle();
    expect(text(q("place-heading"))).toBe("Travel");
    expect(text(q("place-title"))).toBe("Travelled 3.20 km");
    expect(all("place-end").map((e) => text(e).split("Open")[0].trim())).toEqual([
      "From: 11.00000, 77.00000",
      "To: 11.02000, 77.02000",
    ]);
    click(timelineRow("seg-3"));
    await settle();
    expect(text(q("place-heading"))).toBe("Gap (no location)");
    expect(text(q("place-title"))).toBe("Location services were off");
    expect(all("place-end")).toHaveLength(2);
    expect(text(panel())).toContain("straight dashed line");
  });

  it("shows an event with its time and its last known place", async () => {
    await openJourney(7);
    click(timelineRow("ev-3"));
    await settle();
    expect(text(q("place-heading"))).toBe("Event");
    expect(text(q("place-title"))).toBe("Network lost");
    expect(text(q("place-facts"))).toContain("11.05000, 77.05000");
    expect(inPanel("open-google-maps")!.getAttribute("href")).toContain("query=11.050000,77.050000");
  });

  it("asks Google for nothing until the Google Maps view is turned on, then shows the picked place and remembers the choice", async () => {
    await openJourney(7);
    expect(q("google-view-frame")).toBeNull();
    expect(q("google-view-toggle")!.textContent).toContain("Show Google Maps view");
    click(q("google-view-toggle"));
    // nothing picked: Google's map of where the journey ended
    expect(q("google-view-frame")!.getAttribute("src")).toBe(
      "https://www.google.com/maps?q=11.060000,77.060000&z=18&output=embed&hl=en",
    );
    expect(window.localStorage.getItem("hr-google-view")).toBe("on");
    click(stopPin(1));
    await settle();
    expect(q("google-view-frame")!.getAttribute("src")).toContain("q=11.020000,77.020000");
    click(q("google-view-toggle"));
    expect(q("google-view-frame")).toBeNull();
    expect(window.localStorage.getItem("hr-google-view")).toBe("off");
  });

  it("opens the Google Maps view straight away when it was left on", async () => {
    window.localStorage.setItem("hr-google-view", "on");
    await openJourney(7);
    expect(q("google-view-frame")).not.toBeNull();
    expect(q("google-view-toggle")!.textContent).toContain("Hide Google Maps view");
  });

  it("puts a Google Maps link on the timeline rows that have one place, and on no others", async () => {
    await openJourney(7);
    const link = (key: string) => timelineRow(key).querySelector('[data-testid="open-google-maps"]');
    expect(link("seg-2")!.getAttribute("href")).toContain("query=11.020000,77.020000");
    expect(link("seg-4")).not.toBeNull();
    expect(link("ev-2")).not.toBeNull();
    expect(link("seg-1")).toBeNull();
    expect(link("seg-3")).toBeNull();
    // the link opens Google; it does not pick the row
    click(link("seg-2") as Element);
    expect(timelineRow("seg-2").dataset.selected).toBe("false");
  });
});

describe("stops at the same place", () => {
  // stop 1 and stop 3 are 4 m apart (the same gate before and after a visit to stop 2): they used to lie on top of each other,
  // and the later pin hid the earlier one
  const stop = (seqNo: number, from: string, to: string, secs: number, lat: number, lng: number) => ({
    seqNo,
    kind: "stop",
    startedAt: IST(from),
    endedAt: IST(to),
    durationS: secs,
    centerLat: lat,
    centerLng: lng,
    radiusM: 25,
    address: "",
  });
  const travel = (seqNo: number, from: string, to: string, a: [number, number], b: [number, number]) => ({
    seqNo,
    kind: "travel",
    startedAt: IST(from),
    endedAt: IST(to),
    durationS: 1200,
    distanceM: 4000,
    startLat: a[0],
    startLng: a[1],
    endLat: b[0],
    endLng: b[1],
    polyline: [a, b],
    avgSpeedKmh: 30,
  });
  const stopPins = () => markers().filter((m) => m.dataset.pin === "stop");

  beforeEach(() => {
    world.details[7] = detailFixture(7, {
      segments: [
        stop(1, "09:00", "09:10", 600, 11.02, 77.02),
        travel(2, "09:10", "09:30", [11.02, 77.02], [11.05, 77.05]),
        stop(3, "09:30", "09:50", 1200, 11.05, 77.05),
        travel(4, "09:50", "10:20", [11.05, 77.05], [11.02004, 77.02001]),
        stop(5, "10:20", "10:35", 900, 11.02004, 77.02001),
      ],
    });
  });

  it("draws them as one pin that says every number, and a pin of its own for the other stop", async () => {
    await openJourney(7);
    expect(stopPins().map((m) => m.dataset.title)).toEqual([
      "Stops 1 \u00b7 3: the same place",
      "Stop 2: 09:30 - 09:50",
    ]);
    expect(stopPins().map((m) => [m.dataset.lat, m.dataset.lng])).toEqual([
      [String((11.02 + 11.02004) / 2), String((77.02 + 77.02001) / 2)],
      ["11.05", "77.05"],
    ]);
  });

  it("lists the stops of the pin in its popup, with Google Maps once, and picks one from there", async () => {
    await openJourney(7);
    const popup = all("stop-popup").find((p) => p.dataset.stops === "2")!;
    expect(popup).toBeDefined();
    expect(all("stop-popup-item").filter((i) => popup.contains(i))).toHaveLength(2);
    expect(text(popup)).toContain("Stops 1 \u00b7 3");
    expect(text(popup)).toContain("the same place");
    expect(text(popup)).toContain("09:00 - 09:10");
    expect(text(popup)).toContain("10:20 - 10:35");
    expect(popup.querySelectorAll('[data-testid="open-google-maps"]')).toHaveLength(1);
    // the other pin is a plain stop
    expect(all("stop-popup").find((p) => p.dataset.stops === "1")).toBeDefined();
    // picking Stop 3 from the popup shows it, and says it was at the same place as stop 1
    click(popup.querySelectorAll<HTMLElement>('[data-testid="stop-popup-pick"]')[1]);
    await settle();
    expect(text(q("place-heading"))).toBe("Stop 3");
    expect(text(q("place-facts"))).toContain("Same place as");
    expect(text(q("place-facts"))).toContain("Stop 1 (09:00 - 09:10)");
    expect(timelineRow("seg-5").dataset.selected).toBe("true");
  });

  it("opens the shared pin when a row of one of its stops is picked in the timeline, and names the other stop", async () => {
    await openJourney(7);
    click(timelineRow("seg-1"));
    await settle();
    expect(text(q("place-heading"))).toBe("Stop 1");
    expect(text(q("place-facts"))).toContain("Stop 3 (10:20 - 10:35)");
    // a stop at a place of its own says nothing of the kind
    click(timelineRow("seg-3"));
    await settle();
    expect(text(q("place-heading"))).toBe("Stop 2");
    expect(text(q("place-facts"))).not.toContain("Same place as");
  });
});

describe("the colours of the pins", () => {
  const pin = (kind: string) => markers().filter((m) => m.dataset.pin === kind);

  it("draws the start and the end of a journey in one colour, apart from the stops", async () => {
    await openJourney(7);
    const start = pin("flag");
    const end = pin("person");
    expect(start).toHaveLength(1);
    expect(end).toHaveLength(1);
    expect(start[0].dataset.color).toBe("#16a34a");
    expect(end[0].dataset.color).toBe(start[0].dataset.color);
    // the stops keep their own colours: amber while waiting, purple from 15 minutes
    expect(pin("stop").map((m) => m.dataset.color)).toEqual(["#d97706", "#7c3aed"]);
    expect(text(q("map-legend"))).toContain("Start and end");
  });

  it("keeps the end the same colour while the journey is still being recorded (its state shows elsewhere)", async () => {
    await openJourney(8);
    expect(pin("person")[0].dataset.color).toBe("#16a34a");
    expect(pin("flag")[0].dataset.color).toBe("#16a34a");
  });
});

describe("the journey as a story", () => {
  const items = () => all("activity-item");
  const item = (key: string) => css(`[data-testid="activity-item"][data-key="${key}"]`)!;
  const head = (key: string) => item(key).querySelector('[data-testid="activity-head"]')!;
  const details = (key: string) => item(key).querySelector('[data-testid="activity-details"]');

  it("tells the recorded journey in order, with the figures of its breaks and its travel", async () => {
    await openJourney(7);
    expect(items().map((i) => i.dataset.kind)).toEqual([
      "start",
      "break",
      "gap",
      "break",
      "resume",
      "notice",
      "notice",
      "end",
    ]);
    expect(text(item("act-start"))).toContain("Journey started");
    expect(text(item("act-start"))).toContain("Tirupur buyer visit");
    expect(text(item("act-end"))).toContain("On-duty completed");
    expect(text(item("act-end"))).toContain("Marked done by the employee");
    expect(text(q("stat-breaks"))).toContain("2 (1 long)");
    expect(text(q("stat-break-time"))).toContain("1 h");
    expect(text(q("stat-travel-time"))).toContain("3 h 10 min");
    expect(text(q("stat-started"))).toContain("1 time");
    expect(text(q("stat-resumed"))).toContain("1 time");
    expect(text(q("stat-total"))).toContain("8 h 40 min");
  });

  it("says where and for how long each break was, and joins the items with the travel between them", async () => {
    await openJourney(7);
    const second = text(item("act-seg-4"));
    expect(second).toContain("Break taken");
    expect(second).toContain("Break 2 · long");
    expect(second).toContain("Buyer office, Avinashi Road");
    expect(second).toContain("10:25 - 10:50");
    expect(second).toContain("25 min");
    expect(text(item("act-seg-2"))).toContain("Break 1");
    expect(text(item("act-seg-2"))).not.toContain("long");
    // the travel before the first break, and the last stretch to the end of the journey
    expect(all("activity-leg").map((l) => l.dataset.key)).toEqual(["seg-1", "seg-5"]);
    expect(text(all("activity-leg")[0])).toContain("3.20 km in 25 min");
    expect(text(all("activity-leg")[1])).toContain("estimated");
    // a gap is told once, with its cause
    expect(text(item("act-seg-3"))).toContain("Location services were off");
    expect(item("act-ev-2")).toBeNull();
  });

  it("opens an item and points it out on the map when it is picked, and lets go when it is picked again", async () => {
    await openJourney(7);
    expect(details("act-seg-4")).toBeNull();
    click(head("act-seg-4"));
    await settle();
    expect(item("act-seg-4").dataset.selected).toBe("true");
    expect(text(details("act-seg-4"))).toContain("Coordinates");
    expect(text(details("act-seg-4"))).toContain("11.04000, 77.04000");
    expect(item("act-seg-4").querySelector('[data-testid="open-google-maps"]')).not.toBeNull();
    expect(mapSpy.setView).toHaveBeenCalledWith([11.04, 77.04], 16);
    // the detailed log below highlights the same stop
    expect(timelineRow("seg-4").dataset.selected).toBe("true");
    click(head("act-seg-4"));
    await settle();
    expect(item("act-seg-4").dataset.selected).toBe("false");
    expect(details("act-seg-4")).toBeNull();
    expect(timelineRow("seg-4").dataset.selected).toBe("false");
  });

  it("opens the item of something picked on the map", async () => {
    await openJourney(7);
    click(markers().find((m) => m.dataset.title === "Network lost")!);
    await settle();
    expect(item("act-ev-3").dataset.selected).toBe("true");
    expect(details("act-ev-3")).not.toBeNull();
    expect(item("act-seg-4").dataset.selected).toBe("false");
  });

  it("shows a stretch of the route when its travel is picked", async () => {
    await openJourney(7);
    click(all("activity-leg")[0]);
    await settle();
    expect(all("activity-leg")[0].dataset.selected).toBe("true");
    expect(polylines().map((l) => l.dataset.weight)).toEqual(["8", "4", "3"]); // the picked line is thick
  });

  it("opens and closes every item at once", async () => {
    await openJourney(7);
    clickId("activity-toggle-all");
    await settle();
    expect(items().every((i) => i.querySelector('[data-testid="activity-details"]') !== null)).toBe(true);
    expect(text(q("activity-toggle-all"))).toBe("Collapse all");
    clickId("activity-toggle-all");
    await settle();
    expect(all("activity-details")).toHaveLength(0);
  });

  it("ends a journey that is still recorded with 'on duty now' and its state", async () => {
    await openJourney(8);
    const now = text(item("act-end"));
    expect(item("act-end").dataset.kind).toBe("live");
    expect(now).toContain("On duty now");
    expect(now).toContain("Moving");
    expect(q("live-note")).not.toBeNull();
  });
});
