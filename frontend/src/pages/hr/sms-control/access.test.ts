import { describe, expect, it } from "vitest";
import { canEdit, canView, canViewRoute, isRouteViewOnly, permissionLevel } from "@/contexts/AuthContext";
import { navGroups, navItemActive } from "@/components/ui/dashboard-sidebar";
import { MODULE_LABELS, MODULE_TREE, ROUTE_MODULE_MAP, allModuleKeys, moduleForPath } from "@/lib/permission-modules";
import { pageHasRefresh } from "@/lib/page-refresh";
import { SETTINGS_SECTIONS, SMS_BASE, SMS_CONTROL_MODULE, SMS_TABS, smsPath, smsTabPath } from "./routes";

// Who may open SMS Control: App.tsx gates the whole /hr/sms-control prefix by the module its path belongs to
// (moduleForPath), so every address of every tab has to stay in the one `sms_control` module, and no other.

const everyPath = [
  SMS_BASE,
  `${SMS_BASE}/`,
  ...SMS_TABS.map((t) => smsTabPath(t.value)),
  ...SETTINGS_SECTIONS.map((s) => smsTabPath("settings", s.value)),
  smsPath("messages", undefined, "status=failed&page=2"),
  `${SMS_BASE}/nope`,
  `${SMS_BASE}/settings/nope`,
];

type User = Parameters<typeof canViewRoute>[0];
const hr = (permissions: Record<string, "hidden" | "view" | "edit">): User => ({
  role: "hr",
  employeeId: null,
  permissions,
});

describe("the module", () => {
  it("is registered like WhatsApp Control and Gmail Control, with its label, in the role editor's list", () => {
    expect(SMS_CONTROL_MODULE).toBe("sms_control");
    expect(MODULE_TREE.map((n) => n.key)).toContain("sms_control");
    expect(MODULE_LABELS).toContainEqual({ key: "sms_control", label: "SMS Control" });
    expect(allModuleKeys()).toContain("sms_control");
    expect(MODULE_TREE.find((n) => n.key === "sms_control")?.children).toBeUndefined();
    // it sits beside the other two message-control modules
    const keys = MODULE_TREE.map((n) => n.key);
    expect(keys.indexOf("sms_control")).toBe(keys.indexOf("gmail_control") + 1);
    expect(ROUTE_MODULE_MAP["/hr/sms-control"]).toBe("sms_control");
  });
});

describe("who may open SMS Control", () => {
  it("keeps every address of every tab in the sms_control module, and no other", () => {
    for (const path of everyPath) expect(moduleForPath(path.split("?")[0]), path).toBe("sms_control");
    // a look-alike is not SMS Control, and the other control pages keep their own modules
    expect(moduleForPath("/hr/sms-control-archive")).toBeNull();
    expect(moduleForPath("/hr/whatsapp-control")).toBe("whatsapp_control");
    expect(moduleForPath("/hr/gmail-control")).toBe("gmail_control");
  });

  it("keeps all of them out of reach of a role without the module, even one with WhatsApp Control, and in reach of one with it", () => {
    const without = hr({ whatsapp_control: "edit", gmail_control: "edit", settings: "edit" });
    const viewer = hr({ sms_control: "view" });
    const editor = hr({ sms_control: "edit" });
    for (const path of everyPath) {
      const route = path.split("?")[0];
      const key = moduleForPath(route);
      expect(canViewRoute(without, route, key), `${route} without the module`).toBe(false);
      expect(canViewRoute(viewer, route, key), `${route} with view`).toBe(true);
      expect(canViewRoute(editor, route, key), `${route} with edit`).toBe(true);
    }
  });

  it("treats a hidden grant as no grant, and a missing permissions list as none", () => {
    for (const path of everyPath) {
      expect(canViewRoute(hr({ sms_control: "hidden" }), path, "sms_control"), path).toBe(false);
      expect(canViewRoute(hr({}), path, "sms_control"), path).toBe(false);
    }
  });

  it("locks a View Only role on every address, and not an editor", () => {
    for (const path of everyPath) {
      expect(isRouteViewOnly(hr({ sms_control: "view" }), path, "sms_control"), path).toBe(true);
      expect(isRouteViewOnly(hr({ sms_control: "edit" }), path, "sms_control"), path).toBe(false);
    }
  });

  it("lets an administrator open and change everything", () => {
    const admin: User = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
    for (const path of everyPath) expect(canViewRoute(admin, path, "sms_control"), path).toBe(true);
    expect(canEdit(admin, "sms_control")).toBe(true);
  });

  it("reads the level the page uses to decide read-only", () => {
    expect(permissionLevel(hr({ sms_control: "view" }), SMS_CONTROL_MODULE)).toBe("view");
    expect(permissionLevel(hr({ sms_control: "edit" }), SMS_CONTROL_MODULE)).toBe("edit");
    expect(permissionLevel(hr({}), SMS_CONTROL_MODULE)).toBe("hidden");
    expect(canView(hr({ sms_control: "view" }), SMS_CONTROL_MODULE)).toBe(true);
    expect(canEdit(hr({ sms_control: "view" }), SMS_CONTROL_MODULE)).toBe(false);
  });
});

describe("the sidebar", () => {
  const administration = navGroups.find((g) => g.heading === "Administration")!;
  const labels = administration.items.map((i) => i.label);

  it("lists SMS Control in Administration, right after WhatsApp Control", () => {
    const item = administration.items.find((i) => i.label === "SMS Control")!;
    expect(item.path).toBe(SMS_BASE);
    expect(item.children).toBeUndefined();
    expect(labels.indexOf("SMS Control")).toBe(labels.indexOf("WhatsApp Control") + 1);
  });

  it("is gated like the page: the entry's path belongs to the sms_control module", () => {
    const item = administration.items.find((i) => i.label === "SMS Control")!;
    expect(moduleForPath(item.path)).toBe("sms_control");
    expect(canViewRoute(hr({ whatsapp_control: "edit" }), item.path, moduleForPath(item.path))).toBe(false);
    expect(canViewRoute(hr({ sms_control: "view" }), item.path, moduleForPath(item.path))).toBe(true);
  });

  it("stays lit on every tab and nested tab, and not on a look-alike", () => {
    const item = administration.items.find((i) => i.label === "SMS Control")!;
    for (const path of everyPath.map((p) => p.split("?")[0]).filter((p) => p !== SMS_BASE && p !== `${SMS_BASE}/`)) {
      expect(navItemActive(item, path), path).toBe(true);
    }
    expect(navItemActive(item, "/hr/sms-control-archive")).toBe(false);
    expect(
      navItemActive(
        administration.items.find((i) => i.label === "WhatsApp Control")!,
        "/hr/sms-control/overview",
      ),
    ).toBe(false);
  });

  it("is found by the sidebar search (every top-level entry is)", () => {
    const entries = navGroups.flatMap((g) => g.items).map((i) => i.label);
    expect(entries).toContain("SMS Control");
  });
});

describe("the Refresh button", () => {
  it("is in the page's title row, so the layout does not add a second one, on every tab", () => {
    for (const path of everyPath) expect(pageHasRefresh(path.split("?")[0]), path).toBe(false);
    expect(pageHasRefresh("/hr/sms-controller")).toBe(true);
  });
});
