import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "../../Settings";
import { SETTINGS_TABS } from "../tabs";
import {
  all,
  apiError,
  click,
  css,
  installBrowserStubs,
  installWorld,
  mount,
  params,
  q,
  settle,
  text,
  typeAt,
  unmount,
  waitFor,
  type World,
} from "./testing";

// The Settings page draws Endpoint Sharing for the super admin ONLY, and even for them it is UNLISTED: not in the navigation
// and not in the search, it opens only from its address (?tab=endpoint_sharing or /hr/settings/endpoint_sharing). For
// everybody else a direct address falls back to the first tab, without the tab's content ever being drawn.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
// an HR role that may do everything in Settings (every settings.* tab), but is not the super admin
const EVERYTHING = {
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  permissions: { settings: "edit" },
};

let world: World;

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  world = installWorld(h.fetch);
  // every request the other tabs make (the first tab asks for company details) is simply unavailable: only the chrome is judged
  const base = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (!url.startsWith("/api/shared-endpoints")) throw apiError(404, { error: "not in this test" });
    return base(url, options);
  });
});
afterEach(() => {
  unmount();
});

const navLabels = () => [...document.body.querySelectorAll('[data-testid="settings-nav"] [role="tab"]')].map(text);
const selected = () =>
  [...document.body.querySelectorAll('[data-testid="settings-nav"] [role="tab"]')]
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map(text);

/** Records whether anything of Endpoint Sharing was ever in the page, from the first render on (so a flash is caught). */
function watchForTheTab() {
  const seen = { tab: false, panel: false };
  const look = () => {
    if (document.body.querySelector('[data-testid="endpoint-sharing-tab"]')) seen.tab = true;
    if (document.body.querySelector('[data-testid="settings-panel-endpoint_sharing"]')) seen.panel = true;
  };
  const observer = new MutationObserver(look);
  observer.observe(document.body, { childList: true, subtree: true });
  return { seen, stop: () => observer.disconnect() };
}

describe("the super admin", () => {
  beforeEach(() => {
    h.user.current = SUPER;
  });

  it("does not list Endpoint Sharing in the navigation: every other tab is still there, in order", async () => {
    mount("/hr/settings", Settings);
    await settle();
    const labels = navLabels();
    expect(labels).not.toContain("Endpoint Sharing");
    expect(labels.indexOf("Backup")).toBe(labels.indexOf("WhatsApp") + 1);
    expect(labels).toHaveLength(SETTINGS_TABS.length - 1);
    expect(selected()).toEqual(["Company"]);
  });

  it("opens the tab by its address, with its heading and the subtabs (no menu item is highlighted: it is not listed)", async () => {
    mount("/hr/settings?tab=endpoint_sharing", Settings);
    await waitFor(() => q("endpoint-sharing-tab") !== null, "the tab");
    expect(navLabels()).not.toContain("Endpoint Sharing");
    expect(selected()).toEqual([]);
    expect(q("settings-panel-endpoint_sharing")).not.toBeNull();
    expect(text(css("#settings-panel h3"))).toBe("Endpoint Sharing");
    expect(text(css("#settings-panel header p"))).toContain("Super admin only");
    expect(q("settings-view-only")).toBeNull();
    await waitFor(() => all("endpoint-card").length === 2, "the list");
  });

  it("opens the same tab from the path /hr/settings/endpoint_sharing", async () => {
    mount("/hr/settings/endpoint_sharing", Settings);
    await waitFor(() => q("endpoint-sharing-tab") !== null, "the tab");
    expect(q("settings-panel-endpoint_sharing")).not.toBeNull();
    expect(navLabels()).not.toContain("Endpoint Sharing");
    await waitFor(() => all("endpoint-card").length === 2, "the list");
  });

  it("opens the path address of a listed tab too, and an unknown tab falls back to the first one", async () => {
    mount("/hr/settings/backup", Settings);
    await settle();
    expect(selected()).toEqual(["Backup"]);
    unmount();
    mount("/hr/settings/nonsense", Settings);
    await settle();
    expect(selected()).toEqual(["Company"]);
  });

  it("keeps the subtab and the open endpoint in the address, and a click on another Settings tab leaves", async () => {
    mount("/hr/settings?tab=endpoint_sharing&sub=guide", Settings);
    await waitFor(() => q("integration-guide") !== null, "the guide");
    expect(params()).toMatchObject({ tab: "endpoint_sharing", sub: "guide" });
    await click(document.body.querySelector('[data-testid="settings-nav"] [role="tab"][id="settings-tab-backup"]'));
    expect(params().tab).toBe("backup");
    expect(selected()).toEqual(["Backup"]);
    // the Backup tab's code loads on demand: the guide is gone once it has
    await waitFor(() => q("endpoint-sharing-tab") === null, "the other tab replacing it");
  });

  it("does not offer its guide sections in the page's search, and the address of the guide still opens it", async () => {
    mount("/hr/settings", Settings);
    await settle();
    for (const query of ["allowed origins", "api key", "endpoint", "cors"]) {
      await typeAt('[data-testid="settings-search"] input', query);
      expect(
        [...document.body.querySelectorAll('[data-testid^="settings-search-hit-endpoint_sharing"]')],
        query,
      ).toHaveLength(0);
    }
    unmount();
    mount("/hr/settings?tab=endpoint_sharing&sub=guide", Settings);
    await waitFor(() => q("integration-guide") !== null, "the Integration guide");
    expect(params()).toMatchObject({ tab: "endpoint_sharing", sub: "guide" });
  });

  it("asks before another tab replaces an endpoint with unsaved changes, and goes when told to", async () => {
    mount("/hr/settings?tab=endpoint_sharing&sub=endpoints&endpoint=3&section=basics", Settings);
    await waitFor(() => q("endpoint-editor") !== null, "the editor");
    await typeAt("#es-name", "Edited");
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(document.body.querySelector("#settings-tab-backup"));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain("changes that are not saved");
    expect(selected()).toEqual([]);
    expect(q("endpoint-editor")).not.toBeNull();
    ask.mockReturnValue(true);
    await click(document.body.querySelector("#settings-tab-backup"));
    expect(selected()).toEqual(["Backup"]);
    ask.mockRestore();
  });
});

describe("everybody else", () => {
  for (const [who, user] of [
    ["an HR role with every Settings permission", EVERYTHING],
    ["an HR login with no permissions at all", { role: "hr", employeeId: null, isSuperAdmin: false, permissions: {} }],
  ] as const) {
    it(`never sees the tab, a search hit or its content: ${who}`, async () => {
      h.user.current = user;
      mount("/hr/settings", Settings);
      await settle();
      const labels = navLabels();
      expect(labels).not.toContain("Endpoint Sharing");
      if (user.permissions && "settings" in user.permissions) expect(labels).toContain("Backup");
      // the search offers none of its settings, whatever is typed
      for (const query of ["allowed origins", "api key", "endpoint", "cors", "curl"]) {
        await typeAt('[data-testid="settings-search"] input', query);
        expect(
          [...document.body.querySelectorAll('[data-testid^="settings-search-hit-endpoint_sharing"]')],
          query,
        ).toHaveLength(0);
      }
    });
  }

  it("falls back to the first tab for a direct address, and the tab's content is never drawn, not even for a moment", async () => {
    h.user.current = EVERYTHING;
    const watch = watchForTheTab();
    mount("/hr/settings?tab=endpoint_sharing&sub=guide", Settings);
    // the very first render already shows the first tab
    expect(q("settings-panel-company")).not.toBeNull();
    expect(q("settings-panel-endpoint_sharing")).toBeNull();
    await settle();
    await waitFor(() => selected().length === 1, "a selected tab");
    expect(selected()).toEqual(["Company"]);
    expect(q("settings-panel-company")).not.toBeNull();
    expect(q("settings-panel-endpoint_sharing")).toBeNull();
    expect(q("endpoint-sharing-tab")).toBeNull();
    await settle(50);
    watch.stop();
    expect(watch.seen).toEqual({ tab: false, panel: false });
    // nothing of Endpoint Sharing was asked of the server either
    expect(world.requests).toEqual([]);
  });

  it("falls back to the first tab the role can see when the first one is hidden for it", async () => {
    h.user.current = {
      role: "hr",
      employeeId: null,
      isSuperAdmin: false,
      permissions: { settings: "hidden", "settings.backup": "edit" },
    };
    mount("/hr/settings?tab=endpoint_sharing", Settings);
    await settle();
    expect(navLabels()).toEqual(["Backup"]);
    expect(selected()).toEqual(["Backup"]);
    expect(q("endpoint-sharing-tab")).toBeNull();
  });

  it("falls back to the first tab for the path address too, without drawing the tab", async () => {
    h.user.current = EVERYTHING;
    const watch = watchForTheTab();
    mount("/hr/settings/endpoint_sharing", Settings);
    expect(q("settings-panel-company")).not.toBeNull();
    await settle();
    watch.stop();
    expect(selected()).toEqual(["Company"]);
    expect(watch.seen).toEqual({ tab: false, panel: false });
    expect(world.requests).toEqual([]);
  });

  it("an employee login is not offered it either", async () => {
    h.user.current = { role: "employee", employeeId: 9 };
    mount("/hr/settings?tab=endpoint_sharing", Settings);
    await settle();
    expect(navLabels()).not.toContain("Endpoint Sharing");
    expect(q("endpoint-sharing-tab")).toBeNull();
    expect(world.requests).toEqual([]);
  });
});
