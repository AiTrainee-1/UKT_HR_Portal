import { describe, expect, it } from "vitest";
import { bankFileRows, isBankFileEligible } from "@/lib/payrollExcelExport";
import { monthStatus, run } from "./fixtures";
import {
  FINALIZE_QUESTION,
  WHOLE_COMPANY_ONLY,
  daysAfterFinalizing,
  elapsedLabel,
  elapsedShort,
  finalizeWarnings,
  monthButton,
  rowsOf,
  skippedCount,
  skippedStatementQuery,
  staffSkippedRows,
  timelineSteps,
} from "./logic";

// The Staff Payroll month workflow as the page shows it (owner 2026-11-10): the header button's three states, the live
// timer's words, the Payroll Done popup's warnings, the month's timeline, the grouped Skipped Employees, and the two bank
// files: the month's never pays a held or new employee, the Skipped Employees' pays ONLY them (and never twice).

const NOW = new Date("2026-11-12T10:00:00Z");

describe("the live timer", () => {
  it("counts days, hours and minutes since finalizing", () => {
    expect(elapsedLabel("2026-11-10T07:48:00Z", NOW)).toBe("2 days 2 h 12 min");
    expect(elapsedLabel("2026-11-11T10:00:00Z", NOW)).toBe("1 day 0 h 0 min");
    expect(elapsedLabel("2026-11-12T06:05:00Z", NOW)).toBe("3 h 55 min");
    expect(elapsedLabel("2026-11-12T09:48:00Z", NOW)).toBe("12 min");
    expect(elapsedLabel("2026-11-12T09:59:40Z", NOW)).toBe("under a minute");
    expect(elapsedLabel(null, NOW)).toBe("—");
    expect(elapsedShort("2026-11-10T07:48:00Z", NOW)).toBe("2d 2h 12m");
    expect(elapsedShort("2026-11-12T06:05:00Z", NOW)).toBe("3h 55m");
  });

  it("never goes negative when the clock is behind the server", () => {
    expect(elapsedLabel("2026-11-12T10:05:00Z", NOW)).toBe("under a minute");
  });

  it("says how many days payment took", () => {
    expect(daysAfterFinalizing(0)).toBe("the same day as finalizing");
    expect(daysAfterFinalizing(1)).toBe("1 day after finalizing");
    expect(daysAfterFinalizing(3)).toBe("3 days after finalizing");
    expect(daysAfterFinalizing(null)).toBe("");
  });
});

describe("the header button", () => {
  it("is Payroll Done while the month is open", () => {
    expect(monthButton(monthStatus(), NOW)).toEqual({
      kind: "done",
      label: "Payroll Done",
      detail: "",
      blockedReason: "",
    });
  });

  it("cannot be pressed by a unit login, nor without payroll, nor without edit rights - and says why", () => {
    const can = { finalize: false, markPaid: false, hold: false, addToPayroll: false, releaseAndPay: false };
    expect(monthButton(monthStatus({ wholeCompany: false, can }))!.blockedReason).toBe(WHOLE_COMPANY_ONLY);
    const empty = monthStatus({ can, counts: { ...monthStatus().counts, inPayroll: 0 } });
    expect(monthButton(empty)!.blockedReason).toBe("There is no payroll for October 2026 yet: generate it first.");
    expect(monthButton(monthStatus({ can }))!.blockedReason).toContain("payroll edit rights");
  });

  it("is Payment Pending with the timer once finalized", () => {
    const s = monthStatus({ state: "finalized", locked: true, finalizedAt: "2026-11-10T07:48:00Z" });
    expect(monthButton(s, NOW)).toEqual({
      kind: "pending",
      label: "Payment Pending",
      detail: "2d 2h 12m",
      blockedReason: "",
    });
  });

  it("is Paid with the date and the days it took", () => {
    const s = monthStatus({
      state: "paid",
      locked: true,
      finalizedAt: "2026-11-10T07:48:00Z",
      paidAt: "2026-11-12T09:00:00Z",
      daysToPay: 2,
    });
    expect(monthButton(s, NOW)).toMatchObject({
      kind: "paid",
      label: "Paid",
      detail: "12 Nov 2026 · 2 days after finalizing",
    });
    expect(monthButton(undefined)).toBeNull();
  });
});

describe("the Payroll Done popup", () => {
  it("asks the owner's question word for word", () => {
    expect(FINALIZE_QUESTION).toBe(
      "Are you sure you want to finalize this month's payroll? Once confirmed, payroll generation and recomputation will be permanently locked for this month.",
    );
  });

  it("points out what is still open, without blocking", () => {
    expect(finalizeWarnings(monthStatus())).toEqual([]);
    const s = monthStatus({
      monthEnded: false,
      counts: { ...monthStatus().counts, notCleared: 3, onHold: 1, newJoiners: 2 },
    });
    expect(finalizeWarnings(s)).toEqual([
      "October 2026 has not ended yet: days still to come are counted as absent.",
      "3 employees in the payroll are not Cleared yet.",
      "1 salary is on hold: not in the bank file, paid later one by one with Release & pay.",
      "2 new joiners are not added to the payroll: after finalizing they can only be paid one by one with Release & pay.",
    ]);
  });
});

describe("the month's timeline", () => {
  it("shows generated, finalized and paid, each when it happened", () => {
    const open = timelineSteps(monthStatus(), NOW);
    expect(open.map((s) => [s.key, s.done])).toEqual([
      ["generated", true],
      ["finalized", false],
      ["paid", false],
    ]);
    expect(open[0].detail).toMatch(/^Last computed /);
    expect(open[1].detail).toBe("Not finalized yet");

    const pending = timelineSteps(
      monthStatus({ state: "finalized", finalizedAt: "2026-11-10T07:48:00Z", finalizedBy: "Meena" }),
      NOW,
    );
    expect(pending[1]).toMatchObject({ done: true, detail: "By Meena · locked for good" });
    expect(pending[2].detail).toBe("Waiting for payment: 2 days 2 h 12 min so far");

    const paid = timelineSteps(
      monthStatus({
        state: "paid",
        finalizedAt: "2026-11-10T07:48:00Z",
        paidAt: "2026-11-11T05:00:00Z",
        paidBy: "Admin",
        daysToPay: 1,
      }),
      NOW,
    );
    expect(paid[2]).toMatchObject({ done: true, detail: "By Admin · 1 day after finalizing" });
    expect(timelineSteps(monthStatus({ firstGeneratedAt: null, lastComputedAt: null }))[0].detail).toBe(
      "Not generated yet",
    );
  });
});

describe("Skipped Employees, grouped", () => {
  const lists = {
    onHold: [
      run({ id: 1, employeeCode: "H1", onHold: true, holdChangedBy: "Meena", holdChangedAt: "2026-11-05T05:00:00Z" }),
    ],
    newJoiners: [run({ id: 2, employeeCode: "N1", newJoinerParked: true, joinDate: "2026-10-14" })],
    paidSeparately: [
      run({ id: 3, employeeCode: "P1", releasedFrom: "new_joiner", paymentPaidAt: "2026-11-20T05:00:00Z" }),
    ],
  };
  const notGenerated = [{ employeeId: 9, employeeCode: "X9", name: "Divya", reason: "No Salary Amount set" }];

  it("lists not generated, on hold, new joiners and paid separately, each with its reason", () => {
    const rows = staffSkippedRows(notGenerated, lists);
    expect(rows.map((r) => [r.group, r.employeeCode])).toEqual([
      ["not_generated", "X9"],
      ["on_hold", "H1"],
      ["new_joiner", "N1"],
      ["paid_separately", "P1"],
    ]);
    expect(rowsOf(rows, "on_hold")[0].reason).toBe("Salary on hold by Meena on 5 Nov 2026");
    expect(rowsOf(rows, "new_joiner")[0].reason).toBe(
      "New joiner (joined 2026-10-14): calculated, kept out of the payroll until added",
    );
    expect(rowsOf(rows, "paid_separately")[0].reason).toBe(
      "Was a new joiner; released and paid separately on 20 Nov 2026",
    );
    expect(rowsOf(rows, "not_generated")[0]).toMatchObject({ net: null, payrollId: null });
    expect(rowsOf(rows, "on_hold")[0]).toMatchObject({ gross: 24000, deductions: 1000, net: 23000, payrollId: 1 });
  });

  it("counts everyone not in the payroll (a person paid separately is paid, not skipped)", () => {
    expect(skippedCount(staffSkippedRows(notGenerated, lists))).toBe(3);
    expect(skippedCount(staffSkippedRows(undefined, undefined))).toBe(0);
  });
});

describe("the bank file", () => {
  it("never pays a salary on hold or a new joiner not added to the payroll", () => {
    expect(isBankFileEligible(run())).toBe(true);
    expect(isBankFileEligible(run({ onHold: true }))).toBe(false);
    expect(isBankFileEligible(run({ newJoinerParked: true }))).toBe(false);
    // released and paid on their own: their one-person file pays them
    expect(isBankFileEligible(run({ releasedFrom: "hold", paymentStatus: "paid" }))).toBe(true);
    // an older server sends no flags at all
    expect(isBankFileEligible({})).toBe(true);
  });
});

describe("the Skipped Employees' own bank file and statement (owner 2026-11-10)", () => {
  const MAIN = run({ id: 1, employeeCode: "M1" });
  const HELD = run({ id: 2, employeeCode: "H1", onHold: true });
  const NEW = run({ id: 3, employeeCode: "N1", newJoinerParked: true });
  const PAID = run({ id: 4, employeeCode: "P1", releasedFrom: "hold", paymentStatus: "paid" });
  const codes = (rows: { employeeCode?: string | null }[]) => rows.map((r) => r.employeeCode);

  it("pays ONLY the held and new employees not paid yet: never the main payroll, never someone already paid", () => {
    expect(codes(bankFileRows([MAIN, HELD, NEW, PAID], "skipped"))).toEqual(["H1", "N1"]);
    // a held salary somehow already paid is never paid again
    expect(bankFileRows([run({ onHold: true, paymentStatus: "paid" })], "skipped")).toEqual([]);
  });

  it("leaves the month's own file as it was: everyone but held and new", () => {
    expect(codes(bankFileRows([MAIN, HELD, NEW, PAID]))).toEqual(["M1", "P1"]);
    expect(codes(bankFileRows([MAIN, HELD, NEW, PAID], "payroll"))).toEqual(["M1", "P1"]);
  });

  it("asks the Report Center for the same statement, skipped employees only", () => {
    expect(skippedStatementQuery({ month: 10, year: 2026 }).toString()).toBe("period=2026-10&section=skipped");
  });
});
