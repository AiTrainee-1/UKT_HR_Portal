import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RECENT,
  _resetPrefsCache,
  getLastQuery,
  getPrefs,
  pushRecent,
  setLastQuery,
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
  it("round-trips per report", () => {
    expect(getLastQuery("a")).toBeNull();
    setLastQuery("a", "period=2026-09");
    setLastQuery("b", "dateFrom=2026-09-01");
    expect(getLastQuery("a")).toBe("period=2026-09");
    expect(getLastQuery("b")).toBe("dateFrom=2026-09-01");
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
    _resetPrefsCache();
    expect(() => toggleFavorite("a")).not.toThrow();
    expect(getPrefs().favorites).toEqual(["a"]);
    expect(getLastQuery("a")).toBeNull();
    expect(() => setLastQuery("a", "x=1")).not.toThrow();
  });
});
