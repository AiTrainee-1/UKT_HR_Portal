import { describe, expect, it } from "vitest";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { departmentGroups, pickDepartment, runDepartmentId, runsOfDepartment } from "./department-groups";

const run = (id: number, departmentId: number | null, departmentName: string | null, net: string): PayrollRunItem =>
  ({ id, departmentId, departmentName, finalSalary: net }) as unknown as PayrollRunItem;

const RUNS = [
  run(1, 2, "Stitching", "1000"),
  run(2, 1, "Accounts", "2500.50"),
  run(3, 2, "Stitching", "500"),
  run(4, null, null, "300"),
  run(5, 1, "Accounts", "oops"),
];

describe("departmentGroups", () => {
  it("makes one group per department by name, with the row count and the net, and No department last", () => {
    expect(departmentGroups(RUNS)).toEqual([
      { id: "1", name: "Accounts", count: 2, net: 2500.5 },
      { id: "2", name: "Stitching", count: 2, net: 1500 },
      { id: "none", name: "No department", count: 1, net: 300 },
    ]);
  });

  it("gives nothing for no rows", () => {
    expect(departmentGroups([])).toEqual([]);
    expect(departmentGroups(undefined)).toEqual([]);
  });
});

describe("pickDepartment", () => {
  const groups = departmentGroups(RUNS);
  it("opens the one asked for when the rows have it", () => expect(pickDepartment(groups, "2")).toBe("2"));
  it("opens the first department otherwise", () => {
    expect(pickDepartment(groups, "")).toBe("1");
    expect(pickDepartment(groups, "99")).toBe("1");
    expect(pickDepartment(groups, undefined)).toBe("1");
  });
  it("has no department when there are no rows", () => expect(pickDepartment([], "1")).toBeNull());
});

describe("runsOfDepartment", () => {
  it("keeps the rows of one department in their order", () => {
    expect(runsOfDepartment(RUNS, "2").map((r) => r.id)).toEqual([1, 3]);
    expect(runsOfDepartment(RUNS, "none").map((r) => r.id)).toEqual([4]);
    expect(runDepartmentId(RUNS[3])).toBe("none");
  });
  it("gives nothing when no department is open", () => expect(runsOfDepartment(RUNS, null)).toEqual([]));
});
