// Birthday Compensation on a chosen date (owner 2026-11-25) in the Requests hub: the kind `birthday_compensation`, decided
// by the Department Head first and then by HR here (Approve / Reject call PATCH .../birthday-compensation/uses/<id>/decision;
// a rejection needs its reason). A row says the day it is placed on, the part of the day and the birthday it belongs to.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalProgress } from "@/lib/approval-workflow";
import ApprovedRequests from "../ApprovedRequests";
import { decisionCall } from "./api";
import {
  EMPTY_STATS,
  KIND_KEYS,
  birthdayOf,
  decisionsHere,
  normalizeHub,
  type HubItem,
  type HubKind,
  type HubResponse,
} from "./logic";
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
  workflow: "birthday_compensation",
  label: "Birthday Compensation",
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

// what GET /api/hr-requests sends for a placement the Department Head has approved (hr_requests_views._birthday_compensation)
const ITEM: HubItem = {
  key: "birthday_compensation-9",
  kind: "birthday_compensation",
  id: 9,
  employee: {
    id: 31,
    code: "E31",
    name: "Mala Iyer",
    department: "Sales",
    departmentId: 1,
    designation: null,
    branch: "Head Office",
    branchId: 2,
    type: "staff",
    photoUrl: null,
  },
  label: "Birthday Compensation · first half",
  summary: "2026-11-20 · first half (birthday 2026-11-12)",
  reason: "Family function",
  reasonLabel: "Reason",
  requested: { from: "2026-11-20", to: null, note: "first half", label: "Placed on", precision: "day" },
  date: "2026-11-20",
  details: [
    { label: "Placed on", value: "2026-11-20" },
    { label: "Day part", value: "First half" },
    { label: "Days", value: "0.50" },
    { label: "Birthday", value: "2026-11-12" },
    { label: "Raised by", value: "Mala Iyer (employee)" },
  ],
  status: "pending",
  rawStatus: "pending",
  statusLabel: null,
  queue: "hr",
  approval: twoSteps(true),
  submittedAt: "2026-11-18T04:30:00Z",
  decided: { by: "Suresh Raj", role: "hod", at: "2026-11-19T05:00:00Z", comment: null },
  extra: {
    birthday: "2026-11-12",
    portion: "first_half",
    days: 0.5,
    raisedByRole: "employee",
    decisionPath: "/api/compensation/birthday-compensation/uses/9/decision",
  },
};

const KIND: HubKind = {
  key: "birthday_compensation",
  label: "Birthday Compensation",
  group: "Compensation",
  access: "edit",
  canApprove: true,
  mode: "quick",
  openPath: "/hr/compensation/compensation-leave/birthdays",
  openLabel: "Compensation",
  pipeline: "Employee or HR → HOD → HR",
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
    expect(KIND_KEYS).toContain("birthday_compensation");
    expect(KIND_VISUAL.birthday_compensation.tile).toBe("bg-fuchsia-50 text-fuchsia-600");
  });

  it("is called Birthday compensation, in the page's sentence case", () => {
    const hub = normalizeHub({ ...HUB, focusItem: ITEM });
    expect(hub.kinds[0].label).toBe("Birthday compensation");
    expect(hub.items[0].label).toBe("Birthday compensation · first half");
    expect(hub.focusItem?.label).toBe("Birthday compensation · first half");
    // other kinds keep the server's words
    const leave = normalizeHub({ kinds: [{ ...KIND, key: "leave", label: "Leave" }] });
    expect(leave.kinds[0].label).toBe("Leave");
  });

  it("knows the birthday a placement belongs to", () => {
    expect(birthdayOf(ITEM)).toBe("2026-11-12");
    expect(birthdayOf({ kind: "leave", extra: { birthday: "2026-11-12" } })).toBeNull();
  });

  it("is decided by HR through the Birthday Compensation decision endpoint, with the reason as the comment", () => {
    expect(decisionCall({ item: { kind: "birthday_compensation", id: 9 }, status: "approved" })).toEqual({
      url: "/api/compensation/birthday-compensation/uses/9/decision",
      method: "PATCH",
      body: { status: "approved", comment: undefined },
    });
    expect(
      decisionCall({ item: { kind: "birthday_compensation", id: 9 }, status: "rejected", comment: " Not this day " }),
    ).toEqual({
      url: "/api/compensation/birthday-compensation/uses/9/decision",
      method: "PATCH",
      body: { status: "rejected", comment: "Not this day" },
    });
  });

  it("offers Approve and Reject only once the Department Head has approved", () => {
    expect(decisionsHere(ITEM, KIND)).toMatchObject({ approve: true, reject: true, why: null });
    const atHod = { ...ITEM, queue: "hod" as const, approval: twoSteps(false) };
    expect(decisionsHere(atHod, KIND)).toMatchObject({
      approve: false,
      reject: false,
      why: "Waiting for HOD: HR cannot decide it until that step is done.",
    });
    // an account without the Birthday Compensation approval right
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

function open(url = "/hr/requests?kind=birthday_compensation") {
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
    .filter(([url]) => String(url).includes("/birthday-compensation/"))
    .map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      body: JSON.parse(String((init as RequestInit).body)),
    }));

describe("on the Requests page", () => {
  it("lists it under its own tab: the day it is placed on, the part, the birthday and the reason", () => {
    open();
    const row = q("request-birthday_compensation-9")!;
    expect(row).not.toBeNull();
    expect(text(row)).toContain("Birthday compensation · first half");
    expect(text(q("requested-birthday_compensation-9"))).toBe("Placed on: 20 Nov 2026 · first half");
    expect(text(q("birthday-of-birthday_compensation-9"))).toBe("Birthday: 12 Nov 2026");
    expect(text(q("reason-birthday_compensation-9"))).toContain("Family function");
    expect(text(row)).toContain("Waiting for HR");
    expect(q("approve-birthday_compensation-9")).not.toBeNull();
    expect(q("reject-birthday_compensation-9")).not.toBeNull();
  });

  it("Approve sends HR's approval to the decision endpoint", async () => {
    open();
    click(q("approve-birthday_compensation-9"));
    await settle();
    expect(decisions()).toEqual([
      {
        url: "/api/compensation/birthday-compensation/uses/9/decision",
        method: "PATCH",
        body: { status: "approved" },
      },
    ]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Birthday compensation approved" }));
  });

  it("Reject asks for the reason first (the shared dialog), then sends it", async () => {
    open();
    click(q("reject-birthday_compensation-9"));
    await settle();
    expect(q("request-reject-dialog")).not.toBeNull();
    expect(text(q("request-reject-dialog"))).toContain("Reject this birthday compensation request?");
    click(q("request-reject-confirm"));
    await settle();
    expect(decisions()).toEqual([]); // no reason, nothing sent
    type(q("request-reject-text"), "  The day is needed for dispatch  ");
    click(q("request-reject-confirm"));
    await settle();
    expect(decisions()).toEqual([
      {
        url: "/api/compensation/birthday-compensation/uses/9/decision",
        method: "PATCH",
        body: { status: "rejected", comment: "The day is needed for dispatch" },
      },
    ]);
  });

  it("shows the server's refusal inside the reject dialog", async () => {
    h.fetch.mockImplementation(async () => {
      throw Object.assign(new Error("HTTP 409"), {
        data: {
          error: "Mala Iyer worked on Friday 20 Nov 2026 meanwhile: there is nothing to make up.",
          code: "use_refused",
        },
      });
    });
    open();
    click(q("reject-birthday_compensation-9"));
    await settle();
    type(q("request-reject-text"), "Not this day");
    click(q("request-reject-confirm"));
    await settle();
    expect(text(q("request-reject-error"))).toBe(
      "Mala Iyer worked on Friday 20 Nov 2026 meanwhile: there is nothing to make up.",
    );
  });

  it("while it waits for the Department Head, HR only follows it", () => {
    h.hub = { ...HUB, items: [{ ...ITEM, queue: "hod", approval: twoSteps(false), decided: null }] };
    open();
    expect(text(q("request-birthday_compensation-9"))).toContain("Waiting for HOD");
    expect(q("approve-birthday_compensation-9")).toBeNull();
    expect(q("reject-birthday_compensation-9")).toBeNull();
  });
});
