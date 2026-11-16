import { describe, expect, it } from "vitest";
import type { NamedOption } from "@/lib/report-center";
import { orgFilterOptions, prunePicked, reportOrgKind } from "./org-options";

const DEPARTMENTS: NamedOption[] = [
  { id: 1, name: "CUTTING", category: "staff", branchId: 4, branchName: "Unit1" },
  { id: 2, name: "CUTTING", category: "production", branchId: 4, branchName: "Unit1" },
  { id: 3, name: "ADMIN", category: "staff", branchId: 4, branchName: "Unit1" },
  { id: 4, name: "SEWING", category: "production", branchId: 4, branchName: "Unit1" },
  { id: 5, name: "SEWING", category: "production", branchId: 7, branchName: "Unit2" },
];

describe("report filters: Staff / Production departments and designations", () => {
  it("reads the report's Employee type", () => {
    expect(reportOrgKind("production")).toBe("production");
    expect(reportOrgKind("staff")).toBe("staff");
    expect(reportOrgKind("")).toBeNull();
    expect(reportOrgKind(undefined)).toBeNull();
    expect(reportOrgKind(["staff"])).toBeNull();
  });

  it("offers only one kind when the type is picked", () => {
    const staff = orgFilterOptions("department", DEPARTMENTS, "staff");
    expect(staff.map((o) => o.value)).toEqual(["3", "1"]);
    expect(staff.every((o) => o.group === undefined)).toBe(true);
    const production = orgFilterOptions("department", DEPARTMENTS, "production");
    // the two SEWINGs of one kind are told apart by their branch
    expect(production.map((o) => o.label)).toEqual(["CUTTING", "SEWING · Unit1", "SEWING · Unit2"]);
  });

  it("groups both kinds, Staff first, when no type is picked", () => {
    const both = orgFilterOptions("department", DEPARTMENTS, null);
    expect(both.map((o) => [o.group, o.label])).toEqual([
      ["Staff", "ADMIN"],
      ["Staff", "CUTTING"],
      ["Production", "CUTTING"],
      ["Production", "SEWING · Unit1"],
      ["Production", "SEWING · Unit2"],
    ]);
  });

  it("treats an option from an older server (no category) as Staff, ungrouped", () => {
    const old = orgFilterOptions("department", [{ id: 9, name: "Sales" }], null);
    expect(old).toEqual([{ value: "9", label: "Sales" }]);
  });

  it("filters designations by kind too", () => {
    const desigs: NamedOption[] = [
      { id: 11, name: "Tailor", category: "production", departmentId: 2 },
      { id: 12, name: "Clerk", category: "staff", departmentId: 3 },
    ];
    expect(orgFilterOptions("designation", desigs, "production").map((o) => o.value)).toEqual(["11"]);
    expect(orgFilterOptions("designation", desigs, null).map((o) => o.group)).toEqual(["Staff", "Production"]);
  });

  it("drops picked values the new kind does not offer", () => {
    const production = orgFilterOptions("department", DEPARTMENTS, "production");
    expect(prunePicked(["1", "2", "4"], production)).toEqual(["2", "4"]);
    expect(prunePicked([], production)).toEqual([]);
  });
});
