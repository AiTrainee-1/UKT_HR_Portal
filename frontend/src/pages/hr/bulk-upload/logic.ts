import type { Employee } from "@/lib/api-client";
import { SPLIT_FIELDS } from "@/lib/salary-split";
import { PROBLEM_STATUSES, STATUS_HEADER } from "./config";
import type { BulkCounts, Category, ListStatus, MissingEmployee, RemovalAction, RowReport, RowStatus } from "./types";

/** Employees of one kind and state: Active, or anything that is not active. */
export function employeesOf(employees: Employee[] | undefined, category: Category, status: ListStatus): Employee[] {
  return (employees ?? []).filter(
    (e) => e.employmentType === category && (status === "active" ? e.status === "active" : e.status !== "active"),
  );
}

export function tally(employees: Employee[] | undefined): Record<Category, Record<ListStatus, number>> {
  const out = { staff: { active: 0, inactive: 0 }, production: { active: 0, inactive: 0 } };
  for (const e of employees ?? []) {
    if (e.employmentType !== "staff" && e.employmentType !== "production") continue;
    out[e.employmentType][e.status === "active" ? "active" : "inactive"] += 1;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 2024-06-01 -> 01-06-2024, the format the sheets use. */
export function dmy(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

const cap = (s?: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

type ExtraFields = {
  fatherName?: string | null;
  motherName?: string | null;
  biometricDeviceId?: string | null;
  emergencyContact?: string | null;
};

const SPLIT_BY_LABEL = new Map(SPLIT_FIELDS.map((f) => [f.label, f.key]));

/** One cell of an employee's row, for the column called `header`. */
export function cellValue(emp: Employee, header: string): string | number {
  const e = emp as Employee & ExtraFields;
  const splitKey = SPLIT_BY_LABEL.get(header);
  if (splitKey) return e.salaryBreakup?.[splitKey] ?? "";
  switch (header) {
    case "Employee Code":
      return e.employeeCode;
    case "First Name":
      return e.firstName;
    case "Last Name":
      return e.lastName;
    case "Email":
      return e.email ?? "";
    case "Phone":
      return e.phone ?? "";
    case "Gender":
      return cap(e.gender);
    case "Date of Birth":
      return dmy(e.dateOfBirth);
    case "Department":
      return e.departmentName ?? "";
    case "Designation":
      return e.designationTitle ?? "";
    case "Branch":
      return e.branchName ?? "";
    case "Join Date":
      return dmy(e.joinDate);
    case "Salary Type":
      return cap(e.salaryType);
    case "Salary Amount":
      return e.salaryAmount ?? "";
    case "Salary Per Shift":
      return e.salaryPerShift ?? "";
    case "Bank Name":
      return e.bankName ?? "";
    case "Bank Account":
      return e.bankAccount ?? "";
    case "Bank IFSC":
      return e.bankIfsc ?? "";
    case "PF Number":
      return e.pfNumber ?? "";
    case "ESI Number":
      return e.esiNumber ?? "";
    case "Address":
      return e.address ?? "";
    case "ID Proof":
      return e.idProof ?? "";
    case "Father's Name":
      return e.fatherName ?? "";
    case "Mother's Name":
      return e.motherName ?? "";
    case "Biometric Device ID":
      return e.biometricDeviceId ?? "";
    case "Blood Group":
      return e.bloodGroup ?? "";
    case "Emergency Contact":
      return e.emergencyContact ?? "";
    case STATUS_HEADER:
      return e.status === "active" ? "Active" : "Inactive";
    default:
      return "";
  }
}

export const employeeRow = (emp: Employee, headers: string[]) => headers.map((h) => cellValue(emp, h));

/** A search over code, name, department and phone. */
export function searchEmployees(employees: Employee[], query: string): Employee[] {
  const q = query.trim().toLowerCase();
  if (!q) return employees;
  return employees.filter((e) =>
    [e.employeeCode, `${e.firstName} ${e.lastName}`, e.departmentName, e.phone, e.designationTitle].some((v) =>
      (v ?? "").toLowerCase().includes(q),
    ),
  );
}

export type RowFilter = RowStatus | "all" | "problems";

export function countsOfRows(rows: RowReport[]): Record<RowStatus, number> {
  const out = { created: 0, updated: 0, unchanged: 0, duplicate: 0, invalid: 0, failed: 0, skipped: 0, not_found: 0 };
  for (const r of rows) out[r.status] += 1;
  return out;
}

/** The rows to show for a filter chip and a search over code, name, and what was said about them. */
export function filterRows(rows: RowReport[], filter: RowFilter, query: string): RowReport[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "problems" ? !PROBLEM_STATUSES.includes(r.status) : filter !== "all" && r.status !== filter) {
      return false;
    }
    if (!q) return true;
    return [r.code, r.name, `row ${r.row}`, ...r.messages, ...r.warnings, ...r.changes].some((v) =>
      v.toLowerCase().includes(q),
    );
  });
}

/** How many rows were refused or flagged: the ones a person has to look at. */
export const problemCount = (counts: BulkCounts) => counts.duplicate + counts.invalid + counts.failed + counts.notFound;

/** What the chosen decisions amount to, for the confirmation text and the button. */
export function removalSummary(
  missing: MissingEmployee[],
  fallback: RemovalAction,
  overrides: Record<string, RemovalAction>,
): {
  keep: number;
  inactive: number;
  delete: number;
  deleteData: { attendance: number; payroll: number; leaves: number };
} {
  const out = { keep: 0, inactive: 0, delete: 0, deleteData: { attendance: 0, payroll: 0, leaves: 0 } };
  for (const m of missing) {
    const action = overrides[m.code] ?? fallback;
    out[action] += 1;
    if (action === "delete") {
      out.deleteData.attendance += m.dataCounts.attendance;
      out.deleteData.payroll += m.dataCounts.payroll;
      out.deleteData.leaves += m.dataCounts.leaves;
    }
  }
  return out;
}

/** The decisions in the form the API takes: only the ones that differ from the default. */
export function decisionOverrides(
  missing: MissingEmployee[],
  fallback: RemovalAction,
  overrides: Record<string, RemovalAction>,
): Record<string, RemovalAction> {
  const out: Record<string, RemovalAction> = {};
  for (const m of missing) {
    const action = overrides[m.code] ?? fallback;
    if (action !== fallback) out[m.code] = action;
  }
  return out;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
