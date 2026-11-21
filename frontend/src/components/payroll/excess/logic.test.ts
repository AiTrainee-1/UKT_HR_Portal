import { describe, expect, it } from "vitest";
import type {
  ExcessDepartment,
  ExcessEmployeeOption,
  ExcessEmployeeRow,
  ExcessEntry,
} from "@/lib/api-client/custom-hooks";
import {
  addButtonLabel,
  addSummary,
  allPeriodsLabel,
  amountError,
  amountMove,
  breakdownFiltersFromUrl,
  breakdownFiltersToUrl,
  changePreview,
  deptKey,
  earnedMove,
  eligibleOnly,
  entriesByIds,
  entryIdsOf,
  entryWasChanged,
  excessPermissionKey,
  excessView,
  exportRows,
  filterBreakdown,
  hasBreakdownFilters,
  hasHistoryFilters,
  historyFilters,
  historyItemPeriod,
  historyUiFromUrl,
  historyUiToUrl,
  keepExisting,
  netMove,
  parseAmount,
  payrollLine,
  remarkCounter,
  remarkError,
  rowState,
  rowStateMeta,
  rupees,
  scopeLabel,
  signedAmount,
  signedRupees,
  sortOptions,
  toggleAll,
  toggleId,
  totalPages,
  totalsOfRows,
} from "./logic";

// The pure part of the Excess tab (Staff Payroll: one month; a Production Payroll cycle page: one pay period).

const entry = (id: number, over: Partial<ExcessEntry> = {}): ExcessEntry => ({
  id,
  employeeId: 12,
  kind: "excess",
  amount: 2000,
  remark: "Festival incentive approved by MD",
  source: "manual",
  createdBy: "Admin",
  createdAt: "2026-11-20T12:01:00+05:30",
  updatedBy: "Admin",
  updatedAt: "2026-11-20T12:01:00+05:30",
  ...over,
});

const row = (code: string, over: Partial<ExcessEmployeeRow> = {}): ExcessEmployeeRow => ({
  employeeId: Number(code),
  code,
  name: `Name ${code}`,
  designation: "ACCOUNTANT",
  department: "ACCOUNTS",
  excess: 2000,
  detection: 500,
  net: 1500,
  payrollId: 881,
  inPayroll: true,
  earnedSalary: 15000,
  earnedWithExcess: 16500,
  netPay: 15800,
  entries: [entry(Number(code) * 10), entry(Number(code) * 10 + 1, { kind: "detection", amount: 500 })],
  ...over,
});

const dept = (id: number | null, name: string, rows: ExcessEmployeeRow[]): ExcessDepartment => ({
  departmentId: id,
  department: name,
  unit: "HO",
  employees: rows.length,
  excessTotal: rows.reduce((s, r) => s + r.excess, 0),
  detectionTotal: rows.reduce((s, r) => s + r.detection, 0),
  net: rows.reduce((s, r) => s + r.net, 0),
  rows,
});

const STAFF = { kind: "staff", month: 11, year: 2026 } as const;
const WEEKLY = { kind: "production", cycle: "weekly", periodStart: "2026-11-02", periodEnd: "2026-11-08" } as const;

describe("staff month or production period", () => {
  it("keeps the tab's permission key of each page", () => {
    expect(excessPermissionKey("staff")).toBe("salary");
    expect(excessPermissionKey("production")).toBe("production_payroll.salary");
  });

  it("names the period before the server answers", () => {
    expect(scopeLabel(STAFF)).toBe("November 2026");
    expect(scopeLabel(WEEKLY)).toBe("Weekly 2 Nov - 8 Nov 2026");
  });

  it("says what a save did to the payroll, in the page's words", () => {
    expect(payrollLine(2, "staff")).toBe("2 payrolls updated at once: earned salary and NET.");
    expect(payrollLine(1, "production")).toBe("1 payroll updated at once: earned salary and NET.");
    expect(payrollLine(0, "staff")).toBe("Applied when the month's payroll is generated.");
    expect(payrollLine(0, "production")).toBe("Applied when the period's payroll is generated.");
    expect(payrollLine(true, "staff")).toBe("The payroll is updated at once: earned salary and NET.");
    expect(payrollLine(false, "production")).toBe("Applied when the period's payroll is generated.");
  });
});

describe("money", () => {
  it("writes rupees without paise unless there are some", () => {
    expect(rupees(2000)).toBe("₹2,000");
    expect(rupees(2000.5)).toBe("₹2,000.50");
    expect(rupees(null)).toBe("—");
    expect(rupees(Number.NaN)).toBe("—");
  });

  it("signs a change to the salary", () => {
    expect(signedRupees(500)).toBe("+₹500");
    expect(signedRupees(-500)).toBe("−₹500");
    expect(signedRupees(0)).toBe("₹0");
    expect(signedAmount("excess", 300)).toBe(300);
    expect(signedAmount("detection", 300)).toBe(-300);
  });
});

describe("where a row stands with the payroll", () => {
  it("is in the payroll, not generated yet, or set aside", () => {
    expect(rowState({ inPayroll: true, payrollId: 1 })).toBe("in_payroll");
    expect(rowState({ inPayroll: false, payrollId: null })).toBe("not_generated");
    expect(rowState({ inPayroll: false, payrollId: 9 })).toBe("held_or_new");
  });

  it("calls a set-aside production payroll a new joiner waiting (production has no hold)", () => {
    expect(rowStateMeta("held_or_new", "staff").label).toBe("Held or new joiner");
    expect(rowStateMeta("held_or_new", "production").label).toBe("New joiner waiting");
    expect(rowStateMeta("in_payroll").tone).toBe("success");
  });

  it("moves the earned salary only when there is a payroll", () => {
    expect(earnedMove(row("1"))).toEqual({ before: 15000, after: 16500 });
    expect(earnedMove(row("1", { earnedWithExcess: null }))).toEqual({ before: 15000, after: 16500 });
    expect(earnedMove(row("1", { earnedSalary: null }))).toBeNull();
  });

  it("knows an entry that was changed after it was added", () => {
    expect(entryWasChanged(entry(1))).toBe(false);
    expect(entryWasChanged(entry(1, { updatedAt: "2026-11-20T12:05:00+05:30" }))).toBe(true);
    expect(entryWasChanged(entry(1, { updatedAt: null }))).toBe(false);
  });
});

describe("the breakdown's filters", () => {
  const departments = [
    dept(3, "ACCOUNTS", [row("30020"), row("30021", { excess: 0, detection: 500, net: -500, inPayroll: false })]),
    dept(null, "No department", [row("40001", { detection: 0, net: 2000, designation: "DRIVER" })]),
  ];

  it("reads and writes the address, prefixed ex", () => {
    expect(breakdownFiltersFromUrl({ exq: "surya", exdept: "3", exkind: "detection", exin: "1" })).toEqual({
      q: "surya",
      dept: "3",
      kind: "detection",
      inPayrollOnly: true,
    });
    expect(breakdownFiltersFromUrl({ exkind: "bonus" }).kind).toBe("");
    expect(breakdownFiltersToUrl({ inPayrollOnly: false, kind: "excess" })).toEqual({ exin: "", exkind: "excess" });
    expect(excessView("history")).toBe("history");
    expect(excessView("anything")).toBe("breakdown");
  });

  it("gives back the server's departments untouched without a filter", () => {
    const f = breakdownFiltersFromUrl({});
    expect(hasBreakdownFilters(f)).toBe(false);
    expect(filterBreakdown(departments, f)).toEqual(departments);
  });

  it("keeps only the matching rows and works the totals out again, dropping empty departments", () => {
    const shown = filterBreakdown(departments, { q: "", dept: "", kind: "detection", inPayrollOnly: false });
    expect(shown.map((d) => d.rows.map((r) => r.code))).toEqual([["30020", "30021"]]);
    expect(shown[0]).toMatchObject({ employees: 2, excessTotal: 2000, detectionTotal: 1000, net: 1000 });
    expect(
      filterBreakdown(departments, { q: "driver", dept: "", kind: "", inPayrollOnly: false })[0].rows,
    ).toHaveLength(1);
    expect(filterBreakdown(departments, { q: "", dept: "none", kind: "", inPayrollOnly: true })[0].department).toBe(
      "No department",
    );
    expect(filterBreakdown(departments, { q: "", dept: "", kind: "", inPayrollOnly: true })[0].rows).toHaveLength(1);
    expect(deptKey({ departmentId: null })).toBe("none");
  });

  it("adds the rows up", () => {
    expect(totalsOfRows(departments.flatMap((d) => d.rows))).toEqual({
      employees: 3,
      entries: 6,
      excessTotal: 4000,
      detectionTotal: 1000,
      net: 3000,
    });
  });
});

describe("selections", () => {
  const departments = [dept(3, "ACCOUNTS", [row("1"), row("2")])];

  it("toggles one id, and all of a set", () => {
    expect(toggleId([1, 2], 2)).toEqual([1]);
    expect(toggleId([1], 2)).toEqual([1, 2]);
    expect(toggleAll([1], [1, 2])).toEqual([1, 2]);
    expect(toggleAll([1, 2, 3], [1, 2])).toEqual([3]);
    expect(toggleAll([], [])).toEqual([]);
  });

  it("finds the entries picked with their employee, and forgets the ones that are gone", () => {
    expect(entryIdsOf(departments)).toEqual([10, 11, 20, 21]);
    expect(entriesByIds(departments, [21, 10, 99]).map((t) => [t.row.code, t.entry.id])).toEqual([
      ["1", 10],
      ["2", 21],
    ]);
    expect(keepExisting([10, 99], entryIdsOf(departments))).toEqual([10]);
  });

  it("never picks an employee who cannot get an entry", () => {
    const options: ExcessEmployeeOption[] = [
      {
        id: 2,
        code: "B2",
        name: "B",
        department: null,
        designation: null,
        eligible: false,
        reason: "Inactive employee",
      },
      { id: 1, code: "A10", name: "A", department: null, designation: null, eligible: true, reason: null },
      { id: 3, code: "A9", name: "C", department: null, designation: null, eligible: true, reason: null },
    ];
    expect(eligibleOnly([1, 2, 3, 4], options)).toEqual([1, 3]);
    // selectable first, each part by code (numbers in order)
    expect(sortOptions(options).map((o) => o.code)).toEqual(["A9", "A10", "B2"]);
  });
});

describe("validation: the server's rules", () => {
  it("wants an amount more than zero, at most ₹10,00,000, with at most 2 decimals", () => {
    expect(amountError("")).toBe("Enter an amount.");
    expect(amountError("-5")).toBe("The amount must be more than zero.");
    expect(amountError("0")).toBe("The amount must be more than zero.");
    expect(amountError("abc")).toBe("Enter the amount in rupees, for example 2000.");
    expect(amountError("10.555")).toBe("Use at most 2 decimals (paise).");
    expect(amountError("1000001")).toBe("The amount cannot be more than ₹10,00,000.");
    expect(amountError("₹2,000.50")).toBeNull();
    expect(parseAmount("₹2,000.50")).toBe(2000.5);
    expect(parseAmount("2 000")).toBe(2000);
    expect(parseAmount("1e3")).toBeNull();
  });

  it("wants a remark (or a reason) of 3 to 500 characters", () => {
    expect(remarkError("  ")).toBe("A remark is required.");
    expect(remarkError("", "reason")).toBe("A reason is required.");
    expect(remarkError("ok")).toBe("Write at least 3 characters.");
    expect(remarkError("x".repeat(501), "reason")).toBe("Keep the reason within 500 characters.");
    expect(remarkError(" Added by mistake ")).toBeNull();
    expect(remarkCounter(" abc ")).toEqual({ label: "3 / 500", over: false });
    expect(remarkCounter("x".repeat(501)).over).toBe(true);
  });
});

describe("what the dialogs say", () => {
  it("sums an add up, for one employee or each of several", () => {
    expect(addSummary("excess", 2000, ["SURYA M"])).toBe("Adds ₹2,000 to SURYA M's earned salary.");
    expect(addSummary("excess", 2000, ["A", "B", "C"])).toBe("Adds ₹2,000 to each of 3 employees (₹6,000 in all).");
    expect(addSummary("detection", 500, ["A"])).toBe("Takes ₹500 off A's earned salary.");
    expect(addSummary("detection", 500, ["A", "B"])).toBe("Takes ₹500 off each of 2 employees (₹1,000 in all).");
    expect(addSummary("excess", null, ["A"])).toBeNull();
    expect(addSummary("excess", 100, [])).toBeNull();
  });

  it("labels the save button with what it will do", () => {
    expect(addButtonLabel("excess", 2000, 3)).toBe("Add ₹2,000 excess to 3 employees");
    expect(addButtonLabel("detection", 500, 1)).toBe("Add ₹500 detection to 1 employee");
    expect(addButtonLabel("excess", null, 3)).toBe("Add excess");
  });

  it("previews a change of amount", () => {
    expect(changePreview(2000, "2500")).toBe("₹2,000 → ₹2,500 (+₹500)");
    expect(changePreview(2000, "1500")).toBe("₹2,000 → ₹1,500 (−₹500)");
    expect(changePreview(2000, "2000")).toBe("₹2,000 → ₹2,000 (no change)");
    expect(changePreview(2000, "x")).toBeNull();
  });
});

describe("history", () => {
  it("reads and writes the address; a filter change goes back to page 1", () => {
    expect(historyUiFromUrl({ exhall: "1", exhdept: "3", exhemp: "x", exhkind: "excess", exhpage: "3" })).toEqual({
      allPeriods: true,
      dept: "3",
      emp: "",
      kind: "excess",
      action: "",
      page: 3,
    });
    expect(historyUiFromUrl({ exhpage: "0" }).page).toBe(1);
    expect(historyUiToUrl({ kind: "detection" })).toEqual({ exhkind: "detection", exhpage: "" });
    expect(historyUiToUrl({ page: 2 })).toEqual({ exhpage: "2" });
    expect(historyUiToUrl({ page: 1 })).toEqual({ exhpage: "" });
    expect(hasHistoryFilters(historyUiFromUrl({}))).toBe(false);
    expect(hasHistoryFilters(historyUiFromUrl({ exhact: "removed" }))).toBe(true);
  });

  it("asks a staff history for the month, or every month", () => {
    const ui = historyUiFromUrl({ exhdept: "3", exhact: "changed" });
    expect(historyFilters(ui, STAFF, 50)).toEqual({
      month: 11,
      year: 2026,
      departmentId: 3,
      employeeId: null,
      kind: null,
      action: "changed",
      page: 1,
      pageSize: 50,
    });
    expect(historyFilters({ ...ui, allPeriods: true }, STAFF, 25)).toMatchObject({ month: null, year: null });
  });

  it("asks a production history for the cycle's period, or every period of the cycle (never another cycle)", () => {
    const ui = historyUiFromUrl({});
    expect(historyFilters(ui, WEEKLY, 50)).toMatchObject({
      cycle: "weekly",
      periodStart: "2026-11-02",
      periodEnd: "2026-11-08",
    });
    expect(historyFilters({ ...ui, allPeriods: true }, WEEKLY, 50)).toMatchObject({
      cycle: "weekly",
      periodStart: null,
      periodEnd: null,
    });
    expect(historyFilters(ui, WEEKLY, 50)).not.toHaveProperty("month");
    expect(allPeriodsLabel(STAFF)).toBe("All months");
    expect(allPeriodsLabel(WEEKLY)).toBe("Every Weekly period");
  });

  it("names the month or the period of a line", () => {
    expect(historyItemPeriod({ month: 11, year: 2026 })).toBe("November 2026");
    expect(historyItemPeriod({ month: null, year: null, periodStart: "2026-11-02", periodEnd: "2026-11-08" })).toBe(
      "2 Nov - 8 Nov 2026",
    );
    expect(historyItemPeriod({})).toBe("—");
  });

  it("writes what happened to the amount and to the NET", () => {
    expect(amountMove({ action: "added", previousAmount: null, newAmount: 2000 })).toBe("New ₹2,000");
    expect(amountMove({ action: "changed", previousAmount: 2000, newAmount: 2500 })).toBe("₹2,000 → ₹2,500");
    expect(amountMove({ action: "removed", previousAmount: 2000, newAmount: null })).toBe("₹2,000 removed");
    expect(netMove({ payrollNetBefore: 15800, payrollNetAfter: 16300 })).toBe("₹15,800 → ₹16,300");
    expect(netMove({ payrollNetBefore: null, payrollNetAfter: null })).toBeNull();
    expect(totalPages(0, 50)).toBe(1);
    expect(totalPages(101, 50)).toBe(3);
  });
});

describe("the Excel export", () => {
  it("has a line per employee, a total per department and a grand total, with the entries and remarks", () => {
    const departments = [
      dept(3, "ACCOUNTS", [row("1")]),
      dept(4, "STORES", [row("2", { inPayroll: false, payrollId: 7 })]),
    ];
    const { rows, totalRowIndexes } = exportRows(departments, "production");
    expect(totalRowIndexes).toEqual([1, 3, 4]);
    expect(rows[0].slice(0, 12)).toEqual([
      "ACCOUNTS",
      "HO",
      "1",
      "Name 1",
      "ACCOUNTANT",
      2000,
      500,
      1500,
      15000,
      16500,
      15800,
      "In payroll",
    ]);
    expect(rows[0][12]).toContain("Excess ₹2,000: Festival incentive approved by MD (Admin)");
    expect(rows[2][11]).toBe("New joiner waiting");
    expect(rows[4].slice(0, 8)).toEqual(["Grand total", "", "", "2 employees", "", 4000, 1000, 3000]);
  });
});
