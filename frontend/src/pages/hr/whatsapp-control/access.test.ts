import { describe, expect, it } from "vitest";
import { canEdit, canViewRoute, isRouteViewOnly, permissionLevel } from "@/contexts/AuthContext";
import { MODULE_TREE, ROUTE_MODULE_MAP, moduleForPath } from "@/lib/permission-modules";
import { pickVisible, visibleItems } from "@/lib/tab-access";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { tabFromSearch, tabHref } from "./logic";
import { WA_MODULE, WA_PATH, WA_TABS, waTabModule } from "./tabs";

// Who sees which tab of WhatsApp Control. Every tab lives at /hr/whatsapp-control (?tab= picks one), so the route is
// gated by the page's key and each tab by its own key (whatsapp_control.<tab>, Account Management -> Roles & Permissions),
// which follows the page while nothing is set on it. The nine tabs of the Meta Cloud API page (2026-11-20): Overview,
// Usage & Cost, Message Controls, Templates, OTP, Messages, Employees, Send a test, Settings.

type User = Parameters<typeof canViewRoute>[0];
const hr = (permissions: Record<string, "hidden" | "view" | "edit">): User => ({
  role: "hr",
  employeeId: null,
  permissions,
});

/** The tabs a login is offered and the one it lands on for an address, as the page works them out. */
const tabsFor = (user: User, search = "") => {
  const level = (key: string) => permissionLevel(user, key);
  const visible = visibleItems(WA_TABS, (t) => waTabModule(t.value), level).map((t) => t.value as string);
  return { visible, open: pickVisible(tabFromSearch(search), visible) };
};

describe("the tabs and their keys", () => {
  it("match the permission tree's keys, labels and order", () => {
    const node = MODULE_TREE.find((n) => n.key === WA_MODULE);
    expect(node?.children?.map((c) => c.key)).toEqual(WA_TABS.map((t) => waTabModule(t.value)));
    expect(node?.children?.map((c) => c.label)).toEqual(WA_TABS.map((t) => t.label));
    expect(WA_TABS.map((t) => t.value)).toEqual([
      "overview",
      "usage",
      "controls",
      "templates",
      "otp",
      "messages",
      "employees",
      "test",
      "config",
    ]);
    expect(ROUTE_MODULE_MAP[WA_PATH]).toBe(WA_MODULE);
    expect(moduleForPath(WA_PATH)).toBe(WA_MODULE);
  });
});

describe("who sees which tab", () => {
  it("offers every tab, Send a test too, to a role with the page", () => {
    expect(tabsFor(hr({ whatsapp_control: "edit" })).visible).toEqual(WA_TABS.map((t) => t.value));
    expect(tabsFor(hr({ whatsapp_control: "view" })).visible).toEqual(WA_TABS.map((t) => t.value));
  });

  it("hides Send a test on its own, and an address asking for it lands on the first open tab", () => {
    const user = hr({ whatsapp_control: "edit", "whatsapp_control.test": "hidden" });
    const { visible, open } = tabsFor(user, "?tab=test");
    expect(visible).not.toContain("test");
    expect(visible).toContain("config");
    expect(open).toBe("overview");
  });

  it("opens the tab the address names (a link from Requests -> Notify to Message Controls)", () => {
    expect(tabsFor(hr({ whatsapp_control: "edit" }), "?tab=controls").open).toBe("controls");
    expect(tabsFor(hr({ whatsapp_control: "edit" }), "?tab=usage").open).toBe("usage");
    expect(tabsFor(hr({ whatsapp_control: "edit" }), "?tab=otp").open).toBe("otp");
    expect(tabsFor(hr({ whatsapp_control: "edit" }), "?tab=test").open).toBe("test");
    expect(tabsFor(hr({ whatsapp_control: "edit" }), "?tab=nope").open).toBe("overview");
    expect(tabHref(WA_PATH, "controls")).toBe("/hr/whatsapp-control?tab=controls");
  });

  it("opens the page for a role given only Send a test, with only that tab", () => {
    const user = hr({ "whatsapp_control.test": "edit" });
    expect(canViewRoute(user, WA_PATH, moduleForPath(WA_PATH))).toBe(true);
    expect(tabsFor(user).visible).toEqual(["test"]);
    expect(tabsFor(user).open).toBe("test");
  });

  it("hides Usage & Cost and Templates on their own (a role that may switch messages but not see the bill)", () => {
    const user = hr({
      whatsapp_control: "edit",
      "whatsapp_control.usage": "hidden",
      "whatsapp_control.templates": "hidden",
    });
    expect(tabsFor(user).visible).toEqual(["overview", "controls", "otp", "messages", "employees", "test", "config"]);
    expect(tabsFor(user, "?tab=usage").open).toBe("overview");
  });

  it("keeps the set-up check with Settings: hiding Settings hides it", () => {
    const user = hr({ whatsapp_control: "edit", "whatsapp_control.config": "hidden" });
    expect(tabsFor(user).visible).not.toContain("config");
    expect(tabsFor(user).visible).toContain("test");
  });
});

describe("View only on Send a test", () => {
  it("is View only on a role that may only view the page, or only the tab", () => {
    expect(isRouteViewOnly(hr({ whatsapp_control: "view" }), WA_PATH, moduleForPath(WA_PATH))).toBe(true);
    const tabOnly = hr({ whatsapp_control: "edit", "whatsapp_control.test": "view" });
    expect(isRouteViewOnly(tabOnly, WA_PATH, moduleForPath(WA_PATH))).toBe(false);
    expect(permissionLevel(tabOnly, waTabModule("test"))).toBe("view");
    expect(canEdit(tabOnly, waTabModule("test"))).toBe(false);
    expect(canEdit(tabOnly, waTabModule("controls"))).toBe(true);
  });

  it("follows the page while nothing is set on the tab", () => {
    expect(permissionLevel(hr({ whatsapp_control: "edit" }), waTabModule("test"))).toBe("edit");
    expect(permissionLevel(hr({ whatsapp_control: "view" }), waTabModule("test"))).toBe("view");
    expect(permissionLevel(hr({}), waTabModule("test"))).toBe("hidden");
  });

  it("lets an administrator open and send", () => {
    const admin: User = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
    expect(canViewRoute(admin, WA_PATH, WA_MODULE)).toBe(true);
    expect(canEdit(admin, waTabModule("test"))).toBe(true);
  });
});

describe("the View-only lock and the tab row", () => {
  it("leaves the Send a test tab open (the page wraps its tabs in data-view-safe) but locks the send button", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div data-view-safe=""><div role="tablist"><button role="tab">Send a test</button></div></div>' +
      "<button>Preview</button><button>Send test message</button>";
    document.body.append(root);
    lockMutatingControls(root);
    const [tab, preview, send] = Array.from(root.querySelectorAll("button"));
    expect(tab.disabled).toBe(false);
    expect(preview.disabled).toBe(false);
    expect(send.disabled).toBe(true);
    root.remove();
  });
});
