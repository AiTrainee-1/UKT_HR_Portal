// Recruitment Documents: the rules behind the page (the tracker of who has which documents, its filters, the upload
// check), apart from the screens so they can be tested on their own. What counts as "complete" is decided by the
// server (employee_documents_views.document_completion_stats); this only reads what it sends and mirrors the list of
// required documents so the employee view can mark them.

import type {
  DocumentCompletionEmployee,
  DocumentCompletionStats,
  EmployeeDocumentCategory,
  EmployeeDocumentItem,
} from "@/lib/api-client/custom-hooks";
import { compareNumber, compareText, matchesWords, sortBy, type SortDir } from "../career/common";

/** The five personal-ID documents every employee needs, whatever their type. */
const REQUIRED_COMMON: EmployeeDocumentCategory[] = [
  "pan_card",
  "aadhaar_card",
  "educational_certificate",
  "voter_id_or_birth_certificate",
  "bank_passbook",
];

/** What an employee must have on file: the common five, plus one that depends on their type (the same rule as the server). */
export function requiredCategories(employmentType: string | null | undefined): EmployeeDocumentCategory[] {
  return [...REQUIRED_COMMON, employmentType === "production" ? "production_employee_documents" : "staff_letter"];
}

// ─── The tracker ────────────────────────────────────────────────────────────────────────────────────────────────────

export type MissingCategory = { value: EmployeeDocumentCategory; label: string };

export type TrackerRow = {
  id: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  status: "complete" | "pending";
  missing: MissingCategory[];
  /** Required documents on file / required in all. */
  present: number;
  required: number;
};

/** Everyone the server counted (complete and pending together), by name. `required` is how many documents each needs. */
export function buildTracker(stats: DocumentCompletionStats | undefined, required: number): TrackerRow[] {
  if (!stats) return [];
  const complete = (e: DocumentCompletionEmployee): TrackerRow => ({
    id: e.id,
    employeeCode: e.employeeCode,
    name: e.name,
    departmentName: e.departmentName,
    status: "complete",
    missing: [],
    present: required,
    required,
  });
  const pending = stats.pendingEmployees.map((e): TrackerRow => ({
    id: e.id,
    employeeCode: e.employeeCode,
    name: e.name,
    departmentName: e.departmentName,
    status: "pending",
    missing: e.missingCategories,
    present: Math.max(0, required - e.missingCategories.length),
    required,
  }));
  return [...stats.uploadedEmployees.map(complete), ...pending].sort((a, b) => compareText(a.name, b.name));
}

export type TrackerFilters = {
  query: string;
  status: "all" | "complete" | "pending";
  /** "all" or a department name; "none" = no department. */
  department: string;
  /** "all" or a document category that must be among the missing ones. */
  missing: string;
};

export const NO_FILTERS: TrackerFilters = { query: "", status: "all", department: "all", missing: "all" };
export const NO_DEPARTMENT = "none";

export const filtersActive = (f: TrackerFilters) =>
  f.query.trim() !== "" || f.status !== "all" || f.department !== "all" || f.missing !== "all";

export function filterTracker(rows: TrackerRow[], f: TrackerFilters): TrackerRow[] {
  return rows.filter((r) => {
    if (f.status !== "all" && r.status !== f.status) return false;
    if (f.department === NO_DEPARTMENT) {
      if (r.departmentName) return false;
    } else if (f.department !== "all" && r.departmentName !== f.department) {
      return false;
    }
    if (f.missing !== "all" && !r.missing.some((m) => m.value === f.missing)) return false;
    return matchesWords(f.query, r.name, r.employeeCode, r.departmentName);
  });
}

export type SortKey = "name" | "code" | "department" | "documents";

export function sortTracker(rows: TrackerRow[], key: SortKey, dir: SortDir): TrackerRow[] {
  const compare: Record<SortKey, (a: TrackerRow, b: TrackerRow) => number> = {
    name: (a, b) => compareText(a.name, b.name),
    code: (a, b) => compareText(a.employeeCode, b.employeeCode),
    department: (a, b) => compareText(a.departmentName, b.departmentName),
    // fewest documents on file first when ascending: the people to chase
    documents: (a, b) => compareNumber(a.present, b.present),
  };
  return sortBy(rows, compare[key], dir);
}

export type TrackerSummary = {
  total: number;
  complete: number;
  pending: number;
  /** Complete / total, a whole percent (100 when there is nobody). */
  percent: number;
  /** Documents missing across everyone. */
  missingFiles: number;
  /** The category missing for the most people, if anything is missing. */
  mostMissing: { value: EmployeeDocumentCategory; label: string; count: number } | null;
};

export function summarizeTracker(rows: TrackerRow[]): TrackerSummary {
  const counts = new Map<EmployeeDocumentCategory, { label: string; count: number }>();
  let missingFiles = 0;
  for (const r of rows) {
    for (const m of r.missing) {
      missingFiles += 1;
      const known = counts.get(m.value);
      if (known) known.count += 1;
      else counts.set(m.value, { label: m.label, count: 1 });
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || compareText(a[1].label, b[1].label))[0];
  const complete = rows.filter((r) => r.status === "complete").length;
  return {
    total: rows.length,
    complete,
    pending: rows.length - complete,
    percent: rows.length ? Math.round((complete / rows.length) * 100) : 100,
    missingFiles,
    mostMissing: top ? { value: top[0], label: top[1].label, count: top[1].count } : null,
  };
}

/** The categories someone in the list is missing, with how many people: the choices of the "missing" filter. */
export function missingOptions(
  rows: TrackerRow[],
): { value: EmployeeDocumentCategory; label: string; count: number }[] {
  const counts = new Map<EmployeeDocumentCategory, { label: string; count: number }>();
  for (const r of rows) {
    for (const m of r.missing) {
      const known = counts.get(m.value);
      if (known) known.count += 1;
      else counts.set(m.value, { label: m.label, count: 1 });
    }
  }
  return [...counts.entries()]
    .map(([value, v]) => ({ value, label: v.label, count: v.count }))
    .sort((a, b) => compareText(a.label, b.label));
}

// ─── One employee ───────────────────────────────────────────────────────────────────────────────────────────────────

export type CategoryStatus = { count: number; latest: string | null };

/** How many files an employee has in a category, and when the newest was uploaded. */
export function categoryStatus(documents: EmployeeDocumentItem[], category: EmployeeDocumentCategory): CategoryStatus {
  let count = 0;
  let latest: string | null = null;
  for (const d of documents) {
    if (d.category !== category) continue;
    count += 1;
    if (d.uploadedAt && (!latest || d.uploadedAt > latest)) latest = d.uploadedAt;
  }
  return { count, latest };
}

/** Required documents with at least one file, over the number required. */
export function completion(documents: EmployeeDocumentItem[], employmentType: string | null | undefined) {
  const required = requiredCategories(employmentType);
  const present = required.filter((c) => documents.some((d) => d.category === c)).length;
  return {
    present,
    required: required.length,
    missing: required.filter((c) => !documents.some((d) => d.category === c)),
  };
}

// ─── Uploads ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const UPLOAD_EXTENSIONS = ["pdf", "jpg", "jpeg", "png"];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The server's own checks (type and size), made before the file is sent. Null = fine. */
export function checkUpload(file: { name: string; size: number }): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!UPLOAD_EXTENSIONS.includes(ext)) {
    return `"${file.name}" is not a PDF, JPG or PNG file.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB: the limit is 10 MB.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  return null;
}

/** Is the last working day (YYYY-MM-DD) before the day they joined? Then the experience letter would read oddly. */
export function lastDayBeforeJoining(lastWorkingDay: string, joinDate: string | null | undefined): boolean {
  return !!joinDate && !!lastWorkingDay && lastWorkingDay < joinDate.slice(0, 10);
}
