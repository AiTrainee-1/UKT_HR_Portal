import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { OvertimeConfig, OvertimeRow } from "@/lib/api-client/custom-hooks";
import { OT_CONFIG, OT_ROWS } from "../fixtures";
import {
  allowanceStatusOf,
  allowanceUseText,
  applySkipped,
  assignFailure,
  assignModes,
  assignPayload,
  assignSummary,
  assignedText,
  checkAssign,
  commonBounds,
  effectText,
  filterHistory,
  filterOt,
  groupOt,
  grantBounds,
  initialAssignRows,
  isHistoryStatus,
  lastPunchText,
  otDepartments,
  otKpis,
  remainingAfter,
  rowKey,
  rowProblem,
  shiftsOf,
  type2Pause,
  type AssignRow,
} from "./ot-logic";

// The OT Detection rules as pure functions: the groups and tiles of a month, the filters, what can be done right now, and
// everything the Assign dialog decides.

const row = (id: number) => OT_ROWS.find((r) => r.id === id)!;
const config = (over: Partial<OvertimeConfig> = {}): OvertimeConfig => ({ ...OT_CONFIG, ...over });

describe("grouping the month's records", () => {
  it("separates Type 1, the Type 2 candidates, what HR dealt with, and the older records", () => {
    const groups = groupOt(OT_ROWS);
    expect(groups.allowance.map((r) => r.id)).toEqual([1, 2]);
    expect(groups.waiting.map((r) => r.id)).toEqual([3, 4]);
    expect(groups.history.map((r) => r.id)).toEqual([5, 6]);
    expect(groups.legacy.map((r) => r.id)).toEqual([7, 8]);
  });

  it("never lists a Type 1 row among the candidates, even though it has an OT date", () => {
    const groups = groupOt(OT_ROWS);
    expect(groups.waiting.every((r) => r.otType === "shift" && r.canAssign)).toBe(true);
  });

  it("keys a record by employee and OT day", () => {
    expect(rowKey(row(3))).toBe("13|2026-10-05");
  });
});

describe("the tiles", () => {
  it("counts Type 1 earned and used, what waits for HR, what was assigned and what was rejected", () => {
    const k = otKpis(OT_ROWS);
    expect(k.allowanceEarned).toBe(2);
    expect(k.allowanceMinutes).toBe(90);
    expect(k.allowanceUsed).toBe(1);
    expect(k.allowanceUsedMinutes).toBe(18);
    expect(k.allowanceNotUsed).toBe(1);
    expect(k.allowancePending).toBe(0);
    expect(k.waiting).toBe(2);
    expect(k.waitingSuggestedShifts).toBe(1.25);
    // assigned: the Type 2 relaxation (0.5) and the older announced record (one day = one shift)
    expect(k.assigned).toBe(2);
    expect(k.assignedShifts).toBe(1.5);
    expect(k.assignedRelaxation).toBe(1);
    expect(k.assignedPay).toBe(1);
    expect(k.rejected).toBe(1);
  });

  it("is all zeros for a quiet month", () => {
    const k = otKpis([]);
    expect(Object.values(k).every((v) => v === 0)).toBe(true);
  });

  it("counts an older announced record as one shift, and a waiting one as none", () => {
    expect(shiftsOf(row(7))).toBe(1);
    expect(shiftsOf(row(8))).toBeNull();
    expect(shiftsOf(row(5))).toBe(0.5);
  });
});

describe("the filters", () => {
  it("search by name, code or department", () => {
    expect(filterOt(OT_ROWS, { q: "asha", dept: "" }).map((r) => r.id)).toEqual([1, 4]);
    expect(filterOt(OT_ROWS, { q: "E13", dept: "" }).map((r) => r.id)).toEqual([3]);
    expect(filterOt(OT_ROWS, { q: "cutting", dept: "" }).map((r) => r.id)).toEqual([2, 5, 6]);
  });

  it("narrow to one department by its name", () => {
    expect(filterOt(OT_ROWS, { q: "", dept: "Cutting" }).map((r) => r.id)).toEqual([2, 5, 6]);
    expect(filterOt(OT_ROWS, { q: "bala", dept: "Cutting" }).map((r) => r.id)).toEqual([2, 6]);
    expect(filterOt(OT_ROWS, { q: "asha", dept: "Cutting" })).toEqual([]);
  });

  it("list the departments that occur, sorted", () => {
    expect(otDepartments(OT_ROWS)).toEqual(["Cutting", "Sales"]);
  });

  it("filter the Type 2 history by status", () => {
    const history = groupOt(OT_ROWS).history;
    expect(filterHistory(history, "assigned").map((r) => r.id)).toEqual([5]);
    expect(filterHistory(history, "rejected").map((r) => r.id)).toEqual([6]);
    expect(filterHistory(history, "all").map((r) => r.id)).toEqual([5, 6]);
    expect(isHistoryStatus("assigned")).toBe(true);
    expect(isHistoryStatus("detected")).toBe(false);
  });
});

describe("words", () => {
  it("says whether and when the allowance was used", () => {
    expect(allowanceUseText(row(1))).toEqual({ status: "used", used: true, text: "Used on 7 Oct 2026 (18 min)" });
    expect(allowanceUseText(row(2))).toEqual({ status: "not_used", used: false, text: "Not used" });
  });

  it("never reads a pending allowance as not used", () => {
    const pending: OvertimeRow = { ...row(2), allowanceStatus: "pending", allowanceUsed: false };
    expect(allowanceUseText(pending)).toEqual({ status: "pending", used: false, text: "Pending" });
    expect(allowanceStatusOf(pending)).toBe("pending");
  });

  it("reads the status the server sends, whatever allowanceUsed says (a window or relaxation can win the day marker)", () => {
    // used although allowanceUsed is false: the marker went to a window, but compensation minutes were used
    const used: OvertimeRow = {
      ...row(2),
      allowanceUsed: false,
      allowanceStatus: "used",
      usedOn: "2026-10-08",
      usedMinutes: 10,
    };
    expect(allowanceUseText(used)).toEqual({ status: "used", used: true, text: "Used on 8 Oct 2026 (10 min)" });
    // a used one with no day on record still says Used
    expect(allowanceUseText({ ...used, usedOn: null, usedMinutes: null }).text).toBe("Used");
  });

  it("falls back to allowanceUsed for a backend that sends no status", () => {
    expect(allowanceStatusOf({ allowanceStatus: undefined, allowanceUsed: true })).toBe("used");
    expect(allowanceStatusOf({ allowanceStatus: undefined, allowanceUsed: false })).toBe("not_used");
    expect(allowanceStatusOf({ allowanceStatus: null, allowanceUsed: null })).toBe("not_used");
  });

  it("counts Used, Not used and Pending from the status", () => {
    const rows: OvertimeRow[] = [
      { ...row(1), allowanceStatus: "used", usedMinutes: 20 },
      { ...row(2), allowanceStatus: "pending", allowanceUsed: false },
      { ...row(2), id: 20, allowanceStatus: "pending", allowanceUsed: false },
      { ...row(2), id: 21, allowanceStatus: "not_used", allowanceUsed: false },
      { ...row(1), id: 22, allowanceStatus: "used", allowanceUsed: false, usedMinutes: 5 },
    ];
    const k = otKpis(rows);
    expect([k.allowanceEarned, k.allowanceUsed, k.allowanceNotUsed, k.allowancePending]).toEqual([5, 2, 1, 2]);
    expect(k.allowanceUsedMinutes).toBe(25);
  });

  it("marks a punch after midnight", () => {
    expect(lastPunchText(row(3))).toBe("21:30");
    expect(lastPunchText(row(4))).toBe("01:00 (next day)");
    expect(lastPunchText({ lastPunchOut: null, lastPunchNextDay: false })).toBe("—");
  });

  it("says what an assigned record gave", () => {
    expect(assignedText(row(5))).toBe("Relaxation on 12 Oct 2026");
    expect(assignedText(row(7))).toBe("Payment: one day's pay");
    expect(assignedText({ ...row(5), compensationType: "pay", claimDate: null })).toBe("Payment");
    expect(assignedText({ ...row(5), compensationType: "pay", claimDate: "2026-10-20" })).toBe(
      "Payment (granted 20 Oct 2026)",
    );
    expect(assignedText({ ...row(7), compensationType: "relaxation" })).toBe("Relaxation: one Alternative-Day credit");
    expect(assignedText(row(3))).toBe("—");
  });
});

describe("what can be done right now", () => {
  it("offers only the modes switched on in Settings", () => {
    expect(assignModes(config())).toEqual(["relaxation", "pay"]);
    expect(assignModes(config({ payEnabled: false }))).toEqual(["relaxation"]);
    expect(assignModes(config({ relaxationEnabled: false }))).toEqual(["pay"]);
    expect(assignModes(config({ relaxationEnabled: false, payEnabled: false }))).toEqual([]);
  });

  it("offers no mode while Type 2 or the master switch is off, or before the settings are known", () => {
    expect(assignModes(config({ shiftEnabled: false }))).toEqual([]);
    expect(assignModes(config({ masterEnabled: false }))).toEqual([]);
    expect(assignModes(undefined)).toEqual([]);
  });

  it("says why changing is paused: the master switch first, then Type 2, then the two modes", () => {
    expect(type2Pause(config(), false)).toBeNull();
    expect(type2Pause(config(), true)?.reason).toMatch(/switched off in Settings → Payroll/);
    expect(type2Pause(config({ masterEnabled: false }), false)?.reason).toMatch(/Settings → Payroll/);
    const type2Off = type2Pause(config({ shiftEnabled: false }), false);
    expect(type2Off?.reason).toMatch(/Type 2 \(shift-based compensation\) is switched off in Settings → Compensation/);
    expect(type2Off?.setting).toBe("shift-enabled");
    expect(type2Pause(config({ relaxationEnabled: false, payEnabled: false }), false)?.reason).toMatch(
      /neither Relaxation nor Payment/,
    );
    // the master switch wins over everything else
    expect(type2Pause(config({ shiftEnabled: false }), true)?.reason).toMatch(/Settings → Payroll/);
    // settings not loaded yet: nothing is paused (the buttons wait for the selection anyway)
    expect(type2Pause(undefined, false)).toBeNull();
  });
});

describe("the Assign dialog", () => {
  const waiting = [row(3), row(4)];

  it("starts every record on its suggested shifts, with no date", () => {
    const rows = initialAssignRows(waiting);
    expect(rows.map((r) => [r.key, r.shifts, r.claimDate])).toEqual([
      ["13|2026-10-05", 0.5, ""],
      ["11|2026-10-09", 0.75, ""],
    ]);
    expect(rows[0].suggested).toBe(0.5);
  });

  it("starts with no shifts chosen when the suggestion is not one of the four amounts", () => {
    const odd: OvertimeRow = { ...row(3), suggestedShifts: 0.3 };
    expect(initialAssignRows([odd])[0].shifts).toBeNull();
    expect(initialAssignRows([{ ...row(3), suggestedShifts: null }])[0].shifts).toBeNull();
  });

  it("limits the granted date to the month of the OT day", () => {
    expect(grantBounds("2026-10-05")).toEqual({ min: "2026-10-01", max: "2026-10-31" });
    expect(grantBounds("2028-02-10")).toEqual({ min: "2028-02-01", max: "2028-02-29" });
    expect(commonBounds(initialAssignRows(waiting))).toEqual({ min: "2026-10-01", max: "2026-10-31" });
    // records of two different months have no date in common
    expect(commonBounds([{ date: "2026-10-05" }, { date: "2026-11-02" }])).toBeNull();
    expect(commonBounds([])).toBeNull();
  });

  describe("what is wrong with a row", () => {
    const base = initialAssignRows([row(3)])[0];
    const rowWith = (over: Partial<AssignRow>): AssignRow => ({ ...base, ...over });

    it("needs the shifts", () => {
      expect(rowProblem("pay", rowWith({ shifts: null }))).toMatch(/Choose the shifts/);
    });

    it("needs a date for Relaxation but not for Payment", () => {
      expect(rowProblem("relaxation", rowWith({ claimDate: "" }))).toMatch(/Choose the date the day off is granted/);
      expect(rowProblem("pay", rowWith({ claimDate: "" }))).toBeNull();
    });

    it("accepts any day of the same month, before or after the OT day", () => {
      for (const day of ["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-31"]) {
        expect(rowProblem("relaxation", rowWith({ claimDate: day }))).toBeNull();
      }
    });

    it("refuses a date in another month, for either mode", () => {
      for (const day of ["2026-09-30", "2026-11-01", "2025-10-05"]) {
        expect(rowProblem("relaxation", rowWith({ claimDate: day }))).toMatch(/must be in October 2026/);
        expect(rowProblem("pay", rowWith({ claimDate: day }))).toMatch(/must be in October 2026/);
      }
    });

    it("refuses a date that is not a day", () => {
      expect(rowProblem("relaxation", rowWith({ claimDate: "2026-10-40" }))).toBe("Enter a valid date.");
    });
  });

  describe("the check as a whole", () => {
    const modes = ["relaxation", "pay"] as const;
    const dated = (d: string) => initialAssignRows(waiting).map((r) => ({ ...r, claimDate: d }));

    it("passes when every row is complete", () => {
      const result = checkAssign("relaxation", [...modes], dated("2026-10-12"));
      expect(result).toEqual({ ok: true, problems: {}, general: null });
    });

    it("lists each row's problem by its key", () => {
      const rows = initialAssignRows(waiting);
      const result = checkAssign("relaxation", [...modes], rows);
      expect(result.ok).toBe(false);
      expect(Object.keys(result.problems)).toEqual(["13|2026-10-05", "11|2026-10-09"]);
    });

    it("asks for a mode, and refuses a mode that is switched off", () => {
      expect(checkAssign(null, [...modes], dated("2026-10-12")).general).toMatch(/Choose how to give it/);
      expect(checkAssign("pay", ["relaxation"], dated("2026-10-12")).ok).toBe(false);
    });

    it("has nothing to assign when no row is left", () => {
      expect(checkAssign("pay", [...modes], []).general).toMatch(/nothing left/);
    });
  });

  it("sends every record with its own shifts and date, and the mode", () => {
    const rows = initialAssignRows(waiting).map((r, i) => ({ ...r, claimDate: i === 0 ? "2026-10-12" : "" }));
    expect(assignPayload("relaxation", rows)).toEqual({
      mode: "relaxation",
      records: [
        { employeeId: 13, date: "2026-10-05", shifts: 0.5, claimDate: "2026-10-12" },
        { employeeId: 11, date: "2026-10-09", shifts: 0.75 },
      ],
    });
  });

  it("says what will happen to each record, and to all of them", () => {
    const [first] = initialAssignRows([row(3)]);
    expect(effectText("relaxation", { ...first, claimDate: "2026-10-12" })).toBe(
      "12 Oct 2026 is topped up by 0.50 shifts (a day never goes above 1 shift).",
    );
    expect(effectText("relaxation", first)).toBe("Choose the day to top up.");
    expect(effectText("pay", first)).toBe(
      "0.50 shifts × the daily rate is added to the October 2026 payslip as OT pay.",
    );
    expect(effectText("pay", { ...first, shifts: null })).toBe("—");

    const rows = initialAssignRows(waiting);
    expect(assignSummary("relaxation", rows)).toContain("2 records for 2 employees, 1.25 shifts in all.");
    expect(assignSummary("relaxation", rows)).toContain("topped up");
    expect(assignSummary("pay", rows)).toContain("daily rate");
    expect(assignSummary("pay", [rows[0]])).toContain("1 record for 1 employee, 0.50 shifts in all.");
  });

  describe("the server's refusals", () => {
    const rows = initialAssignRows(waiting);
    const skipped = [{ employeeId: 11, date: "2026-10-09", reason: "E11 on 09 Oct 2026: it is already assigned." }];

    it("land on the row they are about", () => {
      const marked = applySkipped(rows, skipped);
      expect(marked[0].problem).toBeNull();
      expect(marked[1].problem).toBe("E11 on 09 Oct 2026: it is already assigned.");
    });

    it("leave only the refused rows in the dialog", () => {
      expect(remainingAfter(rows, skipped).map((r) => r.key)).toEqual(["11|2026-10-09"]);
      expect(remainingAfter(rows, [])).toEqual([]);
    });

    it("are read from a 400 that assigned nothing", () => {
      const err = new ApiError(
        new Response(null, { status: 400, statusText: "400" }),
        { error: "first reason", assigned: 0, skipped },
        { method: "POST", url: "/x" },
      );
      expect(assignFailure(err)).toEqual({ message: "first reason", skipped });
    });

    it("fall back to a plain sentence when nothing usable came back", () => {
      expect(assignFailure(new Error("down")).message).toMatch(/could not be assigned/);
      const refused = new ApiError(
        new Response(null, { status: 403, statusText: "403" }),
        { error: "Payment is switched off in Settings > Compensation." },
        { method: "POST", url: "/x" },
      );
      expect(assignFailure(refused)).toEqual({
        message: "Payment is switched off in Settings > Compensation.",
        skipped: [],
      });
    });
  });
});
