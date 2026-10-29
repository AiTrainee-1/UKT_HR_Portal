import { describe, expect, it } from "vitest";
import { geoAddress, readGeoAddress } from "./address";

// The open tab and journey of Geo Attendance live in the page address, so a journey can be linked to.

describe("reading the address", () => {
  it("opens the tab and the journey it names", () => {
    expect(readGeoAddress("?tab=journeys&journey=12")).toEqual({ tab: "journeys", journey: 12 });
    expect(readGeoAddress("?tab=map")).toEqual({ tab: "map", journey: null });
  });

  it("falls back to the first tab and no journey for anything unknown or malformed", () => {
    expect(readGeoAddress("")).toEqual({ tab: "approvals", journey: null });
    expect(readGeoAddress("?tab=nonsense&journey=abc")).toEqual({ tab: "approvals", journey: null });
    expect(readGeoAddress("?tab=journeys&journey=-4")).toEqual({ tab: "journeys", journey: null });
    expect(readGeoAddress("?tab=journeys&journey=1.5")).toEqual({ tab: "journeys", journey: null });
  });
});

describe("writing the address", () => {
  it("names the tab, and the journey only on the Journey History tab", () => {
    expect(geoAddress("", "journeys", 12)).toBe("?tab=journeys&journey=12");
    expect(geoAddress("", "journeys", null)).toBe("?tab=journeys");
    expect(geoAddress("?tab=journeys&journey=12", "map", 12)).toBe("?tab=map");
  });

  it("leaves the address clean on the first tab and keeps parameters that are not its own", () => {
    expect(geoAddress("?tab=map", "approvals", null)).toBe("");
    expect(geoAddress("?utm=x&tab=map", "tracking", null)).toBe("?utm=x&tab=tracking");
  });
});
