import { describe, expect, it } from "vitest";
import { canEdit, canViewRoute, isRouteViewOnly, permissionLevel } from "@/contexts/AuthContext";
import { navGroups, navItemActive } from "@/components/ui/dashboard-sidebar";
import { MODULE_LABELS, MODULE_TREE, ROUTE_MODULE_MAP, allModuleKeys, moduleForPath } from "@/lib/permission-modules";
import { pageHasRefresh } from "@/lib/page-refresh";
import { PHONE_NOTIFY_MODULE, PN_BASE, PN_TABS, pnPath, pnTabModule, pnTabPath } from "./routes";

// Who may open Phone Notify Control: App.tsx gates the whole /hr/phone-notify-control prefix by the key its path belongs to
// (moduleForPath): the page's own, or a tab's own key for a tab's address. Every address stays inside phone_notify_control.

const everyPath = [
  PN_BASE,
  `${PN_BASE}/`,
  ...PN_TABS.map((t) => pnTabPath(t.value)),
  pnPath("messages", "status=failed&page=2"),
  pnPath("settings", "list=on&type=staff"),
  pnPath("templates", "custom=1"),
  `${PN_BASE}/nope`,
];

type User = Parameters<typeof canViewRoute>[0];
const hr = (permissions: Record<string, "hidden" | "view" | "edit">): User => ({
  role: "hr",
  employeeId: null,
  permissions,
});

describe("the module", () => {
  it("is registered beside the other control pages, with its label and a key for each tab", () => {
    expect(PHONE_NOTIFY_MODULE).toBe("phone_notify_control");
    expect(MODULE_TREE.map((n) => n.key)).toContain("phone_notify_control");
    expect(MODULE_LABELS).toContainEqual({ key: "phone_notify_control", label: "Phone Notify Control" });
    expect(allModuleKeys()).toContain("phone_notify_control");
    const node = MODULE_TREE.find((n) => n.key === "phone_notify_control");
    expect(node?.children?.map((c) => c.key)).toEqual(PN_TABS.map((t) => pnTabModule(t.value)));
    expect(ROUTE_MODULE_MAP[PN_BASE]).toBe("phone_notify_control");
  });

  it("no longer has the old Mobile Messages keys under Mobile App Login", () => {
    expect(allModuleKeys().some((k) => k.startsWith("mobile_app_login.messages"))).toBe(false);
  });
});

describe("who may open Phone Notify Control", () => {
  it("keeps every address in the phone_notify_control module, each tab its own key", () => {
    for (const path of everyPath) {
      expect(moduleForPath(path.split("?")[0]), path).toMatch(/^phone_notify_control(\.|$)/);
    }
    expect(moduleForPath(PN_BASE)).toBe("phone_notify_control");
    expect(moduleForPath(`${PN_BASE}/nope`)).toBe("phone_notify_control");
    for (const t of PN_TABS) expect(moduleForPath(pnTabPath(t.value)), t.value).toBe(pnTabModule(t.value));
    // a look-alike is not this page, and the other control pages keep their own modules
    expect(moduleForPath("/hr/phone-notify-control-archive")).toBeNull();
    expect(moduleForPath("/hr/mobile-app-login")).toBe("mobile_app_login");
    expect(moduleForPath("/hr/sms-control")).toBe("sms_control");
  });

  it("follows Mobile App Login while nothing is set on it (the page held these as a tab before)", () => {
    for (const path of everyPath) {
      const route = path.split("?")[0];
      const key = moduleForPath(route);
      expect(canViewRoute(hr({ mobile_app_login: "view" }), route, key), `${route} by Mobile App Login`).toBe(true);
      expect(canViewRoute(hr({ whatsapp_control: "edit", sms_control: "edit" }), route, key), route).toBe(false);
      expect(canViewRoute(hr({}), route, key), `${route} with nothing`).toBe(false);
    }
    expect(permissionLevel(hr({ mobile_app_login: "edit" }), PHONE_NOTIFY_MODULE)).toBe("edit");
    // its own setting wins over Mobile App Login's
    expect(permissionLevel(hr({ mobile_app_login: "edit", phone_notify_control: "hidden" }), PHONE_NOTIFY_MODULE)).toBe(
      "hidden",
    );
  });

  it("hides one tab's address and keeps the rest, and opens the page for a role given only one tab", () => {
    const user = hr({ phone_notify_control: "edit", "phone_notify_control.send": "hidden" });
    expect(canViewRoute(user, pnTabPath("send"), moduleForPath(pnTabPath("send")))).toBe(false);
    expect(canViewRoute(user, pnTabPath("messages"), moduleForPath(pnTabPath("messages")))).toBe(true);
    const noSettings = hr({ phone_notify_control: "edit", "phone_notify_control.settings": "hidden" });
    expect(canViewRoute(noSettings, pnTabPath("settings"), moduleForPath(pnTabPath("settings")))).toBe(false);
    expect(canViewRoute(noSettings, pnTabPath("overview"), moduleForPath(pnTabPath("overview")))).toBe(true);
    const onlyOne = hr({ "phone_notify_control.messages": "view" });
    expect(canViewRoute(onlyOne, PN_BASE, moduleForPath(PN_BASE))).toBe(true);
    expect(canViewRoute(onlyOne, pnTabPath("messages"), moduleForPath(pnTabPath("messages")))).toBe(true);
    expect(canViewRoute(onlyOne, pnTabPath("controls"), moduleForPath(pnTabPath("controls")))).toBe(false);
  });

  it("locks a View Only role on every address, a View Only tab on its own, and not an editor", () => {
    for (const path of everyPath) {
      const route = path.split("?")[0];
      const key = moduleForPath(route);
      expect(isRouteViewOnly(hr({ phone_notify_control: "view" }), route, key), route).toBe(true);
      expect(isRouteViewOnly(hr({ phone_notify_control: "edit" }), route, key), route).toBe(false);
    }
    const user = hr({ phone_notify_control: "edit", "phone_notify_control.controls": "view" });
    expect(isRouteViewOnly(user, pnTabPath("controls"), moduleForPath(pnTabPath("controls")))).toBe(true);
    expect(isRouteViewOnly(user, pnTabPath("messages"), moduleForPath(pnTabPath("messages")))).toBe(false);
    // Message Text (key `templates`, address `/message-text`) has its own edit right too
    const wordingView = hr({ phone_notify_control: "edit", "phone_notify_control.templates": "view" });
    expect(moduleForPath(pnTabPath("templates"))).toBe("phone_notify_control.templates");
    expect(isRouteViewOnly(wordingView, pnTabPath("templates"), moduleForPath(pnTabPath("templates")))).toBe(true);
    expect(canEdit(wordingView, pnTabModule("templates"))).toBe(false);
    const noWording = hr({ phone_notify_control: "edit", "phone_notify_control.templates": "hidden" });
    expect(canViewRoute(noWording, pnTabPath("templates"), moduleForPath(pnTabPath("templates")))).toBe(false);
    // the Settings tab (who receives phone notifications) has its own edit right
    const settingsView = hr({ phone_notify_control: "edit", "phone_notify_control.settings": "view" });
    expect(isRouteViewOnly(settingsView, pnTabPath("settings"), moduleForPath(pnTabPath("settings")))).toBe(true);
    expect(canEdit(settingsView, pnTabModule("settings"))).toBe(false);
    expect(canEdit(settingsView, pnTabModule("controls"))).toBe(true);
  });

  it("lets an administrator open and change everything", () => {
    const admin: User = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
    for (const path of everyPath) expect(canViewRoute(admin, path, PHONE_NOTIFY_MODULE), path).toBe(true);
    expect(canEdit(admin, PHONE_NOTIFY_MODULE)).toBe(true);
  });
});

describe("the sidebar", () => {
  const administration = navGroups.find((g) => g.heading === "Administration")!;
  const labels = administration.items.map((i) => i.label);
  const item = () => administration.items.find((i) => i.label === "Phone Notify Control")!;

  it("lists Phone Notify Control in Administration, right after Gmail Control", () => {
    expect(item().path).toBe(PN_BASE);
    expect(item().children).toBeUndefined();
    expect(labels.indexOf("Phone Notify Control")).toBe(labels.indexOf("Gmail Control") + 1);
  });

  it("is gated like the page, and stays lit on every tab but not on a look-alike", () => {
    expect(moduleForPath(item().path)).toBe("phone_notify_control");
    expect(canViewRoute(hr({ sms_control: "edit" }), item().path, moduleForPath(item().path))).toBe(false);
    expect(canViewRoute(hr({ phone_notify_control: "view" }), item().path, moduleForPath(item().path))).toBe(true);
    for (const t of PN_TABS) expect(navItemActive(item(), pnTabPath(t.value)), t.value).toBe(true);
    expect(navItemActive(item(), "/hr/phone-notify-control-archive")).toBe(false);
    expect(
      navItemActive(
        administration.items.find((i) => i.label === "Mobile App Login")!,
        pnTabPath("messages"),
      ),
    ).toBe(false);
  });
});

describe("the Refresh button", () => {
  it("is in the page's title row, so the layout does not add a second one, on every tab", () => {
    for (const path of everyPath) expect(pageHasRefresh(path.split("?")[0]), path).toBe(false);
    expect(pageHasRefresh("/hr/phone-notify-controller")).toBe(true);
  });
});
