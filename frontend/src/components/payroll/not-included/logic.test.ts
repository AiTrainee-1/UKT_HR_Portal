import { describe, expect, it } from "vitest";
import type { NotIncludedEmployee, PeriodNotIncluded } from "@/lib/api-client/custom-hooks";
import {
  ALL,
  DEFAULT_NOT_INCLUDED_FILTERS,
  NOT_INCLUDED_COLUMNS,
  NOT_INCLUDED_URL_DEFAULTS,
  PRODUCTION_NOT_INCLUDED_URL_DEFAULTS,
  categoryLabel,
  defaultNotIncludedFilters,
  filterNotIncluded,
  filterOptions,
  listedNoun,
  notIncludedColumns,
  notIncludedCount,
  notIncludedFileStem,
  notIncludedFilterCount,
  notIncludedFiltersFromUrl,
  notIncludedFiltersToUrl,
  notIncludedUrlDefaults,
  pickReason,
  reasonChips,
  reasonMeta,
  statusLabel,
} from "./logic";

// The pure part of the "Not included" view (Staff Payroll: one month; a Production Payroll cycle page: one pay period).

const person = (id: number, over: Partial<NotIncludedEmployee> = {}): NotIncludedEmployee => ({
  id,
  code: `E${id}`,
  name: `Name ${id}`,
  category: "staff",
  status: "active",
  departmentId: 3,
  department: "ACCOUNTS",
  designationId: 5,
  designation: "ACCOUNTANT",
  branchId: 1,
  unit: "HO",
  joinDate: "2025-04-21",
  reasonCode: "on_hold",
  reason: "Salary on hold for the month.",
  detail: null,
  payrollId: null,
  ...over,
});

const PEOPLE = [
  person(1, { name: "Asha Kumar", code: "2552", status: "inactive", reasonCode: "inactive" }),
  person(2, { reasonCode: "not_generated" }),
  person(3, { category: "production", reasonCode: "production", departmentId: 4, designationId: 6 }),
  person(4, { reasonCode: "no_salary", departmentId: null, designationId: null }),
];

describe("the filters in the address", () => {
  it("opens each page on its own employees: Staff on Staff Payroll, Production on a cycle page", () => {
    expect(NOT_INCLUDED_URL_DEFAULTS.nicat).toBe("staff");
    expect(PRODUCTION_NOT_INCLUDED_URL_DEFAULTS.nicat).toBe("production");
    expect(notIncludedUrlDefaults("production")).toBe(PRODUCTION_NOT_INCLUDED_URL_DEFAULTS);
    expect(notIncludedFiltersFromUrl({}).category).toBe("staff");
    expect(notIncludedFiltersFromUrl({}, "production").category).toBe("production");
    expect(notIncludedFiltersFromUrl({ nicat: "weird" }, "production").category).toBe("production");
    expect(notIncludedFiltersFromUrl({ nicat: ALL }, "production").category).toBe(ALL);
    expect(defaultNotIncludedFilters("production")).toEqual({
      ...DEFAULT_NOT_INCLUDED_FILTERS,
      category: "production",
    });
  });

  it("reads and writes every key, prefixed ni", () => {
    const f = notIncludedFiltersFromUrl({
      niq: "asha",
      nidept: "3",
      nidesig: "5",
      nistatus: "inactive",
      nicat: "staff",
      nireason: "inactive",
    });
    expect(f).toEqual({ q: "asha", dept: "3", desig: "5", status: "inactive", category: "staff", reason: "inactive" });
    expect(notIncludedFiltersFromUrl({ nistatus: "gone" }).status).toBe(ALL);
    expect(notIncludedFiltersToUrl({ category: "production", reason: ALL })).toEqual({
      nicat: "production",
      nireason: ALL,
    });
  });

  it("counts the filters set, the category only when it is not the page's own", () => {
    expect(notIncludedFilterCount(DEFAULT_NOT_INCLUDED_FILTERS)).toBe(0);
    expect(notIncludedFilterCount({ ...DEFAULT_NOT_INCLUDED_FILTERS, category: "production" })).toBe(1);
    expect(notIncludedFilterCount(defaultNotIncludedFilters("production"), "production")).toBe(0);
    expect(notIncludedFilterCount({ ...DEFAULT_NOT_INCLUDED_FILTERS, category: "staff" }, "production")).toBe(1);
    expect(
      notIncludedFilterCount({ q: "x", dept: "1", desig: "2", status: "active", category: ALL, reason: "skipped" }),
    ).toBe(6);
  });
});

describe("which employees are listed", () => {
  it("keeps to the category, the reason, the status, the department and designation and the search", () => {
    const ids = (f: Partial<typeof DEFAULT_NOT_INCLUDED_FILTERS>) =>
      filterNotIncluded(PEOPLE, { ...DEFAULT_NOT_INCLUDED_FILTERS, ...f }).map((e) => e.id);
    expect(ids({})).toEqual([1, 2, 4]);
    expect(ids({ category: "production" })).toEqual([3]);
    expect(ids({ category: ALL })).toEqual([1, 2, 3, 4]);
    expect(ids({ status: "inactive" })).toEqual([1]);
    expect(ids({ status: "active" })).toEqual([2, 4]);
    expect(ids({ reason: "no_salary" })).toEqual([4]);
    expect(ids({ dept: "3" })).toEqual([1, 2]);
    expect(ids({ desig: "5" })).toEqual([1, 2]);
    expect(ids({ q: "asha 2552" })).toEqual([1]);
  });

  it("leaves the ones only waiting out of a month not generated yet, unless that reason is picked", () => {
    const f = DEFAULT_NOT_INCLUDED_FILTERS;
    expect(filterNotIncluded(PEOPLE, f, { hideWaiting: true }).map((e) => e.id)).toEqual([1, 4]);
    expect(
      filterNotIncluded(PEOPLE, { ...f, reason: "not_generated" }, { hideWaiting: true }).map((e) => e.id),
    ).toEqual([2]);
  });

  it("counts what the view opens on, for the view switch", () => {
    const data = { employees: PEOPLE, generated: true } as Pick<PeriodNotIncluded, "employees" | "generated">;
    expect(notIncludedCount(data, "staff")).toBe(3);
    expect(notIncludedCount(data, "production")).toBe(1);
    expect(notIncludedCount({ ...data, generated: false }, "staff")).toBe(2);
    expect(notIncludedCount(undefined, "staff")).toBeNull();
  });

  it("offers the departments and designations of the category listed, and the one chosen", () => {
    const data = {
      employees: PEOPLE,
      departments: [
        { id: 4, name: "WEAVING" },
        { id: 3, name: "ACCOUNTS" },
        { id: 9, name: "EMPTY" },
      ],
      designations: [
        { id: 5, title: "ACCOUNTANT" },
        { id: 6, title: "WEAVER" },
      ],
    };
    const staff = filterOptions(data, { category: "staff", dept: ALL, desig: ALL });
    expect(staff.departments.map((o) => o.label)).toEqual(["ACCOUNTS"]);
    expect(staff.designations.map((o) => o.label)).toEqual(["ACCOUNTANT"]);
    const kept = filterOptions(data, { category: "staff", dept: "9", desig: ALL });
    expect(kept.departments.map((o) => o.label)).toEqual(["ACCOUNTS", "EMPTY"]);
    expect(filterOptions(null, DEFAULT_NOT_INCLUDED_FILTERS)).toEqual({ departments: [], designations: [] });
  });
});

describe("the reasons", () => {
  it("reads each reason in the page's words", () => {
    expect(reasonMeta("on_hold").label).toBe("On hold");
    expect(reasonMeta("no_salary").hint).toBe("Set a monthly salary on the employee's profile.");
    expect(reasonMeta("no_salary", "production")).toMatchObject({
      label: "No rate per shift",
      hint: "Set a salary per shift on the employee's profile.",
    });
    expect(reasonMeta("joined_after", "production").hint).toBe("Joined after the period ended.");
    expect(reasonMeta("other_cycle", "production").label).toBe("Other pay cycle");
    expect(reasonMeta("no_cycle", "production").label).toBe("No pay cycle");
    expect(reasonMeta("staff", "production").hint).toBe("Paid on the Staff Payroll.");
    // a code the screen does not know yet
    expect(reasonMeta("left_company")).toEqual({ label: "Left company", tone: "neutral", hint: "" });
    expect(reasonMeta(null).label).toBe("Other");
  });

  it("makes one chip per reason that has someone, the ones HR can act on first", () => {
    const chips = reasonChips({ production: 18, inactive: 4, not_generated: 1, skipped: 0, zz_new: 2 });
    expect(chips.map((c) => [c.code, c.count])).toEqual([
      ["not_generated", 1],
      ["inactive", 4],
      ["production", 18],
      ["zz_new", 2],
    ]);
    expect(reasonChips(null)).toEqual([]);
    expect(reasonChips({ no_salary: 1 }, "production")[0].label).toBe("No rate per shift");
  });

  it("moves the category with the reason of the other payroll, on each page", () => {
    const staffPage = DEFAULT_NOT_INCLUDED_FILTERS;
    expect(pickReason(staffPage, "production")).toEqual({ reason: "production", category: "production" });
    expect(pickReason({ ...staffPage, category: "production" }, "inactive")).toEqual({
      reason: "inactive",
      category: "staff",
    });
    expect(pickReason({ ...staffPage, reason: "inactive" }, "inactive")).toEqual({ reason: ALL });
    expect(pickReason({ ...staffPage, category: ALL }, "production")).toEqual({ reason: "production", category: ALL });

    const cyclePage = defaultNotIncludedFilters("production");
    expect(pickReason(cyclePage, "staff", "production")).toEqual({ reason: "staff", category: "staff" });
    expect(pickReason({ ...cyclePage, category: "staff" }, "other_cycle", "production")).toEqual({
      reason: "other_cycle",
      category: "production",
    });
  });
});

describe("labels and the export", () => {
  it("names categories, statuses and what the list counts", () => {
    expect(categoryLabel("production")).toBe("Production");
    expect(categoryLabel("staff")).toBe("Staff");
    expect(categoryLabel(null)).toBe("—");
    expect(statusLabel({ status: " Active " })).toBe("Active");
    expect(statusLabel({ status: "inactive" })).toBe("Inactive");
    expect(listedNoun("staff")).toBe("staff employee");
    expect(listedNoun("production")).toBe("production employee");
    expect(listedNoun(ALL)).toBe("employee");
  });

  it("exports the reason in the page's words, and names the file after the month or the period", () => {
    const reasonColumn = notIncludedColumns("production").find((c) => c.key === "reasonCode")!;
    expect(reasonColumn.value!(person(1, { reasonCode: "no_salary" }))).toBe("No rate per shift");
    expect(NOT_INCLUDED_COLUMNS.map((c) => c.label)).toContain("Reason");
    expect(notIncludedFileStem({ kind: "staff", month: 11, year: 2026 })).toBe("Not_included_November_2026");
    expect(
      notIncludedFileStem({ kind: "production", cycle: "weekly", periodStart: "2026-11-02", periodEnd: "2026-11-08" }),
    ).toBe("Not_included_Weekly_2026_11_02_2026_11_08");
  });
});
