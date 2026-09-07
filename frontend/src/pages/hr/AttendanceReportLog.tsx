import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import ExcelJS from "exceljs";
import html2canvas from "html2canvas-pro";
import jsPDF from "jspdf";
import HrLayout from "@/components/HrLayout";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceReportSummary, useAttendanceReportDetail, useAttendanceLateSummary,
  usePayrollSettings, useAttendanceReportDaily, useSetDayInformed,
  type ShiftLogEntry, type MonthlySummaryRow, type ReportLogDailyRow,
} from "@/lib/api-client/custom-hooks";
import { useListDepartments } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { AttendanceLoader } from "@/components/ui/AttendanceLoader";
import {
  ClipboardList, AlertTriangle, ChevronLeft, ChevronDown, ChevronUp, Search, Users, Building2, Loader2,
  CalendarDays, FileSpreadsheet, FileImage, FileText, CheckSquare, Square,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────

const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_STYLES: Record<ShiftLogEntry["status"], string> = {
  present: "bg-green-100 text-green-700",
  half_shift: "bg-amber-100 text-amber-700",
  absent: "bg-red-100 text-red-700",
  on_leave: "bg-blue-100 text-blue-700",
  holiday: "bg-gray-100 text-gray-600",
};

const STATUS_LABELS: Record<ShiftLogEntry["status"], string> = {
  present: "Present",
  half_shift: "Half Shift",
  absent: "Absent",
  on_leave: "On Leave",
  holiday: "Holiday",
};

function StatusBadge({ status }: { status: ShiftLogEntry["status"] }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// The backend only ever sends approved CL/Permission/Leave rows here
// (pending and rejected requests aren't final, so they don't belong on an
// attendance report) -a present row is always "approved", hence the fixed
// green style on all three badges below.
function CasualLeaveBadge({ cl }: { cl: ShiftLogEntry["casualLeave"] }) {
  if (!cl) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap bg-green-50 text-green-700 border-green-200"
      title={cl.reason ?? ""}
    >
      CL · Approved
    </span>
  );
}

function PermissionBadge({ perm }: { perm: ShiftLogEntry["permission"] }) {
  if (!perm) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap bg-green-50 text-green-700 border-green-200"
      title={perm.reason ?? ""}
    >
      Perm {perm.time ? `· ${perm.time}` : ""} · Approved
    </span>
  );
}

function LeaveBadge({ leave }: { leave: ShiftLogEntry["leave"] }) {
  if (!leave) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap bg-blue-50 text-blue-700 border-blue-200"
      title={leave.reason ?? ""}
    >
      {leave.type ?? "Leave"} · Approved
    </span>
  );
}

function LateCell({ row }: { row: ShiftLogEntry }) {
  const permParts = [
    row.permissionMorning && "Morning",
    row.permissionAfternoon && "Afternoon",
    row.permissionDeparture && "Departure",
  ].filter(Boolean) as string[];
  const anyWithRequest = row.permissionMorningWithRequest || row.permissionAfternoonWithRequest || row.permissionDepartureWithRequest;

  if (permParts.length > 0) {
    return (
      <span
        className="flex items-center gap-1.5 text-emerald-700 font-semibold text-xs"
        title={row.lateReason ?? ""}
      >
        <AlertTriangle size={13} />
        Permission ({permParts.join(" + ")}) · {anyWithRequest ? "With Request" : "Without Request"}
      </span>
    );
  }
  if (!row.isLate) return <span className="text-green-600 text-sm">✓</span>;
  const parts = [row.lateMorning && "AM", row.lateAfternoon && "Night", row.lateReturn && !row.lateAfternoon && "Return"].filter(Boolean);
  return (
    <span className="flex items-center gap-1.5 text-red-600 font-semibold text-xs" title={row.lateReason ?? ""}>
      <AlertTriangle size={13} />
      {parts.length > 0 ? parts.join(" + ") : "Late"}
    </span>
  );
}

// ── Daily Report helpers (Late/Permission/On-Leave export, this page only) ──

function dailyIsPermission(row: ReportLogDailyRow): boolean {
  return row.permissionMorning || row.permissionAfternoon || row.permissionDeparture;
}

function dailyStatusLabel(row: ReportLogDailyRow): string {
  if (dailyIsPermission(row)) return "Permission";
  if (row.isLate) return row.lateAfternoon ? "Night Late" : "Late";
  if (row.status === "on_leave") return "On Leave";
  if (row.status === "half_shift") return "Half Shift";
  if (row.status === "absent") return "Absent";
  if (row.status === "holiday") return "Holiday";
  return "Present";
}

function dailyRowCategories(row: ReportLogDailyRow): Array<"late_permission" | "on_leave"> {
  const cats: Array<"late_permission" | "on_leave"> = [];
  if (row.isLate || dailyIsPermission(row)) cats.push("late_permission");
  if (row.status === "on_leave") cats.push("on_leave");
  return cats;
}

const formatDMY = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

const remarksLabel = (row: ReportLogDailyRow): string =>
  row.status === "on_leave"
    ? (row.isInformed === true ? "Informed" : row.isInformed === false ? "Not informed" : "Unset")
    : dailyStatusLabel(row);

const remarksColor = (row: ReportLogDailyRow): string | undefined =>
  row.status === "on_leave"
    ? (row.isInformed === true ? "#92d050" : row.isInformed === false ? "#ffa500" : "#dddddd")
    : undefined;

const exportCellStyle: CSSProperties = { border: "1px solid #333", padding: "5px 6px", textAlign: "center" };

// ── Component ──────────────────────────────────────────────────────────────

export default function AttendanceReportLog() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();

  const [viewMode, setViewMode] = useState<"monthly" | "daily">("monthly");

  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const [department, setDepartment] = useState("");
  const [search, setSearch] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [showLatePenalty, setShowLatePenalty] = useState(false);

  // ── Daily Report (Late/Permission/On-Leave filter + Informed + export) ──
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const [dailyDate, setDailyDate] = useState(todayIso());
  const [dailyDepartment, setDailyDepartment] = useState("");
  const [dailySearch, setDailySearch] = useState("");
  const [categoryFilters, setCategoryFilters] = useState<Set<"late_permission" | "on_leave">>(new Set());
  const [informedFilter, setInformedFilter] = useState<"all" | "informed" | "not_informed" | "unset">("all");
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState<"excel" | "pdf" | "image" | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const { data: departments } = useListDepartments();
  const { data: settings } = usePayrollSettings();
  const simpleMode = settings?.attendanceMode === "simple";

  const setInformedMutation = useSetDayInformed();
  const { data: dailyData, isLoading: dailyLoading } = useAttendanceReportDaily(
    { date: dailyDate, department: dailyDepartment ? Number(dailyDepartment) : undefined, search: dailySearch || undefined },
    viewMode === "daily",
  );
  const dailyRows = dailyData?.rows ?? [];

  const filteredDailyRows = useMemo(() => {
    return dailyRows.filter((row) => {
      const cats = dailyRowCategories(row);
      const categoryOk = categoryFilters.size === 0 || cats.some((c) => categoryFilters.has(c));
      if (!categoryOk) return false;
      if (informedFilter === "all") return true;
      if (row.status !== "on_leave") return false;
      if (informedFilter === "informed") return row.isInformed === true;
      if (informedFilter === "not_informed") return row.isInformed === false;
      return row.isInformed === null;
    });
  }, [dailyRows, categoryFilters, informedFilter]);

  const toggleCategory = (cat: "late_permission" | "on_leave") => {
    setCategoryFilters((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const toggleRowSelected = (id: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allFilteredSelected = filteredDailyRows.length > 0 && filteredDailyRows.every((r) => selectedRows.has(r.employeeId));
  const toggleSelectAllFiltered = () => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredDailyRows.forEach((r) => next.delete(r.employeeId));
      } else {
        filteredDailyRows.forEach((r) => next.add(r.employeeId));
      }
      return next;
    });
  };

  const selectedDailyRows = dailyRows.filter((r) => selectedRows.has(r.employeeId));

  const handleSetInformed = async (row: ReportLogDailyRow, value: boolean | null) => {
    try {
      await setInformedMutation.mutateAsync({ employeeId: row.employeeId, date: dailyDate, isInformed: value });
    } catch {
      toast({ title: "Failed to update Informed status", variant: "destructive" });
    }
  };

  const reportTitle = useMemo(() => {
    const onlyLeave = categoryFilters.size === 1 && categoryFilters.has("on_leave");
    const onlyLate = categoryFilters.size === 1 && categoryFilters.has("late_permission");
    const label = onlyLeave ? "STAFF LEAVE LIST" : onlyLate ? "LATE / PERMISSION LIST" : "ATTENDANCE EXCEPTION REPORT";
    return `${formatDMY(dailyDate)} ${label}`;
  }, [dailyDate, categoryFilters]);

  async function exportDailyExcel() {
    if (selectedDailyRows.length === 0) return;
    setExporting("excel");
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Report");
      ws.columns = [{ width: 6 }, { width: 14 }, { width: 26 }, { width: 20 }, { width: 26 }, { width: 16 }];

      ws.mergeCells("A1:F1");
      const nameCell = ws.getCell("A1");
      nameCell.value = settings?.companyName ?? "Company";
      nameCell.font = { bold: true, size: 14 };
      nameCell.alignment = { horizontal: "center" };

      ws.mergeCells("A2:F2");
      const branchCell = ws.getCell("A2");
      branchCell.value = user?.branchName ? `${user.branchName} Branch` : "All Branches";
      branchCell.font = { size: 10, color: { argb: "FF666666" } };
      branchCell.alignment = { horizontal: "center" };

      if (settings?.companyLogo?.startsWith("data:image")) {
        try {
          const match = settings.companyLogo.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
          if (match) {
            const ext = match[1].toLowerCase().startsWith("jpg") || match[1].toLowerCase().startsWith("jpeg") ? "jpeg" : "png";
            const imageId = wb.addImage({ base64: settings.companyLogo, extension: ext as "png" | "jpeg" });
            ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 50, height: 50 } });
          }
        } catch {
          // Non-critical -export continues without the logo.
        }
      }

      ws.mergeCells("A3:F3");
      const titleCell = ws.getCell("A3");
      titleCell.value = reportTitle;
      titleCell.font = { bold: true, size: 13 };
      titleCell.alignment = { horizontal: "center", vertical: "middle" };
      titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8A9A3" } };
      ws.getRow(3).height = 24;

      const headerRow = ws.getRow(5);
      ["S.No", "Ticket No", "Employee Name", "Department", "Designation", "Remarks"].forEach((c, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = c;
        cell.font = { bold: true };
        cell.border = { bottom: { style: "thin" }, top: { style: "thin" } };
        cell.alignment = { horizontal: "center" };
      });

      selectedDailyRows.forEach((row, i) => {
        const r = ws.getRow(6 + i);
        r.getCell(1).value = i + 1;
        r.getCell(2).value = row.employeeCode;
        r.getCell(3).value = row.employeeName;
        r.getCell(4).value = row.department ?? "—";
        r.getCell(5).value = row.designation ?? "—";
        const remarksCell = r.getCell(6);
        remarksCell.value = remarksLabel(row);
        const color = remarksColor(row);
        if (color) {
          remarksCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color.replace("#", "")}` } };
        }
        remarksCell.font = { bold: true };
        remarksCell.alignment = { horizontal: "center" };
        for (let c = 1; c <= 6; c++) r.getCell(c).border = { bottom: { style: "hair" } };
      });

      const footerRowIdx = 6 + selectedDailyRows.length + 2;
      ws.getCell(`A${footerRowIdx}`).value = `Generated by ${settings?.companyName ?? ""} HRMS`;
      ws.getCell(`A${footerRowIdx}`).font = { italic: true, size: 9, color: { argb: "FF999999" } };

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportTitle.replace(/[^a-z0-9]+/gi, "_")}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Failed to export Excel", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  async function exportDailyVisual(format: "pdf" | "image") {
    if (selectedDailyRows.length === 0 || !exportRef.current) return;
    setExporting(format);
    try {
      const canvas = await html2canvas(exportRef.current, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
      if (format === "image") {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("Failed to render image");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${reportTitle.replace(/[^a-z0-9]+/gi, "_")}.png`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const imgData = canvas.toDataURL("image/png");
        const pdf = new jsPDF({
          orientation: canvas.width > canvas.height ? "landscape" : "portrait",
          unit: "px",
          format: [canvas.width, canvas.height],
        });
        pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
        pdf.save(`${reportTitle.replace(/[^a-z0-9]+/gi, "_")}.pdf`);
      }
    } catch {
      toast({ title: `Failed to export ${format === "pdf" ? "PDF" : "image"}`, variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  const isDetail = selectedEmployeeId != null;

  const { data: summaryData, isLoading: summaryLoading } = useAttendanceReportSummary(
    { month, year, department: department ? Number(department) : undefined, search: search || undefined },
    !isDetail,
  );

  const { data: detailData, isLoading: detailLoading } = useAttendanceReportDetail(
    { month, year, employeeId: selectedEmployeeId ?? 0 },
    isDetail,
  );

  const { data: lateData, isLoading: lateLoading } = useAttendanceLateSummary(month, year, showLatePenalty);

  function renderRow(row: ShiftLogEntry) {
    return (
      <tr
        key={row.date}
        className={`border-b hover:bg-gray-50 transition-colors ${
          row.status === "absent" ? "bg-red-50/30" : row.isHalfShift ? "bg-amber-50/30" : ""
        }`}
      >
        <td className="px-3 py-2.5 text-xs font-mono text-gray-700 whitespace-nowrap">{row.date}</td>
        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
          {row.assignedShift ? (
            <>
              <p className="font-medium text-gray-700">{row.assignedShift.name}</p>
              <p className="text-[10px] text-gray-400">
                {row.assignedShift.startTime}–{row.assignedShift.endTime} · Grace {row.assignedShift.gracePeriodMinutes}m
              </p>
            </>
          ) : (
            <span className="text-gray-300">No shift assigned</span>
          )}
        </td>
        <td className="px-4 py-3 font-mono text-sm whitespace-nowrap">
          {row.punch1
            ? <span className={row.lateMorning ? "text-red-600 font-bold" : "text-green-700"}>{row.punch1}</span>
            : <span className="text-gray-300">—</span>}
        </td>
        {!simpleMode && (
          <>
            <td className="px-4 py-3 font-mono text-sm text-gray-600 whitespace-nowrap">{row.punch2 ?? <span className="text-gray-300">—</span>}</td>
            <td className="px-4 py-3 font-mono text-sm whitespace-nowrap">
              {row.punch3
                ? <span className={row.lateReturn ? "text-orange-600 font-bold" : "text-gray-700"}>{row.punch3}</span>
                : <span className="text-gray-300">—</span>}
            </td>
          </>
        )}
        <td className="px-4 py-3 font-mono text-sm text-gray-600 whitespace-nowrap">{row.punch4 ?? <span className="text-gray-300">—</span>}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1 flex-wrap">
            <StatusBadge status={row.status} />
            {row.isCompensationDay && (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap bg-purple-100 text-purple-700"
                title="HR-announced Compensation Day -Late/Permission penalties exempted; Full/Half still judged from real punches"
              >
                Comp Day
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          <span className={`font-bold ${row.isHalfShift ? "text-amber-700" : "text-gray-800"}`}>{row.shiftsCompleted}</span>
        </td>
        <td className="px-4 py-3"><LateCell row={row} /></td>
        <td className="px-4 py-3"><CasualLeaveBadge cl={row.casualLeave} /></td>
        <td className="px-4 py-3"><PermissionBadge perm={row.permission} /></td>
        <td className="px-4 py-3"><LeaveBadge leave={row.leave} /></td>
      </tr>
    );
  }

  const columnHeaders = [
    "Date", "Assigned Shift", "P1 · Morning IN",
    ...(simpleMode ? [] : ["P2 · Lunch OUT", "P3 · Lunch IN"]),
    "P4 · Evening OUT", "Status", "Shifts", "Late", "CL", "Permission", "Leave",
  ];

  return (
    <HrLayout>
      <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/hr/attendance")}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
            <ClipboardList size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Report Log</h1>
            <p className="text-xs text-muted-foreground">
              Every punch, shift, status, and reason -CL, Permission, and Leave included -for every staff employee.
            </p>
          </div>
          <span
            className={`ml-auto text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide ${
              simpleMode ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
            }`}
            title="Attendance calculation mode -change it in Settings → Attendance"
          >
            {simpleMode ? "Simple Mode" : "Strict Mode"}
          </span>
        </div>

        {/* View mode toggle: Monthly Report (existing) vs Daily Report (new) */}
        <div className="flex items-center gap-1.5 bg-gray-100 rounded-lg p-1 w-fit">
          <button
            onClick={() => setViewMode("monthly")}
            className={`h-7 px-3 text-xs font-semibold rounded-md transition-colors ${
              viewMode === "monthly" ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Monthly Report
          </button>
          <button
            onClick={() => setViewMode("daily")}
            className={`h-7 px-3 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 ${
              viewMode === "daily" ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <CalendarDays size={13} /> Daily Report
          </button>
        </div>

        {viewMode === "monthly" && (<>
        {/* Filter bar */}
        <div className="flex items-center gap-2 flex-wrap">
          {isDetail ? (
            <button
              onClick={() => setSelectedEmployeeId(null)}
              className="h-8 px-3 text-xs border rounded-lg text-indigo-700 border-indigo-200 hover:bg-indigo-50 flex items-center gap-1.5 font-semibold"
            >
              <ChevronLeft size={13} /> All Employees
            </button>
          ) : (
            <>
              <div className="relative">
                <Building2 size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <select
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="h-8 rounded-md border pl-7 pr-2 text-xs bg-background"
                >
                  <option value="">All Departments</option>
                  {(departments ?? []).map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by employee code or name…"
                  className="h-8 text-xs pl-7 w-64"
                />
              </div>
            </>
          )}
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="h-8 rounded-md border px-2 text-xs bg-background"
          >
            {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="w-20 h-8 text-xs"
            min={2020} max={2035}
          />
          {!isDetail && (
            <button
              onClick={() => setShowLatePenalty(v => !v)}
              className="ml-auto h-8 px-3 text-xs border rounded-lg text-amber-700 border-amber-200 hover:bg-amber-50 flex items-center gap-1.5 font-semibold"
            >
              {showLatePenalty ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              Late-Penalty Breakdown
            </button>
          )}
        </div>

        {/* ── Mode A: All Employees / Department Summary ── */}
        {!isDetail && (
          <>
            <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
              {summaryLoading ? (
                <AttendanceLoader />
              ) : !summaryData || summaryData.employees.length === 0 ? (
                <div className="py-20 text-center">
                  <Users size={36} className="text-gray-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">No matching employees found.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        {["Employee", "Department", "Present", "Half Shift", "Absent", "On Leave", "CL", "Permission", "Holidays", "Late", "Total Shifts", "Effective Days"].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summaryData.employees.map((row: MonthlySummaryRow) => (
                        <tr
                          key={row.employeeId}
                          onClick={() => setSelectedEmployeeId(row.employeeId)}
                          className={`border-b hover:bg-indigo-50/50 cursor-pointer transition-colors ${row.absentDays > 0 ? "bg-red-50/20" : ""}`}
                        >
                          <td className="px-4 py-3">
                            <p className="font-semibold text-gray-900 text-sm whitespace-nowrap">{row.employeeName}</p>
                            <p className="text-[11px] text-gray-400 font-mono">{row.employeeCode}</p>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{row.department ?? "—"}</td>
                          <td className="px-4 py-3 font-bold text-sm text-green-700">{row.presentDays}</td>
                          <td className="px-4 py-3 font-bold text-sm text-amber-700">{row.halfShiftDays}</td>
                          <td className="px-4 py-3 font-bold text-sm text-red-700">{row.absentDays}</td>
                          <td className="px-4 py-3 font-bold text-sm text-blue-700">{row.onLeaveDays}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{row.casualLeaveCount}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{row.permissionCount}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{row.holidays}</td>
                          <td className="px-4 py-3">
                            <span className={`font-bold text-sm ${row.lateCount > 0 ? "text-red-600" : "text-gray-400"}`}>{row.lateCount}</span>
                          </td>
                          <td className="px-4 py-3 font-bold text-sm text-indigo-700">{row.totalShifts}</td>
                          <td className="px-4 py-3 font-bold text-sm text-gray-800">{row.effectiveDays}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Late-Penalty Breakdown (collapsible, payroll-adjacent) ── */}
            {showLatePenalty && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800">
                  <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    <strong>Deduction Rule:</strong> Each employee gets 3 free lates per month.
                    Every 3 billable lates beyond that = ¼ shift deducted from salary.
                    These deductions are applied automatically when payroll is generated.
                  </span>
                </div>
                <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
                  {lateLoading ? (
                    <div className="py-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 size={18} className="animate-spin text-amber-500" /> Loading…
                    </div>
                  ) : !lateData || lateData.employees.length === 0 ? (
                    <div className="py-20 text-center">
                      <p className="text-sm text-gray-500">No late summary for {MONTH_NAMES[month - 1]} {year}.</p>
                    </div>
                  ) : (
                    <>
                      <div className="px-4 py-3 border-b bg-gray-50">
                        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Late Penalty Summary</p>
                      </div>
                      <table className="w-full text-sm">
                        <thead className="border-b">
                          <tr>
                            {["Employee", "Department", "Total Late", "Free (3)", "Billable", "Shift Deductions", "Salary Deduction"].map(h => (
                              <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {lateData.employees.map((row) => (
                            <tr key={row.employeeId} className={`border-b hover:bg-gray-50 ${row.billableLateCount > 0 ? "bg-red-50/20" : ""}`}>
                              <td className="px-4 py-3">
                                <p className="font-semibold text-sm text-gray-900">{row.employeeName}</p>
                                <p className="text-[11px] font-mono text-gray-400">{row.employeeCode}</p>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600">{row.department ?? "—"}</td>
                              <td className="px-4 py-3">
                                <span className={`font-bold text-sm ${row.totalLateCount > 0 ? "text-amber-700" : "text-gray-400"}`}>{row.totalLateCount}</span>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600">{row.permissionsUsed}/3</td>
                              <td className="px-4 py-3">
                                <span className={`font-bold text-sm ${row.billableLateCount > 0 ? "text-red-700" : "text-green-600"}`}>{row.billableLateCount}</span>
                              </td>
                              <td className="px-4 py-3 font-bold text-sm text-gray-800">{row.shiftDeductions}</td>
                              <td className="px-4 py-3">
                                <span className={`font-bold text-sm ${parseFloat(row.salaryDeductionAmount) > 0 ? "text-red-700" : "text-green-600"}`}>
                                  ₹{parseFloat(row.salaryDeductionAmount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Mode B: Single Employee Detail ── */}
        {isDetail && (
          <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
            {detailLoading ? (
              <div className="py-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={18} className="animate-spin text-indigo-500" /> Loading…
              </div>
            ) : !detailData ? (
              <div className="py-20 text-center">
                <ClipboardList size={36} className="text-gray-200 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No attendance for {MONTH_NAMES[month - 1]} {year}.</p>
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-3">
                  <div>
                    <p className="font-bold text-sm text-gray-900">{detailData.employee.name}</p>
                    <p className="text-[11px] text-gray-400 font-mono">
                      {detailData.employee.code} · {detailData.employee.department ?? "—"}
                      {detailData.employee.designation ? ` · ${detailData.employee.designation}` : ""}
                    </p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        {columnHeaders.map(h => (
                          <th key={h} className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.days.map((row) => renderRow(row))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
        </>)}

        {/* ── Daily Report: Late/Permission/On-Leave filter + Informed + export ── */}
        {viewMode === "daily" && (
          <div className="space-y-4">
            {/* Filter bar */}
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                type="date"
                value={dailyDate}
                onChange={(e) => { setDailyDate(e.target.value); setSelectedRows(new Set()); }}
                className="h-8 text-xs w-40"
              />
              <div className="relative">
                <Building2 size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <select
                  value={dailyDepartment}
                  onChange={(e) => setDailyDepartment(e.target.value)}
                  className="h-8 rounded-md border pl-7 pr-2 text-xs bg-background"
                >
                  <option value="">All Departments</option>
                  {(departments ?? []).map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  value={dailySearch}
                  onChange={(e) => setDailySearch(e.target.value)}
                  placeholder="Search by employee code or name…"
                  className="h-8 text-xs pl-7 w-64"
                />
              </div>

              <div className="h-6 w-px bg-gray-200 mx-1" />

              {([
                { key: "late_permission" as const, label: "Late / Permission" },
                { key: "on_leave" as const, label: "On Leave" },
              ]).map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => toggleCategory(key)}
                  className={`h-8 px-3 text-xs font-semibold rounded-lg border transition-colors ${
                    categoryFilters.has(key)
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "text-gray-600 border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {label}
                </button>
              ))}

              <select
                value={informedFilter}
                onChange={(e) => setInformedFilter(e.target.value as typeof informedFilter)}
                className="h-8 rounded-md border px-2 text-xs bg-background"
                title="Only applies to On Leave rows"
              >
                <option value="all">Informed: All</option>
                <option value="informed">Informed only</option>
                <option value="not_informed">Not Informed only</option>
                <option value="unset">Unset only</option>
              </select>

              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{selectedRows.size} selected</span>
                <button
                  onClick={exportDailyExcel}
                  disabled={selectedRows.size === 0 || exporting !== null}
                  className="h-8 px-3 text-xs border rounded-lg text-green-700 border-green-200 hover:bg-green-50 disabled:opacity-40 flex items-center gap-1.5 font-semibold"
                >
                  <FileSpreadsheet size={13} /> {exporting === "excel" ? "Exporting…" : "Excel"}
                </button>
                <button
                  onClick={() => exportDailyVisual("pdf")}
                  disabled={selectedRows.size === 0 || exporting !== null}
                  className="h-8 px-3 text-xs border rounded-lg text-red-700 border-red-200 hover:bg-red-50 disabled:opacity-40 flex items-center gap-1.5 font-semibold"
                >
                  <FileText size={13} /> {exporting === "pdf" ? "Exporting…" : "PDF"}
                </button>
                <button
                  onClick={() => exportDailyVisual("image")}
                  disabled={selectedRows.size === 0 || exporting !== null}
                  className="h-8 px-3 text-xs border rounded-lg text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-40 flex items-center gap-1.5 font-semibold"
                >
                  <FileImage size={13} /> {exporting === "image" ? "Exporting…" : "Image"}
                </button>
              </div>
            </div>

            <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
              {dailyLoading ? (
                <AttendanceLoader />
              ) : filteredDailyRows.length === 0 ? (
                <div className="py-20 text-center">
                  <Users size={36} className="text-gray-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">No employees match the current filters for {formatDMY(dailyDate)}.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-3 py-3">
                          <button onClick={toggleSelectAllFiltered} className="text-gray-500 hover:text-gray-700">
                            {allFilteredSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                          </button>
                        </th>
                        {["Ticket No", "Employee Name", "Department", "Designation", "Status", "Remarks"].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDailyRows.map((row) => (
                        <tr key={row.employeeId} className="border-b hover:bg-gray-50 transition-colors">
                          <td className="px-3 py-3">
                            <button onClick={() => toggleRowSelected(row.employeeId)} className="text-gray-500 hover:text-gray-700">
                              {selectedRows.has(row.employeeId) ? <CheckSquare size={15} className="text-indigo-600" /> : <Square size={15} />}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-gray-600 whitespace-nowrap">{row.employeeCode}</td>
                          <td className="px-4 py-3 font-semibold text-sm text-gray-900 whitespace-nowrap">{row.employeeName}</td>
                          <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{row.department ?? "—"}</td>
                          <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{row.designation ?? "—"}</td>
                          <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap">{dailyStatusLabel(row)}</td>
                          <td className="px-4 py-3">
                            {row.status === "on_leave" ? (
                              <select
                                value={row.isInformed === true ? "informed" : row.isInformed === false ? "not_informed" : "unset"}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  handleSetInformed(row, v === "informed" ? true : v === "not_informed" ? false : null);
                                }}
                                disabled={setInformedMutation.isPending}
                                className={`h-7 text-xs font-semibold rounded-md border px-2 ${
                                  row.isInformed === true
                                    ? "bg-green-100 text-green-700 border-green-200"
                                    : row.isInformed === false
                                    ? "bg-amber-100 text-amber-700 border-amber-200"
                                    : "bg-gray-50 text-gray-500 border-gray-200"
                                }`}
                              >
                                <option value="unset">Unset</option>
                                <option value="informed">Informed</option>
                                <option value="not_informed">Not Informed</option>
                              </select>
                            ) : (
                              <span className="text-gray-300 text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Hidden export template -captured by html2canvas for PDF/Image;
                Excel is built independently via ExcelJS above. Kept off-screen
                (not display:none, which html2canvas can't render) rather than
                inside a modal, so no extra user interaction is needed to export. */}
            <div style={{ position: "fixed", left: -99999, top: 0, zIndex: -1 }} aria-hidden="true">
              <div ref={exportRef} style={{ width: 760, background: "#ffffff", padding: 20, fontFamily: "Arial, Helvetica, sans-serif" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  {settings?.companyLogo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={settings.companyLogo} alt="" style={{ height: 48, width: 48, objectFit: "contain" }} />
                  )}
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a1a" }}>{settings?.companyName ?? "Company"}</div>
                    <div style={{ fontSize: 11, color: "#666" }}>{user?.branchName ? `${user.branchName} Branch` : "All Branches"}</div>
                  </div>
                </div>
                <div style={{ background: "#e8a9a3", padding: "8px 0", textAlign: "center", fontWeight: 700, fontSize: 15, border: "1px solid #333", color: "#1a1a1a" }}>
                  {reportTitle}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 0 }}>
                  <thead>
                    <tr>
                      {["S.No", "Ticket No", "Employee Name", "Department", "Designation", "Remarks"].map(h => (
                        <th key={h} style={{ ...exportCellStyle, background: "#f2f2f2" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedDailyRows.map((row, i) => (
                      <tr key={row.employeeId}>
                        <td style={exportCellStyle}>{i + 1}</td>
                        <td style={exportCellStyle}>{row.employeeCode}</td>
                        <td style={{ ...exportCellStyle, textAlign: "left" }}>{row.employeeName}</td>
                        <td style={exportCellStyle}>{row.department ?? "—"}</td>
                        <td style={{ ...exportCellStyle, textAlign: "left" }}>{row.designation ?? "—"}</td>
                        <td style={{ ...exportCellStyle, fontWeight: 700, background: remarksColor(row) }}>
                          {remarksLabel(row)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 10, fontSize: 10, color: "#999", fontStyle: "italic", textAlign: "right" }}>
                  Generated by {settings?.companyName ?? ""} HRMS
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </HrLayout>
  );
}
