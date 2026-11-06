import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GeoAttendance from "../../GeoAttendance";
import { resetMap } from "../leafletMock";
import {
  all,
  click,
  clickId,
  installBrowserStubs,
  installWorld,
  mount,
  newWorld,
  q,
  settle,
  text,
  unmount,
  waitFor,
  IST,
  type World,
} from "../testing";

// The Journey Simulation page in jsdom (react-leaflet replaced by plain elements; the replay's own map is plain Leaflet on a
// stand-in map, so nothing is drawn): what it says about the journey, the stops, the controls and their states, a journey
// with nothing to replay, and step-through for a device that asks for less motion. The arithmetic is playback.test.ts.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  reduced: { current: false },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "tok123", user: { role: "hr", isSuperAdmin: true, permissions: {} } }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("react-leaflet", async () => (await import("../leafletMock")).leafletMock);
vi.mock("@/components/HrLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

let world: World;

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  resetMap();
  h.reduced.current = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("reduce") ? h.reduced.current : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  world = installWorld(h.fetch, newWorld());
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
});

const open = async (id = 7) => {
  mount(`/hr/geo-attendance/journeys/${id}/simulate`, GeoAttendance);
  await settle(40);
  await waitFor(() => q("journey-simulation") !== null || q("sim-error") !== null, "the simulation page");
};

describe("Journey Simulation", () => {
  it("names the journey and shows its figures as the journey page does: distance, duration, stops, gaps", async () => {
    await open();
    expect(text(q("sim-hero"))).toContain("Asha Kumar");
    expect(text(q("sim-hero"))).toContain("Tirupur buyer visit");
    const summary = text(q("sim-summary"));
    expect(summary).toContain("14.25 km"); // summary.distanceM of the journey
    expect(summary).toContain("Top speed 62 km/h");
    expect(summary).toContain("2 · 1 h"); // two stops, an hour stationary
    expect(summary).toContain("1 gap in the positions");
    expect(q("journey-simulation")!.dataset.points).toBe("28"); // the recorded positions the route uses
  });

  it("lists the stops with their arrival, departure and how long they lasted, and a click jumps to the arrival", async () => {
    await open();
    const rows = all("sim-stop-row");
    expect(rows).toHaveLength(2);
    expect(text(rows[0])).toContain("Arrived 09:30");
    expect(text(rows[0])).toContain("left 09:38");
    expect(text(rows[0])).toContain("8 min");
    expect(text(rows[1])).toContain("Buyer office, Avinashi Road");
    expect(text(rows[1])).toContain("25 min");
    click(rows[1]);
    await settle(5);
    expect(text(q("sim-clock"))).toContain("10:25:00");
    expect(text(q("sim-status"))).toBe("At stop 2");
    expect(all("sim-stop-row")[1].dataset.current).toBe("true");
  });

  it("starts at the first recorded position, plays, pauses, resumes, stops and replays", async () => {
    await open();
    expect(text(q("sim-clock"))).toContain("09:05:00");
    expect(text(q("sim-status"))).toBe("Start");
    expect((q("sim-stop") as HTMLButtonElement).disabled).toBe(true);
    clickId("sim-play");
    await settle(5);
    expect(q("sim-pause")).not.toBeNull();
    clickId("sim-pause");
    await settle(5);
    expect(text(q("sim-play"))).toContain("Resume");
    clickId("sim-stop");
    await settle(5);
    expect(text(q("sim-clock"))).toContain("09:05:00");
    expect(text(q("sim-play"))).toContain("Play");
    clickId("sim-replay");
    await settle(5);
    expect(q("sim-pause")).not.toBeNull();
    clickId("sim-pause");
  });

  it("steps from one stop or gap to the next, and the scrubber's keys move it too", async () => {
    await open();
    clickId("sim-step-forward");
    await settle(5);
    expect(text(q("sim-clock"))).toContain("09:30:00");
    expect(text(q("sim-status"))).toBe("At stop 1");
    clickId("sim-step-forward");
    await settle(5);
    expect(text(q("sim-clock"))).toContain("09:37:00"); // the signal is lost after the last fix of stop 1
    expect(text(q("sim-status"))).toBe("No location");
    clickId("sim-step-back");
    await settle(5);
    expect(text(q("sim-clock"))).toContain("09:30:00");
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!;
    act(() => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    await settle(5);
    expect(text(q("sim-clock"))).toContain("11:30:00");
    expect(text(q("sim-status"))).toBe("Journey end");
    expect(text(q("sim-distance"))).toContain("14.25 km of 14.25 km");
  });

  it("shows where the stops and the gap lie on the bar, and changes the speed", async () => {
    await open();
    const bands = [...document.querySelectorAll<HTMLElement>("[data-band]")].map((b) => b.dataset.band);
    expect(bands).toEqual(["stop", "gap", "stop"]);
    const select = q("sim-speed") as HTMLSelectElement;
    act(() => {
      select.value = "x-10";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle(5);
    expect(text(q("sim-speed-note"))).toContain("10×");
  });

  it("offers step-through first when the device asks for less motion, and Play still animates on request", async () => {
    h.reduced.current = true;
    await open();
    expect(text(q("sim-play"))).toContain("Play anyway");
    expect(text(q("sim-speed-note"))).toContain("asks for less motion");
  });

  it("says so when there is nothing to replay, and keeps the buttons off", async () => {
    world.trails[7] = { trackId: 7, source: "points", total: 0, count: 0, truncated: false, points: [] };
    world.details[7] = { ...(world.details[7] as Record<string, unknown>), path: [] };
    await open();
    expect(q("sim-empty")).not.toBeNull();
    expect((q("sim-play") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("sim-speed-note"))).toContain("nothing to replay");
  });

  it("one recorded position: the marker stands there and there is nothing to play", async () => {
    world.trails[7] = {
      trackId: 7,
      source: "points",
      points: [{ t: Date.parse(IST("09:05")), lat: 11, lng: 77, used: true }],
    };
    await open();
    expect((q("sim-play") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("sim-speed-note"))).toContain("Only one position was recorded");
  });

  it("a journey still being recorded says the replay ends at the latest position", async () => {
    await open(8);
    expect(text(q("sim-live-note"))).toContain("still being recorded");
    expect(text(q("sim-summary"))).toContain("Latest position");
  });

  it("a journey that does not exist says so, with a way back", async () => {
    await open(404);
    expect(text(q("sim-error"))).toContain("This journey was not found.");
    clickId("sim-back");
    await settle(10);
    expect(window.location.pathname).toBe("/hr/geo-attendance/journeys");
  });
});
