import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ApprovedRequests from "../ApprovedRequests";
import { EMPTY_STATS, type HubItem, type HubKind, type HubResponse } from "./logic";

// The Requests page with its three sections beside the heading: Requests (the list, unchanged), HoD's and Notify. The
// sections are in the address (?tab=), the list's own ?kind= stays, and ?kind=&focus= (a HoD's link) opens that request. The
// list's data and the two new sections are stand-ins here; each has its own tests.

const h = vi.hoisted(() => ({ hub: null as unknown, placeholder: false, toast: vi.fn() }));

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
  useHubRequests: () => ({
    data: h.hub,
    dataUpdatedAt: 1,
    isError: false,
    isPlaceholderData: h.placeholder,
    refetch: vi.fn(),
  }),
  useDecide: () => ({ mutateAsync: vi.fn() }),
  useHandleRequest: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./reminders", async (original) => ({
  ...(await original<typeof import("./reminders")>()),
  useHrReminders: () => ({ data: [] }),
}));
vi.mock("./hods/HodsTab", () => ({
  default: ({ onOpenRequest }: { onOpenRequest: (path: string) => void }) => (
    <div data-testid="stub-hods">
      <button type="button" data-testid="stub-open" onClick={() => onOpenRequest("/hr/requests?kind=leave&focus=2")}>
        Open
      </button>
      <button type="button" data-testid="stub-open-other" onClick={() => onOpenRequest("/hr/compensation")}>
        Elsewhere
      </button>
    </div>
  ),
}));
vi.mock("./notify/NotifyTab", () => ({ default: () => <div data-testid="stub-notify" /> }));

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

const kind = (key: HubKind["key"], label: string): HubKind => ({
  key,
  label,
  group: "Requests",
  access: "edit",
  mode: "quick",
  openPath: null,
  openLabel: null,
  pipeline: "Employee → HOD → HR",
  enabled: true,
  waiting: 1,
  waitingHr: 0,
  waitingHod: 1,
  matched: 1,
  truncated: false,
});

const leave = (id: number, name: string): HubItem => ({
  key: `leave-${id}`,
  kind: "leave",
  id,
  employee: {
    id,
    code: `E${id}`,
    name,
    department: "Cutting",
    departmentId: 5,
    designation: null,
    branch: null,
    branchId: null,
    type: "staff",
    photoUrl: null,
  },
  label: "Leave",
  summary: "05 Nov 2026 · 1 day",
  reason: "family",
  date: "2026-11-05",
  details: [],
  status: "pending",
  rawStatus: "pending",
  statusLabel: null,
  queue: "hod",
  approval: null,
  submittedAt: "2026-11-01T04:00:00Z",
  decided: null,
  extra: {},
});

const HUB: HubResponse = {
  kinds: [kind("leave", "Leave"), kind("permission", "Permission")],
  stats: { ...EMPTY_STATS, waiting: 2, waitingHod: 2 },
  items: [leave(1, "Asha Kumar"), leave(2, "Bala Murugan")],
  limit: 200,
  options: { branches: [], departments: [] },
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  h.hub = HUB;
  h.placeholder = false;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

function open(url: string) {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ApprovedRequests)));
}

const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const sections = () => [...document.body.querySelectorAll('[data-testid="requests-sections"] [role="tab"]')];
const section = (label: string) => sections().find((t) => text(t).startsWith(label)) ?? null;

describe("the sections beside the heading", () => {
  it("are Requests, HoD's and Notify; the bare address is the list, as before", () => {
    open("/hr/requests");
    // a pill draws its label twice (the second is its hover animation): the first is the one read
    expect(sections().map((t) => text(t.querySelector(".ptab-label")))).toEqual(["Requests", "HoD's", "Notify"]);
    expect(section("Requests")?.getAttribute("aria-selected")).toBe("true");
    expect(q("requests-figures")).not.toBeNull();
    expect(q("requests-tabs")).not.toBeNull();
    expect(text(q("requests-section-note"))).toContain("auto-refreshes every 30 s");
    expect(q("stub-hods")).toBeNull();
  });

  it("switch by the address, keeping the list's kind, and back again", () => {
    open("/hr/requests?kind=leave");
    click(section("HoD's"));
    expect(window.location.search).toBe("?kind=leave&tab=hods");
    expect(q("stub-hods")).not.toBeNull();
    expect(q("requests-figures")).toBeNull();
    expect(text(q("requests-section-note"))).toContain("Department Head");
    click(section("Notify"));
    expect(window.location.search).toBe("?kind=leave&tab=notify");
    expect(q("stub-notify")).not.toBeNull();
    click(section("Requests"));
    expect(window.location.search).toBe("?kind=leave");
    expect(q("requests-figures")).not.toBeNull();
    // the list is still on Leave
    const leaveTab = [...document.body.querySelectorAll('[data-testid="requests-tabs"] [role="tab"]')].find((t) =>
      text(t).startsWith("Leave"),
    );
    expect(leaveTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("open straight on a section from a link", () => {
    open("/hr/requests?tab=notify");
    expect(section("Notify")?.getAttribute("aria-selected")).toBe("true");
    expect(q("stub-notify")).not.toBeNull();
  });
});

describe("opening one request", () => {
  it("?kind=&focus= opens its details once the list is in, and leaves the address", () => {
    open("/hr/requests?kind=leave&focus=2");
    const detail = document.body.querySelector('[data-testid="request-detail"]');
    expect(detail).not.toBeNull();
    expect(text(detail)).toContain("Bala Murugan");
    expect(window.location.search).toBe("?kind=leave");
  });

  it("says so when the request is not in the list", () => {
    open("/hr/requests?kind=leave&focus=99");
    expect(document.body.querySelector('[data-testid="request-detail"]')).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "That request is not in the list" }));
  });

  it("waits for the real list, not the one kept on screen while a new one loads", () => {
    h.placeholder = true;
    open("/hr/requests?kind=leave&focus=99");
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("a HoD's link switches to the list in place and opens the request", () => {
    open("/hr/requests?tab=hods");
    click(q("stub-open"));
    expect(window.location.pathname).toBe("/hr/requests");
    expect(window.location.search).toBe("?kind=leave");
    expect(q("requests-figures")).not.toBeNull();
    expect(text(document.body.querySelector('[data-testid="request-detail"]'))).toContain("Bala Murugan");
  });

  it("a link to another page is simply followed", () => {
    open("/hr/requests?tab=hods");
    click(q("stub-open-other"));
    expect(window.location.pathname).toBe("/hr/compensation");
  });
});
