import { useState, useEffect, useRef } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth, permissionLevel } from "@/contexts/AuthContext";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useSalarySlipBulk } from "@/contexts/SalarySlipBulkContext";
import { useWhatsAppBulk } from "@/contexts/WhatsAppBulkContext";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import SalarySlipBulkPipeline from "@/components/SalarySlipBulkPipeline";
import WhatsAppBulkPipeline from "@/components/WhatsAppBulkPipeline";
import {
  useListPayrollRuns, useUpdatePayrollRecord, useListDepartments,
  useSessionConfigs, useCreateSessionConfig,
  useUpdateSessionConfig, useDeleteSessionConfig,
  getListPayrollRunsQueryKey, getSessionConfigsQueryKey,
  useListEmployees, useListSalarySlips, useEmailSalarySlip,
  type PayrollRunItem, type SessionConfigItem, type SalarySlipItem,
} from "@/lib/api-client";
import { usePayrollSkipCheck, previewDocumentPdf, downloadDocumentPdf, useWhatsAppSalarySlip } from "@/lib/api-client/custom-hooks";
import { useQueryClient } from "@tanstack/react-query";
import { exportPayrollToExcel } from "@/lib/payrollExcelExport";
import { MONTH_NAMES, BreakdownDrawer, PayrollRow } from "@/components/payroll/BreakdownDrawer";
import { customFetch } from "@/lib/api-client/custom-fetch";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import {
  IndianRupee, Play, CheckCircle2, CheckCircle, Clock, Users,
  TrendingUp, AlertCircle, Info,
  Settings, Plus, Trash2, Edit, X,
  Download, Search, AlertTriangle, RefreshCcw,
  CreditCard, Layers, FileText, FileSearch, Mail, Loader2, Eye, MessageCircle,
} from "lucide-react";

// Staff Payroll's 3 sub-tabs map to 3 independently-permissioned module keys
// (unchanged from before this page consolidated them into one shell) -mirrors
// Settings.tsx's SETTINGS_TAB_MODULE pattern for merging several
// independently-gated experiences into one tabbed page.
const STAFF_PAYROLL_TAB_MODULE: Record<string, string> = {
  payroll: "payroll",
  salary: "salary",
  payslip: "salary_slip",
};

// ─────────────────────────────────────────────────────────────────────────────
//  Session Config Panel (Payroll sub-tab)
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
            <CardTitle className="text-sm font-bold text-gray-900">Legacy Session Config</CardTitle>
          </div>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => { setShowAdd(s => !s); setEditId(null); resetForm(); }}>
            <Plus size={12} /> Add Session
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Not used by current production payroll -pay is now Total Shifts × Salary Per Shift
          (configure shift segments and punch times in Settings → Payroll). This panel only affects
          historical payroll records still shown in the old session format.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {showAdd && <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/40 p-3">{formFields}</div>}
        {isLoading ? (
          <ShieldLoader />
        ) : (configs ?? []).length === 0 ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-gray-50 border border-gray-100">
            <AlertCircle size={14} className="text-gray-400 mt-0.5 shrink-0" />
            <p className="text-xs text-gray-500">
              No legacy sessions configured -nothing to do here. Current production payroll doesn't need this.
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
//  Generate Payroll Dialog (Payroll sub-tab)
// ─────────────────────────────────────────────────────────────────────────────

function GeneratePayrollDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const { triggerGenerate, isGenerating } = usePayrollGeneration();
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());

  const handleGenerate = () => {
    if (isGenerating) {
      toast({ title: "A payroll run is already in progress", description: "Wait for it to finish before starting another." });
      return;
    }
    // Fire-and-forget: the PayrollGenerationContext owns the request and the
    // progress polling from here, so generation keeps running -and stays
    // visible via the pipeline/banner -even after this dialog (or the whole
    // page) unmounts.
    triggerGenerate({ month, year, runType: "monthly" });
    onSuccess();
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play size={16} className="text-green-600" /> Generate Payroll
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">

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

          {/* Summary box */}
          <div className="rounded-lg p-3 flex items-start gap-2 bg-green-50 border border-green-100">
            <Info size={14} className="text-green-600 mt-0.5 shrink-0" />
            <p className="text-xs text-green-800">
              Will generate monthly payroll for all active staff employees for {MONTH_NAMES[month - 1]} {year}.
              Calculations are based on attendance logs, approved leave, and advances.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? "A run is already in progress…" : (
              <><Play size={13} className="mr-1.5" />Generate Staff Payroll</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Skipped Employees Dialog (Payroll sub-tab) -on-demand, read-only preview of
//  who Generate Payroll would currently skip and why. Unlike the
//  post-generation toast, this works any time HR wants to check, not just
//  right after a run.
// ─────────────────────────────────────────────────────────────────────────────

function SkippedEmployeesDialog({ params, periodLabel, onClose }: {
  params: { month: number; year: number; runType: "monthly" | "biweekly"; weekNumber?: number };
  periodLabel: string;
  onClose: () => void;
}) {
  const { data, isLoading, isFetching, refetch } = usePayrollSkipCheck(params);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" /> Skipped Employees
          </DialogTitle>
          <p className="text-xs text-muted-foreground">Staff · {periodLabel}</p>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !data || data.skipped.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">
            <CheckCircle2 size={28} className="mx-auto mb-2 text-green-300" />
            <p className="text-sm font-semibold text-gray-700">Nobody would be skipped</p>
            <p className="text-xs mt-0.5">All {data?.totalChecked ?? 0} active employees checked out fine for this period.</p>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-xs text-gray-500">
              {data.skippedCount} of {data.totalChecked} active employees would be skipped if you ran Generate Payroll now:
            </p>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {data.skipped.map(s => (
                <div key={s.employeeId} className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-amber-900">{s.name}</span>
                    <span className="text-xs text-amber-600 font-mono">{s.employeeCode}</span>
                  </div>
                  <p className="text-xs text-amber-700 mt-0.5">{s.reason}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCcw size={12} className={isFetching ? "animate-spin" : ""} /> Re-check
          </Button>
          <Button onClick={onClose}><X size={14} className="mr-1" />Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payroll sub-tab -verbatim body of the former PayrollFull.tsx page
// ─────────────────────────────────────────────────────────────────────────────

function PayrollSubTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSessionConfig, setShowSessionConfig] = useState(false);
  const [showSkipCheck, setShowSkipCheck] = useState(false);
  const [breakdownId, setBreakdownId] = useState<number | null>(null);

  const [filterMonth, setFilterMonth] = useState<number>(new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState<number>(new Date().getFullYear());
  const [search, setSearch]         = useState("");
  const [deptFilter, setDeptFilter] = useState("all");

  const updateMutation = useUpdatePayrollRecord();
  const { showPipeline, progress, dismiss: dismissPipeline } = usePayrollGeneration();
  const { data: departments } = useListDepartments();

  const { data: runs, isLoading } = useListPayrollRuns({ month: filterMonth, year: filterYear });

  // This page is Staff-only -Production payroll has its own dedicated page
  // (Production Payroll) with its own configurable period cycle.
  const staffRuns = (runs ?? []).filter(r => r.salaryMode === "monthly");

  const filteredRuns = staffRuns.filter(r => {
    if (deptFilter !== "all" && String(r.departmentId ?? "") !== deptFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.employeeName?.toLowerCase().includes(q) ||
      r.employeeCode?.toLowerCase().includes(q)
    );
  });

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

  const skipCheckParams = {
    month: filterMonth,
    year: filterYear,
    runType: "monthly" as const,
  };
  const skipCheckPeriodLabel = `${MONTH_NAMES[filterMonth - 1]} ${filterYear}`;
  // Auto-runs on mount/month-change (not gated behind the dialog opening) so
  // the new "Skipped" KPI card below always shows a live count -this is a
  // per-employee dry-run simulation but acceptable as a one-time page-load
  // cost for an internal HR tool. SkippedEmployeesDialog calls the exact
  // same hook+params, so React Query serves it from cache when opened -no
  // duplicate network request.
  const { data: skipData, isLoading: skipLoading } = usePayrollSkipCheck(skipCheckParams);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-muted-foreground text-sm">
            {MONTH_NAMES[filterMonth - 1]} {filterYear} · {filteredRuns.length} records
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" className="gap-2 h-9 border-amber-200 text-amber-700 hover:bg-amber-50"
            onClick={() => setShowSkipCheck(true)}
          >
            <AlertTriangle size={14} /> Skipped Employees
          </Button>
          <Button
            variant="outline" className="gap-2 h-9"
            onClick={() => setShowSessionConfig(s => !s)}
          >
            <Settings size={14} /> Legacy Session Config
          </Button>
          <Button className="gap-2 h-9" onClick={() => setShowGenerate(true)}>
            <Play size={14} /> Generate Payroll
          </Button>
        </div>
      </div>

      {/* Payroll generation progress */}
      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismissPipeline} />

      {/* Session Config (collapsible) */}
      {showSessionConfig && <SessionConfigPanel />}

      {/* Generate dialog */}
      {showGenerate && (
        <GeneratePayrollDialog
          onClose={() => setShowGenerate(false)}
          onSuccess={() => queryClient.invalidateQueries({ queryKey: getListPayrollRunsQueryKey({ month: filterMonth, year: filterYear }) })}
        />
      )}

      {/* Skipped employees preview */}
      {showSkipCheck && (
        <SkippedEmployeesDialog
          params={skipCheckParams}
          periodLabel={skipCheckPeriodLabel}
          onClose={() => setShowSkipCheck(false)}
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
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by employee code or name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm w-56"
          />
        </div>
        <Select value={deptFilter} onValueChange={setDeptFilter}>
          <SelectTrigger className="h-8 w-44 text-sm">
            <SelectValue placeholder="Department" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Departments</SelectItem>
            {departments?.map(d => (
              <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Export */}
      {!isLoading && filteredRuns.length > 0 && (
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
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: "Total Gross", value: `₹${(totalGross / 1000).toFixed(1)}K`, color: "text-blue-700", icon: TrendingUp, bg: "bg-blue-50" },
            { label: "Deductions", value: `₹${(totalDeductions / 1000).toFixed(1)}K`, color: "text-red-600", icon: IndianRupee, bg: "bg-red-50" },
            { label: "Net Payable", value: `₹${(totalNet / 1000).toFixed(1)}K`, color: "text-green-700", icon: CheckCircle2, bg: "bg-green-50" },
            { label: "Pending Payment", value: `${pendingCount} employees`, color: "text-amber-700", icon: Clock, bg: "bg-amber-50" },
            {
              label: "Skipped", value: skipLoading ? "…" : `${skipData?.skippedCount ?? 0} employees`,
              color: "text-orange-700", icon: AlertTriangle, bg: "bg-orange-50", onClick: () => setShowSkipCheck(true),
            },
          ].map(s => (
            <Card
              key={s.label}
              className={`border-0 shadow-sm ${s.onClick ? "cursor-pointer hover:shadow-md transition-shadow" : ""}`}
              onClick={s.onClick}
            >
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
          <ShieldLoader />
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
              <p><strong>Advances</strong> are auto-deducted from the monthly repayment schedule configured in the Advances module.</p>
              <p>Looking for Production employees? See the <strong>Production Payroll</strong> page -it has its own configurable period cycle.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Breakdown Drawer */}
      {breakdownId && (
        <BreakdownDrawer payrollId={breakdownId} onClose={() => setBreakdownId(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Salary sub-tab -verbatim body of the former Salary.tsx page (raw
//  customFetch data-fetching kept exactly as-is, not upgraded to hooks)
// ─────────────────────────────────────────────────────────────────────────────

const payrollAdjustmentSchema = z.object({
  bonus: z.string().min(1, "Bonus amount required"),
  deductions: z.string().min(1, "Deduction amount required"),
  notes: z.string().optional(),
});

function SalarySubTab() {
  const { toast } = useToast();
  const { data: employees } = useListEmployees({ status: "active" });

  // Filter States
  const [empFilter, setEmpFilter] = useState("all");
  const [monthFilter, setMonthFilter] = useState(String(new Date().getMonth() + 1));
  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));
  const [statusFilter, setStatusFilter] = useState("all");

  // Data Loading States
  const [payrolls, setPayrolls] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Generate Payroll dialog state (separate from display filter)
  const [genMonth, setGenMonth] = useState(String(new Date().getMonth() + 1));
  const [genYear, setGenYear] = useState(String(new Date().getFullYear()));

  // Dialog open states
  const [runPayrollOpen, setRunPayrollOpen] = useState(false);
  const [adjustPayrollOpen, setAdjustPayrollOpen] = useState(false);

  // Selected state for editing
  const [selectedPayroll, setSelectedPayroll] = useState<any | null>(null);

  // Pagination
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  const payrollAdjustForm = useForm<z.infer<typeof payrollAdjustmentSchema>>({
    resolver: zodResolver(payrollAdjustmentSchema),
    defaultValues: { bonus: "0", deductions: "0", notes: "" },
  });

  const fetchPayrolls = async (overrideMonth?: string, overrideYear?: string) => {
    try {
      setLoading(true);
      const m = overrideMonth ?? monthFilter;
      const y = overrideYear ?? yearFilter;
      let url = `/api/payroll?month=${m}&year=${y}`;
      if (empFilter !== "all") url += `&employeeId=${empFilter}`;
      if (statusFilter !== "all") url += `&status=${statusFilter}`;
      const data = await customFetch<any[]>(url);
      setPayrolls(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPayrolls();
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empFilter, monthFilter, yearFilter, statusFilter]);

  // Payroll generation lives in a root-level context (PayrollGenerationProvider)
  // so it keeps running -and stays visible via the pipeline/banner -even if
  // this page unmounts mid-run, the same pattern Attendance.tsx uses for the
  // biometric sync pipeline.
  const { triggerGenerate, isGenerating, showPipeline, progress, dismiss: dismissPipeline } = usePayrollGeneration();
  const generatedParamsRef = useRef<{ month: string; year: string } | null>(null);
  const wasGeneratingRef = useRef(false);

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating && generatedParamsRef.current) {
      const { month, year } = generatedParamsRef.current;
      fetchPayrolls(month, year);
      generatedParamsRef.current = null;
    }
    wasGeneratingRef.current = isGenerating;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerating]);

  // Operations
  const handleGeneratePayroll = () => {
    if (isGenerating) {
      toast({ title: "A payroll run is already in progress", description: "Wait for it to finish before starting another." });
      return;
    }
    generatedParamsRef.current = { month: genMonth, year: genYear };
    triggerGenerate({ month: Number(genMonth), year: Number(genYear), runType: "monthly" });
    // Switch display filter to the generated period right away so the list
    // is pointed at the right period once results land.
    setMonthFilter(genMonth);
    setYearFilter(genYear);
    setRunPayrollOpen(false);
  };

  const submitAdjustment = async (data: z.infer<typeof payrollAdjustmentSchema>) => {
    if (!selectedPayroll) return;
    try {
      await customFetch(`/api/payroll/${selectedPayroll.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          bonus: Number(data.bonus),
          deductions: Number(data.deductions),
          notes: data.notes,
        }),
      });
      toast({ title: "Adjustment applied successfully" });
      fetchPayrolls();
      setAdjustPayrollOpen(false);
    } catch (err: any) {
      toast({ title: "Adjustment failed", description: err.data?.error || "", variant: "destructive" });
    }
  };

  const markPayrollPaid = async (id: number) => {
    try {
      await customFetch(`/api/payroll/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "paid" }),
      });
      toast({ title: "Payroll status updated to Paid" });
      fetchPayrolls();
    } catch (err: any) {
      toast({ title: "Status update failed", description: err.data?.error || "", variant: "destructive" });
    }
  };

  // This page is Staff-only -Production payroll has its own dedicated
  // Production Payroll page with its own configurable period cycle.
  const groupedPayrolls = payrolls.filter(p => p.salaryMode === "monthly");

  // Stats calculation
  const totalGross = groupedPayrolls.reduce((sum, p) => sum + p.grossSalary, 0);
  const totalPaid = groupedPayrolls.filter(p => p.status === "paid").reduce((sum, p) => sum + p.finalSalary, 0);
  const totalPending = groupedPayrolls.filter(p => p.status === "pending").reduce((sum, p) => sum + p.finalSalary, 0);

  // Paginated Data
  const totalRecords = groupedPayrolls.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
  const currentPage = page > totalPages ? totalPages : page;
  const paginated = groupedPayrolls.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">
            Computed monthly payroll records for staff employees.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {groupedPayrolls.length > 0 && (
            <Button
              variant="outline"
              className="gap-2 border-green-600 text-green-700 hover:bg-green-50"
              onClick={() => exportPayrollToExcel(
                groupedPayrolls,
                "Staff",
                `${new Date(2000, Number(monthFilter) - 1).toLocaleDateString("en-US", { month: "long" })}_${yearFilter}`,
              )}
            >
              <Download size={16} /> Export to Excel
            </Button>
          )}
          <Button
            onClick={() => {
              setGenMonth(monthFilter);
              setGenYear(yearFilter);
              setRunPayrollOpen(true);
            }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition duration-200"
          >
            <Play size={16} className="mr-2" />
            Generate Payroll
          </Button>
        </div>
      </div>

      {/* Payroll generation progress */}
      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismissPipeline} />

      {/* Global Filter Bar */}
      <Card className="shadow-sm border-slate-100 bg-white">
        <CardContent className="p-4 flex flex-wrap gap-3 items-center">
          <div className="w-56">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Employee Search</label>
            <EmployeeSearchSelect
              employees={employees}
              value={empFilter}
              onChange={setEmpFilter}
              allowAll={true}
              allPlaceholder="All Employees"
              dataTestId="select-employee-filter"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Target Month</label>
            <Select value={monthFilter} onValueChange={setMonthFilter}>
              <SelectTrigger className="w-40 font-medium">
                <SelectValue placeholder="Month" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 12 }, (_, i) => (
                  <SelectItem key={i+1} value={String(i+1)}>
                    {new Date(2000, i).toLocaleDateString("en-US", { month: "long" })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Target Year</label>
            <Select value={yearFilter} onValueChange={setYearFilter}>
              <SelectTrigger className="w-28 font-medium">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent>
                {["2025", "2026", "2027", "2028"].map(yr => (
                  <SelectItem key={yr} value={yr}>{yr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Payment Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 font-medium">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Payrolls</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="self-end pb-0.5">
            {(empFilter !== "all" || statusFilter !== "all" || monthFilter !== String(new Date().getMonth() + 1)) && (
              <Button variant="ghost" size="sm" onClick={() => { setEmpFilter("all"); setStatusFilter("all"); setMonthFilter(String(new Date().getMonth() + 1)); }} className="text-slate-400 hover:text-slate-600">
                Reset Filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Financial Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-l-4 border-l-indigo-600 bg-white shadow-sm">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Gross Payroll Amount</p>
              <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalGross.toLocaleString("en-IN")}</h3>
            </div>
            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
              <Layers size={22} />
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-emerald-500 bg-white shadow-sm">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Paid Payroll</p>
              <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalPaid.toLocaleString("en-IN")}</h3>
            </div>
            <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
              <CheckCircle size={22} />
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500 bg-white shadow-sm">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pending Release</p>
              <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalPending.toLocaleString("en-IN")}</h3>
            </div>
            <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
              <Clock size={22} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* PAYROLL COMPUTATION RECORDS */}
      <div className="flex-1">
        <Card className="shadow-sm border-slate-100 bg-white">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="pl-4 font-bold text-slate-700">Employee</TableHead>
                  <TableHead className="font-bold text-slate-700">Mode</TableHead>
                  <TableHead className="font-bold text-slate-700">Period</TableHead>
                  <TableHead className="font-bold text-slate-700">Present (Days)</TableHead>
                  <TableHead className="font-bold text-slate-700">Basic Rate</TableHead>
                  <TableHead className="font-bold text-slate-700">OT Pay</TableHead>
                  <TableHead className="font-bold text-slate-700">Bonus / Deduct</TableHead>
                  <TableHead className="font-bold text-slate-700">Final Payout</TableHead>
                  <TableHead className="font-bold text-slate-700">Status</TableHead>
                  <TableHead className="pr-4 text-right font-bold text-slate-700">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8">
                      <ShieldLoader />
                    </TableCell>
                  </TableRow>
                ) : paginated.length > 0 ? (
                  paginated.map((rec) => (
                    <TableRow key={rec.id} className="hover:bg-slate-50/50">
                      <TableCell className="pl-4 font-semibold text-slate-900">
                        <div>{rec.employeeName}</div>
                        <span className="text-[10px] text-slate-400 block font-mono">ID: {rec.employeeId}</span>
                      </TableCell>
                      <TableCell className="text-xs font-semibold">
                        <Badge variant="outline" className={rec.salaryMode === "monthly" ? "text-blue-700 bg-blue-50 border-blue-100" : "text-purple-700 bg-purple-50 border-purple-100"}>
                          {rec.salaryMode === "monthly" ? "Monthly" : rec.salaryMode === "shift" ? "Shift" : "Session"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-medium text-slate-600">
                        {rec.month}/{rec.year}{rec.weekNumber ? ` · Wk ${rec.weekNumber}` : ""}
                      </TableCell>
                      <TableCell className="text-xs font-mono font-medium text-slate-700">
                        {rec.presentDays} Days
                      </TableCell>
                      <TableCell className="font-medium text-xs">₹{rec.baseSalary.toLocaleString("en-IN")}</TableCell>
                      <TableCell className="font-medium text-xs text-indigo-600">₹{rec.otAmount.toLocaleString("en-IN")}</TableCell>
                      <TableCell className="text-xs">
                        <span className="text-emerald-600 font-semibold">+₹{rec.bonus}</span>
                        <span className="text-rose-600 font-semibold ml-2">-₹{rec.deductions}</span>
                      </TableCell>
                      <TableCell className="font-black text-indigo-700 text-sm">₹{rec.finalSalary.toLocaleString("en-IN")}</TableCell>
                      <TableCell>
                        <Badge className={rec.status === "paid" ? "bg-emerald-100 text-emerald-800 border-transparent font-bold hover:bg-emerald-200" : "bg-amber-100 text-amber-800 border-transparent font-bold hover:bg-amber-200"}>
                          {rec.status.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4 text-right flex gap-1 justify-end">
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-indigo-600 hover:text-indigo-800" onClick={() => {
                          setSelectedPayroll(rec);
                          payrollAdjustForm.setValue("bonus", String(rec.bonus));
                          payrollAdjustForm.setValue("deductions", String(rec.deductions));
                          payrollAdjustForm.setValue("notes", rec.notes || "");
                          setAdjustPayrollOpen(true);
                        }}>
                          <Edit size={14} />
                        </Button>
                        {rec.status === "pending" && (
                          <Button size="sm" variant="ghost" className="h-8 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 px-2" onClick={() => markPayrollPaid(rec.id)}>
                            <CheckCircle size={13} className="mr-1" /> Pay
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-16 text-muted-foreground">
                      No payroll computations generated for this period. Click "Generate Payroll" to run the wage engine.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* BOTTOM PAGINATION ELEMENT */}
      {totalRecords > PAGE_SIZE && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t bg-card rounded-lg shadow-sm shrink-0">
          <p className="text-sm text-muted-foreground font-medium">
            Showing {paginated.length} of {totalRecords} entries
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-3 py-1.5 rounded-md font-mono">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* DIALOG: GENERATE PAYROLL -Staff only. Production has its own
          dedicated Production Payroll page with its own generate flow. */}
      <Dialog open={runPayrollOpen} onOpenChange={setRunPayrollOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play size={16} className="text-indigo-600" />
              Generate Payroll
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">

            {/* Period selection */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Month</Label>
                <select value={genMonth} onChange={e => setGenMonth(e.target.value)} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                  {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Year</Label>
                <Input type="number" value={genYear} onChange={e => setGenYear(e.target.value)} className="h-9" min={2020} max={2030} />
              </div>
            </div>

            {/* Summary box */}
            <div className="rounded-lg p-3 flex items-start gap-2 bg-indigo-50 border border-indigo-100">
              <Info size={14} className="text-indigo-600 mt-0.5 shrink-0" />
              <p className="text-xs text-indigo-800">
                Will generate monthly payroll for all active staff employees for {MONTH_NAMES[Number(genMonth) - 1]} {genYear}.
                Calculations are based on attendance logs, approved leave, and advances.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunPayrollOpen(false)}>Cancel</Button>
            <Button
              onClick={handleGeneratePayroll} disabled={isGenerating}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold"
            >
              {isGenerating ? "A run is already in progress…" : (
                <><Play size={13} className="mr-1.5" />Generate Staff Payroll</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DIALOG: ADJUST PAYROLL */}
      <Dialog open={adjustPayrollOpen} onOpenChange={setAdjustPayrollOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust Employee Payroll</DialogTitle>
          </DialogHeader>
          <Form {...payrollAdjustForm}>
            <form onSubmit={payrollAdjustForm.handleSubmit(submitAdjustment)} className="space-y-4">
              <div className="bg-slate-50 p-3 rounded-lg border text-xs mb-2">
                <strong>Employee:</strong> {selectedPayroll?.employeeName} <br />
                <strong>Base Wage:</strong> ₹{selectedPayroll?.baseSalary} <br />
                <strong>OT Wage:</strong> ₹{selectedPayroll?.otAmount}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField control={payrollAdjustForm.control} name="bonus" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bonus (₹)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={payrollAdjustForm.control} name="deductions" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Deductions (₹)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={payrollAdjustForm.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes / Adjustments justification</FormLabel>
                  <FormControl><Textarea rows={2} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAdjustPayrollOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold">Apply Changes</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payslip sub-tab -verbatim body of the former SalarySlip.tsx page, minus its
//  Staff/Production toggle: hardcoded to "staff", mirrors how
//  ProductionPayroll.tsx's own Payslip sub-tab hardcodes "production".
// ─────────────────────────────────────────────────────────────────────────────

function PayslipSubTab() {
  const { toast } = useToast();
  const { token } = useAuth();
  const emailMutation = useEmailSalarySlip();
  const whatsappMutation = useWhatsAppSalarySlip();
  const today = new Date();
  const [month, setMonth]         = useState(today.getMonth() + 1);
  const [year, setYear]           = useState(today.getFullYear());
  const [search, setSearch]       = useState("");
  const [emailing, setEmailing]   = useState<number | null>(null);
  const [whatsapping, setWhatsapping] = useState<number | null>(null);
  const [pdfBusy, setPdfBusy]     = useState<{ id: number; mode: "preview" | "download" } | null>(null);
  const { isRunning: bulkRunning, showPipeline, progress, dismiss: dismissBulkPipeline, triggerBulkDownload, triggerBulkEmail } = useSalarySlipBulk();
  const { isRunning: whatsappBulkRunning, showPipeline: showWhatsappPipeline, progress: whatsappProgress, dismiss: dismissWhatsappPipeline, triggerBulkWhatsApp } = useWhatsAppBulk();

  const { data: slips = [], isLoading } = useListSalarySlips({ month, year, employmentType: "staff" });

  const filtered = slips.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.employeeName.toLowerCase().includes(q) ||
      s.employeeCode.toLowerCase().includes(q)
    );
  });

  // Month overview -based on the full month's set (not the search box),
  // since these cards describe the whole month's payroll, not a lookup.
  const totalEmployees = slips.length;
  const totalGross = slips.reduce((sum, s) => sum + s.grossSalary, 0);
  const totalDeductions = slips.reduce((sum, s) => sum + s.totalDeductions, 0);
  const totalNet = slips.reduce((sum, s) => sum + s.netSalary, 0);

  async function doPdf(slip: SalarySlipItem, mode: "preview" | "download") {
    setPdfBusy({ id: slip.id, mode });
    try {
      const url = `/api/salary-slips/${slip.id}/pdf`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate PDF", variant: "destructive" });
    } finally {
      setPdfBusy(null);
    }
  }

  function doBulkDownload() {
    triggerBulkDownload({ month, year, employmentType: "staff" });
  }

  function doBulkEmail() {
    triggerBulkEmail({ month, year, employmentType: "staff" });
  }

  function doBulkWhatsApp() {
    triggerBulkWhatsApp({ month, year, employmentType: "staff" });
  }

  async function doEmail(slip: SalarySlipItem) {
    setEmailing(slip.id);
    try {
      const result = await emailMutation.mutateAsync({ id: slip.id });
      toast({
        title: `Email sent to ${slip.employeeName}`,
        description: `Salary slip delivered to ${result.sentTo}`,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "Unknown error";
      toast({ title: "Failed to send email", description: msg, variant: "destructive" });
    } finally {
      setEmailing(null);
    }
  }

  async function doWhatsApp(slip: SalarySlipItem) {
    setWhatsapping(slip.id);
    try {
      const result = await whatsappMutation.mutateAsync(slip.id);
      toast({
        title: `WhatsApp sent to ${slip.employeeName}`,
        description: `Salary slip delivered to ${result.sentTo}`,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "Unknown error";
      toast({ title: "Failed to send via WhatsApp", description: msg, variant: "destructive" });
    } finally {
      setWhatsapping(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-gray-500">
            Generate, preview, and distribute payslips
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={doBulkEmail}
            disabled={bulkRunning || slips.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition-colors disabled:opacity-50"
          >
            {bulkRunning && progress?.kind === "email" ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
            Bulk Send ({slips.length})
          </button>
          <button
            onClick={doBulkWhatsApp}
            disabled={whatsappBulkRunning || slips.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50"
          >
            {whatsappBulkRunning ? <Loader2 size={15} className="animate-spin" /> : <MessageCircle size={15} />}
            Bulk WhatsApp ({slips.length})
          </button>
          <button
            onClick={doBulkDownload}
            disabled={bulkRunning || slips.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-800 text-white rounded-xl hover:bg-slate-900 transition-colors disabled:opacity-50"
          >
            {bulkRunning && progress?.kind === "pdf" ? <Loader2 size={15} className="animate-spin" /> : <Layers size={15} />}
            Bulk Download All ({slips.length})
          </button>
        </div>
      </div>

      {/* ── Bulk download/email/WhatsApp progress ───────────────────── */}
      <SalarySlipBulkPipeline active={showPipeline} data={progress} onDismiss={dismissBulkPipeline} />
      <WhatsAppBulkPipeline active={showWhatsappPipeline} data={whatsappProgress} onDismiss={dismissWhatsappPipeline} />

      {/* ── Month Overview ──────────────────────────────────────── */}
      {!isLoading && slips.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total Employees", value: `${totalEmployees}`, color: "text-indigo-700", icon: Users, bg: "bg-indigo-50" },
            { label: "Total Gross", value: `₹${totalGross.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-blue-700", icon: TrendingUp, bg: "bg-blue-50" },
            { label: "Deductions", value: `₹${totalDeductions.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-red-600", icon: IndianRupee, bg: "bg-red-50" },
            { label: "Total Salary Amount", value: `₹${totalNet.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-green-700", icon: CheckCircle2, bg: "bg-green-50" },
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

      {/* ── Filters ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 clay-card rounded-2xl px-4 py-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">Month</span>
          <select
            value={month}
            onChange={e => setMonth(Number(e.target.value))}
            className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {MONTH_NAMES.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">Year</span>
          <select
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="ml-auto relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search employee…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
          />
        </div>
      </div>

      {/* ── Slip list ─────────────────────────────────────────────── */}
      <div className="clay-card rounded-2xl overflow-hidden">
        <div className="divide-y divide-gray-50">
          {isLoading ? (
            <ShieldLoader />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <FileText size={40} className="opacity-20 mb-3" />
              <p className="text-sm">No salary slips found for the selected period.</p>
              <p className="text-xs mt-1 text-gray-400">Generate payroll first, then slips will appear here.</p>
            </div>
          ) : (
            filtered.map(slip => (
              <div
                key={slip.id}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50/60 transition-colors"
              >
                {/* Avatar */}
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {slip.employeeName.charAt(0)}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">{slip.employeeName}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {slip.employeeCode}
                    {slip.designationTitle ? ` · ${slip.designationTitle}` : ""}
                    {slip.departmentName ? ` · ${slip.departmentName}` : ""}
                  </p>
                </div>

                {/* Net salary badge */}
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-gray-900">
                    ₹{slip.netSalary.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                  </p>
                  <p className="text-xs text-gray-400">
                    {MONTH_NAMES[slip.month-1]?.slice(0, 3)} {slip.year}
                  </p>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <ActionBtn
                    icon={pdfBusy?.id === slip.id && pdfBusy.mode === "preview" ? <Loader2 size={13} className="animate-spin" /> : <FileSearch size={13} />}
                    label="View PDF"
                    onClick={() => doPdf(slip, "preview")}
                    disabled={pdfBusy !== null}
                    color="gray"
                  />
                  <ActionBtn
                    icon={pdfBusy?.id === slip.id && pdfBusy.mode === "download" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    label="Download PDF"
                    onClick={() => doPdf(slip, "download")}
                    disabled={pdfBusy !== null}
                    color="green"
                  />
                  <ActionBtn
                    icon={emailing === slip.id ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                    label="Email"
                    onClick={() => doEmail(slip)}
                    disabled={emailing !== null}
                    color="purple"
                  />
                  <ActionBtn
                    icon={whatsapping === slip.id ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
                    label="WhatsApp"
                    onClick={() => doWhatsApp(slip)}
                    disabled={whatsapping !== null}
                    color="emerald"
                  />
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer count */}
        {filtered.length > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 text-xs text-gray-400">
            {filtered.length} salary slip{filtered.length !== 1 ? "s" : ""} ·
            Total Net: ₹{filtered.reduce((s,r) => s + r.netSalary, 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionBtn({
  icon, label, onClick, disabled = false, color,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  color: "gray" | "blue" | "green" | "purple" | "emerald";
}) {
  const colors = {
    gray:    "border-gray-200 text-gray-600 hover:bg-gray-50",
    blue:    "border-blue-200 text-blue-700 hover:bg-blue-50",
    green:   "border-green-200 text-green-700 hover:bg-green-50",
    purple:  "border-purple-200 text-purple-700 hover:bg-purple-50",
    emerald: "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded-lg transition-colors disabled:opacity-40 ${colors[color]}`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main Page -mirrors ProductionPayroll.tsx's shell, replicating Settings.tsx's
//  per-tab permission mechanism since the 3 sub-tabs map to 3 independently-
//  permissioned module keys (payroll / salary / salary_slip).
// ─────────────────────────────────────────────────────────────────────────────

export default function StaffPayroll() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"payroll" | "salary" | "payslip">("payroll");

  const tabLevel = (t: string) => permissionLevel(user, STAFF_PAYROLL_TAB_MODULE[t] ?? "payroll");
  const isTabViewOnly = tabLevel(tab) === "view";

  // Land on the first sub-tab this role can actually see if the default
  // ("payroll") -or whichever tab was active before a permission change -
  // is hidden for them.
  useEffect(() => {
    if (tabLevel(tab) === "hidden") {
      const firstVisible = (["payroll", "salary", "payslip"] as const).find((t) => tabLevel(t) !== "hidden");
      if (firstVisible) setTab(firstVisible);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, tab]);

  // Only the active tab is mounted (conditional render below, same as
  // Settings.tsx's Radix Tabs), so locking document.body whenever the active
  // tab is view-only only ever touches that one tab's controls.
  useEffect(() => {
    if (!isTabViewOnly) return;
    const relock = () => lockMutatingControls(document.body);
    relock();
    const observer = new MutationObserver(relock);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isTabViewOnly, tab]);

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <CreditCard size={22} className="text-indigo-600" /> Payroll
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Monthly payroll for staff employees -Payroll, Salary, and Payslip in one place.
            </p>
          </div>
        </div>

        <PillTabs
          items={[
            { value: "payroll", label: "Payroll" },
            { value: "salary", label: "Salary" },
            { value: "payslip", label: "Payslip" },
          ].filter((t) => tabLevel(t.value) !== "hidden")}
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          baseColor="#4f46e5"
        />

        {isTabViewOnly && (
          <div
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-semibold"
            style={{
              background: "rgba(245,158,11,0.08)",
              color: "#b45309",
              boxShadow: "inset 3px 3px 8px rgba(245,158,11,0.06), inset -3px -3px 8px rgba(255,255,255,0.9)",
            }}
          >
            <Eye size={15} strokeWidth={2} />
            View only -browse and inspect freely, changes can't be saved.
          </div>
        )}

        <Separator />

        {tab === "payroll" && <PayrollSubTab />}
        {tab === "salary" && <SalarySubTab />}
        {tab === "payslip" && <PayslipSubTab />}
      </div>
    </HrLayout>
  );
}
