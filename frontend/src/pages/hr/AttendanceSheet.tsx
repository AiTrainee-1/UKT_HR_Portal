import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ExcelJS from "exceljs";
import html2canvas from "html2canvas-pro";
import jsPDF from "jspdf";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { AttendanceLoader } from "@/components/ui/AttendanceLoader";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Tooltip, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useListDepartments } from "@/lib/api-client";
import {
  useAttendanceReportSheet, usePayrollSettings,
  type AttendanceSheetDayCell, type AttendanceSheetDayStatus, type AttendanceSheetEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import {
  ChevronLeft, ChevronRight, ClipboardList, Building2, Search,
  FileSpreadsheet, FileImage, Loader2,
  CheckCircle2, Sunrise, Sunset, XCircle, Plane, PartyPopper, type LucideIcon,
} from "lucide-react";

// ── Date helpers ─────────────────────────────────────────────────────────
// Deliberately local-calendar, not toISOString().slice(0,10) -see
// PunchView.tsx's identical localISO for why UTC conversion is wrong here.

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO(): string {
  return localISO(new Date());
}
function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localISO(d);
}
function startOfWeekISO(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const dow = d.getDay(); // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - backToMonday);
  return localISO(d);
}
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
function fmtShort(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function fmtLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", weekday: "long" });
}
/** "8h 22m" between two "HH:MM" punch times -a raw clock-in-to-clock-out
 *  span, not the payroll-authoritative figure (that's shiftsEarned, which
 *  already accounts for lunch breaks/half-shift rules) -shown alongside it
 *  in the tooltip as a plain "how long were they here" fact. */
function punchDuration(first?: string | null, last?: string | null): string | null {
  if (!first || !last) return null;
  const [fh, fm] = first.split(":").map(Number);
  const [lh, lm] = last.split(":").map(Number);
  let mins = (lh * 60 + lm) - (fh * 60 + fm);
  if (mins < 0) mins += 24 * 60;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();

// ── Status presentation ─────────────────────────────────────────────────
// Same palette/vocabulary as AttendanceReportLog's STATUS_STYLES, so a
// status reads the same color everywhere in the HRMS, not just here.

type StatusKey = Exclude<AttendanceSheetDayStatus, null>;
type CellMeta = {
  code: string; label: string; bg: string; text: string; hex: string;
  accent: string; // saturated hex -tooltip arrow/icon color, punchier than `hex` (the pastel cell fill)
  Icon: LucideIcon;
};

const STATUS_META: Record<StatusKey, CellMeta> = {
  present:    { code: "P", label: "Present",    bg: "bg-green-100",  text: "text-green-800",  hex: "C6EFCE", accent: "16A34A", Icon: CheckCircle2 },
  half_shift: { code: "½", label: "Half Shift",  bg: "bg-amber-100",  text: "text-amber-800",  hex: "FFEB9C", accent: "D97706", Icon: Sunrise },
  absent:     { code: "A", label: "Absent",      bg: "bg-red-100",    text: "text-red-800",    hex: "FFC7CE", accent: "DC2626", Icon: XCircle },
  on_leave:   { code: "L", label: "On Leave",    bg: "bg-blue-100",   text: "text-blue-800",   hex: "BDD7EE", accent: "2563EB", Icon: Plane },
  holiday:    { code: "H", label: "Holiday",     bg: "bg-slate-100",  text: "text-slate-600",  hex: "E2E8F0", accent: "64748B", Icon: PartyPopper },
};

const HALF_MORNING_META: CellMeta = { code: "½M", label: "Half Shift (Morning)", bg: "bg-amber-100", text: "text-amber-800", hex: "FFEB9C", accent: "D97706", Icon: Sunrise };
const HALF_AFTERNOON_META: CellMeta = { code: "½A", label: "Half Shift (Afternoon)", bg: "bg-orange-100", text: "text-orange-800", hex: "FED7AA", accent: "EA580C", Icon: Sunset };

/** Which status "look" a cell should render as -half_shift splits into a
 *  morning/afternoon variant (different code + shade) once halfDayPeriod
 *  is known; every other status is a plain lookup. */
function cellDisplay(cell: AttendanceSheetDayCell): CellMeta | null {
  if (!cell.status) return null;
  if (cell.status === "half_shift") {
    if (cell.halfDayPeriod === "morning") return HALF_MORNING_META;
    if (cell.halfDayPeriod === "afternoon") return HALF_AFTERNOON_META;
    return STATUS_META.half_shift;
  }
  return STATUS_META[cell.status];
}

const LEGEND_ITEMS: CellMeta[] = [
  STATUS_META.present, HALF_MORNING_META, HALF_AFTERNOON_META,
  STATUS_META.absent, STATUS_META.on_leave, STATUS_META.holiday,
];

// ── Sticky employee-info columns -explicit pixel widths shared by the
// header, body, and footer rows so the three frozen columns line up
// exactly, rather than relying on the browser to size them consistently. ─

const COL_W = { sno: 32, code: 68, name: 132, dept: 100 };
const COL_LEFT = {
  sno: 0,
  code: COL_W.sno,
  name: COL_W.sno + COL_W.code,
  dept: COL_W.sno + COL_W.code + COL_W.name,
};
const stickyStyle = (left: number, width: number): CSSProperties => ({ left, width, minWidth: width, maxWidth: width });

type RangeMode = "day" | "week" | "month";

/**
 * Attendance Sheet -the classic paper "Monthly Attendance Sheet" register,
 * reborn as a colored grid: every employee is a row, every date in the
 * selected range is a column, one status cell per day. Day/Week/Month are
 * the same grid at three range lengths, all backed by the same endpoint
 * (attendance_report_log_sheet) -there's no separate code path per mode.
 *
 * Content-only -no page shell of its own (no HrLayout, no header/back
 * button). Embedded directly into Report Log's Monthly Report tab
 * (AttendanceReportLog.tsx), which owns the surrounding page chrome.
 */
export function AttendanceSheetContent() {
  const { toast } = useToast();
  const { user } = useAuth();
  const exportRef = useRef<HTMLDivElement>(null);

  const [rangeMode, setRangeMode] = useState<RangeMode>("month");
  const [anchorDate, setAnchorDate] = useState(todayISO());
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const [department, setDepartment] = useState("");
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState<"excel" | "pdf" | null>(null);

  const { data: departments } = useListDepartments();
  const { data: settings } = usePayrollSettings();

  const { dateFrom, dateTo, rangeLabel } = useMemo(() => {
    if (rangeMode === "day") {
      return { dateFrom: anchorDate, dateTo: anchorDate, rangeLabel: fmtLong(anchorDate) };
    }
    if (rangeMode === "week") {
      const start = startOfWeekISO(anchorDate);
      const end = addDaysISO(start, 6);
      return { dateFrom: start, dateTo: end, rangeLabel: `${fmtShort(start)} – ${fmtShort(end)}, ${year}` };
    }
    const dim = daysInMonth(year, month);
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    const to = `${year}-${String(month).padStart(2, "0")}-${String(dim).padStart(2, "0")}`;
    return { dateFrom: from, dateTo: to, rangeLabel: `${MONTH_NAMES[month - 1]} ${year}` };
  }, [rangeMode, anchorDate, month, year]);

  const { data, isLoading } = useAttendanceReportSheet({
    dateFrom, dateTo,
    department: department ? Number(department) : undefined,
    search: search || undefined,
  });

  const dates = data?.dates ?? [];
  const employees = data?.employees ?? [];
  const strength = data?.strength ?? [];
  const isWide = dates.length === 1; // Day mode -room to show full punch times inline
  // Day/Week have too few date columns to naturally reach the container's
  // edge (table-layout: auto only ever sizes to content), leaving a large
  // blank gap on the right -Month's 28-31 columns don't have this problem,
  // so only Day/Week switch to a full-width, evenly-distributed layout.
  const isCompactRange = dates.length <= 7;

  const goPrev = () => {
    if (rangeMode === "day") setAnchorDate((d) => addDaysISO(d, -1));
    else if (rangeMode === "week") setAnchorDate((d) => addDaysISO(d, -7));
    else {
      if (month === 1) { setMonth(12); setYear((y) => y - 1); } else setMonth((m) => m - 1);
    }
  };
  const goNext = () => {
    if (rangeMode === "day") setAnchorDate((d) => addDaysISO(d, 1));
    else if (rangeMode === "week") setAnchorDate((d) => addDaysISO(d, 7));
    else {
      if (month === 12) { setMonth(1); setYear((y) => y + 1); } else setMonth((m) => m + 1);
    }
  };
  const goToday = () => {
    const t = todayISO();
    setAnchorDate(t);
    setMonth(currentMonth());
    setYear(currentYear());
  };

  const sheetTitle = useMemo(() => {
    const kind = rangeMode === "day" ? "Daily" : rangeMode === "week" ? "Weekly" : "Monthly";
    return `${kind} Attendance Sheet - ${rangeLabel}`;
  }, [rangeMode, rangeLabel]);

  // ── Excel export -colored cells, Strength row, frozen employee columns,
  // built with ExcelJS exactly like AttendanceReportLog's exportDailyExcel
  // so both exports look and behave the same way across the app. ─────────
  async function exportExcel() {
    if (employees.length === 0 || dates.length === 0) return;
    setExporting("excel");
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Attendance Sheet");
      const fixedCols = 4; // S.No, Emp Code, Name, Department
      const summaryCols = 3; // P, A, Eff. Days
      const totalCols = fixedCols + dates.length + summaryCols;

      ws.getColumn(1).width = 6;
      ws.getColumn(2).width = 14;
      ws.getColumn(3).width = 24;
      ws.getColumn(4).width = 16;
      for (let i = 0; i < dates.length; i++) ws.getColumn(fixedCols + 1 + i).width = 5;
      for (let i = 0; i < summaryCols; i++) ws.getColumn(fixedCols + dates.length + 1 + i).width = 7;

      const mergeAndTitle = (row: number, text: string, opts: { size?: number; bold?: boolean; fill?: string } = {}) => {
        ws.mergeCells(row, 1, row, totalCols);
        const cell = ws.getCell(row, 1);
        cell.value = text;
        cell.font = { bold: opts.bold ?? true, size: opts.size ?? 12 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        if (opts.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${opts.fill}` } };
      };

      mergeAndTitle(1, settings?.companyName ?? "Company", { size: 14 });
      mergeAndTitle(2, user?.branchName ? `${user.branchName} Branch` : "All Branches", { size: 10, bold: false });
      mergeAndTitle(3, sheetTitle, { size: 13, fill: "E8A9A3" });
      ws.getRow(3).height = 22;

      const headerRowIdx = 5;
      const headerRow = ws.getRow(headerRowIdx);
      const headers = ["S.No", "Emp Code", "Employee Name", "Department",
        ...dates.map((d) => String(new Date(`${d}T00:00:00`).getDate())),
        "P", "A", "Eff."];
      headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, size: 10 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "hair" }, right: { style: "hair" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
      });
      headerRow.height = 20;

      employees.forEach((emp, rowOffset) => {
        const r = ws.getRow(headerRowIdx + 1 + rowOffset);
        r.getCell(1).value = rowOffset + 1;
        r.getCell(2).value = emp.employeeCode;
        r.getCell(3).value = emp.employeeName;
        r.getCell(4).value = emp.department ?? "—";
        emp.days.forEach((cell, i) => {
          const c = r.getCell(fixedCols + 1 + i);
          const meta = cellDisplay(cell);
          c.value = meta ? meta.code : "";
          c.alignment = { horizontal: "center", vertical: "middle" };
          c.font = { bold: true, size: 9 };
          if (meta) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${meta.hex}` } };
        });
        r.getCell(fixedCols + dates.length + 1).value = emp.summary.present;
        r.getCell(fixedCols + dates.length + 2).value = emp.summary.absent;
        r.getCell(fixedCols + dates.length + 3).value = emp.summary.effectiveDays;
        for (let c = 1; c <= totalCols; c++) {
          r.getCell(c).border = {
            ...r.getCell(c).border,
            top: { style: "hair" }, bottom: { style: "hair" }, left: { style: "hair" }, right: { style: "hair" },
          };
        }
      });

      const strengthRowIdx = headerRowIdx + 1 + employees.length;
      const strengthRow = ws.getRow(strengthRowIdx);
      strengthRow.getCell(3).value = "Strength";
      strengthRow.getCell(3).font = { bold: true };
      strength.forEach((n, i) => {
        const c = strengthRow.getCell(fixedCols + 1 + i);
        c.value = n;
        c.font = { bold: true, size: 9 };
        c.alignment = { horizontal: "center" };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
        c.border = { top: { style: "thin" } };
      });

      const legendRowIdx = strengthRowIdx + 2;
      ws.getCell(legendRowIdx, 1).value = "Legend:";
      ws.getCell(legendRowIdx, 1).font = { bold: true, size: 9 };
      LEGEND_ITEMS.forEach((meta, i) => {
        const cell = ws.getCell(legendRowIdx, 2 + i * 2);
        cell.value = `${meta.code} = ${meta.label}`;
        cell.font = { size: 9 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${meta.hex}` } };
      });

      ws.getCell(legendRowIdx + 2, 1).value = `Generated by ${settings?.companyName ?? ""} HRMS`;
      ws.getCell(legendRowIdx + 2, 1).font = { italic: true, size: 9, color: { argb: "FF999999" } };

      ws.views = [{ state: "frozen", xSplit: fixedCols, ySplit: headerRowIdx }];

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sheetTitle.replace(/[^a-z0-9]+/gi, "_")}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Failed to export Excel", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  // ── PDF export -renders the visible table to an image, exactly like
  // AttendanceReportLog's exportDailyVisual, so both PDF exports in this
  // app behave identically. ────────────────────────────────────────────
  async function exportPdf() {
    if (employees.length === 0 || !exportRef.current) return;
    setExporting("pdf");
    try {
      const canvas = await html2canvas(exportRef.current, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({
        orientation: canvas.width > canvas.height ? "landscape" : "portrait",
        unit: "px",
        format: [canvas.width, canvas.height],
      });
      pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
      pdf.save(`${sheetTitle.replace(/[^a-z0-9]+/gi, "_")}.pdf`);
    } catch {
      toast({ title: "Failed to export PDF", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  return (
    <TooltipProvider delayDuration={150}>
      {/* Cell-tooltip reveal animation -a springy pop keyed off Radix's own
          data-state, plus a slight delay on the arrow so it feels like the
          pointer "grows" a beat after the card, echoing a branch-and-leaf
          reveal without hand-drawn SVG paths (which only work for a fixed
          trigger position -these tooltips open from any of thousands of
          grid cells at any scroll position, so Radix's own dynamic
          placement has to stay in charge of where the card actually goes). */}
      <style>{`
        .att-tooltip-content {
          animation: att-tooltip-in 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
        }
        .att-tooltip-content[data-state="closed"] {
          animation: att-tooltip-out 0.12s ease-in both;
        }
        @keyframes att-tooltip-in {
          0%   { opacity: 0; transform: scale(0.85) translateY(-6px); }
          65%  { opacity: 1; transform: scale(1.04) translateY(1px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes att-tooltip-out {
          to { opacity: 0; transform: scale(0.94) translateY(-3px); }
        }
        .att-tooltip-arrow {
          animation: att-arrow-in 0.22s ease-out 0.14s both;
        }
        @keyframes att-arrow-in {
          from { transform: scale(0); opacity: 0; }
          to   { transform: scale(1); opacity: 1; }
        }
      `}</style>
      <div className="space-y-5">
          {/* Controls */}
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap justify-between">
                <PillTabs
                  size="sm"
                  items={[
                    { value: "day", label: "Day" },
                    { value: "week", label: "Week" },
                    { value: "month", label: "Month" },
                  ]}
                  value={rangeMode}
                  onChange={(v) => setRangeMode(v as RangeMode)}
                />

                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={goPrev}>
                    <ChevronLeft size={14} />
                  </Button>
                  <button
                    onClick={goToday}
                    className="h-8 px-3 rounded-md border text-xs font-semibold text-gray-700 hover:bg-gray-50 min-w-[160px]"
                  >
                    {rangeLabel}
                  </button>
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={goNext}>
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Building2 size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <select
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="h-8 rounded-md border pl-7 pr-2 text-xs bg-background"
                  >
                    <option value="">All Departments</option>
                    {(departments ?? []).map((d) => (
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

                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                    onClick={exportExcel} disabled={exporting !== null || isLoading || employees.length === 0}
                  >
                    {exporting === "excel" ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />}
                    Excel
                  </Button>
                  <Button
                    variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                    onClick={exportPdf} disabled={exporting !== null || isLoading || employees.length === 0}
                  >
                    {exporting === "pdf" ? <Loader2 size={13} className="animate-spin" /> : <FileImage size={13} />}
                    PDF
                  </Button>
                </div>
              </div>

              {/* Legend */}
              <div className="flex items-center gap-2 flex-wrap pt-1">
                {LEGEND_ITEMS.map((meta) => (
                  <span key={meta.code} className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full ${meta.bg} ${meta.text}`}>
                    <span className="font-bold">{meta.code}</span> {meta.label}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" /> Late arrival
                </span>
                <span className="text-[11px] text-gray-400 ml-auto">Hover any cell for full details</span>
              </div>
            </CardContent>
          </Card>

          {/* Sheet */}
          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-0">
              {isLoading ? (
                <div className="py-6">
                  <AttendanceLoader />
                  <p className="text-center text-xs text-muted-foreground -mt-2">
                    Computing attendance for every employee in this range…
                  </p>
                </div>
              ) : employees.length === 0 ? (
                <div className="py-16 text-center">
                  <ClipboardList size={30} className="text-gray-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">No employees match these filters.</p>
                </div>
              ) : (
                <div ref={exportRef} className="bg-white">
                  <div className="px-4 pt-4 pb-2 hidden print:block">
                    <p className="text-center font-bold text-base">{settings?.companyName ?? "Company"}</p>
                    <p className="text-center text-xs text-muted-foreground">{sheetTitle}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className={`text-xs border-collapse ${isCompactRange ? "w-full table-fixed" : ""}`}>
                      <thead>
                        <tr className="bg-slate-50">
                          <th style={stickyStyle(COL_LEFT.sno, COL_W.sno)} className="sticky z-20 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500">#</th>
                          <th style={stickyStyle(COL_LEFT.code, COL_W.code)} className="sticky z-20 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 whitespace-nowrap text-left">Emp Code</th>
                          <th style={stickyStyle(COL_LEFT.name, COL_W.name)} className="sticky z-20 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 whitespace-nowrap text-left">Employee Name</th>
                          <th style={stickyStyle(COL_LEFT.dept, COL_W.dept)} className="sticky z-20 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 whitespace-nowrap text-left">Department</th>
                          {dates.map((d) => {
                            const day = new Date(`${d}T00:00:00`);
                            const isSunday = day.getDay() === 0;
                            return (
                              <th
                                key={d}
                                className={`border px-1 py-1.5 text-center whitespace-nowrap ${isSunday ? "bg-rose-50" : ""} ${isCompactRange ? "" : "w-12"}`}
                                title={fmtLong(d)}
                              >
                                <div className="font-bold text-[11px] text-gray-700">{day.getDate()}</div>
                                <div className={`text-[9px] ${isSunday ? "text-rose-500" : "text-gray-400"}`}>{WEEKDAY_ABBR[day.getDay()]}</div>
                              </th>
                            );
                          })}
                          <th className="border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 w-10">P</th>
                          <th className="border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 w-10">A</th>
                          <th className="border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 w-14">Eff.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {employees.map((emp, i) => (
                          <EmployeeRow key={emp.employeeId} emp={emp} index={i} isWide={isWide} />
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-100 font-bold">
                          <td style={stickyStyle(COL_LEFT.sno, COL_W.sno)} className="sticky z-20 bg-slate-100 border px-2 py-2" />
                          <td style={stickyStyle(COL_LEFT.code, COL_W.code)} className="sticky z-20 bg-slate-100 border px-2 py-2" />
                          <td style={stickyStyle(COL_LEFT.name, COL_W.name)} className="sticky z-20 bg-slate-100 border px-2 py-2 text-[11px] text-gray-700">Strength</td>
                          <td style={stickyStyle(COL_LEFT.dept, COL_W.dept)} className="sticky z-20 bg-slate-100 border px-2 py-2" />
                          {strength.map((n, i) => (
                            <td key={dates[i]} className="border px-1 py-2 text-center text-[11px] text-gray-700">{n}</td>
                          ))}
                          <td className="border" colSpan={3} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
      </div>
    </TooltipProvider>
  );
}

function EmployeeRow({ emp, index, isWide }: { emp: AttendanceSheetEmployeeRow; index: number; isWide: boolean }) {
  return (
    <tr className="hover:bg-slate-50/60 group">
      <td style={stickyStyle(COL_LEFT.sno, COL_W.sno)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 text-[10px] text-gray-400 text-center tabular-nums">{index + 1}</td>
      <td style={stickyStyle(COL_LEFT.code, COL_W.code)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 font-mono text-[10px] text-gray-500 whitespace-nowrap">{emp.employeeCode}</td>
      <td style={stickyStyle(COL_LEFT.name, COL_W.name)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 font-semibold text-gray-800 whitespace-nowrap overflow-hidden text-ellipsis">{emp.employeeName}</td>
      <td style={stickyStyle(COL_LEFT.dept, COL_W.dept)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis">{emp.department ?? "—"}</td>
      {emp.days.map((cell) => <DayCell key={cell.date} cell={cell} isWide={isWide} />)}
      <td className="border px-1 py-1.5 text-center font-bold text-green-700">{emp.summary.present}</td>
      <td className="border px-1 py-1.5 text-center font-bold text-red-700">{emp.summary.absent}</td>
      <td className="border px-1 py-1.5 text-center font-bold text-gray-700">{emp.summary.effectiveDays}</td>
    </tr>
  );
}

/** Rich tooltip body shared by both the compact and wide cell renderings --
 *  every punch/status detail the user asked to see on hover, not just a
 *  bare status word. */
function CellDetails({ cell, meta }: { cell: AttendanceSheetDayCell; meta: CellMeta }) {
  const duration = punchDuration(cell.firstPunch, cell.lastPunch);
  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between gap-4">
      <span className="text-gray-400">{label}</span>
      <span className="font-medium text-gray-700">{value}</span>
    </div>
  );
  return (
    <div className="w-56">
      <div className="px-3 py-2 flex items-center justify-between border-b" style={{ borderColor: `#${meta.accent}22` }}>
        <span className="flex items-center gap-1.5 font-bold text-xs" style={{ color: `#${meta.accent}` }}>
          <meta.Icon size={13} strokeWidth={2.5} />
          {meta.label}
        </span>
        {cell.isLate && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">Late</span>
        )}
      </div>
      <div className="px-3 py-2 space-y-1 text-[11px]">
        {row("Date", fmtLong(cell.date))}
        {row("Punch In", cell.firstPunch ?? "—")}
        {row("Punch Out", cell.lastPunch ?? "—")}
        {row("Duration", duration ?? "—")}
        {row("Shift Credit", cell.shiftsEarned ?? "—")}
      </div>
    </div>
  );
}

/** Custom tooltip shell (not the shared components/ui/tooltip's
 *  TooltipContent -that one's reused elsewhere in the app and shouldn't
 *  inherit this page's animated, arrow-pointed styling). Radix keeps
 *  ownership of where the card actually appears -only its entrance/exit
 *  motion and the colored arrow pointing back at the cell are custom. */
function AttTooltipContent({ meta, children }: { meta: CellMeta; children: ReactNode }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={8}
        className="att-tooltip-content z-50 overflow-hidden rounded-lg border border-gray-200 bg-white text-gray-800 shadow-xl origin-[--radix-tooltip-content-transform-origin]"
      >
        {children}
        <TooltipPrimitive.Arrow className="att-tooltip-arrow" width={12} height={6} style={{ fill: `#${meta.accent}` }} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

function DayCell({ cell, isWide }: { cell: AttendanceSheetDayCell; isWide: boolean }) {
  const meta = cellDisplay(cell);

  if (!meta) {
    return <td className="border text-center text-gray-300 text-xs py-1.5">–</td>;
  }

  if (isWide) {
    const duration = punchDuration(cell.firstPunch, cell.lastPunch);
    return (
      <td className={`border px-2 py-1.5 ${meta.bg} ${meta.text}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-xs">{meta.label}</span>
          {cell.isLate && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">Late</span>
          )}
        </div>
        {(cell.firstPunch || cell.lastPunch) && (
          <p className="text-[10px] font-mono opacity-80 mt-0.5">
            IN {cell.firstPunch ?? "—"} · OUT {cell.lastPunch ?? "—"}
          </p>
        )}
        {duration && <p className="text-[10px] opacity-70">Duration: {duration}</p>}
      </td>
    );
  }

  return (
    <td className="border p-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`relative text-center py-2 cursor-pointer transition-[filter,box-shadow] duration-100 hover:brightness-90 hover:ring-2 hover:ring-inset hover:ring-black/30 ${meta.bg} ${meta.text}`}>
            <span className="text-xs font-bold">{meta.code}</span>
            {cell.isLate && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-red-500" />}
          </div>
        </TooltipTrigger>
        <AttTooltipContent meta={meta}>
          <CellDetails cell={cell} meta={meta} />
        </AttTooltipContent>
      </Tooltip>
    </td>
  );
}
