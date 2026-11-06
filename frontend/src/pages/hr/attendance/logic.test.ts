import { describe, expect, it } from "vitest";
import {
  ABSENT,
  CL,
  DAY,
  MANUAL,
  NIGHT,
  ON_DUTY,
  ON_LEAVE,
  PENDING_LEAVE,
  PRESENT,
  STAFF_DAY,
  punch,
  row,
} from "./fixtures";
import {
  BOARD_ORDER,
  arrivalCurve,
  arrivalStats,
  boardStateOf,
  countBoard,
  departmentsOf,
  filterRows,
  indexRows,
  leaveFacts,
  parseStatusFilter,
  punchKind,
  punchText,
  punchTitle,
  shortDate,
} from "./logic";

describe("which card a row belongs to", () => {
  it("files every kind of day under the owner's six cards", () => {
    expect(STAFF_DAY.map((r) => boardStateOf(r))).toEqual([
      "present",
      "present",
      "absent",
      "leave_applied",
      "on_leave",
      "cl",
      "on_duty",
    ]);
  });

  it("puts an approved On-Duty first, then any punch, then the approved absences, then a waiting request", () => {
    // punched on a half-day leave: present (the chip says the rest)
    expect(boardStateOf({ status: "present", leaveState: "on_leave" })).toBe("present");
    // an approved CL without punches is not Absent, though the server's status still says absent
    expect(boardStateOf({ status: "absent", leaveState: "cl" })).toBe("cl");
    // a paid birthday leave arrives as status on_leave with no leave request
    expect(boardStateOf({ status: "on_leave", leaveState: null })).toBe("on_leave");
    expect(boardStateOf({ status: "absent", leaveState: "leave_applied" })).toBe("leave_applied");
    expect(boardStateOf({ status: "absent", leaveState: "on_duty" })).toBe("on_duty");
    // an older backend sends no leaveState at all
    expect(boardStateOf({ status: "absent" })).toBe("absent");
  });

  it("counts add up to the roster, with the extras the cards mention", () => {
    const c = countBoard([...STAFF_DAY, NIGHT]);
    expect(BOARD_ORDER.reduce((n, s) => n + c[s], 0)).toBe(c.total);
    expect(c).toMatchObject({
      present: 3,
      on_duty: 1,
      on_leave: 1,
      cl: 1,
      leave_applied: 1,
      absent: 1,
      total: 8,
      manual: 1,
      late: 1,
      heldPunches: 1,
    });
  });
});

describe("filters", () => {
  it("reads only known filters from the address", () => {
    expect(parseStatusFilter("cl")).toBe("cl");
    expect(parseStatusFilter("on_leave")).toBe("on_leave");
    expect(parseStatusFilter("nonsense")).toBe("all");
    expect(parseStatusFilter(null)).toBe("all");
  });

  it("filters by status, department and a name / code search, sorted by name", () => {
    const index = indexRows(STAFF_DAY);
    const names = (status: Parameters<typeof filterRows>[1]["status"], query = "", department = "") =>
      filterRows(index, { status, query, department }).map((r) => r.employeeName);
    expect(names("all")).toEqual([...STAFF_DAY.map((r) => r.employeeName)].sort((a, b) => a.localeCompare(b)));
    expect(names("present")).toEqual(["Asha Kumar", "Ravi Nair"]);
    expect(names("all", "103")).toEqual(["Meena Raj"]);
    expect(names("all", "  KUMAR ")).toEqual(["Asha Kumar"]);
    expect(names("all", "", "Stores")).toEqual(["Ravi Nair"]);
    expect(names("present", "", "Cutting")).toEqual(["Asha Kumar"]);
  });

  it("lists the departments once, in order", () => {
    expect(departmentsOf(STAFF_DAY)).toEqual(["Cutting", "Stores"]);
  });
});

describe("the arrival curve", () => {
  it("counts first punches per half hour and how many were in by then", () => {
    const rows = [
      row("1", "A", { firstPunch: "08:10" }),
      row("2", "B", { firstPunch: "08:29" }),
      row("3", "C", { firstPunch: "08:31" }),
      row("4", "D", { firstPunch: "09:45" }),
      row("5", "E"),
    ];
    const curve = arrivalCurve(rows);
    expect(curve[0]).toEqual({ slot: "07:30", label: "07:30-08:00", arrived: 0, inBy: 0 });
    const at = (slot: string) => curve.find((s) => s.slot === slot)!;
    expect(at("08:00")).toMatchObject({ arrived: 2, inBy: 2 });
    expect(at("08:30")).toMatchObject({ arrived: 1, inBy: 3 });
    expect(at("09:30")).toMatchObject({ arrived: 1, inBy: 4 });
    expect(curve.length).toBeGreaterThanOrEqual(8); // four hours at least
    expect(curve[curve.length - 1].inBy).toBe(4);
    // "half in by": the time by which half of the arrivals (2 of 4) had punched
    expect(arrivalStats(rows)).toEqual({ first: "08:10", median: "08:29", last: "09:45" });
  });

  it("is empty when nobody punched", () => {
    expect(arrivalCurve([ABSENT])).toEqual([]);
    expect(arrivalStats([ABSENT])).toEqual({ first: "", median: "", last: "" });
  });
});

describe("punches", () => {
  it("knows each source, and the ones the day is not counted on", () => {
    expect(PRESENT.punches!.map((p) => punchKind(p))).toEqual(["biometric", "geo", "hr_entry", "missing_punch"]);
    expect(ON_DUTY.punches!.map((p) => punchKind(p))).toEqual(["on_duty", "held"]);
    expect(NIGHT.punches!.map((p) => punchKind(p))).toEqual(["uncounted", "biometric", "biometric"]);
    expect(punchKind(punch("09:00:00", "IN", "on_duty:rejected", { verification: "rejected", counted: false }))).toBe(
      "rejected",
    );
    expect(punchKind(punch("09:00:00", "IN", "auto:md"))).toBe("auto");
  });

  it("says what a punch is in words, with its real date", () => {
    expect(shortDate("2026-11-05")).toBe("5 Nov");
    const [previous, , closing] = NIGHT.punches!;
    expect(punchTitle(closing, DAY)).toBe("Out 05:30:00 on 5 Nov, Biometric. Closes this shift after midnight.");
    expect(punchTitle(previous, DAY)).toContain("Closes the previous day's night shift");
    expect(punchTitle(ON_DUTY.punches![1], DAY)).toContain("Waiting for HR to verify; not counted yet.");
    expect(punchText(closing, DAY)).toBe("OUT 05:30 5 Nov (Biometric)");
    expect(punchText(ON_DUTY.punches![1], DAY)).toBe("OUT 12:40 (On-Duty (awaiting HR), waiting for HR)");
  });
});

describe("leave facts", () => {
  it("names the request and where it stands", () => {
    expect(leaveFacts(PENDING_LEAVE)).toEqual(["Sick leave, waiting for approval"]);
    expect(leaveFacts(ON_LEAVE)).toEqual(["Earned leave"]);
    expect(leaveFacts(CL)).toEqual(["Casual leave"]);
    expect(leaveFacts(ON_DUTY)).toEqual(["On-Duty: On-Duty approved; punches await HR (Erode)"]);
    expect(
      leaveFacts(
        row("9", "X", {
          leave: {
            status: "approved",
            type: "casual",
            isHalfDay: true,
            halfDaySlot: "morning",
            startDate: DAY,
            endDate: DAY,
          },
          casualLeave: { status: "pending", portion: "second_half" },
        }),
      ),
    ).toEqual(["Casual leave, second half, waiting for approval", "Casual leave, half day (morning)"]);
    expect(leaveFacts(MANUAL)).toEqual([]);
  });
});
