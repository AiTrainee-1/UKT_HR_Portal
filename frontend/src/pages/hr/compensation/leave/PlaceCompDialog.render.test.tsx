import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalProgress } from "@/lib/approval-workflow";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { claim, ot, placementCalendar, placementSource } from "../fixtures";
import {
  apiError,
  bodiesOf,
  click,
  freezeClock,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  q,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";
import { rowKeys } from "./leave-test-utils";

// Compensation days on a date HR chooses (owner brief 2026-11-28) in jsdom: the calendar dialog (PlaceCompDialog) and every
// way into it. Use balance (Balance), Choose date on an approved credit (Claims), on a day off worked (Raise a claim) and on
// a Type 2 OT record (OT Detection) open the same dialog with their source; HR picks a working day and how much of it, and
// Send passes it to the Department Head, then HR. A date HR chose shows its stage in Claims, where HR approves or rejects it
// after the Department Head.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { role: "hr"; employeeId: null; permissions: Record<string, string> } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const HOLIDAY = "/hr/compensation/compensation-leave/holiday-work";
const CALENDAR = "/api/compensation/placements/calendar";
const PLACE = "/api/compensation/placements";

const button = (id: string) => must(id) as HTMLButtonElement;
const calendarAsks = () =>
  world
    .requests()
    .filter((r) => r.split("?")[0] === CALENDAR)
    .map((r) => Object.fromEntries(new URLSearchParams(r.split("?")[1] ?? "")));

async function openBalanceDialog() {
  mountPage(`${HOLIDAY}/balance`);
  await waitFor(() => rowKeys("balance-table").length > 0, "the balances");
  click(must("balance-use-E21"));
  await waitFor(() => !!q("pc-calendar"), "the calendar");
}

describe("the dialog (from Use balance)", () => {
  it("asks for the employee's month from the balance and says what it is", async () => {
    await openBalanceDialog();
    expect(calendarAsks()).toEqual([{ employeeId: "21", source: "balance" }]);
    expect(text(q("pc-title"))).toBe("Compensation balance for Fara Khan");
    expect(text(q("pc-dialog"))).toContain("Choose a working day up to 45 days back");
    expect(text(q("pc-dialog"))).toContain("or 90 days ahead. It goes to the Department Head, then HR.");
    expect(text(q("pc-source-title"))).toBe("The compensation balance");
    expect(text(q("pc-source-figures"))).toBe("Total 1.00 · placed 0.00 · left 1.00");
    expect(text(q("pc-month"))).toBe("October 2026");
    expect(text(q("pc-approval-path"))).toBe("Approval: HR → Department Head → HR.");
    // nothing picked yet: Send waits for a day
    expect(button("pc-send").disabled).toBe(true);
    expect(q("pc-credit")).toBeNull();
  });

  it("greys out a day that cannot be chosen and says why when it is pressed", async () => {
    await openBalanceDialog();
    const sunday = must("pc-day-2026-10-11");
    expect(sunday.getAttribute("data-selectable")).toBe("false");
    expect(sunday.title).toBe("A Sunday is already a day off: choose a working day.");
    click(sunday);
    expect(text(q("pc-day-info"))).toContain("Sun, 11 Oct 2026 · Sunday");
    expect(text(q("pc-day-reason"))).toBe("A Sunday is already a day off: choose a working day.");
    expect(q("pc-amounts")).toBeNull();
    // a day with a compensation day on it
    expect(text(must("pc-day-2026-10-08"))).toContain("Comp");
    click(must("pc-day-2026-10-07"));
    expect(text(q("pc-day-reason"))).toBe("Casual Leave is already asked for or approved on this day.");
  });

  it("picks a day with as much as it takes, lets HR take less, and says what happens", async () => {
    await openBalanceDialog();
    click(must("pc-day-2026-10-15"));
    expect(must("pc-day-2026-10-15").getAttribute("data-picked")).toBe("true");
    expect(must("pc-amount-1.00").getAttribute("aria-checked")).toBe("true");
    expect(text(q("pc-summary"))).toBe(
      "Fara Khan takes 1.00 shift off on Thu 15 Oct. It goes to the Department Head, then HR.",
    );
    click(must("pc-amount-0.50"));
    expect(text(q("pc-summary"))).toContain("Fara Khan takes 0.50 shift off on Thu 15 Oct.");
    expect(text(q("pc-summary"))).toContain("0.50 shift of the balance stays, to place later.");
    // a half day takes at most the other half: the larger amounts are greyed out with the reason
    click(must("pc-day-2026-10-06"));
    expect(must("pc-amount-0.50").getAttribute("aria-checked")).toBe("true");
    expect(button("pc-amount-0.75").disabled).toBe(true);
    expect(button("pc-amount-0.75").title).toBe("This day can take at most 0.50 shift.");
    expect(text(q("pc-day-reason"))).toBe("This day already earns 0.50 shift: at most 0.50 can be added.");
    // pressing the picked day again lets it go
    click(must("pc-day-2026-10-06"));
    expect(q("pc-amounts")).toBeNull();
    expect(button("pc-send").disabled).toBe(true);
  });

  it("sends the employee, the source, the day, the amount and the reason, then closes", async () => {
    await openBalanceDialog();
    click(must("pc-day-2026-10-15"));
    click(must("pc-amount-0.50"));
    typeInto(must("pc-reason") as HTMLTextAreaElement, "  Family function  ");
    click(must("pc-send"));
    await waitFor(() => bodiesOf(world, "POST", PLACE).length === 1, "the request");
    expect(bodiesOf(world, "POST", PLACE)[0]).toEqual({
      employeeId: 21,
      source: { type: "balance" },
      useDate: "2026-10-15",
      shifts: 0.5,
      reason: "Family function",
    });
    await waitFor(() => !q("pc-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Sent to the Department Head",
        description: "Sent to the Department Head: 0.50 shift on 2026-10-15. HR approves it after the Department Head.",
      }),
    );
  });

  it("sends once when Send is clicked twice in a row", async () => {
    const release = world.hold(PLACE);
    await openBalanceDialog();
    click(must("pc-day-2026-10-15"));
    const send = must("pc-send");
    act(() => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(20);
    release();
    await waitFor(() => !q("pc-dialog"), "the dialog to close");
    expect(bodiesOf(world, "POST", PLACE)).toHaveLength(1);
  });

  it("shows the server's sentence when the day cannot take it, stays open and reads the month again", async () => {
    world.on.set(`POST ${PLACE}`, () =>
      apiError(400, {
        error: "Fara Khan was given Casual Leave on Thu 15 Oct 2026 meanwhile: choose another day.",
        code: "date_not_allowed",
      }),
    );
    await openBalanceDialog();
    click(must("pc-day-2026-10-15"));
    click(must("pc-send"));
    await waitFor(() => !!q("pc-error"), "the refusal");
    expect(text(q("pc-error"))).toBe(
      "Fara Khan was given Casual Leave on Thu 15 Oct 2026 meanwhile: choose another day.",
    );
    expect(q("pc-dialog")).not.toBeNull();
    await waitFor(() => calendarAsks().length === 2, "the month read again");
  });

  it("moves to the next and previous months while they are in the window", async () => {
    await openBalanceDialog();
    click(must("pc-day-2026-10-15"));
    click(must("pc-month-next"));
    await waitFor(() => text(q("pc-month")).startsWith("November 2026"), "November");
    expect(calendarAsks().at(-1)).toEqual({ employeeId: "21", source: "balance", month: "2026-11" });
    // the pick of October does not ride along
    expect(q("pc-amounts")).toBeNull();
    expect(must("pc-day-2026-11-02").getAttribute("data-selectable")).toBe("true");
    click(must("pc-month-prev"));
    await waitFor(() => text(q("pc-month")).startsWith("October 2026"), "October");
  });

  it("disables a month arrow outside the window", async () => {
    world.placement = (qs) => {
      const cal = placementCalendar(placementSource(), qs.get("month") ?? "2026-10");
      return { ...cal, month: { ...cal.month, next: null } };
    };
    await openBalanceDialog();
    expect(button("pc-month-next").disabled).toBe(true);
    expect(button("pc-month-next").title).toBe("Later days are too far ahead");
    expect(button("pc-month-prev").disabled).toBe(false);
  });

  it("explains, and keeps Send off, when the employee has no Department Head who may approve", async () => {
    world.placement = () =>
      placementCalendar(placementSource(), "2026-10", {
        hodProblem: "Fara Khan has no Department Head who may approve compensation (HOD Assignment).",
      });
    await openBalanceDialog();
    expect(text(q("pc-hod-problem"))).toBe(
      "Fara Khan has no Department Head who may approve compensation (HOD Assignment).",
    );
    click(must("pc-day-2026-10-15"));
    expect(button("pc-send").disabled).toBe(true);
    expect(button("pc-send").title).toBe(
      "Fara Khan has no Department Head who may approve compensation (HOD Assignment).",
    );
  });

  it("says so when chosen dates are switched off in Approval Workflow Control", async () => {
    world.placement = () => placementCalendar(placementSource(), "2026-10", { workflowOn: false });
    await openBalanceDialog();
    expect(text(q("pc-workflow-off"))).toContain("Compensation days on chosen dates are switched off");
    expect(q("pc-workflow-off")!.querySelector("a")!.getAttribute("href")).toBe("/hr/user-management?tab=approvals");
    click(must("pc-day-2026-10-15"));
    expect(button("pc-send").disabled).toBe(true);
  });

  it("shows the source's refusal and keeps the calendar readable with every day greyed out", async () => {
    world.placement = () =>
      placementCalendar(
        placementSource({ canPlace: false, left: 0, refusal: "All of this credit is already placed." }),
        "2026-10",
      );
    await openBalanceDialog();
    expect(text(q("pc-refusal"))).toBe("All of this credit is already placed.");
    expect(must("pc-day-2026-10-15").getAttribute("data-selectable")).toBe("false");
    expect(button("pc-send").disabled).toBe(true);
  });

  it("lists the employee's open compensation days: HR's turn opens Requests, a waiting one can be withdrawn", async () => {
    await openBalanceDialog();
    expect(text(q("pc-placements"))).toContain("Open compensation days of Fara Khan");
    expect(text(q("pc-placement-77"))).toContain("Thu, 8 Oct 2026 · 0.50 shift");
    expect(text(q("pc-placement-status-77"))).toBe("Approved by the Department Head, waiting for HR");
    expect(text(q("pc-placement-77"))).toContain("Sunday compensation · placed by HR (Meena) · “Family function”");
    expect(must("pc-placement-decide-77").getAttribute("href")).toBe(
      "/hr/requests?kind=compensation_placement&focus=77",
    );
    expect(text(q("pc-placement-status-78"))).toBe("Waiting for the Department Head");
    expect(q("pc-placement-decide-78")).toBeNull();
    click(must("pc-placement-withdraw-78"));
    click(must("pc-placement-withdraw-confirm-78"));
    await waitFor(() => world.writes.some((w) => w.method === "DELETE"), "the withdrawal");
    expect(world.writes.filter((w) => w.method === "DELETE").map((w) => w.url)).toEqual([
      "/api/compensation/claims/78",
    ]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Compensation day withdrawn" }));
  });

  it("greys Send out for a login without Edit on the Claims tab", async () => {
    h.user.current = {
      role: "hr",
      employeeId: null,
      permissions: { compensation: "edit", "compensation.leave.holiday_work.claims": "view" },
    };
    await openBalanceDialog();
    click(must("pc-day-2026-10-15"));
    expect(button("pc-send").disabled).toBe(true);
    expect(button("pc-send").title).toBe("Needs Edit on Compensation > Leave > Holiday work > Claims");
  });
});

describe("Choose date on a day off worked (Raise a claim)", () => {
  async function openSundayDialog() {
    mountPage(`${HOLIDAY}/raise`);
    await waitFor(() => !!q("claim-table"), "the people who worked");
    // only the people who can still be claimed for offer it
    expect(q("claim-place-E21")).not.toBeNull();
    expect(q("claim-place-E23")).toBeNull();
    click(must("claim-place-E21"));
    await waitFor(() => !!q("pc-calendar"), "the calendar");
  }

  it("asks for the day worked as the source and lets HR choose the credit, 1.00 by default", async () => {
    await openSundayDialog();
    expect(calendarAsks()).toEqual([{ employeeId: "21", source: "holiday_work:2026-10-11" }]);
    expect(text(q("pc-title"))).toBe("Sunday compensation for Fara Khan");
    expect(text(q("pc-source-figures"))).toBe("Credit 1.00");
    expect(must("pc-credit-1").getAttribute("aria-checked")).toBe("true");
    click(must("pc-day-2026-10-15"));
    click(must("pc-amount-0.50"));
    expect(text(q("pc-summary"))).toContain("The credit is 1.00 shift: the rest (0.50 shift) stays in the balance.");
  });

  it("is locked for a View Only role", async () => {
    mountPage(`${HOLIDAY}/raise`);
    await waitFor(() => !!q("claim-table"), "the people who worked");
    lockMutatingControls(document.body);
    await settle();
    expect(button("claim-place-E21").disabled).toBe(true);
  });

  it("keeps the day within a smaller credit and sends the credit with it", async () => {
    await openSundayDialog();
    click(must("pc-day-2026-10-15"));
    expect(must("pc-amount-1.00").getAttribute("aria-checked")).toBe("true");
    click(must("pc-credit-0.5"));
    expect(text(q("pc-source-figures"))).toBe("Credit 0.50");
    expect(must("pc-amount-0.50").getAttribute("aria-checked")).toBe("true");
    expect(button("pc-amount-0.75").disabled).toBe(true);
    expect(text(q("pc-summary"))).not.toContain("stays in the balance");
    click(must("pc-send"));
    await waitFor(() => bodiesOf(world, "POST", PLACE).length === 1, "the request");
    expect(bodiesOf(world, "POST", PLACE)[0]).toEqual({
      employeeId: 21,
      source: { type: "holiday_work", date: "2026-10-11" },
      useDate: "2026-10-15",
      shifts: 0.5,
      creditShifts: 0.5,
    });
  });
});

describe("Choose date on a Type 2 OT record (OT Detection)", () => {
  it("is offered next to Claim where the record can be claimed, and asks for the record as the source", async () => {
    world.ot = [
      ot(41, {
        employeeId: 21,
        employeeCode: "E21",
        employeeName: "Fara Khan",
        date: "2026-10-09",
        otType: "shift",
        lastPunchOut: "21:30",
        otMinutes: 240,
        allowanceMinutes: 0,
        suggestedShifts: 0.5,
        creditShifts: 0.5,
        creditRule: "quarters",
        status: "detected",
        statusLabel: "Detected",
        allowanceUsed: null,
        canAssign: true,
        claimable: true,
        claim: null,
      }),
      ot(42, {
        employeeId: 22,
        employeeCode: "E22",
        employeeName: "Gopal Das",
        date: "2026-10-10",
        otType: "shift",
        otMinutes: 240,
        allowanceMinutes: 0,
        creditShifts: 0.5,
        creditRule: "quarters",
        status: "detected",
        statusLabel: "Detected",
        allowanceUsed: null,
        canAssign: true,
        claimable: false,
        claim: null,
      }),
    ];
    mountPage("/hr/compensation/ot-detection/type-2/waiting");
    await waitFor(() => !!q("ot-type2-table"), "the Type 2 records");
    expect(q("ot2-claim-E21-2026-10-09")).not.toBeNull();
    expect(q("ot2-place-E22-2026-10-10")).toBeNull();
    // one line: Claim and Choose date side by side
    expect(must("ot2-place-E21-2026-10-09").parentElement).toBe(must("ot2-claim-E21-2026-10-09").parentElement);
    expect(button("ot2-place-E21-2026-10-09").title).toContain("send it to the Department Head, then HR");
    click(must("ot2-place-E21-2026-10-09"));
    await waitFor(() => !!q("pc-calendar"), "the calendar");
    expect(calendarAsks()).toEqual([{ employeeId: "21", source: "overtime:41" }]);
    expect(text(q("pc-title"))).toBe("Shift compensation for Fara Khan");
    expect(text(q("pc-source-figures"))).toBe("Total 0.50 · placed 0.00 · left 0.50");
    expect(q("pc-credit")).toBeNull();
    click(must("pc-day-2026-10-15"));
    expect(must("pc-amount-0.50").getAttribute("aria-checked")).toBe("true");
    click(must("pc-send"));
    await waitFor(() => bodiesOf(world, "POST", PLACE).length === 1, "the request");
    expect(bodiesOf(world, "POST", PLACE)[0]).toEqual({
      employeeId: 21,
      source: { type: "overtime", id: 41 },
      useDate: "2026-10-15",
      shifts: 0.5,
    });
  });
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

describe("the Claims list", () => {
  beforeEach(() => {
    world.claims.push(
      // an approved Sunday credit with 0.50 still to place
      claim(3010, {
        employeeId: 21,
        employeeCode: "E21",
        employeeName: "Fara Khan",
        status: "approved",
        shifts: 1,
        credited: true,
        placed: 0.5,
        leftToPlace: 0.5,
      }),
      // a date HR chose, approved by the Department Head, waiting for HR
      claim(3011, {
        employeeId: 22,
        employeeCode: "E22",
        employeeName: "Gopal Das",
        kind: "use_balance",
        workDate: "2026-10-20",
        useDate: "2026-10-20",
        useShifts: 0.5,
        hrStep: true,
        stage: "hr",
        statusLabel: "Approved by the Department Head, waiting for HR",
        compType: "balance",
        compTypeLabel: "Compensation balance",
        approval: twoSteps(true),
      }),
      // a date HR chose, still with the Department Head
      claim(3012, {
        employeeId: 27,
        employeeCode: "E27",
        employeeName: "Lata Roy",
        kind: "use_balance",
        workDate: "2026-10-22",
        useDate: "2026-10-22",
        useShifts: 1,
        shifts: 1,
        hrStep: true,
        stage: "hod",
        statusLabel: "Waiting for the Department Head",
        approval: twoSteps(false),
      }),
    );
  });

  async function openClaims() {
    mountPage(`${HOLIDAY}/claims`);
    await waitFor(() => rowKeys("claims-table").length > 0, "the claims");
  }

  it("offers Choose date on an approved credit with some still to place, and opens the calendar on it", async () => {
    await openClaims();
    expect(q("claim-place-3010")).not.toBeNull();
    // approved, but nothing left to place / not a credit / not approved
    expect(q("claim-place-3002")).toBeNull();
    expect(q("claim-place-3005")).toBeNull();
    expect(q("claim-place-3001")).toBeNull();
    click(must("claim-place-3010"));
    await waitFor(() => !!q("pc-calendar"), "the calendar");
    expect(calendarAsks()).toEqual([{ employeeId: "21", source: "claim:3010" }]);
    expect(text(q("pc-title"))).toBe("Sunday compensation for Fara Khan");
    expect(text(q("pc-source-figures"))).toBe("Total 1.00 · placed 0.50 · left 0.50");
  });

  it("shows the stage and the day off of a date HR chose", async () => {
    await openClaims();
    expect(text(q("claim-status-3011"))).toBe("Waiting for HR");
    expect(q("claim-status-3011")!.title).toBe("Approved by the Department Head, waiting for HR");
    expect(text(q("claim-stage-3011"))).toBe("Approved by the Department Head");
    expect(text(q("claim-dayoff-3011"))).toBe("Day off on 20 Oct 2026 · 0.50 shift");
    expect(text(q("claim-status-3012"))).toBe("Waiting for the Department Head");
    expect(q("claim-stage-3012")).toBeNull();
    expect(text(q("claim-dayoff-3012"))).toBe("Day off on 22 Oct 2026 · 1.00 shift");
    // HR decides only after the Department Head; before that it can be withdrawn
    expect(q("claim-approve-3011")).not.toBeNull();
    expect(q("claim-reject-3011")).not.toBeNull();
    expect(q("claim-withdraw-3011")).toBeNull();
    expect(q("claim-approve-3012")).toBeNull();
    expect(q("claim-withdraw-3012")).not.toBeNull();
  });

  it("Approve sends HR's approval to the placement's decision endpoint", async () => {
    await openClaims();
    click(must("claim-approve-3011"));
    await waitFor(() => bodiesOf(world, "PATCH", `${PLACE}/3011/decision`).length === 1, "the decision");
    expect(bodiesOf(world, "PATCH", `${PLACE}/3011/decision`)[0]).toEqual({ status: "approved" });
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Compensation day approved",
        description: "Gopal Das: Day off on 20 Oct 2026 · 0.50 shift.",
      }),
    );
  });

  it("locks Choose date, Approve and Reject for a View Only role, and keeps Details open", async () => {
    await openClaims();
    lockMutatingControls(document.body);
    await settle();
    expect(button("claim-place-3010").disabled).toBe(true);
    expect(button("claim-approve-3011").disabled).toBe(true);
    expect(button("claim-reject-3011").disabled).toBe(true);
    expect(button("claim-view-3010").disabled).toBe(false);
  });

  it("Reject asks for the reason first, then sends it", async () => {
    await openClaims();
    click(must("claim-reject-3011"));
    await waitFor(() => !!q("claim-reject-dialog"), "the reason dialog");
    expect(text(q("claim-reject-dialog"))).toContain("Reject this compensation day?");
    click(must("claim-reject-confirm"));
    await settle();
    expect(bodiesOf(world, "PATCH", `${PLACE}/3011/decision`)).toEqual([]);
    typeInto(must("claim-reject-text") as HTMLTextAreaElement, "The day is needed for dispatch");
    click(must("claim-reject-confirm"));
    await waitFor(() => bodiesOf(world, "PATCH", `${PLACE}/3011/decision`).length === 1, "the decision");
    expect(bodiesOf(world, "PATCH", `${PLACE}/3011/decision`)[0]).toEqual({
      status: "rejected",
      comment: "The day is needed for dispatch",
    });
    await waitFor(() => !q("claim-reject-dialog"), "the dialog to close");
  });
});
