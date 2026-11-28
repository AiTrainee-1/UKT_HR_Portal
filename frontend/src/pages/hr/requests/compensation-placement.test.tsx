// Compensation days on a chosen date (owner brief 2026-11-28) in the Requests hub: the kind `compensation_placement`, a
// Shift / Overtime / Sunday / Holiday work compensation (or the balance) HR placed on a date, decided by the Department Head
// first and then by HR here (Approve / Reject call PATCH /api/compensation/placements/<id>/decision; a rejection needs its
// reason). The holiday_work kind no longer lists these rows.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalProgress } from "@/lib/approval-workflow";
import ApprovedRequests from "../ApprovedRequests";
import { decisionCall } from "./api";
import { EMPTY_STATS, KIND_KEYS, decisionsHere, type HubItem, type HubKind, type HubResponse } from "./logic";
import { KIND_VISUAL } from "./parts";

const h = vi.hoisted(() => ({
  hub: null as unknown,
  fetch: vi.fn(),
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
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
// the list comes from the test; deciding goes through the page's real decision hook (and so through customFetch)
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useHubRequests: () => ({ data: h.hub, dataUpdatedAt: 1, isError: false, isPlaceholderData: false, refetch: vi.fn() }),
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

const twoSteps = (hrTurn: boolean): ApprovalProgress => ({
  workflow: "compensation_placement",
  label: "Compensation days (chosen dates)",
  enabled: true,
  steps: [
    { index: 0, roles: ["hod"], mandatory: true, state: hrTurn ? "approved" : "pending", label: "HOD" },
    { index: 1, roles: ["hr"], mandatory: true, state: hrTurn ? "pending" : "waiting", label: "HR" },
  ],
  currentStep: hrTurn ? 1 : 0,
  waitingFor: [hrTurn ? "hr" : "hod"],
  canAct: { hod: !hrTurn, hr: hrTurn },
  canReject: { hod: !hrTurn, hr: hrTurn },
  hrTurn,
  hrPermitted: true,
});

// what GET /api/hr-requests sends for a placement the Department Head has approved (hr_requests_views._compensation_placement)
const ITEM: HubItem = {
  key: "compensation_placement-77",
  kind: "compensation_placement",
  id: 77,
  employee: {
    id: 5,
    code: "1001",
    name: "Asha K",
    department: "Cutting",
    departmentId: 2,
    designation: null,
    branch: "Head Office",
    branchId: 1,
    type: "staff",
    photoUrl: null,
  },
  label: "Sunday compensation",
  summary: "2026-12-02 · 0.5 shift",
  reason: "Placed for the employee at their request",
  reasonLabel: "Reason",
  requested: { from: "2026-12-02", to: null, note: "0.5 shift", label: "Day off on", precision: "day" },
  date: "2026-12-02",
  details: [
    { label: "Day off on", value: "2026-12-02" },
    { label: "Shifts", value: "0.50" },
    { label: "From the credit of", value: "2026-11-22" },
    { label: "Placed by", value: "Admin" },
  ],
  status: "pending",
  rawStatus: "pending",
  statusLabel: "Approved by the Department Head, waiting for HR",
  queue: "hr",
  approval: twoSteps(true),
  submittedAt: "2026-11-25T04:30:00Z",
  decided: { by: "Suresh Raj", role: "hod", at: "2026-11-26T05:00:00Z", comment: null },
  extra: {
    claimKind: "use_balance",
    compType: "sunday",
    useDate: "2026-12-02",
    openPath: "/hr/compensation/compensation-leave/holiday-work/claims?hmonth=all&hemp=5&hclaim=77",
  },
};

const KIND: HubKind = {
  key: "compensation_placement",
  label: "Compensation days (chosen dates)",
  group: "Compensation",
  access: "edit",
  canApprove: true,
  mode: "quick",
  openPath: "/hr/compensation/compensation-leave/holiday-work/claims",
  openLabel: "Compensation",
  pipeline: "HR → HOD → HR",
  enabled: true,
  waiting: 1,
  waitingHr: 1,
  waitingHod: 0,
  matched: 1,
  truncated: false,
};

const HUB: HubResponse = {
  kinds: [KIND],
  stats: { ...EMPTY_STATS, waiting: 1, waitingHr: 1 },
  items: [ITEM],
  limit: 25,
  options: { branches: [], departments: [] },
  page: 1,
  pageSize: 25,
  total: 1,
  pages: 1,
  focusItem: null,
};

describe("the kind", () => {
  it("is a kind the page knows, with its own icon and tint", () => {
    expect(KIND_KEYS).toContain("compensation_placement");
    expect(KIND_VISUAL.compensation_placement.tile).toBe("bg-purple-50 text-purple-600");
  });

  it("is decided by HR through the placement's decision endpoint, with the reason as the comment", () => {
    expect(decisionCall({ item: { kind: "compensation_placement", id: 77 }, status: "approved" })).toEqual({
      url: "/api/compensation/placements/77/decision",
      method: "PATCH",
      body: { status: "approved", comment: undefined },
    });
    expect(
      decisionCall({ item: { kind: "compensation_placement", id: 77 }, status: "rejected", comment: " Not this day " }),
    ).toEqual({
      url: "/api/compensation/placements/77/decision",
      method: "PATCH",
      body: { status: "rejected", comment: "Not this day" },
    });
  });

  it("offers Approve and Reject only once the Department Head has approved", () => {
    expect(decisionsHere(ITEM, KIND)).toMatchObject({ approve: true, reject: true, why: null });
    const atHod = { ...ITEM, queue: "hod" as const, approval: twoSteps(false) };
    expect(decisionsHere(atHod, KIND)).toMatchObject({ approve: false, reject: false });
    // an account without the "compensation_placement" approval right
    expect(decisionsHere(ITEM, { ...KIND, canApprove: false, access: "view" })).toMatchObject({
      approve: false,
      reject: false,
    });
  });
});

// ── the page ──

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  h.hub = HUB;
  h.fetch.mockImplementation(async () => ({}));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

function open(url = "/hr/requests?kind=compensation_placement") {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(ApprovedRequests))));
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
function type(el: Element | null, value: string) {
  const box = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const decisions = () =>
  h.fetch.mock.calls
    .filter(([url]) => String(url).includes("/compensation/placements/"))
    .map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      body: JSON.parse(String((init as RequestInit).body)),
    }));

describe("on the Requests page", () => {
  it("lists it under its own tab: what it is, the day off and the amount, with Approve and Reject", () => {
    open();
    const row = q("request-compensation_placement-77")!;
    expect(row).not.toBeNull();
    expect(text(row)).toContain("Sunday compensation");
    expect(text(q("requested-compensation_placement-77"))).toBe("Day off on: 2 Dec 2026 · 0.5 shift");
    expect(text(row)).toContain("Waiting for HR");
    expect(text(q("reason-compensation_placement-77"))).toContain("Placed for the employee at their request");
    expect(q("approve-compensation_placement-77")).not.toBeNull();
    expect(q("reject-compensation_placement-77")).not.toBeNull();
  });

  it("Approve sends HR's approval to the decision endpoint", async () => {
    open();
    click(q("approve-compensation_placement-77"));
    await settle();
    expect(decisions()).toEqual([
      { url: "/api/compensation/placements/77/decision", method: "PATCH", body: { status: "approved" } },
    ]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Compensation days (chosen dates) approved" }),
    );
  });

  it("Reject asks for the reason first (the shared dialog), then sends it", async () => {
    open();
    click(q("reject-compensation_placement-77"));
    await settle();
    expect(q("request-reject-dialog")).not.toBeNull();
    click(q("request-reject-confirm"));
    await settle();
    expect(decisions()).toEqual([]);
    type(q("request-reject-text"), "  The day is needed for dispatch  ");
    click(q("request-reject-confirm"));
    await settle();
    expect(decisions()).toEqual([
      {
        url: "/api/compensation/placements/77/decision",
        method: "PATCH",
        body: { status: "rejected", comment: "The day is needed for dispatch" },
      },
    ]);
  });
});
