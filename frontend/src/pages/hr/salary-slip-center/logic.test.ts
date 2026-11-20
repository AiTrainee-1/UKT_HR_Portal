import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  SlipDownloadError,
  slipFileUrl,
  slipOptionsQuery,
  type SavedSlipSummary,
  type SlipCalendarDay,
  type SlipCenterEmployee,
} from "@/lib/api-client/custom-hooks/salary-slip-center";
import {
  ALL,
  EMPTY_RESULT,
  GENERATE_BATCH,
  NO_FILTERS,
  NO_SELECTION,
  SLIP_TABS,
  calendarTitle,
  calendarWeeks,
  changeCategory,
  chunk,
  departmentOptions,
  designationOptions,
  deselectRows,
  emptyInfo,
  errorText,
  fallbackFileName,
  fileLabel,
  filtersActive,
  filtersFromUrl,
  filtersToUrl,
  generateWording,
  hiddenSelected,
  holdSplit,
  idsWithSlips,
  isSlipTab,
  leftOutByReason,
  listSelection,
  matchesFilters,
  matchesTab,
  mergeResults,
  missingFromError,
  missingSlips,
  optionsText,
  paginate,
  resolvePeriod,
  salaryOf,
  sameOptions,
  selectRows,
  selectedEmployees,
  shiftMonth,
  summarize,
  tabCounts,
  toggleId,
  unitOptions,
  visibleRows,
  yearOptions,
  type SlipFilters,
} from "./logic";

const SLIP: SavedSlipSummary = {
  slipNumber: "SSL/30020/2026/11",
  generatedAt: "2026-11-20T10:42:11+05:30",
  generatedBy: "Admin",
  gross: 24000,
  deductions: 900,
  net: 23100,
  paidDays: 25.5,
  options: { statutory: true, lateDeductions: true, advances: true },
  countedTo: "2026-11-20",
};

let nextId = 1;
function emp(p: Partial<SlipCenterEmployee> = {}): SlipCenterEmployee {
  const id = p.id ?? nextId++;
  return {
    id,
    code: String(30000 + id),
    name: `EMPLOYEE ${id}`,
    category: "staff",
    status: "active",
    departmentId: 3,
    department: "ACCOUNTS",
    designationId: 5,
    designation: "ACCOUNTANT",
    branchId: 1,
    unit: "Head Office",
    joinDate: "2024-01-10",
    isNewJoiner: false,
    onHold: false,
    holdReason: "",
    heldAt: null,
    heldBy: null,
    monthlySalary: 25000,
    salaryPerShift: null,
    payIssue: null,
    bankAccountMasked: "XXXXXX1234",
    bankIssue: null,
    slip: null,
    ...p,
  };
}

const f = (p: Partial<SlipFilters> = {}): SlipFilters => ({ ...NO_FILTERS, ...p });

describe("the month", () => {
  const today = new Date(2026, 10, 20);

  it("reads the address, or opens the current month", () => {
    expect(resolvePeriod({ month: "3", year: "2025" }, today)).toEqual({ month: 3, year: 2025 });
    expect(resolvePeriod({}, today)).toEqual({ month: 11, year: 2026 });
    expect(resolvePeriod({ month: "13", year: "abc" }, today)).toEqual({ month: 11, year: 2026 });
    expect(resolvePeriod({ month: "0", year: "1999" }, today)).toEqual({ month: 11, year: 2026 });
  });

  it("steps a month back and forth across the year", () => {
    expect(shiftMonth({ month: 1, year: 2026 }, -1)).toEqual({ month: 12, year: 2025 });
    expect(shiftMonth({ month: 12, year: 2026 }, 1)).toEqual({ month: 1, year: 2027 });
    expect(shiftMonth({ month: 6, year: 2026 }, 0)).toEqual({ month: 6, year: 2026 });
  });

  it("offers the years around this one, and the picked one when it is outside", () => {
    expect(yearOptions(2026, 2026)).toEqual([2023, 2024, 2025, 2026, 2027]);
    expect(yearOptions(2026, 2019)).toEqual([2019, 2023, 2024, 2025, 2026, 2027]);
  });
});

describe("tabs", () => {
  const active = emp({ id: 101 });
  const heldActive = emp({ id: 102, onHold: true });
  const newJoiner = emp({ id: 103, isNewJoiner: true, joinDate: "2026-11-04" });
  const inactive = emp({ id: 104, status: "inactive" });
  const heldInactive = emp({ id: 105, status: "Inactive", onHold: true });
  const all = [active, heldActive, newJoiner, inactive, heldInactive];

  it("knows its tabs", () => {
    expect(SLIP_TABS).toEqual(["active", "on_hold", "new_joiners", "inactive", "all"]);
    expect(isSlipTab("on_hold")).toBe(true);
    expect(isSlipTab("held")).toBe(false);
  });

  it("overlap on purpose: a held active employee is in Active AND On Hold", () => {
    expect(matchesTab(heldActive, "active")).toBe(true);
    expect(matchesTab(heldActive, "on_hold")).toBe(true);
    expect(matchesTab(heldActive, "inactive")).toBe(false);
    // any status other than active is inactive, whatever its case
    expect(matchesTab(heldInactive, "inactive")).toBe(true);
    expect(matchesTab(newJoiner, "new_joiners")).toBe(true);
    expect(matchesTab(newJoiner, "active")).toBe(true);
  });

  it("counts every tab under the filters", () => {
    expect(tabCounts(all, NO_FILTERS)).toEqual({ active: 3, on_hold: 2, new_joiners: 1, inactive: 2, all: 5 });
    expect(tabCounts(all, f({ search: "102" }))).toEqual({
      active: 1,
      on_hold: 1,
      new_joiners: 0,
      inactive: 0,
      all: 1,
    });
  });

  it("lists the tab's rows that pass the filters, in the server's order", () => {
    expect(visibleRows(all, "on_hold", NO_FILTERS).map((e) => e.id)).toEqual([102, 105]);
    expect(visibleRows(all, "all", f({ status: "inactive" })).map((e) => e.id)).toEqual([104, 105]);
  });
});

describe("filters", () => {
  const staff = emp({ id: 201, name: "SURYA M", code: "30020", slip: SLIP });
  const prod = emp({
    id: 202,
    name: "ARUN K",
    code: "50011",
    category: "production",
    departmentId: 9,
    designationId: 11,
    branchId: 2,
    monthlySalary: null,
    salaryPerShift: 650,
  });

  it("searches name and code, any case, trimmed", () => {
    expect(matchesFilters(staff, f({ search: "  surya " }))).toBe(true);
    expect(matchesFilters(staff, f({ search: "3002" }))).toBe(true);
    expect(matchesFilters(prod, f({ search: "surya" }))).toBe(false);
  });

  it("filters by category, department, designation, unit, status and slip", () => {
    expect(matchesFilters(prod, f({ category: "production" }))).toBe(true);
    expect(matchesFilters(staff, f({ category: "production" }))).toBe(false);
    expect(matchesFilters(prod, f({ department: "9" }))).toBe(true);
    expect(matchesFilters(staff, f({ department: "9" }))).toBe(false);
    expect(matchesFilters(prod, f({ designation: "11" }))).toBe(true);
    expect(matchesFilters(staff, f({ unit: "2" }))).toBe(false);
    expect(matchesFilters(staff, f({ status: "active" }))).toBe(true);
    expect(matchesFilters(staff, f({ status: "inactive" }))).toBe(false);
    expect(matchesFilters(staff, f({ slip: "generated" }))).toBe(true);
    expect(matchesFilters(prod, f({ slip: "generated" }))).toBe(false);
    expect(matchesFilters(prod, f({ slip: "not_generated" }))).toBe(true);
  });

  it("round-trips through the address, unknown values falling back", () => {
    const url = { q: "arun", cat: "production", dept: "9", desig: ALL, unit: "2", status: "bogus", slip: "generated" };
    expect(filtersFromUrl(url)).toEqual({
      search: "arun",
      category: "production",
      department: "9",
      designation: ALL,
      unit: "2",
      status: "all",
      slip: "generated",
    });
    expect(filtersFromUrl({})).toEqual(NO_FILTERS);
    expect(filtersToUrl({ search: "x", department: "4" })).toEqual({ page: "1", q: "x", dept: "4" });
    expect(filtersToUrl(NO_FILTERS)).toEqual({
      page: "1",
      q: "",
      cat: "all",
      dept: ALL,
      desig: ALL,
      unit: ALL,
      status: "all",
      slip: "all",
    });
  });

  it("knows when any filter is on", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive(f({ search: "  " }))).toBe(false);
    expect(filtersActive(f({ slip: "not_generated" }))).toBe(true);
  });

  const departments = [
    { id: 3, name: "ACCOUNTS", category: "staff" },
    { id: 9, name: "STITCHING", category: "production" },
    { id: 10, name: "QUALITY", category: "staff" },
    { id: 12, name: "QUALITY", category: "production" },
  ];
  const designations = [
    { id: 5, title: "ACCOUNTANT", category: "staff" },
    { id: 11, title: "TAILOR", category: "production" },
  ];

  it("offers the departments and designations of the chosen category, telling twins apart", () => {
    expect(departmentOptions(departments, "production")).toEqual([
      { value: "12", label: "QUALITY" },
      { value: "9", label: "STITCHING" },
    ]);
    expect(departmentOptions(departments, "all").map((o) => o.label)).toEqual([
      "ACCOUNTS",
      "QUALITY (Production)",
      "QUALITY (Staff)",
      "STITCHING",
    ]);
    expect(designationOptions(designations, "staff")).toEqual([{ value: "5", label: "ACCOUNTANT" }]);
    expect(
      unitOptions([
        { id: 2, name: "Unit 2" },
        { id: 1, name: "Head Office" },
      ]),
    ).toEqual([
      { value: "1", label: "Head Office" },
      { value: "2", label: "Unit 2" },
    ]);
  });

  it("drops a department or designation the new category does not offer", () => {
    expect(changeCategory(f({ department: "3", designation: "5" }), "production", departments, designations)).toEqual({
      category: "production",
      department: ALL,
      designation: ALL,
    });
    expect(changeCategory(f({ department: "9" }), "production", departments, designations)).toEqual({
      category: "production",
      department: "9",
      designation: ALL,
    });
    expect(changeCategory(f({ department: "3" }), "all", departments, designations).department).toBe("3");
  });
});

describe("pages", () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);

  it("cuts the list into pages and clamps the page number", () => {
    expect(paginate(rows, 1)).toMatchObject({ page: 1, totalPages: 3, from: 1, to: 50, total: 120 });
    expect(paginate(rows, 3).rows).toHaveLength(20);
    expect(paginate(rows, 9)).toMatchObject({ page: 3, from: 101, to: 120 });
    expect(paginate(rows, Number("x"))).toMatchObject({ page: 1 });
    expect(paginate([], 4)).toMatchObject({ page: 1, totalPages: 1, from: 0, to: 0, total: 0 });
  });
});

describe("selection", () => {
  const a = emp({ id: 301 });
  const b = emp({ id: 302, onHold: true });
  const c = emp({ id: 303 });

  it("ticks one, all shown, or none", () => {
    let s = toggleId(NO_SELECTION, a.id);
    expect([...s]).toEqual([301]);
    s = toggleId(s, a.id);
    expect(s.size).toBe(0);
    s = selectRows(NO_SELECTION, [a, b]);
    expect(listSelection(s, [a, b])).toBe("all");
    expect(listSelection(s, [a, b, c])).toBe("some");
    expect(listSelection(NO_SELECTION, [a])).toBe("none");
    expect(listSelection(s, [])).toBe("none");
    expect(deselectRows(s, [a]).has(a.id)).toBe(false);
  });

  it("counts the ticked employees the filters hide, and keeps the list's order", () => {
    const s = selectRows(NO_SELECTION, [c, a]);
    expect(hiddenSelected(s, [a])).toBe(1);
    expect(selectedEmployees(s, [a, b, c]).map((e) => e.id)).toEqual([301, 303]);
    // someone no longer in the month's list drops out
    expect(selectedEmployees(toggleId(s, 999), [a, c]).map((e) => e.id)).toEqual([301, 303]);
  });

  it("splits the ticked ones into who can be held and who released", () => {
    const { toHold, toRelease } = holdSplit([a, b, c]);
    expect(toHold.map((e) => e.id)).toEqual([301, 303]);
    expect(toRelease.map((e) => e.id)).toEqual([302]);
  });
});

describe("Generate in batches", () => {
  it("sends batches of 20", () => {
    expect(GENERATE_BATCH).toBe(20);
    const ids = Array.from({ length: 45 }, (_, i) => i + 1);
    const batches = chunk(ids, GENERATE_BATCH);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(batches.flat()).toEqual(ids);
    expect(chunk([], 20)).toEqual([]);
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  });

  it("adds up the batches' answers", () => {
    const one = { generated: [{ employeeId: 1, slip: SLIP }], skipped: [] };
    const two = { generated: [], skipped: [{ employeeId: 2, code: "2", name: "B", reason: "No monthly salary" }] };
    expect(mergeResults(mergeResults(EMPTY_RESULT, one), two)).toEqual({
      generated: one.generated,
      skipped: two.skipped,
    });
  });

  it("words the result: saved, skipped and stopped early", () => {
    const made = { generated: [{ employeeId: 1, slip: SLIP }], skipped: [] };
    expect(generateWording(made, 1, "November 2026", null)).toEqual({
      title: "1 slip generated for November 2026",
      description: "Saved. They can be downloaded now.",
      variant: "default",
    });
    const mixed = {
      generated: [{ employeeId: 1, slip: SLIP }],
      skipped: [{ employeeId: 2, code: "2", name: "B", reason: "x" }],
    };
    const w = generateWording(mixed, 40, "November 2026", "Server is busy");
    expect(w.title).toBe("1 slip generated for November 2026");
    expect(w.description).toBe("1 skipped (see the list on the page). 38 not done: Server is busy");
    expect(w.variant).toBe("destructive");
    expect(generateWording(EMPTY_RESULT, 3, "November 2026", "No access").title).toBe("No slips were generated");
    expect(generateWording(EMPTY_RESULT, 3, "November 2026", null)).toMatchObject({
      title: "No slips generated for November 2026",
      variant: "destructive",
    });
  });
});

describe("downloads need saved slips", () => {
  const saved = emp({ id: 401, slip: SLIP });
  const notSaved = emp({ id: 402 });
  const alsoNot = emp({ id: 403 });

  it("finds the missing ones, and what may be downloaded once they are generated", () => {
    expect(missingSlips([saved, notSaved, alsoNot]).map((e) => e.id)).toEqual([402, 403]);
    // 403 was skipped (no salary): it stays out of the file
    expect(idsWithSlips([saved, notSaved, alsoNot], [402])).toEqual([401, 402]);
  });

  it("reads the server's 409 'missing' list, and nothing else", () => {
    expect(missingFromError(new SlipDownloadError("No saved slip", 409, [402, 403]))).toEqual([402, 403]);
    expect(missingFromError(new SlipDownloadError("No saved slip", 409, []))).toBeNull();
    expect(missingFromError(new SlipDownloadError("Server error", 500, [1]))).toBeNull();
    expect(missingFromError(new Error("x"))).toBeNull();
  });

  it("names the file when the server's name cannot be read", () => {
    const one = [{ code: "30020" }];
    const two = [{ code: "30020" }, { code: "30021" }];
    expect(fallbackFileName({ kind: "slips", layout: "single" }, 11, 2026, one)).toBe(
      "Salary-Slip-30020-November-2026.pdf",
    );
    expect(fallbackFileName({ kind: "slips", layout: "double" }, 11, 2026, two)).toBe("Salary-Slips-November-2026.pdf");
    expect(fallbackFileName({ kind: "statement", fmt: "xlsx" }, 3, 2026, two)).toBe("Salary-Statement-March-2026.xlsx");
    expect(fallbackFileName({ kind: "bank-file" }, 3, 2026, two)).toBe("Bank-File-March-2026.xlsx");
  });

  it("says what is being made", () => {
    expect(fileLabel({ kind: "slips", layout: "double" }, 3)).toBe("Making the slips PDF (3 slips, two per page)");
    expect(fileLabel({ kind: "statement", fmt: "pdf" }, 1)).toBe("Making the salary statement (PDF, 1 employee)");
    expect(fileLabel({ kind: "bank-file" }, 2)).toBe("Making the bank file (2 employees)");
  });

  it("asks the server for the right file", () => {
    expect(slipFileUrl(11, 2026, [1, 2], { kind: "slips", layout: "double" })).toBe(
      "/api/salary-slip-center/download/slips?month=11&year=2026&ids=1,2&layout=double",
    );
    expect(slipFileUrl(11, 2026, [7], { kind: "statement", fmt: "xlsx" })).toBe(
      "/api/salary-slip-center/download/statement?month=11&year=2026&ids=7&fmt=xlsx",
    );
    expect(slipFileUrl(1, 2027, [7, 8], { kind: "bank-file" })).toBe(
      "/api/salary-slip-center/download/bank-file?month=1&year=2027&ids=7,8",
    );
  });

  it("groups the bank check's left-out list by reason, most first", () => {
    const check = {
      included: [{ employeeId: 1, code: "1", name: "A", amount: 100 }],
      total: 100,
      leftOut: [
        { employeeId: 2, code: "2", name: "B", reason: "On hold" },
        { employeeId: 3, code: "3", name: "C", reason: "No IFSC code" },
        { employeeId: 4, code: "4", name: "D", reason: "On hold" },
      ],
    };
    expect(leftOutByReason(check)).toEqual([
      { reason: "On hold", count: 2 },
      { reason: "No IFSC code", count: 1 },
    ]);
  });
});

describe("errors", () => {
  const apiError = (status: number, data: unknown) =>
    new ApiError(new Response(null, { status, statusText: "Bad Request" }), data, { method: "GET", url: "/x" });

  it("shows the server's own sentence", () => {
    expect(errorText(apiError(400, { error: "No monthly salary on the profile" }))).toBe(
      "No monthly salary on the profile",
    );
    expect(errorText(apiError(403, { message: "Not allowed" }))).toBe("Not allowed");
    expect(errorText(new SlipDownloadError("No saved slip for 2 employees", 409, [1]))).toBe(
      "No saved slip for 2 employees",
    );
    expect(errorText(new Error("HTTP 500 Internal Server Error: Boom"))).toBe("Boom");
    expect(errorText("weird")).toBe("Could not reach the server. Check the connection and try again.");
  });
});

describe("options", () => {
  it("sends the switches as the preview takes them", () => {
    expect(slipOptionsQuery({ statutory: true, lateDeductions: false, advances: true })).toBe(
      "statutory=1&late=0&advances=1",
    );
  });

  it("names the deductions that are on, and compares two sets", () => {
    expect(optionsText({ statutory: true, lateDeductions: false, advances: true })).toBe(
      "PF / ESI / TDS, Advance instalments",
    );
    expect(optionsText({ statutory: false, lateDeductions: false, advances: false })).toBe("No deductions");
    expect(sameOptions(SLIP.options, { ...SLIP.options })).toBe(true);
    expect(sameOptions(SLIP.options, { ...SLIP.options, advances: false })).toBe(false);
  });
});

describe("the calendar", () => {
  const day = (date: string, p: Partial<SlipCalendarDay> = {}): SlipCalendarDay => ({
    date,
    day: "",
    status: "present",
    shifts: 1,
    firstIn: null,
    lastOut: null,
    late: false,
    note: "",
    ...p,
  });

  it("lays the month out in Monday-first weeks", () => {
    // November 2026 starts on a Sunday: six empty cells before the 1st
    const days = Array.from({ length: 30 }, (_, i) => day(`2026-11-${String(i + 1).padStart(2, "0")}`));
    const weeks = calendarWeeks([...days].reverse());
    expect(weeks).toHaveLength(6);
    expect(weeks[0].slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0][6]?.date).toBe("2026-11-01");
    expect(weeks[1][0]?.date).toBe("2026-11-02");
    expect(weeks[5][0]?.date).toBe("2026-11-30");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(calendarWeeks([])).toEqual([]);
  });

  it("puts the punches in the hover text", () => {
    expect(
      calendarTitle(
        day("2026-11-03", { day: "Tue", firstIn: "08:58", lastOut: "18:02", late: true, note: "Permission" }),
        "Present",
      ),
    ).toBe("Tue 3 · Present · 1 shift · 08:58-18:02 · Late · Permission");
    expect(calendarTitle(day("2026-11-08", { day: "Sun", status: "sunday", shifts: 0 }), "Sunday")).toBe(
      "Sun 8 · Sunday",
    );
  });
});

describe("a row and the month's figures", () => {
  it("shows the salary per month for staff and per shift for production", () => {
    expect(salaryOf(emp({ monthlySalary: 25000 }))).toEqual({ amount: 25000, per: "month" });
    expect(salaryOf(emp({ category: "production", monthlySalary: null, salaryPerShift: 650 }))).toEqual({
      amount: 650,
      per: "shift",
    });
    expect(salaryOf(emp({ monthlySalary: null, payIssue: "No monthly salary on the profile" }))).toBeNull();
  });

  it("adds up the month", () => {
    const list = [
      emp({ slip: SLIP }),
      emp({ slip: { ...SLIP, net: 900 }, onHold: true }),
      emp({ isNewJoiner: true, payIssue: "No monthly salary on the profile" }),
      emp({ bankIssue: "No IFSC code" }),
    ];
    expect(summarize(list)).toEqual({
      total: 4,
      generated: 2,
      net: 24000,
      onHold: 1,
      newJoiners: 1,
      payIssues: 1,
      bankIssues: 1,
    });
  });

  it("explains an empty list, with the way out", () => {
    expect(emptyInfo("active", false, 0, "November 2026").action).toBe("previous");
    expect(emptyInfo("active", true, 10, "November 2026").action).toBe("clear");
    expect(emptyInfo("on_hold", false, 10, "November 2026")).toMatchObject({
      title: "Nobody is on hold in November 2026",
      action: "all",
    });
    expect(emptyInfo("all", false, 10, "November 2026").action).toBeNull();
  });
});
