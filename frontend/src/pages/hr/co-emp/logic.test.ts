import { describe, expect, it } from "vitest";
import type { CoverageCounts, CoverageResponse, CoverageRow, TdsEmployeeRow } from "@/lib/api-client/custom-hooks";
import {
  EMPLOYEES_URL_DEFAULTS,
  PERCENT_MESSAGE,
  STRIP_COLUMNS,
  addedMessage,
  checkTdsForm,
  classLabel,
  coEmpListParams,
  coverageById,
  formatPercent,
  notEvaluatedNote,
  pageOf,
  parseClass,
  parseEmployeesTab,
  parsePercent,
  pfEsiHint,
  removeWording,
  serverProblem,
  stripRows,
  tdsProblemField,
  toggleNeedsConfirm,
  toggleToast,
} from "./logic";

const row = (over: Partial<CoverageRow> = {}): CoverageRow => ({
  id: 1,
  employeeCode: "UK001",
  name: "Asha Kumar",
  employmentType: "staff",
  departmentName: "Stitching",
  branchId: 1,
  branchName: "Unit 1",
  category: "co_emp",
  pf: true,
  esi: true,
  pfRatePercent: 12,
  esiRatePercent: 0.75,
  status: "pf_esi",
  tdsPercent: null,
  ...over,
});

const tdsRow = (over: Partial<TdsEmployeeRow> = {}): TdsEmployeeRow => ({
  id: 7,
  employeeCode: "UK007",
  name: "Ravi Nair",
  departmentName: null,
  designationTitle: null,
  branchId: 1,
  branchName: "Unit 1",
  employmentType: "staff",
  status: "active",
  tdsPercent: 10,
  ...over,
});

const counts = (over: Partial<CoverageCounts> = {}): CoverageCounts => ({
  total: 20,
  coEmp: 10,
  tds: 2,
  notCoEmp: 8,
  withPf: 6,
  withEsi: 4,
  withBoth: 3,
  withAny: 7,
  withNeither: 3,
  notEvaluated: 0,
  ...over,
});

describe("the address", () => {
  it("opens on Staff, with the Staff pill and no panel", () => {
    expect(EMPLOYEES_URL_DEFAULTS).toEqual({ tab: "staff", type: "staff", view: "" });
  });

  it("reads the tab and the class; anything unknown falls back to Staff", () => {
    expect(parseEmployeesTab("coemp")).toBe("coemp");
    expect(parseEmployeesTab("production")).toBe("production");
    expect(parseEmployeesTab("staff")).toBe("staff");
    expect(parseEmployeesTab("whatever")).toBe("staff");
    expect(parseEmployeesTab(null)).toBe("staff");
    expect(parseClass("production")).toBe("production");
    expect(parseClass("coemp")).toBe("staff");
    expect(parseClass(undefined)).toBe("staff");
    expect(classLabel("production")).toBe("Production");
    expect(classLabel("staff")).toBe("Staff");
  });
});

describe("the Co Emp list", () => {
  it("always asks for the class of the pill, whatever the filters", () => {
    const filters = { departmentId: 3, branchId: 2, status: "active", search: "asha" };
    expect(coEmpListParams(filters, "production", 2, 25)).toEqual({
      departmentId: 3,
      branchId: 2,
      status: "active",
      search: "asha",
      employmentType: "production",
      page: 2,
      pageSize: 25,
    });
    expect(coEmpListParams({}, "staff", 1, 10).employmentType).toBe("staff");
  });
});

describe("the PF/ESI hint", () => {
  it("says TDS (never PF/ESI) for a TDS employee, whatever else is on", () => {
    const hint = pfEsiHint({ tdsEnabled: true, tdsPercent: 12.5, coEmpEnabled: false });
    expect(hint).toMatchObject({ text: "TDS 12.5%", tone: "accent" });
    expect(hint.detail).toMatch(/no PF\/ESI/);
    // even if a stale verdict says Co Emp
    expect(pfEsiHint({ tdsEnabled: true, tdsPercent: 10, coEmpEnabled: true }, row()).text).toBe("TDS 10%");
  });

  it("says No PF/ESI for an employee who is neither Co Emp nor TDS", () => {
    expect(pfEsiHint({ coEmpEnabled: false })).toMatchObject({ text: "No PF/ESI", tone: "neutral" });
    expect(pfEsiHint({ coEmpEnabled: null, tdsEnabled: null })).toMatchObject({ text: "No PF/ESI" });
    // a stale "co_emp" verdict does not make a switched-off employee look covered
    expect(pfEsiHint({ coEmpEnabled: false }, row()).text).toBe("No PF/ESI");
  });

  it("names the category only while the verdict has not arrived", () => {
    expect(pfEsiHint({ coEmpEnabled: true })).toMatchObject({ text: "PF/ESI rules apply", tone: "info" });
    // a verdict for another category (the employee was just switched) is not trusted
    expect(pfEsiHint({ coEmpEnabled: true }, row({ category: "none", status: "not_co_emp" })).text).toBe(
      "PF/ESI rules apply",
    );
  });

  it("turns the report's verdict into words", () => {
    const co = { coEmpEnabled: true };
    expect(pfEsiHint(co, row())).toEqual({ text: "PF + ESI", tone: "success", detail: "PF 12% · ESI 0.75%" });
    expect(pfEsiHint(co, row({ status: "pf_only", esi: false, esiRatePercent: null }))).toEqual({
      text: "PF only",
      tone: "success",
      detail: "PF 12%",
    });
    expect(pfEsiHint(co, row({ status: "esi_only", pf: false, pfRatePercent: null }))).toEqual({
      text: "ESI only",
      tone: "success",
      detail: "ESI 0.75%",
    });
    expect(pfEsiHint(co, row({ status: "neither", pf: false, esi: false }))).toMatchObject({
      text: "No deduction",
      tone: "warning",
    });
    expect(pfEsiHint(co, row({ status: "not_evaluated", pf: null, esi: null }))).toMatchObject({
      text: "Not known yet",
      tone: "neutral",
    });
  });

  it("indexes the verdicts by employee", () => {
    const map = coverageById([row({ id: 4 }), row({ id: 9 })]);
    expect([...map.keys()]).toEqual([4, 9]);
    expect(coverageById(undefined).size).toBe(0);
  });
});

describe("the Co Emp switch", () => {
  it("confirms only when turning ON for a TDS employee", () => {
    expect(toggleNeedsConfirm({ tdsEnabled: true }, true)).toBe(true);
    expect(toggleNeedsConfirm({ tdsEnabled: true }, false)).toBe(false);
    expect(toggleNeedsConfirm({ tdsEnabled: false }, true)).toBe(false);
    expect(toggleNeedsConfirm({}, true)).toBe(false);
  });

  it("says what happened", () => {
    expect(toggleToast({ employeeCode: "UK001" }, true)).toEqual({
      title: "UK001 is now Co Emp",
      description: "PF/ESI rules apply from the next payroll.",
    });
    expect(toggleToast({ employeeCode: "UK001", tdsEnabled: true, tdsPercent: 10 }, true).description).toBe(
      "Moved out of TDS (10%). PF/ESI rules apply from the next payroll.",
    );
    expect(toggleToast({ employeeCode: "UK001", coEmpEnabled: true }, false)).toEqual({
      title: "UK001 is no longer Co Emp",
      description: "No PF/ESI will be deducted from the next payroll.",
    });
  });
});

describe("percentages", () => {
  it("accepts more than 0 up to 100 with at most 2 decimals", () => {
    for (const [text, value] of [
      ["10", 10],
      ["0.01", 0.01],
      ["12.5", 12.5],
      ["100", 100],
      [" 7.25 ", 7.25],
      ["99.99", 99.99],
    ] as const) {
      expect(parsePercent(text)).toEqual({ ok: true, value });
    }
  });

  it("refuses everything else with the server's wording", () => {
    for (const text of ["0", "0.00", "100.01", "101", "-5", "1e2", "10%", "abc", "1.234", "12,5", "1 0", ".5", "10."]) {
      expect(parsePercent(text), text).toEqual({ ok: false, message: PERCENT_MESSAGE });
    }
    expect(parsePercent("")).toEqual({ ok: false, message: "Enter the TDS percentage." });
    expect(parsePercent("   ")).toEqual({ ok: false, message: "Enter the TDS percentage." });
  });

  it("writes a percentage without trailing zeros", () => {
    expect(formatPercent(10)).toBe("10");
    expect(formatPercent(12.5)).toBe("12.5");
    expect(formatPercent(0.75)).toBe("0.75");
    expect(formatPercent(10.0)).toBe("10");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});

describe("the Add Employee form", () => {
  it("passes a code and a percentage, trimming the code", () => {
    expect(checkTdsForm({ code: "  UK001 ", percent: "10" })).toEqual({ ok: true, employeeCode: "UK001", percent: 10 });
  });

  it("keeps the case of the code (codes are not upper-cased on the way)", () => {
    expect(checkTdsForm({ code: "Unit1-7", percent: "5" })).toMatchObject({ ok: true, employeeCode: "Unit1-7" });
  });

  it("names every field that is wrong", () => {
    expect(checkTdsForm({ code: "", percent: "" })).toEqual({
      ok: false,
      errors: { code: "Enter the employee code.", percent: "Enter the TDS percentage." },
    });
    expect(checkTdsForm({ code: "UK001", percent: "150" })).toEqual({
      ok: false,
      errors: { percent: PERCENT_MESSAGE },
    });
    expect(checkTdsForm({ code: " ", percent: "10" })).toEqual({
      ok: false,
      errors: { code: "Enter the employee code." },
    });
  });
});

describe("the server's answers", () => {
  const apiError = (status: number, data: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, data });

  it("reads the human message and the machine code", () => {
    expect(serverProblem(apiError(404, { error: "No employee with code 'X'.", code: "employee_not_found" }))).toEqual({
      message: "No employee with code 'X'.",
      code: "employee_not_found",
      status: 404,
    });
    expect(
      serverProblem(
        apiError(409, { error: "UK001 is already in TDS (10%). Edit the percentage instead.", code: "already_in_tds" }),
      ),
    ).toMatchObject({ code: "already_in_tds", status: 409 });
  });

  it("prefers `message` over a machine `error` code, and uses the code as the code", () => {
    expect(
      serverProblem(
        apiError(403, { error: "permission_denied", message: "Only the Super Admin can change PF / ESI rules." }),
      ),
    ).toEqual({ message: "Only the Super Admin can change PF / ESI rules.", code: "permission_denied", status: 403 });
  });

  it("never shows a bare machine code or a status line", () => {
    expect(serverProblem(apiError(403, { error: "permission_denied" })).message).toBe(
      "You do not have permission to do this.",
    );
    expect(serverProblem(apiError(500, null)).message).toBe("The server could not do this. Please try again.");
    expect(serverProblem(new TypeError("Failed to fetch")).message).toBe(
      "Could not reach the server. Check the connection and try again.",
    );
    expect(serverProblem("nonsense").message).toBe("Could not reach the server. Check the connection and try again.");
  });

  it("puts each message under the field it is about", () => {
    const of = (message: string, code: string | null = null) => tdsProblemField({ message, code, status: 400 });
    expect(of("x", "employee_not_found")).toBe("code");
    expect(of("x", "employee_inactive")).toBe("code");
    expect(of("x", "already_in_tds")).toBe("code");
    expect(of("Percentage must be greater than 0 and at most 100 (2 decimals).")).toBe("percent");
    expect(of("employeeCode is required")).toBe("code");
    expect(of("Something else")).toBe("form");
  });
});

describe("what the user is told", () => {
  it("says whether the employee was moved out of PF/ESI", () => {
    const moved = addedMessage({ employee: tdsRow({ employeeCode: "UK001", tdsPercent: 10 }), movedFromPfEsi: true });
    expect(moved.title).toBe("UK001 moved from PF/ESI to TDS at 10%");
    const plain = addedMessage({ employee: tdsRow({ employeeCode: "UK002", tdsPercent: 7.5 }), movedFromPfEsi: false });
    expect(plain.title).toBe("UK002 added to TDS at 7.5%");
    expect(plain.description).toContain("7.5%");
  });

  it("explains what removing from TDS leads to", () => {
    const wording = removeWording({ employeeCode: "UK007", name: "Ravi Nair" });
    expect(wording.title).toBe("Remove UK007 from TDS?");
    expect(wording.lines.join(" ")).toMatch(/no PF\/ESI and no TDS/);
  });
});

describe("the coverage strip", () => {
  const data = (over: Partial<CoverageResponse> = {}): CoverageResponse => ({
    asOf: "2026-10-24T10:00:00Z",
    filters: { type: "all", branchId: null },
    staff: counts(),
    production: counts({ total: 5, coEmp: 2, notEvaluated: 1, withAny: 1, withNeither: 0 }),
    ...over,
  });

  it("has the seven columns the owner listed, in order", () => {
    expect(STRIP_COLUMNS.map((c) => c.key)).toEqual([
      "coEmp",
      "withPf",
      "withEsi",
      "withBoth",
      "withNeither",
      "tds",
      "notCoEmp",
    ]);
  });

  it("lists Staff first and only the classes the report answered with", () => {
    expect(stripRows(data()).map((r) => r.cls)).toEqual(["staff", "production"]);
    expect(stripRows(data({ production: undefined })).map((r) => r.cls)).toEqual(["staff"]);
    expect(stripRows(data({ staff: undefined })).map((r) => r.label)).toEqual(["Production"]);
    expect(stripRows(undefined)).toEqual([]);
  });

  it("warns about production Co Emp employees with no payroll yet, and says nothing otherwise", () => {
    expect(notEvaluatedNote(stripRows(data()))).toBe(
      "1 Co Emp employee has no payroll generated yet, so their PF/ESI is not counted above.",
    );
    expect(notEvaluatedNote(stripRows(data({ staff: counts({ notEvaluated: 2 }) })))).toMatch(
      /^3 Co Emp employees have/,
    );
    expect(notEvaluatedNote(stripRows(data({ production: counts() })))).toBeNull();
    expect(notEvaluatedNote([])).toBeNull();
  });
});

describe("pages of a short list", () => {
  const rows = Array.from({ length: 23 }, (_, i) => i + 1);

  it("slices a page and counts the pages", () => {
    expect(pageOf(rows, 1, 10)).toEqual({ rows: rows.slice(0, 10), page: 1, totalPages: 3 });
    expect(pageOf(rows, 3, 10)).toEqual({ rows: [21, 22, 23], page: 3, totalPages: 3 });
  });

  it("clamps a page that no longer exists, and an empty list is one empty page", () => {
    expect(pageOf(rows, 9, 10).page).toBe(3);
    expect(pageOf(rows, 0, 10).page).toBe(1);
    expect(pageOf([], 4, 10)).toEqual({ rows: [], page: 1, totalPages: 1 });
  });
});
