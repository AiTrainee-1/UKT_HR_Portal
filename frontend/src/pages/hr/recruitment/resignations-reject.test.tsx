import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Resignations from "./Resignations";
import {
  apiError,
  buttonNamed,
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

// HR's decision on a resignation (owner brief 2026-11-21): Approve keeps its confirmation (the final approval makes the
// employee Inactive) and its comment stays optional; Reject asks for the reason, sends nothing until one of at least 3
// characters is written, and sends it as HR's comment. The details say when it was sent, the last working day asked for
// and the reason.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: null, token: "tok" }),
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

const resignation = {
  id: 21,
  employeeId: 7,
  employeeName: "Meena Iyer",
  employeeCode: "E7",
  departmentName: "Sales",
  reason: "Moving to another city",
  lastWorkingDate: "2026-11-30",
  status: "dept_approved",
  createdAt: "2026-11-02T10:15:00",
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
    if (method === "GET") return url.startsWith("/api/recruitment/resignations") ? [resignation] : [];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, body });
    if (refuse) throw refuse;
    return { ...resignation, status: body.action === "approve" ? "approved" : "rejected" };
  });
});

afterEach(unmount);

const open = async () => {
  mount("/hr/recruitment/resignations", Resignations);
  await waitFor(() => !!q("resignation-21"), "the resignation row");
};
const rowButton = (name: string) =>
  [...must("resignation-21").querySelectorAll("button")].find((b) => text(b) === name) as HTMLButtonElement;

describe("rejecting a resignation", () => {
  it("asks for the reason first and sends nothing without one", async () => {
    await open();
    click(rowButton("Reject"));
    await waitFor(() => !!q("resignation-reject-dialog"), "the reason dialog");
    expect(text(q("resignation-reject-dialog"))).toContain(
      "Meena Iyer's resignation (overriding an approval already given).",
    );
    click(must("resignation-reject-confirm"));
    expect(text(q("resignation-reject-dialog"))).toContain("Write the reason for rejecting (at least 3 characters).");
    expect(sent).toEqual([]);
  });

  it("sends the reason as HR's comment, then closes", async () => {
    await open();
    click(rowButton("Reject"));
    await waitFor(() => !!q("resignation-reject-dialog"), "the reason dialog");
    typeInto(must("resignation-reject-text") as HTMLTextAreaElement, " Asked to stay   until March ");
    click(must("resignation-reject-confirm"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({
      url: "/api/recruitment/resignations/21/action",
      body: { action: "reject", hrComment: "Asked to stay until March" },
    });
    await waitFor(() => !q("resignation-reject-dialog"), "the dialog to close");
    expect(q("resignation-submitted-on")).toBeNull(); // the details do not pop up behind it
  });

  it("keeps the dialog open with the server's words when it refuses", async () => {
    refuse = apiError(400, { error: "Write the reason for rejecting (at least 3 characters).", code: "remark_required" });
    await open();
    click(rowButton("Reject"));
    await waitFor(() => !!q("resignation-reject-dialog"), "the reason dialog");
    typeInto(must("resignation-reject-text") as HTMLTextAreaElement, "Stay");
    click(must("resignation-reject-confirm"));
    await waitFor(() => !!q("resignation-reject-error"), "the refusal");
    expect(text(q("resignation-reject-error"))).toBe("Write the reason for rejecting (at least 3 characters).");
  });
});

describe("approving a resignation", () => {
  it("keeps its confirmation and sends no comment when none is written", async () => {
    await open();
    click(rowButton("Approve"));
    await waitFor(() => !!buttonNamed("Yes, Approve"), "the confirmation");
    expect(text(document.body)).toContain("Inactive");
    click(buttonNamed("Yes, Approve"));
    await waitFor(() => sent.length === 1, "the decision");
    expect(sent[0]).toEqual({ url: "/api/recruitment/resignations/21/action", body: { action: "approve" } });
  });
});

describe("the details of a resignation", () => {
  it("say when it was sent (date and time), the last working day and the reason; Reject there asks for the reason", async () => {
    await open();
    click(rowButton("View"));
    await waitFor(() => !!q("resignation-submitted-on"), "the details");
    expect(text(q("resignation-submitted-on"))).toMatch(/^2 Nov 2026, 10:15/);
    const dialog = text(document.body.querySelector('[role="dialog"]'));
    expect(dialog).toContain("Last Working Day2026-11-30");
    expect(dialog).toContain("ReasonMoving to another city");
    click(buttonNamed("Reject"));
    await waitFor(() => !!q("resignation-reject-dialog"), "the reason dialog");
    expect(sent).toEqual([]);
  });
});
