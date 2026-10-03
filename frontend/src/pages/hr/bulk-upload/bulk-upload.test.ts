import { describe, expect, it } from "vitest";
import type { Employee } from "@/lib/api-client";
import {
  CATEGORIES,
  PRODUCTION_HEADERS,
  ROW_STATUS_ORDER,
  STAFF_HEADERS,
  STATUS_HEADER,
  exportHeaders,
  sampleRows,
} from "./config";
import {
  cellValue,
  countsOfRows,
  decisionOverrides,
  dmy,
  employeeRow,
  employeesOf,
  filterRows,
  formatFileSize,
  problemCount,
  removalSummary,
  searchEmployees,
  tally,
} from "./logic";
import type { BulkCounts, MissingEmployee, RowReport } from "./types";

// The same lists as STAFF_UPLOAD_HEADERS / PRODUCTION_UPLOAD_HEADERS in backend/api/employee_bulk_views.py: the backend
// refuses a sheet whose columns differ, so changing either side means changing both (and these).
const COMMON_HEAD = [
  "Employee Code",
  "First Name",
  "Last Name",
  "Email",
  "Phone",
  "Gender",
  "Date of Birth",
  "Department",
  "Designation",
  "Branch",
  "Join Date",
];
const COMMON_TAIL = [
  "Bank Name",
  "Bank Account",
  "Bank IFSC",
  "PF Number",
  "ESI Number",
  "Address",
  "ID Proof",
  "Father's Name",
  "Mother's Name",
  "Biometric Device ID",
  "Blood Group",
  "Emergency Contact",
];
const SPLIT = [
  "Basic",
  "DA",
  "Retaining Allowance",
  "Other Allowance",
  "Petrol Allowance",
  "HRA",
  "Special Allowance",
  "CA",
];

describe("the two sheet layouts", () => {
  it("match the backend lists column for column", () => {
    expect(STAFF_HEADERS).toEqual([...COMMON_HEAD, "Salary Type", "Salary Amount", ...SPLIT, ...COMMON_TAIL]);
    expect(PRODUCTION_HEADERS).toEqual([...COMMON_HEAD, "Salary Per Shift", ...COMMON_TAIL]);
  });

  it("differ in the pay columns only", () => {
    for (const h of ["Salary Type", "Salary Amount", ...SPLIT]) {
      expect(STAFF_HEADERS).toContain(h);
      expect(PRODUCTION_HEADERS).not.toContain(h);
    }
    expect(PRODUCTION_HEADERS).toContain("Salary Per Shift");
    expect(STAFF_HEADERS).not.toContain("Salary Per Shift");
    expect(STAFF_HEADERS).not.toContain("Employment Type");
    expect(PRODUCTION_HEADERS).not.toContain("Employment Type");
  });

  it("add a trailing Status to a download of existing employees", () => {
    expect(exportHeaders("staff").slice(-1)).toEqual([STATUS_HEADER]);
    expect(exportHeaders("production")).toEqual([...PRODUCTION_HEADERS, STATUS_HEADER]);
  });

  it("have sample rows that line up with the columns and are skipped by the backend (code starts with SAMPLE)", () => {
    for (const category of ["staff", "production"] as const) {
      const rows = sampleRows(category);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toHaveLength(CATEGORIES[category].headers.length);
        expect(String(row[0])).toMatch(/^SAMPLE/);
      }
    }
    // production samples carry a per-shift rate and no salary
    const perShift = PRODUCTION_HEADERS.indexOf("Salary Per Shift");
    expect(Number(sampleRows("production")[0][perShift])).toBeGreaterThan(0);
  });

  it("list every result status once, in a fixed order", () => {
    expect(ROW_STATUS_ORDER).toEqual([
      "created",
      "updated",
      "unchanged",
      "duplicate",
      "invalid",
      "failed",
      "not_found",
      "skipped",
    ]);
  });
});

const emp = (over: Partial<Employee>): Employee =>
  ({
    id: 1,
    employeeCode: "E1",
    firstName: "Asha",
    lastName: "Kumar",
    employmentType: "staff",
    status: "active",
    salaryType: "monthly",
    ...over,
  }) as Employee;

const people = [
  emp({ id: 1, employeeCode: "S1" }),
  emp({ id: 2, employeeCode: "S2", status: "inactive" }),
  emp({ id: 3, employeeCode: "P1", employmentType: "production" }),
  emp({ id: 4, employeeCode: "P2", employmentType: "production", status: "inactive" }),
  emp({ id: 5, employeeCode: "P3", employmentType: "production", status: "terminated" as never }),
];

describe("which employees are in which list", () => {
  it("splits by kind and by active / not active", () => {
    expect(employeesOf(people, "staff", "active").map((e) => e.employeeCode)).toEqual(["S1"]);
    expect(employeesOf(people, "staff", "inactive").map((e) => e.employeeCode)).toEqual(["S2"]);
    expect(employeesOf(people, "production", "inactive").map((e) => e.employeeCode)).toEqual(["P2", "P3"]);
    expect(employeesOf(undefined, "staff", "active")).toEqual([]);
  });

  it("counts the four lists", () => {
    expect(tally(people)).toEqual({ staff: { active: 1, inactive: 1 }, production: { active: 1, inactive: 2 } });
  });

  it("searches code, name, department and phone", () => {
    const list = [
      emp({ employeeCode: "A9", departmentName: "Stitching", phone: "98765" }),
      emp({ employeeCode: "B1", firstName: "Ravi" }),
    ];
    expect(searchEmployees(list, "stitch")).toHaveLength(1);
    expect(searchEmployees(list, "ravi")[0].employeeCode).toBe("B1");
    expect(searchEmployees(list, "98765")).toHaveLength(1);
    expect(searchEmployees(list, "  ")).toHaveLength(2);
  });
});

describe("an employee as a row of the sheet", () => {
  const full = emp({
    employeeCode: "007",
    gender: "female",
    dateOfBirth: "1995-01-15",
    departmentName: "HR",
    salaryAmount: 24000,
    salaryBreakup: {
      basic: 4000,
      da: 4000,
      retainingAllowance: 4000,
      otherAllowance: 2400,
      petrolAllowance: 2400,
      hra: 2400,
      specialAllowance: 2400,
      ca: 2400,
    } as never,
    joinDate: "2024-06-01",
  });

  it("writes dates the way the sheet reads them and capitalises choices", () => {
    expect(dmy("2024-06-01")).toBe("01-06-2024");
    expect(dmy(null)).toBe("");
    expect(cellValue(full, "Gender")).toBe("Female");
    expect(cellValue(full, "Salary Type")).toBe("Monthly");
    expect(cellValue(full, "Date of Birth")).toBe("15-01-1995");
  });

  it("keeps a code like 007 as text and puts the salary split in its eight columns", () => {
    const row = employeeRow(full, exportHeaders("staff"));
    expect(row[0]).toBe("007");
    expect(row[exportHeaders("staff").indexOf("Basic")]).toBe(4000);
    expect(row[exportHeaders("staff").indexOf("CA")]).toBe(2400);
    expect(row[row.length - 1]).toBe("Active");
  });

  it("has a production row with no salary columns and a Status of Inactive for someone inactive", () => {
    const headers = exportHeaders("production");
    const row = employeeRow(emp({ employmentType: "production", salaryPerShift: 450, status: "inactive" }), headers);
    expect(row[headers.indexOf("Salary Per Shift")]).toBe(450);
    expect(row[row.length - 1]).toBe("Inactive");
  });
});

const row = (n: number, status: RowReport["status"], over: Partial<RowReport> = {}): RowReport => ({
  row: n,
  code: `E${n}`,
  name: `Person ${n}`,
  status,
  messages: [],
  warnings: [],
  changes: [],
  ...over,
});

describe("reviewing the rows of a result", () => {
  const rows = [
    row(2, "created"),
    row(3, "duplicate", { messages: ["Employee code 'E3' already exists"] }),
    row(4, "invalid", { messages: ["Gender must be Male, Female or Other"] }),
    row(5, "updated", { changes: ["Phone", "Department"] }),
    row(6, "skipped", { messages: ["Sample row"] }),
    row(7, "not_found"),
  ];

  it("counts each outcome", () => {
    expect(countsOfRows(rows)).toEqual({
      created: 1,
      updated: 1,
      unchanged: 0,
      duplicate: 1,
      invalid: 1,
      failed: 0,
      skipped: 1,
      not_found: 1,
    });
  });

  it("filters to one outcome, to the ones needing attention, or shows all", () => {
    expect(filterRows(rows, "all", "")).toHaveLength(6);
    expect(filterRows(rows, "problems", "").map((r) => r.row)).toEqual([3, 4, 7]);
    expect(filterRows(rows, "updated", "").map((r) => r.row)).toEqual([5]);
  });

  it("searches the code, the name, the reason and the changed fields", () => {
    expect(filterRows(rows, "all", "gender")).toHaveLength(1);
    expect(filterRows(rows, "all", "department")[0].row).toBe(5);
    expect(filterRows(rows, "all", "person 7")[0].row).toBe(7);
    expect(filterRows(rows, "problems", "already exists")).toHaveLength(1);
  });

  it("also searches what was created on the way", () => {
    const withNote = [...rows, row(8, "updated", { notes: ["Created designation 'Quality Checker' in Stitching"] })];
    expect(filterRows(withNote, "all", "quality checker").map((r) => r.row)).toEqual([8]);
    expect(filterRows(rows, "all", "quality checker")).toHaveLength(0); // an older server sends no notes at all
  });

  it("adds up what needs attention", () => {
    const counts = {
      created: 1,
      updated: 0,
      unchanged: 0,
      duplicate: 2,
      invalid: 3,
      failed: 1,
      skipped: 4,
      notFound: 5,
    } as BulkCounts;
    expect(problemCount(counts)).toBe(11);
  });
});

describe("deciding what happens to employees who are not in the file", () => {
  const missing = (code: string, attendance = 0): MissingEmployee => ({
    id: 1,
    code,
    name: code,
    department: null,
    designation: null,
    branch: null,
    joinDate: null,
    dataCounts: { attendance, payroll: 1, leaves: 2 },
    action: null,
    result: null,
  });
  const list = [missing("M1", 10), missing("M2", 5), missing("M3")];

  it("starts from one choice for everyone and counts the overrides", () => {
    expect(removalSummary(list, "keep", {})).toMatchObject({ keep: 3, inactive: 0, delete: 0 });
    expect(removalSummary(list, "inactive", { M3: "keep" })).toMatchObject({ keep: 1, inactive: 2, delete: 0 });
  });

  it("totals what a delete would take with it, for the people chosen only", () => {
    const s = removalSummary(list, "keep", { M1: "delete", M2: "delete" });
    expect(s.delete).toBe(2);
    expect(s.deleteData).toEqual({ attendance: 15, payroll: 2, leaves: 4 });
  });

  it("sends only the decisions that differ from the default", () => {
    expect(decisionOverrides(list, "inactive", { M1: "inactive", M2: "delete" })).toEqual({ M2: "delete" });
    expect(decisionOverrides(list, "keep", {})).toEqual({});
  });
});

describe("file sizes", () => {
  it("reads naturally", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
