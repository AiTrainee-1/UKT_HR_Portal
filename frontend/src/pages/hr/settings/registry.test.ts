import { describe, expect, it } from "vitest";
import { allModuleKeys } from "@/lib/permission-modules";
import { SETTINGS_TAB_MODULE, SUPER_ADMIN_ONLY_TABS } from "./constants";
import { SETTINGS_GROUPS, searchSettings } from "./kit/catalog";
import { ALL_SETTINGS } from "./metas";
import { ATTENDANCE_VIEW_OF } from "./AttendanceTab.meta";
import { LATE_CYCLE_OF, LATE_VIEW_OF } from "./LateDetectionTab.meta";
import { PAYROLL_SUB_TAB_OF } from "./PayrollTab.meta";
import { PF_ESI_SUB_TAB_OF } from "./PfEsiTab.meta";
import { PRODUCTION_SHIFT_VIEW_OF } from "./ProductionShiftsTab.meta";
import { PRODUCTION_SUB_TAB_OF } from "./ProductionPayrollTab.meta";
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
      "staff-shifts-where",
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

  it("registers the PF & ESI tab in the Pay group with the Payroll permission, searchable, every block on one of its pages", () => {
    const tab = SETTINGS_TABS.find((t) => t.id === "pf_esi");
    expect(tab?.label).toBe("PF & ESI");
    expect(tab?.group).toBe("pay");
    // read by every login that may see Payroll settings; changing the rules is the super admin's alone, which the API decides
    expect(SETTINGS_TAB_MODULE.pf_esi).toBe("settings.payroll");
    expect(SUPER_ADMIN_ONLY_TABS.has("pf_esi")).toBe(false);
    expect(tab?.purpose).toContain("Co Emp");
    expect(tab?.usedBy.map((u) => u.to).filter(Boolean)).toEqual([
      "/hr/payroll",
      "/hr/production-payroll",
      "/hr/employees",
      "/hr/compensation/ctc-breakdown",
      "/hr/reports",
    ]);
    // it sits with the payroll tabs, right after Production Payroll
    const order = SETTINGS_TABS.filter((t) => t.group === "pay").map((t) => t.id);
    expect(order.indexOf("pf_esi")).toBe(order.indexOf("production_payroll") + 1);
    // the blocks the search can reach: whose rules, then both pages
    expect(ALL_SETTINGS.filter((m) => m.tab === "pf_esi").map((m) => m.id)).toEqual([
      "pf-esi-scope",
      "staff-pf-esi-how",
      "staff-pf-rules",
      "staff-esi-rules",
      "prod-pf-esi-how",
      "prod-pf-rules",
      "prod-esi-rules",
    ]);
    const find = (query: string) =>
      searchSettings(ALL_SETTINGS, SETTINGS_TABS, query)
        .filter((m) => m.tab === "pf_esi")
        .map((m) => m.id);
    expect(find("provident fund")).toEqual(expect.arrayContaining(["staff-pf-rules", "prod-pf-rules"]));
    expect(find("employee state insurance")).toEqual(expect.arrayContaining(["staff-esi-rules", "prod-esi-rules"]));
    expect(find("reset to global")).toEqual(["pf-esi-scope"]);
    expect(find("who pays")).toEqual(expect.arrayContaining(["staff-pf-esi-how", "prod-pf-esi-how"]));
    // each pf setting has a page, so a link opens it
    expect(PF_ESI_SUB_TAB_OF["staff-esi-rules"]).toBe("staff");
    expect(PF_ESI_SUB_TAB_OF["prod-pf-rules"]).toBe("production");
    expect(PF_ESI_SUB_TAB_OF["pf-esi-scope"]).toBeUndefined();
  });

  it("no longer lists any of the old PF and ESI methods on the Payroll and Production Payroll tabs", () => {
    const gone = [
      "staff-pf-esi-switch",
      "staff-pf-rate",
      "staff-esi-rate",
      "staff-esi-ceiling",
      "prod-pf-esi-switch",
      "prod-pf-rate",
      "prod-esi-rate",
      "prod-esi-ceiling",
      "pf-ef-switch",
      "pf-ef-rules",
    ];
    const payroll = ALL_SETTINGS.filter((m) => m.tab === "payroll").map((m) => m.id);
    for (const id of gone) expect(payroll, id).not.toContain(id);
    // Staff Payroll holds staff and company-wide settings only: the suggested rate per shift moved to Production Payroll
    expect(payroll).toEqual([
      "pay-day",
      "fy-start-month",
      "bonus-percent",
      "bonus-wage-ceiling",
      "bonus-eligibility-ceiling",
      "compensation-features",
    ]);
    // the Production Payroll tab keeps a pointer, not a control
    const production = ALL_SETTINGS.filter((m) => m.tab === "production_payroll" && m.id === "prod-pf-esi-where");
    expect(production).toHaveLength(1);
    expect(production[0].purpose).toContain("PF & ESI tab");
  });

  it("keeps the old production wording out of the tabs that now point to Production Shifts", () => {
    const attendance = ALL_SETTINGS.filter((m) => m.tab === "attendance" && m.section === "Production workers");
    expect(attendance.map((m) => m.id)).toEqual(["production-days-valued", "production-attendance", "production-late"]);
    expect(attendance[1].title).toContain("Old production");
    expect(attendance[1].purpose).toContain("Production Shifts tab");
    expect(SETTINGS_TABS.find((t) => t.id === "attendance")?.purpose).toContain("Production Shifts");
  });

  it("labels the payroll tabs Staff Payroll and Production Payroll, and keeps their ids (permission keys and addresses)", () => {
    const label = (id: string) => SETTINGS_TABS.find((t) => t.id === id)?.label;
    expect(label("payroll")).toBe("Staff Payroll");
    expect(label("production_payroll")).toBe("Production Payroll");
    expect(SETTINGS_TAB_MODULE.payroll).toBe("settings.payroll");
    expect(SETTINGS_TAB_MODULE.production_payroll).toBe("settings.production_payroll");
    expect(SETTINGS_TABS.find((t) => t.id === "payroll")?.purpose).toContain("company-wide");
    // the pay tabs keep their order: Staff Payroll, Production Payroll, PF & ESI
    const order = SETTINGS_TABS.filter((t) => t.group === "pay").map((t) => t.id);
    expect(order.slice(0, 3)).toEqual(["payroll", "production_payroll", "pf_esi"]);
  });

  it("puts every Production Payroll setting on a sub-tab, and every moved setting on its new tab", () => {
    const ids = (tab: string) => ALL_SETTINGS.filter((m) => m.tab === tab).map((m) => m.id);
    expect(ids("production_payroll").sort()).toEqual(
      [
        "prod-shifts-earned",
        "prod-pf-esi-where",
        "prod-assigned-shifts",
        ...["weekly", "biweekly", "monthly"].flatMap((c) => [`${c}-week-start`, `${c}-first-period`]),
        "default-salary-per-shift",
        "prod-bonus-percent",
        "prod-bonus-wage-ceiling",
        "prod-bonus-eligibility-ceiling",
      ].sort(),
    );
    for (const id of ids("production_payroll")) expect(PRODUCTION_SUB_TAB_OF[id], id).toBeTruthy();
    expect(PRODUCTION_SUB_TAB_OF["default-salary-per-shift"]).toBe("payBonus");
    expect(PRODUCTION_SUB_TAB_OF["prod-bonus-percent"]).toBe("payBonus");
    expect(PRODUCTION_SUB_TAB_OF["prod-shifts-earned"]).toBe("overview");
    expect(PRODUCTION_SUB_TAB_OF["biweekly-first-period"]).toBe("biweekly");
    // the late rules left Production Payroll for Late Detection -> Production, with the same ids
    const gone = [
      "prod-late-switch",
      "prod-attendance-mode",
      ...["weekly", "biweekly", "monthly"].flatMap((c) => [`${c}-late-allowance`, `${c}-late-slabs`]),
    ];
    for (const id of gone) {
      expect(ids("production_payroll"), id).not.toContain(id);
      expect(ids("late_detection"), id).toContain(id);
      expect(LATE_VIEW_OF[id], id).toBe("production");
    }
    expect(LATE_CYCLE_OF["biweekly-late-slabs"]).toBe("biweekly");
    expect(LATE_CYCLE_OF["prod-late-switch"]).toBeUndefined();
    // one home per setting: no id is on two tabs of the pay and time groups
    const homes = new Map<string, string[]>();
    for (const m of ALL_SETTINGS) homes.set(m.id, [...(homes.get(m.id) ?? []), m.tab]);
    const shared = [...homes].filter(([, tabs]) => tabs.length > 1).map(([id]) => id);
    expect(shared).toEqual([]);
    // the Staff Payroll sub-tabs
    expect(PAYROLL_SUB_TAB_OF["pay-day"]).toBe("rates");
    expect(PAYROLL_SUB_TAB_OF["bonus-percent"]).toBe("bonus");
    expect(PAYROLL_SUB_TAB_OF["default-salary-per-shift"]).toBeUndefined();
  });

  it("gives every setting of a tab with a Staff | Production switch the page that holds it, so a link or the search opens it", () => {
    const check = (tab: string, viewOf: Record<string, string>) => {
      for (const m of ALL_SETTINGS.filter((x) => x.tab === tab)) {
        expect(["staff", "production"], `${tab}#${m.id}`).toContain(viewOf[m.id]);
      }
    };
    check("attendance", ATTENDANCE_VIEW_OF);
    check("production_shifts", PRODUCTION_SHIFT_VIEW_OF);
    check("late_detection", LATE_VIEW_OF);
    expect(ATTENDANCE_VIEW_OF["late-window"]).toBe("staff");
    expect(ATTENDANCE_VIEW_OF["production-attendance"]).toBe("production");
    expect(PRODUCTION_SHIFT_VIEW_OF["staff-shifts-where"]).toBe("staff");
    expect(PRODUCTION_SHIFT_VIEW_OF["shift-groups"]).toBe("production");
    expect(LATE_VIEW_OF["free-allowance"]).toBe("staff");
    expect(LATE_VIEW_OF["permission-deduction-slabs"]).toBe("staff");
    expect(LATE_VIEW_OF["weekly-late-allowance"]).toBe("production");
  });

  it("registers the permission pricing and the production late rules for the search, in words HR would use", () => {
    const find = (query: string) =>
      searchSettings(ALL_SETTINGS, SETTINGS_TABS, query)
        .filter((m) => m.tab === "late_detection")
        .map((m) => m.id);
    expect(ALL_SETTINGS.filter((m) => m.tab === "late_detection").map((m) => m.id)).toEqual([
      "free-allowance",
      "deduction-slabs",
      "permission-cap",
      "permission-pricing",
      "permission-free-allowance",
      "permission-deduction-slabs",
      "prod-late-switch",
      "prod-attendance-mode",
      "weekly-late-allowance",
      "weekly-late-slabs",
      "biweekly-late-allowance",
      "biweekly-late-slabs",
      "monthly-late-allowance",
      "monthly-late-slabs",
    ]);
    expect(find("permission slabs")).toContain("permission-deduction-slabs");
    expect(find("price permissions")).toContain("permission-pricing");
    expect(find("free permissions")).toContain("permission-free-allowance");
    expect(find("biweekly late")).toEqual(expect.arrayContaining(["biweekly-late-allowance", "biweekly-late-slabs"]));
    expect(find("late production")).toContain("prod-late-switch");
    const production = searchSettings(ALL_SETTINGS, SETTINGS_TABS, "production bonus").map((m) => `${m.tab}#${m.id}`);
    // the three production bonus settings come first; the staff ones can only follow (they mention production)
    expect(production.slice(0, 3).sort()).toEqual([
      "production_payroll#prod-bonus-eligibility-ceiling",
      "production_payroll#prod-bonus-percent",
      "production_payroll#prod-bonus-wage-ceiling",
    ]);
  });
});
