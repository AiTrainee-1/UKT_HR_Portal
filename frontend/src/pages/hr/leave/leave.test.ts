import { describe, expect, it } from "vitest";
import { isMutatingControl } from "@/lib/view-only-lock";
import {
  NO_BALANCE_FILTERS,
  NO_HOLIDAY_FILTERS,
  NO_LEAVE_FILTERS,
  NO_PERMISSION_FILTERS,
  addDays,
  awayPeople,
  balanceExportRows,
  balanceFlag,
  branchOptions,
  dateOnly,
  daysBetween,
  decidedByLine,
  departmentOptions,
  entriesByDay,
  entryFromCasual,
  entryFromLeave,
  fallsOnSunday,
  filterBalances,
  filterHolidays,
  filterLeaves,
  filterPermissions,
  groupHolidaysByMonth,
  heatLevel,
  holidaysByDay,
  isoDate,
  joinBalances,
  leaveDays,
  leaveExportRows,
  leaveFiltersActive,
  leaveTypesOf,
  longDate,
  matchesQuery,
  monthGrid,
  nextHoliday,
  overlapsRange,
  relativeDays,
  shiftMonth,
  shortDate,
  sortLeaves,
  summarizeBalances,
  summarizeCalendar,
  summarizeHolidays,
  summarizeLeaves,
  usedPercent,
  weekdayIndex,
  type CalendarEntry,
  type HolidayRow,
  type LeaveBalanceRow,
  type LeaveRow,
  type PermissionRow,
  type PersonFields,
} from "./logic";

const leave = (over: Partial<LeaveRow> & { id: number }): LeaveRow => ({
  employeeId: over.id * 10,
  employeeName: `Person ${over.id}`,
  employeeCode: `E${over.id}`,
  department: "Cutting",
  departmentId: 1,
  branchId: 1,
  branch: "Head Office",
  employmentType: "staff",
  type: "sick",
  startDate: "2026-10-05",
  endDate: "2026-10-05",
  status: "pending",
  createdAt: `2026-10-0${over.id}T09:00:00Z`,
  ...over,
});

const rows: LeaveRow[] = [
  leave({
    id: 1,
    employeeName: "Asha Kumar",
    type: "sick",
    startDate: "2026-10-05",
    endDate: "2026-10-07",
    status: "approved",
  }),
  leave({
    id: 2,
    employeeName: "Ravi Shankar",
    type: "casual",
    startDate: "2026-10-12",
    endDate: "2026-10-12",
    status: "pending",
    department: "Stitching",
    departmentId: 2,
  }),
  leave({
    id: 3,
    employeeName: "Meena Iyer",
    type: "annual",
    startDate: "2026-09-28",
    endDate: "2026-10-02",
    status: "rejected",
    branch: "Unit 2",
    branchId: 2,
    employmentType: "production",
  }),
  leave({
    id: 4,
    employeeName: "Suresh Raj",
    type: "sick",
    startDate: "2026-10-12",
    endDate: "2026-10-12",
    status: "pending",
    isHalfDay: true,
    halfDaySlot: "afternoon",
    totalDays: 0.5,
  }),
];

describe("dates", () => {
  it("reads a date out of a timestamp and refuses anything else", () => {
    expect(dateOnly("2026-10-05T10:00:00Z")).toBe("2026-10-05");
    expect(dateOnly("2026-10-05")).toBe("2026-10-05");
    expect(dateOnly("05/10/2026")).toBeNull();
    expect(dateOnly("")).toBeNull();
    expect(dateOnly(null)).toBeNull();
  });

  it("counts and adds days across month and year ends without the browser's timezone", () => {
    expect(daysBetween("2026-10-05", "2026-10-07")).toBe(2);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("knows the weekday, Monday first", () => {
    expect(weekdayIndex("2026-10-05")).toBe(0); // a Monday
    expect(weekdayIndex("2026-10-11")).toBe(6); // a Sunday
  });

  it("moves between months over a year end", () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 10, 0)).toEqual({ year: 2026, month: 10 });
  });

  it("words dates", () => {
    expect(longDate("2026-10-05")).toBe("Mon, 5 Oct 2026");
    expect(longDate(null)).toBe("-");
    expect(shortDate("2026-10-05", 2026)).toBe("5 Oct");
    expect(shortDate("2025-10-05", 2026)).toBe("5 Oct 2025");
    expect(shortDate("junk")).toBe("-");
  });
});

describe("search", () => {
  it("needs every word, in any order and any field", () => {
    expect(matchesQuery("asha cutting", "Asha Kumar", "E1", "Cutting")).toBe(true);
    expect(matchesQuery("cutting asha", "Asha Kumar", "E1", "Cutting")).toBe(true);
    expect(matchesQuery("asha stitching", "Asha Kumar", "E1", "Cutting")).toBe(false);
    expect(matchesQuery("  ", "anything")).toBe(true);
    expect(matchesQuery("e1", "Asha", null, undefined, "E1")).toBe(true);
  });
});

describe("leave requests", () => {
  it("filters by status, type, department, branch and employee type, together", () => {
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, status: "pending" }).map((l) => l.id)).toEqual([2, 4]);
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, type: "sick" }).map((l) => l.id)).toEqual([1, 4]);
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, department: "2" }).map((l) => l.id)).toEqual([2]);
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, branch: "2" }).map((l) => l.id)).toEqual([3]);
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, employeeType: "production" }).map((l) => l.id)).toEqual([3]);
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, status: "pending", type: "sick" }).map((l) => l.id)).toEqual([4]);
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, query: "ravi stitching" }).map((l) => l.id)).toEqual([2]);
  });

  it("a date range keeps any leave that touches it", () => {
    // 6 Oct falls inside Asha's 5-7 Oct leave
    expect(overlapsRange("2026-10-05", "2026-10-07", "2026-10-06", "2026-10-06")).toBe(true);
    expect(overlapsRange("2026-10-05", "2026-10-07", "2026-10-08", "")).toBe(false);
    expect(overlapsRange("2026-10-05", "2026-10-07", "", "2026-10-04")).toBe(false);
    expect(overlapsRange("2026-10-05", "2026-10-07", "2026-10-07", "2026-10-07")).toBe(true); // the last day counts
    expect(overlapsRange("2026-10-05", "2026-10-07", "", "")).toBe(true);
    expect(filterLeaves(rows, { ...NO_LEAVE_FILTERS, from: "2026-10-02", to: "2026-10-06" }).map((l) => l.id)).toEqual([
      1, 3,
    ]);
  });

  it("knows when a filter is on", () => {
    expect(leaveFiltersActive(NO_LEAVE_FILTERS)).toBe(false);
    expect(leaveFiltersActive({ ...NO_LEAVE_FILTERS, query: " x " })).toBe(true);
    expect(leaveFiltersActive({ ...NO_LEAVE_FILTERS, from: "2026-10-01" })).toBe(true);
    expect(leaveFiltersActive({ ...NO_LEAVE_FILTERS, employeeType: "staff" })).toBe(true);
  });

  it("counts the days a request covers", () => {
    expect(leaveDays(rows[0])).toBe(3);
    expect(leaveDays(rows[1])).toBe(1);
    expect(leaveDays(rows[3])).toBe(0.5);
    expect(leaveDays({ startDate: "2026-10-05", endDate: "2026-10-07", totalDays: 2 })).toBe(2); // the server's count wins
    expect(leaveDays({ startDate: "junk", endDate: "junk" })).toBe(1);
  });

  it("lists what needs a decision first, longest-waiting first, then the newest leave", () => {
    expect(sortLeaves(rows).map((l) => l.id)).toEqual([2, 4, 1, 3]);
    // the input is not changed
    expect(rows.map((l) => l.id)).toEqual([1, 2, 3, 4]);
  });

  it("summarises, and counts who is away today once", () => {
    const s = summarizeLeaves(rows, "2026-10-06");
    expect(s).toMatchObject({ total: 4, pending: 2, approved: 1, rejected: 1, approvedDays: 3, onLeaveToday: 1 });
    expect(summarizeLeaves(rows, "2026-10-20").onLeaveToday).toBe(0);
    // two approved requests for one person on one day are one person
    const twice = [rows[0], { ...rows[0], id: 9 }];
    expect(summarizeLeaves(twice, "2026-10-06").onLeaveToday).toBe(1);
  });

  it("lists the leave types that occur", () => {
    expect(leaveTypesOf(rows)).toEqual(["annual", "casual", "sick"]);
  });

  it("offers only the branches and departments that occur", () => {
    expect(branchOptions(rows)).toEqual([
      { value: "1", label: "Head Office" },
      { value: "2", label: "Unit 2" },
    ]);
    expect(departmentOptions(rows)).toEqual([
      { value: "1", label: "Cutting" },
      { value: "2", label: "Stitching" },
    ]);
    // an older backend sends no ids: nothing to filter on, nothing offered
    expect(branchOptions([{ employeeId: 1, employeeName: "A" }])).toEqual([]);
  });

  it("says who decided", () => {
    expect(decidedByLine({ status: "approved", approvedBy: "Meena", approverRole: "hr" })).toBe(
      "Approved by Meena (HR)",
    );
    expect(decidedByLine({ status: "rejected", approvedBy: "Suresh", approverRole: "dept_head" }, true)).toBe(
      "Rejected by Suresh (Department Head)",
    );
    expect(decidedByLine({ status: "pending", approvedBy: null, approverRole: null })).toBeNull();
  });

  it("exports what is shown, one row per request", () => {
    const out = leaveExportRows([rows[3], rows[0]]);
    expect(out[0]).toEqual([
      "E4",
      "Suresh Raj",
      "Head Office",
      "Cutting",
      "Half day (afternoon)",
      "2026-10-12",
      "2026-10-12",
      0.5,
      "pending",
      "",
      "",
    ]);
    expect(out[1][4]).toBe("sick");
    expect(out[1][7]).toBe(3);
  });
});

describe("permissions", () => {
  const perms: PermissionRow[] = [
    {
      id: 1,
      employeeId: 1,
      employeeName: "Asha Kumar",
      date: "2026-10-05",
      status: "pending",
      typeKey: "morning_late_in",
      branchId: 1,
      departmentId: 1,
    },
    {
      id: 2,
      employeeId: 2,
      employeeName: "Ravi Shankar",
      date: "2026-10-06",
      status: "approved",
      capStatus: "excess",
      typeKey: "evening_early_out",
      branchId: 2,
      departmentId: 2,
    },
    {
      id: 3,
      employeeId: 3,
      employeeName: "Meena Iyer",
      date: "2026-10-07",
      status: "approved",
      capStatus: "within_cap",
      typeKey: null,
    },
    {
      id: 4,
      employeeId: 4,
      employeeName: "Suresh Raj",
      date: "2026-10-08",
      status: "rejected",
      typeKey: "middle_permission",
    },
  ];
  const ids = (f: Partial<typeof NO_PERMISSION_FILTERS>) =>
    filterPermissions(perms, { ...NO_PERMISSION_FILTERS, ...f }).map((p) => p.id);

  it("treats Overdue / Excess as approved beyond the cap, and Approved as every approved one", () => {
    expect(ids({ status: "excess" })).toEqual([2]);
    expect(ids({ status: "approved" })).toEqual([2, 3]);
    expect(ids({ status: "rejected" })).toEqual([4]);
  });

  it("filters by type, including the ones with none", () => {
    expect(ids({ type: "morning_late_in" })).toEqual([1]);
    expect(ids({ type: "none" })).toEqual([3]);
  });

  it("filters by date range, branch and search", () => {
    expect(ids({ from: "2026-10-06", to: "2026-10-07" })).toEqual([2, 3]);
    expect(ids({ branch: "2" })).toEqual([2]);
    expect(ids({ query: "meena" })).toEqual([3]);
  });
});

describe("the who-is-on-leave calendar", () => {
  const entries = [
    entryFromLeave(rows[0]), // Asha 5-7 Oct, approved
    entryFromLeave(rows[1]), // Ravi 12 Oct, pending
    entryFromLeave(rows[2]), // Meena, rejected: not leave
    entryFromLeave(rows[3]), // Suresh half day 12 Oct, pending
    entryFromCasual({ id: 7, employeeId: 10, employeeName: "Asha Kumar", date: "2026-10-06", status: "approved" }),
  ].filter((e): e is CalendarEntry => e !== null);

  it("turns a request into entries, dropping one with no usable date", () => {
    expect(entryFromLeave({ ...rows[0], startDate: "junk" })).toBeNull();
    expect(entryFromCasual({ id: 1, employeeId: 1, date: "", status: "approved" })).toBeNull();
    expect(entries[3].kind).toBe("half");
    expect(entries[3].label).toBe("Half day (afternoon)");
    expect(entries[0].label).toBe("Sick");
    expect(entries[4].kind).toBe("casual");
  });

  it("puts a leave on every day it covers, and leaves a rejected request off", () => {
    const byDay = entriesByDay(entries, 2026, 10);
    expect([...byDay.keys()].sort()).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-12"]);
    expect(byDay.get("2026-10-12")?.map((e) => e.employeeName)).toEqual(["Ravi Shankar", "Suresh Raj"]);
    expect(byDay.has("2026-10-02")).toBe(false); // Meena's rejected annual leave
  });

  it("counts one person once a day, the approved request winning", () => {
    // Asha has leave and a CL on 6 Oct, both approved: one entry, her one person
    const day = entriesByDay(entries, 2026, 10).get("2026-10-06") ?? [];
    expect(day).toHaveLength(1);
    const mixed = entriesByDay(
      [
        { ...entries[1], employeeId: 50, status: "pending", key: "a" },
        { ...entries[1], employeeId: 50, status: "approved", key: "b" },
      ],
      2026,
      10,
    );
    expect(mixed.get("2026-10-12")?.map((e) => e.status)).toEqual(["approved"]);
  });

  it("clips a leave that crosses a month end to the month", () => {
    const long = entryFromLeave(
      leave({ id: 5, startDate: "2026-09-29", endDate: "2026-10-02", status: "approved" }),
    ) as CalendarEntry;
    const oct = entriesByDay([long], 2026, 10);
    expect([...oct.keys()].sort()).toEqual(["2026-10-01", "2026-10-02"]);
    const sep = entriesByDay([long], 2026, 9);
    expect([...sep.keys()].sort()).toEqual(["2026-09-29", "2026-09-30"]);
    expect(entriesByDay([long], 2026, 11).size).toBe(0);
  });

  it("draws the month as whole weeks starting on Monday", () => {
    const grid = monthGrid(2026, 10); // 1 Oct 2026 is a Thursday
    expect(grid.every((w) => w.length === 7)).toBe(true);
    expect(grid[0][0].iso).toBe("2026-09-28");
    expect(grid[0][0].inMonth).toBe(false);
    expect(grid[0][3]).toMatchObject({ iso: "2026-10-01", inMonth: true, day: 1 });
    expect(grid.at(-1)?.at(-1)?.iso).toBe("2026-11-01");
    expect(grid.flat().filter((c) => c.inMonth)).toHaveLength(31);
    // 1 Jun 2026 is a Monday and the month has 30 days: the last week is padded with five days of July
    expect(
      monthGrid(2026, 6)
        .flat()
        .filter((c) => !c.inMonth),
    ).toHaveLength(5);
    expect(monthGrid(2027, 2)).toHaveLength(4); // 1 Feb 2027 is a Monday, 28 days
  });

  it("shades a day by how busy it is next to the busiest day", () => {
    expect(heatLevel(0, 5)).toBe(0);
    expect(heatLevel(1, 0)).toBe(0);
    expect(heatLevel(1, 8)).toBe(1);
    expect(heatLevel(3, 8)).toBe(2);
    expect(heatLevel(5, 8)).toBe(3);
    expect(heatLevel(8, 8)).toBe(4);
  });

  it("summarises the month and lists who is away, most days first", () => {
    const byDay = entriesByDay(entries, 2026, 10);
    expect(summarizeCalendar(byDay)).toEqual({ people: 3, personDays: 5, busiest: { iso: "2026-10-12", count: 2 } });
    const people = awayPeople(byDay);
    expect(people[0]).toMatchObject({ name: "Asha Kumar", days: 3 });
    expect(people.map((p) => p.name)).toEqual(["Asha Kumar", "Ravi Shankar", "Suresh Raj"]);
    expect(summarizeCalendar(new Map())).toEqual({ people: 0, personDays: 0, busiest: null });
  });
});

describe("holidays", () => {
  const hol = (id: number, date: string, over: Partial<HolidayRow> = {}): HolidayRow => ({
    id,
    name: `Holiday ${id}`,
    date,
    holidayType: "national",
    isRecurring: false,
    ...over,
  });
  const holidays = [
    hol(1, "2026-10-20", { name: "Deepavali", holidayType: "regional", branchId: 2, branchName: "Unit 2" }),
    hol(2, "2026-01-14", { name: "Pongal", isRecurring: true }),
    hol(3, "2026-10-11", { name: "Founders Day", holidayType: "company" }), // a Sunday
    hol(4, "2026-12-25", { name: "Christmas" }),
  ];

  it("filters by type, month, branch and search", () => {
    const ids = (f: Partial<typeof NO_HOLIDAY_FILTERS>) =>
      filterHolidays(holidays, { ...NO_HOLIDAY_FILTERS, ...f }).map((h) => h.id);
    expect(ids({})).toEqual([2, 3, 1, 4]); // in date order
    expect(ids({ type: "company" })).toEqual([3]);
    expect(ids({ month: "10" })).toEqual([3, 1]);
    expect(ids({ branch: "2" })).toEqual([1]);
    expect(ids({ branch: "none" })).toEqual([2, 3, 4]); // every-branch holidays
    expect(ids({ query: "pong" })).toEqual([2]);
  });

  it("groups by month in calendar order", () => {
    expect(
      groupHolidaysByMonth(filterHolidays(holidays, NO_HOLIDAY_FILTERS)).map((g) => [g.month, g.rows.length]),
    ).toEqual([
      [1, 1],
      [10, 2],
      [12, 1],
    ]);
  });

  it("finds the next holiday and how far away it is", () => {
    expect(nextHoliday(holidays, "2026-10-05")).toMatchObject({ holiday: { id: 3 }, inDays: 6 });
    expect(nextHoliday(holidays, "2026-10-11")).toMatchObject({ holiday: { id: 3 }, inDays: 0 }); // today counts
    expect(nextHoliday(holidays, "2026-12-26")).toBeNull();
    expect(relativeDays(0)).toBe("Today");
    expect(relativeDays(1)).toBe("Tomorrow");
    expect(relativeDays(12)).toBe("In 12 days");
    expect(relativeDays(-3)).toBe("3 days ago");
  });

  it("notes a holiday that falls on a Sunday and counts the types", () => {
    expect(fallsOnSunday(holidays[2])).toBe(true);
    expect(fallsOnSunday(holidays[0])).toBe(false);
    expect(summarizeHolidays(holidays)).toEqual({ total: 4, national: 2, regional: 1, company: 1, onSunday: 1 });
  });

  it("maps the holidays of a month to their days", () => {
    const oct = holidaysByDay(holidays, 2026, 10);
    expect([...oct.keys()]).toEqual(["2026-10-20", "2026-10-11"]);
    expect(holidaysByDay(holidays, 2026, 2).size).toBe(0);
    expect(isoDate(2026, 3, 4)).toBe("2026-03-04");
  });
});

describe("balances", () => {
  const bal = (id: number, over: Partial<LeaveBalanceRow>): LeaveBalanceRow => ({
    id,
    employeeId: id,
    leaveTypeId: 1,
    leaveTypeName: "Casual",
    year: 2026,
    allocated: 12,
    used: 0,
    remaining: 12,
    carriedForward: 0,
    ...over,
  });
  const people = new Map<number, PersonFields>([
    [
      1,
      {
        employeeId: 1,
        employeeName: "Asha Kumar",
        employeeCode: "E1",
        branchId: 1,
        branch: "Head Office",
        departmentId: 1,
        department: "Cutting",
        employmentType: "staff",
      },
    ],
    [
      2,
      {
        employeeId: 2,
        employeeName: "Ravi Shankar",
        employeeCode: "E2",
        branchId: 2,
        branch: "Unit 2",
        departmentId: 2,
        department: "Stitching",
        employmentType: "production",
      },
    ],
    [
      3,
      {
        employeeId: 3,
        employeeName: "Meena Iyer",
        employeeCode: "E3",
        branchId: 1,
        branch: "Head Office",
        departmentId: 1,
        department: "Cutting",
        employmentType: "staff",
      },
    ],
  ]);
  const balances = [
    bal(1, { used: 4, remaining: 8 }), // fine
    bal(2, { used: 10, remaining: 2 }), // 2 of 12 left: under a fifth
    bal(3, { used: 12, remaining: 0 }), // exhausted
    bal(4, { employeeId: 99 }), // not in the list (inactive)
    bal(5, { employeeId: 1, leaveTypeId: 2, leaveTypeName: "Sick", allocated: 0, remaining: 0 }), // nothing allocated
  ];

  it("flags low and exhausted balances", () => {
    expect(balanceFlag({ allocated: 12, carriedForward: 0, remaining: 8 })).toBe("ok");
    expect(balanceFlag({ allocated: 12, carriedForward: 0, remaining: 2.4 })).toBe("low"); // exactly a fifth
    expect(balanceFlag({ allocated: 12, carriedForward: 0, remaining: 3 })).toBe("ok");
    expect(balanceFlag({ allocated: 12, carriedForward: 0, remaining: 1 })).toBe("low");
    expect(balanceFlag({ allocated: 12, carriedForward: 0, remaining: 0 })).toBe("exhausted");
    expect(balanceFlag({ allocated: 2, carriedForward: 0, remaining: 1 })).toBe("low"); // the last day of a small allotment
    expect(balanceFlag({ allocated: 0, carriedForward: 0, remaining: 0 })).toBe("ok"); // nothing to run out of
    expect(balanceFlag({ allocated: 5, carriedForward: 5, remaining: 3 })).toBe("ok"); // carried days count
    expect(balanceFlag({ allocated: 5, carriedForward: 5, remaining: 2 })).toBe("low");
  });

  it("measures how much is used", () => {
    expect(usedPercent({ allocated: 12, carriedForward: 0, used: 3 })).toBe(25);
    expect(usedPercent({ allocated: 10, carriedForward: 2, used: 12 })).toBe(100);
    expect(usedPercent({ allocated: 10, carriedForward: 0, used: 15 })).toBe(100); // never past the end of the bar
    expect(usedPercent({ allocated: 0, carriedForward: 0, used: 0 })).toBe(0);
  });

  it("joins balances to employees and drops those whose employee is not listed", () => {
    const view = joinBalances(balances, people);
    expect(view.map((b) => b.id)).toEqual([1, 2, 3, 5]);
    expect(view.find((b) => b.id === 3)).toMatchObject({ employeeName: "Meena Iyer", flag: "exhausted" });
  });

  it("filters by person, type and flag, and sorts by employee then type", () => {
    const view = joinBalances(balances, people);
    const ids = (f: Partial<typeof NO_BALANCE_FILTERS>) =>
      filterBalances(view, { ...NO_BALANCE_FILTERS, ...f }).map((b) => b.id);
    expect(ids({})).toEqual([1, 5, 3, 2]); // Asha (Casual, Sick), Meena, Ravi
    expect(ids({ flag: "low" })).toEqual([3, 2]); // low or exhausted
    expect(ids({ flag: "exhausted" })).toEqual([3]);
    expect(ids({ leaveType: "2" })).toEqual([5]);
    expect(ids({ branch: "2" })).toEqual([2]);
    expect(ids({ employeeType: "production" })).toEqual([2]);
    expect(ids({ query: "head office" })).toEqual([1, 5, 3]);
  });

  it("summarises and exports", () => {
    const view = joinBalances(balances, people);
    expect(summarizeBalances(view)).toEqual({ rows: 4, people: 3, low: 1, exhausted: 1, daysLeft: 10 });
    expect(balanceExportRows([view[2]])[0]).toEqual([
      "E3",
      "Meena Iyer",
      "Head Office",
      "Cutting",
      "Casual",
      2026,
      12,
      0,
      12,
      0,
      "Exhausted",
    ]);
  });
});

describe("View Only (the MD's copy of this page)", () => {
  const button = (label: string, attrs: Record<string, string> = {}) => {
    const b = document.createElement("button");
    b.textContent = label;
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    return b;
  };

  it("locks every control that changes something", () => {
    for (const label of [
      "Approve",
      "Reject",
      "Add Permission",
      "Add Holiday",
      "Add Leave Type",
      "Add Allocation",
      "Save Holiday",
      "Save type",
    ]) {
      expect(isMutatingControl(button(label)), label).toBe(true);
    }
    expect(isMutatingControl(button("", { "aria-label": "Edit Pongal" }))).toBe(true);
    expect(isMutatingControl(button("", { "aria-label": "Delete Pongal" }))).toBe(true);
    expect(isMutatingControl(button("", { "aria-label": "Edit Asha Kumar's Casual allocation" }))).toBe(true);
    expect(isMutatingControl(button("Set type & approve"))).toBe(true);
  });

  it("leaves browsing alone: tabs, filters, months, the calendar, the stat cards", () => {
    for (const label of [
      "Leave Requests",
      "Calendar",
      "Balances",
      "Clear filters",
      "Show more (12 left)",
      "This month",
      "Retry",
      "Year view",
      "Waiting for a decision 3 Oldest first in the list",
      "Approved 2 7 days of leave",
      "Overdue / Excess 1 approved beyond the cap",
      "Low balance 2 a fifth or less left",
    ]) {
      expect(isMutatingControl(button(label)), label).toBe(false);
    }
    for (const aria of [
      "Previous month",
      "Next month",
      "Previous year",
      "Clear search",
      "Mon, 5 Oct 2026: 3 on leave, holiday",
    ]) {
      expect(isMutatingControl(button("", { "aria-label": aria })), aria).toBe(false);
    }
  });

  it("an Export button is a read, so it carries the opt-out and stays usable", () => {
    const wrapper = document.createElement("div");
    const b = button("Export", { "data-view-safe": "true" });
    wrapper.appendChild(b);
    expect(isMutatingControl(button("Export"))).toBe(true); // without the opt-out the word locks it
    expect(isMutatingControl(b)).toBe(false);
  });
});
