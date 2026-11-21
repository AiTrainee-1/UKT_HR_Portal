import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CasualLeave from "../CasualLeave";
import { apiError, click, must, q, text, typeInto, waitFor } from "../settings/endpoint-sharing/testing";
import type { ClBoard, ClRequest } from "./logic";

// The Casual Leave decision (owner brief 2026-11-21): Approve is sent at once with no remark; Reject asks for the reason,
// sends nothing until one of at least 3 characters is written, and sends it as the review comment.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: null }),
}));
vi.mock("@/components/ApprovalTrail", async (original) => ({
  ...(await original<typeof import("@/components/ApprovalTrail")>()),
  PipelineNote: () => null,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

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

let root: Root | null = null;
let host: HTMLElement | null = null;
let sent: { url: string; body: Record<string, unknown> }[];
let refuse: unknown;

const board: ClBoard = { month: 10, year: 2026, eligibilityMonths: 6, employees: [] };
const pending: ClRequest = {
  id: 12,
  employeeId: 9,
  employeeName: "Lakshmi",
  employeeCode: "E9",
  date: "2026-10-20",
  reason: "Family function",
  status: "pending",
  branch: "Head Office",
  branchId: 1,
  employmentType: "staff",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-15T10:00:00") });
  window.history.replaceState(null, "", "/hr/casual-leave?tab=requests");
  sent = [];
  refuse = null;
  h.toast.mockReset();
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return [];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, body });
    if (refuse) throw refuse;
    return { ...pending, status: body.status };
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  vi.useRealTimers();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["/api/casual-leaves/eligibility", 10, 2026, "board"], board);
  client.setQueryData(["/api/casual-leaves", null, 10, 2026], [pending]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(CasualLeave))));
}

const rowButton = (name: string) =>
  [...must("cl-12").querySelectorAll("button")].find((b) => text(b) === name) as HTMLButtonElement;

describe("deciding a Casual Leave request", () => {
  it("approves at once, with no remark asked for", async () => {
    mount();
    click(rowButton("Approve"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({ url: "/api/casual-leaves/12", body: { status: "approved" } });
    expect(q("cl-reject-dialog")).toBeNull();
  });

  it("asks for the reason first and sends nothing without one", async () => {
    mount();
    click(rowButton("Reject"));
    expect(text(q("cl-reject-dialog"))).toContain("Lakshmi's Casual Leave for Tue, 20 Oct 2026");
    click(must("cl-reject-confirm"));
    expect(text(q("cl-reject-dialog"))).toContain("Write the reason for rejecting (at least 3 characters).");
    typeInto(must("cl-reject-text") as HTMLTextAreaElement, "no");
    click(must("cl-reject-confirm"));
    expect(sent).toEqual([]);
  });

  it("sends the reason as the review comment, then closes", async () => {
    mount();
    click(rowButton("Reject"));
    typeInto(must("cl-reject-text") as HTMLTextAreaElement, " Month-end   dispatch ");
    click(must("cl-reject-confirm"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({
      url: "/api/casual-leaves/12",
      body: { status: "rejected", comment: "Month-end dispatch" },
    });
    await waitFor(() => !q("cl-reject-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Casual leave rejected" }));
  });

  it("keeps the dialog open with the server's words when it refuses", async () => {
    refuse = apiError(400, {
      error: "Write the reason for rejecting (at least 3 characters).",
      code: "remark_required",
    });
    mount();
    click(rowButton("Reject"));
    typeInto(must("cl-reject-text") as HTMLTextAreaElement, "Dispatch");
    click(must("cl-reject-confirm"));
    await waitFor(() => !!q("cl-reject-error"), "the refusal");
    expect(text(q("cl-reject-error"))).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(h.toast).not.toHaveBeenCalled();
  });
});
