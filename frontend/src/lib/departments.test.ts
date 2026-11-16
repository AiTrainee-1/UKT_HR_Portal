import { describe, expect, it } from "vitest";
import {
  categoryForEmploymentType,
  departmentOptions,
  designationOptions,
  groupByCategory,
  hasBothCategories,
  inCategory,
  keepIfOffered,
  matchesNamedOrgOption,
  namedOrgOptions,
  optionText,
  orgCategoryOf,
  type OrgDepartment,
  type OrgDesignation,
} from "./departments";

// Two branches, and a CUTTING for staff AND for production in Unit1 (the split the owner asked for).
const DEPTS: OrgDepartment[] = [
  { id: 24, name: "CUTTING", category: "staff", branchId: 4, branchName: "Unit1" },
  { id: 68, name: "CUTTING", category: "production", branchId: 4, branchName: "Unit1" },
  { id: 30, name: "CUTTING", category: "staff", branchId: 1, branchName: "Head Office" },
  { id: 5, name: "accounts", category: "staff", branchId: 1, branchName: "Head Office" },
  { id: 7, name: "SEWING", category: "production", branchId: 4, branchName: "Unit1" },
  // an older server sends no category: Staff
  { id: 9, name: "HR", branchId: 1, branchName: "Head Office" },
];

const DESIGS: OrgDesignation[] = [
  { id: 1, title: "Tailor", departmentId: 7, departmentName: "SEWING", category: "production" },
  { id: 2, title: "Manager", departmentId: 24, departmentName: "CUTTING", category: "staff" },
  { id: 3, title: "Manager", departmentId: 5, departmentName: "accounts", category: "staff" },
  { id: 4, title: "Helper", departmentId: null, category: "production" },
];

describe("categories", () => {
  it("treats a row with no category as Staff", () => {
    expect(orgCategoryOf({})).toBe("staff");
    expect(orgCategoryOf(null)).toBe("staff");
    expect(orgCategoryOf({ category: "production" })).toBe("production");
  });
  it("maps an employment type or filter value to a kind, null for both", () => {
    expect(categoryForEmploymentType("staff")).toBe("staff");
    expect(categoryForEmploymentType(" Production ")).toBe("production");
    expect(categoryForEmploymentType("Production Employees")).toBe("production");
    expect(categoryForEmploymentType("all")).toBeNull();
    expect(categoryForEmploymentType("")).toBeNull();
    expect(categoryForEmploymentType(undefined)).toBeNull();
  });
  it("keeps one kind, or everything without one", () => {
    expect(inCategory(DEPTS, "production").map((d) => d.id)).toEqual([68, 7]);
    expect(inCategory(DEPTS, null)).toHaveLength(DEPTS.length);
    expect(inCategory(undefined, "staff")).toEqual([]);
  });
  it("groups Staff first, leaves empty groups out, and narrows to one group", () => {
    expect(groupByCategory(DEPTS).map((g) => [g.label, g.items.length])).toEqual([
      ["Staff", 4],
      ["Production", 2],
    ]);
    expect(groupByCategory(DEPTS, "production").map((g) => g.label)).toEqual(["Production"]);
    expect(groupByCategory(inCategory(DEPTS, "staff")).map((g) => g.label)).toEqual(["Staff"]);
  });
});

describe("departmentOptions", () => {
  it("offers only the page's kind, sorted by name, ids as values", () => {
    const prod = departmentOptions(DEPTS, { category: "production" });
    expect(prod.map((o) => [o.value, o.label])).toEqual([
      ["68", "CUTTING"],
      ["7", "SEWING"],
    ]);
    expect(hasBothCategories(prod)).toBe(false);
  });
  it("tells the same name in two branches apart by the branch, within one kind only", () => {
    const staff = departmentOptions(DEPTS, { category: "staff" });
    expect(staff.map((o) => o.label)).toEqual(["accounts", "CUTTING · Head Office", "CUTTING · Unit1", "HR"]);
  });
  it("offers both kinds for an everyone page, each under its heading", () => {
    const all = departmentOptions(DEPTS);
    expect(hasBothCategories(all)).toBe(true);
    const unit1Cutting = all.filter((o) => o.name === "CUTTING" && o.branchId === 4);
    expect(unit1Cutting.map((o) => [o.group, o.value]).sort()).toEqual([
      ["Production", "68"],
      ["Staff", "24"],
    ]);
    // the production CUTTING is the only one of its kind: no branch needed on it
    expect(all.find((o) => o.value === "68")?.label).toBe("CUTTING");
    expect(
      optionText(
        all.find((o) => o.value === "68")!,
        true,
      ),
    ).toBe("CUTTING (Production)");
    expect(
      optionText(
        all.find((o) => o.value === "68")!,
        false,
      ),
    ).toBe("CUTTING");
  });
  it("narrows to a branch", () => {
    expect(departmentOptions(DEPTS, { branchId: 4 }).map((o) => o.value)).toEqual(["24", "68", "7"]);
  });
});

describe("designationOptions", () => {
  it("offers one kind, or one department's", () => {
    expect(designationOptions(DESIGS, { category: "production" }).map((o) => o.label)).toEqual(["Helper", "Tailor"]);
    expect(designationOptions(DESIGS, { departmentId: 24 }).map((o) => o.value)).toEqual(["2"]);
  });
  it("names the department when a title repeats in one kind", () => {
    expect(designationOptions(DESIGS, { category: "staff" }).map((o) => o.label)).toEqual([
      "Manager · accounts",
      "Manager · CUTTING",
    ]);
  });
});

describe("keepIfOffered", () => {
  it("drops a pick of the other kind when the page's type switches", () => {
    const prod = departmentOptions(DEPTS, { category: "production" });
    expect(keepIfOffered("68", prod, "all")).toBe("68");
    expect(keepIfOffered(24, prod, "all")).toBe("all");
    expect(keepIfOffered("", prod, null)).toBeNull();
    expect(keepIfOffered(undefined, prod, "")).toBe("");
  });
});

describe("namedOrgOptions", () => {
  // rows that only carry the department's NAME and the employee's type (a request list, say)
  const rows = [
    { dept: "CUTTING", type: "staff" },
    { dept: "CUTTING", type: "production" },
    { dept: "CUTTING", type: "production" },
    { dept: " Sewing ", type: "production" },
    { dept: null, type: "staff" },
    { dept: "Accounts", type: undefined },
  ];
  const opts = namedOrgOptions(
    rows,
    (r) => r.dept,
    (r) => r.type,
  );
  it("lists each name once per kind", () => {
    expect(opts.map((o) => o.value)).toEqual([
      "staff|Accounts",
      "production|CUTTING",
      "staff|CUTTING",
      "production|Sewing",
    ]);
    expect(hasBothCategories(opts)).toBe(true);
  });
  it("narrows to one kind", () => {
    expect(
      namedOrgOptions(
        rows,
        (r) => r.dept,
        (r) => r.type,
        "production",
      ).map((o) => o.label),
    ).toEqual(["CUTTING", "Sewing"]);
  });
  it("matches rows by name AND kind", () => {
    expect(matchesNamedOrgOption("production|CUTTING", "CUTTING", "production")).toBe(true);
    expect(matchesNamedOrgOption("production|CUTTING", "CUTTING", "staff")).toBe(false);
    expect(matchesNamedOrgOption("staff|Accounts", "Accounts", null)).toBe(true);
    expect(matchesNamedOrgOption("all", "anything", "staff")).toBe(true);
    expect(matchesNamedOrgOption("", "anything", "staff")).toBe(true);
    // a plain name saved before the split still matches by name
    expect(matchesNamedOrgOption("CUTTING", "CUTTING", "production")).toBe(true);
  });
});
