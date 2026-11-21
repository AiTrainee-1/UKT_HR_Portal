import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LeaveHoliday from "../LeaveHoliday";
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
import type { LeaveRow } from "./logic";

// Leave & Holiday in jsdom, the decision HR takes on a request (owner brief 2026-11-21): Approve is sent at once with no
// remark; Reject asks for the reason, sends nothing until one of at least 3 characters is written, and sends it as HR's
// comment. The details say when the request was sent (date and time), the dates it is for and the employee's reason.

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

const leave = (id: number, over: Partial<LeaveRow> = {}): LeaveRow => ({
  id,
  employeeId: id * 10,
  employeeName: `Employee ${id}`,
  employeeCode: `E${id}`,
  department: "Cutting",
  type: "sick",
  startDate: "2026-10-12",
  endDate: "2026-10-13",
  status: "pending",
  reason: "Fever",
  createdAt: "2026-10-04T09:05:00",
  ...over,
});

let rows: LeaveRow[];
let permissions: Record<string, unknown>[];
let sent: { url: string; body: Record<string, unknown> }[];
let refuse: unknown;

beforeAll(installBrowserStubs);

beforeEach(() => {
  rows = [leave(7)];
  permissions = [
    {
      id: 5,
      employeeId: 50,
      employeeName: "Ravi Shankar",
      employeeCode: "E50",
      department: "Cutting",
      date: "2026-10-14",
      permissionTime: "09:30",
      reason: "Bank visit",
      typeKey: "late_in",
      status: "pending",
      monthlyLimit: 3,
      createdAt: "2026-10-13T18:40:00",
    },
  ];
  sent = [];
  refuse = null;
  h.toast.mockReset();
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      if (url.startsWith("/api/leave-requests")) return rows;
      if (url.startsWith("/api/permissions")) return permissions;
      return [];
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, body });
    if (refuse) throw refuse;
    return { ...rows[0], status: body.status };
  });
});

afterEach(unmount);

const open = async () => {
  mount("/hr/leave", LeaveHoliday);
  await waitFor(() => !!q("leave-7"), "the leave card");
};
const cardButton = (name: string) =>
  [...must("leave-7").querySelectorAll("button")].find((b) => text(b) === name) as HTMLButtonElement;
const reason = () => must("leave-reject-text") as HTMLTextAreaElement;

describe("deciding a leave request", () => {
  it("approves at once, with no remark asked for or sent", async () => {
    await open();
    click(cardButton("Approve"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({ url: "/api/leave-requests/7/status", body: { status: "approved" } });
    expect(q("leave-reject-dialog")).toBeNull();
  });

  it("asks for the reason before rejecting, and sends nothing without one", async () => {
    await open();
    click(cardButton("Reject"));
    await waitFor(() => !!q("leave-reject-dialog"), "the reason dialog");
    expect(text(q("leave-reject-dialog"))).toContain("Employee 7's leave from 12 Oct 2026 to 13 Oct 2026");
    click(must("leave-reject-confirm"));
    expect(text(q("leave-reject-dialog"))).toContain("Write the reason for rejecting (at least 3 characters).");
    typeInto(reason(), "  ok ");
    click(must("leave-reject-confirm"));
    expect(sent).toEqual([]);
    expect(q("leave-reject-dialog")).not.toBeNull();
  });

  it("sends the reason (spaces tidied) as HR's comment, then closes", async () => {
    await open();
    click(cardButton("Reject"));
    await waitFor(() => !!q("leave-reject-dialog"), "the reason dialog");
    typeInto(reason(), "  Clash with   the audit ");
    click(must("leave-reject-confirm"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({
      url: "/api/leave-requests/7/status",
      body: { status: "rejected", hrComment: "Clash with the audit" },
    });
    await waitFor(() => !q("leave-reject-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith({ title: "Leave request rejected" });
  });

  it("keeps the dialog open with the server's words when the server refuses", async () => {
    refuse = apiError(400, {
      error: "Write the reason for rejecting (at least 3 characters).",
      code: "remark_required",
    });
    await open();
    click(cardButton("Reject"));
    await waitFor(() => !!q("leave-reject-dialog"), "the reason dialog");
    typeInto(reason(), "Clash");
    click(must("leave-reject-confirm"));
    await waitFor(() => !!q("leave-reject-error"), "the refusal");
    expect(text(q("leave-reject-error"))).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(q("leave-reject-dialog")).not.toBeNull();
  });

  it("a half-day request is rejected the same way", async () => {
    rows = [leave(7, { isHalfDay: true, startDate: "2026-10-12", endDate: "2026-10-12", halfDaySlot: "morning" })];
    mount("/hr/leave?tab=halfDay", LeaveHoliday);
    await waitFor(() => !!q("leave-7"), "the half-day card");
    click(cardButton("Reject"));
    await waitFor(() => !!q("leave-reject-dialog"), "the reason dialog");
    expect(text(q("leave-reject-dialog"))).toContain("Reject this half-day leave?");
    expect(text(q("leave-reject-dialog"))).toContain("half-day leave on Mon, 12 Oct 2026");
    typeInto(reason(), "Short staffed");
    click(must("leave-reject-confirm"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0].body).toEqual({ status: "rejected", hrComment: "Short staffed" });
  });
});

describe("the details of a leave request", () => {
  it("say when it was sent (date and time), the dates it is for and the reason", async () => {
    await open();
    click(must("leave-7"));
    await waitFor(() => !!q("leave-detail"), "the details");
    const detail = must("leave-detail");
    expect(text(q("leave-submitted-on"))).toBe("Sun, 4 Oct 2026, 9:05 am");
    expect(text(detail)).toContain("FromMon, 12 Oct 2026");
    expect(text(detail)).toContain("ToTue, 13 Oct 2026");
    expect(text(detail)).toContain("ReasonFever");
  });

  it("Reject there asks for the reason too", async () => {
    await open();
    click(must("leave-7"));
    await waitFor(() => !!q("leave-detail"), "the details");
    click([...must("leave-detail").querySelectorAll("button")].find((b) => text(b) === "Reject") as HTMLButtonElement);
    await waitFor(() => !!q("leave-reject-dialog"), "the reason dialog");
    expect(sent).toEqual([]);
    typeInto(reason(), "Not enough cover");
    click(must("leave-reject-confirm"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0].body).toEqual({ status: "rejected", hrComment: "Not enough cover" });
    await waitFor(() => !q("leave-reject-dialog"), "the dialog to close");
  });
});

describe("deciding a permission", () => {
  const openPermissions = async () => {
    mount("/hr/leave?tab=permissions", LeaveHoliday);
    await waitFor(() => !!q("permission-5"), "the permission card");
  };
  const button = (scope: string, name: string) =>
    [...must(scope).querySelectorAll("button")].find((b) => text(b) === name) as HTMLButtonElement;

  it("approves at once with no remark", async () => {
    await openPermissions();
    click(button("permission-5", "Approve"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({ url: "/api/permissions/5", body: { status: "approved" } });
  });

  it("rejects only with a reason, sent as HR's comment", async () => {
    await openPermissions();
    click(button("permission-5", "Reject"));
    await waitFor(() => !!q("permission-reject-dialog"), "the reason dialog");
    expect(text(q("permission-reject-dialog"))).toContain("Ravi Shankar's permission on Wed, 14 Oct 2026");
    click(must("permission-reject-confirm"));
    expect(text(q("permission-reject-dialog"))).toContain("Write the reason for rejecting (at least 3 characters).");
    expect(sent).toEqual([]);
    typeInto(must("permission-reject-text") as HTMLTextAreaElement, "Third late this week");
    click(must("permission-reject-confirm"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({
      url: "/api/permissions/5",
      body: { status: "rejected", hrComment: "Third late this week" },
    });
    await waitFor(() => !q("permission-reject-dialog"), "the dialog to close");
  });

  it("the details say when it was sent, the day and time asked for and the reason; Reject there asks too", async () => {
    await openPermissions();
    click(must("permission-5"));
    await waitFor(() => !!q("permission-detail"), "the details");
    expect(text(q("permission-submitted-on"))).toBe("Tue, 13 Oct 2026, 6:40 pm");
    expect(text(q("permission-detail"))).toContain("DateWed, 14 Oct 2026");
    expect(text(q("permission-detail"))).toContain("Time09:30");
    expect(text(q("permission-detail"))).toContain("ReasonBank visit");
    click(button("permission-detail", "Reject"));
    await waitFor(() => !!q("permission-reject-dialog"), "the reason dialog");
    expect(sent).toEqual([]);
  });
});
