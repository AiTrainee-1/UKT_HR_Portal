import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import PhoneNotifyControl from "../PhoneNotifyControl";

// Phone Notify Control in jsdom, with a fake server behind customFetch: the tabs that each have an address and the redirects,
// which tab each address renders (and that a hidden one asks the server for nothing), the overview and its shortcuts, the
// message log with its filters in the address and Push again, the employees with mute and remove-a-phone (asked first, in the
// page), the switches (one, a group, the master switch), sending one message, the configuration, and a View-only tab.
// (It replaces the render test of the old Mobile App Login -> Mobile Messages tab.)

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { role: string; employeeId: null; permissions: Record<string, string> } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
// the shared Refresh button subscribes to every query: its re-renders are not what these tests are about
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

const BASE = "/hr/phone-notify-control";
const API = "/api/mobile-app/messages";

// ── the fake server ───────────────────────────────────────────────────────────

const COUNTS = { total: 5, sent: 3, delivered: 2, noDevice: 1, failed: 1, off: 0 };
const overview = (over: Record<string, unknown> = {}) => ({
  pushEnabled: true,
  switchedOff: 1,
  kinds: 3,
  muted: 1,
  devices: { employees: 40, withDevice: 31, withoutDevice: 9, tokens: 33, lastRegisteredAt: "2026-11-10T09:00:00Z" },
  today: COUNTS,
  week: { ...COUNTS, total: 30, sent: 24, delivered: 20, failed: 2 },
  month: { ...COUNTS, total: 120, sent: 100, delivered: 90 },
  readRate: 61.5,
  byKind: [{ label: "Late Attendance Alert", count: 12 }],
  byDay: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-11-${String(4 + i).padStart(2, "0")}`,
    total: i,
    sent: i,
  })),
  ...over,
});

const STATS = { total: 9, sent: 7, delivered: 6, failed: 1, off: 0, noDevice: 1 };
const control = (
  key: string,
  label: string,
  group: string,
  groupLabel: string,
  over: Record<string, unknown> = {},
) => ({
  key,
  label,
  description: `About ${label}`,
  group,
  groupLabel,
  kind: "message",
  enabled: true,
  sentFrom: `Sent from ${label}`,
  audience: "employee",
  origin: "whatsapp",
  stats: STATS,
  ...over,
});
const CONTROLS = () => [
  // the server's order is not the page's order: Approvals by workflow comes last, Attendance first
  control("approval:leave", "Leave", "approval_workflows", "Approvals by workflow", {
    kind: "workflow",
    origin: "app",
    stats: { ...STATS, total: 0 },
  }),
  control("late_alert", "Late Attendance Alert", "attendance", "Attendance"),
  control("absent_alert", "Absent Alert", "attendance", "Attendance", { enabled: false }),
  control("approval_waiting", "Waiting for your approval", "approvals", "Approvals", {
    audience: "approver",
    origin: "app",
  }),
];

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  employeeId: 7,
  employeeName: "Asha Kumar",
  employeeCode: "E7",
  title: "Late Attendance",
  message: "Hi Asha, your attendance has been marked as Late today.",
  type: "attendance",
  kind: "Late Attendance Alert",
  source: "late_alert",
  pushStatus: "delivered",
  pushStatusLabel: "Delivered to the phone",
  pushError: null,
  isRead: false,
  createdAt: "2026-11-17T09:30:00Z",
  pushedAt: "2026-11-17T09:30:01Z",
  canPushAgain: false,
  ...over,
});
const LOG = () => [
  row(1),
  row(2, {
    pushStatus: "failed",
    pushStatusLabel: "Push failed",
    pushError: "DeviceNotRegistered: The app was uninstalled",
    canPushAgain: true,
    title: "Request Rejected",
    kind: "Approval - Rejected: Leave",
  }),
  row(3, {
    employeeId: 8,
    employeeName: "Ravi Nair",
    employeeCode: "E8",
    pushStatus: "no_device",
    pushStatusLabel: "No phone registered",
    canPushAgain: false,
    isRead: true,
  }),
];

const DEVICES = () => [
  {
    id: 7,
    name: "Asha Kumar",
    employeeCode: "E7",
    employmentType: "staff",
    phone: "9000000001",
    devices: 1,
    lastRegisteredAt: "2026-11-10T09:00:00Z",
    muted: false,
    mutedBy: null,
    mutedAt: null,
    phones: [{ id: 5, platform: "android", registeredAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-10T09:00:00Z" }],
  },
  {
    id: 8,
    name: "Ravi Nair",
    employeeCode: "E8",
    employmentType: "production",
    phone: null,
    devices: 0,
    lastRegisteredAt: null,
    muted: true,
    mutedBy: "Test HR",
    mutedAt: "2026-11-12T09:00:00Z",
    phones: [],
  },
];

const config = (over: Record<string, unknown> = {}) => ({
  service: {
    provider: "Expo push service",
    transport: "Firebase Cloud Messaging (Android)",
    url: "https://exp.host/--/api/v2/push/send",
    androidChannel: "default",
    appPackage: "net.uktex.employee",
  },
  health: {
    state: "ok",
    note: "Pushes are reaching phones.",
    lastSentAt: "2026-11-17T09:30:01Z",
    lastDeliveredAt: "2026-11-17T09:31:00Z",
    sent30: 120,
    delivered30: 110,
    failed30: 3,
    failureReasons: [
      {
        reason: "DeviceNotRegistered",
        label: "App uninstalled / notifications reset",
        count: 2,
        advice: "The app was uninstalled or its notifications were reset on that phone.",
      },
    ],
    ...over,
  },
  phones: { employeesWithPhone: 31, tokens: 33, lastRegisteredAt: "2026-11-10T09:00:00Z" },
  pushEnabled: true,
});

type Call = { method: string; path: string; body: Record<string, unknown> };
type World = {
  overview: ReturnType<typeof overview>;
  config: ReturnType<typeof config>;
  pushEnabled: boolean;
  controls: ReturnType<typeof CONTROLS>;
  log: ReturnType<typeof LOG>;
  devices: ReturnType<typeof DEVICES>;
  calls: Call[];
  gets: string[];
  failNext: Record<string, Error>;
};

let world: World;

const paged = <T,>(items: T[], qs: URLSearchParams) => ({
  items,
  total: items.length,
  page: Number(qs.get("page") ?? 1),
  pageSize: Number(qs.get("pageSize") ?? 20),
});

function install() {
  world = {
    overview: overview(),
    config: config(),
    pushEnabled: true,
    controls: CONTROLS(),
    log: LOG(),
    devices: DEVICES(),
    calls: [],
    gets: [],
    failNext: {},
  };
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const [path, query = ""] = url.split("?");
    const qs = new URLSearchParams(query);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "GET") world.gets.push(url);
    else world.calls.push({ method, path, body });
    const failure = world.failNext[`${method} ${path}`];
    if (failure) {
      delete world.failNext[`${method} ${path}`];
      throw failure;
    }
    const controlsBody = () => ({
      pushEnabled: world.pushEnabled,
      controls: world.controls,
      updatedBy: "Test HR",
      updatedAt: "2026-11-16T10:00:00Z",
    });

    if (method === "GET" && path === `${API}/overview`) return world.overview;
    if (method === "GET" && path === `${API}/config`) return world.config;
    if (method === "GET" && path === `${API}/controls`) return controlsBody();
    if (method === "PUT" && path === `${API}/controls`) {
      if (typeof body.pushEnabled === "boolean") world.pushEnabled = body.pushEnabled;
      const types = (body.types ?? {}) as Record<string, boolean>;
      world.controls = world.controls.map((c) => (c.key in types ? { ...c, enabled: types[c.key] } : c));
      return controlsBody();
    }
    if (method === "GET" && path === `${API}/log`) {
      const status = qs.get("status");
      return paged(
        world.log.filter((r) => !status || r.pushStatus === status),
        qs,
      );
    }
    const again = path.match(/^\/api\/mobile-app\/messages\/log\/(\d+)\/push-again$/);
    if (method === "POST" && again) {
      const r = world.log.find((x) => x.id === Number(again[1]))!;
      Object.assign(r, { pushStatus: "sent", pushStatusLabel: "Sent, not confirmed yet", canPushAgain: false });
      return r;
    }
    if (method === "GET" && path === `${API}/devices`) {
      const muted = qs.get("muted") === "1";
      const has = qs.get("has");
      return paged(
        world.devices.filter(
          (d) => (!muted || d.muted) && (has !== "with" || d.devices > 0) && (has !== "without" || d.devices === 0),
        ),
        qs,
      );
    }
    const mute = path.match(/^\/api\/mobile-app\/messages\/devices\/(\d+)\/mute$/);
    if (method === "PUT" && mute) {
      const d = world.devices.find((x) => x.id === Number(mute[1]))!;
      d.muted = body.muted as boolean;
      return d;
    }
    const phone = path.match(/^\/api\/mobile-app\/messages\/devices\/phones\/(\d+)$/);
    if (method === "DELETE" && phone) {
      for (const d of world.devices) {
        d.phones = d.phones.filter((p) => p.id !== Number(phone[1]));
        d.devices = d.phones.length;
      }
      return undefined;
    }
    if (method === "POST" && path === `${API}/send`) {
      return row(9, {
        title: body.title,
        message: body.message,
        kind: "Message from HR",
        pushStatus: "sent",
        pushStatusLabel: "Sent, not confirmed yet",
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

// ── mounting and the DOM ──────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error(`nothing to click; the page shows: ${text(document.body).slice(0, 400)}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(10);
};
async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const t0 = performance.now();
  while (!check()) {
    if (performance.now() - t0 > timeoutMs) {
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 500)}`);
    }
    await settle(8);
  }
}
/** Types into a controlled field, or picks an option, the way a user does (React tracks the value itself). */
async function setValue(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await settle(10);
}
const button = (name: string | RegExp): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof name === "string" ? text(b) === name : name.test(text(b)),
  );
const tabs = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="pn-subtabs"] [role="tab"]')];
/** A pill's own label (the pill draws its label twice, for its animation). */
const label = (el: Element) => text(el.querySelector(".ptab-label") ?? el);
const tab = (name: string) => tabs().find((t) => label(t) === name);
const pathname = () => window.location.pathname;
const asked = () => world.gets.map((u) => u.split("?")[0]);
const changes = (method?: string) => world.calls.filter((c) => !method || c.method === method);

async function open(url: string, ready: string) {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(PhoneNotifyControl))));
  await waitFor(() => !!q(ready), ready);
  await settle(10);
}

const as = (permissions: Record<string, string>) => {
  h.user.current = { role: "hr", employeeId: null, permissions };
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  h.user.current = null; // no login in the test: every key is Edit (permissionLevel)
  install();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

// ── the tests ─────────────────────────────────────────────────────────────────

describe("the addresses", () => {
  it("the bare page opens the Overview at its own address, with the heading and the six tabs", async () => {
    await open(BASE, "pn-overview");
    expect(pathname()).toBe(`${BASE}/overview`);
    expect([...document.body.querySelectorAll("h2")].map(text)).toEqual(["Phone Notify Control"]);
    expect(tabs().map(label)).toEqual([
      "Overview",
      "Messages",
      "Employees",
      "Controls",
      "Send a message",
      "Configuration",
    ]);
    expect(tab("Overview")?.getAttribute("aria-selected")).toBe("true");
  });

  it("a click on a tab opens it at its own address, and only it asks the server for anything", async () => {
    await open(`${BASE}/messages`, "pn-messages");
    expect(asked()).not.toContain(`${API}/overview`);
    await click(tab("Employees"));
    await waitFor(() => !!q("pn-employees"), "the employees");
    expect(pathname()).toBe(`${BASE}/employees`);
    expect(q("pn-messages")).toBeNull();
    await click(tab("Configuration"));
    await waitFor(() => !!q("pn-config"), "the configuration");
    expect(pathname()).toBe(`${BASE}/configuration`);
  });

  it("an unknown tab lands on the first one, keeping the query string", async () => {
    await open(`${BASE}/nope?from=link`, "pn-overview");
    expect(`${window.location.pathname}${window.location.search}`).toBe(`${BASE}/overview?from=link`);
  });

  it("offers only the tabs the role may open, and sends a hidden one's address to the first open tab", async () => {
    as({
      phone_notify_control: "edit",
      "phone_notify_control.overview": "hidden",
      "phone_notify_control.send": "hidden",
    });
    await open(`${BASE}/send`, "pn-messages");
    expect(pathname()).toBe(`${BASE}/messages`);
    expect(tabs().map(label)).toEqual(["Messages", "Employees", "Controls", "Configuration"]);
    expect(asked()).not.toContain(`${API}/overview`);
  });

  it("follows Mobile App Login while nothing is set on the page, and says so when nothing is open", async () => {
    as({ mobile_app_login: "view" });
    await open(BASE, "pn-overview");
    expect(tabs()).toHaveLength(6);
    act(() => root?.unmount());
    host?.remove();
    world.gets = [];
    as({ mobile_app_login: "edit", phone_notify_control: "hidden" });
    await open(BASE, "pn-nothing-open");
    expect(world.gets).toEqual([]);
  });
});

describe("the overview", () => {
  it("shows the master switch, the phones and what became of the pushes, the chart and the kinds", async () => {
    await open(`${BASE}/overview`, "pn-overview");
    const t = text(must("pn-tiles"));
    for (const needle of ["ON", "2 of 3 kinds on", "31 / 40", "Pushed today", "24", "20", "83% of what went out"]) {
      expect(t, needle).toContain(needle);
    }
    expect(text(must("pn-read-rate"))).toContain("61.5%");
    expect(text(must("pn-counts"))).toContain("3 pushed");
    expect(text(must("pn-by-kind"))).toContain("Late Attendance Alert");
    expect(q("pn-bar-2026-11-17")).not.toBeNull();
    expect(q("pn-master-off")).toBeNull();
    expect(q("pn-health-banner")).toBeNull();
  });

  it("puts a warning on top when phone notifications are off, or the push service is not healthy", async () => {
    world.overview = overview({ pushEnabled: false });
    world.config = config({ state: "problem", note: "Google refused pushes: the app's Firebase key is missing." });
    await open(`${BASE}/overview`, "pn-overview");
    await waitFor(() => !!q("pn-health-banner"), "the health banner");
    expect(text(must("pn-master-off"))).toContain("Switch them on");
    expect(text(must("pn-health-banner"))).toContain("Firebase key is missing");
    expect(text(must("pn-tile-master"))).toContain("OFF");
  });

  it("offers a shortcut only into a tab the role may open, and reads the health only with Configuration open", async () => {
    world.overview = overview({ pushEnabled: false });
    as({
      phone_notify_control: "edit",
      "phone_notify_control.controls": "hidden",
      "phone_notify_control.configuration": "hidden",
    });
    await open(`${BASE}/overview`, "pn-overview");
    expect(text(must("pn-master-off"))).not.toContain("Switch them on");
    expect(asked()).not.toContain(`${API}/config`);
    expect(text(must("pn-tile-failed"))).toContain("See the failures");
  });

  it("a shortcut opens the Messages tab already filtered", async () => {
    await open(`${BASE}/overview`, "pn-overview");
    const link = [...must("pn-tile-failed").querySelectorAll("a")].find((a) => text(a).includes("See the failures"));
    await click(link);
    await waitFor(() => !!q("pn-messages"), "the messages");
    expect(`${window.location.pathname}${window.location.search}`).toBe(`${BASE}/messages?status=failed`);
    await waitFor(() => world.gets.some((u) => u.includes("/log?") && u.includes("status=failed")), "the filtered log");
  });

  it("says when the overview could not be loaded, with a Try again", async () => {
    world.failNext[`GET ${API}/overview`] = new Error("offline");
    await open(`${BASE}/overview`, "pn-overview-error");
    expect(button("Try again")).toBeDefined();
  });
});

describe("the messages", () => {
  it("lists each notification with what happened to its push, and filters through the address", async () => {
    await open(`${BASE}/messages`, "pn-row-1");
    const t = text(must("pn-message-table"));
    for (const needle of ["Asha Kumar", "(E7)", "Delivered to the phone", "Push failed", "No phone registered"]) {
      expect(t, needle).toContain(needle);
    }
    expect(t).toContain("Reason: DeviceNotRegistered");
    await setValue(must("pn-status-filter"), "failed");
    expect(window.location.search).toBe("?status=failed");
    await waitFor(() => !q("pn-row-1"), "the filtered list");
    expect(world.gets.some((u) => u.includes("/log?") && u.includes("status=failed"))).toBe(true);
    await click(must("pn-clear-filters"));
    expect(window.location.search).toBe("");
  });

  it("offers Push again only where the server allows it, and pushes that one again", async () => {
    await open(`${BASE}/messages`, "pn-row-1");
    expect(q("pn-again-1")).toBeNull();
    expect(q("pn-again-3")).toBeNull();
    await click(must("pn-again-2"));
    expect(changes()).toEqual([{ method: "POST", path: `${API}/log/2/push-again`, body: {} }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pushed again" }));
  });

  it("says why when a push again is refused", async () => {
    const refusal = Object.assign(new Error("HTTP 400"), {
      data: { error: "This employee has no phone registered for notifications." },
    });
    world.failNext[`POST ${API}/log/2/push-again`] = refusal;
    await open(`${BASE}/messages`, "pn-row-1");
    await click(must("pn-again-2"));
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not push it again",
        description: "This employee has no phone registered for notifications.",
        variant: "destructive",
      }),
    );
  });

  it("opens the details of one notification: the full text and what its result means", async () => {
    await open(`${BASE}/messages`, "pn-row-2");
    await click(must("pn-details-2"));
    const detail = must("pn-message-detail");
    expect(text(detail)).toContain("Hi Asha, your attendance has been marked as Late today.");
    expect(text(detail)).toContain("The push service refused it");
    expect(text(detail)).toContain("DeviceNotRegistered");
    expect(detail.querySelector('[data-testid="pn-again-2"]')).not.toBeNull();
  });
});

describe("the employees", () => {
  it("lists who has a phone and who is muted, and filters by what is picked", async () => {
    await open(`${BASE}/employees`, "pn-employee-7");
    expect(text(must("pn-employee-7"))).toContain("1 phone");
    expect(text(must("pn-employee-8"))).toContain("No phone yet");
    expect(text(must("pn-employee-8"))).toContain("Muted");
    expect(text(must("pn-employee-8"))).toContain("Production");
    await click(tabsIn("pn-employee-filter").find((b) => label(b) === "Muted"));
    expect(window.location.search).toBe("?show=muted");
    await waitFor(() => !q("pn-employee-7"), "the muted list");
    expect(world.gets.some((u) => u.includes("/devices?") && u.includes("muted=1"))).toBe(true);
  });

  it("mutes an employee only after asking in the page, and Cancel changes nothing", async () => {
    await open(`${BASE}/employees`, "pn-employee-7");
    await click(must("pn-mute-7"));
    expect(text(must("pn-confirm-mute-7"))).toContain("No phone notification will reach them");
    await click(button("Cancel"));
    expect(q("pn-confirm-mute-7")).toBeNull();
    expect(changes()).toEqual([]);
    await click(must("pn-mute-7"));
    await click(must("pn-confirm-mute-7-yes"));
    expect(changes()).toEqual([{ method: "PUT", path: `${API}/devices/7/mute`, body: { muted: true } }]);
    await waitFor(() => text(must("pn-employee-7")).includes("Unmute notifications"), "the muted row");
  });

  it("unmutes a muted employee", async () => {
    await open(`${BASE}/employees`, "pn-employee-8");
    expect(text(must("pn-mute-8"))).toBe("Unmute notifications");
    await click(must("pn-mute-8"));
    await click(must("pn-confirm-mute-8-yes"));
    expect(changes()).toEqual([{ method: "PUT", path: `${API}/devices/8/mute`, body: { muted: false } }]);
  });

  it("shows an employee's phones and removes one after asking", async () => {
    await open(`${BASE}/employees`, "pn-employee-7");
    expect(q("pn-phone-5")).toBeNull();
    await click(must("pn-phones-7"));
    expect(text(must("pn-phone-5"))).toContain("Android phone");
    await click(must("pn-remove-5"));
    expect(text(must("pn-confirm-remove-5"))).toContain("registers it again");
    await click(must("pn-confirm-remove-5-yes"));
    expect(changes()).toEqual([{ method: "DELETE", path: `${API}/devices/phones/5`, body: {} }]);
    await waitFor(() => text(must("pn-employee-7")).includes("No phone yet"), "the phone gone");
  });
});

/** The buttons inside a test id (a pill row). */
function tabsIn(id: string): HTMLButtonElement[] {
  return [...must(id).querySelectorAll<HTMLButtonElement>("button")];
}

describe("the controls", () => {
  it("groups the switches in the page's order, each with where it is sent from, who gets it and its 30 days", async () => {
    await open(`${BASE}/controls`, "pn-controls");
    const groups = [...document.body.querySelectorAll('[data-testid^="pn-group-"]')]
      .map((g) => g.getAttribute("data-testid"))
      .filter((id) => /^pn-group-[a-z_]+$/.test(id ?? ""));
    expect(groups).toEqual(["pn-group-attendance", "pn-group-approvals", "pn-group-approval_workflows"]);
    const late = text(must("pn-control-late_alert"));
    for (const needle of ["To the employee", "Also by WhatsApp", "Sent from: Sent from Late Attendance Alert"]) {
      expect(late, needle).toContain(needle);
    }
    expect(text(must("pn-stats-late_alert"))).toContain("9 saved · 7 pushed · 6 delivered · 1 failed · 1 no phone");
    expect(text(must("pn-control-approval_waiting"))).toContain("To the approver");
    expect(text(must("pn-control-approval_waiting"))).not.toContain("Also by WhatsApp");
    expect(text(must("pn-group-approval_workflows"))).toContain("both its own kind above and its workflow");
    expect(text(must("pn-controls"))).toContain("only stop the push to the phone");
  });

  it("switches one kind, a whole group (only the ones that change) and, after asking, the master switch", async () => {
    await open(`${BASE}/controls`, "pn-controls");
    await click(must("pn-toggle-late_alert"));
    await waitFor(() => changes().length === 1, "the first change");
    await click(must("pn-group-on-attendance"));
    await waitFor(() => changes().length === 2, "the group change");
    expect(changes().map((c) => c.body)).toEqual([
      { types: { late_alert: false } },
      { types: { late_alert: true, absent_alert: true } },
    ]);
    await click(must("pn-master-switch"));
    expect(text(must("pn-confirm-master"))).toContain("No notification will be pushed to any phone");
    expect(changes()).toHaveLength(2);
    await click(must("pn-confirm-master-yes"));
    await waitFor(() => changes().length === 3, "the master switch");
    expect(changes()[2].body).toEqual({ pushEnabled: false });
    await waitFor(() => must("pn-master").getAttribute("data-state") === "off", "the master switch OFF");
    expect(q("pn-master-off-note")).not.toBeNull();
  });
});

describe("sending a message", () => {
  it("sends one message to one chosen employee", async () => {
    await open(`${BASE}/send`, "pn-send");
    await waitFor(() => !!q("pn-pick-E7"), "the employees to pick from");
    const send = () => must("pn-send-button") as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    await click(must("pn-pick-E7"));
    expect(text(must("pn-picked"))).toContain("To Asha Kumar");
    await setValue(must("pn-title"), "Test");
    await setValue(must("pn-message"), "Does this reach?");
    expect(send().disabled).toBe(false);
    await click(send());
    expect(changes()).toEqual([
      { method: "POST", path: `${API}/send`, body: { employeeId: 7, title: "Test", message: "Does this reach?" } },
    ]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Message sent to the phone" }));
  });

  it("tells HR a muted employee will only get it in the app", async () => {
    await open(`${BASE}/send`, "pn-send");
    await waitFor(() => !!q("pn-pick-E8"), "the employees to pick from");
    await click(must("pn-pick-E8"));
    expect(text(must("pn-picked"))).toContain("They are muted, so it will only be in the app");
  });
});

describe("the configuration", () => {
  it("explains the road a push takes, the service, the health with the reasons and the phones", async () => {
    await open(`${BASE}/configuration`, "pn-config");
    const flow = text(must("pn-config-flow"));
    for (const needle of [
      "1. Saved in the HRMS",
      "2. Handed to the Expo push service",
      "Firebase",
      "4. On the phone",
    ]) {
      expect(flow, needle).toContain(needle);
    }
    expect(must("pn-health-state").getAttribute("data-state")).toBe("ok");
    expect(text(must("pn-failure-reasons"))).toContain("App uninstalled / notifications reset");
    expect(text(must("pn-failure-reasons"))).toContain("uninstalled or its notifications were reset");
    const service = text(must("pn-config-service"));
    expect(service).toContain("https://exp.host/--/api/v2/push/send");
    expect(service).toContain("net.uktex.employee");
    expect(text(must("pn-config-phones"))).toContain("33 phones");
  });
});

describe("a View-only tab", () => {
  it("shows the switches but changes nothing", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.controls": "view" });
    await open(`${BASE}/controls`, "pn-controls");
    expect((must("pn-toggle-late_alert") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-master-switch") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-group-on-attendance") as HTMLButtonElement).disabled).toBe(true);
    await click(must("pn-toggle-late_alert"));
    expect(changes()).toEqual([]);
    // the tabs stay usable: they only open a tab
    expect(tabs().every((t) => !(t as HTMLButtonElement).disabled)).toBe(true);
  });

  it("locks Push again, Mute, Remove and Send, and leaves looking around open", async () => {
    as({ phone_notify_control: "view" });
    await open(`${BASE}/messages`, "pn-row-2");
    expect((must("pn-again-2") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-details-2") as HTMLButtonElement).disabled).toBe(false);
    await click(tab("Employees"));
    await waitFor(() => !!q("pn-employee-7"), "the employees");
    expect((must("pn-mute-7") as HTMLButtonElement).disabled).toBe(true);
    await click(must("pn-phones-7"));
    expect((must("pn-remove-5") as HTMLButtonElement).disabled).toBe(true);
    await click(tab("Send a message"));
    await waitFor(() => !!q("pn-pick-E7"), "the employees to pick from");
    await click(must("pn-pick-E7"));
    await setValue(must("pn-title"), "Test");
    await setValue(must("pn-message"), "Hello");
    expect((must("pn-send-button") as HTMLButtonElement).disabled).toBe(true);
    expect(changes()).toEqual([]);
  });
});
