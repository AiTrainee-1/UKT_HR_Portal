import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  addTitleBlock, downloadWorkbook, exportElementToFile, fileSafe, newWorkbook, solidFill, styleHeaderCell,
} from "@/lib/exportUtils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { AttendanceLoader } from "@/components/ui/AttendanceLoader";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/use-debounced";
import { useAuth } from "@/contexts/AuthContext";
import { useListDepartments } from "@/lib/api-client";
import { departmentOptions } from "@/lib/departments";
import { OrgNativeOptions } from "@/lib/org-select";
import {
  useAttendanceReportSheet, usePayrollSettings, useReportLogDayPunches,
  type AttendanceSheetDayCell, type AttendanceSheetDayStatus, type AttendanceSheetEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import { normalizeHalf } from "@/lib/late-detection";
import { countedAfterLabel, inProgressPunchText, isInProgress } from "@/lib/day-progress";
import { useKindText, useReportLogKind } from "./report-log/kind";
import DayEarned from "./report-log/DayEarned";
import DayPunches from "./report-log/DayPunches";
import {
  CompensationChip, CompensationLegend, CompensationSymbol, KIND_META, compensationMark, countMarks,
  isPunchlessRelaxation, kindLabel, markShort, markTitle, type MarkKind,
} from "@/components/attendance-compensation";
import {
  ChevronLeft, ChevronRight, ClipboardList, Building2, Search,
  FileSpreadsheet, FileImage, Loader2,
  CheckCircle2, Sunrise, Sunset, XCircle, Plane, PartyPopper, Hourglass, type LucideIcon,
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
function punchDuration(first?: string | null, last?: string | null, lastNextDay = false): string | null {
  if (!first || !last) return null;
  const [fh, fm] = first.split(":").map(Number);
  const [lh, lm] = last.split(":").map(Number);
  let mins = (lh * 60 + lm) - (fh * 60 + fm);
  if (mins < 0) mins += 24 * 60;
  // a production night shift's last punch made after midnight (the day card knows it from the punch list)
  else if (lastNextDay) mins += 24 * 60;
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
const HALF_EVENING_META: CellMeta = { code: "½E", label: "Half Shift (Evening)", bg: "bg-orange-100", text: "text-orange-800", hex: "FED7AA", accent: "EA580C", Icon: Sunset };

/** TODAY while the shift is still running (owner 2026-11-26): no verdict yet, counted after the shift ends. */
const IN_PROGRESS_META: CellMeta = { code: "…", label: "In progress", bg: "bg-slate-50", text: "text-slate-600", hex: "F1F5F9", accent: "64748B", Icon: Hourglass };

/** Which status "look" a cell should render as -half_shift splits into a
 *  morning/evening variant (different code + shade) once halfDayPeriod
 *  is known (the endpoint spells the evening half "afternoon"); every other
 *  status is a plain lookup. */
function cellDisplay(cell: AttendanceSheetDayCell): CellMeta | null {
  if (isInProgress(cell)) return IN_PROGRESS_META;
  if (!cell.status) return null;
  if (cell.status === "half_shift") {
    // A day made up by a relaxation has no punches, so the endpoint's "afternoon" is only its default, not a half that
    // was worked: it keeps the plain Half Shift look and the Relaxation marker says what it is.
    const half = isPunchlessRelaxation(cell) ? null : normalizeHalf(cell.halfDayPeriod);
    if (half === "morning") return HALF_MORNING_META;
    if (half === "evening") return HALF_EVENING_META;
    return STATUS_META.half_shift;
  }
  return STATUS_META[cell.status];
}

const LEGEND_ITEMS: CellMeta[] = [
  STATUS_META.present, HALF_MORNING_META, HALF_EVENING_META,
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

// Above this many employees the grid renders only the rows on screen (plus a
// small buffer) -a full roster x 31 days is thousands of tooltip-wrapped cells.
// The PDF export switches it off so the captured DOM has every row.
const VIRTUALIZE_ABOVE = 60;

type RangeMode = "day" | "week" | "month";

/** The Production Report Log's register is asked by pay cycle instead (owner 2026-11-16: "weekly, biweekly, monthly
 *  like payroll"): the cycle's own pay period, the workers on that cycle. */
type CycleMode = "weekly" | "biweekly" | "monthly";
const CYCLE_TABS: { value: CycleMode; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "BiWeekly" },
  { value: "monthly", label: "Monthly" },
];
const CYCLE_LABEL: Record<CycleMode, string> = { weekly: "Weekly", biweekly: "BiWeekly", monthly: "Monthly" };

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
 *
 * Whose register it is comes from the page (report-log/kind.tsx): staff on the Report Log, production employees on the
 * Production Report Log (its own address, its own departments, "Production" in the titles of its downloads).
 */
export function AttendanceSheetContent() {
  const { toast } = useToast();
  const { user } = useAuth();
  const kind = useReportLogKind();
  const words = useKindText();
  const exportRef = useRef<HTMLDivElement>(null);

  const [rangeMode, setRangeMode] = useState<RangeMode>("month");
  const [anchorDate, setAnchorDate] = useState(todayISO());
  // production: the pay cycle and a day inside the period to show (the server answers with that period's dates)
  const byCycle = kind === "production";
  // "auto" until one is picked: the server opens the cycle with the most workers and says which it chose
  const [cycle, setCycle] = useState<CycleMode | "auto">("auto");
  const [around, setAround] = useState(todayISO());
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const [department, setDepartment] = useState("");
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState<"excel" | "pdf" | null>(null);

  const { data: departments } = useListDepartments();
  // The register lists one kind of employee (staff here, production on the Production Report Log), so the picker offers
  // that kind's departments only.
  const deptOptions = useMemo(() => departmentOptions(departments, { category: kind }), [departments, kind]);
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

  // the box shows every letter; the grid is asked for once typing pauses
  const debouncedSearch = useDebounced(search);
  const { data, isLoading } = useAttendanceReportSheet(
    {
      ...(byCycle ? { payCycle: cycle, around } : { dateFrom, dateTo }),
      department: department ? Number(department) : undefined,
      search: debouncedSearch || undefined,
    },
    true,
    kind,
  );
  // the pay period on screen (production); kept while the next one loads, so the arrows and the label stay put
  const lastPeriod = useRef(data?.period);
  if (data?.period) lastPeriod.current = data.period;
  const period = byCycle ? (data?.period ?? lastPeriod.current) : undefined;
  const periodLabel = period
    ? `${fmtShort(period.periodStart)} – ${fmtShort(period.periodEnd)}, ${period.periodEnd.slice(0, 4)}`
    : "Loading the pay period…";
  const shownLabel = byCycle ? periodLabel : rangeLabel;
  const activeCycle: CycleMode | undefined = cycle === "auto" ? period?.cycle : cycle;
  const counts = period?.cycleCounts;
  const cycleTabs = CYCLE_TABS.map((t) => ({ ...t, label: counts ? `${t.label} · ${counts[t.value]}` : t.label }));
  // once the server has said which cycle "auto" is, moving keeps to it
  const pinCycle = () => {
    if (cycle === "auto" && period) setCycle(period.cycle);
  };

  const dates = data?.dates ?? [];
  const employees = data?.employees ?? [];
  // Which kinds of compensation marker appear in the grid (and how many days of each): the legend lists only those.
  const compensationCounts = useMemo(() => countMarks((data?.employees ?? []).flatMap((e) => e.days)), [data]);
  const compensationKinds = Object.keys(compensationCounts) as MarkKind[];
  const strength = data?.strength ?? [];
  const isWide = dates.length === 1; // Day mode -room to show full punch times inline
  // Day/Week have too few date columns to naturally reach the container's
  // edge (table-layout: auto only ever sizes to content), leaving a large
  // blank gap on the right -Month's 28-31 columns don't have this problem,
  // so only Day/Week switch to a full-width, evenly-distributed layout.
  const isCompactRange = dates.length <= 7;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = exporting !== "pdf" && employees.length > VIRTUALIZE_ABOVE;
  const rowVirtualizer = useVirtualizer({
    count: employees.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isWide ? 58 : 37),
    overscan: 10,
    enabled: virtualize,
  });
  const virtualRows = virtualize ? rowVirtualizer.getVirtualItems() : [];
  const padTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const padBottom = virtualRows.length > 0 ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end : 0;
  const tableCols = 4 + dates.length + 3;

  const goPrev = () => {
    if (byCycle) {
      if (period) setAround(addDaysISO(period.periodStart, -1));
      pinCycle();
      return;
    }
    if (rangeMode === "day") setAnchorDate((d) => addDaysISO(d, -1));
    else if (rangeMode === "week") setAnchorDate((d) => addDaysISO(d, -7));
    else {
      if (month === 1) { setMonth(12); setYear((y) => y - 1); } else setMonth((m) => m - 1);
    }
  };
  const goNext = () => {
    if (byCycle) {
      if (period) setAround(addDaysISO(period.periodEnd, 1));
      pinCycle();
      return;
    }
    if (rangeMode === "day") setAnchorDate((d) => addDaysISO(d, 1));
    else if (rangeMode === "week") setAnchorDate((d) => addDaysISO(d, 7));
    else {
      if (month === 12) { setMonth(1); setYear((y) => y + 1); } else setMonth((m) => m + 1);
    }
  };
  const goToday = () => {
    const t = todayISO();
    setAnchorDate(t);
    setAround(t);
    pinCycle();
    setMonth(currentMonth());
    setYear(currentYear());
  };

  const sheetTitle = useMemo(() => {
    const span = byCycle
      ? (activeCycle ? CYCLE_LABEL[activeCycle] : "")
      : rangeMode === "day" ? "Daily" : rangeMode === "week" ? "Weekly" : "Monthly";
    // "Monthly Attendance Sheet - November 2026"; "BiWeekly Production Attendance Sheet - 27 Jul – 9 Aug, 2026" there
    return `${span} ${words.titlePrefix}Attendance Sheet - ${shownLabel}`;
  }, [byCycle, activeCycle, rangeMode, shownLabel, words.titlePrefix]);

  // ── Excel export -colored cells, Strength row, frozen employee columns.
  // Title block, header styling and download all come from lib/exportUtils,
  // shared with the Daily Leave and Late report exports in AttendanceReportLog. ───────────
  async function exportExcel() {
    if (employees.length === 0 || dates.length === 0) return;
    setExporting("excel");
    try {
      const wb = await newWorkbook();
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

      addTitleBlock(wb, ws, {
        totalCols,
        company: settings?.companyName ?? "Company",
        branchLabel: user?.branchName ? `${user.branchName} Branch` : "All Branches",
        title: sheetTitle,
        logoDataUrl: settings?.companyLogo,
      });

      const headerRowIdx = 5;
      const headerRow = ws.getRow(headerRowIdx);
      const headers = ["S.No", "Emp Code", "Employee Name", "Department",
        ...dates.map((d) => String(new Date(`${d}T00:00:00`).getDate())),
        "P", "A", "Eff."];
      headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        styleHeaderCell(cell, {
          fill: "FFF1F5F9", color: "FF000000", size: 10, wrapText: false,
          border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "hair" }, right: { style: "hair" } },
        });
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
          // a day that used a compensation carries its short code after the day's own ("P·OT") and a cell note
          const short = markShort(cell);
          c.value = meta ? `${meta.code}${short ? `·${short}` : ""}` : "";
          c.alignment = { horizontal: "center", vertical: "middle" };
          c.font = { bold: true, size: 9 };
          if (meta) c.fill = solidFill(`FF${meta.hex}`);
          if (short) c.note = markTitle(cell);
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
        c.fill = solidFill("FFF1F5F9");
        c.border = { top: { style: "thin" } };
      });

      const legendRowIdx = strengthRowIdx + 2;
      ws.getCell(legendRowIdx, 1).value = "Legend:";
      ws.getCell(legendRowIdx, 1).font = { bold: true, size: 9 };
      LEGEND_ITEMS.forEach((meta, i) => {
        const cell = ws.getCell(legendRowIdx, 2 + i * 2);
        cell.value = `${meta.code} = ${meta.label}`;
        cell.font = { size: 9 };
        cell.fill = solidFill(`FF${meta.hex}`);
      });

      // one row per kind of compensation marker present, so a printed sheet explains the code after a day's own
      compensationKinds.forEach((kind, i) => {
        if (i === 0) {
          ws.getCell(legendRowIdx + 1, 1).value = "Compensation:";
          ws.getCell(legendRowIdx + 1, 1).font = { bold: true, size: 9 };
        }
        const cell = ws.getCell(legendRowIdx + 1 + i, 2);
        cell.value = `${KIND_META[kind].short} = ${kindLabel(kind)} (the day used a compensation)`;
        cell.font = { size: 9 };
      });

      const footerRowIdx = legendRowIdx + 2 + compensationKinds.length;
      ws.getCell(footerRowIdx, 1).value = `Generated by ${settings?.companyName ?? ""} HRMS`;
      ws.getCell(footerRowIdx, 1).font = { italic: true, size: 9, color: { argb: "FF999999" } };

      ws.views = [{ state: "frozen", xSplit: fixedCols, ySplit: headerRowIdx }];

      await downloadWorkbook(wb, `${fileSafe(sheetTitle)}.xlsx`);
    } catch {
      toast({ title: "Failed to export Excel", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  // ── PDF export -renders the visible table (lib/exportUtils). ──────────
  async function exportPdf() {
    if (employees.length === 0 || !exportRef.current) return;
    // Un-virtualize and un-clamp the table synchronously, and let the browser
    // paint it, so the captured DOM holds every row rather than just the
    // ones currently scrolled into view.
    flushSync(() => setExporting("pdf"));
    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await exportElementToFile(exportRef.current, fileSafe(sheetTitle), "pdf");
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
                {byCycle ? (
                  <div data-testid="register-cycle-tabs">
                    <PillTabs
                      size="sm"
                      items={cycleTabs}
                      value={activeCycle ?? ""}
                      onChange={(v) => setCycle(v as CycleMode)}
                    />
                  </div>
                ) : (
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
                )}

                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={goPrev}
                    disabled={byCycle && !period}
                    aria-label="Previous period"
                  >
                    <ChevronLeft size={14} />
                  </Button>
                  <button
                    onClick={goToday}
                    className="h-8 px-3 rounded-md border text-xs font-semibold text-gray-700 hover:bg-gray-50 min-w-[160px]"
                    title={byCycle ? "Go to the pay period that holds today" : undefined}
                    data-testid="register-range"
                  >
                    {shownLabel}
                  </button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={goNext}
                    disabled={byCycle && !period}
                    aria-label="Next period"
                  >
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
              {byCycle && activeCycle && (
                <p className="text-xs text-gray-500" data-testid="register-cycle-note">
                  {CYCLE_LABEL[activeCycle]} pay period{period ? ` · ${period.days} days` : ""} · the same dates as the{" "}
                  {CYCLE_LABEL[activeCycle]} payroll page · only workers on the {CYCLE_LABEL[activeCycle]} cycle
                  {data ? ` (${employees.length})` : ""}
                </p>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Building2 size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <select
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="h-8 rounded-md border pl-7 pr-2 text-xs bg-background"
                  >
                    <option value="">All Departments</option>
                    <OrgNativeOptions options={deptOptions} />
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
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500 inline-block" /> Early out
                </span>
                <span className="text-[11px] text-gray-400 ml-auto">Click any day for its punches</span>
              </div>
              <CompensationLegend counts={compensationCounts} className="pt-0.5" />
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
                  <div ref={scrollRef} className={exporting === "pdf" ? "overflow-x-auto" : "overflow-auto max-h-[70vh]"}>
                    <table className={`text-xs border-collapse ${isCompactRange ? "w-full table-fixed" : ""}`}>
                      <thead>
                        <tr className="bg-slate-50">
                          <th style={stickyStyle(COL_LEFT.sno, COL_W.sno)} className="sticky top-0 z-30 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500">#</th>
                          <th style={stickyStyle(COL_LEFT.code, COL_W.code)} className="sticky top-0 z-30 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 whitespace-nowrap text-left">Emp Code</th>
                          <th style={stickyStyle(COL_LEFT.name, COL_W.name)} className="sticky top-0 z-30 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 whitespace-nowrap text-left">Employee Name</th>
                          <th style={stickyStyle(COL_LEFT.dept, COL_W.dept)} className="sticky top-0 z-30 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 whitespace-nowrap text-left">Department</th>
                          {dates.map((d) => {
                            const day = new Date(`${d}T00:00:00`);
                            const isSunday = day.getDay() === 0;
                            return (
                              <th
                                key={d}
                                className={`sticky top-0 z-20 border px-1 py-1.5 text-center whitespace-nowrap ${isSunday ? "bg-rose-50" : "bg-slate-50"} ${isCompactRange ? "" : "w-12"}`}
                                title={fmtLong(d)}
                              >
                                <div className="font-bold text-[11px] text-gray-700">{day.getDate()}</div>
                                <div className={`text-[9px] ${isSunday ? "text-rose-500" : "text-gray-400"}`}>{WEEKDAY_ABBR[day.getDay()]}</div>
                              </th>
                            );
                          })}
                          <th className="sticky top-0 z-20 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 w-10">P</th>
                          <th className="sticky top-0 z-20 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 w-10">A</th>
                          <th className="sticky top-0 z-20 bg-slate-50 border px-2 py-2 text-[10px] font-bold uppercase text-gray-500 w-14">Eff.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {virtualize ? (
                          <>
                            {padTop > 0 && <tr aria-hidden="true"><td colSpan={tableCols} style={{ height: padTop, padding: 0, border: 0 }} /></tr>}
                            {virtualRows.map((v) => (
                              <EmployeeRow
                                key={employees[v.index].employeeId}
                                emp={employees[v.index]}
                                index={v.index}
                                isWide={isWide}
                                dataIndex={v.index}
                                rowRef={rowVirtualizer.measureElement}
                              />
                            ))}
                            {padBottom > 0 && <tr aria-hidden="true"><td colSpan={tableCols} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>}
                          </>
                        ) : (
                          employees.map((emp, i) => (
                            <EmployeeRow key={emp.employeeId} emp={emp} index={i} isWide={isWide} />
                          ))
                        )}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-100 font-bold">
                          <td style={stickyStyle(COL_LEFT.sno, COL_W.sno)} className="sticky bottom-0 z-30 bg-slate-100 border px-2 py-2" />
                          <td style={stickyStyle(COL_LEFT.code, COL_W.code)} className="sticky bottom-0 z-30 bg-slate-100 border px-2 py-2" />
                          <td style={stickyStyle(COL_LEFT.name, COL_W.name)} className="sticky bottom-0 z-30 bg-slate-100 border px-2 py-2 text-[11px] text-gray-700">Strength</td>
                          <td style={stickyStyle(COL_LEFT.dept, COL_W.dept)} className="sticky bottom-0 z-30 bg-slate-100 border px-2 py-2" />
                          {strength.map((n, i) => (
                            <td key={dates[i]} className="sticky bottom-0 z-20 bg-slate-100 border px-1 py-2 text-center text-[11px] text-gray-700">{n}</td>
                          ))}
                          <td className="sticky bottom-0 z-20 bg-slate-100 border" colSpan={3} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {/* the PDF is a picture of this block alone, so the symbols' legend goes into it while it is made */}
                  {exporting === "pdf" && <CompensationLegend counts={compensationCounts} className="px-4 py-2" />}
                </div>
              )}
            </CardContent>
          </Card>
      </div>
    </TooltipProvider>
  );
}

function EmployeeRow({
  emp, index, isWide, dataIndex, rowRef,
}: {
  emp: AttendanceSheetEmployeeRow;
  index: number;
  isWide: boolean;
  /** Set only when virtualized: the virtualizer measures each row by this. */
  dataIndex?: number;
  rowRef?: (node: HTMLTableRowElement | null) => void;
}) {
  return (
    <tr ref={rowRef} data-index={dataIndex} className="hover:bg-slate-50/60 group">
      <td style={stickyStyle(COL_LEFT.sno, COL_W.sno)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 text-[10px] text-gray-400 text-center tabular-nums">{index + 1}</td>
      <td style={stickyStyle(COL_LEFT.code, COL_W.code)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 font-mono text-[10px] text-gray-500 whitespace-nowrap">{emp.employeeCode}</td>
      <td style={stickyStyle(COL_LEFT.name, COL_W.name)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 font-semibold text-gray-800 whitespace-nowrap overflow-hidden text-ellipsis">{emp.employeeName}</td>
      <td style={stickyStyle(COL_LEFT.dept, COL_W.dept)} className="sticky z-10 bg-white group-hover:bg-slate-50/60 border px-2 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis">{emp.department ?? "—"}</td>
      {emp.days.map((cell) => (
        <DayCell key={cell.date} cell={cell} isWide={isWide} employeeId={emp.employeeId} employeeName={emp.employeeName} />
      ))}
      <td className="border px-1 py-1.5 text-center font-bold text-green-700">{emp.summary.present}</td>
      <td className="border px-1 py-1.5 text-center font-bold text-red-700">{emp.summary.absent}</td>
      <td className="border px-1 py-1.5 text-center font-bold text-gray-700">{emp.summary.effectiveDays}</td>
    </tr>
  );
}

/** The day card's head and figures, shared by the compact and wide cells; the day's every punch follows it
 *  (DayPunches). Opened by a click (owner 2026-11-16: the hover tooltip got in the way). */
function CellDetails({
  cell,
  meta,
  lastNextDay = false,
}: {
  cell: AttendanceSheetDayCell;
  meta: CellMeta;
  /** The day's last punch was made after midnight (a night shift): the duration runs into the next day. */
  lastNextDay?: boolean;
}) {
  const duration = punchDuration(cell.firstPunch, cell.lastPunch, lastNextDay);
  return (
    <div>
      <div className="px-3 py-2 flex items-center justify-between border-b" style={{ borderColor: `#${meta.accent}22` }}>
        <span className="flex items-center gap-1.5 font-bold text-xs" style={{ color: `#${meta.accent}` }}>
          <meta.Icon size={13} strokeWidth={2.5} />
          {meta.label}
        </span>
        <span className="flex items-center gap-1">
          {cell.isLate && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">Late</span>
          )}
          {cell.isEarlyOut && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-600">Early Out</span>
          )}
        </span>
      </div>
      <div className="px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500" data-testid="day-card-head">
        <span className="font-semibold text-gray-800">{fmtLong(cell.date)}</span>
        {isInProgress(cell) ? (
          <span className="tabular-nums" data-testid="day-card-in-progress">
            <b className="font-semibold text-gray-800">{inProgressPunchText(cell.firstPunch)}</b> ·{" "}
            {countedAfterLabel(cell.provisionalUntil)}
          </span>
        ) : (
        <>
        <span className="tabular-nums">
          In <b className="font-semibold text-gray-800">{cell.firstPunch ?? "—"}</b> · Out{" "}
          <b className="font-semibold text-gray-800">{cell.lastPunch ?? "—"}</b>
        </span>
        <span className="tabular-nums">
          Duration <b className="font-semibold text-gray-800">{duration ?? "—"}</b>
        </span>
        </>
        )}
      </div>
      {compensationMark(cell) && (
        <div className="px-3 pb-2">
          <CompensationChip day={cell} size="sm" withNote />
        </div>
      )}
    </div>
  );
}

/** The day card's shell: a click-opened popover (it stays until a click outside it or Escape, so its punches can be
 *  read and scrolled), with this page's entrance motion and the coloured arrow pointing back at the cell. Radix places
 *  it and keeps it on screen. */
function AttPopoverContent({ meta, children }: { meta: CellMeta; children: ReactNode }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={8}
        collisionPadding={12}
        className="att-tooltip-content z-50 overflow-hidden rounded-lg border border-gray-200 bg-white text-gray-800 shadow-xl outline-none origin-[--radix-popover-content-transform-origin]"
        data-testid="day-card"
      >
        {children}
        <PopoverPrimitive.Arrow className="att-tooltip-arrow" width={12} height={6} style={{ fill: `#${meta.accent}` }} />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/** What the open day card holds: the day's figures and every punch, from one request (made when it opens). */
function DayCardBody({ cell, meta, employeeId }: { cell: AttendanceSheetDayCell; meta: CellMeta; employeeId: number }) {
  const punches = useReportLogDayPunches(employeeId, cell.date, useReportLogKind());
  const lastNextDay = !!punches.data?.punches.at(-1)?.nextDay;
  // the earned-shift breakdown on the left of the punches (stacked on a phone)
  return (
    <div className="w-[min(92vw,620px)]" data-testid="day-card-body">
      <CellDetails cell={cell} meta={meta} lastNextDay={lastNextDay} />
      <div className="grid grid-cols-1 border-t border-gray-100 sm:grid-cols-2 sm:divide-x sm:divide-gray-100">
        <DayEarned query={punches} />
        <DayPunches query={punches} />
      </div>
    </div>
  );
}

function DayCell({
  cell,
  isWide,
  employeeId,
  employeeName,
}: {
  cell: AttendanceSheetDayCell;
  isWide: boolean;
  employeeId: number;
  employeeName: string;
}) {
  const meta = cellDisplay(cell);

  if (!meta) {
    return <td className="border text-center text-gray-300 text-xs py-1.5">–</td>;
  }

  // a click opens the day's card: its status and figures, then every punch of the day (asked for on opening)
  const card = (
    <AttPopoverContent meta={meta}>
      <DayCardBody cell={cell} meta={meta} employeeId={employeeId} />
    </AttPopoverContent>
  );
  const label = `${employeeName}, ${fmtLong(cell.date)}: ${meta.label}${isInProgress(cell) ? ` (${countedAfterLabel(cell.provisionalUntil)})` : ""}. Show the day's punches`;

  if (isWide) {
    const duration = punchDuration(cell.firstPunch, cell.lastPunch);
    return (
      <td className={`border p-0 ${meta.bg} ${meta.text}`}>
        <PopoverPrimitive.Root>
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label={label}
              className="block w-full px-2 py-1.5 text-left cursor-pointer transition-[filter] duration-100 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 data-[state=open]:ring-2 data-[state=open]:ring-inset data-[state=open]:ring-slate-500"
              data-testid={`day-cell-${employeeId}-${cell.date}`}
            >
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-xs">{meta.label}</span>
          <span className="flex items-center gap-1">
            {cell.isLate && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">Late</span>
            )}
            {cell.isEarlyOut && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700">Early Out</span>
            )}
          </span>
        </div>
        {isInProgress(cell) ? (
          <p className="text-[10px] font-mono opacity-80 mt-0.5" title={countedAfterLabel(cell.provisionalUntil)}>
            {inProgressPunchText(cell.firstPunch)}
          </p>
        ) : (
          <>
            {(cell.firstPunch || cell.lastPunch) && (
              <p className="text-[10px] font-mono opacity-80 mt-0.5">
                IN {cell.firstPunch ?? "—"} · OUT {cell.lastPunch ?? "—"}
              </p>
            )}
            {duration && <p className="text-[10px] opacity-70">Duration: {duration}</p>}
          </>
        )}
        <CompensationChip day={cell} size="sm" className="mt-1" />
            </button>
          </PopoverPrimitive.Trigger>
          {card}
        </PopoverPrimitive.Root>
      </td>
    );
  }

  return (
    <td className="border p-0">
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className={`relative block w-full text-center py-2 cursor-pointer transition-[filter,box-shadow] duration-100 hover:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 data-[state=open]:ring-2 data-[state=open]:ring-inset data-[state=open]:ring-slate-500 ${meta.bg} ${meta.text}`}
            data-testid={`day-cell-${employeeId}-${cell.date}`}
          >
            <span className="text-xs font-bold">{meta.code}</span>
            {cell.isLate && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-red-500" />}
            {cell.isEarlyOut && <span className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-orange-500" />}
            {/* used a compensation: a two-letter symbol (OT / LI / EO / BD / RX), explained by the legend and the day card */}
            <CompensationSymbol day={cell} tooltip={false} className="absolute left-0.5 top-0.5 h-3 min-w-[0.95rem] text-[7px]" />
          </button>
        </PopoverPrimitive.Trigger>
        {card}
      </PopoverPrimitive.Root>
    </td>
  );
}
