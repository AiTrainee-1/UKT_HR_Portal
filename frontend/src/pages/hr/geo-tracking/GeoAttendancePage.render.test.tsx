import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GeoAttendance from "../GeoAttendance";
import { mapSpy, resetMap } from "./leafletMock";
import {
  all,
  buttonNamed,
  click,
  clickId,
  css,
  here,
  installBrowserStubs,
  installWorld,
  liveRow,
  mount,
  newWorld,
  q,
  settle,
  text,
  unmount,
  waitFor,
  type Raw,
  type World,
} from "./testing";

// Geo Attendance as a whole page in jsdom: the new Journey History tab and its address, the Live Map with the new feed of On-Duty
// tracks first and the old feed after it, "Open journey" from the board to the journey, the two photos of a punch, and the rules
// card on the Tracking Settings tab. The server is a small copy behind customFetch; the map is replaced by plain elements.

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
// the page's frame (sidebar, header) and its refresh button are other parts of the application
vi.mock("@/components/HrLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString();

let world: World;

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  resetMap();
  h.user.current = SUPER;
  world = installWorld(h.fetch, newWorld());
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
  vi.restoreAllMocks();
});

const open = async (search = "") => {
  mount(`/hr/geo-attendance${search}`, GeoAttendance);
  await settle(30);
};
// the page's own tab strip (the Approvals tab has a second one of its own below it); a tab's label is drawn twice by the pills
const tabs = () => [...document.body.querySelector('[role="tablist"]')!.querySelectorAll<HTMLElement>('[role="tab"]')];
const labelOf = (el: Element) => text(el.querySelector(".ptab-label"));
const tab = (name: RegExp | string) =>
  tabs().find((t) => (typeof name === "string" ? labelOf(t) === name : name.test(labelOf(t))))!;
const markers = () => all("marker");
const liveTracks = () => all("live-track");
const trackRow = (id: number) => liveTracks().find((r) => r.dataset.trackId === String(id))!;

/** Four tracks (one per state, one per approval stage) and the old feed with two people on the map and one without a position. */
function liveBoard(): Raw[] {
  return [
    liveRow(21, {
      state: "moving",
      approvalStatus: "pending_hod",
      employeeName: "Moving Mani",
      lastPointAt: minutesAgo(2),
      batteryPct: 71,
      network: "wifi",
    }),
    liveRow(22, {
      state: "stationary",
      approvalStatus: "pending_hr",
      employeeName: "Still Sita",
      lastPointAt: minutesAgo(6),
      batteryPct: 55,
      network: "cell",
      stateSince: "2026-10-28T10:00:00+05:30",
    }),
    liveRow(23, {
      state: "offline",
      approvalStatus: "active",
      employeeName: "Quiet Qadir",
      lastPointAt: minutesAgo(25),
      batteryPct: 9,
      network: "none",
    }),
    liveRow(24, {
      state: "location_off",
      approvalStatus: "rejected",
      employeeName: "Dark Devi",
      lastPointAt: minutesAgo(12),
      batteryPct: null,
      network: "cell",
      isMocked: true,
    }),
  ];
}
const oldFeed = (): Raw[] => [
  // the same person as track 21, with an older position: the new feed wins on the map
  {
    employeeId: 31,
    employeeCode: "E31",
    employeeName: "Moving Mani",
    department: "Stitching",
    branchName: null,
    latitude: 12.5,
    longitude: 78.5,
    isMocked: false,
    lastSeenAt: minutesAgo(60),
  },
  {
    employeeId: 40,
    employeeCode: "E40",
    employeeName: "Toggle Tara",
    department: "Cutting",
    branchName: null,
    latitude: 11.9,
    longitude: 77.9,
    isMocked: false,
    lastSeenAt: minutesAgo(3),
  },
  {
    employeeId: 41,
    employeeCode: "E41",
    employeeName: "Nofix Nila",
    department: "Cutting",
    branchName: null,
    latitude: null,
    longitude: null,
    isMocked: false,
    lastSeenAt: null,
  },
];

describe("the tabs", () => {
  it("has a Journey History tab between the Live Map and the On-Duty Map", async () => {
    await open();
    expect(tabs().map((t) => labelOf(t).replace(/\s*\(\d+\)$/, ""))).toEqual([
      "On-Duty Approvals",
      "Punch Verifications",
      "Live Map",
      "Journey History",
      "On-Duty Map",
      "Tracking Settings",
    ]);
  });

  it("opens the journeys list from the tab and writes the tab into the address", async () => {
    await open();
    click(tab("Journey History"));
    await waitFor(() => all("journey-row").length === 3, "the journeys");
    expect(here()).toBe("/hr/geo-attendance?tab=journeys");
    click(tab("Live Map"));
    await settle(20);
    expect(here()).toBe("/hr/geo-attendance?tab=map");
    click(tab("On-Duty Approvals"));
    await settle(20);
    expect(here()).toBe("/hr/geo-attendance");
  });

  it("opens a journey straight from its address, and Back returns to the list (and the address)", async () => {
    await open("?tab=journeys&journey=7");
    await waitFor(() => q("journey-detail") !== null, "the journey");
    expect(text(q("journey-detail"))).toContain("Asha Kumar");
    clickId("journey-back");
    await waitFor(() => all("journey-row").length === 3, "the list");
    expect(here()).toBe("/hr/geo-attendance?tab=journeys");
  });

  it("opens the tab the address names and falls back to the first for an unknown one", async () => {
    await open("?tab=map");
    expect(tab("Live Map").getAttribute("aria-selected")).toBe("true");
    unmount();
    await open("?tab=nonsense");
    expect(tab(/^On-Duty Approvals/).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the Live Map", () => {
  it("lists the On-Duty tracks first, each with its state, last seen, battery, network, approval and when it started", async () => {
    world.live = liveBoard();
    world.team = oldFeed();
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 4, "the tracks");

    expect(text(q("live-tracks"))).toContain("On-Duty tracks (4)");
    // the rows that need a look come first: location off, offline, then moving, then stationary
    expect(liveTracks().map((r) => r.dataset.state)).toEqual(["location_off", "offline", "moving", "stationary"]);

    const pill = (id: number) => text(trackRow(id).querySelector('[data-testid="live-state"]'));
    expect(pill(21)).toBe("Moving");
    expect(pill(22)).toBe("Stationary");
    expect(pill(23)).toBe("Offline");
    expect(pill(24)).toBe("Location off");

    const moving = text(trackRow(21));
    expect(moving).toContain("Moving Mani");
    expect(moving).toContain("Stitching");
    expect(moving).toContain("Buyer 21");
    expect(moving).toContain("Last seen 2 min ago");
    expect(moving).toContain("71%");
    expect(moving).toContain("wifi");
    expect(moving).toContain("tracking since 09:00");
    expect(text(trackRow(23))).toContain("Last seen 25 min ago");
    expect(text(trackRow(23))).toContain("none");
    // a battery nobody reported is not shown as 0
    expect(trackRow(24).querySelector('[data-testid="live-battery"]')).toBeNull();
  });

  it("shows where each request stands: pending (with the stage), approved, rejected", async () => {
    world.live = liveBoard();
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 4, "the tracks");
    const approval = (id: number) => text(trackRow(id).querySelector('[data-testid="live-approval"]'));
    expect(approval(21)).toBe("Awaiting Department Head");
    expect(approval(22)).toBe("Awaiting HR");
    expect(approval(23)).toBe("Approved");
    expect(approval(24)).toBe("Rejected");
  });

  it("counts the tracks by state and flags a simulated location", async () => {
    world.live = liveBoard();
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 4, "the tracks");
    expect(text(q("live-counts"))).toBe("1 moving 1 stationary 1 offline 1 location off");
    expect(text(trackRow(24))).toContain("Simulated");
  });

  it("opens the journey from the board: the Journey History tab with that journey", async () => {
    world.live = [liveRow(7, { employeeName: "Asha Kumar" })];
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 1, "the track");
    click(trackRow(7).querySelector('[data-testid="open-journey"]'));
    await waitFor(() => q("journey-detail") !== null, "the journey");
    expect(q("journey-detail")!.dataset.journeyId).toBe("7");
    expect(tab("Journey History").getAttribute("aria-selected")).toBe("true");
    expect(here()).toBe("/hr/geo-attendance?tab=journeys&journey=7");
  });

  it("opens the journey from a pin's popup too", async () => {
    world.live = [liveRow(7, { employeeName: "Asha Kumar" })];
    await open("?tab=map");
    await waitFor(() => all("live-popup").length === 1, "the pin");
    const popup = text(all("live-popup")[0]);
    expect(popup).toContain("Asha Kumar");
    expect(popup).toContain("Moving since 09:10");
    expect(popup).toContain("Battery 71%");
    expect(popup).toContain("1 stop");
    click(all("live-popup")[0].querySelector("button"));
    await waitFor(() => q("journey-detail") !== null, "the journey");
  });

  it("keeps the old list for the employees HR switched live tracking on for, and draws one pin per person", async () => {
    world.live = liveBoard();
    world.team = oldFeed();
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 4, "the tracks");
    const body = text(document.body);
    // the old list is unchanged: everybody HR switched on, with or without a position
    expect(body).toContain("Tracking-Enabled Employees (3)");
    expect(body).toContain("Toggle Tara");
    expect(body).toContain("Nofix Nila");
    expect(body).toContain("no signal yet");
    // on the map: the four tracks (new feed) and the one old position that nothing newer replaces (Tara); Mani's old pin is dropped
    const titled = markers().filter((m) => m.dataset.title);
    expect(titled).toHaveLength(4);
    const old = markers().filter((m) => !m.dataset.title);
    expect(old.map((m) => [m.dataset.lat, m.dataset.lng])).toEqual([["11.9", "77.9"]]);
  });

  it("keeps the old pin when the old position is the newer one", async () => {
    world.live = [liveRow(21, { employeeName: "Moving Mani", lastPointAt: minutesAgo(90) })];
    world.team = [{ ...oldFeed()[0], lastSeenAt: minutesAgo(1) }];
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 1, "the track");
    expect(markers().filter((m) => !m.dataset.title)).toHaveLength(1);
  });

  it("says nothing is being recorded when there are no tracks, and why when the board cannot load", async () => {
    await open("?tab=map");
    await waitFor(() => q("live-tracks-empty") !== null, "the empty note");
    expect(text(q("live-tracks-empty"))).toContain("No On-Duty journey is being recorded now");
    unmount();
    world.failing.set("/api/tracking/live", { status: 403, body: null });
    await open("?tab=map");
    await waitFor(() => q("live-tracks-error") !== null, "the error");
    expect(text(q("live-tracks-error"))).toContain("You are not allowed to see On-Duty tracks.");
    // the old board still works next to it
    expect(text(document.body)).toContain("Tracking-Enabled Employees");
  });

  it("picking a row moves the map to that person", async () => {
    world.live = liveBoard();
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 4, "the tracks");
    click(trackRow(22).querySelector("button"));
    await settle();
    // moved to the position of track 22 (11.22, 77.22)
    expect(mapSpy.setView).toHaveBeenCalledWith([11.22, 77.22], 14);
  });
});

const verification = (over: Raw = {}): Raw => ({
  id: 5,
  sessionId: 50,
  sessionStatus: "pending_hr",
  sessionApproved: false,
  sessionDestination: "Tirupur buyer visit",
  employeeId: 11,
  employeeCode: "E2E001",
  employeeName: "Asha Kumar",
  department: "Stitching",
  punchDate: "2026-10-28",
  punchTime: "10:15:00",
  punchType: "IN",
  punchNumber: 1,
  latitude: 11.02,
  longitude: 77.02,
  accuracyM: 12,
  isMocked: false,
  hasPhoto: true,
  hasPhoto2: true,
  status: "pending",
  hrReviewedBy: null,
  hrReviewComment: null,
  hrReviewedAt: null,
  createdAt: "2026-10-28T10:15:00+05:30",
  ...over,
});

/** Answers some of the page's other requests with what a test needs (the fake server returns no sessions and no branches). */
function answer(overrides: Record<string, unknown>) {
  const base = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    const path = url.split("?")[0];
    if (path in overrides) return JSON.parse(JSON.stringify(overrides[path]));
    return base(url, options);
  });
}

describe("the page frame", () => {
  it("has a title row with what the page is for, and says how many are on duty now", async () => {
    world.live = liveBoard();
    await open();
    expect(text(document.body.querySelector("h2"))).toContain("Geo Attendance");
    await waitFor(() => q("on-duty-now") !== null, "the chip");
    expect(text(document.body.querySelector("h2"))).toContain("4 on duty now");
    expect(text(q("on-duty-now"))).toBe("4 on duty now");
    expect(q("on-duty-now")!.dataset.count).toBe("4");
  });

  it("says so when nobody is on duty, and the chip leads to the Live Map", async () => {
    await open();
    await waitFor(() => q("on-duty-now") !== null, "the chip");
    expect(text(q("on-duty-now"))).toBe("No one on duty now");
    click(q("on-duty-now"));
    await settle(20);
    expect(tab("Live Map").getAttribute("aria-selected")).toBe("true");
    expect(here()).toBe("/hr/geo-attendance?tab=map");
  });

  it("shows no chip when the board cannot be read (a role that may not see the tracks)", async () => {
    world.failing.set("/api/tracking/live", { status: 403, body: null });
    await open();
    await settle(30);
    expect(q("on-duty-now")).toBeNull();
  });

  it("puts what waits for HR on the tabs as badges, read as 'pending' by a screen reader, and none when nothing waits", async () => {
    await open();
    expect(
      document.body.querySelectorAll('[role="tablist"]')[0].querySelectorAll('[data-testid="tab-badge"]'),
    ).toHaveLength(0);
    unmount();
    world.verifications = [verification({ id: 1 }), verification({ id: 2, sessionId: 51 })];
    answer({ "/api/on-duty-sessions": [{ id: 50, status: "pending_hr" }] });
    await open();
    await waitFor(() => document.body.querySelectorAll('[data-testid="tab-badge"]').length > 0, "the badges");
    const badge = (name: string) => tab(new RegExp(`^${name}`)).querySelector('[data-testid="tab-badge"]');
    expect(text(badge("On-Duty Approvals"))).toBe("1 pending");
    expect(text(badge("Punch Verifications"))).toBe("2 pending");
    expect(badge("Live Map")).toBeNull();
    // the tab's name is still the name the tests and the e2e find it by
    expect(tab(/^Punch Verifications/).getAttribute("role")).toBe("tab");
  });

  it("keeps the six tabs in one strip that scrolls sideways on a phone instead of pushing the page wider", async () => {
    await open();
    const strip = q("geo-tabs")!;
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.querySelectorAll('[role="tab"]')).toHaveLength(6);
  });
});

describe("the Live Map opens on Tiruppur, not on India", () => {
  const map = () => css('[data-testid="leaflet-map"]')!;

  it("is centred on Tiruppur at zoom 11 whatever the data says (the data used to decide: nothing loaded meant all of India)", async () => {
    await open("?tab=map");
    expect(JSON.parse(map().dataset.center!)).toEqual([11.1085, 77.3411]);
    expect(map().dataset.zoom).toBe("11");
    expect(text(document.body)).toContain("Tiruppur area (30 km)");
  });

  it("stays on Tiruppur when the first track is far away: the map is not moved by the data", async () => {
    world.live = [liveRow(21, { employeeName: "Far Farid", latitude: 13.0827, longitude: 80.2707 })]; // Chennai
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 1, "the track");
    expect(JSON.parse(map().dataset.center!)).toEqual([11.1085, 77.3411]);
    expect(map().dataset.zoom).toBe("11");
  });

  it("does not hard-lock the map: no bounds, no minimum zoom, free scrolling", async () => {
    await open("?tab=map");
    expect(map().dataset.maxBounds).toBeUndefined();
    expect(map().dataset.minZoom).toBeUndefined();
  });

  it("'Back to Tiruppur' brings the view back and 'Fit all' fits every pin on the map", async () => {
    world.live = [
      liveRow(21, { employeeName: "Near Nila", latitude: 11.12, longitude: 77.35 }),
      liveRow(22, { employeeName: "Near Nikhil", latitude: 11.0, longitude: 77.5 }),
    ];
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 2, "the tracks");
    resetMap();
    clickId("map-back-to-tiruppur");
    expect(mapSpy.setView).toHaveBeenCalledWith([11.1085, 77.3411], 11);
    clickId("map-fit-all");
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds] = mapSpy.fitBounds.mock.calls[0] as unknown as [[[number, number], [number, number]]];
    expect(bounds).toEqual([
      [11.0, 77.35],
      [11.12, 77.5],
    ]);
  });

  it("counts what lies outside the Tiruppur area and fits everything with one click, so nothing is lost off the edge", async () => {
    world.live = [
      liveRow(21, { employeeName: "Near Nila", latitude: 11.12, longitude: 77.35 }),
      liveRow(22, { employeeName: "Far Farid", latitude: 13.0827, longitude: 80.2707 }), // Chennai
    ];
    answer({
      "/api/branches": [
        { id: 1, name: "Erode Unit", geofenceLat: 11.341, geofenceLng: 77.7172, geofenceRadiusM: 150 },
        { id: 2, name: "Head Office", geofenceLat: 11.1085, geofenceLng: 77.3411, geofenceRadiusM: 200 },
      ],
    });
    await open("?tab=map");
    await waitFor(() => q("outside-chip") !== null, "the chip");
    expect(text(q("outside-chip"))).toContain("2 outside the Tiruppur area");
    // it names them, with how far they are, for the person hovering over it
    expect(q("outside-chip")!.title).toContain("Far Farid");
    expect(q("outside-chip")!.title).toContain("Erode Unit");
    expect(q("outside-chip")!.title).not.toContain("Head Office");
    resetMap();
    click(q("outside-chip"));
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds] = mapSpy.fitBounds.mock.calls[0] as unknown as [[[number, number], [number, number]]];
    expect(bounds[1][0]).toBeCloseTo(13.0827, 4); // the far track is inside the fitted window
    expect(bounds[1][1]).toBeCloseTo(80.2707, 4);
    // the company locations are on the map: a building pin and its radius each
    expect(all("circle")).toHaveLength(2);
  });

  it("has no chip when everything is inside the area", async () => {
    world.live = [liveRow(21, { latitude: 11.12, longitude: 77.35 })];
    await open("?tab=map");
    await waitFor(() => liveTracks().length === 1, "the track");
    expect(q("outside-chip")).toBeNull();
  });
});

describe("Punch Verifications: the photos", () => {
  const realFetch = globalThis.fetch;
  let imageUrls: string[];

  beforeEach(() => {
    imageUrls = [];
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:photo-${++n}`);
    URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(async (url: string) => {
      imageUrls.push(String(url));
      if (String(url).includes("broken")) return new Response("", { status: 404 });
      return new Response(new Blob(["jpeg"]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as never;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const openPhotos = async () => {
    await open("?tab=verifications");
    await waitFor(() => buttonNamed(/^Photo/) !== undefined, "the punch");
    click(buttonNamed(/^Photo/));
    await waitFor(() => all("punch-photo").length > 0, "the photos");
  };
  const dialog = () => css('[role="dialog"]')!;

  it("shows both photos of a two-photo punch, labelled Photo 1 and Photo 2, each fetched with the person's token", async () => {
    world.verifications = [verification()];
    await open("?tab=verifications");
    await waitFor(() => buttonNamed(/^Photo/) !== undefined, "the punch");
    expect(text(buttonNamed(/^Photo/)!)).toBe("Photos (2)");
    click(buttonNamed(/^Photo/));
    await waitFor(
      () => all("punch-photo").length === 2 && dialog().querySelectorAll("img").length === 2,
      "both photos",
    );
    expect(all("punch-photo").map((f) => f.dataset.label)).toEqual(["Photo 1", "Photo 2"]);
    expect(imageUrls.sort()).toEqual([
      "/api/on-duty-punch-verifications/5/photo",
      "/api/on-duty-punch-verifications/5/photo?n=2",
    ]);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]).toEqual({ headers: { Authorization: "Bearer tok123" } });
    expect(text(dialog())).toContain("Asha Kumar");
    expect(text(dialog())).toContain("punch #1 (check-in) at 10:15");
    expect(text(dialog())).toContain("Click a photo to enlarge it.");
  });

  it("enlarges a photo on a click and goes back to both", async () => {
    world.verifications = [verification()];
    await openPhotos();
    await waitFor(() => dialog().querySelectorAll("img").length === 2, "both photos");
    click(css('[aria-label="Enlarge Photo 2"]'));
    await settle();
    expect(all("punch-photo").map((f) => f.dataset.label)).toEqual(["Photo 2"]);
    expect(dialog().querySelector("img")!.className).toContain("object-contain");
    click(q("photos-back"));
    await settle();
    await waitFor(() => all("punch-photo").length === 2, "both photos again");
  });

  it("keeps working when there is only one photo: one photo, no Photo 1 / Photo 2 labels", async () => {
    world.verifications = [verification({ hasPhoto2: false })];
    await open("?tab=verifications");
    await waitFor(() => buttonNamed(/^Photo/) !== undefined, "the punch");
    expect(text(buttonNamed(/^Photo/)!)).toBe("Photo");
    click(buttonNamed(/^Photo/));
    await waitFor(() => dialog().querySelectorAll("img").length === 1, "the photo");
    expect(all("punch-photo").map((f) => f.dataset.label)).toEqual(["Photo"]);
    expect(imageUrls).toEqual(["/api/on-duty-punch-verifications/5/photo"]);
  });

  it("keeps working against a server that does not send hasPhoto2", async () => {
    const old = verification();
    delete old.hasPhoto2;
    world.verifications = [old];
    await open("?tab=verifications");
    await waitFor(() => buttonNamed(/^Photo/) !== undefined, "the punch");
    expect(text(buttonNamed(/^Photo/)!)).toBe("Photo");
  });

  it("says which photo could not be loaded and still shows the other", async () => {
    world.verifications = [verification({ id: 6 })];
    globalThis.fetch = vi.fn(async (url: string) => {
      imageUrls.push(String(url));
      return String(url).includes("n=2")
        ? new Response("", { status: 404 })
        : new Response(new Blob(["jpeg"]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as never;
    await open("?tab=verifications");
    await waitFor(() => buttonNamed(/^Photo/) !== undefined, "the punch");
    click(buttonNamed(/^Photo/));
    await waitFor(() => q("punch-photo-error") !== null, "the failure");
    expect(text(q("punch-photo-error"))).toBe("Photo 2 could not be loaded");
    expect(dialog().querySelectorAll("img")).toHaveLength(1);
  });

  it("says when a punch has no photo at all", async () => {
    world.verifications = [verification({ hasPhoto: false, hasPhoto2: false })];
    await open("?tab=verifications");
    await waitFor(() => buttonNamed(/^Photo/) !== undefined, "the punch");
    click(buttonNamed(/^Photo/));
    await waitFor(() => q("no-photo") !== null, "the note");
    expect(imageUrls).toEqual([]);
  });

  it("releases the photos when the dialog closes", async () => {
    world.verifications = [verification()];
    await openPhotos();
    await waitFor(() => dialog().querySelectorAll("img").length === 2, "both photos");
    click(css('[data-slot="dialog-close"], [role="dialog"] button[class*="absolute"]'));
    await settle(20);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});

describe("Tracking Settings", () => {
  it("shows the geo-tracking rules above the list of employees HR switched live tracking on for", async () => {
    await open("?tab=tracking");
    await waitFor(() => q("rules-card") !== null, "the rules");
    const rules = q("rules-card")!;
    const list = [...document.body.querySelectorAll("*")].find((e) => e.textContent === "Total Employees")!;
    // the rules come first in the page
    expect(rules.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text(rules)).toContain("Geo-tracking rules");
  });
});
