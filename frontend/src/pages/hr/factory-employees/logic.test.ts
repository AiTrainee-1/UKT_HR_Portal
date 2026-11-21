import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  FactoryCounts,
  FactoryEmployee,
  FactoryEmployeeRecord,
  FactoryLabel,
  PermissionLevel,
  PlanResult,
} from "@/lib/api-client/custom-hooks";
import { EMPTY_SPLIT, defaultSplit } from "@/lib/salary-split";
import {
  ALL,
  FREQUENCY_REQUIRED,
  LABEL_IS_DEPARTMENT,
  NO_FILTERS,
  NO_LABEL,
  NO_SELECTION,
  actionLabel,
  candidateSub,
  categoriesIn,
  categoryOf,
  chipStyle,
  createBody,
  createProblems,
  deselectRows,
  editFormFrom,
  editPayrollBody,
  editProblems,
  emptyCreateForm,
  emptyInfo,
  errorText,
  figures,
  filtersActive,
  firstProblem,
  frequencyText,
  hiddenSelected,
  labelBody,
  labelConfirmWording,
  labelDepartment,
  labelInUse,
  labelProblem,
  labelTabs,
  listSelection,
  longDay,
  matchesAttention,
  matchesLabel,
  moveLabel,
  movedLines,
  nextColor,
  paginate,
  payText,
  payrollBody,
  payrollChanged,
  payrollFix,
  payrollProblems,
  payrollToast,
  personalBody,
  recordFromRow,
  requestFilters,
  rightsFor,
  safeColor,
  sectionFromSearch,
  selectRows,
  selectedRows,
  shiftApplyToast,
  shiftBody,
  shiftRemoveToast,
  shiftText,
  shiftsFor,
  showingText,
  sortLabels,
  statusChanged,
  storedSplit,
  toggleRow,
  validLabelTab,
  whenText,
  type CreateForm,
  type PayrollForm,
} from "./logic";

const row = (id: number, over: Partial<FactoryEmployee> = {}): FactoryEmployee => ({
  id,
  code: `F${String(id).padStart(3, "0")}`,
  name: `Worker ${id}`,
  firstName: "Worker",
  lastName: String(id),
  phone: "9876543210",
  employmentType: "staff",
  status: "active",
  labelId: null,
  label: null,
  labelColor: null,
  departmentId: null,
  department: "",
  designationId: null,
  designation: "",
  branchId: 1,
  unit: "HO",
  joinDate: "2025-04-01",
  salaryAmount: 18000,
  salaryPerShift: null,
  productionPayCycle: null,
  shift: null,
  payrollReady: true,
  payrollIssue: null,
  ...over,
});

const label = (id: number, name: string, sortOrder: number, color = "#2563eb"): FactoryLabel => ({
  id,
  name,
  color,
  description: "",
  employees: 0,
  sortOrder,
});

const levels =
  (map: Record<string, PermissionLevel>, fallback: PermissionLevel = "hidden") =>
  (key: string): PermissionLevel =>
    map[key] ?? fallback;

const apiError = (status: number, body: Record<string, unknown>) =>
  new ApiError(new Response(JSON.stringify(body), { status }), body, { method: "POST", url: "/api/x" });

const pay = (over: Partial<PayrollForm> = {}): PayrollForm => ({
  category: "staff",
  payCycle: "",
  salaryAmount: "",
  split: EMPTY_SPLIT,
  salaryPerShift: "",
  ...over,
});

describe("rights", () => {
  it("gives a full editor everything", () => {
    expect(rightsFor(() => "edit", true)).toEqual({
      manage: true,
      editEmployee: true,
      readEmployee: true,
      setStatus: true,
    });
  });

  it("follows the server's canEdit for the page's own changes", () => {
    expect(rightsFor(() => "edit", false).manage).toBe(false);
    expect(rightsFor(() => "edit", undefined).manage).toBe(true);
  });

  it("needs only the page key for shifts and payroll, and the employee keys for personal details and status", () => {
    const r = rightsFor(
      levels({
        "employees.factory": "edit",
        employees: "view",
        "employees.edit": "edit",
        "employees.status": "edit",
        // no shifts / production / department rights at all: the page's own actions do not need them
      }),
      true,
    );
    expect(r).toEqual({ manage: true, editEmployee: false, readEmployee: true, setStatus: true });
    expect(rightsFor(levels({ "employees.factory": "view" })).manage).toBe(false);
    expect(rightsFor(levels({ "employees.factory": "edit" })).readEmployee).toBe(false);
  });

  it("reads the section from ?tab=, an old Departments tab opening Employees", () => {
    expect(sectionFromSearch("?tab=shifts")).toBe("shifts");
    expect(sectionFromSearch("tab=labels")).toBe("labels");
    expect(sectionFromSearch("?tab=org")).toBe("employees");
    expect(sectionFromSearch("")).toBe("employees");
  });
});

describe("filters", () => {
  it("leaves out what is not filtered, and never sends the label", () => {
    expect(requestFilters(NO_FILTERS)).toEqual({ status: "active", search: undefined, employmentType: undefined });
    expect(requestFilters({ search: " ravi ", status: "all", category: "production" })).toEqual({
      status: "all",
      search: "ravi",
      employmentType: "production",
    });
    expect(requestFilters({ ...NO_FILTERS, search: "typed" }, "")).toMatchObject({ search: undefined });
  });

  it("knows when anything is filtered", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, status: "all" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, category: "staff" })).toBe(true);
  });
});

describe("label tabs", () => {
  const labels = [label(5, "Security", 3), label(3, "Driver", 1), label(4, "Chef", 1)];
  const counts: FactoryCounts = { total: 9, active: 8, inactive: 1, unlabeled: 2, byLabel: { "3": 4, "5": 3 } };

  it("orders the labels by their order, then name", () => {
    expect(sortLabels(labels).map((l) => l.name)).toEqual(["Chef", "Driver", "Security"]);
  });

  it("lists All, every label with its count (an empty one too) and No label", () => {
    expect(labelTabs(labels, counts)).toEqual([
      { value: ALL, label: "All", count: 9, color: null },
      { value: "4", label: "Chef", count: 0, color: "#2563eb" },
      { value: "3", label: "Driver", count: 4, color: "#2563eb" },
      { value: "5", label: "Security", count: 3, color: "#2563eb" },
      { value: NO_LABEL, label: "No label", count: 2, color: null },
    ]);
    expect(labelTabs([], undefined).map((t) => t.count)).toEqual([0, 0]);
  });

  it("matches a row to a tab, and sends a deleted label's tab back to All", () => {
    expect(matchesLabel(row(1, { labelId: 3 }), ALL)).toBe(true);
    expect(matchesLabel(row(1, { labelId: 3 }), "3")).toBe(true);
    expect(matchesLabel(row(1, { labelId: 3 }), "4")).toBe(false);
    expect(matchesLabel(row(1), NO_LABEL)).toBe(true);
    expect(matchesLabel(row(1, { labelId: 3 }), NO_LABEL)).toBe(false);
    expect(validLabelTab("3", labels)).toBe("3");
    expect(validLabelTab("99", labels)).toBe(ALL);
    expect(validLabelTab(NO_LABEL, [])).toBe(NO_LABEL);
  });
});

describe("needs attention", () => {
  const general = {
    assignmentId: 1,
    shiftId: 2,
    name: "General",
    startTime: "09:00",
    endTime: "18:00",
    effectiveFrom: null,
    saturdayOff: false,
  };
  const rows = [
    row(1, { payrollIssue: "No monthly salary", payrollReady: false }),
    row(2, { shift: general }),
    row(3, { status: "inactive", payrollIssue: "No monthly salary" }),
  ];

  it("filters to the payroll problems or to no shift", () => {
    expect(rows.filter((r) => matchesAttention(r, "payroll")).map((r) => r.id)).toEqual([1, 3]);
    expect(rows.filter((r) => matchesAttention(r, "shift")).map((r) => r.id)).toEqual([1, 3]);
    expect(rows.filter((r) => matchesAttention(r, "all")).length).toBe(3);
  });

  it("counts only active people in the warnings", () => {
    expect(figures(rows, undefined)).toEqual({ total: 3, active: 2, inactive: 1, payroll: 1, noShift: 1 });
    expect(figures(rows, { total: 10, active: 7, inactive: 3, unlabeled: 0, byLabel: {} })).toMatchObject({
      total: 10,
      active: 7,
      inactive: 3,
    });
  });
});

describe("pages and selection", () => {
  it("clamps the page and says what is shown", () => {
    const list = Array.from({ length: 30 }, (_, i) => i);
    const p = paginate(list, 9);
    expect(p).toMatchObject({ page: 2, totalPages: 2, from: 26, to: 30, total: 30 });
    expect(showingText(p)).toBe("Showing 26-30 of 30");
    expect(showingText(paginate([], 1))).toBe("Showing 0 of 0");
  });

  it("ticks, unticks and keeps people hidden by a filter", () => {
    const a = row(1);
    const b = row(2);
    let s = toggleRow(NO_SELECTION, a);
    expect(listSelection(s, [a, b])).toBe("some");
    s = selectRows(s, [a, b]);
    expect(listSelection(s, [a, b])).toBe("all");
    expect(hiddenSelected(s, [a])).toBe(1);
    const fresh = { ...a, name: "Renamed" };
    expect(selectedRows(s, [fresh]).map((r) => r.name)).toEqual(["Renamed", "Worker 2"]);
    s = deselectRows(s, [a]);
    expect([...s.keys()]).toEqual([2]);
    expect(listSelection(toggleRow(s, b), [a, b])).toBe("none");
    expect(listSelection(s, [])).toBe("none");
  });
});

describe("a row's words", () => {
  it("reads the pay and the frequency of each payroll (Staff Payroll is Monthly)", () => {
    expect(payText(row(1))).toBe("₹18,000 a month · Monthly");
    expect(payText(row(1, { salaryAmount: null }))).toBe("No monthly salary · Monthly");
    expect(payText(row(1, { employmentType: "production", salaryPerShift: 650, productionPayCycle: "weekly" }))).toBe(
      "₹650 a shift · Weekly",
    );
    expect(payText(row(1, { employmentType: "production", salaryPerShift: null }))).toBe(
      "No salary per shift · No frequency",
    );
    expect(frequencyText("staff", "weekly")).toBe("Monthly");
    expect(frequencyText("production", "biweekly")).toBe("BiWeekly");
    expect(frequencyText("production", null)).toBe("No frequency");
  });

  it("finds the fix of a payroll problem", () => {
    expect(payrollFix(row(1))).toBeNull();
    expect(payrollFix(row(1, { payrollIssue: "No monthly salary" }))).toBe("salary");
    expect(
      payrollFix(row(1, { employmentType: "production", payrollIssue: "No pay cycle (in no Production Payroll yet)" })),
    ).toBe("cycle");
    expect(payrollFix(row(1, { employmentType: "production", payrollIssue: "No salary per shift" }))).toBe("salary");
    expect(payrollFix(row(1, { payrollIssue: "Something new" }))).toBeNull();
  });

  it("reads the shift and a candidate", () => {
    expect(shiftText(null)).toBe("No shift");
    expect(
      shiftText({
        assignmentId: 1,
        shiftId: 2,
        name: "General",
        startTime: "09:00",
        endTime: "18:00",
        effectiveFrom: null,
        saturdayOff: false,
      }),
    ).toBe("General · 09:00-18:00");
    expect(
      candidateSub({
        id: 1,
        code: "E1",
        name: "A",
        employmentType: "production",
        department: "CUTTING",
        designation: "",
        status: "active",
      }),
    ).toBe("Production Payroll");
    expect(categoryOf({ employmentType: "PRODUCTION" })).toBe("production");
    expect(categoryOf({ employmentType: null })).toBe("staff");
  });

  it("formats days and times", () => {
    expect(longDay("2025-04-01")).toBe("1 Apr 2025");
    expect(longDay(null)).toBe("");
    expect(longDay("soon")).toBe("soon");
    expect(whenText(null)).toBe("");
    expect(whenText("not a time")).toBe("not a time");
    expect(whenText("2026-11-20T10:05:00")).toBe("20 Nov 2026, 10:05");
  });

  it("uses the server's own error words", () => {
    expect(errorText(apiError(400, { error: "Employee code 'F001' already exists" }))).toBe(
      "Employee code 'F001' already exists",
    );
    expect(errorText(apiError(403, { error: "permission_denied", message: "No access" }))).toBe("No access");
    expect(errorText(apiError(400, { error: "lowercase sentence here" }))).toBe("lowercase sentence here");
    expect(errorText(apiError(400, { ok: false, errors: ["Pick a shift"] }))).toBe("Pick a shift");
    expect(errorText(apiError(403, { message: "You do not have access to this section." }))).toBe(
      "You do not have access to this section.",
    );
    expect(errorText(new Error("HTTP 500 Internal Server Error: boom"))).toBe("boom");
    expect(errorText("??")).toContain("Could not reach the server");
  });
});

describe("labels", () => {
  const labels = [label(1, "Driver", 1, "#2563eb"), label(2, "Chef", 2, "#0d9488"), label(3, "Security", 3, "#d97706")];

  it("colours a chip safely", () => {
    expect(chipStyle("#2563eb")).toEqual({ color: "#2563eb", backgroundColor: "#2563eb14", borderColor: "#2563eb40" });
    expect(safeColor("red; background: url(x)")).toBe("#94a3b8");
    expect(safeColor(null)).toBe("#94a3b8");
  });

  it("picks the next unused colour", () => {
    expect(nextColor(labels)).toBe("#dc2626");
    expect(nextColor([])).toBe("#2563eb");
  });

  it("checks a label like the server", () => {
    const form = { name: "  Gardener ", color: "#2563eb", description: "" };
    expect(labelProblem(form, labels, null)).toBeNull();
    expect(labelProblem({ ...form, name: "   " }, labels, null)).toBe("Give the label a name.");
    expect(labelProblem({ ...form, name: "x".repeat(41) }, labels, null)).toContain("under 40");
    expect(labelProblem({ ...form, name: "driver" }, labels, null)).toBe('A label called "driver" already exists.');
    expect(labelProblem({ ...form, name: "Driver" }, labels, 1)).toBeNull();
    expect(labelProblem({ ...form, color: "blue" }, labels, null)).toBe("Pick a colour.");
  });

  it("sends everything on create and only what changed on edit", () => {
    expect(labelBody({ name: " Night  Watch ", color: "#DC2626", description: " Gate " }, null)).toEqual({
      name: "Night Watch",
      color: "#dc2626",
      description: "Gate",
    });
    expect(labelBody({ name: "Driver", color: "#2563eb", description: "" }, labels[0])).toBeNull();
    expect(labelBody({ name: "Drivers", color: "#2563eb", description: "Vans" }, labels[0])).toEqual({
      name: "Drivers",
      description: "Vans",
    });
  });

  it("moves a label up or down, writing only the numbers that change", () => {
    expect(moveLabel(labels, 2, -1)).toEqual([
      { id: 2, sortOrder: 1 },
      { id: 1, sortOrder: 2 },
    ]);
    expect(moveLabel(labels, 3, 1)).toEqual([]);
    expect(moveLabel(labels, 1, -1)).toEqual([]);
    expect(moveLabel(labels, 99, 1)).toEqual([]);
    const tied = [label(1, "A", 0), label(2, "B", 0), label(3, "C", 0)];
    expect(moveLabel(tied, 3, -1)).toEqual([
      { id: 1, sortOrder: 1 },
      { id: 3, sortOrder: 2 },
      { id: 2, sortOrder: 3 },
    ]);
  });

  it("reads the 409 of a label still in use", () => {
    expect(labelInUse(apiError(409, { error: "4 employee(s) still have the label", employees: 4 }))).toBe(4);
    expect(labelInUse(apiError(409, { error: "x" }))).toBe(1);
    expect(labelInUse(apiError(400, { error: "x" }))).toBeNull();
    expect(labelInUse(new Error("x"))).toBeNull();
  });

  it("says that a label is also the department and designation", () => {
    expect(LABEL_IS_DEPARTMENT).toBe(
      "The label is also the employee's department and designation (e.g. DRIVER) across the HRMS.",
    );
    expect(labelDepartment("  Night  watch ")).toBe("NIGHT WATCH");
    const give = labelConfirmWording(3, { name: "Driver" });
    expect(give.title).toBe("Give 3 employees the label Driver?");
    expect(give.lines[0]).toContain("they move to the department DRIVER and the designation DRIVER");
    expect(give.lines[1]).toBe(
      "Their Department Head becomes the head of DRIVER; until one is set, their leave and permission requests go to HR.",
    );
    const remove = labelConfirmWording(1, null);
    expect(remove.title).toBe("Remove the label from 1 employee?");
    expect(remove.lines[0]).toContain("They keep the department and designation they have now");
  });

  it("lists who moved department, briefly", () => {
    const moved = Array.from({ length: 5 }, (_, i) => ({
      employeeId: i,
      code: `F00${i}`,
      what: `department ADMIN -> DRIVER, designation MIS -> DRIVER`,
    }));
    expect(movedLines(undefined)).toEqual([]);
    expect(movedLines(moved.slice(0, 1))).toEqual(["F000: department ADMIN -> DRIVER, designation MIS -> DRIVER"]);
    const lines = movedLines(moved);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("and 2 more moved.");
    const words = payrollToast(
      { updated: [row(3, { name: "RAJA P" })], refused: [], cleared: [], moved: moved.slice(0, 1) },
      { category: "production", payCycle: "weekly" },
    );
    expect(words.lines).toEqual(["F000: department ADMIN -> DRIVER, designation MIS -> DRIVER"]);
  });
});

describe("payroll", () => {
  it("always asks for the Production Payroll frequency", () => {
    expect(
      payrollProblems(pay({ category: "production", salaryPerShift: "650" }), {
        amountRequired: false,
        withSplit: false,
      }),
    ).toEqual({ payCycle: FREQUENCY_REQUIRED });
    expect(
      payrollProblems(pay({ category: "production", payCycle: "weekly", salaryPerShift: "650" }), {
        amountRequired: true,
        withSplit: false,
      }),
    ).toEqual({});
    // Staff Payroll has no frequency to choose: it is Monthly
    expect(payrollProblems(pay({ salaryAmount: "18000" }), { amountRequired: true, withSplit: false })).toEqual({});
  });

  it("asks for the amount only when it is required, and checks a typed one", () => {
    expect(payrollProblems(pay(), { amountRequired: false, withSplit: false })).toEqual({});
    expect(payrollProblems(pay(), { amountRequired: true, withSplit: false }).salaryAmount).toContain("monthly salary");
    expect(
      payrollProblems(pay({ salaryAmount: "-1" }), { amountRequired: false, withSplit: false }).salaryAmount,
    ).toBeDefined();
    expect(
      payrollProblems(pay({ category: "production", payCycle: "monthly" }), { amountRequired: true, withSplit: false })
        .salaryPerShift,
    ).toContain("salary per shift");
    expect(
      payrollProblems(pay({ salaryAmount: "18000", split: { ...defaultSplit("18000")!, basic: "1" } }), {
        amountRequired: true,
        withSplit: true,
      }).split,
    ).toContain("50%");
  });

  it("builds the payroll body: the frequency for production, the salary and split for staff", () => {
    expect(
      payrollBody([3, 4], pay({ category: "production", payCycle: "biweekly", salaryPerShift: "700" }), {
        withSplit: false,
      }),
    ).toEqual({ employeeIds: [3, 4], category: "production", payCycle: "biweekly", salaryPerShift: 700 });
    expect(payrollBody([3], pay({ category: "production", payCycle: "weekly" }), { withSplit: false })).toEqual({
      employeeIds: [3],
      category: "production",
      payCycle: "weekly",
    });
    expect(payrollBody([1], pay(), { withSplit: false })).toEqual({ employeeIds: [1], category: "staff" });
    const staff = payrollBody([1], pay({ salaryAmount: "20000", split: defaultSplit("20000")! }), { withSplit: true });
    expect(staff).toMatchObject({ employeeIds: [1], category: "staff", salaryAmount: 20000 });
    expect(staff.salaryBreakup).toMatchObject({ basic: "3333.34" });
    expect(staff).not.toHaveProperty("payCycle");
    expect(payrollBody([1], pay({ salaryAmount: "20000" }), { withSplit: true, sendAmount: false })).toEqual({
      employeeIds: [1],
      category: "staff",
    });
  });

  it("words the result, with who was refused and what was cleared", () => {
    const words = payrollToast(
      {
        updated: [row(3, { name: "RAJA P" })],
        refused: [{ employeeId: 4, code: "F004", name: "SELVI R", reason: "Enter the salary per shift." }],
        cleared: [{ employeeId: 3, code: "F003", what: "department TRANSPORT" }],
      },
      { category: "production", payCycle: "weekly" },
    );
    expect(words.title).toBe("RAJA P now on Production Payroll (Weekly)");
    expect(words.lines).toEqual([
      "SELVI R: Enter the salary per shift.",
      "Removed because it belongs to the other payroll: F003: department TRANSPORT.",
    ]);
    expect(words.failed).toBe(true);
    expect(
      payrollToast({ updated: [row(1), row(2)], refused: [], cleared: [] }, { category: "staff", payCycle: "" }).title,
    ).toBe("2 employees now on Staff Payroll (Monthly)");
  });
});

describe("the create form", () => {
  const filled = (over: Partial<CreateForm> = {}): CreateForm => ({
    ...emptyCreateForm("2026-11-20", "3"),
    employeeCode: " F010 ",
    firstName: "Murugan",
    lastName: "K",
    phone: "9876543210",
    salaryAmount: "18000",
    split: defaultSplit("18000")!,
    ...over,
  });

  it("starts on today, with the page's label, in Staff Payroll", () => {
    const f = emptyCreateForm("2026-11-20", "3");
    expect(f).toMatchObject({
      joinDate: "2026-11-20",
      shiftFrom: "2026-11-20",
      labelId: "3",
      category: "staff",
      payCycle: "",
    });
    expect(f).not.toHaveProperty("departmentId");
  });

  it("asks for what the server needs, and the frequency of Production Payroll", () => {
    expect(createProblems(filled(), false)).toEqual({});
    const empty = createProblems(emptyCreateForm("2026-11-20"), true);
    expect(Object.keys(empty).sort()).toEqual([
      "branchId",
      "employeeCode",
      "firstName",
      "lastName",
      "phone",
      "salaryAmount",
    ]);
    expect(firstProblem(empty)).toBe("Employee code is required");
    expect(createProblems(filled({ phone: "12345" }), false).phone).toContain("10 digits");
    expect(createProblems(filled({ split: { ...defaultSplit("18000")!, basic: "1" } }), false).split).toContain("50%");
    const production = createProblems(filled({ category: "production", salaryPerShift: "650" }), false);
    expect(production).toEqual({ payCycle: FREQUENCY_REQUIRED });
    expect(firstProblem(production)).toBe(FREQUENCY_REQUIRED);
    expect(createProblems(filled({ category: "production", payCycle: "weekly", salaryPerShift: "" }), false)).toEqual({
      salaryPerShift: "Enter the salary per shift (more than 0)",
    });
    expect(createProblems(filled({ shiftId: "2", shiftFrom: "" }), false).shiftFrom).toBeDefined();
    expect(firstProblem({})).toBeNull();
  });

  it("sends the employee body with the label and no department or designation", () => {
    const body = createBody(filled({ bankIfsc: "sbin0001 ", gender: "male" }));
    expect(body).toMatchObject({
      employeeCode: "F010",
      firstName: "Murugan",
      lastName: "K",
      phone: "9876543210",
      gender: "male",
      employmentType: "staff",
      joinDate: "2026-11-20",
      salaryType: "monthly",
      salaryAmount: 18000,
      bankIfsc: "SBIN0001",
      labelId: 3,
    });
    expect(body.salaryBreakup).toMatchObject({ basic: "3000.00", ca: "1800.00" });
    for (const k of ["salaryPerShift", "branchId", "bankName", "departmentId", "designationId", "payCycle"])
      expect(body).not.toHaveProperty(k);
  });

  it("sends a production employee's rate, and no label as null", () => {
    const body = createBody(
      filled({ category: "production", payCycle: "weekly", salaryPerShift: "650", labelId: "", branchId: "2" }),
    );
    expect(body).toMatchObject({ employmentType: "production", salaryPerShift: 650, labelId: null, branchId: 2 });
    expect(body).not.toHaveProperty("salaryAmount");
    expect(body).not.toHaveProperty("salaryBreakup");
  });

  it("builds the shift body of this page's endpoints", () => {
    expect(shiftBody([12], 2, "2026-11-21", true)).toEqual({
      shiftId: 2,
      employeeIds: [12],
      effectiveFrom: "2026-11-21",
      saturdayOff: true,
    });
  });
});

describe("the edit form", () => {
  const record = (over: Partial<FactoryEmployeeRecord> = {}): FactoryEmployeeRecord => ({
    id: 12,
    employeeCode: "F001",
    firstName: "Murugan",
    lastName: "K",
    phone: "9876543210",
    employmentType: "staff",
    branchId: 1,
    salaryAmount: 18000,
    salaryBreakup: {
      basic: 3000,
      da: 3000,
      retainingAllowance: 3000,
      otherAllowance: 1800,
      petrolAllowance: 1800,
      hra: 1800,
      specialAllowance: 1800,
      ca: 1800,
    },
    salaryPerShift: null,
    status: "active",
    joinDate: "2025-04-01T00:00:00",
    ...over,
  });
  const opts = { needsBranch: false, personal: true, payroll: true, splitRecorded: true };

  it("fills the form from the record and the row's frequency", () => {
    expect(editFormFrom(record())).toMatchObject({
      firstName: "Murugan",
      category: "staff",
      payCycle: "",
      branchId: "1",
      joinDate: "2025-04-01",
      salaryAmount: "18000",
      salaryPerShift: "",
      status: "active",
    });
    const production = editFormFrom(record({ employmentType: "production", salaryPerShift: 650 }), "biweekly");
    expect(production).toMatchObject({ category: "production", payCycle: "biweekly", salaryPerShift: "650" });
    // a staff employee has no production frequency even if one is sent
    expect(editFormFrom(record(), "weekly").payCycle).toBe("");
    expect(storedSplit(record()).recorded).toBe(true);
    const old = storedSplit(record({ salaryBreakup: null }));
    expect(old.recorded).toBe(false);
    expect(old.split.basic).toBe("3000.00");
  });

  it("sends only the personal details that changed to the employee endpoint", () => {
    const before = editFormFrom(record());
    expect(personalBody(before, before, { sendBranch: true })).toBeNull();
    expect(personalBody({ ...before, phone: " 9123456780 " }, before, { sendBranch: true })).toEqual({
      phone: "9123456780",
    });
    expect(personalBody({ ...before, branchId: "2" }, before, { sendBranch: false })).toBeNull();
    expect(personalBody({ ...before, branchId: "2" }, before, { sendBranch: true })).toEqual({ branchId: 2 });
    // the payroll never goes to the employee endpoint
    expect(
      personalBody({ ...before, category: "production", salaryAmount: "1" }, before, { sendBranch: true }),
    ).toBeNull();
  });

  it("sends a payroll change to the payroll endpoint, with the amount only when it changed", () => {
    const r = record();
    const before = editFormFrom(r);
    expect(editPayrollBody(12, before, before, true)).toBeNull();
    expect(payrollChanged(before, before, true)).toBe(false);
    const raise = editPayrollBody(
      12,
      { ...before, salaryAmount: "20000", split: defaultSplit("20000")! },
      before,
      true,
    );
    expect(raise).toMatchObject({ employeeIds: [12], category: "staff", salaryAmount: 20000 });
    expect(raise?.salaryBreakup).toMatchObject({ basic: "3333.34" });
    // moving to Production Payroll: the frequency and the rate go; the staff salary does not
    expect(
      editPayrollBody(
        12,
        { ...before, category: "production", payCycle: "weekly", salaryPerShift: "700" },
        before,
        true,
      ),
    ).toEqual({ employeeIds: [12], category: "production", payCycle: "weekly", salaryPerShift: 700 });
    // a split not on record yet is recorded with the save
    const unrecorded = record({ salaryBreakup: null });
    const b2 = editFormFrom(unrecorded);
    expect(editPayrollBody(12, b2, b2, false)).toMatchObject({ salaryAmount: 18000 });
  });

  it("changes only the frequency of a production employee", () => {
    const r = record({ employmentType: "production", salaryAmount: null, salaryPerShift: 650 });
    const before = editFormFrom(r, "weekly");
    expect(editPayrollBody(12, { ...before, payCycle: "monthly" }, before, true)).toEqual({
      employeeIds: [12],
      category: "production",
      payCycle: "monthly",
    });
  });

  it("asks for the production frequency always, and the amounts only when the payroll changes", () => {
    const prod = editFormFrom(record({ employmentType: "production", salaryAmount: null, salaryPerShift: 650 }));
    expect(editProblems(prod, prod, opts)).toEqual({ payCycle: FREQUENCY_REQUIRED });
    // a login that cannot change payroll is not asked
    expect(editProblems(prod, prod, { ...opts, payroll: false })).toEqual({});
    const staff = editFormFrom(record({ salaryAmount: null, salaryBreakup: null }));
    // a staff employee with no salary can still have their phone changed
    expect(editProblems({ ...staff, phone: "9123456780" }, staff, opts)).toEqual({});
    expect(editProblems({ ...staff, salaryAmount: "-5" }, staff, opts).salaryAmount).toBeDefined();
    expect(
      editProblems({ ...editFormFrom(record()), category: "production" }, editFormFrom(record()), opts),
    ).toMatchObject({ payCycle: FREQUENCY_REQUIRED, salaryPerShift: "Enter the salary per shift (more than 0)" });
    expect(editProblems({ ...staff, firstName: " ", phone: "12" }, staff, opts)).toMatchObject({
      firstName: "First name is required",
      phone: "Enter a phone number of at least 10 digits",
    });
    expect(editProblems({ ...staff, firstName: " " }, staff, { ...opts, personal: false })).toEqual({});
    expect(editProblems({ ...staff, branchId: "" }, staff, { ...opts, needsBranch: true }).branchId).toBe(
      "Select a branch",
    );
  });

  it("knows a status change, and builds a record from a row", () => {
    const before = editFormFrom(record());
    expect(statusChanged({ ...before, status: "inactive" }, before)).toBe(true);
    expect(statusChanged(before, before)).toBe(false);
    const fromRow = recordFromRow(row(7, { salaryAmount: 15000 }));
    expect(fromRow).toMatchObject({ id: 7, employeeCode: "F007", salaryAmount: 15000, salaryBreakup: null });
  });
});

describe("shifts and the rest", () => {
  const plan = (over: Partial<PlanResult>): PlanResult =>
    ({
      ok: true,
      errors: [],
      warnings: [],
      shift: { id: 2, name: "General", shiftType: "staff", startTime: "09:00", endTime: "18:00", genderRule: "all" },
      effectiveFrom: "2026-11-21",
      counts: {} as PlanResult["counts"],
      rows: [],
      ...over,
    }) as PlanResult;

  it("words a shift assignment", () => {
    const done = shiftApplyToast(
      plan({
        applied: {
          created: 2,
          reassigned: 1,
          updated: 0,
          kept: 0,
          unchanged: 1,
          skipped: 0,
          blocked: 0,
          excluded: 0,
          assigned: 3,
        },
        rows: [
          {
            employeeId: 9,
            name: "Ravi",
            status: "skipped",
            reason: "A Female only shift",
          } as PlanResult["rows"][number],
        ],
      }),
      new Map([[9, "Ravi K"]]),
    );
    expect(done.title).toBe("General assigned to 3 employees");
    expect(done.lines).toEqual(["1 already on it.", "Not changed: Ravi K: A Female only shift."]);
    expect(done.failed).toBe(false);
    const none = shiftApplyToast(
      plan({
        applied: {
          created: 0,
          reassigned: 0,
          updated: 0,
          kept: 0,
          unchanged: 0,
          skipped: 1,
          blocked: 0,
          excluded: 0,
          assigned: 0,
        },
        rows: [{ employeeId: 9, name: "Ravi", status: "skipped", reason: null } as PlanResult["rows"][number]],
      }),
    );
    expect(none.title).toBe("Nobody was put on General");
    expect(none.failed).toBe(true);
  });

  it("words taking people off a shift", () => {
    expect(shiftRemoveToast({ ended: 2, cancelled: 1 }, "2026-11-20")).toBe(
      "2 employees taken off their shift after 20 Nov 2026; 1 upcoming shift cancelled",
    );
    expect(shiftRemoveToast({ ended: 0, cancelled: 0 }, "2026-11-20")).toBe("Nobody was on a shift");
  });

  it("offers a kind's shifts and finds the kinds in a selection", () => {
    const shifts = [
      { id: 1, shiftType: "staff" },
      { id: 2, shiftType: "staff", isActive: false },
      { id: 3, shiftType: "production" },
    ];
    expect(shiftsFor(shifts, "staff").map((s) => s.id)).toEqual([1]);
    expect(shiftsFor(shifts, "production").map((s) => s.id)).toEqual([3]);
    expect(categoriesIn([row(1), row(2, { employmentType: "production" })])).toEqual(["staff", "production"]);
    expect(categoriesIn([row(1, { employmentType: "production" })])).toEqual(["production"]);
    expect(categoriesIn([])).toEqual([]);
  });

  it("names the history's actions", () => {
    expect(actionLabel("create")).toBe("Created");
    expect(actionLabel("UPDATE")).toBe("Changed");
    expect(actionLabel("export")).toBe("Export");
    expect(actionLabel("")).toBe("Changed");
  });

  it("says why the list is empty and what to do", () => {
    const base = { total: 0, filtered: false, labelTab: ALL, labelName: null, attention: "all" as const, manage: true };
    expect(emptyInfo(base)).toMatchObject({ title: "No factory employees yet", action: "add" });
    expect(emptyInfo({ ...base, manage: false }).action).toBeNull();
    expect(emptyInfo({ ...base, total: 4, filtered: true })).toMatchObject({
      title: "Nothing matches",
      action: "clear",
    });
    expect(emptyInfo({ ...base, total: 4, attention: "shift" })).toMatchObject({ action: "clear" });
    expect(emptyInfo({ ...base, total: 4, labelTab: NO_LABEL })).toMatchObject({ title: "Everyone has a label" });
    expect(emptyInfo({ ...base, total: 4, labelTab: "3", labelName: "Chef" })).toMatchObject({
      title: "Nobody has the label Chef",
      action: "all-labels",
    });
  });
});
