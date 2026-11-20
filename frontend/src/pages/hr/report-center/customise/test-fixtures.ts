// Fixtures for the Customise (report builder) tests: the shapes /api/reports/custom/* and /api/reports/catalog send (see
// lib/api-client/custom-hooks/report-customise.ts and the Customise contract), small enough to check by eye.

import type { CustomDataset, SavedCustomReport } from "@/lib/api-client/custom-hooks/report-customise";
import type {
  ReportCatalog,
  ReportCategory,
  ReportColumn,
  ReportFilter,
  ReportMeta,
  ReportRunResult,
} from "@/lib/report-center";

const filter = (over: Partial<ReportFilter> & Pick<ReportFilter, "key" | "kind" | "label">): ReportFilter => ({
  required: false,
  multi: false,
  default: null,
  ...over,
});

export const RANGE = filter({
  key: "dateRange",
  kind: "dateRange",
  label: "Dates",
  required: true,
  default: { dateFrom: "2026-11-01", dateTo: "2026-11-19" },
});
const DEPARTMENT = filter({ key: "department", kind: "department", label: "Department", multi: true, default: [] });
const STATUS = filter({
  key: "employeeStatus",
  kind: "employeeStatus",
  label: "Employee status",
  default: "active",
  options: [
    { value: "active", label: "Active" },
    { value: "all", label: "All" },
  ],
});
const NAME_LIKE = filter({ key: "nameLike", kind: "text", label: "Name contains", default: "" });

export const EMPLOYEES: CustomDataset = {
  id: "employees",
  label: "Employees with period figures",
  description: "One row per employee, with attendance and payroll for the period.",
  grain: "employee",
  filters: [RANGE, DEPARTMENT, STATUS, NAME_LIKE],
  sections: [
    {
      id: "personal",
      label: "Personal",
      fields: [
        { key: "emp.code", label: "Employee code", type: "text", section: "personal" },
        { key: "emp.name", label: "Name", type: "text", section: "personal" },
        { key: "emp.gender", label: "Gender", type: "text", section: "personal" },
      ],
    },
    {
      id: "attendance",
      label: "Attendance in period",
      fields: [
        { key: "att.present_days", label: "Present days", type: "number", section: "attendance" },
        { key: "att.late_count", label: "Late count", type: "integer", section: "attendance" },
        { key: "att.ot_hours", label: "OT hours", type: "hours", section: "attendance" },
      ],
    },
    {
      id: "payroll",
      label: "Payroll for the month",
      fields: [
        { key: "pay.net", label: "Net pay", type: "currency", section: "payroll", description: "After deductions" },
      ],
    },
  ],
  defaultFields: ["emp.code", "emp.name"],
};

export const PUNCHES: CustomDataset = {
  id: "punches",
  label: "Punches",
  description: "Every punch.",
  grain: "punch",
  filters: [filter({ ...RANGE, maxDays: 31 })],
  sections: [
    {
      id: "punch",
      label: "Punch",
      fields: [
        { key: "emp.code", label: "Employee code", type: "text", section: "punch" },
        { key: "punch.time", label: "Punch time", type: "datetime", section: "punch" },
      ],
    },
  ],
  defaultFields: ["emp.code", "punch.time"],
};

/** A data source with a month filter (the real "employees" one has a Month, not a date range). */
export const MONTHLY: CustomDataset = {
  id: "monthly",
  label: "Monthly figures",
  description: "One row per employee for a month.",
  grain: "employee",
  filters: [filter({ key: "period", kind: "period", label: "Month", required: true, default: "2026-11" })],
  sections: [
    {
      id: "personal",
      label: "Personal",
      fields: [{ key: "emp.code", label: "Employee code", type: "text", section: "personal" }],
    },
  ],
  defaultFields: ["emp.code"],
};

export const DATASETS_BODY = { datasets: [EMPLOYEES, PUNCHES] };

const LABELS = new Map(
  [...EMPLOYEES.sections, ...PUNCHES.sections].flatMap((s) => s.fields.map((f) => [f.key, f] as const)),
);

/** What /api/reports/custom/preview answers for a field list: one column per field, two rows. */
export function previewResult(params: URLSearchParams): ReportRunResult {
  const keys = (params.get("fields") ?? "").split(",").filter(Boolean);
  const columns: ReportColumn[] = keys.map((key) => {
    const f = LABELS.get(key);
    return { key, label: f?.label ?? key, type: f?.type ?? "text", width: 1, total: null, align: null };
  });
  const row = (n: number) => Object.fromEntries(keys.map((k) => [k, k === "emp.name" ? `Worker ${n}` : `${k}-${n}`]));
  return {
    id: "custom-preview",
    title: "Preview",
    category: "customise",
    generatedAt: "19-Nov-2026 10:00",
    generatedBy: "HR Admin",
    filters: [],
    columns,
    rows: [row(1), row(2)],
    totals: null,
    summary: [],
    notes: ["Attendance from the stored day records."],
    rowCount: 2,
    truncated: false,
    limit: 200,
  };
}

export const savedItem = (over: Partial<SavedCustomReport> = {}): SavedCustomReport => ({
  id: 7,
  reportId: "custom-7",
  name: "Monthly Employee Performance Report",
  description: "Present days, late count and net pay per employee.",
  dataset: "employees",
  datasetLabel: "Employees with period figures",
  fields: ["emp.code", "emp.name", "att.present_days", "att.late_count", "pay.net"],
  hiddenFields: 0,
  filters: { employeeStatus: "active" },
  sort: [{ key: "emp.code", dir: "asc" }],
  createdBy: "Priya",
  createdAt: "2026-11-18T09:30:00+05:30",
  updatedBy: "Priya",
  updatedAt: "2026-11-19T10:42:00+05:30",
  canEdit: true,
  canDelete: true,
  ...over,
});

const meta = (id: string, category: string, over: Partial<ReportMeta> = {}): ReportMeta => ({
  id,
  title: id,
  description: `about ${id}`,
  category,
  icon: "FileText",
  tags: [],
  family: null,
  variant: null,
  landscape: true,
  filters: [],
  columns: [],
  dynamicColumns: false,
  exports: ["xlsx", "pdf"],
  ...over,
});

const category = (id: string, label: string, count: number, icon = "FileText"): ReportCategory => ({
  id,
  label,
  description: `${label} reports`,
  icon,
  count,
});

/** A catalog with HR, Attendance and Salary reports, and (unless `customise: false`) the Customise category. */
export function catalogFixture(opts: { customise?: boolean; saved?: SavedCustomReport[] } = {}): ReportCatalog {
  const withCustomise = opts.customise ?? true;
  const saved = opts.saved ?? [];
  const categories = [
    category("hr", "HR Reports", 1, "Briefcase"),
    category("attendance", "Attendance", 2, "CalendarCheck"),
    category("payroll", "Salary", 1, "Wallet"),
    ...(withCustomise ? [category("customise", "Customise", saved.length, "SlidersHorizontal")] : []),
  ];
  return {
    generatedAt: "2026-11-19T10:00:00",
    branchScoped: false,
    categories,
    reports: [
      meta("hr-time-card", "hr", { title: "HR Time Card", tags: ["punch"] }),
      meta("late-detection", "attendance", { title: "Late Detection Report", tags: ["late"] }),
      meta("leave-report", "attendance", { title: "Leave Report" }),
      meta("salary-statement", "payroll", { title: "Salary Statement", tags: ["net", "pf"] }),
      ...(withCustomise
        ? saved.map((s) =>
            meta(s.reportId, "customise", { title: s.name, description: s.description, icon: "SlidersHorizontal" }),
          )
        : []),
    ],
    options: {
      departments: [{ id: 3, name: "Stitching", category: "production" }],
      designations: [],
      branches: [{ id: 1, name: "Unit 1" }],
    },
  };
}
