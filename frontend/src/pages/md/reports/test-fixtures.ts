// Fixtures for the MD Reports tests: the shapes /api/reports/catalog and /api/reports/run/<id> really send (see
// lib/report-center.ts and backend api/reporting/views.py), small enough to check by eye.

import type {
  ReportCatalog,
  ReportCategory,
  ReportColumn,
  ReportFilter,
  ReportMeta,
  ReportRunResult,
} from "@/lib/report-center";

export const meta = (id: string, category: string, over: Partial<ReportMeta> = {}): ReportMeta => ({
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

export const column = (
  key: string,
  label: string,
  type: ReportColumn["type"],
  total: ReportColumn["total"] = null,
): ReportColumn => ({ key, label, type, width: 1, total, align: null });

const filter = (over: Partial<ReportFilter> & Pick<ReportFilter, "key" | "kind" | "label">): ReportFilter => ({
  required: false,
  multi: false,
  default: null,
  ...over,
});

export const CATEGORIES: ReportCategory[] = [
  {
    id: "payroll",
    label: "Payroll & Salary",
    description: "Slips, registers and statutory statements",
    icon: "Wallet",
    count: 2,
  },
  {
    id: "attendance",
    label: "Attendance",
    description: "Daily attendance, late coming and shifts",
    icon: "CalendarCheck",
    count: 2,
  },
  {
    id: "gate",
    label: "Gate & Visitors",
    description: "Outpass, visitor and tea-break registers",
    icon: "DoorOpen",
    count: 1,
  },
  { id: "employees", label: "Employees", description: "Master data, headcount and joiners", icon: "Users", count: 1 },
];

export const EXECUTIVE: ReportCategory = {
  id: "md",
  label: "Executive (MD)",
  description: "One-page executive summaries for the Managing Director",
  icon: "Landmark",
  count: 1,
};

const PERIOD = filter({ key: "period", kind: "period", label: "Month", required: true, default: "2026-09" });
const RANGE = filter({
  key: "dateRange",
  kind: "dateRange",
  label: "Date range",
  required: true,
  default: { dateFrom: "2026-10-01", dateTo: "2026-10-05" },
  maxDays: 92,
});

/** Seven reports in six library entries (the two late-coming views are one), plus one executive report. */
export const REPORTS: ReportMeta[] = [
  meta("salary-register", "payroll", {
    title: "Salary Register",
    description: "Monthly salary for every employee, with deductions and net pay.",
    icon: "Wallet",
    tags: ["wages", "payroll"],
    filters: [PERIOD],
  }),
  meta("pf-statement", "payroll", {
    title: "PF Statement",
    description: "Provident fund contributions per employee for the month.",
    icon: "Landmark",
    tags: ["epf"],
    filters: [PERIOD],
  }),
  meta("daily-attendance", "attendance", {
    title: "Daily Attendance",
    description: "Who was present, absent or late on a day.",
    icon: "CalendarCheck",
    filters: [RANGE],
  }),
  meta("late-coming-detail", "attendance", {
    title: "Late Coming Detail",
    description: "Every late arrival with the minutes late.",
    icon: "Clock",
    family: "late-coming",
    variant: "Detail",
    tags: ["late"],
    filters: [RANGE],
  }),
  meta("late-coming-counts", "attendance", {
    title: "Late Coming Summary",
    description: "Late arrivals counted per employee.",
    icon: "Clock",
    family: "late-coming",
    variant: "Counts",
    filters: [RANGE],
  }),
  meta("visitor-register", "gate", {
    title: "Visitor Register",
    description: "Visitors in and out of the gate.",
    icon: "DoorOpen",
    tags: ["visitors"],
    filters: [RANGE],
  }),
  meta("employee-master", "employees", {
    title: "Employee Master",
    description: "Every employee with department, designation and joining date.",
    icon: "Users",
    filters: [
      filter({ key: "department", kind: "department", label: "Department", multi: true, default: [] }),
      filter({
        key: "employeeStatus",
        kind: "employeeStatus",
        label: "Employee status",
        default: "active",
        options: [
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
          { value: "all", label: "All" },
        ],
      }),
    ],
  }),
];

export const DAILY_BRIEF = meta("md-daily-brief", "md", {
  title: "Daily Brief",
  description: "One page for yesterday: attendance, absentees, visitors and payroll movement.",
  icon: "Landmark",
  landscape: false,
});

/** The catalog the MD gets. `executive: false` is today's reality (no executive report has been written yet). */
export function catalogFixture({ executive = true }: { executive?: boolean } = {}): ReportCatalog {
  return {
    generatedAt: "2026-10-05 10:42",
    branchScoped: false,
    categories: executive ? [...CATEGORIES, EXECUTIVE] : CATEGORIES,
    reports: executive ? [...REPORTS, DAILY_BRIEF] : REPORTS,
    options: {
      departments: [
        { id: 10, name: "Stitching" },
        { id: 11, name: "Cutting" },
      ],
      designations: [],
      branches: [
        { id: 1, name: "Unit 1" },
        { id: 2, name: "Head Office" },
      ],
    },
  };
}

const EMPLOYEE_COLUMNS = [
  column("code", "Code", "text"),
  column("name", "Name", "text"),
  column("department", "Department", "text"),
  column("status", "Status", "badge"),
  column("salary", "Monthly salary", "currency", "sum"),
];

/** Employee Master with its three people; `count` adds more rows (for "prints every row, not just the page"). */
export function employeeMasterRun(over: Partial<ReportRunResult> = {}, count = 3): ReportRunResult {
  const people = [
    { code: "E001", name: "Asha Kumar", department: "Stitching", status: "Active", salary: 24000 },
    { code: "E002", name: "Ravi Nair", department: "Cutting", status: "Active", salary: 31000 },
    { code: "E003", name: "Meena Nosalary", department: "Accounts", status: "Active", salary: null },
  ];
  const rows = Array.from({ length: count }, (_, i) =>
    i < people.length
      ? people[i]
      : {
          code: `E${String(i + 1).padStart(3, "0")}`,
          name: `Worker ${i + 1}`,
          department: "Stitching",
          status: "Active",
          salary: 10000,
        },
  );
  const bill = rows.reduce((sum, r) => sum + (r.salary ?? 0), 0);
  return {
    id: "employee-master",
    title: "Employee Master",
    category: "employees",
    generatedAt: "2026-10-05 10:42",
    generatedBy: "Test MD",
    filters: [{ label: "Employee status", value: "Active" }],
    columns: EMPLOYEE_COLUMNS,
    rows,
    totals: { salary: bill },
    summary: [
      { label: "Employees", value: rows.length, format: "integer" },
      { label: "Salary bill", value: bill, format: "currency" },
    ],
    notes: ["Salaries are monthly gross."],
    rowCount: rows.length,
    truncated: false,
    limit: 10000,
    ...over,
  };
}

/** A one-row result for any other report in the catalog. */
export const simpleRun = (id: string, title: string, category: string): ReportRunResult => ({
  id,
  title,
  category,
  generatedAt: "2026-10-05 10:42",
  generatedBy: "Test MD",
  filters: [{ label: "Date range", value: "01-Oct-2026 to 05-Oct-2026" }],
  columns: [column("name", "Name", "text"), column("minutes", "Minutes late", "minutes", "sum")],
  rows: [{ name: "Asha Kumar", minutes: 12 }],
  totals: { minutes: 12 },
  summary: [],
  notes: [],
  rowCount: 1,
  truncated: false,
  limit: 10000,
});

/** A run with nothing in it (the filters match no one). */
export const emptyRun = (): ReportRunResult =>
  employeeMasterRun({ rows: [], totals: null, summary: [], notes: [], rowCount: 0 }, 0);
