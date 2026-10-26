import { describe, expect, it } from "vitest";
import type { SalarySlipItem } from "@/lib/api-client/custom-hooks";
import {
  ALL_DEPARTMENTS,
  NO_SLIP_FILTER,
  REGISTER_COLUMNS,
  emailedDay,
  errorText,
  filterSlips,
  parseYear,
  registerColumnsFor,
  registerFileStem,
  slipCycleLabel,
  slipDepartments,
  slipFilterCount,
  slipPeriodText,
  slipTotals,
} from "./payslips-logic";

const slip = (id: number, name: string, code: string, over: Partial<SalarySlipItem> = {}): SalarySlipItem =>
  ({
    id,
    employeeId: id * 10,
    employeeCode: code,
    employeeName: name,
    departmentName: "Weaving",
    designationTitle: "Operator",
    month: 10,
    year: 2026,
    slipNumber: `SLP-2026-10-${code}`,
    grossSalary: 30000,
    totalDeductions: 1500,
    netSalary: 28500,
    emailedAt: null,
    ...over,
  }) as SalarySlipItem;

const SLIPS = [
  slip(1, "Asha Kumar", "E001", { emailedAt: "2026-10-12T09:30:00+05:30" }),
  slip(2, "Ravi Nair", "E002", {
    departmentName: "Stitching",
    grossSalary: 20000,
    totalDeductions: 0,
    netSalary: 20000,
  }),
  slip(3, "Meena Das", "E003", { departmentName: null, designationTitle: null }),
  slip(4, "Bala Worker", "PC-W2", { departmentName: "Stitching", emailedAt: "2026-10-13T08:00:00+05:30" }),
];

describe("parseYear", () => {
  it("accepts a four-digit year in range", () => {
    expect(parseYear("2026")).toBe(2026);
    expect(parseYear(" 2026 ")).toBe(2026);
    expect(parseYear("2000")).toBe(2000);
    expect(parseYear("2100")).toBe(2100);
  });

  it("rejects what is half typed or out of range, so nothing is asked of the server yet", () => {
    for (const bad of ["", "2", "20", "202", "20266", "1999", "2101", "abcd", "20.6", "-202"]) {
      expect(parseYear(bad)).toBeNull();
    }
  });
});

describe("a slip's period and cycle", () => {
  it("staff: the month", () => {
    expect(slipPeriodText(slip(1, "A", "A"))).toBe("October 2026");
  });

  it("production: the dates", () => {
    expect(slipPeriodText(slip(1, "A", "A", { periodStart: "2026-02-02", periodEnd: "2026-02-08", month: 2 }))).toBe(
      "2 Feb - 8 Feb 2026",
    );
  });

  it("an old week-numbered slip: the week and the month", () => {
    expect(slipPeriodText(slip(1, "A", "A", { weekNumber: 4, month: 2 }))).toBe("Week 4 · February 2026");
  });

  it("names the pay cycle, or none", () => {
    expect(slipCycleLabel(slip(1, "A", "A", { payCycle: "weekly" }))).toBe("Weekly");
    expect(slipCycleLabel(slip(1, "A", "A", { payCycle: "biweekly" }))).toBe("BiWeekly");
    expect(slipCycleLabel(slip(1, "A", "A", { payCycle: null }))).toBeNull();
    expect(slipCycleLabel(slip(1, "A", "A"))).toBeNull();
    expect(slipCycleLabel(slip(1, "A", "A", { payCycle: "odd" }))).toBeNull();
  });
});

describe("emailedDay", () => {
  it("is nothing when the slip was never emailed or the date is not one", () => {
    expect(emailedDay(null)).toBeNull();
    expect(emailedDay(undefined)).toBeNull();
    expect(emailedDay("")).toBeNull();
    expect(emailedDay("not a date")).toBeNull();
  });

  it("reads as the viewer's own calendar day", () => {
    const iso = "2026-10-13T09:30:00+05:30";
    const d = new Date(iso);
    const expected = `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getFullYear()}`;
    expect(emailedDay(iso)).toBe(expected);
  });
});

describe("errorText", () => {
  it("prefers the server's own sentence", () => {
    expect(
      errorText({ data: { error: "No email address on file for Ravi Nair" }, message: "HTTP 400 Bad Request: ..." }),
    ).toBe("No email address on file for Ravi Nair");
  });

  it("else the error's message, else a plain default", () => {
    expect(errorText(new Error("Network is down"))).toBe("Network is down");
    expect(errorText({ data: { error: "  " }, message: "HTTP 500" })).toBe("HTTP 500");
    expect(errorText({ data: null })).toBe("Unknown error");
    expect(errorText(undefined)).toBe("Unknown error");
    expect(errorText("boom")).toBe("Unknown error");
  });
});

describe("filterSlips", () => {
  const ids = (rows: SalarySlipItem[]) => rows.map((s) => s.id);

  it("keeps everyone, in the order given, when nothing is chosen", () => {
    expect(ids(filterSlips(SLIPS, NO_SLIP_FILTER))).toEqual([1, 2, 3, 4]);
    expect(ids(filterSlips([...SLIPS].reverse(), NO_SLIP_FILTER))).toEqual([4, 3, 2, 1]);
  });

  it("searches the name or the code, in any case, every word", () => {
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, q: "RAVI" }))).toEqual([2]);
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, q: "e00" }))).toEqual([1, 2, 3]);
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, q: "nair  ravi" }))).toEqual([2]);
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, q: "ravi e001" }))).toEqual([]);
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, q: "   " }))).toEqual([1, 2, 3, 4]);
  });

  it("filters by department name, and 'none' for slips without one", () => {
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, dept: "Stitching" }))).toEqual([2, 4]);
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, dept: "none" }))).toEqual([3]);
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, dept: "Nowhere" }))).toEqual([]);
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, dept: ALL_DEPARTMENTS }))).toEqual([1, 2, 3, 4]);
  });

  it("'not yet emailed' leaves the slips that were never sent", () => {
    expect(ids(filterSlips(SLIPS, { ...NO_SLIP_FILTER, notEmailed: true }))).toEqual([2, 3]);
  });

  it("applies all three together", () => {
    expect(ids(filterSlips(SLIPS, { q: "e00", dept: "Stitching", notEmailed: true }))).toEqual([2]);
  });

  it("never changes its input", () => {
    const copy = [...SLIPS];
    filterSlips(SLIPS, { q: "ravi", dept: "all", notEmailed: true });
    expect(SLIPS).toEqual(copy);
  });

  it("counts the filters that are on", () => {
    expect(slipFilterCount(NO_SLIP_FILTER)).toBe(0);
    expect(slipFilterCount({ q: " ", dept: "all", notEmailed: false })).toBe(0);
    expect(slipFilterCount({ q: "a", dept: "Weaving", notEmailed: true })).toBe(3);
  });
});

describe("slipDepartments", () => {
  it("lists each department once, by name, with 'No department' last", () => {
    expect(slipDepartments(SLIPS)).toEqual([
      { value: "Stitching", label: "Stitching" },
      { value: "Weaving", label: "Weaving" },
      { value: "none", label: "No department" },
    ]);
  });

  it("has no 'No department' when every slip has one", () => {
    expect(slipDepartments([SLIPS[0], SLIPS[1]]).some((o) => o.value === "none")).toBe(false);
    expect(slipDepartments([])).toEqual([]);
  });
});

describe("slipTotals", () => {
  it("adds the month's money and counts the people", () => {
    expect(slipTotals(SLIPS)).toEqual({
      slips: 4,
      employees: 4,
      gross: 110000,
      deductions: 4500,
      net: 105500,
      notEmailed: 2,
    });
  });

  it("counts a person once however many slips they have", () => {
    const t = slipTotals([
      slip(1, "A", "A", { employeeId: 7 }),
      slip(2, "A", "A", { employeeId: 7 }),
      slip(3, "B", "B"),
    ]);
    expect(t.slips).toBe(3);
    expect(t.employees).toBe(2);
  });

  it("is zero for nothing, and has no floating-point dust", () => {
    expect(slipTotals([])).toEqual({ slips: 0, employees: 0, gross: 0, deductions: 0, net: 0, notEmailed: 0 });
    expect(slipTotals([slip(1, "A", "A", { netSalary: 0.1 }), slip(2, "B", "B", { netSalary: 0.2 })]).net).toBe(0.3);
  });
});

describe("the Payslip register", () => {
  const cells = (s: SalarySlipItem) =>
    REGISTER_COLUMNS.map((c) => (c.value ? c.value(s) : (s as unknown as Record<string, unknown>)[c.key]));

  it("has the columns the owner asked for, in order", () => {
    expect(REGISTER_COLUMNS.map((c) => c.label)).toEqual([
      "Slip no",
      "Code",
      "Name",
      "Department",
      "Designation",
      "Period",
      "Gross",
      "Deductions",
      "Net",
      "Emailed at",
    ]);
  });

  it("writes the money as money cells, so Excel adds them up", () => {
    expect(REGISTER_COLUMNS.filter((c) => c.type === "money").map((c) => c.label)).toEqual([
      "Gross",
      "Deductions",
      "Net",
    ]);
  });

  it("reads one slip into one line", () => {
    const line = cells(SLIPS[1]);
    expect(line.slice(0, 3)).toEqual(["SLP-2026-10-E002", "E002", "Ravi Nair"]);
    expect(line[3]).toBe("Stitching");
    expect(line[4]).toBe("Operator");
    expect(line[5]).toBe("October 2026");
    expect(line.slice(6, 9)).toEqual([20000, 0, 20000]);
    expect(line[9]).toBe(""); // never emailed
  });

  it("leaves a missing department and designation empty", () => {
    const line = cells(SLIPS[2]);
    expect(line[3]).toBe("");
    expect(line[4]).toBe("");
  });

  it("writes when it was emailed", () => {
    expect(cells(SLIPS[0])[9]).toMatch(/^\d{1,2} [A-Z][a-z]{2} 2026, \d{2}:\d{2}$/);
  });

  it("has no TDS columns while no slip has TDS: the very same columns", () => {
    expect(registerColumnsFor(SLIPS)).toBe(REGISTER_COLUMNS);
    expect(registerColumnsFor([slip(9, "No Tds", "E009", { tdsDeduction: 0, tdsPercent: null })])).toBe(
      REGISTER_COLUMNS,
    );
  });

  it("adds 'TDS %' and 'TDS' before Deductions when a slip has TDS, empty on the slips that have none", () => {
    const tds = slip(9, "Karthik Rajan", "E009", { tdsDeduction: 2500, tdsPercent: 10, totalDeductions: 2500 });
    const columns = registerColumnsFor([...SLIPS, tds]);
    expect(columns.map((c) => c.label)).toEqual([
      "Slip no",
      "Code",
      "Name",
      "Department",
      "Designation",
      "Period",
      "Gross",
      "TDS %",
      "TDS",
      "Deductions",
      "Net",
      "Emailed at",
    ]);
    const read = (label: string, s: SalarySlipItem) => columns.find((c) => c.label === label)!.value!(s);
    expect(read("TDS", tds)).toBe(2500);
    expect(read("TDS %", tds)).toBe(10);
    expect(read("TDS", SLIPS[0])).toBeNull();
    expect(read("TDS %", SLIPS[0])).toBeNull();
  });

  it("names the file after who, which month and the register", () => {
    expect(registerFileStem("staff", undefined, 10, 2026)).toBe("Payslip_register_Staff_October_2026");
    expect(registerFileStem("production", "weekly", 2, 2026)).toBe("Payslip_register_Weekly_February_2026");
    expect(registerFileStem("production", undefined, 2, 2026)).toBe("Payslip_register_Production_February_2026");
  });
});
