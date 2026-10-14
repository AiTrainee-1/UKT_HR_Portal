import { describe, expect, it } from "vitest";
import { allModuleKeys } from "@/lib/permission-modules";
import { SETTINGS_TAB_MODULE } from "./constants";
import { SETTINGS_GROUPS } from "./kit/catalog";
import { ALL_SETTINGS } from "./metas";
import { SETTINGS_TABS, SETTINGS_TAB_COMPONENTS } from "./tabs";

// The Settings tab registry: every tab is in one group, has a permission key the Account Management role editor knows, a
// component, and search entries that point at it.

describe("the Settings tab registry", () => {
  it("puts every tab in a known group, with a purpose and a permission key that exists", () => {
    const groups = new Set(SETTINGS_GROUPS.map((g) => g.id));
    const modules = new Set(allModuleKeys());
    const ids = SETTINGS_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of SETTINGS_TABS) {
      expect(groups.has(tab.group), `${tab.id} group`).toBe(true);
      expect(tab.purpose.length, `${tab.id} purpose`).toBeGreaterThan(30);
      expect(SETTINGS_TAB_MODULE[tab.id], `${tab.id} permission key`).toBeTruthy();
      expect(
        modules.has(SETTINGS_TAB_MODULE[tab.id]),
        `${tab.id} -> ${SETTINGS_TAB_MODULE[tab.id]} is a known module`,
      ).toBe(true);
      expect(SETTINGS_TAB_COMPONENTS[tab.id], `${tab.id} component`).toBeDefined();
    }
    expect(Object.keys(SETTINGS_TAB_MODULE).sort()).toEqual([...ids].sort());
  });

  it("has search entries only for tabs that exist, with ids that are unique within their tab", () => {
    const ids = new Set(SETTINGS_TABS.map((t) => t.id));
    const seen = new Set<string>();
    for (const meta of ALL_SETTINGS) {
      expect(ids.has(meta.tab), `${meta.id} -> tab ${meta.tab}`).toBe(true);
      const key = `${meta.tab}#${meta.id}`;
      expect(seen.has(key), `${key} is listed once`).toBe(false);
      seen.add(key);
    }
  });

  it("registers the Compensation tab with the attendance and time group, its own permission key and its links", () => {
    const tab = SETTINGS_TABS.find((t) => t.id === "compensation");
    expect(tab).toBeDefined();
    expect(tab?.label).toBe("Compensation");
    expect(tab?.group).toBe("time");
    expect(SETTINGS_TAB_MODULE.compensation).toBe("settings.compensation");
    expect(tab?.usedBy.map((u) => u.to).filter(Boolean)).toEqual([
      "/hr/compensation",
      "/hr/attendance/staff",
      "/hr/payroll",
    ]);
    expect(tab?.purpose).toContain("Staff only");
    // it sits with the late and early detection tabs, after Late Detection
    const order = SETTINGS_TABS.filter((t) => t.group === "time").map((t) => t.id);
    expect(order.indexOf("compensation")).toBe(order.indexOf("late_detection") + 1);
    // and it is searchable
    expect(ALL_SETTINGS.filter((m) => m.tab === "compensation").length).toBeGreaterThanOrEqual(10);
  });
});
