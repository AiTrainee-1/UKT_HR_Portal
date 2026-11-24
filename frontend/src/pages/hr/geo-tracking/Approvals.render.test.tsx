import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { istDayOf } from "@/lib/date-range";
import GeoAttendance from "../GeoAttendance";
import { resetMap } from "./leafletMock";
import {
  all,
  apiError,
  buttonNamed,
  click,
  clickId,
  css,
  installBrowserStubs,
  installWorld,
  mount,
  newWorld,
  q,
  settle,
  text,
  typeInto,
  unmount,
  waitFor,
  type Raw,
  type World,
  inDays,
  pinClock,
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
  pinClock();
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
      // the status and the date filter's days (a request is for the day it was made), as the server does
      const params = new URLSearchParams(query);
      const rows = (sessions[params.get("status") ?? "pending"] ?? []).filter((s) =>
        inDays(istDayOf(String(s.createdAt)), params),
      );
      return JSON.parse(JSON.stringify(rows));
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
  vi.useRealTimers();
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
    expect(first).toContain("Submitted 28 Oct, 09:00");
    expect(cards()[0].dataset.status).toBe("pending_hr");
    expect(text(q("approvals-count"))).toBe("2 pending requests · October 2026");
  });

  it("asks first, then sends the decision the button says (with the note), and says what happened", async () => {
    sessions.pending = [session(1, { approval: approval(), isProvisional: true, pendingPunchCount: 2 })];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    click(buttonNamed("Approve"));
    await waitFor(() => q("approval-confirm") !== null, "the confirmation");
    expect(text(q("approval-confirm"))).toContain("Approve this On-Duty request?");
    expect(text(q("approval-confirm"))).toContain("Employee 1 (E1) may work at");
    expect(patches).toHaveLength(0); // nothing is sent before the confirmation
    clickId("approval-confirm-confirm");
    await waitFor(() => patches.length === 1, "the decision");
    expect(patches[0]).toEqual({ url: "/api/on-duty-sessions/1/status", body: { status: "approved" } });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Session approved" }));
    // a rejection says what it voids, and carries the note typed in the dialog
    click(buttonNamed("Reject"));
    await waitFor(() => q("approval-confirm") !== null, "the second confirmation");
    expect(text(q("approval-confirm"))).toContain("2 punches recorded under it are voided");
    typeInto(q("approval-confirm-comment") as HTMLTextAreaElement, "  Not a   client visit ");
    clickId("approval-confirm-confirm");
    await waitFor(() => patches.length === 2, "the second decision");
    expect(patches[1].body).toEqual({ status: "rejected", comment: "Not a client visit" });
  });

  it("approves with no note at all: the note is optional on an approval", async () => {
    sessions.pending = [session(1, { approval: approval() })];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    click(buttonNamed("Approve"));
    await waitFor(() => q("approval-confirm") !== null, "the confirmation");
    expect(text(q("approval-confirm"))).toContain("Note for the employee (optional)");
    expect(q("approval-confirm-problem")).toBeNull();
    clickId("approval-confirm-confirm");
    await waitFor(() => patches.length === 1, "the decision");
    expect(patches[0].body).toEqual({ status: "approved" });
  });

  it("a rejection needs the reason: without one (or a too short one) nothing is sent and the dialog says why", async () => {
    sessions.pending = [session(1, { approval: approval() })];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    click(buttonNamed("Reject"));
    await waitFor(() => q("approval-confirm") !== null, "the confirmation");
    expect(text(q("approval-confirm"))).toContain("Reason for rejecting (required)");
    clickId("approval-confirm-confirm");
    await settle(10);
    expect(patches).toHaveLength(0);
    expect(q("approval-confirm")).not.toBeNull(); // still open
    expect(text(q("approval-confirm-problem"))).toBe("Write the reason for rejecting (at least 3 characters).");
    typeInto(q("approval-confirm-comment") as HTMLTextAreaElement, " no ");
    clickId("approval-confirm-confirm");
    await settle(10);
    expect(patches).toHaveLength(0);
    typeInto(q("approval-confirm-comment") as HTMLTextAreaElement, "Duplicate request");
    clickId("approval-confirm-confirm");
    await waitFor(() => patches.length === 1, "the rejection");
    expect(patches[0]).toEqual({
      url: "/api/on-duty-sessions/1/status",
      body: { status: "rejected", comment: "Duplicate request" },
    });
  });

  it("shows the server's words when it refuses a rejection", async () => {
    sessions.pending = [session(1, { approval: approval() })];
    const base = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if ((options?.method ?? "GET").toUpperCase() === "PATCH") {
        throw apiError(400, {
          error: "Write the reason for rejecting (at least 3 characters).",
          code: "remark_required",
        });
      }
      return base(url, options);
    });
    await open();
    await waitFor(() => cards().length === 1, "the request");
    click(buttonNamed("Reject"));
    await waitFor(() => q("approval-confirm") !== null, "the confirmation");
    typeInto(q("approval-confirm-comment") as HTMLTextAreaElement, "Not needed");
    clickId("approval-confirm-confirm");
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to update session",
        description: "Write the reason for rejecting (at least 3 characters).",
        variant: "destructive",
      }),
    );
  });

  it("sends nothing when the confirmation is cancelled", async () => {
    sessions.pending = [session(1, { approval: approval() })];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    click(buttonNamed("Reject"));
    await waitFor(() => q("approval-confirm") !== null, "the confirmation");
    clickId("approval-confirm-cancel");
    await settle(10);
    expect(q("approval-confirm")).toBeNull();
    expect(patches).toHaveLength(0);
  });

  it("says so, with a way to try again, when the requests cannot be loaded", async () => {
    let failing = true;
    const base = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (failing && url.startsWith("/api/on-duty-sessions?status=")) {
        throw apiError(500, { error: "The server is busy." });
      }
      return base(url, options);
    });
    await open();
    await waitFor(() => q("approvals-error") !== null, "the error");
    expect(text(q("approvals-error"))).toContain("The On-Duty requests could not be loaded.");
    expect(text(q("approvals-error"))).toContain("The server is busy.");
    failing = false;
    click(buttonNamed("Try again"));
    await waitFor(() => q("approvals-error") === null, "the retry");
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
    await waitFor(
      () => text(document.body).includes("No pending On-Duty sessions for October 2026."),
      "the empty note",
    );
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
    expect(text(q("verifications-count"))).toBe("3 pending punches · 2 requests · October 2026");
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
    await waitFor(() => q("punch-confirm") !== null, "the confirmation");
    expect(text(q("punch-confirm"))).toContain("Approve all 2 punches into attendance?");
    clickId("punch-confirm-confirm");
    await waitFor(() => patches.length === 1, "the decision");
    expect(patches[0]).toEqual({ url: "/api/on-duty-sessions/50/punches", body: { status: "approved" } });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 punches approved" }));
    click(buttonNamed("Reject all"));
    await waitFor(() => q("punch-confirm") !== null, "the second confirmation");
    // one reason for the whole batch: without it nothing is sent
    clickId("punch-confirm-confirm");
    await settle(10);
    expect(patches).toHaveLength(1);
    expect(text(q("punch-confirm-problem"))).toBe("Write the reason for rejecting (at least 3 characters).");
    typeInto(q("punch-confirm-comment") as HTMLTextAreaElement, "Photos are of the office");
    clickId("punch-confirm-confirm");
    await waitFor(() => patches.length === 2, "the rejection");
    expect(patches[1]).toEqual({
      url: "/api/on-duty-sessions/50/punches",
      body: { status: "rejected", comment: "Photos are of the office" },
    });
  });

  it("decides one punch when only that one is wrong", async () => {
    world.verifications = [punch(1), punch(2)];
    await open("?tab=verifications");
    await waitFor(() => all("punch-row").length === 2, "the punches");
    const row = all("punch-row")[1];
    click([...row.querySelectorAll("button")].find((b) => text(b) === "Reject"));
    await waitFor(() => q("punch-confirm") !== null, "the confirmation");
    expect(text(q("punch-confirm"))).toContain("Reject this punch?");
    clickId("punch-confirm-confirm");
    await settle(10);
    expect(patches).toHaveLength(0); // the reason is required
    typeInto(q("punch-confirm-comment") as HTMLTextAreaElement, "Far from the site");
    clickId("punch-confirm-confirm");
    await waitFor(() => patches.length === 1, "the decision");
    expect(patches[0]).toEqual({
      url: "/api/on-duty-punch-verifications/2/status",
      body: { status: "rejected", comment: "Far from the site" },
    });
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
    await waitFor(
      () => text(document.body).includes("No pending punch verifications for October 2026."),
      "the empty note",
    );
    expect(text(document.body)).toContain("wait here until HR approves them into attendance");
  });
});

describe("the date filter (This Month by default: the pinned clock is 28 Oct 2026)", () => {
  const sessionCalls = () =>
    h.fetch.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/on-duty-sessions?"));

  it("asks for the requests made on This Month's days, and names the pending ones of other days", async () => {
    sessions.pending = [
      session(1, { approval: approval() }),
      session(2, { createdAt: "2026-09-30T18:00:00+05:30", approval: approval() }),
    ];
    await open();
    await waitFor(() => cards().length === 1, "October's request");
    expect(sessionCalls()).toContain("/api/on-duty-sessions?status=pending&from=2026-10-01&to=2026-10-31");
    expect(text(q("approvals-count"))).toBe("1 pending request · October 2026");
    expect(text(q("approvals-outside"))).toContain("1 more pending request outside October 2026");
    expect(text(q("approvals-outside"))).toContain("the earliest is for 30 Sep 2026");
    // Show them: Custom days from the earliest to today, in the address
    clickId("approvals-outside-show");
    await waitFor(() => cards().length === 2, "both requests");
    expect(window.location.search).toBe("?range=custom&from=2026-09-30&to=2026-10-28");
    expect(q("approvals-outside")).toBeNull();
  });

  it("Today and an earlier month ask for their own days", async () => {
    sessions.pending = [session(1, { approval: approval() })];
    await open();
    await waitFor(() => cards().length === 1, "the request");
    clickId("approvals-dates-yesterday");
    await waitFor(() => cards().length === 0, "nothing yesterday");
    expect(sessionCalls().at(-1)).toBe("/api/on-duty-sessions?status=pending&from=2026-10-27&to=2026-10-27");
    expect(text(document.body)).toContain("No pending On-Duty sessions for Yesterday, 27 Oct.");
    clickId("approvals-dates-prev");
    await waitFor(
      () => sessionCalls().at(-1) === "/api/on-duty-sessions?status=pending&from=2026-09-01&to=2026-09-30",
      "September",
    );
    expect(window.location.search).toBe("?month=2026-09");
  });

  it("punches by their punch date: This Month's, and the pending ones of other days named apart", async () => {
    world.verifications = [
      punch(1),
      punch(2, {
        sessionId: 52,
        employeeName: "Old Punch",
        punchDate: "2026-09-29",
        createdAt: "2026-09-29T10:00:00+05:30",
      }),
    ];
    await open("?tab=verifications");
    await waitFor(() => verificationCards().length === 1, "October's punch");
    expect(world.requests).toContain(
      "GET /api/on-duty-punch-verifications?status=pending&from=2026-10-01&to=2026-10-31",
    );
    expect(text(q("verifications-count"))).toBe("1 pending punch · 1 request · October 2026");
    expect(text(q("verifications-outside"))).toContain("1 more pending punch outside October 2026");
    clickId("verifications-dates-today");
    await waitFor(
      () =>
        world.requests.includes("GET /api/on-duty-punch-verifications?status=pending&from=2026-10-28&to=2026-10-28"),
      "today's punches",
    );
    expect(window.location.search).toBe("?range=today");
  });
});
