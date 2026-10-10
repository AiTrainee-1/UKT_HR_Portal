import { describe, expect, it } from "vitest";
import type { DepartmentRow, DesignationRow, DesignationsTree, Person } from "./api";
import {
  NONE,
  NO_DEPT_FILTERS,
  NO_DESIG_FILTERS,
  NO_PEOPLE_FILTERS,
  allNodeKeys,
  buildTree,
  departmentDeleteImpact,
  departmentSheet,
  designationDeleteImpact,
  designationSheet,
  deptFiltersActive,
  desigFiltersActive,
  filterDepartments,
  filterDesignations,
  filterPeople,
  initials,
  levelInfo,
  matchesAll,
  plural,
  sortDepartments,
  sortDesignations,
  splitPercent,
  summarizeDepartments,
  summarizeDesignations,
  summarizePeople,
} from "./logic";

const hc = (staff = 0, production = 0, inactive = 0) => ({
  activeStaff: staff,
  activeProduction: production,
  activeOther: 0,
  active: staff + production,
  inactive,
});

const dept = (
  id: number,
  name: string,
  branchId: number | null,
  branchName: string | null,
  h = hc(),
  extra = {},
): DepartmentRow => ({
  id,
  name,
  description: null,
  branchId,
  branchName,
  designationCount: 0,
  hodCount: 0,
  createdAt: null,
  ...h,
  ...extra,
});

const desig = (
  id: number,
  title: string,
  level: string | null,
  d: { id: number; name: string; branchId: number; branchName: string } | null,
  h = hc(),
): DesignationRow => ({
  id,
  title,
  level,
  departmentId: d?.id ?? null,
  departmentName: d?.name ?? null,
  branchId: d?.branchId ?? null,
  branchName: d?.branchName ?? null,
  createdAt: null,
  ...h,
});

const HO = { id: 1, name: "Head Office" };
const U2 = { id: 2, name: "Unit 2" };
const cutting = { id: 10, name: "Cutting", branchId: 1, branchName: "Head Office" };
const sewing = { id: 11, name: "Sewing", branchId: 2, branchName: "Unit 2" };

const TREE: DesignationsTree = {
  branches: [U2, HO, { id: 3, name: "Unit 3" }],
  departments: [
    { id: 10, name: "Cutting", branchId: 1, branchName: "Head Office", active: 7 },
    { id: 12, name: "Admin", branchId: 1, branchName: "Head Office", active: 0 },
    { id: 11, name: "Sewing", branchId: 2, branchName: "Unit 2", active: 2 },
    { id: 13, name: "Stray", branchId: null, branchName: null, active: 0 },
  ],
  designations: [
    desig(1, "Master", "senior", cutting, hc(2, 0)),
    desig(2, "Helper", "junior", cutting, hc(0, 3, 1)),
    desig(3, "Tailor", "mid", sewing, hc(1, 1)),
    desig(4, "Floating", "manager", null, hc()),
    desig(5, "Legacy", "staff", sewing, hc()),
  ],
  unassigned: { active: 4, staff: 3, production: 1 },
};

describe("matchesAll", () => {
  it("needs every word, in any order and case", () => {
    expect(matchesAll(["Senior Tailor", "Sewing"], "tailor sew")).toBe(true);
    expect(matchesAll(["Senior Tailor", "Sewing"], "SEWING senior")).toBe(true);
    expect(matchesAll(["Senior Tailor", "Sewing"], "tailor cutting")).toBe(false);
  });
  it("matches everything for a blank query and ignores empty parts", () => {
    expect(matchesAll([null, undefined], "")).toBe(true);
    expect(matchesAll([null, "x"], "   ")).toBe(true);
    expect(matchesAll([null], "x")).toBe(false);
  });
});

describe("splitPercent", () => {
  it("adds up to 100 and is 0/0 for an empty department", () => {
    expect(splitPercent(2, 1)).toEqual({ staff: 67, production: 33 });
    expect(splitPercent(1, 1)).toEqual({ staff: 50, production: 50 });
    expect(splitPercent(0, 5)).toEqual({ staff: 0, production: 100 });
    expect(splitPercent(0, 0)).toEqual({ staff: 0, production: 0 });
    const { staff, production } = splitPercent(1, 6);
    expect(staff + production).toBe(100);
  });
});

describe("plural", () => {
  it("handles one, many and an explicit plural", () => {
    expect(plural(1, "employee")).toBe("1 employee");
    expect(plural(0, "employee")).toBe("0 employees");
    expect(plural(2, "head of department", "heads of department")).toBe("2 heads of department");
  });
});

const DEPTS: DepartmentRow[] = [
  dept(1, "Cutting", 1, "Head Office", hc(2, 3, 1), { description: "Cut room" }),
  dept(2, "Admin", 1, "Head Office", hc(4, 0)),
  dept(3, "Sewing", 2, "Unit 2", hc(1, 9)),
  dept(4, "Store", 2, "Unit 2", hc()),
  dept(5, "Loose", null, null, hc(0, 0)),
];

describe("departments", () => {
  it("filters by search over name, description and branch", () => {
    const f = (query: string) => filterDepartments(DEPTS, { ...NO_DEPT_FILTERS, query }).map((d) => d.name);
    expect(f("cut")).toEqual(["Cutting"]);
    expect(f("cut room")).toEqual(["Cutting"]);
    expect(f("unit 2")).toEqual(["Sewing", "Store"]);
    expect(f("admin head")).toEqual(["Admin"]);
  });
  it("filters by branch, including departments with none", () => {
    expect(filterDepartments(DEPTS, { ...NO_DEPT_FILTERS, branch: "2" }).map((d) => d.name)).toEqual([
      "Sewing",
      "Store",
    ]);
    expect(filterDepartments(DEPTS, { ...NO_DEPT_FILTERS, branch: NONE }).map((d) => d.name)).toEqual(["Loose"]);
  });
  it("filters by whether anyone active is in it", () => {
    expect(filterDepartments(DEPTS, { ...NO_DEPT_FILTERS, show: "empty" }).map((d) => d.name)).toEqual([
      "Store",
      "Loose",
    ]);
    expect(filterDepartments(DEPTS, { ...NO_DEPT_FILTERS, show: "with" })).toHaveLength(3);
  });
  it("reports whether any filter is on", () => {
    expect(deptFiltersActive(NO_DEPT_FILTERS)).toBe(false);
    expect(deptFiltersActive({ ...NO_DEPT_FILTERS, query: " " })).toBe(false);
    expect(deptFiltersActive({ ...NO_DEPT_FILTERS, show: "empty" })).toBe(true);
  });
  it("sorts by name and head-count, ties by name, without touching the input", () => {
    const names = (s: Parameters<typeof sortDepartments>[1]) => sortDepartments(DEPTS, s).map((d) => d.name);
    expect(names("name-asc")).toEqual(["Admin", "Cutting", "Loose", "Sewing", "Store"]);
    expect(names("name-desc")).toEqual(["Store", "Sewing", "Loose", "Cutting", "Admin"]);
    expect(names("total-desc")).toEqual(["Sewing", "Cutting", "Admin", "Loose", "Store"]);
    expect(names("total-asc")).toEqual(["Loose", "Store", "Admin", "Cutting", "Sewing"]);
    expect(names("staff-desc")).toEqual(["Admin", "Cutting", "Sewing", "Loose", "Store"]);
    expect(names("production-desc")).toEqual(["Sewing", "Cutting", "Admin", "Loose", "Store"]);
    expect(DEPTS[0].name).toBe("Cutting");
  });
  it("summarizes the company", () => {
    expect(summarizeDepartments(DEPTS, { active: 6, staff: 5, production: 1 })).toEqual({
      departments: 5,
      branches: 3,
      active: 19,
      staff: 7,
      production: 12,
      inactive: 1,
      empty: 2,
      unassigned: 6,
    });
    expect(summarizeDepartments([], undefined)).toMatchObject({
      departments: 0,
      branches: 0,
      active: 0,
      unassigned: 0,
    });
  });
  it("explains what a delete does", () => {
    const lines = departmentDeleteImpact(
      dept(1, "Cutting", 1, "HO", hc(2, 3, 1), { designationCount: 2, hodCount: 1 }),
    );
    expect(lines[0]).toContain("6 employees (5 active, 1 inactive) will be left with no department");
    expect(lines[1]).toContain("2 designations will lose their department");
    expect(lines[2]).toContain("1 head of department");
    expect(lines.at(-1)).toContain("deleted with it");
    expect(departmentDeleteImpact(dept(2, "Empty", 1, "HO"))).toEqual([
      "Nobody is in this department.",
      "Its required-role targets, hiring rules and department chat channel are deleted with it.",
    ]);
  });
  it("lays the export out as a header and a row each", () => {
    const sheet = departmentSheet(DEPTS.slice(0, 1));
    expect(sheet[0]).toHaveLength(8);
    expect(sheet[1]).toEqual(["Cutting", "Head Office", "Cut room", 2, 3, 5, 1, 0]);
  });
});

describe("levelInfo", () => {
  it("knows the five levels and ranks them", () => {
    expect(levelInfo("junior")).toMatchObject({ key: "junior", label: "Junior", rank: 0 });
    expect(levelInfo(" Executive ")).toMatchObject({ key: "executive", label: "Executive", rank: 4 });
  });
  it("treats blank and the old server default 'staff' as not set", () => {
    for (const raw of [null, undefined, "", "  ", "staff", "Staff"]) {
      expect(levelInfo(raw)).toMatchObject({ key: "", label: "Not set", rank: 99 });
    }
  });
  it("keeps a free-text level as typed", () => {
    expect(levelInfo("operator")).toMatchObject({ key: "operator", label: "Operator", rank: 50 });
  });
});

describe("designations", () => {
  const titles = (f: Partial<typeof NO_DESIG_FILTERS>) =>
    filterDesignations(TREE.designations, { ...NO_DESIG_FILTERS, ...f }).map((d) => d.title);

  it("searches designation, department, branch and level", () => {
    expect(titles({ query: "tailor" })).toEqual(["Tailor"]);
    expect(titles({ query: "cutting" })).toEqual(["Master", "Helper"]);
    expect(titles({ query: "head office" })).toEqual(["Master", "Helper"]);
    expect(titles({ query: "senior cutting" })).toEqual(["Master"]);
    expect(titles({ query: "nothing here" })).toEqual([]);
  });
  it("filters by branch, department and level, including 'none'", () => {
    expect(titles({ branch: "2" })).toEqual(["Tailor", "Legacy"]);
    expect(titles({ branch: NONE })).toEqual(["Floating"]);
    expect(titles({ department: "10" })).toEqual(["Master", "Helper"]);
    expect(titles({ department: NONE })).toEqual(["Floating"]);
    expect(titles({ level: "junior" })).toEqual(["Helper"]);
    expect(titles({ level: NONE })).toEqual(["Legacy"]);
  });
  it("filters designations nobody holds", () => {
    expect(titles({ empty: true })).toEqual(["Floating", "Legacy"]);
  });
  it("combines filters", () => {
    expect(titles({ branch: "1", level: "senior", query: "mas" })).toEqual(["Master"]);
    expect(titles({ branch: "1", level: "mid" })).toEqual([]);
  });
  it("reports whether any filter is on", () => {
    expect(desigFiltersActive(NO_DESIG_FILTERS)).toBe(false);
    expect(desigFiltersActive({ ...NO_DESIG_FILTERS, empty: true })).toBe(true);
    expect(desigFiltersActive({ ...NO_DESIG_FILTERS, level: NONE })).toBe(true);
  });
  it("sorts", () => {
    const order = (s: Parameters<typeof sortDesignations>[1]) =>
      sortDesignations(TREE.designations, s).map((d) => d.title);
    expect(order("title-asc")).toEqual(["Floating", "Helper", "Legacy", "Master", "Tailor"]);
    expect(order("title-desc")).toEqual(["Tailor", "Master", "Legacy", "Helper", "Floating"]);
    expect(order("department")).toEqual(["Helper", "Master", "Legacy", "Tailor", "Floating"]);
    expect(order("level")).toEqual(["Helper", "Tailor", "Master", "Floating", "Legacy"]);
    expect(order("employees-desc")).toEqual(["Helper", "Master", "Tailor", "Floating", "Legacy"]);
    expect(order("employees-asc")[0]).toBe("Floating");
  });
  it("summarizes", () => {
    expect(summarizeDesignations(TREE)).toEqual({
      designations: 5,
      departments: 2,
      active: 7,
      staff: 3,
      production: 4,
      empty: 2,
      unassigned: 4,
    });
  });
  it("explains what a delete does", () => {
    expect(designationDeleteImpact(TREE.designations[1])[0]).toContain(
      "4 employees (3 active, 1 inactive) will be left with no designation",
    );
    expect(designationDeleteImpact(TREE.designations[3])).toEqual(["Nobody holds this designation."]);
  });
  it("lays the export out with Unassigned for a designation with no department", () => {
    const sheet = designationSheet([TREE.designations[3], TREE.designations[0]]);
    expect(sheet[1]).toEqual(["", "Unassigned", "Floating", "Manager", 0, 0, 0, 0]);
    expect(sheet[2]).toEqual(["Head Office", "Cutting", "Master", "Senior", 2, 0, 2, 0]);
  });
});

describe("buildTree", () => {
  const build = (f: Partial<typeof NO_DESIG_FILTERS> = {}) => {
    const filters = { ...NO_DESIG_FILTERS, ...f };
    return buildTree(TREE, filterDesignations(TREE.designations, filters), filters);
  };
  const shape = (nodes: ReturnType<typeof build>) =>
    nodes.map((b) => [
      b.name,
      b.departments.map((d) => [d.name, d.designations.map((x) => x.title)]),
      b.designations.map((x) => x.title),
    ]);

  it("groups branch -> department -> designation, sorted by name, with empty ones listed", () => {
    expect(shape(build())).toEqual([
      [
        "Head Office",
        [
          ["Admin", []],
          ["Cutting", ["Helper", "Master"]],
        ],
        [],
      ],
      ["Unit 2", [["Sewing", ["Legacy", "Tailor"]]], []],
      ["Unit 3", [], []],
      ["No branch", [["Stray", []]], []],
      ["Unassigned", [], ["Floating"]],
    ]);
  });
  it("totals every level and splits staff from production", () => {
    const tree = build();
    const ho = tree[0];
    expect(ho.totals).toMatchObject({
      designations: 2,
      departments: 2,
      activeStaff: 2,
      activeProduction: 3,
      active: 5,
      inactive: 1,
    });
    const cuttingNode = ho.departments[1];
    expect(cuttingNode.totals).toMatchObject({ designations: 2, activeStaff: 2, activeProduction: 3 });
    expect(tree[4].totals).toMatchObject({ designations: 1, active: 0 });
  });
  it("counts people of a department who hold none of its designations", () => {
    const cuttingNode = build()[0].departments[1];
    expect(cuttingNode.withoutDesignation).toBe(2); // 7 in the department, 5 hold Master or Helper
    expect(build()[1].departments[0].withoutDesignation).toBe(0);
  });
  it("a search keeps only the matching designations and drops departments and branches that have none", () => {
    expect(shape(build({ query: "tailor" }))).toEqual([["Unit 2", [["Sewing", ["Tailor"]]], []]]);
  });
  it("a search that names a department or branch keeps it and all its designations", () => {
    expect(shape(build({ query: "cutting" }))).toEqual([["Head Office", [["Cutting", ["Helper", "Master"]]], []]]);
  });
  it("a search that names an empty department or an empty branch still finds it", () => {
    expect(shape(build({ query: "admin" }))).toEqual([["Head Office", [["Admin", []]], []]]);
    expect(shape(build({ query: "unit 3" }))).toEqual([["Unit 3", [], []]]);
  });
  it("a level or 'no employees' filter shows designations only", () => {
    expect(shape(build({ level: "mid" }))).toEqual([["Unit 2", [["Sewing", ["Tailor"]]], []]]);
    expect(shape(build({ empty: true }))).toEqual([
      ["Unit 2", [["Sewing", ["Legacy"]]], []],
      ["Unassigned", [], ["Floating"]],
    ]);
  });
  it("a branch filter keeps that branch (empty departments included) and nothing else", () => {
    expect(shape(build({ branch: "1" }))).toEqual([
      [
        "Head Office",
        [
          ["Admin", []],
          ["Cutting", ["Helper", "Master"]],
        ],
        [],
      ],
    ]);
    expect(shape(build({ branch: NONE }))).toEqual([
      ["No branch", [["Stray", []]], []],
      ["Unassigned", [], ["Floating"]],
    ]);
  });
  it("a department filter shows that department only", () => {
    expect(shape(build({ department: "10" }))).toEqual([["Head Office", [["Cutting", ["Helper", "Master"]]], []]]);
    expect(shape(build({ department: "12" }))).toEqual([["Head Office", [["Admin", []]], []]]);
  });
  it("shows a switched-off branch that still has departments", () => {
    const tree: DesignationsTree = {
      ...TREE,
      branches: [HO],
      departments: [...TREE.departments, { id: 20, name: "Old", branchId: 9, branchName: "Closed Unit", active: 0 }],
    };
    const nodes = buildTree(tree, tree.designations, NO_DESIG_FILTERS);
    expect(nodes.map((n) => n.name)).toContain("Closed Unit");
  });
  it("lists the keys that can be opened", () => {
    expect(allNodeKeys(build())).toEqual([
      "b:1",
      "d:12",
      "d:10",
      "b:2",
      "d:11",
      "b:3",
      "no-branch",
      "d:13",
      "unassigned",
    ]);
  });
  it("has nothing to draw for no data", () => {
    const empty: DesignationsTree = {
      designations: [],
      departments: [],
      branches: [],
      unassigned: { active: 0, staff: 0, production: 0 },
    };
    expect(buildTree(empty, [], NO_DESIG_FILTERS)).toEqual([]);
  });
});

describe("people", () => {
  const p = (id: number, name: string, type: string, status = "active", desigTitle: string | null = null): Person => ({
    id,
    employeeCode: `E${id}`,
    name,
    designationId: null,
    designationTitle: desigTitle,
    departmentId: 1,
    departmentName: "Cutting",
    employmentType: type,
    status,
  });
  const PEOPLE = [
    p(1, "Asha Kumar", "staff", "active", "Supervisor"),
    p(2, "Bala Raj", "production", "active", "Helper"),
    p(3, "Chitra Devi", "production", "inactive"),
    p(4, "Dev Anand", "staff", "resigned"),
  ];
  const ids = (f: Partial<typeof NO_PEOPLE_FILTERS>) =>
    filterPeople(PEOPLE, { ...NO_PEOPLE_FILTERS, ...f }).map((x) => x.id);

  it("shows active people by default and treats every other status as inactive", () => {
    expect(ids({})).toEqual([1, 2]);
    expect(ids({ status: "inactive" })).toEqual([3, 4]);
    expect(ids({ status: "all" })).toEqual([1, 2, 3, 4]);
  });
  it("filters by employment type", () => {
    expect(ids({ type: "staff" })).toEqual([1]);
    expect(ids({ type: "production", status: "all" })).toEqual([2, 3]);
  });
  it("searches name, code and designation", () => {
    expect(ids({ query: "bala" })).toEqual([2]);
    expect(ids({ query: "e1" })).toEqual([1]);
    expect(ids({ query: "supervisor" })).toEqual([1]);
    expect(ids({ query: "kumar raj" })).toEqual([]);
  });
  it("summarizes active staff and production and counts the rest as inactive", () => {
    expect(summarizePeople(PEOPLE)).toEqual({ active: 2, staff: 1, production: 1, inactive: 2 });
  });
  it("makes initials", () => {
    expect(initials("Asha Kumar")).toBe("AK");
    expect(initials("  madonna ")).toBe("M");
    expect(initials("")).toBe("?");
  });
});
