import { useState } from "react";
import ExcelJS from "exceljs";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useListPayrollRuns, useGeneratePayroll, useUpdatePayrollRecord,
  usePayrollBreakdown, useSessionConfigs, useCreateSessionConfig,
  useUpdateSessionConfig, useDeleteSessionConfig,
  getListPayrollRunsQueryKey, getSessionConfigsQueryKey,
  type PayrollRunItem, type PayrollBreakdown, type SessionConfigItem,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  IndianRupee, Play, Lock, CheckCircle2, Clock, Users,
  TrendingUp, ChevronDown, ChevronUp, AlertCircle, Info,
  Factory, UserCheck, Settings, Plus, Trash2, Edit, X,
  CalendarDays, ArrowRight, Download,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:  { label: "Pending",  cls: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  paid:     { label: "Paid",     cls: "bg-green-50 text-green-700 border-green-200" },
  draft:    { label: "Draft",    cls: "bg-gray-50 text-gray-700 border-gray-200" },
  approved: { label: "Approved", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  locked:   { label: "Locked",   cls: "bg-purple-50 text-purple-700 border-purple-200" },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Excel Export — Bank Transfer Format (styled with exceljs)
// ─────────────────────────────────────────────────────────────────────────────

async function exportPayrollToExcel(
  runs: PayrollRunItem[],
  sheetLabel: string,
  monthYear: string,
) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UKTextiles HRMS";
  const ws = wb.addWorksheet(sheetLabel.substring(0, 31));

  // Column definitions — widths match the bank template
  ws.columns = [
    { key: "A", width: 18 },  // Txn type
    { key: "B", width: 22 },  // Beneficiary Code
    { key: "C", width: 24 },  // Bene A/c No
    { key: "D", width: 14 },  // Amount
    { key: "E", width: 32 },  // Beneficiary Name
    { key: "F", width: 16 },  // IFSC code
    { key: "G", width: 30 },  // Bene Bank Name
    { key: "H", width: 30 },  // Bene Bank Branch Name
    { key: "I", width: 32 },  // Bene Email ID
  ];

  const GREEN  = "FF5B8C00";   // olive-green matching the image
  const WHITE  = "FFFFFFFF";
  const RED    = "FFFF0000";   // Amount header is red in the template

  const styleHeader = (cell: ExcelJS.Cell, isAmount = false) => {
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    cell.font      = { bold: true, color: { argb: isAmount ? RED : WHITE } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  };
  const styleData = (cell: ExcelJS.Cell) => {
    cell.alignment = { horizontal: "center", vertical: "middle" };
  };

  // ── Row 1: Header labels ─────────────────────────────────────────────────
  const HEADERS = [
    "TXN TYPE\nRTGS-R\nNEFT-N\nHDFC TRF-I\nIMPS - M(1)",
    "BENEFICIARY CODE\n(MANDATORY ONLY FOR\nTXN TYPE \"I\")\n(13)",
    "BENE A/C NO\n(25)",
    "AMOUNT\n(20)",
    "BENEFICIARY NAME\n(35)",
    "IFSC CODE\n(11)",
    "BENE BANK NAME\n(40)",
    "BENE BANK BRANCH NAME\n(40)",
    "BENE EMAIL ID\n(100)",
  ];

  const hRow = ws.addRow(HEADERS);
  hRow.height = 72;
  hRow.eachCell((cell, col) => styleHeader(cell, col === 4));

  // ── Row 2: M / O indicators ──────────────────────────────────────────────
  const INDICATORS = ["M", "M / O", "M", "M", "M", "M", "M", "O", "M"];
  const mRow = ws.addRow(INDICATORS);
  mRow.height = 18;
  mRow.eachCell(cell => styleHeader(cell));

  // ── Data rows ────────────────────────────────────────────────────────────
  for (const r of runs) {
    const dataRow = ws.addRow([
      "",                                       // Txn type — blank
      "",                                       // Beneficiary Code — blank
      (r.bankAccount || "").toUpperCase(),      // Bene A/c No
      r.finalSalary,                            // Amount (numeric)
      (r.employeeName || "").toUpperCase(),     // Beneficiary Name
      (r.bankIfsc || "").toUpperCase(),         // IFSC code
      (r.bankName || "").toUpperCase(),         // Bene Bank Name
      "",                                       // Branch Name — blank
      "",                                       // Email — blank
    ]);
    dataRow.height = 16;
    dataRow.eachCell({ includeEmpty: true }, cell => styleData(cell));
  }

  // ── Download ─────────────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Payroll_${sheetLabel.replace(/[^a-zA-Z0-9]/g, "_")}_${monthYear.replace(/\s/g, "_")}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Session Config Panel
// ─────────────────────────────────────────────────────────────────────────────

function SessionConfigPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: configs, isLoading } = useSessionConfigs();
  const createMutation = useCreateSessionConfig();
  const updateMutation = useUpdateSessionConfig();
  const deleteMutation = useDeleteSessionConfig();

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({
    name: "", startTime: "08:30", endTime: "12:40",
    minimumCheckoutTime: "12:40", payAmount: "", order: "1",
  });

  const resetForm = () => setForm({
    name: "", startTime: "08:30", endTime: "12:40",
    minimumCheckoutTime: "12:40", payAmount: "", order: "1",
  });

  const handleSave = async () => {
    if (!form.name || !form.payAmount) {
      toast({ title: "Name and pay amount are required", variant: "destructive" }); return;
    }
    try {
      if (editId) {
        await updateMutation.mutateAsync({ id: editId, data: {
          name: form.name, startTime: form.startTime, endTime: form.endTime,
          minimumCheckoutTime: form.minimumCheckoutTime || null,
          payAmount: Number(form.payAmount), order: Number(form.order),
        }});
        setEditId(null);
      } else {
        await createMutation.mutateAsync({
          name: form.name, startTime: form.startTime, endTime: form.endTime,
          minimumCheckoutTime: form.minimumCheckoutTime || null,
          payAmount: Number(form.payAmount), order: Number(form.order),
        });
        setShowAdd(false);
      }
      resetForm();
      queryClient.invalidateQueries({ queryKey: getSessionConfigsQueryKey() });
      toast({ title: editId ? "Session updated" : "Session created" });
    } catch {
      toast({ title: "Failed to save session config", variant: "destructive" });
    }
  };

  const handleEdit = (sc: SessionConfigItem) => {
    setEditId(sc.id);
    setShowAdd(false);
    setForm({
      name: sc.name,
      startTime: sc.startTime,
      endTime: sc.endTime,
      minimumCheckoutTime: sc.minimumCheckoutTime ?? "",
      payAmount: String(sc.payAmount),
      order: String(sc.order),
    });
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteMutation.mutateAsync(id);
      queryClient.invalidateQueries({ queryKey: getSessionConfigsQueryKey() });
      toast({ title: "Session deleted" });
    } catch {
      toast({ title: "Failed to delete session config", variant: "destructive" });
    }
  };

  const formFields = (
    <div className="grid sm:grid-cols-2 gap-3 mt-3">
      <div className="space-y-1">
        <Label className="text-xs">Session Name</Label>
        <Input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Morning Session" className="h-8 text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Pay Amount (₹)</Label>
        <Input type="number" value={form.payAmount} onChange={e => setForm(f => ({...f, payAmount: e.target.value}))} placeholder="e.g. 150" className="h-8 text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Start Time</Label>
        <Input type="time" value={form.startTime} onChange={e => setForm(f => ({...f, startTime: e.target.value}))} className="h-8 text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">End Time</Label>
        <Input type="time" value={form.endTime} onChange={e => setForm(f => ({...f, endTime: e.target.value}))} className="h-8 text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Min. Checkout Time</Label>
        <Input type="time" value={form.minimumCheckoutTime} onChange={e => setForm(f => ({...f, minimumCheckoutTime: e.target.value}))} className="h-8 text-sm" />
        <p className="text-xs text-muted-foreground">Session only counts if employee leaves after this time</p>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Order</Label>
        <Input type="number" value={form.order} onChange={e => setForm(f => ({...f, order: e.target.value}))} className="h-8 text-sm" min={1} />
      </div>
      <div className="sm:col-span-2 flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending} className="gap-1.5">
          <CheckCircle2 size={13} />{editId ? "Update Session" : "Add Session"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => { setShowAdd(false); setEditId(null); resetForm(); }}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings size={15} className="text-amber-600" />
            <CardTitle className="text-sm font-bold text-gray-900">Production Session Config</CardTitle>
          </div>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => { setShowAdd(s => !s); setEditId(null); resetForm(); }}>
            <Plus size={12} /> Add Session
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Define pay per session. Production employees earn per completed session — not by the hour.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {showAdd && <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/40 p-3">{formFields}</div>}
        {isLoading ? (
          <div className="space-y-2">{[1,2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}</div>
        ) : (configs ?? []).length === 0 ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-100">
            <AlertCircle size={14} className="text-red-500 mt-0.5 shrink-0" />
            <p className="text-xs text-red-700">
              No sessions configured. Production payroll cannot be generated until you add at least one session.
              <br />Example: Morning (08:30–12:40, min checkout 12:40, ₹150) + Afternoon (13:40–20:00, min checkout 17:30, ₹150).
            </p>
          </div>
        ) : (
          (configs ?? []).map(sc => (
            <div key={sc.id}>
              {editId === sc.id ? (
                <div className="rounded-lg border border-dashed border-blue-300 bg-blue-50/40 p-3">{formFields}</div>
              ) : (
                <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-amber-50/60 border border-amber-100">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-amber-900">{sc.name}</span>
                      <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200">₹{sc.payAmount}/session</Badge>
                    </div>
                    <p className="text-xs text-amber-700 mt-0.5">
                      {sc.startTime} – {sc.endTime}
                      {sc.minimumCheckoutTime && <> · Min checkout: <strong>{sc.minimumCheckoutTime}</strong></>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-gray-700" onClick={() => handleEdit(sc)}><Edit size={13} /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-600" onClick={() => handleDelete(sc.id)}><Trash2 size={13} /></Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Breakdown Drawer
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  present:      "bg-green-100 text-green-700",
  absent:       "bg-red-100 text-red-700",
  paid_leave:   "bg-blue-100 text-blue-700",
  unpaid_leave: "bg-orange-100 text-orange-700",
};

function BreakdownDrawer({ payrollId, onClose }: { payrollId: number; onClose: () => void }) {
  const { data, isLoading } = usePayrollBreakdown(payrollId);
  const bd = data?.breakdown;
  const [showAllDays, setShowAllDays] = useState(false);

  const displayDays = bd && !showAllDays ? bd.days.slice(0, 15) : bd?.days ?? [];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IndianRupee size={18} className="text-green-600" />
            Salary Breakdown — {data ? `${data.employee.name}` : "Loading…"}
          </DialogTitle>
          {data && (
            <p className="text-xs text-muted-foreground">
              {MONTH_NAMES[(data.month ?? 1) - 1]} {data.year}
              {data.weekNumber ? ` · Week ${data.weekNumber}` : ""}
              {" · "}{data.employee.code} · {data.employee.department ?? ""}
            </p>
          )}
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-4">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !bd ? (
          <div className="py-8 text-center text-muted-foreground">
            <Info size={28} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm">No breakdown data available. Re-generate payroll to create it.</p>
          </div>
        ) : (
          <div className="space-y-5 pb-2">

            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-blue-50 p-3 text-center">
                <p className="text-xs text-blue-600 font-medium">Gross Salary</p>
                <p className="text-lg font-black text-blue-800">₹{data!.summary.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
              </div>
              <div className="rounded-lg bg-red-50 p-3 text-center">
                <p className="text-xs text-red-600 font-medium">Deductions</p>
                <p className="text-lg font-black text-red-800">₹{data!.summary.deductions.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
              </div>
              <div className="rounded-lg bg-green-50 p-3 text-center">
                <p className="text-xs text-green-600 font-medium">Net Salary</p>
                <p className="text-lg font-black text-green-800">₹{data!.summary.netSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
              </div>
            </div>

            {/* Staff breakdown */}
            {bd.type === "staff" && (
              <>
                {/* Attendance summary */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Attendance Summary</p>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: "Working Days", value: bd.summary.totalWorkingDays, color: "text-gray-800" },
                      { label: "Present", value: bd.summary.presentDays, color: "text-green-700" },
                      { label: "Paid Leave", value: bd.summary.paidLeaveDays, color: "text-blue-700" },
                      { label: "Absent", value: (bd.summary.absentDays ?? 0) + (bd.summary.unpaidLeaveDays ?? 0), color: "text-red-700" },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg border p-2 text-center">
                        <p className={`text-xl font-black ${s.color}`}>{s.value}</p>
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>
                  {(bd.summary.lateDays ?? 0) > 0 && (
                    <p className="text-xs text-amber-700 mt-2 flex items-center gap-1">
                      <Clock size={12} /> {bd.summary.lateDays} day{bd.summary.lateDays !== 1 ? "s" : ""} late (arrived after grace period)
                    </p>
                  )}
                </div>

                {/* Earnings breakdown */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Earnings Calculation</p>
                  <div className="rounded-lg border divide-y text-sm">
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Monthly Salary</span>
                      <span className="font-semibold">₹{bd.earnings.monthlySalary?.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Working Days in Month</span>
                      <span className="font-semibold">{bd.summary.totalWorkingDays} days</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Daily Rate</span>
                      <span className="font-semibold">₹{bd.earnings.dailyRate?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 bg-blue-50/40">
                      <span className="text-blue-800 font-medium">Effective Days (Present + Paid Leave)</span>
                      <span className="font-bold text-blue-800">{bd.summary.effectivePaidDays} days</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Basic (50%)</span>
                      <span className="font-semibold">₹{bd.earnings.basic?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">HRA (20%)</span>
                      <span className="font-semibold">₹{bd.earnings.hra?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Other Allowances</span>
                      <span className="font-semibold">₹{bd.earnings.allowances?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 bg-green-50/40 font-bold">
                      <span className="text-green-800">Gross Salary</span>
                      <span className="text-green-800">₹{bd.earnings.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                  </div>
                </div>

                {/* Deductions */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Deductions</p>
                  <div className="rounded-lg border divide-y text-sm">
                    {(bd.deductions.pf ?? 0) > 0 && (
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">PF (12% of Basic)</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.pf?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {(bd.deductions.esi ?? 0) > 0 && (
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">ESI (0.75% of Gross)</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.esi?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {bd.deductions.advances > 0 && (
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">Advance Recovery ({bd.deductions.advanceDetails.length} advance{bd.deductions.advanceDetails.length !== 1 ? "s" : ""})</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.advances.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {bd.deductions.total === 0 && (
                      <div className="px-3 py-2 text-muted-foreground text-xs">No deductions</div>
                    )}
                    <div className="flex justify-between px-3 py-2 bg-red-50/40 font-bold">
                      <span className="text-red-800">Total Deductions</span>
                      <span className="text-red-800">- ₹{bd.deductions.total.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                  </div>
                </div>

                {/* Day-by-day table */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Day-by-Day Attendance</p>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Day</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">First In</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Last Out</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Late?</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {displayDays.map((d) => (
                          <tr key={d.date} className="hover:bg-gray-50/50">
                            <td className="px-3 py-1.5 font-mono">{d.date}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{d.day}</td>
                            <td className="px-3 py-1.5">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[d.status ?? "absent"] ?? "bg-gray-100 text-gray-600"}`}>
                                {d.status === "paid_leave" ? (d.leaveType ?? "Paid Leave")
                                  : d.status === "unpaid_leave" ? "Unpaid Leave"
                                  : d.status ?? "—"}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 font-mono text-green-700">{d.firstIn ?? "—"}</td>
                            <td className="px-3 py-1.5 font-mono text-blue-700">{d.lastOut ?? "—"}</td>
                            <td className="px-3 py-1.5">
                              {d.isLate ? <span className="text-amber-600 font-semibold">Late</span> : <span className="text-gray-300">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {bd.days.length > 15 && (
                      <div className="border-t bg-gray-50 px-3 py-2 text-center">
                        <button
                          className="text-xs text-blue-600 hover:underline flex items-center gap-1 mx-auto"
                          onClick={() => setShowAllDays(s => !s)}
                        >
                          {showAllDays ? <><ChevronUp size={12} /> Show fewer days</> : <><ChevronDown size={12} /> Show all {bd.days.length} days</>}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Production breakdown */}
            {bd.type === "production" && (
              <>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Session Configuration</p>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {(bd.sessionConfigs ?? []).map(sc => (
                      <div key={sc.id} className="rounded-lg bg-amber-50 border border-amber-100 p-3">
                        <p className="font-semibold text-sm text-amber-900">{sc.name}</p>
                        <p className="text-xs text-amber-700 mt-0.5">{sc.startTime} – {sc.endTime}</p>
                        <p className="text-xs text-amber-600">Min checkout: <strong>{sc.minCheckout}</strong></p>
                        <p className="text-sm font-bold text-amber-800 mt-1">₹{sc.rate}/session</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Period: {bd.dateFrom} to {bd.dateTo}
                  </p>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[
                      { label: "Days Worked", value: bd.summary.daysWorked, color: "text-green-700" },
                      { label: "Days Absent", value: bd.summary.daysAbsent, color: "text-red-700" },
                      { label: "Total Sessions", value: bd.summary.totalSessions, color: "text-blue-700" },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg border p-2 text-center">
                        <p className={`text-xl font-black ${s.color}`}>{s.value}</p>
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Earnings</p>
                  <div className="rounded-lg border divide-y text-sm">
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Total Sessions Completed</span>
                      <span className="font-semibold">{bd.summary.totalSessions}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 font-bold bg-green-50/40">
                      <span className="text-green-800">Gross Salary</span>
                      <span className="text-green-800">₹{bd.earnings.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                  </div>
                </div>

                {bd.deductions.advances > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Deductions</p>
                    <div className="rounded-lg border divide-y text-sm">
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">Advance Recovery</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.advances.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Day-by-day table */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Day-by-Day Sessions</p>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Day</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">First In</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Last Out</th>
                          <th className="text-right px-3 py-2 font-semibold text-gray-600">Sessions</th>
                          <th className="text-right px-3 py-2 font-semibold text-gray-600">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {displayDays.map((d) => (
                          <tr key={d.date} className={d.present ? "" : "opacity-40"}>
                            <td className="px-3 py-1.5 font-mono">{d.date}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{d.day}</td>
                            <td className="px-3 py-1.5 font-mono text-green-700">{d.firstIn ?? "—"}</td>
                            <td className="px-3 py-1.5 font-mono text-blue-700">{d.lastOut ?? "—"}</td>
                            <td className="px-3 py-1.5 text-right">
                              {d.totalSessions != null && d.totalSessions > 0
                                ? <Badge className="text-xs bg-green-100 text-green-700 border-green-200">{d.totalSessions}</Badge>
                                : <span className="text-gray-300">0</span>
                              }
                            </td>
                            <td className="px-3 py-1.5 text-right font-semibold">
                              {(d.sessionAmount ?? 0) > 0 ? `₹${d.sessionAmount}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {bd.days.length > 15 && (
                      <div className="border-t bg-gray-50 px-3 py-2 text-center">
                        <button className="text-xs text-blue-600 hover:underline flex items-center gap-1 mx-auto" onClick={() => setShowAllDays(s => !s)}>
                          {showAllDays ? <><ChevronUp size={12} /> Show fewer</> : <><ChevronDown size={12} /> Show all {bd.days.length} days</>}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Net salary callout */}
            <div className="rounded-xl bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 p-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-green-600 font-medium">Net Salary Payable</p>
                <p className="text-2xl font-black text-green-800">
                  ₹{data!.summary.netSalary.toLocaleString("en-IN", {maximumFractionDigits:2})}
                </p>
              </div>
              <Badge className={`text-sm ${STATUS_CONFIG[data!.status]?.cls ?? STATUS_CONFIG.pending.cls}`}>
                {STATUS_CONFIG[data!.status]?.label ?? data!.status}
              </Badge>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}><X size={14} className="mr-1" />Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Generate Payroll Dialog
// ─────────────────────────────────────────────────────────────────────────────

function GeneratePayrollDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const generateMutation = useGeneratePayroll();
  const [runType, setRunType] = useState<"monthly" | "biweekly">("monthly");
  const [weekNumber, setWeekNumber] = useState<1 | 2>(1);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());

  const handleGenerate = async () => {
    try {
      const result = await generateMutation.mutateAsync({
        month, year,
        runType,
        weekNumber: runType === "biweekly" ? weekNumber : undefined,
      });
      const skipped = result.skippedDetails ?? [];
      if (skipped.length > 0) {
        toast({
          title: `${result.generated} payrolls generated, ${result.skipped} skipped`,
          description: skipped.slice(0, 3).map(s => `${s.name}: ${s.reason}`).join(" | "),
          variant: "destructive",
        });
      } else {
        toast({ title: `${result.generated} payroll records generated successfully` });
      }
      onSuccess();
      onClose();
    } catch {
      toast({ title: "Failed to generate payroll", variant: "destructive" });
    }
  };

  const lastDay = new Date(year, month, 0).getDate();
  const weekRange = weekNumber === 1
    ? `1–15 ${MONTH_SHORT[month - 1]}`
    : `16–${lastDay} ${MONTH_SHORT[month - 1]}`;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play size={16} className="text-green-600" /> Generate Payroll
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">

          {/* Run type selector */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setRunType("monthly")}
              className={`p-3 rounded-lg border-2 text-left transition-all ${runType === "monthly" ? "border-green-600 bg-green-50" : "border-gray-200 hover:border-gray-300"}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <UserCheck size={14} className={runType === "monthly" ? "text-green-700" : "text-gray-500"} />
                <span className={`font-semibold text-sm ${runType === "monthly" ? "text-green-800" : "text-gray-700"}`}>Staff Monthly</span>
              </div>
              <p className="text-xs text-muted-foreground">Pro-rated monthly salary for all staff</p>
            </button>
            <button
              onClick={() => setRunType("biweekly")}
              className={`p-3 rounded-lg border-2 text-left transition-all ${runType === "biweekly" ? "border-amber-500 bg-amber-50" : "border-gray-200 hover:border-gray-300"}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Factory size={14} className={runType === "biweekly" ? "text-amber-700" : "text-gray-500"} />
                <span className={`font-semibold text-sm ${runType === "biweekly" ? "text-amber-800" : "text-gray-700"}`}>Production Bi-Weekly</span>
              </div>
              <p className="text-xs text-muted-foreground">Session-based pay for production</p>
            </button>
          </div>

          {/* Period selection */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Month</Label>
              <select value={month} onChange={e => setMonth(Number(e.target.value))} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Year</Label>
              <Input type="number" value={year} onChange={e => setYear(Number(e.target.value))} className="h-9" min={2020} max={2030} />
            </div>
          </div>

          {/* Week selector for biweekly */}
          {runType === "biweekly" && (
            <div className="space-y-2">
              <Label className="text-xs">Pay Period</Label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { wk: 1, label: "Week 1 & 2", range: `1–15 ${MONTH_SHORT[month - 1]}` },
                  { wk: 2, label: "Week 3 & 4", range: `16–${lastDay} ${MONTH_SHORT[month - 1]}` },
                ] as const).map(({ wk, label, range }) => (
                  <button
                    key={wk}
                    onClick={() => setWeekNumber(wk)}
                    className={`p-2.5 rounded-lg border-2 text-center transition-all ${weekNumber === wk ? "border-amber-500 bg-amber-50" : "border-gray-200 hover:border-amber-200"}`}
                  >
                    <p className={`font-bold text-sm ${weekNumber === wk ? "text-amber-800" : "text-gray-700"}`}>{label}</p>
                    <p className="text-xs text-muted-foreground">{range}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Summary box */}
          <div className={`rounded-lg p-3 flex items-start gap-2 ${runType === "monthly" ? "bg-green-50 border border-green-100" : "bg-amber-50 border border-amber-100"}`}>
            <Info size={14} className={`${runType === "monthly" ? "text-green-600" : "text-amber-600"} mt-0.5 shrink-0`} />
            <p className={`text-xs ${runType === "monthly" ? "text-green-800" : "text-amber-800"}`}>
              {runType === "monthly"
                ? `Will generate monthly payroll for all active staff employees for ${MONTH_NAMES[month - 1]} ${year}. Calculations are based on attendance logs, approved leave, and advances.`
                : `Will generate session-based payroll for all active production employees for ${weekRange} (${weekNumber === 1 ? "Week 1 & 2" : "Week 3 & 4"}). Sessions completed = attendance × session rate.`
              }
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleGenerate} disabled={generateMutation.isPending}
            className={runType === "monthly" ? "" : "bg-amber-600 hover:bg-amber-700"}>
            {generateMutation.isPending ? "Generating…" : (
              <><Play size={13} className="mr-1.5" />Generate {runType === "monthly" ? "Staff" : "Production"} Payroll</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payroll record row
// ─────────────────────────────────────────────────────────────────────────────

function PayrollRow({ run, onViewBreakdown, onMarkPaid }: {
  run: PayrollRunItem;
  onViewBreakdown: (id: number) => void;
  onMarkPaid: (run: PayrollRunItem) => void;
}) {
  const s = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.pending;
  const isProduction = run.salaryMode === "session";

  return (
    <div className="flex items-center gap-3 py-3 px-4 rounded-xl border bg-white hover:shadow-sm transition-shadow">
      {/* Employee info */}
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 ${isProduction ? "bg-gradient-to-br from-amber-400 to-orange-500" : "bg-gradient-to-br from-blue-400 to-indigo-500"}`}>
        {(run.employeeName ?? "?").charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-bold text-sm text-gray-900 truncate">{run.employeeName ?? `Employee #${run.employeeId}`}</p>
          <Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge>
          <Badge className={`text-xs ${isProduction ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-green-100 text-green-700 border-green-200"}`}>
            {isProduction ? "Production" : "Staff"}
          </Badge>
          {run.weekNumber && <Badge variant="outline" className="text-xs">Week {run.weekNumber}</Badge>}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
          {isProduction ? (
            <span className="flex items-center gap-1"><CalendarDays size={11} />{run.completedSessions} sessions</span>
          ) : (
            <span className="flex items-center gap-1"><CalendarDays size={11} />{run.presentDays} / {run.totalWorkingDays} days</span>
          )}
          <span className="flex items-center gap-1"><ArrowRight size={11} />Gross ₹{run.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</span>
          {run.deductions > 0 && <span className="text-red-500">- ₹{run.deductions.toLocaleString("en-IN", {maximumFractionDigits:0})}</span>}
        </div>
      </div>

      {/* Net salary */}
      <div className="text-right shrink-0">
        <p className="text-sm font-black text-green-700">₹{run.finalSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
        <p className="text-xs text-muted-foreground">net</p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onViewBreakdown(run.id)}>
          <Info size={11} /> Details
        </Button>
        {run.status === "pending" && (
          <Button size="sm" className="h-7 text-xs gap-1 bg-green-700 hover:bg-green-800" onClick={() => onMarkPaid(run)}>
            <CheckCircle2 size={11} /> Mark Paid
          </Button>
        )}
        {run.status === "paid" && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <Lock size={11} /> Paid
          </span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main Page
// ─────────────────────────────────────────────────────────────────────────────

export default function PayrollFull() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSessionConfig, setShowSessionConfig] = useState(false);
  const [breakdownId, setBreakdownId] = useState<number | null>(null);

  const [filterMonth, setFilterMonth] = useState<number>(new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState<number>(new Date().getFullYear());
  const [filterType, setFilterType] = useState<"staff" | "production">("staff");
  const [prodWeek, setProdWeek]     = useState<"week12" | "week34">("week12");

  const updateMutation = useUpdatePayrollRecord();

  const { data: runs, isLoading } = useListPayrollRuns({ month: filterMonth, year: filterYear });

  const allRuns = runs ?? [];
  const staffRuns  = allRuns.filter(r => r.salaryMode === "monthly");
  const week12Runs = allRuns.filter(r => r.salaryMode === "session" && r.weekNumber === 1);
  const week34Runs = allRuns.filter(r => r.salaryMode === "session" && r.weekNumber === 2);
  const prodRuns   = [...week12Runs, ...week34Runs];

  const filteredRuns =
    filterType === "staff" ? staffRuns :
    prodWeek === "week12"  ? week12Runs : week34Runs;

  const totalGross = filteredRuns.reduce((s, r) => s + r.grossSalary, 0);
  const totalDeductions = filteredRuns.reduce((s, r) => s + r.deductions, 0);
  const totalNet = filteredRuns.reduce((s, r) => s + r.finalSalary, 0);
  const pendingCount = filteredRuns.filter(r => r.status === "pending").length;

  const handleMarkPaid = async (run: PayrollRunItem) => {
    try {
      await updateMutation.mutateAsync({ id: run.id, data: { status: "paid" } });
      toast({ title: `${run.employeeName ?? "Employee"}'s salary marked as paid` });
      queryClient.invalidateQueries({ queryKey: getListPayrollRunsQueryKey({ month: filterMonth, year: filterYear }) });
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Payroll</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              {MONTH_NAMES[filterMonth - 1]} {filterYear} · {filteredRuns.length} records
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline" className="gap-2 h-9"
              onClick={() => setShowSessionConfig(s => !s)}
            >
              <Settings size={14} /> Session Config
            </Button>
            <Button className="gap-2 h-9" onClick={() => setShowGenerate(true)}>
              <Play size={14} /> Generate Payroll
            </Button>
          </div>
        </div>

        {/* Session Config (collapsible) */}
        {showSessionConfig && <SessionConfigPanel />}

        {/* Generate dialog */}
        {showGenerate && (
          <GeneratePayrollDialog
            onClose={() => setShowGenerate(false)}
            onSuccess={() => queryClient.invalidateQueries({ queryKey: getListPayrollRunsQueryKey({ month: filterMonth, year: filterYear }) })}
          />
        )}

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={filterMonth}
            onChange={e => setFilterMonth(Number(e.target.value))}
            className="h-8 rounded-md border px-3 text-sm bg-background"
          >
            {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <Input
            type="number" value={filterYear}
            onChange={e => setFilterYear(Number(e.target.value))}
            className="h-8 w-20 text-sm" min={2020} max={2030}
          />
          <Separator orientation="vertical" className="h-6" />
          {(
            [
              { key: "staff",      label: `Staff (${staffRuns.length})` },
              { key: "production", label: `Production (${prodRuns.length})` },
            ] as const
          ).map(t => (
            <button
              key={t.key}
              onClick={() => setFilterType(t.key)}
              className={`text-sm px-3 py-1 rounded-full font-medium transition-all border ${
                filterType === t.key
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Summary Cards + Export */}
        {/* Production sub-tabs (Week 1&2 / Week 3&4) */}
        {!isLoading && filterType === "production" && (
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                { key: "week12", label: `Week 1 & 2`, count: week12Runs.length, range: `${MONTH_SHORT[filterMonth - 1]} 1–15` },
                { key: "week34", label: `Week 3 & 4`, count: week34Runs.length, range: `${MONTH_SHORT[filterMonth - 1]} 16–${new Date(filterYear, filterMonth, 0).getDate()}` },
              ] as const
            ).map(t => (
              <button
                key={t.key}
                onClick={() => setProdWeek(t.key)}
                className={`text-sm px-3 py-1 rounded-full font-medium transition-all border ${
                  prodWeek === t.key
                    ? "bg-amber-600 text-white border-amber-600"
                    : "bg-white text-gray-600 border-gray-200 hover:border-amber-400"
                }`}
              >
                {t.label} ({t.count}) <span className="font-normal opacity-70 text-xs">— {t.range}</span>
              </button>
            ))}

            {filteredRuns.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2 h-8 border-green-600 text-green-700 hover:bg-green-50 ml-auto"
                onClick={() => exportPayrollToExcel(
                  filteredRuns,
                  prodWeek === "week12" ? "Week_1_and_2" : "Week_3_and_4",
                  `${MONTH_NAMES[filterMonth - 1]}_${filterYear}`,
                )}
              >
                <Download size={13} /> Export to Excel
              </Button>
            )}
          </div>
        )}

        {/* Staff export button */}
        {!isLoading && filterType === "staff" && filteredRuns.length > 0 && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 h-8 border-green-600 text-green-700 hover:bg-green-50"
              onClick={() => exportPayrollToExcel(
                filteredRuns,
                "Staff",
                `${MONTH_NAMES[filterMonth - 1]}_${filterYear}`,
              )}
            >
              <Download size={13} /> Export to Excel
            </Button>
          </div>
        )}
        {!isLoading && filteredRuns.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total Gross", value: `₹${(totalGross / 1000).toFixed(1)}K`, color: "text-blue-700", icon: TrendingUp, bg: "bg-blue-50" },
              { label: "Deductions", value: `₹${(totalDeductions / 1000).toFixed(1)}K`, color: "text-red-600", icon: IndianRupee, bg: "bg-red-50" },
              { label: "Net Payable", value: `₹${(totalNet / 1000).toFixed(1)}K`, color: "text-green-700", icon: CheckCircle2, bg: "bg-green-50" },
              { label: "Pending Payment", value: `${pendingCount} employees`, color: "text-amber-700", icon: Clock, bg: "bg-amber-50" },
            ].map(s => (
              <Card key={s.label} className="border-0 shadow-sm">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg ${s.bg} flex items-center justify-center shrink-0`}>
                    <s.icon size={16} className={s.color} />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={`text-base font-black ${s.color}`}>{s.value}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Payroll Records */}
        <div className="space-y-2">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))
          ) : filteredRuns.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground border-2 border-dashed border-gray-200 rounded-xl">
              <Users size={32} className="mx-auto text-gray-200 mb-3" />
              <p className="text-sm font-semibold text-gray-600">No payroll records for {MONTH_NAMES[filterMonth - 1]} {filterYear}</p>
              <p className="text-xs text-gray-400 mt-1">Click "Generate Payroll" to compute payroll from attendance data.</p>
              <Button className="mt-4 gap-2" onClick={() => setShowGenerate(true)}>
                <Play size={14} /> Generate Payroll
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredRuns.map(run => (
                <PayrollRow
                  key={run.id}
                  run={run}
                  onViewBreakdown={setBreakdownId}
                  onMarkPaid={handleMarkPaid}
                />
              ))}
            </div>
          )}
        </div>

        {/* Rules reminder */}
        <Card className="border-0 bg-gray-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="text-blue-500 mt-0.5 shrink-0" />
              <div className="text-xs text-gray-500 space-y-0.5">
                <p><strong>Staff:</strong> Monthly salary, pro-rated by working days (Mon–Sat or Mon–Fri). PF = 12% of basic. ESI = 0.75% of gross (if salary ≤ ₹21,000).</p>
                <p><strong>Production:</strong> Bi-weekly session pay. Morning + afternoon sessions each paid separately. Min checkout time determines if session counts.</p>
                <p><strong>Advances</strong> are auto-deducted from the monthly repayment schedule configured in the Advances module.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Breakdown Drawer */}
      {breakdownId && (
        <BreakdownDrawer payrollId={breakdownId} onClose={() => setBreakdownId(null)} />
      )}
    </HrLayout>
  );
}
