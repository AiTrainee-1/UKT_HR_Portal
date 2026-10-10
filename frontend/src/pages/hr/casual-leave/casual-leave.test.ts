import { describe, expect, it } from "vitest";
import { NO_PERSON_FILTERS } from "../leave/logic";
import {
  NO_CL_FILTERS,
  boardExportRows,
  becomesEligibleThisMonth,
  clFiltersActive,
  countByReason,
  defaultApplyDate,
  eligibleRows,
  filterBoard,
  filterRequests,
  inMonth,
  isCurrentMonth,
  monthBounds,
  monthTitle,
  notEligibleRows,
  requestExportRows,
  serviceText,
  sortRequests,
  summarize,
  takenRows,
  whyNot,
  type BoardRow,
  type ClRequest,
} from "./logic";

const row = (over: Partial<BoardRow> & { employeeId: number }): BoardRow => ({
  employeeName: `Person ${over.employeeId}`,
  employeeCode: `E${over.employeeId}`,
  department: "Cutting",
  departmentId: 1,
  branch: "Head Office",
  branchId: 1,
  employmentType: "staff",
  serviceMonths: 24,
  eligible: true,
  usedThisMonth: false,
  ...over,
});

const board: BoardRow[] = [
  row({ employeeId: 1, employeeName: "Asha Kumar" }),
  row({
    employeeId: 2,
    employeeName: "Ravi Shankar",
    serviceMonths: 31,
    lastClDate: "2026-09-12",
    approvedThisYear: 4,
  }),
  row({
    employeeId: 3,
    employeeName: "Meena Iyer",
    eligible: false,
    reasonCode: "used_this_month",
    usedThisMonth: true,
    usedStatus: "approved",
    usedDate: "2026-10-03",
  }),
  row({
    employeeId: 4,
    employeeName: "Suresh Raj",
    eligible: false,
    reasonCode: "under_service",
    serviceMonths: 5,
    eligibleFrom: "2026-10-20",
    branch: "Unit 2",
    branchId: 2,
    departmentId: 2,
    department: "Stitching",
  }),
  row({
    employeeId: 5,
    employeeName: "Anil Das",
    eligible: false,
    reasonCode: "under_service",
    serviceMonths: 2,
    eligibleFrom: "2027-01-05",
  }),
  row({ employeeId: 6, employeeName: "Lakshmi", eligible: false, reasonCode: "no_join_date", serviceMonths: null }),
  row({
    employeeId: 7,
    employeeName: "Bala",
    eligible: false,
    reasonCode: "not_staff",
    employmentType: "production",
    serviceMonths: 40,
  }),
  row({
    employeeId: 8,
    employeeName: "Chitra",
    eligible: false,
    reasonCode: "not_staff",
    employmentType: "production",
    serviceMonths: 3,
  }),
];

const request = (over: Partial<ClRequest> & { id: number }): ClRequest => ({
  employeeId: over.id * 10,
  employeeName: `Person ${over.id}`,
  employeeCode: `E${over.id}`,
  department: "Cutting",
  branch: "Head Office",
  date: "2026-10-05",
  status: "pending",
  createdAt: `2026-10-0${over.id}T09:00:00Z`,
  ...over,
});

const requests: ClRequest[] = [
  request({ id: 1, date: "2026-10-14", status: "approved", reviewedBy: "Meena", reviewerRole: "hr" }),
  request({ id: 2, date: "2026-10-09", status: "pending" }),
  request({ id: 3, date: "2026-10-02", status: "rejected" }),
  request({ id: 4, date: "2026-10-09", status: "pending", employeeName: "Anil Das" }),
  request({ id: 5, date: "2026-10-01", status: "approved", reviewedBy: "Suresh", reviewerRole: "dept_head" }),
];

describe("who cannot take Casual Leave, and why", () => {
  it("names a production employee as not eligible because of the kind of job", () => {
    const why = whyNot(board[6]);
    expect(why).toMatchObject({ code: "not_staff", title: "Production employee" });
    expect(why?.detail).toContain("only for staff");
  });

  it("tells someone under six months how far they are and the day they qualify", () => {
    const why = whyNot(board[3]);
    expect(why?.code).toBe("under_service");
    expect(why?.title).toBe("Under 6 months of service");
    expect(why?.detail).toBe("5 of 6 months completed. Becomes eligible on Tue, 20 Oct 2026.");
    // the same rule with the number the server says
    expect(whyNot(board[3], 3)?.title).toBe("Under 3 months of service");
  });

  it("says when and in what state the month's one CL was used", () => {
    expect(whyNot(board[2])?.detail).toBe("One Casual Leave a month: CL on 3 Oct 2026 is approved.");
    const pending = { ...board[2], usedStatus: "pending" };
    expect(whyNot(pending)?.detail).toBe(
      "One Casual Leave a month: CL on 3 Oct 2026 is requested, waiting for a decision.",
    );
  });

  it("asks HR to set a missing join date", () => {
    expect(whyNot(board[5])).toMatchObject({ code: "no_join_date", title: "Join date not set", tone: "danger" });
  });

  it("has no reason for someone who is eligible", () => {
    expect(whyNot(board[0])).toBeNull();
  });

  it("copes with an older backend that sends no reason code", () => {
    expect(whyNot({ ...board[2], reasonCode: null })?.code).toBe("used_this_month");
    expect(whyNot({ ...board[6], reasonCode: undefined })?.code).toBe("not_staff");
    const unknown = whyNot({
      ...board[4],
      reasonCode: undefined,
      usedThisMonth: false,
      employmentType: "staff",
      reason: "3/6 months of service",
    });
    expect(unknown?.title).toBe("3/6 months of service");
  });

  it("knows who qualifies later in the month shown", () => {
    expect(becomesEligibleThisMonth(board[3], "2026-10-01", "2026-10-31")).toBe(true);
    expect(becomesEligibleThisMonth(board[4], "2026-10-01", "2026-10-31")).toBe(false);
    expect(becomesEligibleThisMonth(board[0], "2026-10-01", "2026-10-31")).toBe(false);
  });
});

describe("the three groups", () => {
  it("lists the eligible by name", () => {
    expect(eligibleRows(board).map((r) => r.employeeName)).toEqual(["Asha Kumar", "Ravi Shankar"]);
  });

  it("lists the not eligible: used first, then soonest to qualify, then no join date, then production", () => {
    expect(notEligibleRows(board).map((r) => r.employeeId)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("counts why people are held back", () => {
    expect(countByReason(board)).toEqual({ not_staff: 2, no_join_date: 1, under_service: 2, used_this_month: 1 });
  });

  it("the three always add up to everyone on the board", () => {
    const s = summarize(board, requests);
    expect(s.eligible + s.notEligible).toBe(board.length);
    expect(Object.values(s.byReason).reduce((a, b) => a + b, 0)).toBe(s.notEligible);
    expect(s).toMatchObject({ eligible: 2, notEligible: 6, staff: 6, production: 2 });
  });

  it("taken counts approved only; pending and rejected are counted apart", () => {
    expect(summarize(board, requests)).toMatchObject({ taken: 2, pending: 2, rejected: 1 });
  });

  it("lists who took CL or is waiting for it by date, leaving a rejected request out", () => {
    expect(takenRows(requests).map((r) => r.id)).toEqual([5, 4, 2, 1]); // 1 Oct, 9 Oct (by name: Anil, then Person 2), 14 Oct
  });

  it("lists requests with the longest-waiting pending first, then the newest date", () => {
    expect(sortRequests(requests).map((r) => r.id)).toEqual([2, 4, 1, 3, 5]);
  });
});

describe("filters", () => {
  it("filters the board by branch, department, type and words", () => {
    const ids = (f: Partial<typeof NO_CL_FILTERS>) =>
      filterBoard(board, { ...NO_CL_FILTERS, ...f }).map((r) => r.employeeId);
    expect(ids({ branch: "2" })).toEqual([4]);
    expect(ids({ department: "2" })).toEqual([4]);
    expect(ids({ employeeType: "production" })).toEqual([7, 8]);
    expect(ids({ query: "head office production" })).toEqual([7, 8]);
    expect(ids({ query: "nobody" })).toEqual([]);
  });

  it("filters requests by status as well", () => {
    expect(filterRequests(requests, NO_CL_FILTERS, "pending").map((r) => r.id)).toEqual([2, 4]);
    expect(filterRequests(requests, NO_CL_FILTERS, "all")).toHaveLength(5);
    expect(filterRequests(requests, { ...NO_CL_FILTERS, query: "anil" }, "pending").map((r) => r.id)).toEqual([4]);
  });

  it("knows when something narrows the list", () => {
    expect(clFiltersActive(NO_CL_FILTERS)).toBe(false);
    expect(clFiltersActive(NO_CL_FILTERS, ["all", "all"])).toBe(false);
    expect(clFiltersActive(NO_CL_FILTERS, ["all", "pending"])).toBe(true);
    expect(clFiltersActive({ ...NO_PERSON_FILTERS, branch: "1" })).toBe(true);
  });
});

describe("months and the apply dialog", () => {
  it("knows the current month", () => {
    expect(isCurrentMonth(2026, 10, "2026-10-15")).toBe(true);
    expect(isCurrentMonth(2026, 9, "2026-10-15")).toBe(false);
    expect(isCurrentMonth(2025, 10, "2026-10-15")).toBe(false);
    expect(monthTitle(2026, 10)).toBe("October 2026");
  });

  it("opens the dialog on today, or on the 1st of another month", () => {
    expect(defaultApplyDate(2026, 10, "2026-10-15")).toBe("2026-10-15");
    expect(defaultApplyDate(2026, 11, "2026-10-15")).toBe("2026-11-01");
    expect(defaultApplyDate(2026, 9, "2026-10-15")).toBe("2026-09-01");
  });

  it("keeps the date to the month, month ends included", () => {
    expect(monthBounds(2026, 2)).toEqual({ first: "2026-02-01", last: "2026-02-28" });
    expect(monthBounds(2028, 2).last).toBe("2028-02-29");
    expect(inMonth("2026-10-31", 2026, 10)).toBe(true);
    expect(inMonth("2026-11-01", 2026, 10)).toBe(false);
    expect(inMonth("2026-09-30", 2026, 10)).toBe(false);
    expect(inMonth("", 2026, 10)).toBe(false);
  });
});

describe("wording and export", () => {
  it("words service length", () => {
    expect(serviceText(0)).toBe("0 mo");
    expect(serviceText(7)).toBe("7 mo");
    expect(serviceText(12)).toBe("1 yr");
    expect(serviceText(31)).toBe("2 yr 7 mo");
    expect(serviceText(null)).toBe("-");
  });

  it("exports the requests and the board as shown", () => {
    expect(requestExportRows([requests[0]])[0]).toEqual([
      "E1",
      "Person 1",
      "Head Office",
      "Cutting",
      "2026-10-14",
      "approved",
      "Meena",
      "",
      "",
    ]);
    const out = boardExportRows([board[3], board[0]]);
    expect(out[0].slice(0, 9)).toEqual([
      "E4",
      "Suresh Raj",
      "Unit 2",
      "Stitching",
      "staff",
      "",
      5,
      "No",
      expect.stringContaining("Under 6 months of service"),
    ]);
    expect(out[0][9]).toBe("2026-10-20");
    expect(out[1][7]).toBe("Yes");
    expect(out[1][8]).toBe("");
  });
});
