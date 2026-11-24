import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ApprovedRequests from "../ApprovedRequests";
import { EMPTY_STATS, type HubKind, type HubResponse } from "./logic";

// The Requests page's date filter (owner brief 2026-11-24): This Month by default, Today / Yesterday / an earlier month /
// Custom, in the address; the server is asked for the requests FOR those days (from / to) and the figures follow them; the
// requests still waiting on other days are named under the filter, with a way to reach them.

const h = vi.hoisted(() => ({
  hub: null as unknown,
  params: [] as Record<string, string>[],
  toast: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: null }),
}));
vi.mock("@/components/ApprovalTrail", async (original) => ({
  ...(await original<typeof import("@/components/ApprovalTrail")>()),
  PipelineSummary: () => null,
}));
vi.mock("./api", () => ({
  useHubRequests: (params: Record<string, string>) => {
    h.params.push(params);
    return { data: h.hub, dataUpdatedAt: 1, isError: false, isPlaceholderData: false, refetch: vi.fn() };
  },
  useDecide: () => ({ mutateAsync: vi.fn() }),
  useHandleRequest: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./reminders", async (original) => ({
  ...(await original<typeof import("./reminders")>()),
  useHrReminders: () => ({ data: [] }),
}));
vi.mock("./hods/HodsTab", () => ({ default: () => null }));
vi.mock("./notify/NotifyTab", () => ({ default: () => null }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

const kind: HubKind = {
  key: "leave",
  label: "Leave",
  group: "Requests",
  access: "edit",
  mode: "quick",
  openPath: null,
  openLabel: null,
  pipeline: "Employee → HR",
  enabled: true,
  waiting: 1,
  waitingHr: 1,
  waitingHod: 0,
  matched: 0,
  truncated: false,
};

// what the server answers with from / to: the figures of those days, and the waiting requests of other days apart
const HUB: HubResponse = {
  kinds: [kind],
  stats: {
    ...EMPTY_STATS,
    waiting: 1,
    waitingHr: 1,
    approvedThisMonth: 4,
    rejectedThisMonth: 2,
    range: { from: "2026-11-01", to: "2026-11-30" },
    allWaiting: 3,
    outsideWaiting: 2,
    outsideEarliest: "2026-10-28",
  },
  items: [],
  limit: 25,
  options: { branches: [], departments: [] },
  page: 1,
  pageSize: 25,
  total: 0,
  pages: 1,
  focusItem: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T06:00:00Z")); // Tuesday 24 Nov 2026, 11:30 in India
  h.hub = HUB;
  h.params = [];
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

function open(url = "/hr/requests") {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ApprovedRequests)));
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const last = () => h.params.at(-1)!;

describe("the Requests page's date filter", () => {
  it("opens on This Month and asks the server for the requests for its days", () => {
    open();
    expect(q("requests-dates-month")?.getAttribute("aria-pressed")).toBe("true");
    expect(last()).toMatchObject({ from: "2026-11-01", to: "2026-11-30", page: "1" });
    expect(text(q("requests-dates-label"))).toBe("Showing November 2026");
    // the submitted-date period filter is gone: one date filter on the page
    expect(q("filter-period")).toBeNull();
  });

  it("the figures say whose days they count; the header's badge still counts every waiting request", () => {
    open();
    expect(text(q("figure-approved"))).toContain("4");
    expect(text(q("figure-approved"))).toContain("Requests for November 2026");
    expect(text(q("figure-rejected"))).toContain("Requests for November 2026");
    expect(text(q("figure-waiting-hr"))).toContain("November 2026");
    expect(text(document.body.querySelector("h2"))).toContain("3 pending");
  });

  it("Today, Yesterday and an earlier month each ask for their own days, kept in the address", () => {
    open("/hr/requests?kind=leave");
    click(q("requests-dates-today"));
    expect(last()).toMatchObject({ kind: "leave", from: "2026-11-24", to: "2026-11-24", page: "1" });
    expect(window.location.search).toBe("?kind=leave&range=today");
    click(q("requests-dates-yesterday"));
    expect(last()).toMatchObject({ from: "2026-11-23", to: "2026-11-23" });
    click(q("requests-dates-prev"));
    expect(last()).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(window.location.search).toBe("?kind=leave&month=2026-10");
  });

  it("a shared link opens on its days", () => {
    open("/hr/requests?range=custom&from=2026-11-03&to=2026-11-09");
    expect(last()).toMatchObject({ from: "2026-11-03", to: "2026-11-09" });
    expect(text(q("requests-dates-label"))).toBe("Showing 3 Nov – 9 Nov 2026");
  });

  it("names the requests waiting on other days, and Show them reaches back to the earliest", () => {
    open();
    expect(text(q("requests-outside"))).toContain("2 more requests waiting outside November 2026");
    expect(text(q("requests-outside"))).toContain("the earliest is for 28 Oct 2026");
    click(q("requests-outside-show"));
    expect(last()).toMatchObject({ from: "2026-10-28", to: "2026-11-24" });
    expect(window.location.search).toBe("?range=custom&from=2026-10-28&to=2026-11-24");
  });

  it("says nothing about other days when the server does not send them (an older server)", () => {
    h.hub = { ...HUB, stats: { ...EMPTY_STATS, waiting: 1 } };
    open();
    expect(q("requests-outside")).toBeNull();
    expect(text(document.body.querySelector("h2"))).toContain("1 pending");
  });
});
