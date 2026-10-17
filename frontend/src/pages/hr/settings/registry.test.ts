import { describe, expect, it } from "vitest";
import { allModuleKeys } from "@/lib/permission-modules";
import { SETTINGS_TAB_MODULE, SUPER_ADMIN_ONLY_TABS } from "./constants";
import { SETTINGS_GROUPS, searchSettings } from "./kit/catalog";
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
      expect(SETTINGS_TAB_COMPONENTS[tab.id], `${tab.id} component`).toBeDefined();
      if (SUPER_ADMIN_ONLY_TABS.has(tab.id)) {
        // a super-admin-only tab is not a role permission: no permission key, no Account Management module
        expect(SETTINGS_TAB_MODULE[tab.id], `${tab.id} has no permission key`).toBeUndefined();
        continue;
      }
      expect(SETTINGS_TAB_MODULE[tab.id], `${tab.id} permission key`).toBeTruthy();
      expect(
        modules.has(SETTINGS_TAB_MODULE[tab.id]),
        `${tab.id} -> ${SETTINGS_TAB_MODULE[tab.id]} is a known module`,
      ).toBe(true);
    }
    const withPermission = ids.filter((id) => !SUPER_ADMIN_ONLY_TABS.has(id));
    expect(Object.keys(SETTINGS_TAB_MODULE).sort()).toEqual([...withPermission].sort());
    for (const id of SUPER_ADMIN_ONLY_TABS) expect(ids, `${id} is a real tab`).toContain(id);
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
      "/hr/compensation/ot-detection",
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

  it("registers the Production Shifts tab with the attendance and time group, the Attendance permission and its links", () => {
    const tab = SETTINGS_TABS.find((t) => t.id === "production_shifts");
    expect(tab).toBeDefined();
    expect(tab?.label).toBe("Production Shifts");
    expect(tab?.group).toBe("time");
    // it is edited with the permission its API checks (settings.attendance): no new permission key
    expect(SETTINGS_TAB_MODULE.production_shifts).toBe("settings.attendance");
    expect(tab?.purpose).toContain("Production only");
    expect(tab?.usedBy.map((u) => u.to).filter(Boolean)).toEqual([
      "/hr/attendance/production",
      "/hr/production-payroll",
      "/hr/shifts",
      "/hr/reports",
    ]);
    // it sits right after Attendance
    const order = SETTINGS_TABS.filter((t) => t.group === "time").map((t) => t.id);
    expect(order.indexOf("production_shifts")).toBe(order.indexOf("attendance") + 1);
    // and it is searchable, by the words HR would use
    expect(ALL_SETTINGS.filter((m) => m.tab === "production_shifts").map((m) => m.id)).toEqual([
      "rules-enabled",
      "rules-effective-from",
      "rules-grace",
      "shift-groups",
      "breaks",
      "min-credit",
      "rounding",
      "full-day-value",
      "night-session",
      "try-it",
    ]);
    const find = (query: string) =>
      searchSettings(ALL_SETTINGS, SETTINGS_TABS, query)
        .filter((m) => m.tab === "production_shifts")
        .map((m) => m.id);
    expect(find("night shift")).toContain("shift-groups");
    expect(find("sunday")).toContain("shift-groups");
    expect(find("lunch break")).toEqual(["breaks"]);
    expect(find("calculator")).toEqual(["try-it"]);
    expect(find("rounding step")).toContain("rounding");
    expect(find("production grace")).toContain("rules-grace");
    expect(find("applies from")).toContain("rules-effective-from");
  });

  it("registers Endpoint Sharing as a super-admin-only tab in Messages and data, searchable, with no permission module", () => {
    const tab = SETTINGS_TABS.find((t) => t.id === "endpoint_sharing");
    expect(tab?.label).toBe("Endpoint Sharing");
    expect(tab?.group).toBe("system");
    expect(SUPER_ADMIN_ONLY_TABS.has("endpoint_sharing")).toBe(true);
    expect(SETTINGS_TAB_MODULE.endpoint_sharing).toBeUndefined();
    expect([...allModuleKeys()].some((key) => key.includes("endpoint"))).toBe(false);
    // it sits with the other integrations, between WhatsApp and Backup
    const order = SETTINGS_TABS.filter((t) => t.group === "system").map((t) => t.id);
    expect(order).toEqual(["smtp", "whatsapp", "endpoint_sharing", "backup"]);
    // the settings the search can reach exist on the tab even when no endpoint is open
    const ids = ALL_SETTINGS.filter((m) => m.tab === "endpoint_sharing").map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(["endpoints-list", "guide-cors", "guide-keys", "guide-security", "activity-log"]),
    );
    const find = (query: string) =>
      searchSettings(ALL_SETTINGS, SETTINGS_TABS, query)
        .filter((m) => m.tab === "endpoint_sharing")
        .map((m) => m.id);
    expect(find("allowed origins")).toContain("guide-cors");
    expect(find("api key")).toEqual(expect.arrayContaining(["guide-auth", "guide-keys"]));
    expect(find("curl")).toContain("guide-examples");
  });

  it("keeps the old production wording out of the tabs that now point to Production Shifts", () => {
    const attendance = ALL_SETTINGS.filter((m) => m.tab === "attendance" && m.section === "Production workers");
    expect(attendance.map((m) => m.id)).toEqual(["production-attendance", "production-late"]);
    expect(attendance[0].title).toContain("Old production");
    expect(attendance[0].purpose).toContain("Production Shifts tab");
    expect(SETTINGS_TABS.find((t) => t.id === "attendance")?.purpose).toContain("Production Shifts");
  });
});
