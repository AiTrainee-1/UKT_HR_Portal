import { describe, expect, it } from "vitest";
import type { PlanCounts, PlanResult, PlanRow, ShiftAssignment, ShiftItem } from "@/lib/api-client/custom-hooks";
import {
  addDaysIso,
  applyBlocker,
  buildRequest,
  canPreview,
  confirmLabel,
  durationLabel,
  emptyShiftForm,
  filterAssignments,
  filterPeople,
  filterRows,
  flipRule,
  formFromShift,
  formPayload,
  groupAssignments,
  hasSelection,
  isValid,
  latestStart,
  prettyDate,
  removeRule,
  rowFilterCounts,
  rowOutcome,
  ruleCounts,
  ruleOf,
  selectionOf,
  setRule,
  summaryLine,
  timelineBar,
  todayIso,
  toMinutes,
  unassignedOf,
  validateShiftForm,
  type AssignState,
  type Rule,
} from "./shift-logic";

describe("dates", () => {
  it("uses the local calendar day, not UTC", () => {
    expect(todayIso(new Date(2026, 9, 1, 2, 30))).toBe("2026-10-01");
    expect(todayIso(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("adds days across month and year ends", () => {
    expect(addDaysIso("2026-10-01", 3)).toBe("2026-10-04");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("writes a date the way the rest of the portal does", () => {
    expect(prettyDate("2026-10-01")).toBe("01 Oct 2026");
    expect(prettyDate(null)).toBe("");
  });
});

const shift = (over: Partial<ShiftItem> = {}): ShiftItem => ({
  id: 1,
  name: "Morning",
  shiftType: "staff",
  startTime: "09:00",
  endTime: "18:00",
  genderRule: "all",
  gracePeriodMinutes: 15,
  firstHalfEnd: "13:30",
  lunchDurationMinutes: 60,
  lunchGraceMinutes: 10,
  isDefault: false,
  isActive: true,
  assignedCount: 0,
  ...over,
});

describe("the shift form", () => {
  it("starts from sensible hours for each type", () => {
    expect(emptyShiftForm("staff")).toMatchObject({ startTime: "09:00", endTime: "19:00", gracePeriodMinutes: "15" });
    expect(emptyShiftForm("production").endTime).toBe("20:00");
    expect(isValid(validateShiftForm({ ...emptyShiftForm("staff"), name: "General" }, []))).toBe(true);
  });

  it("reads times and lengths", () => {
    expect(toMinutes("09:30")).toBe(570);
    expect(toMinutes("24:00")).toBeNull();
    expect(toMinutes("")).toBeNull();
    expect(durationLabel("09:00", "19:00")).toBe("10h");
    expect(durationLabel("09:00", "17:30")).toBe("8h 30m");
    expect(durationLabel("19:00", "09:00")).toBeNull();
    expect(timelineBar("06:00", "18:00")).toEqual({ left: 25, width: 50 });
    expect(timelineBar("18:00", "06:00")).toEqual({ left: 0, width: 0 });
  });

  const f = (over: object) => ({ ...emptyShiftForm("staff"), name: "Gen", ...over });

  it("asks for a name and keeps it unique within its type, ignoring case", () => {
    expect(validateShiftForm(f({ name: " " }), []).name).toBe("Shift name is required");
    expect(validateShiftForm(f({ name: "x".repeat(81) }), []).name).toContain("at most 80");
    const others = [shift({ id: 1, name: "Morning" }), shift({ id: 2, name: "Night", shiftType: "production" })];
    expect(validateShiftForm(f({ name: "  morning " }), others).name).toBe(
      "A staff shift called 'morning' already exists",
    );
    expect(validateShiftForm(f({ name: "Night" }), others).name).toBeUndefined(); // another type
    expect(validateShiftForm(f({ name: "Morning" }), others, 1).name).toBeUndefined(); // itself
  });

  it("refuses overnight, too-short and missing times", () => {
    expect(validateShiftForm(f({ startTime: "22:00", endTime: "06:00" }), []).endTime).toContain("Overnight");
    expect(validateShiftForm(f({ startTime: "09:00", endTime: "09:30" }), []).endTime).toBe(
      "A shift must be at least 1 hour long",
    );
    expect(validateShiftForm(f({ startTime: "" }), []).startTime).toBe("Start time is required");
    expect(validateShiftForm(f({ endTime: "" }), []).endTime).toBe("End time is required");
  });

  it("checks the grace period and the lunch structure of a staff shift", () => {
    expect(validateShiftForm(f({ gracePeriodMinutes: "61" }), []).gracePeriodMinutes).toContain("between 0 and 60");
    expect(validateShiftForm(f({ gracePeriodMinutes: "" }), []).gracePeriodMinutes).toContain("whole number");
    expect(validateShiftForm(f({ gracePeriodMinutes: "1.5" }), []).gracePeriodMinutes).toContain("whole number");
    expect(validateShiftForm(f({ firstHalfEnd: "08:00" }), []).firstHalfEnd).toContain("between the start and the end");
    expect(validateShiftForm(f({ firstHalfEnd: "" }), []).firstHalfEnd).toBeUndefined(); // optional
    expect(validateShiftForm(f({ lunchDurationMinutes: "5" }), []).lunchDurationMinutes).toContain(
      "between 15 and 120",
    );
    expect(validateShiftForm(f({ lunchGraceMinutes: "40" }), []).lunchGraceMinutes).toContain("between 0 and 30");
  });

  it("does not check the lunch fields of a production shift, which are every gender's", () => {
    const prod = { ...emptyShiftForm("production"), name: "Prod", lunchDurationMinutes: "x", firstHalfEnd: "03:00" };
    expect(isValid(validateShiftForm(prod, []))).toBe(true);
    expect(validateShiftForm({ ...prod, genderRule: "male" }, []).genderRule).toContain("every gender");
  });

  it("builds what the server expects", () => {
    expect(formPayload(f({ name: "  Gen  ", firstHalfEnd: "" }))).toEqual({
      name: "Gen",
      shiftType: "staff",
      startTime: "09:00",
      endTime: "19:00",
      genderRule: "all",
      gracePeriodMinutes: 15,
      firstHalfEnd: null,
      lunchDurationMinutes: 60,
      lunchGraceMinutes: 10,
    });
    const prod = formPayload({ ...emptyShiftForm("production"), name: "P", genderRule: "female" });
    expect(prod.genderRule).toBe("all");
    expect(prod.firstHalfEnd).toBeNull();
    expect(prod).not.toHaveProperty("lunchDurationMinutes");
    expect(formFromShift(shift({ firstHalfEnd: null })).firstHalfEnd).toBe("");
  });
});

const rule = (kind: Rule["kind"], id: number, mode: Rule["mode"] = "include"): Rule => ({
  kind,
  id,
  label: `${kind} ${id}`,
  mode,
});

describe("choosing who gets a shift", () => {
  it("adds a rule once and lets a second click change its mode", () => {
    let rules = setRule([], rule("department", 5));
    rules = setRule(rules, rule("department", 5, "exclude"));
    expect(rules).toHaveLength(1);
    expect(ruleOf(rules, "department", 5)?.mode).toBe("exclude");
    rules = setRule(rules, rule("employee", 5)); // the same id of another kind is another rule
    expect(rules).toHaveLength(2);
  });

  it("flips and removes", () => {
    let rules = [rule("employee", 1), rule("designation", 2, "exclude")];
    rules = flipRule(rules, "employee", 1);
    expect(ruleOf(rules, "employee", 1)?.mode).toBe("exclude");
    rules = flipRule(rules, "employee", 1);
    expect(ruleOf(rules, "employee", 1)?.mode).toBe("include");
    expect(removeRule(rules, "designation", 2)).toHaveLength(1);
  });

  it("sends the include and exclude lists of each kind", () => {
    const rules = [
      rule("employee", 1),
      rule("employee", 2, "exclude"),
      rule("department", 3),
      rule("designation", 4, "exclude"),
      rule("designation", 5),
    ];
    expect(selectionOf(rules, false)).toEqual({
      includeAll: false,
      employees: { include: [1], exclude: [2] },
      departments: { include: [3], exclude: [] },
      designations: { include: [5], exclude: [4] },
    });
    expect(ruleCounts(rules)).toEqual({
      include: 3,
      exclude: 2,
      byKind: { employee: 2, department: 1, designation: 2 },
    });
  });

  it("needs something included: everyone, or at least one included item (exclusions alone select nobody)", () => {
    expect(hasSelection([], false)).toBe(false);
    expect(hasSelection([rule("department", 1, "exclude")], false)).toBe(false);
    expect(hasSelection([rule("department", 1)], false)).toBe(true);
    expect(hasSelection([], true)).toBe(true);
  });

  const state = (over: Partial<AssignState> = {}): AssignState => ({
    shiftId: 7,
    effectiveFrom: "2026-10-04",
    rules: [rule("employee", 1)],
    includeAll: false,
    customStartTime: "",
    customEndTime: "",
    saturdayOff: false,
    notes: "  ",
    onConflict: "keep",
    decisions: {},
    ...over,
  });

  it("builds the request, turning blanks into nulls", () => {
    expect(buildRequest(state({ customStartTime: "10:00" }))).toMatchObject({
      shiftId: 7,
      effectiveFrom: "2026-10-04",
      customStartTime: "10:00",
      customEndTime: null,
      notes: null,
      onConflict: "keep",
    });
  });

  it("previews only once there is a shift, a date and somebody included", () => {
    expect(canPreview(state())).toBe(true);
    expect(canPreview(state({ shiftId: null }))).toBe(false);
    expect(canPreview(state({ effectiveFrom: "" }))).toBe(false);
    expect(canPreview(state({ rules: [] }))).toBe(false);
    expect(canPreview(state({ rules: [], includeAll: true }))).toBe(true);
  });
});

const row = (code: string, status: PlanRow["status"], over: Partial<PlanRow> = {}): PlanRow => ({
  employeeId: Number(code.replace(/\D/g, "")) || 1,
  employeeCode: code,
  name: `Person ${code}`,
  employmentType: "staff",
  gender: "male",
  department: "Sewing",
  designation: "Tailor",
  via: ["Selected directly"],
  status,
  action: status === "new" ? "assign" : status === "conflict" ? "keep" : "none",
  reason: null,
  decision: null,
  current: null,
  scheduled: [],
  ...over,
});

const counts = (over: Partial<PlanCounts> = {}): PlanCounts => ({
  matched: 0,
  selected: 0,
  new: 0,
  alreadyAssigned: 0,
  alreadyOnThisShift: 0,
  conflicts: 0,
  willReassign: 0,
  kept: 0,
  skipped: 0,
  excluded: 0,
  blocked: 0,
  willChange: 0,
  ...over,
});

describe("reading a plan", () => {
  const rows = [
    row("A1", "new"),
    row("A2", "unchanged"),
    row("A3", "conflict"),
    row("A4", "skipped", { department: "Packing" }),
    row("A5", "excluded"),
    row("A6", "blocked"),
  ];

  it("filters by what the person needs", () => {
    expect(filterRows(rows, "all", "").map((r) => r.employeeCode)).toHaveLength(6);
    expect(filterRows(rows, "new", "").map((r) => r.employeeCode)).toEqual(["A1"]);
    expect(filterRows(rows, "conflict", "").map((r) => r.employeeCode)).toEqual(["A2", "A3"]);
    expect(filterRows(rows, "skipped", "").map((r) => r.employeeCode)).toEqual(["A4", "A5"]);
    expect(filterRows(rows, "errors", "").map((r) => r.employeeCode)).toEqual(["A6"]);
    expect(rowFilterCounts(rows)).toEqual({ all: 6, new: 1, conflict: 2, skipped: 2, errors: 1 });
  });

  it("searches name, code, department and designation", () => {
    expect(filterRows(rows, "all", "packing").map((r) => r.employeeCode)).toEqual(["A4"]);
    expect(filterRows(rows, "all", " person a2 ").map((r) => r.employeeCode)).toEqual(["A2"]);
    expect(filterRows(rows, "new", "packing")).toEqual([]);
  });

  it("says what will happen to a row", () => {
    expect(rowOutcome(rows[0]).label).toBe("Will be assigned");
    expect(rowOutcome(rows[2]).label).toBe("Keeps current shift");
    expect(rowOutcome(row("X", "conflict", { action: "reassign" })).label).toBe("Will be reassigned");
    expect(rowOutcome(rows[5]).tone).toBe("danger");
    expect(rowOutcome(rows[4]).label).toBe("Left out");
  });

  it("sums the footer and words the button", () => {
    expect(summaryLine(counts({ new: 12, willReassign: 3, kept: 2, skipped: 4, excluded: 1, blocked: 1 }))).toBe(
      "12 to assign · 3 to reassign · 2 keep their shift · 5 skipped · 1 need attention",
    );
    expect(summaryLine(counts())).toBe("");
    expect(confirmLabel(counts({ new: 1, willChange: 1 }))).toBe("Assign 1 employee");
    expect(confirmLabel(counts({ new: 12, willChange: 12 }))).toBe("Assign 12 employees");
    expect(confirmLabel(counts({ willReassign: 3, willChange: 3 }))).toBe("Reassign 3 employees");
    expect(confirmLabel(counts({ new: 9, willReassign: 3, willChange: 12 }))).toBe("Assign 9 and reassign 3");
    expect(confirmLabel(counts())).toBe("Nothing to assign");
    expect(confirmLabel(undefined)).toBe("Assign");
  });

  it("names what stops Apply", () => {
    const plan = (over: Partial<PlanResult>): PlanResult => ({
      ok: true,
      errors: [],
      warnings: [],
      shift: null,
      effectiveFrom: null,
      counts: counts({ new: 1, willChange: 1 }),
      rows: [],
      ...over,
    });
    expect(applyBlocker(undefined, false)).toBe("Choose a shift, a date and who to include");
    expect(applyBlocker(plan({}), true)).toBe("Checking…");
    expect(applyBlocker(plan({ ok: false, errors: ["Choose a shift"] }), false)).toBe("Choose a shift");
    expect(applyBlocker(plan({ counts: counts() }), false)).toBe("Nobody would be assigned or changed");
    expect(applyBlocker(plan({}), false)).toBeNull();
  });
});

const asg = (id: number, over: Partial<ShiftAssignment> = {}): ShiftAssignment =>
  ({
    id,
    employeeId: id * 10,
    employeeCode: `E${id}`,
    employeeName: `Emp ${id}`,
    employmentType: "staff",
    departmentName: "Sewing",
    shiftId: 1,
    shiftName: "Morning",
    shiftType: "staff",
    startTime: "09:00",
    endTime: "18:00",
    effectiveFrom: "2026-01-05",
    ...over,
  }) as ShiftAssignment;

describe("lists of assignments", () => {
  const list = [
    asg(1),
    asg(2, { shiftId: 2, shiftName: "Evening" }),
    asg(3, { employmentType: "production", shiftId: 3, shiftName: "Prod", effectiveFrom: "2026-03-01" }),
    asg(4),
  ];

  it("groups by shift, sorted by name", () => {
    const groups = groupAssignments(list);
    expect(groups.map((g) => [g.shiftName, g.members.length])).toEqual([
      ["Evening", 1],
      ["Morning", 2],
      ["Prod", 1],
    ]);
  });

  it("filters by the employee's type and by a search", () => {
    expect(filterAssignments(list, "production", "").map((a) => a.id)).toEqual([3]);
    expect(filterAssignments(list, "all", "evening").map((a) => a.id)).toEqual([2]);
    expect(filterAssignments(list, "staff", "e4").map((a) => a.id)).toEqual([4]);
  });

  it("finds the people with no shift", () => {
    const people = [
      { id: 10, employeeCode: "E1", firstName: "Emp", lastName: "1", employmentType: "staff" },
      {
        id: 99,
        employeeCode: "E99",
        firstName: "Free",
        lastName: "Bird",
        employmentType: "production",
        departmentName: "Cutting",
      },
    ];
    expect(unassignedOf(people, list).map((p) => p.id)).toEqual([99]);
    expect(filterPeople(people, "staff", "").map((p) => p.id)).toEqual([10]);
    expect(filterPeople(people, "all", "cutting").map((p) => p.id)).toEqual([99]);
    expect(filterPeople(people, "all", "free b").map((p) => p.id)).toEqual([99]);
  });

  it("knows the latest start among assignments", () => {
    expect(latestStart(list)).toBe("2026-03-01");
    expect(latestStart([])).toBe("");
  });
});
