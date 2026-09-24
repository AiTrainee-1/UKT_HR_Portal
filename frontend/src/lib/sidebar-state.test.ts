import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "hr_sidebar_collapsed";

async function load() {
  vi.resetModules();
  return import("./sidebar-state");
}

describe("sidebar-state", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reads the saved preference synchronously on first load", async () => {
    localStorage.setItem(KEY, "1");
    const mod = await load();
    // Already collapsed: setting it again is a no-op, so the toggle flips it back.
    mod.setSidebarCollapsed(true);
    mod.toggleSidebarCollapsed();
    expect(localStorage.getItem(KEY)).toBe("0");
  });

  it("persists a change to localStorage", async () => {
    const mod = await load();
    mod.setSidebarCollapsed(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    mod.toggleSidebarCollapsed();
    expect(localStorage.getItem(KEY)).toBe("0");
  });

  it("stays in memory when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mod = await load();
    expect(() => mod.setSidebarCollapsed(true)).not.toThrow();
  });

  it("falls back to expanded when storage cannot be read", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mod = await load();
    mod.setSidebarCollapsed(false);
    vi.restoreAllMocks();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("follows changes made in another tab", async () => {
    const mod = await load();
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "1" }));
    // The store now holds "collapsed", so a toggle expands it.
    mod.toggleSidebarCollapsed();
    expect(localStorage.getItem(KEY)).toBe("0");
  });
});
