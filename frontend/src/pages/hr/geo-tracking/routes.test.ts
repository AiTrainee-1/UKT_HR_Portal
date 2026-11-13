import { describe, expect, it } from "vitest";
import { moduleForPath } from "@/lib/permission-modules";
import {
  GEO_SECTIONS,
  GEO_SECTION_KEY,
  GEO_SECTION_LABEL,
  geoPath,
  journeyPath,
  readGeoRoute,
  simulatePath,
} from "./routes";

// Geo Attendance has one address per section; the addresses of the old single page are sent on to the new ones.

const route = (path: string, search = "") => readGeoRoute(path, search).route;
const redirect = (path: string, search = "") => readGeoRoute(path, search).redirect;

describe("the address of each section", () => {
  it("names every section, a journey and its replay", () => {
    expect(GEO_SECTIONS.map((s) => geoPath(s))).toEqual([
      "/hr/geo-attendance/approvals",
      "/hr/geo-attendance/verifications",
      "/hr/geo-attendance/live-map",
      "/hr/geo-attendance/journeys",
      "/hr/geo-attendance/on-duty-map",
      "/hr/geo-attendance/settings",
    ]);
    expect(journeyPath(12)).toBe("/hr/geo-attendance/journeys/12");
    expect(simulatePath(12)).toBe("/hr/geo-attendance/journeys/12/simulate");
    expect(geoPath("live-map", 12)).toBe("/hr/geo-attendance/live-map"); // a journey belongs to Journey History only
    expect(GEO_SECTION_LABEL["live-map"]).toBe("Live Map");
  });

  it("reads every section back from its address", () => {
    for (const s of GEO_SECTIONS) expect(route(geoPath(s))).toEqual({ section: s, journey: null, view: "list" });
    expect(route("/hr/geo-attendance/journeys/12")).toEqual({ section: "journeys", journey: 12, view: "journey" });
    expect(route("/hr/geo-attendance/journeys/12/simulate")).toEqual({
      section: "journeys",
      journey: 12,
      view: "simulate",
    });
    // the router ignores case and a trailing slash, so this does too
    expect(route("/HR/Geo-Attendance/Live-Map/")).toEqual({ section: "live-map", journey: null, view: "list" });
  });
});

describe("the old single page's addresses keep working", () => {
  it("the bare page opens On-Duty Approvals", () => {
    expect(redirect("/hr/geo-attendance")).toBe("/hr/geo-attendance/approvals");
    expect(redirect("/hr/geo-attendance/")).toBe("/hr/geo-attendance/approvals");
  });

  it("every old tab goes to its section", () => {
    expect(redirect("/hr/geo-attendance", "?tab=approvals")).toBe("/hr/geo-attendance/approvals");
    expect(redirect("/hr/geo-attendance", "?tab=verifications")).toBe("/hr/geo-attendance/verifications");
    expect(redirect("/hr/geo-attendance", "?tab=map")).toBe("/hr/geo-attendance/live-map");
    expect(redirect("/hr/geo-attendance", "?tab=journeys")).toBe("/hr/geo-attendance/journeys");
    expect(redirect("/hr/geo-attendance", "?tab=onduty")).toBe("/hr/geo-attendance/on-duty-map");
    expect(redirect("/hr/geo-attendance", "?tab=tracking")).toBe("/hr/geo-attendance/settings");
    expect(redirect("/hr/geo-attendance", "?tab=nonsense")).toBe("/hr/geo-attendance/approvals");
  });

  it("an old journey link opens that journey, and a malformed one the list", () => {
    expect(redirect("/hr/geo-attendance", "?tab=journeys&journey=12")).toBe("/hr/geo-attendance/journeys/12");
    expect(redirect("/hr/geo-attendance", "?tab=journeys&journey=abc")).toBe("/hr/geo-attendance/journeys");
    expect(redirect("/hr/geo-attendance", "?tab=journeys&journey=-4")).toBe("/hr/geo-attendance/journeys");
    expect(redirect("/hr/geo-attendance", "?tab=journeys&journey=1.5")).toBe("/hr/geo-attendance/journeys");
    expect(redirect("/hr/geo-attendance", "?tab=map&journey=12")).toBe("/hr/geo-attendance/live-map");
    expect(redirect("/hr/geo-attendance/journeys", "?journey=7")).toBe("/hr/geo-attendance/journeys/7");
  });

  it("keeps any other parameter of the address", () => {
    expect(redirect("/hr/geo-attendance", "?utm=wa&tab=map")).toBe("/hr/geo-attendance/live-map?utm=wa");
    expect(redirect("/hr/geo-attendance", "?tab=journeys&journey=3&focus=9")).toBe(
      "/hr/geo-attendance/journeys/3?focus=9",
    );
  });

  it("an old tab name, an unknown section or a stray tail goes to the right place", () => {
    expect(redirect("/hr/geo-attendance/map")).toBe("/hr/geo-attendance/live-map");
    expect(redirect("/hr/geo-attendance/tracking")).toBe("/hr/geo-attendance/settings");
    expect(redirect("/hr/geo-attendance/onduty")).toBe("/hr/geo-attendance/on-duty-map");
    expect(redirect("/hr/geo-attendance/nonsense")).toBe("/hr/geo-attendance/approvals");
    expect(redirect("/hr/geo-attendance/live-map/extra")).toBe("/hr/geo-attendance/live-map");
    expect(redirect("/hr/geo-attendance/journeys/abc")).toBe("/hr/geo-attendance/journeys");
    expect(redirect("/hr/geo-attendance/journeys/12/whatever")).toBe("/hr/geo-attendance/journeys/12");
  });
});

describe("the sections a role may see (Account Management -> Roles & Permissions)", () => {
  const land = (path: string, search: string, visible: (typeof GEO_SECTIONS)[number][]) =>
    readGeoRoute(path, search, visible).redirect;

  it("gives each section the key of its own address", () => {
    for (const s of GEO_SECTIONS) expect(moduleForPath(geoPath(s)), s).toBe(GEO_SECTION_KEY[s]);
  });

  it("lands on the first section the role may see, not on a hidden one", () => {
    expect(land("/hr/geo-attendance", "", ["live-map", "journeys"])).toBe("/hr/geo-attendance/live-map");
    expect(land("/hr/geo-attendance/nonsense", "", ["journeys"])).toBe("/hr/geo-attendance/journeys");
    // an old ?tab= or an old section name: there when the role may see it, else the first it may see
    expect(land("/hr/geo-attendance", "?tab=map&x=1", ["approvals", "live-map"])).toBe(
      "/hr/geo-attendance/live-map?x=1",
    );
    expect(land("/hr/geo-attendance", "?tab=map", ["approvals", "settings"])).toBe("/hr/geo-attendance/approvals");
    expect(land("/hr/geo-attendance/map", "", ["settings"])).toBe("/hr/geo-attendance/settings");
    // an old journey link when Journey History is hidden goes to the first section without the journey
    expect(land("/hr/geo-attendance", "?tab=journeys&journey=3", ["verifications"])).toBe(
      "/hr/geo-attendance/verifications",
    );
  });

  it("changes nothing when every section may be seen, or when the list is left out", () => {
    expect(land("/hr/geo-attendance", "", [...GEO_SECTIONS])).toBe("/hr/geo-attendance/approvals");
    expect(readGeoRoute("/hr/geo-attendance/live-map", "", ["approvals"]).route?.section).toBe("live-map");
    expect(readGeoRoute("/hr/geo-attendance", "").redirect).toBe("/hr/geo-attendance/approvals");
  });
});
