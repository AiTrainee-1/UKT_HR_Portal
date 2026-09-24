import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import {
  addTitleBlock, downloadWorkbook, exportElementToFile, fileSafe, newWorkbook, solidFill,
} from "@/lib/exportUtils";
import HrLayout from "@/components/HrLayout";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceLateSummary, usePayrollSettings, useAttendanceReportDaily, useSetDayInformed,
  type ReportLogDailyRow,
} from "@/lib/api-client/custom-hooks";
import { useListDepartments } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { AttendanceLoader } from "@/components/ui/AttendanceLoader";
import { AttendanceSheetContent } from "./AttendanceSheet";
import {
  ClipboardList, AlertTriangle, ChevronLeft, ChevronDown, ChevronUp, Search, Users, Building2, Loader2,
  CalendarDays, FileSpreadsheet, FileImage, FileText, CheckSquare, Square,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────

const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Daily Report helpers (Absent-employees export, this page only) ──────────
// The report is deliberately Absent-only: HR generates it around 10-11 AM,
// by which point anyone Late has already punched in (shows Present) and
// anyone on approved Leave is already accounted for on file -what's left
// and needs a human decision is who simply never showed up, hence the
// Informed/Not Informed call per employee.

const formatDMY = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

const informedLabel = (row: ReportLogDailyRow): string =>
  row.isInformed === true ? "Informed" : row.isInformed === false ? "Not Informed" : "Unset";

const informedColor = (row: ReportLogDailyRow): string =>
  row.isInformed === true ? "#92d050" : row.isInformed === false ? "#ffa500" : "#dddddd";

const exportCellStyle: CSSProperties = { border: "1px solid #333", padding: "5px 6px", textAlign: "center" };

// ── Component ──────────────────────────────────────────────────────────────

/**
 * Report Log -two sub-tabs:
 *   Monthly Report -the Attendance Sheet grid (AttendanceSheetContent,
 *     shared with what used to be its own /hr/attendance/sheet route,
 *     removed to avoid two nav entries for the same thing) plus the
 *     payroll-adjacent Late-Penalty Breakdown, which the sheet doesn't cover.
 *   Daily Report -unchanged from before the sheet existed: absent employees
 *     for one date, Informed/Not Informed call per person, Excel/PDF/Image
 *     export.
 */
export default function AttendanceReportLog() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();

  const [viewMode, setViewMode] = useState<"monthly" | "daily">("monthly");

  const { data: departments } = useListDepartments();
  const { data: settings } = usePayrollSettings();
  const simpleMode = settings?.attendanceMode === "simple";

  const [showLatePenalty, setShowLatePenalty] = useState(false);
  const [lateMonth, setLateMonth] = useState(currentMonth());
  const [lateYear, setLateYear] = useState(currentYear());
  const { data: lateData, isLoading: lateLoading } = useAttendanceLateSummary(lateMonth, lateYear, showLatePenalty);

  // ── Daily Report (Late/Permission/On-Leave filter + Informed + export) ──
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const [dailyDate, setDailyDate] = useState(todayIso());
  const [dailyDepartment, setDailyDepartment] = useState("");
  const [dailySearch, setDailySearch] = useState("");
  const [informedFilter, setInformedFilter] = useState<"all" | "informed" | "not_informed" | "unset">("all");
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState<"excel" | "pdf" | "image" | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const setInformedMutation = useSetDayInformed();
  const { data: dailyData, isLoading: dailyLoading } = useAttendanceReportDaily(
    { date: dailyDate, department: dailyDepartment ? Number(dailyDepartment) : undefined, search: dailySearch || undefined },
    viewMode === "daily",
  );
  const dailyRows = dailyData?.rows ?? [];

  // Absent-only, deliberately -see the helpers comment above. Generated
  // around 10-11 AM, not first thing, so Late/Permission/On-Leave people
  // have already resolved themselves in the normal attendance view by then.
  const absentRows = useMemo(() => dailyRows.filter((row) => row.status === "absent"), [dailyRows]);

  const filteredDailyRows = useMemo(() => {
    return absentRows.filter((row) => {
      if (informedFilter === "all") return true;
      if (informedFilter === "informed") return row.isInformed === true;
      if (informedFilter === "not_informed") return row.isInformed === false;
      return row.isInformed === null;
    });
  }, [absentRows, informedFilter]);

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

  const reportTitle = useMemo(() => `${formatDMY(dailyDate)} STAFF LEAVE LIST`, [dailyDate]);

  async function exportDailyExcel() {
    if (selectedDailyRows.length === 0) return;
    setExporting("excel");
    try {
      const wb = newWorkbook();
      const ws = wb.addWorksheet("Report");
      ws.columns = [{ width: 6 }, { width: 14 }, { width: 26 }, { width: 20 }, { width: 26 }, { width: 16 }];

      addTitleBlock(wb, ws, {
        totalCols: 6,
        company: settings?.companyName ?? "Company",
        branchLabel: user?.branchName ? `${user.branchName} Branch` : "All Branches",
        title: reportTitle,
        logoDataUrl: settings?.companyLogo,
      });

      const headerRow = ws.getRow(5);
      ["S.No", "Ticket No", "Employee Name", "Department", "Designation", "Informed Status"].forEach((c, i) => {
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
        const informedCell = r.getCell(6);
        informedCell.value = informedLabel(row);
        informedCell.fill = solidFill(`FF${informedColor(row).replace("#", "")}`);
        informedCell.font = { bold: true };
        informedCell.alignment = { horizontal: "center" };
        for (let c = 1; c <= 6; c++) r.getCell(c).border = { bottom: { style: "hair" } };
      });

      const footerRowIdx = 6 + selectedDailyRows.length + 2;
      ws.getCell(`A${footerRowIdx}`).value = `Generated by ${settings?.companyName ?? ""} HRMS`;
      ws.getCell(`A${footerRowIdx}`).font = { italic: true, size: 9, color: { argb: "FF999999" } };

      await downloadWorkbook(wb, `${fileSafe(reportTitle)}.xlsx`);
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
      await exportElementToFile(exportRef.current, fileSafe(reportTitle), format === "image" ? "png" : "pdf");
    } catch {
      toast({ title: `Failed to export ${format === "pdf" ? "PDF" : "image"}`, variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  return (
    <HrLayout>
      <div className="max-w-[1500px] mx-auto px-6 py-6 space-y-5">

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
              Every employee, every day -a colored attendance register, plus the late-penalty breakdown behind payroll's deductions.
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

        {/* View mode toggle: Monthly Report vs Daily Report */}
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

        {/* ── Monthly Report: Attendance Sheet + Late-Penalty Breakdown ── */}
        {viewMode === "monthly" && (<>
          <AttendanceSheetContent />

          {/* ── Late-Penalty Breakdown (collapsible, payroll-adjacent) -kept
              separate from the sheet's own controls since it's a monthly-only,
              all-employees view with no Day/Week granularity of its own. ── */}
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
            <button
              onClick={() => setShowLatePenalty((v) => !v)}
              className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-50/40 transition-colors"
            >
              {showLatePenalty ? <ChevronUp size={14} className="text-amber-600" /> : <ChevronDown size={14} className="text-amber-600" />}
              <span className="text-sm font-bold text-amber-700">Late-Penalty Breakdown</span>
              <span className="text-xs text-muted-foreground">-who's over their 3 free lates this month</span>
            </button>

            {showLatePenalty && (
              <div className="border-t p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <select
                    value={lateMonth}
                    onChange={(e) => setLateMonth(Number(e.target.value))}
                    className="h-8 rounded-md border px-2 text-xs bg-background"
                  >
                    {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                  <Input
                    type="number"
                    value={lateYear}
                    onChange={(e) => setLateYear(Number(e.target.value))}
                    className="w-20 h-8 text-xs"
                    min={2020} max={2035}
                  />
                </div>

                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800">
                  <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    <strong>Deduction Rule:</strong> Each employee gets 3 free lates per month.
                    Every 3 billable lates beyond that = ¼ shift deducted from salary.
                    These deductions are applied automatically when payroll is generated.
                  </span>
                </div>

                <div className="rounded-xl border bg-white overflow-hidden">
                  {lateLoading ? (
                    <div className="py-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 size={18} className="animate-spin text-amber-500" /> Loading…
                    </div>
                  ) : !lateData || lateData.employees.length === 0 ? (
                    <div className="py-20 text-center">
                      <p className="text-sm text-gray-500">No late summary for {MONTH_NAMES[lateMonth - 1]} {lateYear}.</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="border-b bg-gray-50">
                          <tr>
                            {["Employee", "Department", "Total Late", "Free (3)", "Billable", "Shift Deductions", "Salary Deduction"].map((h) => (
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
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>)}

        {/* ── Daily Report: Absent employees, Informed status + export ── */}
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

              <select
                value={informedFilter}
                onChange={(e) => setInformedFilter(e.target.value as typeof informedFilter)}
                className="h-8 rounded-md border px-2 text-xs bg-background"
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
                  <p className="text-sm text-gray-500">No absent employees {absentRows.length > 0 ? "match this Informed filter" : `for ${formatDMY(dailyDate)}`}.</p>
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
                        {["Ticket No", "Employee Name", "Department", "Designation", "Informed Status"].map(h => (
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
                          <td className="px-4 py-3">
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
                      {["S.No", "Ticket No", "Employee Name", "Department", "Designation", "Informed Status"].map(h => (
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
                        <td style={{ ...exportCellStyle, fontWeight: 700, background: informedColor(row) }}>
                          {informedLabel(row)}
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
