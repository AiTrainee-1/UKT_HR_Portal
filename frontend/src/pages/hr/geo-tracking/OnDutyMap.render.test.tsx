import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GeoAttendance from "../GeoAttendance";
import { DUTY_PALETTE } from "./dutyColors";
import { mapSpy, resetMap } from "./leafletMock";
import { todayIst } from "./dutyMap";
import {
  all,
  click,
  clickId,
  css,
  installBrowserStubs,
  installWorld,
  mount,
  newWorld,
  q,
  settle,
  text,
  typeAt,
  unmount,
  waitFor,
  type Raw,
  type World,
} from "./testing";

// The On-Duty Map tab in jsdom: every employee's journey on one map in a colour of their own, drawn like the Journey History map
// (route lines, numbered stop pins, a flag at the start, a person at the end), the list beside it as the legend (click = focus,
// the eye hides), the day's date, and an employee without a journey. The server is a small copy behind customFetch; the map is
// replaced by plain elements that carry what was asked for.

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
vi.mock("@/components/HrLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
const TODAY = todayIst();
const at = (hhmm: string, date = TODAY) => `${date}T${hhmm}:00+05:30`;

let world: World;
let calls: string[];
let dayMapFails: boolean;

const travel = (seqNo: number, from: string, to: string, line: [number, number][]): Raw => ({
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
});
const stop = (seqNo: number, from: string, to: string, lat: number, lng: number, minutes: number): Raw => ({
  seqNo,
  kind: "stop",
  startedAt: at(from),
  endedAt: at(to),
  durationS: minutes * 60,
  centerLat: lat,
  centerLng: lng,
  radiusM: 30,
});
const journey = (id: number, employeeId: number, name: string, segments: Raw[], over: Raw = {}): Raw => ({
  id,
  sessionId: 100 + id,
  employeeId,
  employeeCode: `E${employeeId}`,
  employeeName: name,
  department: "Stitching",
  destination: `Buyer ${id}`,
  startedAt: at("09:00"),
  endedAt: at("17:00"),
  status: "ended",
  state: "ended",
  distanceM: 4000,
  travelS: 3000,
  stopS: 1800,
  durationS: 28800,
  stopCount: 2,
  lastLatitude: 11.04,
  lastLongitude: 77.04,
  lastPointAt: at("16:59"),
  approvalStatus: "completed",
  segments,
  ...over,
});
const onDuty = (id: number, name: string, over: Raw = {}): Raw => ({
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

/** Asha (11): a finished day with a short stop and a long one. Ravi (12): still on the road. Meena (13): only old pings. Zoya (14): nothing. */
function dayFeeds(date: string) {
  const journeys =
    date === TODAY
      ? [
          journey(7, 11, "Asha Kumar", [
            travel(1, "09:00", "09:20", [
              [11.0, 77.0],
              [11.02, 77.02],
            ]),
            stop(2, "09:20", "09:32", 11.02, 77.02, 12),
            travel(3, "09:32", "10:00", [
              [11.02, 77.02],
              [11.04, 77.04],
            ]),
            stop(4, "10:00", "10:40", 11.04, 77.04, 40),
          ]),
          journey(
            8,
            12,
            "Ravi Nair",
            [
              travel(1, "09:30", "09:50", [
                [11.1, 77.3],
                [11.12, 77.32],
              ]),
              stop(2, "09:50", "09:55", 11.12, 77.32, 5),
            ],
            {
              status: "active",
              state: "moving",
              endedAt: null,
              approvalStatus: "active",
              distanceM: 4200,
              lastLatitude: 11.121,
              lastLongitude: 77.321,
              lastPointAt: new Date(Date.now() - 60_000).toISOString(),
              hasMock: false,
            },
          ),
        ]
      : [];
  const employees =
    date === TODAY
      ? [
          onDuty(11, "Asha Kumar", {
            punches: [{ punchNumber: 1, punchType: "IN", punchTime: "09:07:00", status: "approved" }],
            session: { id: 107, destination: "Buyer 7", status: "completed" },
          }),
          onDuty(12, "Ravi Nair"),
          onDuty(13, "Meena Devi", {
            latitude: 11.2,
            longitude: 77.4,
            lastSeenAt: at("12:00"),
            routePoints: [
              { latitude: 11.15, longitude: 77.35, recordedAt: at("11:00") },
              { latitude: 11.2, longitude: 77.4, recordedAt: at("12:00") },
            ],
          }),
          onDuty(14, "Zoya Khan"),
        ]
      : [];
  return { dayMap: { date, journeys }, onDutyMap: { date, employees } };
}

function installFeeds() {
  const base = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    const [path, query = ""] = url.split("?");
    const date = new URLSearchParams(query).get("date") ?? TODAY;
    if (path === "/api/tracking/journeys/day-map") {
      calls.push(`day-map ${date}`);
      if (dayMapFails) throw new Error("boom");
      return JSON.parse(JSON.stringify(dayFeeds(date).dayMap));
    }
    if (path === "/api/on-duty-map") {
      calls.push(`on-duty-map ${date}`);
      return JSON.parse(JSON.stringify(dayFeeds(date).onDutyMap));
    }
    return base(url, options);
  });
}

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  resetMap();
  h.user.current = SUPER;
  calls = [];
  dayMapFails = false;
  world = installWorld(h.fetch, newWorld());
  installFeeds();
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
  vi.restoreAllMocks();
});

const open = async () => {
  mount("/hr/geo-attendance?tab=onduty", GeoAttendance);
  await waitFor(() => all("duty-row").length > 0, "the employees");
  await settle(20);
};
const rows = () => all("duty-row");
const rowOf = (name: string) => rows().find((r) => text(r).includes(name))!;
const markers = () => all("marker");
const pinsOf = (name: string) => markers().filter((m) => (m.dataset.title ?? "").startsWith(`${name}:`));
const linesOf = (color: string) => all("polyline").filter((l) => l.dataset.color === color);

describe("the list is the legend", () => {
  it("has one row per employee of the day, by name, each with a colour of its own", async () => {
    await open();
    expect(rows().map((r) => text(r.querySelector("p")).replace(/\s*E\d+$/, ""))).toEqual([
      "Asha Kumar",
      "Meena Devi",
      "Ravi Nair",
      "Zoya Khan",
    ]);
    const colors = rows().map((r) => r.dataset.color);
    expect(new Set(colors).size).toBe(4);
    for (const c of colors) expect(DUTY_PALETTE).toContain(c);
    // the same colour is on the row's swatch (jsdom writes a colour as rgb(...))
    const rgb = (hex: string) =>
      `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    expect(rows().map((r) => (r.querySelector('[data-testid="duty-swatch"]') as HTMLElement).style.background)).toEqual(
      colors.map((c) => rgb(c!)),
    );
  });

  it("says in a line what each journey was: distance, stops, time, the stage of the request and the punches", async () => {
    await open();
    const asha = text(rowOf("Asha Kumar"));
    expect(asha).toContain("4.00 km");
    expect(asha).toContain("2 stops");
    expect(asha).toContain("8 h");
    expect(asha).toContain("Journey ended");
    expect(asha).toContain("ended 17:00"); // a finished journey says when it ended, not when it was "last seen"
    expect(asha).toContain("Completed");
    expect(asha).toContain("#1 IN 09:07 · Approved");
    const ravi = text(rowOf("Ravi Nair"));
    expect(ravi).toContain("Moving");
    expect(ravi).toContain("1 stop");
    expect(ravi).toContain("last seen 1 min ago");
    expect(text(q("duty-summary-chips"))).toContain("4 employees");
    expect(text(q("duty-summary-chips"))).toContain("1 on the road now");
  });

  it("says when an employee has no route, and does not draw a pin for them", async () => {
    await open();
    expect(text(rowOf("Zoya Khan"))).toContain("No route recorded");
    expect(pinsOf("Zoya Khan")).toEqual([]);
  });

  it("is keyboard friendly: a row is a button that can be pressed with Enter", async () => {
    await open();
    const row = rowOf("Asha Kumar");
    expect(row.getAttribute("role")).toBe("button");
    expect(row.tabIndex).toBe(0);
  });
});

describe("the map: every journey in its employee's colour, drawn like the Journey History map", () => {
  it("draws the route of each employee as lines in their colour, with a white casing under each", async () => {
    await open();
    const asha = rowOf("Asha Kumar").dataset.color!;
    const ravi = rowOf("Ravi Nair").dataset.color!;
    expect(linesOf(asha)).toHaveLength(2); // two drives
    expect(linesOf(ravi)).toHaveLength(1);
    expect(all("trail-run").filter((l) => l.dataset.color === "#ffffff").length).toBe(3); // a casing under each drive
    expect(linesOf(asha)[0].dataset.weight).toBe("4");
  });

  it("numbers the stops with pins in the employee's colour, larger for a long stop", async () => {
    await open();
    const asha = rowOf("Asha Kumar").dataset.color!;
    const stops = pinsOf("Asha Kumar").filter((m) => m.dataset.pin === "stop");
    expect(stops.map((m) => m.dataset.title)).toEqual(["Asha Kumar: stop 1", "Asha Kumar: stop 2"]);
    expect(stops.every((m) => m.dataset.color === asha)).toBe(true);
  });

  it("puts a flag at the start and a person at the end, in the same colour: the shapes are the same for everybody", async () => {
    await open();
    for (const name of ["Asha Kumar", "Ravi Nair"]) {
      const color = rowOf(name).dataset.color!;
      const flag = pinsOf(name).find((m) => m.dataset.pin === "flag")!;
      const person = pinsOf(name).find((m) => m.dataset.pin === "person")!;
      expect(flag.dataset.color, `${name}'s flag`).toBe(color);
      expect(person.dataset.color, `${name}'s person`).toBe(color);
    }
    expect(pinsOf("Asha Kumar").find((m) => m.dataset.pin === "person")!.dataset.title).toBe("Asha Kumar: end");
    // the journey that is still recording ends at where the employee is now
    const now = pinsOf("Ravi Nair").find((m) => m.dataset.pin === "person")!;
    expect(now.dataset.title).toBe("Ravi Nair: latest position");
    expect([now.dataset.lat, now.dataset.lng]).toEqual(["11.121", "77.321"]);
  });

  it("keeps an employee without a journey as the old plain line, with a flag and a person", async () => {
    await open();
    const meena = rowOf("Meena Devi").dataset.color!;
    expect(linesOf(meena)).toHaveLength(1);
    expect(linesOf(meena)[0].dataset.points).toBe("2");
    expect(
      pinsOf("Meena Devi")
        .map((m) => m.dataset.pin)
        .sort(),
    ).toEqual(["flag", "person"]);
  });

  it("opens fitted to everybody, once, and does not move the map again when the board refreshes", async () => {
    await open();
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds] = mapSpy.fitBounds.mock.calls[0] as unknown as [[[number, number], [number, number]]];
    expect(bounds[0][0]).toBeCloseTo(11.0, 5); // the south-west corner: Asha's start
    expect(bounds[0][1]).toBeCloseTo(77.0, 5);
    expect(bounds[1][0]).toBeCloseTo(11.2, 5); // the north-east corner: Meena's last ping
    expect(bounds[1][1]).toBeCloseTo(77.4, 5);
    await settle(50);
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
  });
});

describe("focus and hide", () => {
  it("clicking a row focuses that employee: the map fits their journey and the row is pressed", async () => {
    await open();
    mapSpy.fitBounds.mockClear();
    click(rowOf("Asha Kumar"));
    await settle();
    expect(rowOf("Asha Kumar").getAttribute("aria-pressed")).toBe("true");
    expect(rowOf("Ravi Nair").getAttribute("aria-pressed")).toBe("false");
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds] = mapSpy.fitBounds.mock.calls[0] as unknown as [[[number, number], [number, number]]];
    expect(bounds[1][0]).toBeCloseTo(11.04, 5); // Asha's own journey, not everybody's
    expect(bounds[1][1]).toBeCloseTo(77.04, 5);
    expect(q("duty-show-all")).not.toBeNull();
  });

  it("clicking the focused row again lets go, and Show everyone fits everybody again", async () => {
    await open();
    click(rowOf("Asha Kumar"));
    await settle();
    click(rowOf("Asha Kumar"));
    await settle();
    expect(rowOf("Asha Kumar").getAttribute("aria-pressed")).toBe("false");
    expect(q("duty-show-all")).toBeNull();
    click(rowOf("Ravi Nair"));
    await settle();
    mapSpy.fitBounds.mockClear();
    clickId("duty-show-all");
    await settle();
    expect(rowOf("Ravi Nair").getAttribute("aria-pressed")).toBe("false");
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("the eye hides one employee from the map and brings them back, without touching the list", async () => {
    await open();
    const before = markers().length;
    const ravi = rowOf("Ravi Nair");
    click(ravi.querySelector('[data-testid="duty-toggle"]'));
    await settle();
    expect(rowOf("Ravi Nair").dataset.hidden).toBe("true");
    expect(pinsOf("Ravi Nair")).toEqual([]);
    expect(linesOf(ravi.dataset.color!)).toEqual([]);
    expect(markers().length).toBeLessThan(before);
    expect(rows()).toHaveLength(4); // still listed
    expect(text(q("tab-onduty-map"))).toContain("1 hidden");
    // pressing the eye does not also focus the row
    expect(rowOf("Ravi Nair").getAttribute("aria-pressed")).toBe("false");
    click(rowOf("Ravi Nair").querySelector('[data-testid="duty-toggle"]'));
    await settle();
    expect(rowOf("Ravi Nair").dataset.hidden).toBe("false");
    expect(pinsOf("Ravi Nair").length).toBeGreaterThan(0);
  });

  it("a click on a pin focuses its employee without moving the map", async () => {
    await open();
    mapSpy.fitBounds.mockClear();
    mapSpy.setView.mockClear();
    click(pinsOf("Ravi Nair").find((m) => m.dataset.pin === "stop")!);
    await settle();
    expect(rowOf("Ravi Nair").getAttribute("aria-pressed")).toBe("true");
    expect(mapSpy.fitBounds).not.toHaveBeenCalled();
    expect(mapSpy.setView).not.toHaveBeenCalled();
  });
});

describe("the map's own buttons", () => {
  it("Back to Tiruppur moves the map to the Tiruppur window and Fit all to everything drawn", async () => {
    await open();
    mapSpy.setView.mockClear();
    mapSpy.fitBounds.mockClear();
    clickId("map-back-to-tiruppur");
    expect(mapSpy.setView).toHaveBeenCalledWith([11.1085, 77.3411], 11);
    clickId("map-fit-all");
    expect(mapSpy.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("opens on the Tiruppur window, and shows what the pins mean", async () => {
    await open();
    const map = css('[data-testid="leaflet-map"]')!;
    expect(JSON.parse(map.dataset.center!)).toEqual([11.1085, 77.3411]);
    expect(map.dataset.zoom).toBe("11");
    expect(text(q("pin-guide"))).toContain("Long stop (15 min or more)");
  });
});

describe("the day", () => {
  it("opens on today (India), asks both feeds for it, and asks again for another day", async () => {
    await open();
    expect(calls).toContain(`on-duty-map ${TODAY}`);
    expect(calls).toContain(`day-map ${TODAY}`);
    typeAt('input[type="date"]', "2026-10-20");
    await waitFor(() => q("duty-empty") !== null, "the empty day");
    expect(calls).toContain("on-duty-map 2026-10-20");
    expect(calls).toContain("day-map 2026-10-20");
    expect(text(q("duty-empty"))).toBe("No employees were On-Duty on 2026-10-20.");
    expect(text(q("duty-map-empty"))).toContain("No live positions to show for On-Duty staff on 2026-10-20.");
    // the map is still there, on Tiruppur, so the page does not collapse
    expect(JSON.parse(css('[data-testid="leaflet-map"]')!.dataset.center!)).toEqual([11.1085, 77.3411]);
  });

  it("cannot look into the future", async () => {
    await open();
    expect((css('input[type="date"]') as HTMLInputElement).max).toBe(TODAY);
  });
});

describe("when the journeys cannot be loaded", () => {
  it("still lists the employees of the day, says so, and draws what the old feed has", async () => {
    dayMapFails = true;
    await open();
    expect(rows()).toHaveLength(4);
    expect(text(q("duty-journeys-error"))).toContain("The recorded journeys could not be loaded");
    expect(linesOf(rowOf("Meena Devi").dataset.color!)).toHaveLength(1);
  });
});

describe("the Single Employee view", () => {
  it("is still there: pick an employee and their route is drawn as one line with a flag and a person", async () => {
    await open();
    const single = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
      /Single Employee/.test(t.textContent ?? ""),
    )!;
    click(single);
    await waitFor(() => q("onduty-single") !== null, "the single view");
    expect(text(q("single-empty"))).toContain("Select an employee to view their travel route.");
  });
});
