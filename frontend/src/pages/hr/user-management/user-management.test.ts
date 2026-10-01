import { describe, expect, it } from "vitest";
import type { ApprovalSummaryItem, RosterDepartment, RosterEmployee } from "@/lib/api-client/custom-hooks";
import {
  PERMISSIONS,
  PERM_KEYS,
  allPermissions,
  disabledPermissions,
  enabledCount,
  enabledPermissions,
  permissionValuesOf,
  pipelineNote,
} from "./approval-permissions";
import {
  PAGE_SIZE,
  canClaim,
  canRemove,
  canRestore,
  departmentSummary,
  filterCounts,
  filterRoster,
  initialOpen,
  pageSlice,
  removable,
  removedDestination,
  rowDetail,
} from "./roster";

const step = (...roles: ("hod" | "hr")[]) => ({ roles, mandatory: true });
const item = (
  path: string,
  steps: ReturnType<typeof step>[],
  enabled = true,
  label = "Leave",
): ApprovalSummaryItem => ({
  label,
  enabled,
  requestedBy: "Employee",
  steps,
  path,
});

describe("the approval permissions an HOD can be given", () => {
  it("covers each server switch exactly once, Missing Punch included", () => {
    expect(PERM_KEYS).toEqual([
      "canApproveLeaves",
      "canApprovePermissions",
      "canApproveCasualLeave",
      "canApproveAttendance",
      "canApproveMissingPunch",
      "canApproveOnDuty",
      "canApproveResignations",
    ]);
    expect(new Set(PERM_KEYS).size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.workflows.length).toBeGreaterThan(0);
    }
  });

  it("maps each switch to the workflows it lets an HOD act on", () => {
    const flows = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.workflows]));
    expect(flows.canApprovePermissions).toEqual(["permission", "outpass"]); // outpasses share the permissions switch
    expect(flows.canApproveAttendance).toEqual(["attendance_correction"]);
    expect(flows.canApproveMissingPunch).toEqual(["missing_punch"]);
  });

  it("switches everything on or off, and counts what is on", () => {
    expect(enabledCount(allPermissions(true))).toBe(7);
    expect(enabledCount(allPermissions(false))).toBe(0);
    const some = { ...allPermissions(false), canApproveLeaves: true, canApproveOnDuty: true };
    expect(enabledPermissions(some).map((p) => p.short)).toEqual(["Leave", "On-Duty"]);
    expect(disabledPermissions(some)).toHaveLength(5);
  });

  it("reads the switches from the server, treating a missing one (an older server) as on", () => {
    const values = permissionValuesOf({ canApproveLeaves: false, canApproveOnDuty: true });
    expect(values.canApproveLeaves).toBe(false);
    expect(values.canApproveOnDuty).toBe(true);
    expect(values.canApproveMissingPunch).toBe(true);
  });
});

describe("what the approval pipelines say about a switch", () => {
  const perm = (key: string) => PERMISSIONS.find((p) => p.key === key)!;

  it("shows the path a request takes when the HOD has a step", () => {
    const summary = { leave: item("Employee → HOD or HR", [step("hod", "hr")]) };
    expect(pipelineNote(summary, perm("canApproveLeaves"))).toEqual({ tone: "ok", text: "Employee → HOD or HR" });
  });

  it("warns when the HOD has no step, because the switch then changes nothing", () => {
    const summary = { leave: item("Employee → HR", [step("hr")]) };
    const note = pipelineNote(summary, perm("canApproveLeaves"));
    expect(note?.tone).toBe("warn");
    expect(note?.text).toContain("no step");
    expect(note?.text).toContain("Employee → HR");
  });

  it("says when the approval is switched off", () => {
    const summary = { leave: item("Employee → HOD or HR", [step("hod", "hr")], false) };
    expect(pipelineNote(summary, perm("canApproveLeaves"))?.tone).toBe("off");
  });

  it("names each pipeline when one switch covers workflows with different paths", () => {
    const summary = {
      permission: item("Employee → HOD or HR", [step("hod", "hr")], true, "Permission"),
      outpass: item("Employee → HR", [step("hr")], true, "Gate Outpass"),
    };
    const note = pipelineNote(summary, perm("canApprovePermissions"));
    expect(note?.tone).toBe("ok"); // the permission pipeline still has an HOD step
    expect(note?.text).toBe("Permission: Employee → HOD or HR · Gate Outpass: Employee → HR");
  });

  it("is quiet until the pipelines are known", () => {
    expect(pipelineNote(undefined, perm("canApproveLeaves"))).toBeNull();
    expect(pipelineNote({}, perm("canApproveLeaves"))).toBeNull();
  });
});

const person = (over: Partial<RosterEmployee> & { employeeCode: string }): RosterEmployee => ({
  employeeId: Math.abs([...over.employeeCode].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)),
  name: over.employeeCode,
  designation: null,
  status: "active",
  state: "reporting",
  individual: false,
  manager: null,
  via: null,
  ...over,
});

const bala = { id: 2, employeeId: 22, employeeName: "Bala", employeeCode: "BALA" };

const team: RosterEmployee[] = [
  person({ employeeCode: "ZED", name: "Zed Left", status: "inactive" }),
  person({ employeeCode: "ASHA", name: "Asha Head", state: "self", designation: "Supervisor" }),
  person({ employeeCode: "R1", name: "Ravi Kumar", designation: "Tailor" }),
  person({ employeeCode: "R2", name: "Rani Devi", state: "removed" }),
  person({ employeeCode: "R3", name: "Raju", state: "elsewhere", manager: bala, via: "direct" }),
  person({ employeeCode: "R4", name: "Rina", state: "removed", manager: bala, via: "department" }),
];

describe("listing the people of a department", () => {
  it("puts the head first and the people who have left last", () => {
    expect(filterRoster(team, "all", "").map((e) => e.employeeCode)).toEqual(["ASHA", "R1", "R2", "R3", "R4", "ZED"]);
  });

  it("filters by where each person stands", () => {
    expect(filterRoster(team, "reporting", "").map((e) => e.employeeCode)).toEqual(["R1", "ZED"]);
    expect(filterRoster(team, "removed", "").map((e) => e.employeeCode)).toEqual(["R2", "R4"]);
    expect(filterRoster(team, "elsewhere", "").map((e) => e.employeeCode)).toEqual(["R3"]);
  });

  it("searches name, code and designation, ignoring case and spaces around it", () => {
    expect(filterRoster(team, "all", "  RAVI ").map((e) => e.employeeCode)).toEqual(["R1"]);
    expect(filterRoster(team, "all", "r2").map((e) => e.employeeCode)).toEqual(["R2"]);
    expect(filterRoster(team, "all", "tailor").map((e) => e.employeeCode)).toEqual(["R1"]);
    expect(filterRoster(team, "removed", "raju")).toEqual([]);
  });

  it("counts each chip, and leaves the head out of the specific ones", () => {
    expect(filterCounts(team)).toEqual({ all: 6, reporting: 2, removed: 2, elsewhere: 1 });
  });

  it("only lets people who report to this HOD be removed, and removed people be restored", () => {
    const by = Object.fromEntries(team.map((e) => [e.employeeCode, e]));
    expect([canRemove(by.R1), canRemove(by.R2), canRemove(by.R3), canRemove(by.ASHA)]).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([canRestore(by.R2), canRestore(by.R1)]).toEqual([true, false]);
    expect([canClaim(by.R3), canClaim(by.R1)]).toEqual([true, false]);
    expect(removable(team).map((e) => e.employeeCode)).toEqual(["ZED", "R1"]);
  });

  it("says where a removed person's requests go", () => {
    expect(removedDestination(team[3])).toBe("Requests go to HR");
    expect(removedDestination(team[5])).toBe("Requests go to Bala");
    expect(rowDetail(team[3])).toBe("Requests go to HR");
    expect(rowDetail(team[4])).toBe("Reports to Bala (assigned individually)");
    expect(rowDetail(person({ employeeCode: "X", designation: "Cutter", state: "removed" }))).toBe(
      "Cutter · Requests go to HR",
    );
    expect(rowDetail(person({ employeeCode: "Y" }))).toBe("");
    expect(rowDetail(team[2])).toBe("Tailor");
  });

  it("summarises a department's header without empty parts", () => {
    expect(departmentSummary({ reporting: 12, removed: 0, elsewhere: 0, self: 1 })).toBe("12 reporting");
    expect(departmentSummary({ reporting: 9, removed: 2, elsewhere: 1, self: 1 })).toBe(
      "9 reporting · 2 removed · 1 with another HOD",
    );
  });
});

describe("long departments", () => {
  it("shows a page at a time and says how many are hidden", () => {
    const rows = Array.from({ length: 95 }, (_, i) => i);
    expect(pageSlice(rows, PAGE_SIZE)).toEqual({ rows: rows.slice(0, PAGE_SIZE), hidden: 55 });
    expect(pageSlice(rows, 200)).toEqual({ rows, hidden: 0 });
  });

  it("opens the first department, and the one just added", () => {
    const dept = (id: number): RosterDepartment => ({
      id,
      name: `D${id}`,
      counts: { reporting: 0, removed: 0, elsewhere: 0, self: 0 },
      employees: [],
    });
    expect([...initialOpen([dept(1), dept(2), dept(3)], null)]).toEqual([1]);
    expect([...initialOpen([dept(1), dept(2), dept(3)], 3)].sort()).toEqual([1, 3]);
    expect(initialOpen([], null).size).toBe(0);
  });
});
