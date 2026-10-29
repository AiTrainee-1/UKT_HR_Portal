import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GeoAttendance from "../GeoAttendance";
import { resetMap } from "./leafletMock";
import {
  all,
  buttonNamed,
  click,
  css,
  installBrowserStubs,
  installWorld,
  mount,
  newWorld,
  q,
  settle,
  text,
  unmount,
  waitFor,
  type Raw,
  type World,
} from "./testing";

// On-Duty Approvals and Punch Verifications in jsdom: what each card says, the decision it sends, who may decide (the approval
// pipeline, not the status label), the one decision covering every punch of a request, and "View on map".

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "tok123", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("react-leaflet", async () => (await import("./leafletMock")).leafletMock);
vi.mock("@/components/HrLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };

let world: World;
let sessions: Record<string, Raw[]>;
let patches: { url: string; body: Record<string, unknown> }[];

const session = (id: number, over: Raw = {}): Raw => ({
  id,
  employeeId: 10 + id,
  employeeCode: `E${id}`,
  employeeName: `Employee ${id}`,
  department: "Stitching",
  destination: `Buyer ${id}`,
  branchId: 1,
  branchName: "Head Office",
  status: "pending_hr",
  approvalStatus: "pending_hr",
  isProvisional: false,
  pendingPunchCount: 0,
  employeeEndedAt: null,
  hodReviewedBy: null,
  hodReviewComment: null,
  hodReviewedAt: null,
  hrReviewedBy: null,
  hrReviewComment: null,
  hrReviewedAt: null,
  startedAt: null,
  completedAt: null,
  completedBy: null,
  completionReason: null,
  createdAt: "2026-10-28T09:00:00+05:30",
  ...over,
});

const approval = (over: Raw = {}): Raw => ({
  workflow: "on_duty",
  label: "On-Duty",
  enabled: true,
  steps: [{ roles: ["hr"], mandatory: true, index: 0, state: "pending" }],
  currentStep: 0,
  waitingFor: ["hr"],
  canAct: { hod: false, hr: true },
  ...over,
});

const punch = (id: number, over: Raw = {}): Raw => ({
  id,
  sessionId: 50,
  sessionStatus: "active",
  sessionApproved: true,
  sessionDestination: "Tirupur buyer visit",
  employeeId: 11,
  employeeCode: "E2E001",
  employeeName: "Asha Kumar",
  department: "Stitching",
  punchDate: "2026-10-28",
  punchTime: "10:15:00",
  punchType: "IN",
  punchNumber: id,
  latitude: 11.02,
  longitude: 77.02,
  accuracyM: 12,
  isMocked: false,
  hasPhoto: true,
  hasPhoto2: false,
  status: "pending",
  hrReviewedBy: null,
  hrReviewComment: null,
  hrReviewedAt: null,
  createdAt: `2026-10-28T10:15:0${id}+05:30`,
  ...over,
});

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  resetMap();
  h.user.current = SUPER;
  sessions = { pending: [], active: [], completed: [], rejected: [] };
  patches = [];
  world = installWorld(h.fetch, newWorld());
  const base = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    const [path, query = ""] = url.split("?");
    const method = (options?.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/api/on-duty-sessions") {
      return JSON.parse(JSON.stringify(sessions[new URLSearchParams(query).get("status") ?? "pending"] ?? []));
    }
    if (method === "GET" && /^\/api\/live-location\/team\/\d+\/route$/.test(path)) {
      return { employeeId: 11, employeeCode: "E2E001", employeeName: "Asha Kumar", date: "2026-10-28", points: [] };
    }
    if (method === "PATCH" && /^\/api\/on-duty-(sessions|punch-verifications)\//.test(path)) {
      patches.push({ url: path, body: JSON.parse(String(options?.body ?? "{}")) });
      if (path.endsWith("/punches")) return { updated: 2, session: {} };
      return session(1, { status: "active" });
    }
    return base(url, options);
  });
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
  vi.restoreAllMocks();
});

const open = async (search = "") => {
  mount(`/hr/geo-attendance${search}`, GeoAttendance);
  await settle(30);
};
const cards = () => all("approval-card");
const verificationCards = () => all("verification-card");

describe("On-Duty Approvals", () => {
  it("shows one card per request: who, where to, the stage it is at, and the decision", async () => {
    sessions.pending = [
      session(1, { status: "pending_hr", approval: approval() }),
      session(2, {
        status: "pending_hod",
        approval: approval({ canAct: { hod: true, hr: false }, waitingFor: ["hod"] }),
      }),
    ];
    await open();
    await waitFor(() => cards().length === 2, "the requests");
    const first = text(cards()[0]);
    expect(first).toContain("Employee 1");
    expect(first).toContain("E1");
    expect(first).toContain("Stitching · Head Office");
    expect(first).toContain("Buyer 1");
    expect(first).toContain("Requested 28 Oct, 09:00");
    expect(cards()[0].dataset.status).toBe("pending_hr");
    expect(text(q("approvals-count"))).toBe("2 pending requests");
  });

  it("sends the decision the button says, and says what happened", async () => {
    sessions.pending = [session(1, { approval: approval() })];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    click(buttonNamed("Approve"));
    await waitFor(() => patches.length === 1, "the decision");
    expect(patches[0]).toEqual({ url: "/api/on-duty-sessions/1/status", body: { status: "approved" } });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Session approved" }));
    click(buttonNamed("Reject"));
    await waitFor(() => patches.length === 2, "the second decision");
    expect(patches[1].body).toEqual({ status: "rejected" });
  });

  it("offers no decision when the approval pipeline says it is not HR's turn, and says whose turn it is", async () => {
    sessions.pending = [
      session(3, {
        status: "pending_hod",
        approval: approval({ canAct: { hod: true, hr: false }, waitingFor: ["hod"] }),
      }),
    ];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    expect(q("approval-actions")).toBeNull();
    expect(text(cards()[0])).toContain("Waiting for HOD");
    expect(text(cards()[0])).toContain("HR cannot decide this session until that step is done.");
  });

  it("warns that the employee is already working under a request that was not approved yet, and what a decision means", async () => {
    sessions.pending = [session(4, { approval: approval(), isProvisional: true, pendingPunchCount: 2 })];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    const card = text(cards()[0]);
    expect(card).toContain("already working under this request");
    expect(card).toContain("2 punches");
    expect(card).toContain("rejecting voids them all permanently");
  });

  it("shows who reviewed a request and how it ended, on the other lists", async () => {
    sessions.completed = [
      session(5, {
        status: "completed",
        approvalStatus: "completed",
        hodReviewedBy: "Suresh",
        hodReviewComment: "fine",
        hrReviewedBy: "Admin",
        completionReason: "auto_4th_punch",
        completedAt: "2026-10-28T18:00:00+05:30",
      }),
    ];
    await open();
    const subTab = (name: RegExp) =>
      [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
        name.test(text(t.querySelector(".ptab-label"))),
      );
    await waitFor(() => subTab(/^Completed/) !== undefined, "the sub-tabs");
    click(subTab(/^Completed/));
    await waitFor(() => cards().length === 1, "the completed request");
    const card = text(cards()[0]);
    expect(card).toContain('HOD: approved by Suresh - "fine"');
    expect(card).toContain("HR: approved by Admin");
    expect(card).toContain("Ended automatically (4th punch approved)");
    expect(q("approval-actions")).toBeNull();
  });

  it("says when there is nothing, in a few words and with what would appear here", async () => {
    await open();
    await waitFor(() => text(document.body).includes("No pending On-Duty sessions."), "the empty note");
    expect(text(document.body)).toContain("New On-Duty requests from employees appear here for a decision.");
  });
});

describe("Punch Verifications", () => {
  it("groups the punches by On-Duty request: one card with the decision for all of them, and a row per punch", async () => {
    world.verifications = [
      punch(1),
      punch(2, { punchType: "OUT" }),
      punch(3, {
        sessionId: 51,
        employeeName: "Ravi Nair",
        sessionDestination: "Erode mill",
        sessionApproved: false,
        sessionStatus: "pending_hr",
      }),
    ];
    await open("?tab=verifications");
    await waitFor(() => verificationCards().length === 2, "the requests");
    expect(text(q("verifications-count"))).toBe("3 pending punches · 2 requests");
    const asha = verificationCards().find((c) => text(c).includes("Asha Kumar"))!;
    expect(asha.querySelectorAll('[data-testid="punch-row"]')).toHaveLength(2);
    expect(text(asha)).toContain("2 punches");
    expect(text(asha)).toContain("Request approved");
    expect(text(asha)).toContain("#1 CHECK-IN");
    expect(text(asha)).toContain("#2 CHECK-OUT");
    expect(text(asha)).toContain("Approve all 2");
    expect(text(asha)).toContain("11.02000, 77.02000");
  });

  it("approves or rejects every punch of a request with one decision", async () => {
    world.verifications = [punch(1), punch(2)];
    await open("?tab=verifications");
    await waitFor(() => verificationCards().length === 1, "the request");
    click(buttonNamed(/^Approve all 2/));
    await waitFor(() => patches.length === 1, "the decision");
    expect(patches[0]).toEqual({ url: "/api/on-duty-sessions/50/punches", body: { status: "approved" } });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 punches approved" }));
    click(buttonNamed("Reject all"));
    await waitFor(() => patches.length === 2, "the rejection");
    expect(patches[1].body).toEqual({ status: "rejected" });
  });

  it("decides one punch when only that one is wrong", async () => {
    world.verifications = [punch(1), punch(2)];
    await open("?tab=verifications");
    await waitFor(() => all("punch-row").length === 2, "the punches");
    const row = all("punch-row")[1];
    click([...row.querySelectorAll("button")].find((b) => text(b) === "Reject"));
    await waitFor(() => patches.length === 1, "the decision");
    expect(patches[0]).toEqual({ url: "/api/on-duty-punch-verifications/2/status", body: { status: "rejected" } });
  });

  it("cannot approve a punch whose request is still waiting, and says why; rejecting stays possible", async () => {
    world.verifications = [punch(1, { sessionApproved: false, sessionStatus: "pending_hr" })];
    await open("?tab=verifications");
    await waitFor(() => all("punch-row").length === 1, "the punch");
    const card = text(verificationCards()[0]);
    expect(card).toContain("Awaiting HR");
    expect(card).toContain("Approve the On-Duty request on the Approvals tab - that accepts all 1 punch with it.");
    const approve = [...all("punch-row")[0].querySelectorAll("button")].find(
      (b) => text(b) === "Approve",
    ) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe("The On-Duty request this punch belongs to is still awaiting approval.");
    expect((buttonNamed(/^Approve all/) as HTMLButtonElement).disabled).toBe(true);
    expect((buttonNamed("Reject all") as HTMLButtonElement).disabled).toBe(false);
  });

  it("flags a simulated location, and a reviewed punch says who decided", async () => {
    world.verifications = [
      punch(1, { isMocked: true }),
      punch(2, { status: "approved", hrReviewedBy: "Admin", hrReviewComment: "ok" }),
    ];
    await open("?tab=verifications");
    await waitFor(() => all("punch-row").length === 2, "the punches");
    expect(text(all("punch-row")[0])).toContain("Simulated location");
    expect(text(all("punch-row")[1])).toContain('Approved by Admin - "ok"');
    // an approved punch has no per-punch decision left
    expect([...all("punch-row")[1].querySelectorAll("button")].map(text)).not.toContain("Approve");
  });

  it("opens 'View on map': where the punch was taken, its accuracy and the links out", async () => {
    world.verifications = [punch(1, { accuracyM: 14.4 })];
    await open("?tab=verifications");
    await waitFor(() => all("punch-row").length === 1, "the punch");
    click([...document.body.querySelectorAll("button")].find((b) => text(b) === "View on map"));
    await waitFor(() => css('[role="dialog"]') !== null, "the dialog");
    const dialog = text(css('[role="dialog"]'));
    expect(dialog).toContain("Punch #1 · Check-In location");
    expect(dialog).toContain("±14 m accuracy");
    expect(dialog).toContain("11.02,77.02");
    await waitFor(
      () => text(css('[role="dialog"]')).includes("No route recorded for this day - showing the punch location only."),
      "the route note",
    );
    expect(css('[role="dialog"] a[href*="google.com/maps/dir"]')).not.toBeNull();
  });

  it("says there is nothing, and what would appear here", async () => {
    await open("?tab=verifications");
    await waitFor(() => text(document.body).includes("No pending punch verifications."), "the empty note");
    expect(text(document.body)).toContain("wait here until HR approves them into attendance");
  });
});
