// What the bulk upload / bulk update API sends back (backend/api/employee_bulk_views.py) and the choices a person makes.

export type Category = "staff" | "production";
export type ListStatus = "active" | "inactive";

/** What happened to one row of the sheet. */
export type RowStatus =
  "created" | "updated" | "unchanged" | "duplicate" | "invalid" | "failed" | "skipped" | "not_found";

export type RowReport = {
  /** The row number in the Excel sheet (the header is row 1). */
  row: number;
  code: string;
  name: string;
  status: RowStatus;
  /** Why it was refused / skipped / left alone. */
  messages: string[];
  /** Things worth knowing about a row that did go through. */
  warnings: string[];
  /** Update only: the fields that were changed. */
  changes: string[];
  /** What was created on the way ("Created designation 'Tailor' in Stitching"): news, not a problem. */
  notes?: string[];
};

export type RemovalAction = "keep" | "inactive" | "delete";

/** An employee of the chosen kind who is not in the uploaded file. */
export type MissingEmployee = {
  id: number;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  branch: string | null;
  joinDate: string | null;
  /** What would be deleted along with them. */
  dataCounts: { attendance: number; payroll: number; leaves: number };
  /** What was done (apply only). */
  action: RemovalAction | null;
  result: string | null;
};

export type BulkCounts = {
  created: number;
  updated: number;
  unchanged: number;
  duplicate: number;
  invalid: number;
  failed: number;
  skipped: number;
  notFound: number;
  /** Update with a section only. */
  madeInactive?: number;
  deleted?: number;
  kept?: number;
  removalFailed?: number;
  missing?: number;
};

export type BulkResult = {
  message: string;
  /** True for a check: nothing was saved. */
  preview: boolean;
  category: Category | null;
  counts: BulkCounts;
  rows: RowReport[];
  missing?: MissingEmployee[];
  /** Departments / designations named in the sheet that did not exist and were created (a check: would be created). */
  newDepartments?: { name: string; rows: number }[];
  newDesignations?: { title: string; department: string | null; rows: number }[];
  scope?: { category: Category | null; employeeStatus: ListStatus | null; total: number; inFile: number | null };
};

/** Which kind of upload a result belongs to, for its heading and its Excel report. */
export type UploadContext = {
  kind: "create" | "update";
  category: Category;
  status: ListStatus;
  fileName: string;
};

export class InvalidTemplateError extends Error {}
