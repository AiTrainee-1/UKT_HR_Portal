import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import DeviceControl from "../DeviceControl";

// Device Control's tabs against the role's own keys (Account Management -> Roles & Permissions). Every tab but Overview has an
// address of its own (the route guard blocks a hidden one); Overview is the page's own address, so when it is hidden the page
// opens on the first tab the role may see, and when the role may only view it the tab is locked. The tabs are stand-ins here.

const h = vi.hoisted(() => ({ user: { current: null as Record<string, unknown> | null } }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-hooks", () => ({
  useDeviceControlOverview: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  useRecheckDevices: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshDeviceUsers: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
// each tab is a stand-in with one button that changes something, so a lock on the tab shows on it
vi.mock("./OverviewTab", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("button", { "data-testid": "stub-overview" }, "Delete this") };
});
vi.mock("./FetchTab", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("button", { "data-testid": "stub-fetch" }, "Delete this") };
});
vi.mock("./PushTab", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("button", { "data-testid": "stub-push" }, "Delete this") };
});
vi.mock("./LinkTab", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("button", { "data-testid": "stub-link" }, "Delete this") };
});
vi.mock("./ConnectorsTab", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("button", { "data-testid": "stub-connectors" }, "Delete this") };
});

const BASE = "/hr/Biometric-Connectors/DeviceControl";
const role = (permissions: Record<string, string>) => ({
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  permissions,
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const labels = () =>
  [...document.body.querySelectorAll('[role="tab"]')].map((t) =>
    (t.querySelector(".ptab-label")?.textContent ?? "").trim(),
  );
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function open(url: string) {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(DeviceControl)));
  await settle();
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  h.user.current = null;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

describe("Device Control: the tabs a role may see", () => {
  it("offers every tab to a role that set nothing on them, and opens Overview at the page's address", async () => {
    h.user.current = role({ biometric_connectors: "edit" });
    await open(BASE);
    expect(labels()).toEqual(["Overview", "Data Fetch", "Data Push", "Link / Unlink", "Site connectors"]);
    expect(q("stub-overview")).not.toBeNull();
    expect(window.location.pathname).toBe(BASE);
  });

  it("opens the first tab it may see when Overview is hidden, and never draws Overview", async () => {
    h.user.current = role({
      biometric_connectors: "edit",
      "biometric_connectors.device_control.overview": "hidden",
      "biometric_connectors.device_control.fetch": "hidden",
    });
    await open(BASE);
    expect(labels()).toEqual(["Data Push", "Link / Unlink", "Site connectors"]);
    expect(q("stub-overview")).toBeNull();
    expect(q("stub-push")).not.toBeNull();
    expect(window.location.pathname).toBe(`${BASE}/push`);
  });

  it("locks Overview when the role may only view it on a page it may edit, and says so", async () => {
    h.user.current = role({ biometric_connectors: "edit", "biometric_connectors.device_control.overview": "view" });
    await open(BASE);
    expect(q("tab-view-only")).not.toBeNull();
    expect((q("stub-overview") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when no tab is open to it", async () => {
    const hidden = Object.fromEntries(
      ["overview", "fetch", "push", "link_unlink", "connectors"].map((t) => [
        `biometric_connectors.device_control.${t}`,
        "hidden",
      ]),
    );
    h.user.current = role({ biometric_connectors: "edit", ...hidden });
    await open(BASE);
    expect(q("nothing-open")?.textContent).toBe("Nothing on this page is open to your role.");
    expect(labels()).toEqual([]);
    expect(q("stub-overview")).toBeNull();
  });
});
