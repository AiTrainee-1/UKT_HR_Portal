import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import MissingPunch from "../MissingPunch";
import {
  apiError,
  click,
  installBrowserStubs,
  mount,
  must,
  q,
  text,
  typeInto,
  unmount,
  waitFor,
} from "../settings/endpoint-sharing/testing";
import type { MissingRow } from "./logic";

// The Missing Punch decision (owner brief 2026-11-21): Approve is sent at once with no remark; Reject needs the reason.
// The card's Reject asks for it in a dialog; the detail view's Reject needs its note. Nothing is sent without one of at
// least 3 characters, and it goes to the employee as the decision comment.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: null }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/components/HrLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/components/ApprovalTrail", async (original) => ({
  ...(await original<typeof import("@/components/ApprovalTrail")>()),
  PipelineNote: () => null,
}));

const row: MissingRow = {
  id: 31,
  employeeId: 4,
  employeeCode: "E4",
  employeeName: "Asha Kumar",
  department: "Cutting",
  designation: "Tailor",
  date: "2026-10-06",
  punchTime: "09:05",
  punchType: "IN",
  punchSlot: "morning_in",
  reason: "Forgot to punch at the gate",
  status: "pending_hr",
  hodReviewedBy: null,
  hodReviewComment: null,
  hodReviewedAt: null,
  hrReviewedBy: null,
  hrReviewComment: null,
  hrReviewedAt: null,
  createdAt: "2026-10-06T18:20:00",
};

let sent: { url: string; body: Record<string, unknown> }[];
let refuse: unknown;

beforeAll(installBrowserStubs);

beforeEach(() => {
  sent = [];
  refuse = null;
  h.toast.mockReset();
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return url.startsWith("/api/missing-punch-requests") ? [row] : [];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, body });
    if (refuse) throw refuse;
    return { ...row, status: body.status };
  });
});

afterEach(unmount);

const open = async () => {
  mount("/hr/missing-punch", MissingPunch);
  await waitFor(() => !!q("missing-punch-31"), "the request card");
};
const cardButton = (name: string) =>
  [...must("missing-punch-31").querySelectorAll("button")].find((b) => text(b).trim() === name) as HTMLButtonElement;

describe("deciding a Missing Punch from its card", () => {
  it("approves at once, with no remark", async () => {
    await open();
    click(cardButton("Approve"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({ url: "/api/missing-punch-requests/31/status", body: { status: "approved" } });
  });

  it("asks for the reason before rejecting and sends nothing without one", async () => {
    await open();
    click(cardButton("Reject"));
    await waitFor(() => !!q("mp-reject-dialog"), "the reason dialog");
    expect(text(q("mp-reject-dialog"))).toContain("Asha Kumar's Morning Check-In at 9:05 am on 6 Oct 2026");
    click(must("mp-reject-confirm"));
    expect(text(q("mp-reject-dialog"))).toContain("Write the reason for rejecting (at least 3 characters).");
    expect(sent).toEqual([]);
  });

  it("sends the reason as the decision comment, then closes", async () => {
    await open();
    click(cardButton("Reject"));
    await waitFor(() => !!q("mp-reject-dialog"), "the reason dialog");
    typeInto(must("mp-reject-text") as HTMLTextAreaElement, "Not on the gate log");
    click(must("mp-reject-confirm"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({
      url: "/api/missing-punch-requests/31/status",
      body: { status: "rejected", comment: "Not on the gate log" },
    });
    await waitFor(() => !q("mp-reject-dialog"), "the dialog to close");
  });

  it("keeps the dialog open with the server's words when it refuses", async () => {
    refuse = apiError(400, {
      error: "Write the reason for rejecting (at least 3 characters).",
      code: "remark_required",
    });
    await open();
    click(cardButton("Reject"));
    await waitFor(() => !!q("mp-reject-dialog"), "the reason dialog");
    typeInto(must("mp-reject-text") as HTMLTextAreaElement, "Gate log");
    click(must("mp-reject-confirm"));
    await waitFor(() => !!q("mp-reject-error"), "the refusal");
    expect(text(q("mp-reject-error"))).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(q("mp-reject-dialog")).not.toBeNull();
  });
});

describe("the detail view of a Missing Punch", () => {
  const openDetail = async () => {
    await open();
    click(must("mp-open-31"));
    await waitFor(() => !!q("mp-detail"), "the detail view");
  };

  it("says when it was sent (date and time), the day and punch it is for, and the reason", async () => {
    await openDetail();
    const detail = text(q("mp-detail"));
    expect(detail).toContain("Submitted on6 Oct 2026, 6:20");
    expect(detail).toContain("Missed date6 Oct 2026");
    expect(detail).toContain("Morning Check-In");
    expect(detail).toContain("Forgot to punch at the gate");
  });

  it("rejects only with a note of at least 3 characters, and sends it", async () => {
    await openDetail();
    click(must("mp-detail-reject"));
    expect(text(q("mp-comment-problem"))).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(sent).toEqual([]);
    expect(q("mp-detail")).not.toBeNull();
    typeInto(must("mp-comment") as HTMLTextAreaElement, "  Not on   the gate log ");
    expect(q("mp-comment-problem")).toBeNull();
    click(must("mp-detail-reject"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0].body).toEqual({ status: "rejected", comment: "Not on the gate log" });
  });

  it("approves with no note at all", async () => {
    await openDetail();
    click(must("mp-detail-approve"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0].body).toEqual({ status: "approved" });
  });
});
