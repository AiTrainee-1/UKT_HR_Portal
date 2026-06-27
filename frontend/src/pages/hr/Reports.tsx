import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import ExcelJS from "exceljs";
import {
  useListDepartments,
  useListEmployees,
} from "../../lib/api-client";
import { customFetch } from "../../lib/api-client/custom-fetch";
import HrLayout from "@/components/HrLayout";
import {
  FileText,
  BarChart2,
  Users,
  Calendar,
  DollarSign,
  TrendingDown,
  UserPlus,
  Download,
  Loader2,
  ChevronRight,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportColumn = {
  key: string;
  label: string;
  type?: "currency" | "number" | "percent" | "date" | "badge" | "text";
  badgeColors?: Record<string, string>;
  width?: number;
};

type FilterKey =
  | "month" | "year" | "dateFrom" | "dateTo"
  | "departmentId" | "employeeId" | "employmentType"
  | "status" | "weekNumber" | "advanceType" | "overdueOnly";

type ReportConfig = {
  id: string;
  label: string;
  description: string;
  category: string;
  icon: React.FC<{ className?: string }>;
  endpoint: string;
  columns: ReportColumn[];
  filters: FilterKey[];
  totalsKeys?: string[];
};

type Filters = Record<FilterKey, string>;

type ReportResponse = {
  count: number;
  results: Record<string, unknown>[];
  totals?: Record<string, number>;
  byDepartment?: Record<string, unknown>[];
  byType?: Record<string, number>;
  byGender?: Record<string, number>;
  total?: number;
  newThisMonth?: Record<string, unknown>[];
};

// ─── Report Definitions ───────────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const STATUS_COLORS: Record<string, string> = {
  pending:  "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  closed:   "bg-slate-100 text-slate-600",
  active:   "bg-blue-100 text-blue-800",
  inactive: "bg-slate-100 text-slate-500",
};

const REPORTS: ReportConfig[] = [
  // ── Attendance ─────────────────────────────────────────────────────────────
  {
    id: "attendance-summary",
    label: "Attendance Summary",
    description: "Monthly attendance overview per employee with present/absent/late days",
    category: "Attendance",
    icon: Calendar,
    endpoint: "/api/reports/attendance-summary",
    filters: ["month", "year", "departmentId", "employeeId", "employmentType"],
    columns: [
      { key: "employeeCode",   label: "Code",        type: "text",    width: 10 },
      { key: "employeeName",   label: "Employee",    type: "text",    width: 22 },
      { key: "department",     label: "Department",  type: "text",    width: 18 },
      { key: "monthName",      label: "Month",       type: "text",    width: 12 },
      { key: "totalDays",      label: "Total Days",  type: "number",  width: 10 },
      { key: "presentDays",    label: "Present",     type: "number",  width: 10 },
      { key: "absentDays",     label: "Absent",      type: "number",  width: 10 },
      { key: "lateDays",       label: "Late",        type: "number",  width: 10 },
      { key: "attendancePct",  label: "Attendance%", type: "percent", width: 12 },
      { key: "grossSalary",    label: "Gross",       type: "currency",width: 14 },
      { key: "netSalary",      label: "Net",         type: "currency",width: 14 },
    ],
  },
  {
    id: "attendance-log",
    label: "Punch Log",
    description: "Raw biometric/manual punch-in and punch-out records",
    category: "Attendance",
    icon: Calendar,
    endpoint: "/api/reports/attendance-log",
    filters: ["dateFrom", "dateTo", "departmentId", "employeeId", "employmentType"],
    columns: [
      { key: "employeeCode", label: "Code",       type: "text",  width: 10 },
      { key: "employeeName", label: "Employee",   type: "text",  width: 22 },
      { key: "department",   label: "Department", type: "text",  width: 18 },
      { key: "date",         label: "Date",       type: "date",  width: 12 },
      { key: "punchType",    label: "Type",       type: "badge", width: 8,
        badgeColors: { IN: "bg-green-100 text-green-800", OUT: "bg-red-100 text-red-700" } },
      { key: "punchTime",    label: "Time",       type: "text",  width: 10 },
      { key: "source",       label: "Source",     type: "text",  width: 12 },
    ],
  },
  // ── Leave ──────────────────────────────────────────────────────────────────
  {
    id: "leave",
    label: "Leave Report",
    description: "All leave applications with status, type, and approval details",
    category: "Leave",
    icon: FileText,
    endpoint: "/api/reports/leave",
    filters: ["year", "month", "departmentId", "employeeId", "status"],
    columns: [
      { key: "employeeCode", label: "Code",       type: "text",    width: 10 },
      { key: "employeeName", label: "Employee",   type: "text",    width: 22 },
      { key: "department",   label: "Department", type: "text",    width: 18 },
      { key: "leaveType",    label: "Leave Type", type: "text",    width: 16 },
      { key: "startDate",    label: "From",       type: "date",    width: 12 },
      { key: "endDate",      label: "To",         type: "date",    width: 12 },
      { key: "totalDays",    label: "Days",       type: "number",  width: 8  },
      { key: "status",       label: "Status",     type: "badge",   width: 12,
        badgeColors: STATUS_COLORS },
      { key: "approvedBy",   label: "Approved By",type: "text",    width: 16 },
    ],
  },
  {
    id: "leave-balance",
    label: "Leave Balance",
    description: "Current leave balances per employee showing allocated, used, and remaining",
    category: "Leave",
    icon: FileText,
    endpoint: "/api/reports/leave-balance",
    filters: ["year", "departmentId", "employeeId"],
    columns: [
      { key: "employeeCode", label: "Code",       type: "text",   width: 10 },
      { key: "employeeName", label: "Employee",   type: "text",   width: 22 },
      { key: "department",   label: "Department", type: "text",   width: 18 },
      { key: "leaveType",    label: "Leave Type", type: "text",   width: 16 },
      { key: "leaveCode",    label: "Code",       type: "text",   width: 8  },
      { key: "allocated",    label: "Allocated",  type: "number", width: 10 },
      { key: "used",         label: "Used",       type: "number", width: 10 },
      { key: "remaining",    label: "Remaining",  type: "number", width: 10 },
      { key: "carriedForward", label: "C/F",      type: "number", width: 8  },
    ],
  },
  // ── Payroll ────────────────────────────────────────────────────────────────
  {
    id: "payroll",
    label: "Salary Register",
    description: "Full payroll register with earnings, deductions, and net pay",
    category: "Payroll",
    icon: DollarSign,
    endpoint: "/api/reports/payroll",
    filters: ["month", "year", "departmentId", "employeeId", "employmentType", "weekNumber"],
    totalsKeys: ["grossSalary", "totalDeductions", "netSalary"],
    columns: [
      { key: "employeeCode",   label: "Code",       type: "text",    width: 10 },
      { key: "employeeName",   label: "Employee",   type: "text",    width: 22 },
      { key: "department",     label: "Department", type: "text",    width: 18 },
      { key: "presentDays",    label: "Present",    type: "number",  width: 8  },
      { key: "absentDays",     label: "Absent",     type: "number",  width: 8  },
      { key: "basic",          label: "Basic",      type: "currency",width: 12 },
      { key: "hra",            label: "HRA",        type: "currency",width: 12 },
      { key: "allowances",     label: "Allowances", type: "currency",width: 12 },
      { key: "otAmount",       label: "OT",         type: "currency",width: 12 },
      { key: "grossSalary",    label: "Gross",      type: "currency",width: 14 },
      { key: "pfDeduction",    label: "PF",         type: "currency",width: 12 },
      { key: "esiDeduction",   label: "ESI",        type: "currency",width: 12 },
      { key: "advanceDeduction", label: "Advance",  type: "currency",width: 12 },
      { key: "totalDeductions",  label: "Total Ded",type: "currency",width: 14 },
      { key: "netSalary",      label: "Net Pay",    type: "currency",width: 14 },
    ],
  },
  {
    id: "pf-esi",
    label: "PF / ESI Report",
    description: "Statutory PF and ESI contribution summary for compliance filing",
    category: "Payroll",
    icon: BarChart2,
    endpoint: "/api/reports/pf-esi",
    filters: ["month", "year", "departmentId", "employeeId"],
    totalsKeys: ["grossSalary", "pfDeduction", "esiDeduction"],
    columns: [
      { key: "employeeCode",  label: "Code",        type: "text",    width: 10 },
      { key: "employeeName",  label: "Employee",    type: "text",    width: 22 },
      { key: "department",    label: "Department",  type: "text",    width: 18 },
      { key: "uanNumber",     label: "UAN",         type: "text",    width: 16 },
      { key: "pfNumber",      label: "PF No.",      type: "text",    width: 16 },
      { key: "esiNumber",     label: "ESI No.",     type: "text",    width: 16 },
      { key: "grossSalary",   label: "Gross",       type: "currency",width: 14 },
      { key: "pfDeduction",   label: "PF Ded.",     type: "currency",width: 14 },
      { key: "esiDeduction",  label: "ESI Ded.",    type: "currency",width: 14 },
    ],
  },
  // ── Employees ──────────────────────────────────────────────────────────────
  {
    id: "employees",
    label: "Employee Master",
    description: "Complete employee directory with personal and statutory details",
    category: "Employees",
    icon: Users,
    endpoint: "/api/reports/employees",
    filters: ["departmentId", "employeeId", "employmentType", "status"],
    columns: [
      { key: "employeeCode",   label: "Code",         type: "text",  width: 10 },
      { key: "name",           label: "Name",         type: "text",  width: 22 },
      { key: "gender",         label: "Gender",       type: "text",  width: 8  },
      { key: "department",     label: "Department",   type: "text",  width: 18 },
      { key: "designation",    label: "Designation",  type: "text",  width: 18 },
      { key: "employmentType", label: "Type",         type: "text",  width: 12 },
      { key: "joinDate",       label: "Joined",       type: "date",  width: 12 },
      { key: "phone",          label: "Phone",        type: "text",  width: 14 },
      { key: "email",          label: "Email",        type: "text",  width: 22 },
      { key: "pfNumber",       label: "PF No.",       type: "text",  width: 14 },
      { key: "esiNumber",      label: "ESI No.",      type: "text",  width: 14 },
      { key: "bankAccount",    label: "Bank Acct",    type: "text",  width: 16 },
      { key: "bankIfsc",       label: "IFSC",         type: "text",  width: 12 },
    ],
  },
  {
    id: "headcount",
    label: "Headcount Report",
    description: "Workforce strength breakdown by department, type, and gender",
    category: "Employees",
    icon: BarChart2,
    endpoint: "/api/reports/headcount",
    filters: ["status"],
    columns: [
      { key: "department",  label: "Department",  type: "text",   width: 24 },
      { key: "staff",       label: "Staff",       type: "number", width: 10 },
      { key: "production",  label: "Production",  type: "number", width: 12 },
      { key: "male",        label: "Male",        type: "number", width: 10 },
      { key: "female",      label: "Female",      type: "number", width: 10 },
      { key: "total",       label: "Total",       type: "number", width: 10 },
    ],
  },
  // ── Finance ────────────────────────────────────────────────────────────────
  {
    id: "settlement",
    label: "Loan & Advance Report",
    description: "Outstanding loans, repayment status, and overdue advances",
    category: "Finance",
    icon: TrendingDown,
    endpoint: "/api/reports/settlement",
    filters: ["departmentId", "employeeId", "advanceType", "status", "overdueOnly"],
    totalsKeys: ["totalDisbursed", "totalRepaid", "totalOutstanding"],
    columns: [
      { key: "employeeCode",     label: "Code",        type: "text",    width: 10 },
      { key: "employeeName",     label: "Employee",    type: "text",    width: 22 },
      { key: "department",       label: "Department",  type: "text",    width: 18 },
      { key: "advanceTypeLabel", label: "Type",        type: "text",    width: 16 },
      { key: "amount",           label: "Amount",      type: "currency",width: 14 },
      { key: "totalRepaid",      label: "Repaid",      type: "currency",width: 14 },
      { key: "outstanding",      label: "Outstanding", type: "currency",width: 14 },
      { key: "emiAmount",        label: "EMI",         type: "currency",width: 12 },
      { key: "overdueMonths",    label: "Overdue Mo.", type: "number",  width: 12 },
      { key: "status",           label: "Status",      type: "badge",   width: 12,
        badgeColors: STATUS_COLORS },
    ],
  },
  // ── Other ──────────────────────────────────────────────────────────────────
  {
    id: "new-joinings",
    label: "New Joinings",
    description: "Employees who joined during the selected month",
    category: "Other",
    icon: UserPlus,
    endpoint: "/api/reports/new-joinings",
    filters: ["month", "year", "departmentId", "employmentType"],
    columns: [
      { key: "employeeCode",   label: "Code",        type: "text",  width: 10 },
      { key: "name",           label: "Name",        type: "text",  width: 22 },
      { key: "gender",         label: "Gender",      type: "text",  width: 8  },
      { key: "department",     label: "Department",  type: "text",  width: 18 },
      { key: "designation",    label: "Designation", type: "text",  width: 18 },
      { key: "employmentType", label: "Type",        type: "text",  width: 12 },
      { key: "joinDate",       label: "Join Date",   type: "date",  width: 12 },
      { key: "phone",          label: "Phone",       type: "text",  width: 14 },
      { key: "email",          label: "Email",       type: "text",  width: 22 },
    ],
  },
];

const CATEGORIES = ["Attendance", "Leave", "Payroll", "Employees", "Finance", "Other"];

// ─── Utility ─────────────────────────────────────────────────────────────────

function formatCell(value: unknown, col: ReportColumn): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (col.type) {
    case "currency": return `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
    case "number":   return String(Number(value));
    case "percent":  return `${value}%`;
    default:         return String(value);
  }
}

const defaultFilters = (): Filters => {
  const today = new Date();
  return {
    month:          String(today.getMonth() + 1),
    year:           String(today.getFullYear()),
    dateFrom:       "",
    dateTo:         "",
    departmentId:   "",
    employeeId:     "",
    employmentType: "",
    status:         "",
    weekNumber:     "",
    advanceType:    "",
    overdueOnly:    "",
  };
};

// ─── Excel export ─────────────────────────────────────────────────────────────

async function exportToExcel(
  report: ReportConfig,
  rows: Record<string, unknown>[],
  totals: Record<string, number> | undefined,
  subtitle: string,
) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(report.label.substring(0, 31));

  const HEADER_BG = "FF1E3A5F";
  const HEADER_FG = "FFFFFFFF";
  const TOTAL_BG  = "FFE8F5E9";
  const ALT_BG    = "FFF8FAFB";

  ws.columns = report.columns.map(c => ({ key: c.key, width: c.width ?? 14 }));

  // Title row
  ws.mergeCells(1, 1, 1, report.columns.length);
  const titleCell = ws.getCell("A1");
  titleCell.value = report.label.toUpperCase();
  titleCell.font  = { bold: true, size: 14, color: { argb: HEADER_BG } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 28;

  // Subtitle
  ws.mergeCells(2, 1, 2, report.columns.length);
  const subCell = ws.getCell("A2");
  subCell.value = subtitle;
  subCell.font  = { size: 10, color: { argb: "FF555555" } };
  subCell.alignment = { horizontal: "center" };
  ws.getRow(2).height = 18;

  // Header row
  const headerRow = ws.getRow(3);
  report.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label.toUpperCase();
    cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.font  = { bold: true, color: { argb: HEADER_FG }, size: 10 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FF999999" } } };
  });
  ws.getRow(3).height = 22;

  // Data rows
  rows.forEach((row, ri) => {
    const wsRow = ws.getRow(ri + 4);
    report.columns.forEach((col, ci) => {
      const cell = wsRow.getCell(ci + 1);
      const raw  = row[col.key];
      if (col.type === "currency" || col.type === "number" || col.type === "percent") {
        cell.value = raw !== null && raw !== undefined ? Number(raw) : null;
        if (col.type === "currency") cell.numFmt = '₹#,##0.00';
        if (col.type === "percent")  cell.numFmt = '0.0"%"';
      } else {
        cell.value = raw !== null && raw !== undefined ? String(raw) : "";
      }
      cell.alignment = { horizontal: "center", vertical: "middle" };
      if (ri % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALT_BG } };
      }
    });
    wsRow.height = 18;
  });

  // Totals row
  if (totals && report.totalsKeys?.length) {
    const totalRow = ws.getRow(rows.length + 4);
    totalRow.getCell(1).value = "TOTAL";
    totalRow.getCell(1).font  = { bold: true };
    report.columns.forEach((col, ci) => {
      const cell = totalRow.getCell(ci + 1);
      if (report.totalsKeys!.includes(col.key) && totals[col.key] !== undefined) {
        cell.value  = totals[col.key];
        cell.numFmt = '₹#,##0.00';
      }
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href    = url;
  a.download = `${report.id}-${Date.now()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Reports() {
  const [selectedId, setSelectedId]  = useState<string>(REPORTS[0].id);
  const [filters, setFilters]         = useState<Filters>(defaultFilters());
  const [queryParams, setQueryParams] = useState<Record<string, string> | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const report = REPORTS.find(r => r.id === selectedId)!;

  const { data: departments } = useListDepartments();
  const { data: employees }   = useListEmployees({ status: "active" });

  const reportQuery = useQuery<ReportResponse>({
    queryKey: ["report", selectedId, queryParams],
    queryFn: () => {
      const qs = new URLSearchParams(
        Object.entries(queryParams!).filter(([, v]) => v !== ""),
      );
      return customFetch<ReportResponse>(`${report.endpoint}?${qs.toString()}`);
    },
    enabled: queryParams !== null,
  });

  const setFilter = useCallback((key: FilterKey, value: string) => {
    setFilters(f => ({ ...f, [key]: value }));
  }, []);

  const handleSelectReport = (id: string) => {
    setSelectedId(id);
    setQueryParams(null);
    setFilters(defaultFilters());
  };

  const handleGenerate = () => {
    const params: Record<string, string> = {};
    for (const key of report.filters) {
      if (filters[key]) params[key] = filters[key];
    }
    setQueryParams(params);
  };

  const reportRows = (): Record<string, unknown>[] => {
    const data = reportQuery.data;
    if (!data) return [];
    if (report.id === "headcount") return (data.byDepartment ?? []) as Record<string, unknown>[];
    return data.results ?? [];
  };

  const buildSubtitle = (): string => {
    const parts: string[] = [];
    if (filters.month && filters.year && report.filters.includes("month")) {
      parts.push(`${MONTHS[Number(filters.month) - 1]} ${filters.year}`);
    } else if (filters.year && report.filters.includes("year")) {
      parts.push(filters.year);
    }
    if (filters.dateFrom) parts.push(`From: ${filters.dateFrom}`);
    if (filters.dateTo)   parts.push(`To: ${filters.dateTo}`);
    const dept = departments?.find(d => String(d.id) === filters.departmentId);
    if (dept) parts.push(dept.name);
    return parts.join(" · ") || "All Records";
  };

  const handleExport = async () => {
    const rows = reportRows();
    if (!rows.length) return;
    setIsExporting(true);
    try {
      await exportToExcel(report, rows, reportQuery.data?.totals, buildSubtitle());
    } finally {
      setIsExporting(false);
    }
  };

  const rows   = reportRows();
  const totals = reportQuery.data?.totals;

  return (
    <HrLayout>
    <div className="-m-4 lg:-m-6 flex h-screen bg-slate-50">
      {/* Report category sidebar */}
      <aside className="w-52 shrink-0 bg-white border-r border-slate-200 overflow-y-auto">
        <div className="px-4 pt-5 pb-3">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Reports</h2>
        </div>
        {CATEGORIES.map(cat => {
          const catReports = REPORTS.filter(r => r.category === cat);
          return (
            <div key={cat} className="mb-1">
              <div className="px-4 py-1.5 text-xs font-medium text-slate-400 uppercase tracking-wider">
                {cat}
              </div>
              {catReports.map(r => {
                const Icon   = r.icon;
                const active = r.id === selectedId;
                return (
                  <button
                    key={r.id}
                    onClick={() => handleSelectReport(r.id)}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors ${
                      active
                        ? "bg-blue-50 text-blue-700 border-r-2 border-blue-600 font-medium"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{r.label}</span>
                    {active && <ChevronRight className="w-3 h-3 ml-auto text-blue-500" />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </aside>

      {/* Main content area */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-slate-50">
        {/* Header + filters */}
        <div className="bg-white border-b border-slate-200 px-6 py-4">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-semibold text-slate-900">{report.label}</h1>
              <p className="text-sm text-slate-500 mt-0.5">{report.description}</p>
            </div>
            <div className="flex items-center gap-2 mt-1">
              {queryParams !== null && rows.length > 0 && (
                <button
                  onClick={handleExport}
                  disabled={isExporting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-green-600 text-green-700 rounded-lg hover:bg-green-50 transition-colors disabled:opacity-50"
                >
                  {isExporting
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Download className="w-4 h-4" />}
                  Export Excel
                </button>
              )}
              <button
                onClick={handleGenerate}
                disabled={reportQuery.isFetching}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60"
              >
                {reportQuery.isFetching
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <RefreshCw className="w-4 h-4" />}
                Generate
              </button>
            </div>
          </div>

          {/* Filters row */}
          <div className="flex flex-wrap gap-3 mt-4">
            {report.filters.includes("month") && (
              <FilterField label="Month">
                <select
                  value={filters.month}
                  onChange={e => setFilter("month", e.target.value)}
                  className={selectClass}
                >
                  {MONTHS.map((m, i) => (
                    <option key={i + 1} value={i + 1}>{m}</option>
                  ))}
                </select>
              </FilterField>
            )}

            {report.filters.includes("year") && (
              <FilterField label="Year">
                <select
                  value={filters.year}
                  onChange={e => setFilter("year", e.target.value)}
                  className={selectClass}
                >
                  {[2023, 2024, 2025, 2026, 2027].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </FilterField>
            )}

            {report.filters.includes("dateFrom") && (
              <FilterField label="Date From">
                <input type="date" value={filters.dateFrom}
                  onChange={e => setFilter("dateFrom", e.target.value)}
                  className={inputClass} />
              </FilterField>
            )}

            {report.filters.includes("dateTo") && (
              <FilterField label="Date To">
                <input type="date" value={filters.dateTo}
                  onChange={e => setFilter("dateTo", e.target.value)}
                  className={inputClass} />
              </FilterField>
            )}

            {report.filters.includes("departmentId") && (
              <FilterField label="Department">
                <select
                  value={filters.departmentId}
                  onChange={e => setFilter("departmentId", e.target.value)}
                  className={selectClass}
                >
                  <option value="">All Departments</option>
                  {departments?.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </FilterField>
            )}

            {report.filters.includes("employeeId") && (
              <FilterField label="Employee">
                <select
                  value={filters.employeeId}
                  onChange={e => setFilter("employeeId", e.target.value)}
                  className={`${selectClass} min-w-[180px]`}
                >
                  <option value="">All Employees</option>
                  {employees?.map(e => (
                    <option key={e.id} value={e.id}>
                      {e.employeeCode} — {e.firstName} {e.lastName}
                    </option>
                  ))}
                </select>
              </FilterField>
            )}

            {report.filters.includes("employmentType") && (
              <FilterField label="Type">
                <select
                  value={filters.employmentType}
                  onChange={e => setFilter("employmentType", e.target.value)}
                  className={selectClass}
                >
                  <option value="">All Types</option>
                  <option value="staff">Staff</option>
                  <option value="production">Production</option>
                </select>
              </FilterField>
            )}

            {report.filters.includes("weekNumber") && filters.employmentType === "production" && (
              <FilterField label="Week">
                <select
                  value={filters.weekNumber}
                  onChange={e => setFilter("weekNumber", e.target.value)}
                  className={selectClass}
                >
                  <option value="">All Weeks</option>
                  <option value="1">Week 1 &amp; 2 (1–15)</option>
                  <option value="2">Week 3 &amp; 4 (16–end)</option>
                </select>
              </FilterField>
            )}

            {report.filters.includes("status") && report.id === "leave" && (
              <FilterField label="Status">
                <select value={filters.status} onChange={e => setFilter("status", e.target.value)} className={selectClass}>
                  <option value="">All</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </FilterField>
            )}

            {report.filters.includes("status") && report.id === "employees" && (
              <FilterField label="Status">
                <select value={filters.status} onChange={e => setFilter("status", e.target.value)} className={selectClass}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="terminated">Terminated</option>
                </select>
              </FilterField>
            )}

            {report.filters.includes("status") && report.id === "headcount" && (
              <FilterField label="Status">
                <select value={filters.status} onChange={e => setFilter("status", e.target.value)} className={selectClass}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FilterField>
            )}

            {report.filters.includes("status") && report.id === "settlement" && (
              <FilterField label="Status">
                <select value={filters.status} onChange={e => setFilter("status", e.target.value)} className={selectClass}>
                  <option value="">All</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="closed">Closed</option>
                  <option value="rejected">Rejected</option>
                </select>
              </FilterField>
            )}

            {report.filters.includes("advanceType") && (
              <FilterField label="Loan Type">
                <select value={filters.advanceType} onChange={e => setFilter("advanceType", e.target.value)} className={selectClass}>
                  <option value="">All</option>
                  <option value="general">General Advance</option>
                  <option value="term">Term Loan</option>
                </select>
              </FilterField>
            )}

            {report.filters.includes("overdueOnly") && (
              <div className="flex flex-col gap-1 justify-end">
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none pb-2">
                  <input
                    type="checkbox"
                    checked={filters.overdueOnly === "true"}
                    onChange={e => setFilter("overdueOnly", e.target.checked ? "true" : "")}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  Overdue only
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Results area */}
        <div className="flex-1 overflow-auto p-6">
          {queryParams === null && (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <BarChart2 className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-base font-medium">Set filters and click Generate</p>
              <p className="text-sm mt-1">The report preview will appear here.</p>
            </div>
          )}

          {reportQuery.isFetching && (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
              <span className="ml-3 text-slate-500">Generating report…</span>
            </div>
          )}

          {reportQuery.isError && !reportQuery.isFetching && (
            <div className="flex items-center gap-3 p-4 bg-red-50 text-red-700 rounded-xl border border-red-200">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span className="text-sm">Failed to load report. Check filters and try again.</span>
            </div>
          )}

          {!reportQuery.isFetching && !reportQuery.isError && report.id === "headcount" && reportQuery.data && (
            <HeadcountView data={reportQuery.data} />
          )}

          {!reportQuery.isFetching && !reportQuery.isError && report.id !== "headcount" && queryParams !== null && (
            <>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-slate-500">
                  {rows.length} record{rows.length !== 1 ? "s" : ""} · {buildSubtitle()}
                </span>
                {totals && report.totalsKeys && (
                  <div className="flex items-center gap-4">
                    {report.totalsKeys.map(k => (
                      <span key={k} className="text-sm text-slate-700">
                        <span className="text-slate-400 text-xs mr-1">
                          {report.columns.find(c => c.key === k)?.label}:
                        </span>
                        <strong>₹{Number(totals[k]).toLocaleString("en-IN")}</strong>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {rows.length === 0 ? (
                <div className="text-center py-20 text-slate-400">
                  <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p>No records found for the selected filters.</p>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-800 text-white sticky top-0 z-10">
                        <tr>
                          <th className="px-3 py-2.5 text-center font-medium w-10">#</th>
                          {report.columns.map(col => (
                            <th key={col.key} className="px-3 py-2.5 text-center font-medium whitespace-nowrap">
                              {col.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, ri) => (
                          <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                            <td className="px-3 py-2 text-center text-slate-400">{ri + 1}</td>
                            {report.columns.map(col => {
                              const val = row[col.key];
                              if (col.type === "badge") {
                                const valStr = String(val ?? "");
                                const cls = col.badgeColors?.[valStr] ?? "bg-slate-100 text-slate-600";
                                return (
                                  <td key={col.key} className="px-3 py-2 text-center">
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
                                      {valStr}
                                    </span>
                                  </td>
                                );
                              }
                              return (
                                <td
                                  key={col.key}
                                  className={`px-3 py-2 text-center whitespace-nowrap ${
                                    col.type === "currency" ? "font-mono text-slate-800" :
                                    col.type === "number"   ? "tabular-nums" :
                                    "text-slate-700"
                                  }`}
                                >
                                  {formatCell(val, col)}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                      {totals && report.totalsKeys?.length && (
                        <tfoot className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
                          <tr>
                            <td className="px-3 py-2.5 text-center text-slate-400 text-xs">—</td>
                            {report.columns.map(col => (
                              <td key={col.key} className="px-3 py-2.5 text-center text-xs">
                                {report.totalsKeys!.includes(col.key) && totals[col.key] !== undefined
                                  ? `₹${Number(totals[col.key]).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
                                  : ""}
                              </td>
                            ))}
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
    </HrLayout>
  );
}

// ─── Headcount special view ───────────────────────────────────────────────────

function HeadcountView({ data }: { data: ReportResponse }) {
  const byDept   = data.byDepartment ?? [];
  const byType   = data.byType ?? {};
  const byGender = data.byGender ?? {};
  const newJoins = data.newThisMonth ?? [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard label="Total Headcount" value={String(data.total ?? 0)} accent="blue" />
        <SummaryCard label="Staff"           value={String(byType.staff      ?? 0)} accent="purple" />
        <SummaryCard label="Production"      value={String(byType.production ?? 0)} accent="amber" />
        <SummaryCard label="New This Month"  value={String(newJoins.length)} accent="green" />
      </div>

      <div className="flex gap-4">
        {Object.entries(byGender).map(([g, cnt]) => (
          <div key={g} className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-slate-200 text-sm">
            <span className="font-medium capitalize text-slate-700">{g}:</span>
            <span className="text-slate-900 font-semibold">{cnt}</span>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">By Department</h3>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-white">
            <tr>
              {["Department","Staff","Production","Male","Female","Total"].map(h => (
                <th key={h} className={`px-4 py-2.5 font-medium ${h === "Department" ? "text-left" : "text-center"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byDept.map((row, i) => {
              const r = row as Record<string, unknown>;
              return (
                <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                  <td className="px-4 py-2 font-medium text-slate-800">{String(r.department)}</td>
                  <td className="px-4 py-2 text-center">{String(r.staff ?? 0)}</td>
                  <td className="px-4 py-2 text-center">{String(r.production ?? 0)}</td>
                  <td className="px-4 py-2 text-center">{String(r.male ?? 0)}</td>
                  <td className="px-4 py-2 text-center">{String(r.female ?? 0)}</td>
                  <td className="px-4 py-2 text-center font-bold text-slate-900">{String(r.total ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {newJoins.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700">New Joinings This Month ({newJoins.length})</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-100">
              <tr>
                {["Code","Name","Department","Type","Join Date"].map(h => (
                  <th key={h} className="px-4 py-2 text-left font-medium text-slate-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {newJoins.map((nj, i) => {
                const r = nj as Record<string, unknown>;
                return (
                  <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                    <td className="px-4 py-2 font-mono text-slate-700">{String(r.employeeCode)}</td>
                    <td className="px-4 py-2 text-slate-800 font-medium">{String(r.name)}</td>
                    <td className="px-4 py-2 text-slate-600">{String(r.department)}</td>
                    <td className="px-4 py-2 text-slate-600 capitalize">{String(r.employmentType)}</td>
                    <td className="px-4 py-2 text-slate-600">{String(r.joinDate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  const colors: Record<string, string> = {
    blue:   "bg-blue-50 border-blue-200 text-blue-700",
    purple: "bg-purple-50 border-purple-200 text-purple-700",
    amber:  "bg-amber-50 border-amber-200 text-amber-700",
    green:  "bg-green-50 border-green-200 text-green-700",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[accent] ?? colors.blue}`}>
      <p className="text-xs font-medium opacity-70">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}

// ─── Shared classes ───────────────────────────────────────────────────────────

const selectClass = "text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500";
const inputClass  = "text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500";

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-500">{label}</label>
      {children}
    </div>
  );
}
