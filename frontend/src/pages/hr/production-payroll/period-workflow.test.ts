import { describe, expect, it } from "vitest";
import type { ProductionPeriodWorkflow } from "@/lib/api-client/custom-hooks";
import {
  draftGroups,
  movedOutHeadline,
  movedOutPaid,
  moveRoute,
  newJoinerDays,
  newJoinerReason,
  paidOnProblem,
  periodBankRows,
  periodButton,
  periodStateOf,
  periodTimeline,
  todayIso,
} from "./period-workflow";

const status = (over: Partial<ProductionPeriodWorkflow> = {}): ProductionPeriodWorkflow => ({
  cycle: "weekly",
  label: "Weekly",
  periodStart: "2026-02-02",
  periodEnd: "2026-02-08",
  periodLabel: "2 Feb – 8 Feb 2026",
  state: "generated",
  stateLabel: "Generated",
  locked: false,
  periodEnded: true,
  finalizedAt: null,
  finalizedBy: null,
  paidAt: null,
  paidBy: null,
  paidOn: null,
  daysToPay: null,
  firstGeneratedAt: "2026-02-09T10:00:00+05:30",
  lastComputedAt: "2026-02-09T10:00:00+05:30",
  counts: {
    generated: 3,
    inPayroll: 3,
    notCleared: 1,
    parked: 0,
    newJoiners: 0,
    movedIn: 0,
    addedToPayroll: 0,
    paid: 0,
    notPaid: 3,
    mainNet: 9000,
  },
  snapshot: null,
  finalizeBlockers: [],
  wholeCompany: true,
  can: { finalize: true, markPaid: false, addToPayroll: true, adjust: true, markCleared: true, generate: true },
  ...over,
});

describe("the period's button", () => {
  it("is Payroll Done while open, with the reason it cannot be pressed", () => {
    expect(periodButton(status())).toMatchObject({ kind: "done", blockedReason: "" });
    const parked = status({
      can: { ...status().can, finalize: false },
      finalizeBlockers: ["1 worker is still waiting in New Joiners."],
    });
    expect(periodButton(parked)!.blockedReason).toBe("1 worker is still waiting in New Joiners.");
    expect(
      periodButton(status({ wholeCompany: false, can: { ...status().can, finalize: false } }))!.blockedReason,
    ).toContain("whole-company login");
    expect(periodButton(status({ can: { ...status().can, finalize: false } }))!.blockedReason).toContain(
      "Payroll Done needs Edit",
    );
    expect(periodButton(undefined)).toBeNull();
  });

  it("is Payment Pending with the time since Payroll Done, then Paid with the day", () => {
    const now = new Date("2026-02-12T12:30:00+05:30");
    const pending = periodButton(status({ state: "finalized", finalizedAt: "2026-02-10T10:00:00+05:30" }), now)!;
    expect(pending).toMatchObject({ kind: "pending", label: "Payment Pending", detail: "2d 2h 30m" });
    const paid = periodButton(
      status({ state: "paid", finalizedAt: "2026-02-10T10:00:00+05:30", paidOn: "2026-02-11", daysToPay: 1 }),
      now,
    )!;
    expect(paid).toMatchObject({ kind: "paid", label: "Paid" });
    expect(paid.detail).toContain("11 Feb 2026");
    expect(paid.detail).toContain("1 day after finalizing");
  });

  it("reads an unknown state as not generated", () => {
    expect(periodStateOf("paid")).toBe("paid");
    expect(periodStateOf(undefined)).toBe("not_generated");
    expect(periodStateOf("odd")).toBe("not_generated");
  });
});

describe("the timeline", () => {
  it("names who finalized and when it was paid; a backfilled period says so", () => {
    const steps = periodTimeline(
      status({
        state: "paid",
        finalizedAt: "2026-02-10T10:00:00+05:30",
        finalizedBy: "Priya",
        paidAt: "2026-02-11T09:00:00+05:30",
        paidOn: "2026-02-11",
        paidBy: "Priya",
        daysToPay: 1,
      }),
    );
    expect(steps.map((s) => s.done)).toEqual([true, true, true]);
    expect(steps[1].detail).toContain("By Priya");
    expect(steps[2].when).toContain("11 Feb 2026");
    const old = periodTimeline(
      status({
        state: "paid",
        finalizedAt: "2026-02-10T10:00:00+05:30",
        paidAt: "2026-02-10T10:00:00+05:30",
        snapshot: { inPayroll: 3, notCleared: 0, mainNet: 0, backfill: true },
      }),
    );
    expect(old[2].detail).toContain("Cleared before the period workflow");
  });
});

describe("the paid day", () => {
  it("must be a real day, not in the future, not before the period's last day", () => {
    expect(paidOnProblem("", "2026-02-08", "2026-02-12")).toContain("Enter the date");
    expect(paidOnProblem("2026-02-13", "2026-02-08", "2026-02-12")).toContain("future");
    expect(paidOnProblem("2026-02-07", "2026-02-08", "2026-02-12")).toContain("8 Feb 2026");
    expect(paidOnProblem("2026-02-08", "2026-02-08", "2026-02-12")).toBeNull();
    expect(todayIso(new Date(2026, 1, 3))).toBe("2026-02-03");
  });
});

describe("New Joiners and Moved out in words", () => {
  const move = {
    fromCycle: null,
    fromLabel: "Unassigned",
    cameFrom: "weekly" as const,
    cameFromLabel: "Weekly",
    toLabel: "BiWeekly",
  };

  it("names the route a worker took, through Unassigned too", () => {
    expect(moveRoute(move)).toBe("Weekly → BiWeekly");
    expect(moveRoute({ ...move, cameFromLabel: "Unassigned" })).toBe("Unassigned → BiWeekly");
    expect(moveRoute({ ...move, fromCycle: "monthly", fromLabel: "Monthly" })).toBe("Monthly → BiWeekly");
  });

  it("says why a worker waits in New Joiners", () => {
    expect(newJoinerReason({ parkedReason: "new_joiner", joinedOn: "2026-02-05", move: null })).toBe(
      "Joined on 5 Feb 2026",
    );
    expect(
      newJoinerReason({
        parkedReason: "transfer",
        joinedOn: null,
        move: { ...move, changedOn: "2026-02-04" } as never,
      }),
    ).toBe("Moved from Weekly → BiWeekly on 4 Feb 2026");
    expect(newJoinerReason({ parkedReason: "transfer", joinedOn: null, move: null })).toBe(
      "Moved here from another pay cycle",
    );
  });

  it("counts the eligible, the left-out and the catch-up days", () => {
    const days = {
      periodDays: 14,
      eligibleDays: 10,
      excludedDays: 7,
      catchUpDays: 3,
      alreadyPaid: [{ label: "Weekly" }],
      catchUp: [],
      shifts: 10,
    } as never;
    expect(newJoinerDays(days)).toBe(
      "7 days of 14 in the period · 7 days already paid on Weekly, left out · + 3 catch-up days no cycle had paid",
    );
    expect(
      newJoinerDays({ periodDays: 7, eligibleDays: 7, excludedDays: 0, catchUpDays: 0, alreadyPaid: [] } as never),
    ).toBe("7 eligible days");
  });

  it("says where a worker went and what this cycle paid them", () => {
    expect(
      movedOutHeadline({ toCycle: "monthly", toLabel: "Monthly", changedOn: "2026-02-04", changedBy: "Priya" }),
    ).toBe("Moved to Monthly on 4 Feb 2026 by Priya");
    expect(movedOutHeadline({ toCycle: null, toLabel: "Unassigned", changedOn: "2026-02-04", changedBy: null })).toBe(
      "Taken off the pay cycle (Unassigned) on 4 Feb 2026",
    );
    expect(movedOutPaid({ lastPaidThrough: "2026-02-08", paidPeriods: 2, paidNet: 7000 })).toBe(
      "Paid here up to 8 Feb 2026: 2 pay periods, ₹7,000 net",
    );
    expect(movedOutPaid({ lastPaidThrough: null, paidPeriods: 0, paidNet: 0 })).toContain("Nothing was paid");
  });

  it("pays every row of the period in the bank file except a worker waiting in New Joiners", () => {
    expect(periodBankRows([{ newJoinerParked: false }, { newJoinerParked: true }, {}] as never[])).toHaveLength(2);
  });
});

describe("draft payslips, grouped for the Generate dialog", () => {
  it("groups by period and cycle, oldest first, counting workers and Cleared marks", () => {
    const d = (start: string, cleared = false, cycle: "biweekly" | "weekly" = "biweekly") => ({
      payrollId: 1,
      cycle,
      label: cycle === "weekly" ? "Weekly" : "BiWeekly",
      periodStart: start,
      periodEnd: start,
      periodLabel: start,
      status: cleared ? "paid" : "pending",
      cleared,
      net: 1,
    });
    const groups = draftGroups([
      { drafts: [d("2026-10-26"), d("2026-10-12", true)] },
      { drafts: [d("2026-10-12")] },
      { drafts: [d("2026-10-12", false, "weekly")] },
      { drafts: null },
    ]);
    expect(groups.map((g) => [g.periodStart, g.label, g.workers, g.cleared])).toEqual([
      ["2026-10-12", "BiWeekly", 2, 1],
      ["2026-10-12", "Weekly", 1, 0],
      ["2026-10-26", "BiWeekly", 1, 0],
    ]);
  });
});
