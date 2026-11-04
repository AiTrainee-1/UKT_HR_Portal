import { describe, expect, it } from "vitest";
import type { CasualLeaveBalance } from "@/lib/api-client/custom-hooks";
import { NO_CL_FILTERS, type BoardRow } from "./logic";
import {
  assignLabel,
  assignedText,
  balanceSegments,
  calendarWeeks,
  carryCounts,
  carryExportRows,
  carryRows,
  chipDate,
  datesText,
  daysWord,
  filterCarry,
  filterLog,
  logExportRows,
  parseLimit,
  pickLines,
  pickedText,
  pickerMonth,
  reasonError,
  togglePick,
  type CalendarDay,
  type CarryRow,
  type ClAdjustment,
  type DetectedDay,
} from "./carry-forward";

// Carry Forward (owner 2026-11-04): the balance stays a fixed 12; HR turns an employee's absent / on-leave days into Casual
// Leave by entering the most days and picking that many detected dates or fewer. The server decides; these check the
// page words it and keeps the picks inside the number.

const bal = (over: Partial<CasualLeaveBalance> = {}): CasualLeaveBalance => ({
  total: 12,
  used: 0,
  pending: 0,
  remaining: 12,
  year: 2026,
  since: "2026-11-02",
  endsOn: "2026-12-31",
  cutOver: "2026-11-02",
  tracked: true,
  ...over,
});

const row = (id: number, name: string, balance: CasualLeaveBalance | null, over: Partial<BoardRow> = {}): BoardRow => ({
  employeeId: id,
  employeeName: name,
  employeeCode: `E${id}`,
  department: "Cutting",
  departmentId: 1,
  branch: "Head Office",
  branchId: 1,
  employmentType: "staff",
  serviceMonths: 24,
  eligible: true,
  usedThisMonth: false,
  balance,
  ...over,
});

const asha = row(1, "Asha Kumar", bal({ used: 1, pending: 1, remaining: 10 })) as CarryRow;
const ravi = row(2, "Ravi Shankar", bal()) as CarryRow;
const meena = row(3, "Meena Iyer", bal({ used: 12, remaining: 0 })) as CarryRow;

const detected: DetectedDay[] = [
  { date: "2026-10-06", weekday: "Tue", status: "absent", label: "Absent" },
  { date: "2026-10-07", weekday: "Wed", status: "absent", label: "Absent" },
  { date: "2026-10-14", weekday: "Wed", status: "on_leave", label: "On Leave · Sick Leave" },
];

describe("who is on the Carry Forward list", () => {
  it("lists the staff with a balance for the year, not production or a year without one", () => {
    const board = [
      asha,
      ravi,
      row(4, "Bala", null, { employmentType: "production" }),
      row(5, "Old", bal({ tracked: false, since: null })),
    ];
    expect(carryRows(board).map((r) => r.employeeId)).toEqual([1, 2]);
  });

  it("splits them into CL left and none left, and searches", () => {
    const rows = [asha, ravi, meena];
    expect(carryCounts(rows)).toEqual({ all: 3, left: 2, "none-left": 1 });
    expect(filterCarry(rows, NO_CL_FILTERS, "none-left").map((r) => r.employeeId)).toEqual([3]);
    expect(filterCarry(rows, { ...NO_CL_FILTERS, query: "ravi" }).map((r) => r.employeeId)).toEqual([2]);
  });
});

describe("the most days, and picking", () => {
  it("takes a whole number of days from 1 to 31", () => {
    expect(parseLimit("3")).toEqual({ limit: 3, error: null });
    expect(parseLimit("")).toEqual({ limit: null, error: null });
    expect(parseLimit("1.5").error).toBe("Whole days only, e.g. 3");
    expect(parseLimit("0").error).toBe("At least 1 day");
    expect(parseLimit("32").error).toBe("At most 31 days");
  });

  it("never picks past the number; unticking frees a place", () => {
    let picked: string[] = [];
    picked = togglePick(picked, "2026-10-06", 2);
    picked = togglePick(picked, "2026-10-07", 2);
    expect(togglePick(picked, "2026-10-14", 2)).toEqual(["2026-10-06", "2026-10-07"]);
    picked = togglePick(picked, "2026-10-06", 2);
    expect(togglePick(picked, "2026-10-14", 2)).toEqual(["2026-10-07", "2026-10-14"]);
    expect(togglePick([], "2026-10-06", null)).toEqual([]); // no number yet: nothing can be picked
    expect([pickedText(2, 3), pickedText(1, null)]).toEqual(["2 of 3 picked", "1 picked"]);
  });

  it("only the picked dates come off the balance, and each line says what it still needs", () => {
    const [line] = pickLines(
      [ravi],
      () => "3",
      () => detected,
      () => ["2026-10-07"],
      "October 2026",
    );
    expect([line.limit, line.before, line.after, line.error]).toEqual([3, 12, 11, null]);
    const numbers: Record<number, string> = { 1: "11", 2: "2", 3: "1" };
    const lines = pickLines(
      [asha, ravi, meena],
      (r) => numbers[r.employeeId],
      (r) => (r.employeeId === 2 ? [] : detected),
      () => [],
      "October 2026",
    );
    expect(lines.map((l) => l.error)).toEqual([
      "Only 10 days left: enter 10 at most",
      "No absent or leave days in October 2026",
      "No Casual Leave left",
    ]);
    expect(
      pickLines(
        [ravi],
        () => "2",
        () => detected,
        () => [],
        "October 2026",
      )[0].error,
    ).toBe("Pick at least one date");
    expect(
      pickLines(
        [ravi],
        () => "",
        () => detected,
        () => [],
        "October 2026",
      )[0].error,
    ).toBe("Enter the days");
  });

  it("asks for a reason of 3 to 300 characters", () => {
    expect(reasonError(" ok ")).toMatch(/^Write a reason/);
    expect(reasonError("Absent days covered")).toBeNull();
    expect(reasonError("x".repeat(301))).toBe("At most 300 characters");
  });

  it("opens the detection on the page's month when it is of this year and not still to come", () => {
    const today = { year: 2026, month: 11 };
    expect(pickerMonth(2026, 10, today)).toEqual({ year: 2026, month: 10 });
    expect(pickerMonth(2026, 12, today)).toEqual({ year: 2026, month: 11 });
    expect(pickerMonth(2025, 10, today)).toEqual({ year: 2026, month: 11 });
  });
});

describe("the 12 days and the calendar", () => {
  it("draws the fixed 12 as used, waiting, picked now and left", () => {
    const seg = balanceSegments(bal({ used: 1.5, pending: 1, remaining: 9.5 }), 2);
    expect(seg).toHaveLength(12);
    expect(seg[0]).toEqual([{ part: "used", share: 1 }]);
    expect(seg[1]).toEqual([
      { part: "used", share: 0.5 },
      { part: "pending", share: 0.5 },
    ]);
    expect(seg[2]).toEqual([
      { part: "pending", share: 0.5 },
      { part: "picked", share: 0.5 },
    ]);
    expect(seg[4]).toEqual([
      { part: "picked", share: 0.5 },
      { part: "left", share: 0.5 },
    ]);
    expect(seg[11]).toEqual([{ part: "left", share: 1 }]);
  });

  it("lays the month out Monday first, with blanks before the 1st", () => {
    const days: CalendarDay[] = Array.from({ length: 31 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      weekday: "",
      status: "present",
      selectable: false,
      label: "Present",
    }));
    const weeks = calendarWeeks(days);
    expect(weeks).toHaveLength(5); // 1 Oct 2026 is a Thursday
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]?.date).toBe("2026-10-01");
    expect(weeks[4].filter(Boolean)).toHaveLength(6); // 26 to 31
  });
});

describe("the words", () => {
  const a: ClAdjustment = {
    id: 9,
    employeeId: 2,
    employeeCode: "E2",
    employeeName: "Ravi Shankar",
    department: "Cutting",
    branch: "Head Office",
    year: 2026,
    days: -2,
    dates: ["2026-10-06", "2026-10-14"],
    reason: "Absent days covered",
    balanceBefore: 12,
    balanceAfter: 10,
    createdBy: "Meena",
    createdAt: "2026-11-20T10:00:00+05:30",
  };

  it("names the dates, the button and the toast", () => {
    expect(chipDate("2026-10-07", "Wed")).toBe("Wed 7 Oct");
    expect(datesText(["2026-10-07", "2026-10-13"])).toBe("07 Oct, 13 Oct");
    expect(daysWord(1)).toBe("1 day");
    const line = pickLines(
      [ravi],
      () => "3",
      () => detected,
      () => ["2026-10-06", "2026-10-07"],
      "October 2026",
    );
    expect(assignLabel(line)).toBe("Assign CL to 2 dates");
    expect(
      assignLabel(
        pickLines(
          [ravi],
          () => "3",
          () => detected,
          () => [],
          "October 2026",
        ),
      ),
    ).toBe("Pick the dates");
    expect(
      assignLabel(
        pickLines(
          [asha, ravi],
          () => "1",
          () => detected,
          () => [],
          "October 2026",
        ),
      ),
    ).toBe("Assign CL for 2 employees");
    expect(assignedText({ count: 1, days: 2, items: [a] })).toBe(
      "Ravi Shankar: 2 days (06 Oct, 14 Oct) now Casual Leave. 12 → 10 left.",
    );
    expect(assignedText({ count: 2, days: 3, items: [a, { ...a, id: 10 }] })).toBe(
      "3 days of 2 employees are now Casual Leave. Each is in the Change log.",
    );
  });

  it("searches the log and exports both lists", () => {
    expect(filterLog([a], "covered")).toHaveLength(1);
    expect(filterLog([a], "nothing like it")).toHaveLength(0);
    expect(logExportRows([a])[0].slice(1, 9)).toEqual([
      "E2",
      "Ravi Shankar",
      "Head Office",
      "Cutting",
      "06 Oct, 14 Oct",
      2,
      12,
      10,
    ]);
    expect(carryExportRows([asha])).toEqual([["E1", "Asha Kumar", "Head Office", "Cutting", 12, 1, 1, 10]]);
  });
});
