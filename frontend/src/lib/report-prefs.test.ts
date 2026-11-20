import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RECENT,
  _resetPrefsCache,
  getLastFilters,
  getPrefs,
  pushRecent,
  setLastFilters,
  toggleFavorite,
} from "./report-prefs";

beforeEach(() => {
  localStorage.clear();
  _resetPrefsCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("favourites", () => {
  it("stars and un-stars, newest first, and persists", () => {
    toggleFavorite("a");
    toggleFavorite("b");
    expect(getPrefs().favorites).toEqual(["b", "a"]);
    toggleFavorite("a");
    expect(getPrefs().favorites).toEqual(["b"]);
    _resetPrefsCache();
    expect(getPrefs().favorites).toEqual(["b"]);
  });
});

describe("recents", () => {
  it("keeps most recent first without duplicates and caps the list", () => {
    for (let i = 0; i < MAX_RECENT + 3; i++) pushRecent(`r${i}`);
    expect(getPrefs().recents).toHaveLength(MAX_RECENT);
    expect(getPrefs().recents[0]).toBe(`r${MAX_RECENT + 2}`);
    pushRecent("r5");
    expect(getPrefs().recents[0]).toBe("r5");
    expect(getPrefs().recents.filter((r) => r === "r5")).toHaveLength(1);
  });

  it("does not rewrite storage when the same report is re-opened", () => {
    pushRecent("x");
    const spy = vi.spyOn(Storage.prototype, "setItem");
    pushRecent("x");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("last used filters", () => {
  it("round-trips per report and forgets on null", () => {
    expect(getLastFilters("a")).toBeNull();
    setLastFilters("a", { query: "departmentIds=3", relative: { period: "lastMonth" } });
    setLastFilters("b", { query: "", relative: { dateRange: "week" } });
    expect(getLastFilters("a")).toEqual({ query: "departmentIds=3", relative: { period: "lastMonth" } });
    expect(getLastFilters("b")).toEqual({ query: "", relative: { dateRange: "week" } });
    setLastFilters("a", null);
    expect(getLastFilters("a")).toBeNull();
    expect(localStorage.getItem("hr_reports_last:a")).toBeNull();
  });

  it("reads an entry from before relative dates as a plain query (its dates are ignored when restoring)", () => {
    localStorage.setItem("hr_reports_last:old", "period=2026-09&departmentIds=3");
    expect(getLastFilters("old")).toEqual({ query: "period=2026-09&departmentIds=3", relative: {} });
  });

  it("survives a damaged entry", () => {
    localStorage.setItem("hr_reports_last:bad", "{not json");
    expect(getLastFilters("bad")).toBeNull();
    localStorage.setItem(
      "hr_reports_last:odd",
      JSON.stringify({ query: 5, relative: { period: 1, year: "thisYear" } }),
    );
    expect(getLastFilters("odd")).toEqual({ query: "", relative: { year: "thisYear" } });
    localStorage.setItem("hr_reports_last:nul", JSON.stringify({ relative: null }));
    expect(getLastFilters("nul")).toEqual({ query: "", relative: {} });
  });
});

describe("resilience", () => {
  it("survives corrupt stored data", () => {
    localStorage.setItem("hr_reports_favorites", "{not json");
    localStorage.setItem("hr_reports_recent", JSON.stringify(["ok", 5, null, { x: 1 }]));
    _resetPrefsCache();
    expect(getPrefs()).toEqual({ favorites: [], recents: ["ok"] });
  });

  it("keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    _resetPrefsCache();
    expect(() => toggleFavorite("a")).not.toThrow();
    expect(getPrefs().favorites).toEqual(["a"]);
    expect(getLastFilters("a")).toBeNull();
    expect(() => setLastFilters("a", { query: "x=1", relative: {} })).not.toThrow();
    expect(() => setLastFilters("a", null)).not.toThrow();
  });
});
